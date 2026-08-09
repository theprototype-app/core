import * as THREE from 'three';
import { writable, derived, get } from 'svelte/store';
import { objectsGroup, TControls, selectedObject } from '../stores/sceneStore';
import { peers, showToast, closeSelectionInspector } from '../stores/appStore';
import { notifyExternalMove } from '$lib/flowRuntime';

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

/** @param {any} entry */
export function recordEntry(entry) {
	if (applying) return;
	if (batch) {
		batch.push(entry);
		return; // deferred — redoStack stays until the batch commits
	}
	undoStack.update((stack) => {
		const next = [...stack, entry];
		if (next.length > LIMIT) next.shift();
		return next;
	});
	redoStack.set([]);
	// 15-F: the pre-session redo entries this barrier protected are gone now
	if (sessionBase >= 0) sessionRedoBase = 0;
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
	const entries = stack.slice(base);
	undoStack.update((s) => s.slice(0, base));
	if (mode === 'discard') return;
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

/**
 * Serialize an object (ObjectLoader JSON round-trip, same format the
 * `object` peer message uses for lights/parents) for create/delete entries.
 * Returns null when the object is too heavy to keep in history.
 * @param {any} object
 */
export function captureObjectSnapshot(object) {
	try {
		const element = object.toJSON();
		if (JSON.stringify(element).length > SNAPSHOT_LIMIT) {
			showToast('Object is too large for undo history — this step will not be undoable');
			return null;
		}
		const group = get(objectsGroup);
		const parentUuid = object.parent && object.parent !== group ? object.parent.uuid : null;
		return { element, parentUuid };
	} catch (error) {
		console.log('captureObjectSnapshot failed', error);
		return null;
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
		} catch (error) {
			console.log('history restore failed', error);
			showToast('Cannot restore the object from history');
			return false;
		}
		const parent = entry.snapshot.parentUuid
			? group.getObjectByProperty('uuid', entry.snapshot.parentUuid)
			: null;
		(parent ?? group).add(object);
		objectsGroup.update((value) => value);
		// receivers take the same ObjectLoader path as light/parent sync
		if (peer)
			peer.send({ type: 'object', element: entry.snapshot.element, groupuuid: entry.snapshot.parentUuid ?? undefined });
		return true;
	}

	if (!existing) {
		showToast('Cannot undo/redo: the object no longer exists');
		return false;
	}
	if (get(selectedObject)?.uuid === entry.uuid) {
		// selectedObject keeps its last value on purpose (the inspector binds to
		// it) — just detach the gizmo and close it, like deselectObject does
		get(TControls)?.detach();
		closeSelectionInspector();
	}
	existing.parent?.remove(existing);
	objectsGroup.update((value) => value);
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
	if (any) objectsGroup.update((value) => value);
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
	objectsGroup.update((value) => value);
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

export function undo() {
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
	applying = true;
	try {
		if (applyState(entry, entry.before)) redoStack.update((s) => [...s, entry]);
	} finally {
		applying = false;
	}
}

export function redo() {
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
		if (applyState(entry, entry.after)) undoStack.update((s) => [...s, entry]);
	} finally {
		applying = false;
	}
}
