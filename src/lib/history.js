import * as THREE from 'three';
import { writable, derived, get } from 'svelte/store';
import { objectsGroup, TControls, selectedObject, pokeScene } from '../stores/sceneStore';
import { peers, showToast, closeSelectionInspector } from '../stores/appStore';
import { notifyExternalMove } from '$lib/flowRuntime';
import { parkEditOverlays, stripEditOverlays } from '$lib/editOverlays';
import { HISTORY_BYTES, entryBytes } from '$lib/meshBudget';
import { withWireBatch } from '$lib/wireBatch';
import { currentHistoryGesture } from '$lib/historyGesture';

// Undo/redo for local edits; remote peers' changes are not recorded, so
// histories stay per-user.
// - transform entries (default): { uuid, before: {pos,rot,scale}, after: {...} }
// - built-in kinds: 'create'/'delete' (object presence, snapshot-based) and
//   'transformSet' (batch of transforms)
// - other kinds register an applier via registerHistoryKind(kind, apply)
//   ('verts' from mesh editing, 'group'/'props' from objectActions,
//   'material' from materialsHandler)

const LIMIT = 50;
const SNAPSHOT_LIMIT = 5_000_000; // ~5 MB of serialized object per entry

/** @type {Record<string, (entry: any, state: any) => boolean>} */
const kindHandlers = {};

/** @param {string} kind @param {(entry: any, state: any) => boolean} apply */
export function registerHistoryKind(kind, apply) {
	kindHandlers[kind] = apply;
}

// --- 37 R26: one gesture = ONE undo step -------------------------------------
// An entry recorded while a gesture is current (historyGesture.js — DragRow opens one per
// scrub and per typing session) is FOLDED into the stack top when the top belongs to the
// same gesture: a kind that registers a merge makes the top span both (first before, last
// after); any other pair becomes a 'gesture' composite. The top is mutated IN PLACE so its
// identity survives (retractEntry and the 38 lock's undo counter both key on identity),
// and a fold that lands back where the gesture started (Escape after typing) leaves no step.

/** @type {WeakMap<object, object>} entry -> the gesture it was recorded in */
const gestureOf = new WeakMap();

/**
 * @typedef {{merge: (top: any, next: any) => boolean, noop?: (entry: any) => boolean}} HistoryMerge
 * `merge` mutates `top` to span both and returns true, or returns false to keep them
 * apart; `noop` says when a merged entry changes nothing.
 */
/** @type {Record<string, HistoryMerge>} */
const mergeHandlers = {};

/** @param {string} kind @param {HistoryMerge} handler */
export function registerHistoryMerge(kind, handler) {
	mergeHandlers[kind] = handler;
}

/** @param {string} key @param {any} value */
const dropStamps = (key, value) => (key === 'changedAt' ? undefined : value);
/**
 * Same content? A latest-wins document re-stamps `changedAt` on every write, so a revert
 * to the starting value still differs by its stamp — compare without them.
 * @param {any} a @param {any} b
 */
export const sameJson = (a, b) => JSON.stringify(a ?? null, dropStamps) === JSON.stringify(b ?? null, dropStamps);
/** the plain transform entry (no kind) */
const KIND_TRANSFORM = 'transform';
/** @param {any} entry */
const kindOf = (entry) => entry?.kind ?? KIND_TRANSFORM;
/** what an entry edits, so a composite folds a later edit into the right member @param {any} entry */
const targetOf = (entry) => entry?.uuid ?? entry?.key ?? null;

/** @param {any} top @param {any} next */
function mergeSame(top, next) {
	if (kindOf(top) !== kindOf(next)) return false;
	const handler = mergeHandlers[kindOf(top)];
	return !!handler && handler.merge(top, next);
}

/** @param {any} entry @returns {boolean} */
function isNoop(entry) {
	if (entry?.kind === 'gesture') return entry.entries.every(isNoop);
	return !!mergeHandlers[kindOf(entry)]?.noop?.(entry);
}

/** Fold `next` into `top` (both of one gesture). Mutates `top`. @param {any} top @param {any} next */
function foldIntoGesture(top, next) {
	if (top.kind === 'gesture') {
		// the newest member editing the same target takes it; a member in between that
		// edits the same target ends the search (folding past it would reorder the replay)
		const target = targetOf(next);
		for (let i = top.entries.length - 1; i >= 0; i--) {
			const member = top.entries[i];
			if (mergeSame(member, next)) return;
			if (target === null || targetOf(member) === target) break;
		}
		top.entries.push(next);
		return;
	}
	if (mergeSame(top, next)) return;
	const first = { ...top };
	for (const key of Object.keys(top)) delete top[key];
	Object.assign(top, { kind: 'gesture', label: 'Edit', entries: [first, next], before: 'before', after: 'after' });
}

/**
 * Record `entry` into `list` (the undo stack's array or the open batch) as part of the
 * current gesture. Returns true when it folded into the top, plus whether the top is now
 * a no-op the caller should drop.
 * @param {any[]} list @param {any} entry @param {object} gesture
 */
function foldIntoTop(list, entry, gesture) {
	const top = list[list.length - 1];
	if (!top || gestureOf.get(top) !== gesture) return null;
	// never reach below a mesh-edit session's barrier
	if (!batch && sessionBase >= 0 && list.length <= sessionBase) return null;
	foldIntoGesture(top, entry);
	return { drop: isNoop(top) };
}

/** @param {any} top @param {any} next */
function mergeTransform(top, next) {
	if (!top.uuid || top.uuid !== next.uuid) return false;
	top.after = next.after;
	return true;
}
registerHistoryMerge(KIND_TRANSFORM, { merge: mergeTransform, noop: (e) => sameJson(e.before, e.after) });

registerHistoryMerge('transformSet', {
	merge(top, next) {
		// per object: the first before, the latest after
		for (const item of next.items) {
			const mine = top.items.find((/** @type {any} */ i) => i.uuid === item.uuid);
			if (mine) mine.after = item.after;
			else top.items.push({ ...item });
		}
		return true;
	},
	noop: (e) => e.items.every((/** @type {any} */ i) => sameJson(i.before, i.after))
});

// a fan over a selection records one batch per change: fold them member by member
registerHistoryMerge('aibatch', {
	merge(top, next) {
		if (top.entries.length !== next.entries.length) return false;
		/** @type {[any, any][]} */
		const pairs = top.entries.map((/** @type {any} */ e, /** @type {number} */ i) => [e, next.entries[i]]);
		if (!pairs.every(([a, b]) => kindOf(a) === kindOf(b) && targetOf(a) === targetOf(b))) return false;
		// dry run on shallow copies first, so a member that refuses leaves the batch untouched
		if (!pairs.every(([a, b]) => mergeSame({ ...a }, b))) return false;
		for (const [a, b] of pairs) mergeSame(a, b);
		return true;
	},
	noop: (e) => e.entries.every(isNoop)
});

/** @type {import('svelte/store').Writable<any[]>} exported READ-ONLY (tests/debug) */
export const undoStack = writable([]);
/** @type {import('svelte/store').Writable<any[]>} */
const redoStack = writable([]);

export const canUndo = derived(undoStack, (stack) => stack.length > 0);
export const canRedo = derived(redoStack, (stack) => stack.length > 0);

// While replaying an entry the mutation sites fire again (appliers reuse the
// normal actions) — recordEntry ignores them so replays don't pollute history.
let applying = false;

// Batching (roadmap #10): while a batch is open, individual entries collect into
// it instead of the undo stack — one AI prompt commits as ONE undoable step. The
// batch branch returns BEFORE redoStack is cleared; redo is only cleared when the
// composite 'aibatch' entry is finally recorded (via recordEntry with batch=null).
/** @type {any[]|null} */
let batch = null;

/** Open a history batch. Any leftover batch is flushed first (defensive). */
export function beginHistoryBatch() {
	if (batch && batch.length) endHistoryBatch('Batch');
	batch = [];
}

/** Commit the open batch as one 'aibatch' entry (no-op if empty).
 * @param {string} [label] */
export function endHistoryBatch(label = 'AI edit') {
	const entries = batch;
	batch = null;
	if (entries && entries.length) {
		recordEntry({ kind: 'aibatch', label, entries, before: 'before', after: 'after' });
	}
}

/** 37 R25: is a batch collecting entries right now (a caller that wants its own ONE entry
 * must not open a second batch inside somebody else's — beginHistoryBatch flushes) */
export function historyBatchOpen() {
	return batch !== null;
}

/**
 * 37 R25: undo ONE specific entry — the Undo button on a toast, which names the action it
 * offered rather than "whatever is on top now". On top of the stack it is an ordinary undo
 * (it moves to redo, so Ctrl+Y does the action again). Deeper down (something was done
 * since) it is applied out of order and dropped — no redo, because its place in the redo
 * order would be a lie. False when the entry is gone (already undone, or evicted).
 * @param {any} entry
 */
export function undoEntry(entry) {
	const stack = get(undoStack);
	const at = stack.indexOf(entry);
	if (at < 0) return false;
	if (at === stack.length - 1) {
		undo();
		return !get(undoStack).includes(entry);
	}
	undoStack.update((list) => list.filter((e) => e !== entry));
	applying = true;
	try {
		return applyState(entry, entry.before);
	} finally {
		applying = false;
	}
}

/** @param {any} entry */
export function recordEntry(entry) {
	if (applying) return;
	const gesture = currentHistoryGesture();
	if (gesture) {
		const folded = foldIntoTop(batch ?? get(undoStack), entry, gesture);
		if (folded) {
			if (batch) {
				if (folded.drop) batch.pop();
				return;
			}
			// same identity on top, so notify by hand (or drop a step that changes nothing)
			undoStack.update((stack) => (folded.drop ? stack.slice(0, -1) : [...stack]));
			redoStack.set([]);
			return;
		}
		gestureOf.set(entry, gesture);
	}
	if (batch) {
		batch.push(entry);
		return; // deferred — redoStack stays until the batch commits
	}
	undoStack.update((stack) => {
		const next = [...stack, entry];
		while (next.length > LIMIT) {
			// 'selection' entries are cheap and disposable (a list of indices), so
			// a click-heavy mesh session must not push a GEOMETRY step off the
			// stack — that would leave a sealed session unable to reach its own
			// start. Evict the oldest selection first, the oldest entry otherwise.
			const i = next.findIndex((e) => e.kind === 'selection');
			next.splice(i >= 0 ? i : 0, 1);
		}
		// A COUNT is not a budget once a single entry can be megabytes. The geometry
		// ceiling was raised to 500k vertices, and a meshgeo entry holds a before AND
		// an after — so fifty of them at the ceiling is gigabytes, and the tab dies
		// holding undo steps nobody will reach for. Drop from the OLD end until the
		// total fits: the far past is what a user has already stopped wanting.
		// The NEWEST entry is never evicted, however big it is — an undo that cannot
		// undo the thing you just did would be worse than the memory.
		let bytes = next.reduce((sum, e) => sum + entryBytes(e), 0);
		while (bytes > HISTORY_BYTES && next.length > 1) {
			bytes -= entryBytes(next[0]);
			next.splice(0, 1);
		}
		return next;
	});
	redoStack.set([]);
	// 15-F: the pre-session redo entries this barrier protected are gone now
	if (sessionBase >= 0) sessionRedoBase = 0;
}

/** Remove a specific entry from the undo stack by IDENTITY (19-A: the adjust
 * engine's revert — the op's own geometry restore already replicated, so this
 * touches no wire and leaves the redo stack alone). No-op when the entry was
 * already undone or evicted by the LIMIT trim. @param {any} entry */
export function retractEntry(entry) {
	undoStack.update((stack) => stack.filter((e) => e !== entry));
}

// --- 15-F: session-scoped undo (mesh-edit sessions) -------------------------
// While an Edit Mesh session is active, a live BARRIER keeps undo/redo inside
// the session's own steps: entries keep landing on undoStack normally (NOT the
// batch API — beginHistoryBatch diverts entries away, so a mid-session Ctrl+Z
// would pop PRE-session entries, strictly worse), and sealing on Done collapses
// everything above the barrier into ONE entry. Driven by editSession.js.

let sessionBase = -1; // undoStack length at session start; -1 = no session
let sessionRedoBase = 0; // redoStack length at session start (protected below)

/** Open the barrier: undo/redo stop at the CURRENT stack tops. */
export function beginHistorySession() {
	sessionBase = get(undoStack).length;
	sessionRedoBase = get(redoStack).length;
}

/**
 * Seal the session.
 * - 'collapse' (default): pop the session's entries; all-meshgeo/verts on ONE
 *   uuid with meshgeo at both ends compacts to a single synthetic meshgeo
 *   (2 position arrays, each already ≤ the per-commit cap — replays and
 *   replicates through the registered kind, no new wire messages); anything
 *   else becomes a composite 'session' entry (the aibatch replayer).
 * - 'keep': just lift the barrier (per-op entries remain).
 * - 'discard': drop the session's entries (collider PROXY sessions — their
 *   meshgeo targets a disposed proxy and can never replay).
 * @param {'collapse'|'keep'|'discard'} [mode] @param {string} [label]
 */
export function endHistorySession(mode = 'collapse', label = 'Mesh edit') {
	if (sessionBase < 0) return;
	const base = sessionBase;
	const redoBase = sessionRedoBase;
	sessionBase = -1;
	sessionRedoBase = 0;
	if (mode === 'keep') return;
	// drop IN-SESSION redo remnants (ops undone just before Done are sealed
	// away); pre-session redos survive if no in-session entry cleared them
	redoStack.update((s) => s.slice(0, redoBase));
	const stack = get(undoStack);
	if (stack.length <= base) return; // nothing landed above the barrier
	// SELECTION entries are session-local by design: they let Ctrl+Z walk back
	// picks WHILE editing, and evaporate on Done — the sealed entry describes
	// the geometry change, not which faces happened to be lit. Dropping them
	// here also keeps the all-meshgeo/verts compaction test below reachable.
	const entries = stack.slice(base).filter((e) => e.kind !== 'selection');
	undoStack.update((s) => s.slice(0, base));
	if (mode === 'discard' || !entries.length) return;
	const first = entries[0];
	const last = entries[entries.length - 1];
	if (
		new Set(entries.map((e) => e.uuid)).size === 1 &&
		entries.every((e) => e.kind === 'meshgeo' || e.kind === 'verts') &&
		first.kind === 'meshgeo' &&
		last.kind === 'meshgeo'
	) {
		// compact — NOTE the both-ends-meshgeo guard (a refinement over the plan):
		// a 'verts' entry carries ONE vertex position, not a full snapshot, so it
		// cannot bracket the compacted before/after; verts-only or verts-bracketed
		// sessions take the composite path below, which replays each sub-entry
		// through its own kind
		if (JSON.stringify(first.before) !== JSON.stringify(last.after))
			recordEntry({ kind: 'meshgeo', uuid: first.uuid, before: first.before, after: last.after });
		return;
	}
	recordEntry({ kind: 'session', label, entries, before: 'before', after: 'after' });
}

/** @param {any} entry */
export function recordTransform(entry) {
	recordEntry(entry);
}

/** Batch transform entry, applied item-by-item @param {{uuid: string, before: any, after: any}[]} items */
export function recordTransformSet(items) {
	if (items.length === 0) return;
	recordEntry({ kind: 'transformSet', items, before: 'before', after: 'after' });
}

// --- create/delete: object presence, restored from a serialized snapshot ---

/** @type {((object: any) => any) | null} */
let referenceSnapshot = null;

/**
 * 30b integrate: content that can be REBUILT from where it came from is kept in history as
 * that reference, not as its serialized bytes. A kit piece placed from a pack is ~0.8 MB of
 * GLB and ~7.9 MB as toJSON (its textures come back as PNG data URLs), so every placement
 * toasted "too large for undo history" and level building with the kits had no undo. The
 * provider returns a toJSON element (packRefs' stub) or null for "not a reference"; the
 * restore needs nothing new, because a stub added back to the scene is refilled by the
 * same scan that refills a loaded file's or a peer's. Registered, never imported: packRefs
 * reaches the Explorer, and nothing in history's import subtree may grow that edge.
 * @param {((object: any) => any) | null} fn
 */
export function registerReferenceSnapshot(fn) {
	referenceSnapshot = fn;
}

/**
 * Serialize an object (ObjectLoader JSON round-trip, same format the
 * `object` peer message uses for lights/parents) for create/delete entries.
 * Returns null when the object is too heavy to keep in history.
 * @param {any} object @param {boolean} [quiet] skip the too-large toast (the
 * removal-time refresh keeps the existing snapshot instead of warning twice)
 */
export function captureObjectSnapshot(object, quiet = false) {
	// a snapshot is a serialize like any other: an object deleted (or duplicated)
	// while its mesh-edit session is open must not carry the edit WIREFRAME into
	// the entry, or undo brings back a permanently wireframed object and the
	// re-broadcast hands one to every peer (editOverlays.js)
	const unpark = parkEditOverlays(object);
	try {
		const reference = referenceSnapshot ? referenceSnapshot(object) : null;
		const element = reference ?? object.toJSON();
		if (JSON.stringify(element).length > SNAPSHOT_LIMIT) {
			if (!quiet) showToast('Object is too large for undo history — this step will not be undoable');
			return null;
		}
		const group = get(objectsGroup);
		const parentUuid = object.parent && object.parent !== group ? object.parent.uuid : null;
		return { element, parentUuid };
	} catch (error) {
		console.log('captureObjectSnapshot failed', error);
		return null;
	} finally {
		unpark();
	}
}

/**
 * Record a creation or deletion. Call with the object still in the scene
 * (deletions capture the snapshot before removal).
 * @param {'create' | 'delete'} kind @param {any} object
 */
export function recordObjectPresence(kind, object) {
	if (applying || !object) return;
	const snapshot = captureObjectSnapshot(object);
	if (!snapshot) return;
	recordEntry({
		kind,
		uuid: object.uuid,
		snapshot,
		before: { present: kind === 'delete' },
		after: { present: kind === 'create' }
	});
}

const snapshotLoader = new THREE.ObjectLoader();

/** @param {any} entry @param {any} state */
function applyPresence(entry, state) {
	const group = get(objectsGroup);
	if (!group) return false;
	/** @type {any} */
	const peer = get(peers);
	const existing = group.getObjectByProperty('uuid', entry.uuid);

	if (state.present) {
		if (existing) return true; // a peer already restored it
		let object;
		try {
			object = snapshotLoader.parse(entry.snapshot.element);
			stripEditOverlays(object); // an entry an older build recorded mid-session
		} catch (error) {
			console.log('history restore failed', error);
			showToast('Cannot restore the object from history');
			return false;
		}
		const parent = entry.snapshot.parentUuid
			? group.getObjectByProperty('uuid', entry.snapshot.parentUuid)
			: null;
		(parent ?? group).add(object);
		pokeScene();
		// receivers take the same ObjectLoader path as light/parent sync
		if (peer)
			peer.send({ type: 'object', element: entry.snapshot.element, groupuuid: entry.snapshot.parentUuid ?? undefined });
		return true;
	}

	if (!existing) {
		showToast('Cannot undo/redo: the object no longer exists');
		return false;
	}
	// Refresh the snapshot from the LIVE object on its way out, so redo restores
	// it exactly as it left the scene. A 'create' entry is recorded the instant
	// the object exists, but several spawn paths position it AFTERWARDS (the Add
	// menu lands it at the clicked point, the VR sleeve at the release pose) —
	// the stored snapshot held the default origin pose, so undo+redo teleported
	// the object to the world centre, on peers too (they replay this element).
	const fresh = captureObjectSnapshot(existing, true);
	if (fresh) entry.snapshot = fresh;
	if (get(selectedObject)?.uuid === entry.uuid) {
		// selectedObject keeps its last value on purpose (the inspector binds to
		// it) — just detach the gizmo and close it, like deselectObject does
		get(TControls)?.detach();
		closeSelectionInspector();
	}
	existing.parent?.remove(existing);
	pokeScene();
	if (peer) peer.send({ type: 'delete', uuid: entry.uuid, peerId: peer.peer.id });
	return true;
}

registerHistoryKind('create', applyPresence);
registerHistoryKind('delete', applyPresence);

// --- transformSet: batch of transforms (physics restore, future multi-select) ---

registerHistoryKind('transformSet', (entry, state) => {
	const group = get(objectsGroup);
	/** @type {any} */
	const peer = get(peers);
	let any = false;
	entry.items.forEach((item) => {
		const target = item[state]; // state is 'before' | 'after'
		const object = group?.getObjectByProperty('uuid', item.uuid);
		if (!object || !target) return;
		object.position.fromArray(target.pos);
		object.rotation.set(target.rot[0], target.rot[1], target.rot[2]);
		object.scale.fromArray(target.scale);
		notifyExternalMove(item.uuid);
		if (peer)
			peer.send({ type: 'move', uuid: item.uuid, pos: target.pos, rot: target.rot, scale: target.scale });
		any = true;
	});
	if (any) pokeScene();
	else showToast('Cannot undo/redo: the objects no longer exist');
	return any;
});

/** @param {any} entry @param {any} state */
function applyState(entry, state) {
	if (entry.kind && kindHandlers[entry.kind]) return kindHandlers[entry.kind](entry, state);

	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', entry.uuid);
	if (!object) {
		showToast('Cannot undo/redo: the object no longer exists');
		return false;
	}
	object.position.fromArray(state.pos);
	object.rotation.set(state.rot[0], state.rot[1], state.rot[2]);
	object.scale.fromArray(state.scale);
	notifyExternalMove(entry.uuid); // undoing an animated object rewrites its base
	pokeScene();
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'move', uuid: entry.uuid, pos: state.pos, rot: state.rot, scale: state.scale });
	return true;
}

// --- aibatch/session: a composite of sub-entries replayed through applyState,
// so an AI prompt or a sealed mesh-edit session is ONE undo step. Reverse
// order on undo so ops that depend on earlier ones unwind correctly.
/** @param {any} entry @param {any} state */
function applyComposite(entry, state) {
	const undoing = state === 'before';
	const list = undoing ? [...entry.entries].reverse() : entry.entries;
	let any = false;
	for (const sub of list) {
		const target = undoing ? sub.before : sub.after;
		try {
			if (applyState(sub, target)) any = true;
		} catch (error) {
			console.log('composite sub-entry failed', error);
		}
	}
	if (!any) showToast('Cannot undo/redo: those objects no longer exist');
	return any;
}
registerHistoryKind('aibatch', applyComposite);
registerHistoryKind('session', applyComposite); // 15-F mixed-kind seals
registerHistoryKind('gesture', applyComposite); // 37 R26: one gesture's mixed entries

// 37-int-127: a recorder that seals LATER than its change (the Inspector's 500 ms transform /
// light / render-order seals) registers a flush here. Undo and redo run every flush first, so
// a Ctrl+Z pressed right after a drag undoes THAT drag instead of the step before it (which
// was the 1.26 behaviour: the drag's step landed after the undo had already run).
/** @type {Set<() => void>} */
const pendingSeals = new Set();
/** @param {() => void} flush @returns {() => void} unregister */
export function registerPendingSeal(flush) {
	pendingSeals.add(flush);
	return () => pendingSeals.delete(flush);
}
function flushPendingSeals() {
	for (const flush of [...pendingSeals]) {
		try {
			flush();
		} catch (error) {
			console.log('pending history seal failed', error);
		}
	}
}

export function undo() {
	flushPendingSeals();
	const stack = get(undoStack);
	// 15-F: inside an edit session, undo stops at the session's first step
	if (sessionBase >= 0 && stack.length <= sessionBase) {
		showToast('Start of this edit session — press Done to undo earlier steps');
		return;
	}
	if (stack.length === 0) {
		showToast('Nothing to undo');
		return;
	}
	const entry = stack[stack.length - 1];
	undoStack.update((s) => s.slice(0, -1));
	// a step that left the stack is sealed: a later edit of its gesture is a new step
	gestureOf.delete(entry);
	applying = true;
	try {
		// 37 R1: a multi-object step undoes as ONE replicated batch, the way it was made
		if (withWireBatch(() => applyState(entry, entry.before))) redoStack.update((s) => [...s, entry]);
	} finally {
		applying = false;
	}
	refreshSelection();
}

export function redo() {
	flushPendingSeals();
	const stack = get(redoStack);
	// 15-F: pre-session redo entries are protected while a session is open
	if (sessionBase >= 0 && stack.length <= sessionRedoBase) {
		showToast('That redo is outside this edit session — press Done first');
		return;
	}
	if (stack.length === 0) {
		showToast('Nothing to redo');
		return;
	}
	const entry = stack[stack.length - 1];
	redoStack.update((s) => s.slice(0, -1));
	applying = true;
	try {
		if (withWireBatch(() => applyState(entry, entry.after))) undoStack.update((s) => [...s, entry]);
	} finally {
		applying = false;
	}
	refreshSelection();
}

/**
 * 37 R26 (Q2): the Inspector's rows read the selected object through `selectedObject`, and
 * THREE objects are not reactive — an undo rewrote the pose and the rows kept showing the
 * pre-undo number (a scrub started from it then jumped). Every kind's replay mutates in
 * place, so poke the selection after any replay rather than in each kind.
 */
function refreshSelection() {
	if (get(selectedObject)?.uuid) selectedObject.update((v) => v);
}
