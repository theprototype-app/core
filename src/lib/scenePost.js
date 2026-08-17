import { writable, get } from 'svelte/store';
import { peers } from '../stores/appStore';
import { viewMode } from '../stores/sceneStore';
// L2: the 'look' history kind. Safe as a static import — history's own subtree is
// three/stores/flowRuntime/editOverlays/meshBudget, and nothing in it reaches this
// module, so the registerHistoryKind-in-the-body rule is not violated.
import { registerHistoryKind, recordEntry } from './history';

// L1 — the SCENE POST-PROCESSING STACK.
//
// The authored look of a scene (grading, stylize, AO, camera FX) is SCENE DATA:
// replicated latest-wins on a `changedAt` stamp and saved with the scene, the
// `scenePhysics` singleton precedent exactly. What stays LOCAL is whether this
// viewer RENDERS it (`postEnabledLocal` + the `viewMode` pick) — viewport shading
// is a per-viewport setting in every DCC, never scene data.
//
// This module is a deliberate LEAF: stores only, no third-party imports, so the
// planner below is a pure function testable without a GL context and so the
// module can be reached from peerHandler/sessions without closing an import
// cycle. The passes themselves are built in `postEffects.js`, which owns the
// `postprocessing`/`n8ao` imports and registers the built-ins.

/**
 * @typedef {{id: string, kind: string, enabled: boolean, params: Record<string, any>}} PostEntry
 * @typedef {{enabled: boolean, effects: PostEntry[], changedAt: number}} PostStack
 * @typedef {{key: string, label: string, min?: number, max?: number, step?: number, decimals?: number, default: any, options?: {value: any, label: string}[]}} PostParam
 */

// ---- the kind REGISTRY -----------------------------------------------------
// Declared ABOVE every store subscribe in this file: a module-level subscribe
// runs its callback SYNCHRONOUSLY at module eval, and a `let` it reads from
// below would TDZ-crash the SSR prerender (the meshEdit/faceEdit lesson).

/** @type {Record<string, any>} kind -> definition */
const postKinds = {};

/**
 * Register a post effect kind.
 *
 * `isPass` is part of the CONTRACT, not an implementation detail: it is what
 * lets `planPostStack` compute the merge groups purely, with no GL context and
 * before anything is instantiated. An `Effect` merges with its neighbours into
 * one fullscreen shader; a `Pass` (N8AO is a Pass) breaks the run.
 *
 * @param {string} kind stable wire identifier
 * @param {{label: string, group?: string, isPass?: boolean, params?: PostParam[],
 *   make: (params: Record<string, any>, ctx: any) => any,
 *   retarget?: (object: any, camera: any) => void,
 *   resize?: (object: any, width: number, height: number, dpr: number) => void,
 *   applyLocal?: (object: any, prefs: any) => void,
 *   dispose?: (object: any) => void}} def
 */
export function registerPostEffect(kind, def) {
	postKinds[kind] = { group: 'other', isPass: false, params: [], ...def, kind };
	// a kind arriving after a stack was loaded (a module registering late) means
	// entries that were being SKIPPED are now renderable — poke the stack so the
	// chain rebuilds. Cheap: a stamp-free update, so it never looks like an edit.
	scenePost.update((state) => ({ ...state }));
	return () => {
		delete postKinds[kind];
		scenePost.update((state) => ({ ...state }));
	};
}

/** @param {string} kind */
export function postEffectDef(kind) {
	return postKinds[kind] ?? null;
}

/** Every registered kind, for the L3 add menu. */
export function postEffectKinds() {
	return Object.values(postKinds).map((def) => ({
		kind: def.kind,
		label: def.label,
		group: def.group,
		isPass: def.isPass,
		params: def.params
	}));
}

/** Defaults for a kind's params (an unknown kind has none we can invent). @param {string} kind */
export function defaultPostParams(kind) {
	/** @type {Record<string, any>} */
	const out = {};
	for (const param of postKinds[kind]?.params ?? []) out[param.key] = param.default;
	return out;
}

// ---- normalize -------------------------------------------------------------

let idCounter = 0;
function newId() {
	// only needs to be unique within a stack; a stamp+counter is enough and keeps
	// this module free of a crypto dependency
	return 'fx' + Date.now().toString(36) + (idCounter++).toString(36);
}

/**
 * ONE normalizer, run at EVERY store boundary (local edit, remote apply, save
 * restore) so an old save and a NEWER peer both load.
 *
 * The load-bearing rule: **an unknown `kind` is PRESERVED VERBATIM**, params and
 * all. A peer on a newer build may author an effect we have never heard of; we
 * cannot render it, but dropping it here would silently delete their work the
 * moment we touched anything else in the stack (the `normalizeAnnotation` rule).
 * The skip happens later, at PLAN time, where it is a rendering decision.
 *
 * @param {any} raw @returns {PostStack}
 */
export function normalizeScenePost(raw) {
	const source = raw && typeof raw === 'object' ? raw : {};
	const list = Array.isArray(source.effects) ? source.effects : [];
	/** @type {PostEntry[]} */
	const effects = [];
	const seen = new Set();
	for (const item of list) {
		if (!item || typeof item !== 'object') continue;
		const kind = typeof item.kind === 'string' ? item.kind : '';
		if (!kind) continue;
		let id = typeof item.id === 'string' && item.id ? item.id : newId();
		while (seen.has(id)) id = newId(); // ids key the {#each} in L3 — duplicates THROW
		seen.add(id);
		const known = postKinds[kind];
		// a known kind gets its defaults filled in (an older save predates a param);
		// an unknown one keeps exactly what arrived, since we have no schema for it
		const params = known
			? { ...defaultPostParams(kind), ...(item.params && typeof item.params === 'object' ? item.params : {}) }
			: { ...(item.params && typeof item.params === 'object' ? item.params : {}) };
		const entry = { ...item, id, kind, enabled: item.enabled !== false, params };
		effects.push(entry);
	}
	return {
		...source,
		enabled: source.enabled !== false,
		effects,
		changedAt: Number(source.changedAt) || 0
	};
}

/** @type {import('svelte/store').Writable<PostStack>} the replicated stack */
export const scenePost = writable(normalizeScenePost(null));

/** LOCAL kill switch: render the authored stack on THIS device at all. */
export const postEnabledLocal = writable(
	typeof localStorage !== 'undefined' ? localStorage.getItem('postEnabledLocal') !== 'false' : true
);
postEnabledLocal.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('postEnabledLocal', value ? 'true' : 'false');
});

// ---- the PLAN (pure) ------------------------------------------------------

/** The built-in AO entry the legacy 'shaded-ao' view mode renders, at the exact
 * parameters `Outline.svelte` hardcoded before the stack existed — that is what
 * makes that mode byte-compatible with the pre-stack chain. */
export const BUILTIN_AO = Object.freeze({ id: 'builtin-ao', kind: 'ao', enabled: true, params: {} });

/**
 * Which entries this viewer should actually render, given the scene stack and
 * the LOCAL view state. Pure, so the view-mode matrix is a table test.
 *
 *  - `wireframe`  skips the stack entirely: it is a DIAGNOSTIC view that already
 *                 replaces every material via scene.overrideMaterial.
 *  - `shaded`     no post at all.
 *  - `shaded-ao`  the built-in AO only — today's chain, unchanged.
 *  - `custom`     the scene's authored stack.
 *
 * @param {{stack: PostStack, mode: string, localEnabled?: boolean, aoOk?: boolean, aoWarm?: boolean}} input
 * @returns {PostEntry[]}
 */
export function effectivePostStack({ stack, mode, localEnabled = true, aoOk = true, aoWarm = true }) {
	if (mode === 'wireframe') return [];
	const aoAllowed = aoOk && aoWarm;
	if (mode === 'shaded-ao') {
		// deliberately NOT gated on localEnabled: this mode is not the authored
		// look, it is the viewer's own choice of viewport shading
		return aoAllowed ? [{ ...BUILTIN_AO, params: defaultPostParams('ao') }] : [];
	}
	if (mode !== 'custom') return [];
	if (!localEnabled) return [];
	const state = normalizeScenePost(stack);
	if (!state.enabled) return [];
	return state.effects.filter((entry) => entry.enabled && (entry.kind !== 'ao' || aoAllowed));
}

/**
 * Group the effective entries into the passes they will compile to.
 *
 * THE MERGE RULE, and the whole reason this is its own function: consecutive
 * `Effect`s fold into ONE `EffectPass` — postprocessing's central design
 * property — so eight grading/stylize entries are one fullscreen shader, not
 * eight. A `Pass` breaks the run and starts a new merge group. Unknown kinds are
 * reported in `skipped` and do NOT break a run: they contribute no shader, so
 * the effects either side of one still merge.
 *
 * @param {PostEntry[]} entries
 * @returns {{groups: {type: 'effects'|'pass', entries: PostEntry[]}[], skipped: PostEntry[], passCount: number}}
 */
export function planPostStack(entries) {
	/** @type {{type: 'effects'|'pass', entries: PostEntry[]}[]} */
	const groups = [];
	/** @type {PostEntry[]} */
	const skipped = [];
	for (const entry of entries ?? []) {
		const def = postKinds[entry.kind];
		if (!def) {
			skipped.push(entry);
			continue;
		}
		if (def.isPass) {
			groups.push({ type: 'pass', entries: [entry] });
			continue;
		}
		const last = groups[groups.length - 1];
		if (last && last.type === 'effects') last.entries.push(entry);
		else groups.push({ type: 'effects', entries: [entry] });
	}
	return { groups, skipped, passCount: groups.length };
}

/**
 * A cheap identity for "would the compiled chain differ?" — the chain is rebuilt
 * only when this changes, so a param scrub that changes nothing does not thrash
 * the composer.
 *
 * It folds in each kind's REGISTRY STATE, not just the entry: a kind registered
 * late (a module finishing its load) turns a skipped entry into a real pass
 * without the entry itself changing at all, and the chain has to rebuild for it.
 * @param {PostEntry[]} entries
 */
export function postStackSignature(entries) {
	return JSON.stringify(
		(entries ?? []).map((entry) => {
			const def = postKinds[entry.kind];
			return [entry.kind, def ? (def.isPass ? 'pass' : 'effect') : 'unknown', entry.params ?? {}];
		})
	);
}

// ---- editing (local + replicate) ------------------------------------------

/** the open gesture: {before} while a slider drag is collecting */
/** @type {{before: PostStack} | null} */
let gesture = null;
/** true while a history replay is writing, so the replay records nothing */
let applyingHistory = false;

/**
 * Write the stack locally, record ONE undo entry, and replicate it (latest-wins).
 *
 * While a GESTURE is open (a DragRow scrub) the write is LOCAL only: the entry
 * and the broadcast both wait for `endLookGesture`, so a drag that writes the
 * store on every pointermove leaves one undo step and puts one message on the
 * wire. The beginAnimGesture/endAnimGesture precedent exactly.
 * @param {(state: PostStack) => PostStack} fn
 */
function commit(fn) {
	const before = gesture || applyingHistory ? null : structuredClone(get(scenePost));
	const next = normalizeScenePost(fn(get(scenePost)));
	next.changedAt = Date.now();
	scenePost.set(next);
	if (gesture) return next; // the gesture owns the entry and the broadcast
	if (before) recordLookEntry(before, next);
	broadcastScenePost();
	return next;
}

/** @param {PostStack} before @param {PostStack} after */
function recordLookEntry(before, after) {
	if (applyingHistory) return;
	if (JSON.stringify(before.effects) === JSON.stringify(after.effects) && before.enabled === after.enabled) return;
	recordEntry({
		kind: 'look',
		beforeStack: before,
		afterStack: after,
		before: 'before',
		after: 'after'
	});
}

/**
 * Collect every edit until `endLookGesture` into ONE undo entry and ONE
 * broadcast. Wire it to DragRow's `onscrubstart` / `onscrubend` (19-A P0): those
 * fire only once the 3px dead zone is crossed, so a plain click never opens a
 * gesture it would have to close again.
 */
export function beginLookGesture() {
	if (gesture) endLookGesture();
	gesture = { before: structuredClone(get(scenePost)) };
}

/** Commit the open gesture (no-op when nothing changed). */
export function endLookGesture() {
	const open = gesture;
	gesture = null;
	if (!open) return;
	recordLookEntry(open.before, get(scenePost));
	broadcastScenePost();
}

// Replaying writes the stored stack locally AND replicates it, so peers follow an
// undo like any other edit (the 'joint'/'anim' presence-kind precedent).
registerHistoryKind('look', (entry, state) => {
	const target = state === entry.before ? entry.beforeStack : entry.afterStack;
	applyingHistory = true;
	try {
		const next = normalizeScenePost(target);
		next.changedAt = Date.now();
		scenePost.set(next);
		broadcastScenePost();
	} finally {
		applyingHistory = false;
	}
	return true;
});

/** Send the current stack to every peer. */
export function broadcastScenePost() {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send(scenePostState());
}

/** Add an effect of `kind` at the end (or at `index`). @param {string} kind @param {number} [index] */
export function addPostEffect(kind, index) {
	let id = '';
	commit((state) => {
		const entry = { id: (id = newId()), kind, enabled: true, params: defaultPostParams(kind) };
		const effects = [...state.effects];
		effects.splice(index == null ? effects.length : index, 0, entry);
		return { ...state, effects };
	});
	return id;
}

/** @param {string} id */
export function removePostEffect(id) {
	commit((state) => ({ ...state, effects: state.effects.filter((entry) => entry.id !== id) }));
}

/** Move an entry to `index` (the stack IS the order — an artist expects a stack).
 * @param {string} id @param {number} index */
export function movePostEffect(id, index) {
	commit((state) => {
		const from = state.effects.findIndex((entry) => entry.id === id);
		if (from < 0) return state;
		const effects = [...state.effects];
		const [entry] = effects.splice(from, 1);
		effects.splice(Math.max(0, Math.min(effects.length, index)), 0, entry);
		return { ...state, effects };
	});
}

/** @param {string} id @param {boolean} enabled */
export function setPostEffectEnabled(id, enabled) {
	commit((state) => ({
		...state,
		// SPREAD the base record: a newer peer's fields on this entry survive our edit
		effects: state.effects.map((entry) => (entry.id === id ? { ...entry, enabled: !!enabled } : entry))
	}));
}

/** Patch one entry's params. @param {string} id @param {Record<string, any>} patch */
export function setPostEffectParams(id, patch) {
	commit((state) => ({
		...state,
		effects: state.effects.map((entry) =>
			entry.id === id ? { ...entry, params: { ...entry.params, ...patch } } : entry
		)
	}));
}

/** The whole stack on/off (still scene data — "this scene has no look right now").
 * @param {boolean} enabled */
export function setScenePostEnabled(enabled) {
	commit((state) => ({ ...state, enabled: !!enabled }));
}

// ---- replication ----------------------------------------------------------

/** Remote/handshake apply: newest change wins (the environment/scenePhysics
 * pattern). @param {any} data */
export function applyRemoteScenePost(data) {
	const incoming = normalizeScenePost(data);
	if (incoming.changedAt <= (get(scenePost).changedAt || 0)) return false;
	scenePost.set(incoming);
	adoptCustomView();
	return true;
}

/** Handshake payload (singleton push, like environmentState/scenePhysicsState). */
export function scenePostState() {
	const state = get(scenePost);
	return { type: 'scenepost', enabled: state.enabled, effects: state.effects, changedAt: state.changedAt };
}

/**
 * Answer a `getscenepost` request, retrying until the connection opens (peerjs
 * silently drops anything sent before that — the sendJoints/sendAnimations
 * pattern). The handshake also PUSHES `scenePostState()` in both directions, so
 * this is the explicit re-pull path rather than the only one.
 * @param {string} peerId
 */
export function sendScenePost(peerId, attempt = 0) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	if (!get(scenePost).effects.length) return; // nothing authored, nothing to say
	const conn = peer.connections[peerId];
	if (!conn || !conn.open) {
		if (attempt < 20) setTimeout(() => sendScenePost(peerId, attempt + 1), 500);
		return;
	}
	conn.send(scenePostState());
}

// NO per-peer teardown, deliberately. Golden rule 3 asks for cleanup in
// handleDisconnected because per-peer state outlives the peer that contributed
// it — but the post stack is a SHARED SINGLETON with no per-peer keying, exactly
// like `environment`, `music` and `scenephysics`, none of which have a
// handleDisconnected entry either. A departing peer's authored look is the
// scene's look and stays, the same way their objects do. When L5 adds LUT
// textures those ride the content-hash push/pull, which has its own lifecycle.

/**
 * A scene that ARRIVES carrying a look should be seen as its author intended, so
 * the view mode is promoted to 'custom' — the mobile-AO default one level up.
 *
 * It only ever promotes a viewer who has never PICKED a mode (`chooseViewMode`
 * records that): `viewMode` persists to localStorage on every write, so the
 * stored value cannot by itself distinguish a choice from a default. And it never
 * overrides 'wireframe', which is a diagnostic view someone is actively using.
 */
export function adoptCustomView() {
	if (typeof localStorage !== 'undefined' && localStorage.getItem('viewModeChosen') === 'true') return;
	const state = get(scenePost);
	if (!state.enabled || !state.effects.some((entry) => entry.enabled)) return;
	if (get(viewMode) === 'wireframe') return;
	viewMode.set('custom');
}

// ---- persistence ---------------------------------------------------------

/** Snapshot for sessions/.tpscene/autosave. Returns null for an EMPTY stack so a
 * scene that has no look adds no field (old readers unaffected). */
export function scenePostSnapshot() {
	const state = get(scenePost);
	if (!state.effects.length) return null;
	return { enabled: state.enabled, effects: state.effects, changedAt: state.changedAt };
}

/** Restore from a save. `replicate` re-broadcasts, so loading a scene into a live
 * room brings its look along (the jointsRestore precedent).
 * @param {any} payload @param {boolean} [replicate] */
export function scenePostRestore(payload, replicate = false) {
	if (!payload) return;
	const next = normalizeScenePost(payload);
	// a restore is an authoritative local write, so it must WIN over whatever
	// changedAt the save happens to carry (an old file's stamp is in the past)
	next.changedAt = Date.now();
	scenePost.set(next);
	adoptCustomView();
	if (replicate) broadcastScenePost();
}

/** test/debug view */
export function scenePostDebug() {
	const state = get(scenePost);
	return {
		...state,
		kinds: Object.keys(postKinds),
		plan: planPostStack(state.effects.filter((entry) => entry.enabled)).groups.map((group) => ({
			type: group.type,
			kinds: group.entries.map((entry) => entry.kind)
		}))
	};
}
