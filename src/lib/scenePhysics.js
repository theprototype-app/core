import { writable, derived, get } from 'svelte/store';
import { peers } from '../stores/appStore';

// CL-A A6 / 21-B B1: scene-wide physics settings. ONE shared object for the
// whole session, replicated as its OWN latest-wins singleton message (the
// sceneMusic pattern: a changedAt stamp resolves races; deliberately NOT
// piggybacked on environment, which round-trips through preset export/import).
//
// B1 widened the payload from "just gravity" to ground / bounds / material /
// damping / ccd / timeScale / play. That adds ZERO wire surface: the message
// `type` is unchanged, so there is no new conn.on('data') case, no canApply
// entry, no handshake work (peerHandler already pushes scenePhysicsState()) and
// no handleDisconnected cleanup. That is the whole argument for housing the
// play-mode block here rather than minting a `sceneplay` singleton.
//
// physics.js reads these at world creation AND subscribes during a run, so a
// mid-sim change applies live on the stepping peer.

export const DEFAULT_GRAVITY = -9.81;

/** The shipped default state — anything equal to this writes NO `physics` key
 * into a save, so an older build sees exactly the file it wrote before. */
export const DEFAULT_SCENE_PHYSICS = Object.freeze({
	gravity: DEFAULT_GRAVITY,
	ground: { enabled: true, height: 0, friction: 0.6, restitution: 0 },
	bounds: { limit: -100, action: 'respawn' },
	material: { friction: null, restitution: null },
	damping: { linear: 0, angular: 0.05 },
	ccd: false,
	timeScale: 1,
	play: { interaction: 'grab', grounded: false, simOnPlay: false },
	changedAt: 0
});

const BOUNDS_ACTIONS = ['freeze', 'respawn', 'delete'];
const INTERACTIONS = ['grab', 'click', 'off'];

/** @param {any} v @param {number} lo @param {number} hi @param {number} fallback */
function num(v, lo, hi, fallback) {
	const n = typeof v === 'number' ? v : Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(lo, Math.min(hi, n));
}

/** null stays null ("use rapier's own"), anything else clamps.
 * @param {any} v @param {number} lo @param {number} hi */
function nullableNum(v, lo, hi) {
	if (v == null) return null;
	const n = Number(v);
	if (!Number.isFinite(n)) return null;
	return Math.max(lo, Math.min(hi, n));
}

/** @param {any} v @param {boolean} fallback */
function bool(v, fallback) {
	return typeof v === 'boolean' ? v : fallback;
}

/** @param {any} v @param {string[]} options @param {string} fallback */
function pick(v, options, fallback) {
	return typeof v === 'string' && options.includes(v) ? v : fallback;
}

/** Copy every key of `raw` that `known` did not claim — a newer peer's field
 * survives a round trip through OUR editor instead of being silently deleted.
 * @param {any} raw @param {any} known @param {string[]} claimed */
function withUnknown(raw, known, claimed) {
	if (!raw || typeof raw !== 'object') return known;
	/** @type {any} */
	const out = { ...known };
	for (const key of Object.keys(raw)) if (!claimed.includes(key)) out[key] = raw[key];
	return out;
}

/**
 * The ONE boundary normalizer — every store write (local edit, remote apply,
 * handshake, restore) goes through it. Clamps live HERE, not in the setters, so
 * a hostile or stale payload cannot install a value the UI could never produce.
 * Unknown keys are preserved verbatim, at the top level and inside each block.
 * @param {any} raw
 */
export function normalizeScenePhysics(raw) {
	const source = raw && typeof raw === 'object' ? raw : {};
	const d = DEFAULT_SCENE_PHYSICS;
	const groundRaw = source.ground && typeof source.ground === 'object' ? source.ground : {};
	const boundsRaw = source.bounds && typeof source.bounds === 'object' ? source.bounds : {};
	const materialRaw = source.material && typeof source.material === 'object' ? source.material : {};
	const dampingRaw = source.damping && typeof source.damping === 'object' ? source.damping : {};
	const playRaw = source.play && typeof source.play === 'object' ? source.play : {};
	/** @type {any} */
	const state = {
		gravity: num(source.gravity, -20, 5, d.gravity),
		ground: withUnknown(
			groundRaw,
			{
				enabled: bool(groundRaw.enabled, d.ground.enabled),
				height: num(groundRaw.height, -500, 500, d.ground.height),
				friction: num(groundRaw.friction, 0, 2, d.ground.friction),
				restitution: num(groundRaw.restitution, 0, 1, d.ground.restitution)
			},
			['enabled', 'height', 'friction', 'restitution']
		),
		bounds: withUnknown(
			boundsRaw,
			{
				limit: num(boundsRaw.limit, -10000, 0, d.bounds.limit),
				action: pick(boundsRaw.action, BOUNDS_ACTIONS, d.bounds.action)
			},
			['limit', 'action']
		),
		material: withUnknown(
			materialRaw,
			{
				friction: nullableNum(materialRaw.friction, 0, 2),
				restitution: nullableNum(materialRaw.restitution, 0, 1)
			},
			['friction', 'restitution']
		),
		damping: withUnknown(
			dampingRaw,
			{
				linear: num(dampingRaw.linear, 0, 5, d.damping.linear),
				angular: num(dampingRaw.angular, 0, 5, d.damping.angular)
			},
			['linear', 'angular']
		),
		ccd: bool(source.ccd, d.ccd),
		timeScale: num(source.timeScale, 0.1, 2, d.timeScale),
		play: withUnknown(
			playRaw,
			{
				interaction: pick(playRaw.interaction, INTERACTIONS, d.play.interaction),
				grounded: bool(playRaw.grounded, d.play.grounded),
				simOnPlay: bool(playRaw.simOnPlay, d.play.simOnPlay)
			},
			['interaction', 'grounded', 'simOnPlay']
		),
		changedAt: typeof source.changedAt === 'number' ? source.changedAt : 0
	};
	return withUnknown(source, state, [
		'gravity',
		'ground',
		'bounds',
		'material',
		'damping',
		'ccd',
		'timeScale',
		'play',
		'changedAt',
		'type' // the wire envelope's own field, never state
	]);
}

/** the shared scene state (B1: the whole object, not just gravity) */
export const scenePhysicsState_ = writable(normalizeScenePhysics({}));

/** convenience view: just the gravity number (physics + UI read this) */
export const sceneGravity = writable(DEFAULT_GRAVITY);
scenePhysicsState_.subscribe((s) => sceneGravity.set(s.gravity));

/** ground config (physics.js subscribes to this for the live rebuild) */
export const scenePhysicsGround = derived(scenePhysicsState_, (s) => s.ground);
/** out-of-bounds config. NOT named `sceneBounds` — that is sceneBounds.js */
export const scenePhysicsBounds = derived(scenePhysicsState_, (s) => s.bounds);
/** play-mode block ({interaction, grounded, simOnPlay}) */
export const scenePlay = derived(scenePhysicsState_, (s) => s.play);
/** solver defaults ({material, damping, ccd, timeScale}) */
export const scenePhysicsDefaults = derived(scenePhysicsState_, (s) => ({
	material: s.material,
	damping: s.damping,
	ccd: s.ccd,
	timeScale: s.timeScale
}));

const NESTED = ['ground', 'bounds', 'material', 'damping', 'play'];

/**
 * Apply a change locally + replicate (latest-wins). Nested blocks MERGE, so a
 * caller may pass `{ground: {height: 2}}` without restating the friction.
 * @param {any} partial
 */
export function setScenePhysics(partial) {
	const current = get(scenePhysicsState_);
	/** @type {any} */
	const merged = { ...current, ...(partial ?? {}) };
	for (const key of NESTED) {
		if (partial && partial[key] && typeof partial[key] === 'object')
			merged[key] = { ...current[key], ...partial[key] };
	}
	// a gesture can write several times inside one millisecond, and a >= guard on
	// the receiving side would drop every write after the first — bump past the
	// previous stamp so the sequence stays strictly increasing
	const state = normalizeScenePhysics({
		...merged,
		changedAt: Math.max(Date.now(), (current.changedAt ?? 0) + 1)
	});
	scenePhysicsState_.set(state);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'scenephysics', ...state });
	return state;
}

/** Scene gravity (Inspector scene ▸ Physics slider). @param {number} g */
export function setSceneGravity(g) {
	setScenePhysics({ gravity: +g || 0 });
}

/** Back to earth. */
export function resetSceneGravity() {
	setScenePhysics({ gravity: DEFAULT_GRAVITY });
}

/** Remote/handshake apply: newest change wins (env pattern). A STRICTLY older
 * document is refused — an ordered DataConnection means an equal stamp arrived
 * later, so it is the newer intent. @param {any} data */
export function applyRemoteScenePhysics(data) {
	if ((data?.changedAt ?? 0) < (get(scenePhysicsState_).changedAt ?? 0)) return;
	scenePhysicsState_.set(normalizeScenePhysics(data));
}

/** Handshake payload (singleton push, like environmentState/musicState). */
export function scenePhysicsState() {
	return { type: 'scenephysics', ...get(scenePhysicsState_) };
}

/** Save payload — null when the scene is at defaults, so a default scene writes
 * no `physics` key at all and an older build sees the file it always saw.
 * (The scenePostSnapshot precedent; L5 wires the sessions.js call site.) */
export function scenePhysicsSnapshot() {
	const state = get(scenePhysicsState_);
	const { changedAt: _stamp, ...rest } = state;
	const { changedAt: _default, ...defaults } = DEFAULT_SCENE_PHYSICS;
	if (JSON.stringify(rest) === JSON.stringify(defaults)) return null;
	return { ...rest, changedAt: state.changedAt };
}

/** Restore from a save. `replicate` re-broadcasts, so loading a scene into a
 * live room brings its physics config along (the jointsRestore precedent).
 * @param {any} payload @param {boolean} [replicate] */
export function scenePhysicsRestore(payload, replicate = false) {
	if (!payload) return;
	const next = normalizeScenePhysics(payload);
	// a restore is an authoritative local write, so it must WIN over whatever
	// changedAt the save happens to carry (an old file's stamp is in the past).
	// Monotonic for the same reason setScenePhysics is: a restore can land in the
	// same millisecond as the write before it, and an equal stamp is a coin toss.
	next.changedAt = Math.max(Date.now(), (get(scenePhysicsState_).changedAt ?? 0) + 1);
	scenePhysicsState_.set(next);
	if (replicate) {
		/** @type {any} */
		const peer = get(peers);
		if (peer) peer.send({ type: 'scenephysics', ...next });
	}
}

/** test/debug view */
export function scenePhysicsDebug() {
	return JSON.parse(JSON.stringify(get(scenePhysicsState_)));
}
