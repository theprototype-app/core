import { writable, derived, get } from 'svelte/store';
import { peers } from '../stores/appStore';
import { viewportOverrides } from './viewportOverrides';
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
 * @typedef {{enabled: boolean, effects: PostEntry[], changedAt: number, mode?: 'append'|'replace'}} PostStack
 * @typedef {{key: string, label: string, type?: 'number'|'select'|'bool'|'asset', min?: number, max?: number, step?: number, decimals?: number, default: any, hint?: string, options?: {value: any, label: string}[]}} PostParam
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
 *   ownsToneMapping?: boolean,
 *   make: (params: Record<string, any>, ctx: any) => any,
 *   retarget?: (object: any, camera: any) => void,
 *   resize?: (object: any, width: number, height: number, dpr: number) => void,
 *   applyLocal?: (object: any, prefs: any, params: any) => void,
 *   dispose?: (object: any) => void}} def
 */
export function registerPostEffect(kind, def) {
	postKinds[kind] = { group: 'other', isPass: false, params: [], ...def, kind };
	// a kind arriving after a stack was loaded (a module registering late) means
	// entries that were being SKIPPED are now renderable — poke the stack so the
	// chain rebuilds. Cheap: a stamp-free update, so it never looks like an edit.
	postStacks.update((map) => ({ ...map }));
	return () => {
		delete postKinds[kind];
		postStacks.update((map) => ({ ...map }));
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

/** The scene-wide look, and the key the panel opens on. */
export const POST_SCENE_KEY = 'scene';

/**
 * Every post document, keyed `'scene' | cameraUuid`.
 *
 * KEYED, retrofitted — `hudDocs` predicted this exact migration when it chose to be
 * keyed from day one ("a HUD is scene data like the post stack, but ... retrofitting a
 * key later is a migration"). It is the flowGraphs / shaderGraphs / hudDocs shape, and
 * copying it means the monotonic-stamp rule, normalize-at-every-boundary and
 * preserve-a-newer-peer's-fields all come pre-solved.
 *
 * A CAMERA key is how a look attaches to a camera: no new concept, exactly as attaching
 * a HUD to a camera is keying `hudDocs` by that camera's uuid.
 * @type {import('svelte/store').Writable<Record<string, PostStack>>} */
export const postStacks = writable(/** @type {Record<string, PostStack>} */ ({}));

/**
 * The scene document, as a READ-ONLY view.
 *
 * Kept because ~20 call sites and 185 checks read it, and because "the scene look" is
 * still a real single thing. Writes go through the mutators below, which take a KEY.
 * @type {import('svelte/store').Readable<PostStack>} */
export const scenePost = derived(postStacks, (map) => map[POST_SCENE_KEY] ?? EMPTY_STACK);

/** one frozen empty document, so the derived above never allocates per read */
const EMPTY_STACK = normalizeScenePost(null);

/**
 * A per-peer RUNTIME override of whether a look renders: true/false, or absent for
 * "whatever the document says".
 *
 * A SEPARATE store rather than a write into the document, which is the mistake it
 * exists to avoid: the document is authored, replicated scene data, so a game node
 * flipping `enabled` inside it would turn a runtime state into authored state the
 * next edit broadcasts. This is exactly `hudScreenOverride`, which is local and
 * per-peer "ON PURPOSE" for the same reason — one player on the start menu while
 * another plays. Never replicated (the flow trigger already is) and never saved.
 * @type {import('svelte/store').Writable<Record<string, boolean>>} */
export const lookOverride = writable(/** @type {Record<string, boolean>} */ ({}));

/** @param {string} key @param {boolean} on */
export function setLookOverride(key, on) {
	lookOverride.update((map) => ({ ...map, [key || POST_SCENE_KEY]: !!on }));
}

/** Hand a document back to its own `enabled`. @param {string} key */
export function clearLookOverride(key) {
	lookOverride.update((map) => {
		const next = { ...map };
		delete next[key || POST_SCENE_KEY];
		return next;
	});
}

/** A document with any runtime override folded in — what the renderer should use.
 * @param {string} [key] */
export function resolvedDoc(key) {
	const doc = postStackFor(key);
	const over = get(lookOverride)[key || POST_SCENE_KEY];
	return typeof over === 'boolean' && over !== doc.enabled ? { ...doc, enabled: over } : doc;
}

/** @param {string} [key] */
export function postStackFor(key) {
	return get(postStacks)[key || POST_SCENE_KEY] ?? EMPTY_STACK;
}

/**
 * LOCAL kill switch, kept as a convenience VIEW of `viewportOverrides.post` so
 * consumers do not each learn the override key. B moved the state itself there —
 * one concept, so L6/L7 add a key instead of another checkbox with its own story.
 * @type {import('svelte/store').Readable<boolean>}
 */
export const postEnabledLocal = derived(viewportOverrides, (state) => state.post !== false);

// ---- the PLAN (pure) ------------------------------------------------------

/** The built-in AO entry the legacy 'shaded-ao' view mode renders, at the exact
 * parameters `Outline.svelte` hardcoded before the stack existed — that is what
 * makes that mode byte-compatible with the pre-stack chain. */
export const BUILTIN_AO = Object.freeze({ id: 'builtin-ao', kind: 'ao', enabled: true, params: {} });

/**
 * The look a CAMERA adds when you are looking through it.
 *
 * `mode` is the camera document's own field, defaulted so an absent one behaves as
 * `append`: the scene look plus this camera's, which is what HudLayer does with HUD
 * documents (it COMPOSES the scene HUD with the active camera's rather than replacing
 * one with the other). `replace` exists for the camera that is deliberately NOT the
 * house look - a security-monitor feed, a stylised inset.
 * @param {PostStack} scene @param {PostStack|null} camera @returns {PostEntry[]}
 */
export function composeLook(scene, camera) {
	const sceneOn = scene.enabled ? scene.effects.filter((entry) => entry.enabled) : [];
	if (!camera) return sceneOn;
	const cameraOn = camera.enabled ? camera.effects.filter((entry) => entry.enabled) : [];
	if (camera.mode === 'replace') return cameraOn;
	// the camera's effects run AFTER the scene's: a grade on the hero camera should
	// grade the finished house look, not be graded by it
	return [...sceneOn, ...cameraOn];
}

/**
 * Which entries this viewer should actually render.
 *
 * THE MODEL (corrected): a scene's authored look is SCENE DATA and renders for
 * everyone, the way its environment preset, fog and background music already do.
 * Nobody opts in to seeing the scene. The earlier design made the look visible
 * only in a `'custom'` view mode the viewer had to find and pick, which meant an
 * author had to tell each peer, one at a time, to go and switch it on — and once
 * anyone touched the view-mode chips at all, a "they have chosen" latch excluded
 * them from every future scene's look permanently.
 *
 * What stays LOCAL is the right to switch it off here: `localEnabled`, from
 * `viewportOverrides` (see that module for why there is one concept rather than
 * one flag per layer).
 *
 * The view MODE is what it says: a shading choice.
 *  - `wireframe`   skips post entirely — a DIAGNOSTIC view that already replaces
 *                  every material through scene.overrideMaterial.
 *  - `shaded`      no personal ambient occlusion.
 *  - `shaded-ao`   personal ambient occlusion, which applies ONLY when the scene
 *                  does not set its own. An authored look wins: two AO passes
 *                  would double every contact shadow and cost a second pass, and
 *                  it should never be ambiguous whose settings are on screen. The
 *                  UI disables that chip and says why.
 *  - `'custom'`    a legacy value from the opt-in design; treated as `shaded`.
 * Personal AO goes FIRST, before any grading — it is scene shading, not a look.
 *
 * L4's capability gate (`postOk`) and boot-compile warm-up (`postWarm`) empty the
 * whole thing: both are properties of running ANY fullscreen pass.
 *
 * @param {{stack: PostStack, cameraStack?: PostStack|null, mode: string, localEnabled?: boolean, postOk?: boolean, postWarm?: boolean}} input
 * @returns {PostEntry[]}
 */

export function effectivePostStack({
	stack,
	cameraStack = null,
	mode,
	localEnabled = true,
	postOk = true,
	postWarm = true
}) {
	if (mode === 'wireframe') return [];
	if (!postOk || !postWarm) return [];
	if (!localEnabled) return [];
	// the look you see is the scene's COMPOSED with the camera you are looking through
	// (null when that is the editor camera, which is the ordinary case)
	const authored = composeLook(normalizeScenePost(stack), cameraStack ? normalizeScenePost(cameraStack) : null);
	const personalAo = mode === 'shaded-ao' && !authored.some((entry) => entry.kind === 'ao');
	return personalAo ? [{ ...BUILTIN_AO, params: defaultPostParams('ao') }, ...authored] : authored;
}

/**
 * Does the scene's own look already provide ambient occlusion? The View section
 * asks, so it can disable the personal chip and explain instead of quietly
 * ignoring it. @param {PostStack} stack
 */
export function sceneProvidesAo(stack) {
	const state = normalizeScenePost(stack);
	return state.enabled && state.effects.some((entry) => entry.enabled && entry.kind === 'ao');
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
 * L4: does anything in this EFFECTIVE stack map the frame itself?
 *
 * `environment.applyEnvironment` asks (through the seam Outline registers) so the
 * renderer can drop to NoToneMapping — otherwise a Tone mapping entry maps an
 * image the renderer has already mapped and the highlights crush twice.
 * @param {PostEntry[]} entries
 */
export function stackOwnsToneMapping(entries) {
	return (entries ?? []).some((entry) => !!postKinds[entry.kind]?.ownsToneMapping);
}

/**
 * The cost model, for the UI to SHOW (L3's "Effects: N, passes: M" line).
 *
 * Measured over the whole AUTHORED stack rather than the effective one, because
 * this answers "what did I build", not "what is this viewer rendering". The
 * difference between `enabled` and `passes` is the merge doing its job, and
 * making that visible is the point — otherwise an eight-entry stack looks eight
 * times as expensive as it is.
 * @param {PostStack} stack
 */
export function stackCounts(stack) {
	const state = normalizeScenePost(stack);
	const active = state.effects.filter((entry) => entry.enabled);
	const plan = planPostStack(active);
	return {
		effects: state.effects.length,
		enabled: active.length,
		passes: plan.passCount,
		skipped: plan.skipped.map((entry) => entry.kind),
		merged: active.length - plan.skipped.length - plan.passCount
	};
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

/** the open gesture: which document, and its state when the drag began */
/** @type {{key: string, before: PostStack} | null} */
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
function commit(fn, key = POST_SCENE_KEY) {
	const before = gesture || applyingHistory ? null : structuredClone(postStackFor(key));
	const next = normalizeScenePost(fn(postStackFor(key)));
	// MONOTONIC per key (the shaderGraph lesson): a gesture writes several times in one
	// millisecond, so a bare Date.now() gives those edits the SAME stamp and a receiver
	// guarding with <= drops all but the first.
	next.changedAt = Math.max(Date.now(), (postStackFor(key).changedAt || 0) + 1);
	postStacks.update((map) => ({ ...map, [key]: next }));
	if (gesture) return next; // the gesture owns the entry and the broadcast
	if (before) recordLookEntry(before, next, key);
	broadcastScenePost(key);
	return next;
}

/** @param {PostStack} before @param {PostStack} after */
function recordLookEntry(before, after, key = POST_SCENE_KEY) {
	if (applyingHistory) return;
	if (JSON.stringify(before.effects) === JSON.stringify(after.effects) && before.enabled === after.enabled) return;
	recordEntry({
		kind: 'look',
		postKey: key,
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
export function beginLookGesture(key = POST_SCENE_KEY) {
	if (gesture) endLookGesture();
	// the KEY is part of the gesture: a scrub on a camera document must not commit
	// its entry against the scene's
	gesture = { key, before: structuredClone(postStackFor(key)) };
}

/** Commit the open gesture (no-op when nothing changed). */
export function endLookGesture() {
	const open = gesture;
	gesture = null;
	if (!open) return;
	recordLookEntry(open.before, postStackFor(open.key), open.key);
	broadcastScenePost(open.key);
}

// Replaying writes the stored stack locally AND replicates it, so peers follow an
// undo like any other edit (the 'joint'/'anim' presence-kind precedent).
registerHistoryKind('look', (entry, state) => {
	const target = state === entry.before ? entry.beforeStack : entry.afterStack;
	// an entry recorded before the key existed replays into the scene document
	const key = entry.postKey || POST_SCENE_KEY;
	applyingHistory = true;
	try {
		const next = normalizeScenePost(target);
		next.changedAt = Math.max(Date.now(), (postStackFor(key).changedAt || 0) + 1);
		postStacks.update((map) => ({ ...map, [key]: next }));
		broadcastScenePost(key);
	} finally {
		applyingHistory = false;
	}
	return true;
});

/** Send the current stack to every peer. */
export function broadcastScenePost(key = POST_SCENE_KEY) {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send(scenePostState(key));
}

/** Add an effect of `kind` at the end (or at `index`). @param {string} kind @param {number} [index] */
export function addPostEffect(kind, index, key = POST_SCENE_KEY) {
	let id = '';
	commit((state) => {
		const entry = { id: (id = newId()), kind, enabled: true, params: defaultPostParams(kind) };
		const effects = [...state.effects];
		effects.splice(index == null ? effects.length : index, 0, entry);
		return { ...state, effects };
	}, key);
	return id;
}

/** @param {string} id */
export function removePostEffect(id, key = POST_SCENE_KEY) {
	commit((state) => ({ ...state, effects: state.effects.filter((entry) => entry.id !== id) }), key);
}

/** Move an entry to `index` (the stack IS the order — an artist expects a stack).
 * @param {string} id @param {number} index */
export function movePostEffect(id, index, key = POST_SCENE_KEY) {
	commit((state) => {
		const from = state.effects.findIndex((entry) => entry.id === id);
		if (from < 0) return state;
		const effects = [...state.effects];
		const [entry] = effects.splice(from, 1);
		effects.splice(Math.max(0, Math.min(effects.length, index)), 0, entry);
		return { ...state, effects };
	}, key);
}

/** @param {string} id @param {boolean} enabled */
export function setPostEffectEnabled(id, enabled, key = POST_SCENE_KEY) {
	commit((state) => ({
		...state,
		// SPREAD the base record: a newer peer's fields on this entry survive our edit
		effects: state.effects.map((entry) => (entry.id === id ? { ...entry, enabled: !!enabled } : entry))
	}), key);
}

/** Patch one entry's params. @param {string} id @param {Record<string, any>} patch */
export function setPostEffectParams(id, patch, key = POST_SCENE_KEY) {
	commit((state) => ({
		...state,
		effects: state.effects.map((entry) =>
			entry.id === id ? { ...entry, params: { ...entry.params, ...patch } } : entry
		)
	}), key);
}

/**
 * How a CAMERA document combines with the scene look: 'append' (default) or
 * 'replace'. Stored on the document itself, so it replicates, saves and undoes with
 * the rest of it and needs no field of its own anywhere else.
 * @param {string} key @param {string} mode
 */
export function setCameraLookMode(key, mode) {
	const next = mode === 'replace' ? 'replace' : 'append';
	commit((state) => ({ ...state, mode: next }), key);
}

/** The whole stack on/off (still scene data — "this scene has no look right now").
 * @param {boolean} enabled */

export function setScenePostEnabled(enabled, key = POST_SCENE_KEY) {
	commit((state) => ({ ...state, enabled: !!enabled }), key);
}

// ---- replication ----------------------------------------------------------

/** Remote/handshake apply: newest change wins (the environment/scenePhysics
 * pattern). @param {any} data */
export function applyRemoteScenePost(data) {
	// a message with NO key is the scene document — which is every message a peer on
	// a pre-camera-looks build sends, so this line is the whole of their interop story
	const key = data && typeof data.key === "string" && data.key ? data.key : POST_SCENE_KEY;
	const incoming = normalizeScenePost(data);
	if (incoming.changedAt <= (postStackFor(key).changedAt || 0)) return false;
	postStacks.update((map) => ({ ...map, [key]: incoming }));
	return true;
}

/** Handshake payload (singleton push, like environmentState/scenePhysicsState). */
export function scenePostState(key = POST_SCENE_KEY) {
	const state = postStackFor(key);
	return {
		type: 'scenepost',
		// SPREAD the whole document rather than listing its fields. Hand-listing dropped
		// a camera document's `mode` on the wire — the peer got the effects and composed
		// them when the author had asked for `replace` — and it is the same mistake the
		// normalizer avoids by spreading: a field this build does not know about must
		// still reach the next peer.
		...state,
		// the key rides as an OPTIONAL field, ABSENT for the scene document, so a peer
		// on the older build reads our scene look exactly as it did and simply never
		// hears about a camera one — which it could not render anyway
		...(key === POST_SCENE_KEY ? {} : { key })
	};
}

/** Every document, for the handshake full-state reply. */
export function scenePostStates() {
	return Object.keys(get(postStacks)).map((key) => scenePostState(key));
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
	const states = scenePostStates().filter((state) => state.effects.length);
	if (!states.length) return; // nothing authored, nothing to say
	const conn = peer.connections[peerId];
	if (!conn || !conn.open) {
		if (attempt < 20) setTimeout(() => sendScenePost(peerId, attempt + 1), 500);
		return;
	}
	// one message PER DOCUMENT: the scene look and every camera look a joiner needs
	for (const state of states) conn.send(state);
}

// NO per-peer teardown, deliberately. Golden rule 3 asks for cleanup in
// handleDisconnected because per-peer state outlives the peer that contributed
// it — but the post stack is a SHARED SINGLETON with no per-peer keying, exactly
// like `environment`, `music` and `scenephysics`, none of which have a
// handleDisconnected entry either. A departing peer's authored look is the
// scene's look and stays, the same way their objects do. When L5 adds LUT
// textures those ride the content-hash push/pull, which has its own lifecycle.


// ---- persistence ---------------------------------------------------------

/** Snapshot for sessions/.tpscene/autosave. Returns null for an EMPTY stack so a
 * scene that has no look adds no field (old readers unaffected). */
export function scenePostSnapshot() {
	const map = get(postStacks);
	const keys = Object.keys(map).filter((key) => map[key]?.effects?.length);
	if (!keys.length) return null;
	const scene = map[POST_SCENE_KEY];
	return {
		// the SCENE document stays at the TOP LEVEL so a build predating camera looks
		// reads this file and gets the scene look rather than nothing — the `nodes`
		// message precedent, where a `graphs` map rides beside the legacy fields
		enabled: scene?.enabled ?? true,
		effects: scene?.effects ?? [],
		changedAt: scene?.changedAt ?? 0,
		stacks: Object.fromEntries(keys.map((key) => [key, map[key]]))
	};
}

/** Restore from a save. `replicate` re-broadcasts, so loading a scene into a live
 * room brings its look along (the jointsRestore precedent).
 * @param {any} payload @param {boolean} [replicate] */
export function scenePostRestore(payload, replicate = false) {
	if (!payload) return;
	// `stacks` is the keyed map; a payload without it is a pre-camera save whose top
	// level IS the scene document
	const source =
		payload.stacks && typeof payload.stacks === "object"
			? payload.stacks
			: { [POST_SCENE_KEY]: payload };
	/** @type {Record<string, PostStack>} */
	const next = {};
	let stamp = Date.now();
	for (const key of Object.keys(source)) {
		const doc = normalizeScenePost(source[key]);
		// a restore is an authoritative local write, so it must WIN over whatever
		// changedAt the save happens to carry (an old file's stamp is in the past);
		// stamps stay DISTINCT per key so a receiver never drops one as a duplicate
		doc.changedAt = stamp++;
		next[key] = doc;
	}
	postStacks.set(next);
	if (replicate) for (const key of Object.keys(next)) broadcastScenePost(key);
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
