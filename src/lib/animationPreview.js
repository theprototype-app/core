import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { syncedAnimations } from '../stores/flowStore';
import { suspendAnimation, resumeAnimation } from './flowRuntime';
import { recordEntry, registerHistoryKind } from './history';

// Authored object animation, v2 (17-E). Each object owns a set of named CLIPS;
// a clip owns TRACKS (one per transform channel) and a track owns KEYS at
// absolute clip seconds. A key's `ease` shapes the segment that FOLLOWS it, so
// the cubic-bezier easing the v1 window authored is still the storage — it just
// applies per segment instead of once across the whole movement.
//
// v1 stored one `{from, to, bezier}` segment per track and no clips. That shape
// still loads: `normalizeAnimSet` runs at EVERY boundary (mutators, restore,
// remote appliers — the annotations-v2 precedent) and converts it to two keys,
// `[{t:0, v:from, ease:bezier}, {t:duration, v:to}]`, which evaluates
// IDENTICALLY. Old saves and older peers keep working.
//
// Playback is DETERMINISTIC: a transport entry carries a synced-clock stamp and
// every peer evaluates the same keys at the same time (golden rule 8), the model
// imported clips and sound loops already use. Poses are never streamed. N
// objects can play at once — a door swinging on every peer is the point.
//
// Both halves REPLICATE (17-E A2): the authored data as `animdata` (latest-wins
// per object on `changedAt`) and the transport as `animplay`, with `getanim` /
// `animations` covering late joiners. A scrub stays local — it is a look, not an
// edit. Edits are undoable through the `anim` history kind, one entry per
// gesture (`beginAnimGesture` / `endAnimGesture` wrap a key drag).

/**
 * @typedef {{ t: number, v: number, ease?: number[] }} Key a value at a clip time; `ease` shapes the NEXT segment
 * @typedef {{ id: string, channel: string, keys: Key[] }} Track keys sorted by t
 * @typedef {{ name: string, tracks: Track[], duration: number, loop: 'once'|'loop'|'pingpong' }} Clip
 * @typedef {{ clips: Record<string, Clip>, active: string, changedAt: number }} AnimSet
 * @typedef {{ clipId: string, playing: boolean, at: number, pausedAt: number, speed: number, changedAt: number }} Play
 */

/** @type {import('svelte/store').Writable<Record<string, AnimSet>>} uuid -> authored clips */
export const animations = writable({});

/** @type {import('svelte/store').Writable<Record<string, Play>>} uuid -> transport state.
 * Written on transport CHANGES only (play/pause/stop/scrub), so it stays cheap to
 * subscribe to. The per-frame time readout is `playheads`. */
export const playback = writable({});

/** @type {import('svelte/store').Writable<Record<string, number>>} uuid -> current clip seconds.
 * Written EVERY FRAME while something plays: read it for a playhead line, never
 * derive layout or run expensive work off it. */
export const playheads = writable({});

// transform channels a track can drive (rotation in radians here, degrees at the UI)
export const CHANNELS = [
	'pos.x', 'pos.y', 'pos.z',
	'rot.x', 'rot.y', 'rot.z',
	'scale', 'scale.x', 'scale.y', 'scale.z',
	'visible'
];

/** channels that HOLD their value until the next key instead of interpolating */
export const STEPPED = new Set(['visible']);

/** cubic-bezier control points [x1,y1,x2,y2] with fixed endpoints (0,0),(1,1) */
export const EASINGS = /** @type {Record<string, number[]>} */ ({
	linear: [0, 0, 1, 1],
	ease: [0.25, 0.1, 0.25, 1],
	'ease-in': [0.42, 0, 1, 1],
	'ease-out': [0, 0, 0.58, 1],
	'ease-in-out': [0.42, 0, 0.58, 1]
});

/** the clip id a legacy (v1) animation migrates into, and the id a fresh set starts with */
export const DEFAULT_CLIP = 'default';

// --- small helpers -----------------------------------------------------------

/** @param {any} v @param {number} [fallback] */
function num(v, fallback = 0) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function newId() {
	return globalThis.crypto?.randomUUID?.() ?? 'k' + Math.random().toString(36).slice(2, 10);
}

/** The shared clock every peer evaluates against — the same formula as
 * flowRuntime's syncedNow / moduleSDK's runtimeNow (neither is exported; both
 * read this store). Wall clock wrapped daily to keep float precision. */
function syncedNow() {
	return get(syncedAnimations) ? (Date.now() % 86400000) / 1000 : performance.now() / 1000;
}

/** @param {string} uuid */
function objectFor(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
}

// --- normalization / migration ------------------------------------------------

/** @param {any} raw @returns {number[]|undefined} */
function normalizeEase(raw) {
	if (!Array.isArray(raw) || raw.length !== 4) return undefined;
	const e = raw.map((n) => num(n));
	if (!e.every((n) => Number.isFinite(n))) return undefined;
	e[0] = Math.min(1, Math.max(0, e[0]));
	e[2] = Math.min(1, Math.max(0, e[2]));
	return e;
}

/** @param {any} raw @returns {Key|null} */
function normalizeKey(raw) {
	if (!raw || typeof raw !== 'object') return null;
	if (!Number.isFinite(Number(raw.t)) || !Number.isFinite(Number(raw.v))) return null;
	/** @type {Key} */
	const key = { t: Math.max(0, num(raw.t)), v: num(raw.v) };
	const ease = normalizeEase(raw.ease);
	if (ease) key.ease = ease;
	return key;
}

/** @param {any} raw @param {number} duration @returns {Track|null} */
function normalizeTrack(raw, duration) {
	if (!raw || typeof raw.channel !== 'string') return null;
	/** @type {Key[]} */
	let keys = [];
	if (Array.isArray(raw.keys)) {
		keys = /** @type {Key[]} */ (raw.keys.map(normalizeKey).filter(Boolean));
	} else if (Number.isFinite(Number(raw.from)) || Number.isFinite(Number(raw.to))) {
		// v1: ONE from->to segment across the whole clip, shaped by one bezier.
		keys = [
			{ t: 0, v: num(raw.from), ...(normalizeEase(raw.bezier) ? { ease: normalizeEase(raw.bezier) } : {}) },
			{ t: duration, v: num(raw.to) }
		];
	}
	if (!keys.length) return null;
	keys.sort((a, b) => a.t - b.t);
	return { id: typeof raw.id === 'string' && raw.id ? raw.id : newId(), channel: raw.channel, keys };
}

/** @param {any} raw @returns {Clip|null} */
function normalizeClip(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const duration = Math.max(num(raw.duration, 2) || 2, 0.01);
	const loop = raw.loop === 'once' || raw.loop === 'pingpong' ? raw.loop : 'loop';
	const name = typeof raw.name === 'string' && raw.name ? raw.name : 'Movement';
	const tracks = /** @type {Track[]} */ (
		(Array.isArray(raw.tracks) ? raw.tracks : []).map((/** @type {any} */ t) => normalizeTrack(t, duration)).filter(Boolean)
	);
	return { name, tracks, duration, loop };
}

/** Accept a v1 anim, a v2 set, or anything in between. @param {any} raw @returns {AnimSet|null} */
export function normalizeAnimSet(raw) {
	if (!raw || typeof raw !== 'object') return null;
	/** @type {Record<string, Clip>} */
	const clips = {};
	if (raw.clips && typeof raw.clips === 'object') {
		for (const [id, clip] of Object.entries(raw.clips)) {
			const c = normalizeClip(clip);
			if (c) clips[id] = c;
		}
	} else if (Array.isArray(raw.tracks)) {
		const c = normalizeClip(raw); // v1 single anim
		if (c) clips[DEFAULT_CLIP] = c;
	}
	const ids = Object.keys(clips);
	if (!ids.length) return null;
	const active = typeof raw.active === 'string' && clips[raw.active] ? raw.active : ids[0];
	return { clips, active, changedAt: num(raw.changedAt) };
}

/** @returns {AnimSet} */
function emptySet() {
	return {
		clips: { [DEFAULT_CLIP]: { name: 'Movement', tracks: [], duration: 2, loop: 'loop' } },
		active: DEFAULT_CLIP,
		changedAt: 0
	};
}

// --- reads -------------------------------------------------------------------

/** @param {string} uuid @returns {AnimSet|null} */
export function getAnimSet(uuid) {
	return normalizeAnimSet(get(animations)[uuid]);
}

/** The clip the window is editing. @param {string} uuid @returns {Clip|null} */
export function activeClip(uuid) {
	const set = getAnimSet(uuid);
	return set ? (set.clips[set.active] ?? null) : null;
}

/** Back-compat alias — v1 callers asked for "the" animation. @param {string} uuid */
export function getAnim(uuid) {
	return activeClip(uuid);
}

/** @param {string} uuid @param {string} [clipId] */
export function clipOf(uuid, clipId) {
	const set = getAnimSet(uuid);
	if (!set) return null;
	return set.clips[clipId ?? set.active] ?? set.clips[set.active] ?? null;
}

/** `[{id, name, duration, tracks}]` for a list UI. @param {string} uuid */
export function clipList(uuid) {
	const set = getAnimSet(uuid);
	if (!set) return [];
	return Object.entries(set.clips).map(([id, clip]) => ({
		id,
		name: clip.name,
		duration: clip.duration,
		tracks: clip.tracks.length,
		active: id === set.active
	}));
}

/** Read the object's current value for a channel (radians for rotation). @param {any} obj @param {string} channel */
export function channelValue(obj, channel) {
	if (!obj) return 0;
	switch (channel) {
		case 'pos.x': return obj.position.x;
		case 'pos.y': return obj.position.y;
		case 'pos.z': return obj.position.z;
		case 'rot.x': return obj.rotation.x;
		case 'rot.y': return obj.rotation.y;
		case 'rot.z': return obj.rotation.z;
		case 'scale': return obj.scale.x;
		case 'scale.x': return obj.scale.x;
		case 'scale.y': return obj.scale.y;
		case 'scale.z': return obj.scale.z;
		case 'visible': return obj.visible ? 1 : 0;
		default: return 0;
	}
}

/** @param {string} channel */
export function channelLabel(channel) {
	return (
		{
			'pos.x': 'Position X', 'pos.y': 'Position Y', 'pos.z': 'Position Z',
			'rot.x': 'Rotation X', 'rot.y': 'Rotation Y', 'rot.z': 'Rotation Z',
			scale: 'Scale', 'scale.x': 'Scale X', 'scale.y': 'Scale Y', 'scale.z': 'Scale Z',
			visible: 'Visible'
		}[channel] ?? channel
	);
}

/** @param {string} channel */
export function isRotChannel(channel) {
	return channel.startsWith('rot');
}

// --- evaluation --------------------------------------------------------------

/**
 * Evaluate a cubic-bezier easing at normalized time x in [0,1]: solve for the
 * curve parameter t where the x-component equals x, then return the y-component.
 * @param {number[]} bezier [x1,y1,x2,y2] @param {number} x
 */
export function cubicBezierEase(bezier, x) {
	const [x1, y1, x2, y2] = bezier;
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const cx = 3 * x1;
	const bx = 3 * (x2 - x1) - cx;
	const ax = 1 - cx - bx;
	const cy = 3 * y1;
	const by = 3 * (y2 - y1) - cy;
	const ay = 1 - cy - by;
	const bezX = (/** @type {number} */ t) => ((ax * t + bx) * t + cx) * t;
	const bezY = (/** @type {number} */ t) => ((ay * t + by) * t + cy) * t;
	let lo = 0;
	let hi = 1;
	let t = x;
	for (let i = 0; i < 24; i++) {
		const xEst = bezX(t);
		if (Math.abs(xEst - x) < 1e-4) break;
		if (xEst < x) lo = t;
		else hi = t;
		t = (lo + hi) / 2;
	}
	return bezY(t);
}

/**
 * The track's value at `seconds` of clip time: hold before the first key and
 * after the last, otherwise ease across the bracketing pair. A stepped channel
 * holds the left key's value for the whole segment.
 * @param {Track} track @param {number} seconds @returns {number|null}
 */
export function sampleTrack(track, seconds) {
	const keys = track?.keys;
	if (!keys?.length) return null;
	if (seconds <= keys[0].t) return keys[0].v;
	const last = keys[keys.length - 1];
	if (seconds >= last.t) return last.v;
	let i = 0;
	while (i < keys.length - 1 && keys[i + 1].t <= seconds) i++;
	const a = keys[i];
	const b = keys[i + 1];
	if (STEPPED.has(track.channel)) return a.v;
	const span = b.t - a.t;
	const x = span > 1e-6 ? (seconds - a.t) / span : 1;
	const eased = a.ease ? cubicBezierEase(a.ease, x) : x;
	return a.v + (b.v - a.v) * eased;
}

/** Every channel the clip drives at `seconds`. @param {Clip} clip @param {number} seconds
 * @returns {Record<string, number>} */
export function evaluateClip(clip, seconds) {
	/** @type {Record<string, number>} */
	const values = {};
	for (const track of clip?.tracks ?? []) {
		const v = sampleTrack(track, seconds);
		if (v !== null) values[track.channel] = v;
	}
	return values;
}

/** Normalized time for a loop mode at elapsed seconds. @param {Clip} clip @param {number} elapsed */
export function phase(clip, elapsed) {
	const dur = Math.max(clip.duration, 0.001);
	if (clip.loop === 'once') return Math.min(elapsed / dur, 1);
	if (clip.loop === 'pingpong') {
		const p = (elapsed / dur) % 2;
		return p <= 1 ? p : 2 - p;
	}
	return (elapsed / dur) % 1;
}

/** Clip SECONDS for elapsed playback seconds (keys live on the clip timeline).
 * @param {Clip} clip @param {number} elapsed */
export function clipTime(clip, elapsed) {
	return phase(clip, elapsed) * Math.max(clip.duration, 0.001);
}

/** @param {any} obj @param {string} channel @param {number} v */
function setChannel(obj, channel, v) {
	switch (channel) {
		case 'pos.x': obj.position.x = v; break;
		case 'pos.y': obj.position.y = v; break;
		case 'pos.z': obj.position.z = v; break;
		case 'rot.x': obj.rotation.x = v; break;
		case 'rot.y': obj.rotation.y = v; break;
		case 'rot.z': obj.rotation.z = v; break;
		case 'scale': obj.scale.set(v, v, v); break;
		case 'scale.x': obj.scale.x = v; break;
		case 'scale.y': obj.scale.y = v; break;
		case 'scale.z': obj.scale.z = v; break;
		case 'visible': obj.visible = v >= 0.5; break;
	}
}

// --- base pose ---------------------------------------------------------------

/** @type {Map<string, any>} uuid -> pose captured when playback began */
const bases = new Map();

/** @param {any} object */
function captureBase(object) {
	return {
		pos: object.position.toArray(),
		rot: [object.rotation.x, object.rotation.y, object.rotation.z],
		scale: object.scale.toArray(),
		visible: object.visible !== false
	};
}

/** @param {any} object @param {any} base */
function restoreBase(object, base) {
	object.position.fromArray(base.pos);
	object.rotation.set(base.rot[0], base.rot[1], base.rot[2]);
	object.scale.fromArray(base.scale);
	object.visible = base.visible !== false;
	object.updateMatrix(); // serializers read object.matrix, not the live pose (see flowRuntime)
}

/** @param {string} uuid @param {any} object */
function ensureBase(uuid, object) {
	let base = bases.get(uuid);
	if (!base) {
		base = captureBase(object);
		bases.set(uuid, base);
		suspendAnimation(uuid); // park a flow-driven object at its base so it doesn't fight us
	}
	return base;
}

/** @param {string} uuid */
function releaseBase(uuid) {
	const base = bases.get(uuid);
	if (!base) return;
	const object = objectFor(uuid);
	if (object) restoreBase(object, base);
	bases.delete(uuid);
	resumeAnimation(uuid); // released pose becomes the new flow base (no-op if untracked)
}

// --- posing ------------------------------------------------------------------

// The per-object ORIGIN (objectOrigin.js, `userData.origin`) is read INLINE here
// for the same reason flowRuntime does it: importing objectOrigin would close
// animationPreview -> objectOrigin -> history -> flowRuntime, and this module is
// already a leaf of that subtree. Keep the two readers in step.
/** @param {any} object @returns {number[]|null} */
function originOffsetOf(object) {
	const origin = object?.userData?.origin;
	if (!Array.isArray(origin) || origin.length !== 3) return null;
	return origin.some((n) => n !== 0) ? origin.map(Number) : null;
}

const pivotLocal = new THREE.Vector3();
const offsetBase = new THREE.Vector3();
const offsetNow = new THREE.Vector3();
const scaleTmp = new THREE.Vector3();
const eulerTmp = new THREE.Euler();

/**
 * Keep the object's ORIGIN fixed while keyed rotation turns it — the hinge. The
 * pivot comes from the BASE pose (flowRuntime's originPivotOf convention) and
 * rides any keyed position, so a door keyed only in rotation swings about its
 * hinge edge instead of orbiting its own centre.
 * `P = P_eval + R_base*(S_base*o) - R(t)*(S(t)*o)` — a no-op with no origin.
 * @param {any} obj @param {any} base @param {Record<string, number>} values
 */
function applyOriginPivot(obj, base, values) {
	const local = originOffsetOf(obj);
	if (!local) return;
	if (!('rot.x' in values) && !('rot.y' in values) && !('rot.z' in values)) return;
	pivotLocal.fromArray(local);
	offsetBase
		.copy(pivotLocal)
		.multiply(scaleTmp.fromArray(base.scale))
		.applyEuler(eulerTmp.set(base.rot[0], base.rot[1], base.rot[2]));
	offsetNow.copy(pivotLocal).multiply(obj.scale).applyEuler(eulerTmp.copy(obj.rotation));
	obj.position.add(offsetBase).sub(offsetNow);
}

/**
 * Pose the object at `seconds` of clip time. Unkeyed channels return to the base
 * pose first, so a clip is an absolute statement about the channels it drives.
 * @param {any} obj @param {Clip} clip @param {number} seconds @param {any} base
 */
export function poseAt(obj, clip, seconds, base) {
	restoreBase(obj, base);
	const values = evaluateClip(clip, seconds);
	for (const channel in values) setChannel(obj, channel, values[channel]);
	applyOriginPivot(obj, base, values);
	obj.updateMatrix();
}

// --- replication -------------------------------------------------------------

// set while a remote message is being applied, so an applier can reuse the same
// mutators without re-broadcasting (golden rule 1) or recording history
let applyingRemote = false;

/** @type {{uuid: string, before: any, label: string}|null} */
let gesture = null;

/** @param {string} uuid */
function broadcastAnim(uuid) {
	if (applyingRemote) return;
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	const set = get(animations)[uuid];
	if (set) peer.send({ type: 'animdata', uuid, anim: set });
	else peer.send({ type: 'animdata', uuid, anim: null });
}

/** @param {string} uuid */
function broadcastPlay(uuid) {
	if (applyingRemote) return;
	/** @type {any} */
	const peer = get(peers);
	const p = get(playback)[uuid];
	if (!peer || !p) return;
	peer.send({ type: 'animplay', uuid, ...p });
}

/** @param {string} uuid @param {any} before @param {any} after */
function recordAnimEntry(uuid, before, after) {
	if (applyingRemote) return;
	if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return;
	recordEntry({
		kind: 'anim',
		uuid,
		beforeSet: before ?? null,
		afterSet: after ?? null,
		before: 'before',
		after: 'after'
	});
}

/**
 * Collect every edit until `endAnimGesture` into ONE undo entry and ONE
 * broadcast — a key drag writes the store on every pointermove and would
 * otherwise flood both. @param {string} uuid @param {string} [label]
 */
export function beginAnimGesture(uuid, label) {
	if (gesture) endAnimGesture();
	gesture = { uuid, before: structuredClone(get(animations)[uuid] ?? null), label: label ?? 'Animation' };
}

/** Commit the open gesture (no-op when nothing changed). */
export function endAnimGesture() {
	const open = gesture;
	gesture = null;
	if (!open) return;
	const after = get(animations)[open.uuid] ?? null;
	recordAnimEntry(open.uuid, open.before, after);
	broadcastAnim(open.uuid);
}

/** A peer authored (or cleared) an object's animation — latest-wins. @param {any} data */
export function applyAnimData(data) {
	if (!data?.uuid) return;
	const incoming = normalizeAnimSet(data.anim);
	const current = get(animations)[data.uuid];
	if (incoming && current && num(current.changedAt) > num(incoming.changedAt)) return;
	applyingRemote = true;
	try {
		animations.update((map) => {
			const next = { ...map };
			if (incoming) next[data.uuid] = incoming;
			else delete next[data.uuid];
			return next;
		});
	} finally {
		applyingRemote = false;
	}
}

/** A peer started/stopped a clip — latest-wins, then evaluated locally. @param {any} data */
export function applyAnimPlay(data) {
	if (!data?.uuid) return;
	const uuid = data.uuid;
	const current = get(playback)[uuid];
	if (current && num(current.changedAt) > num(data.changedAt)) return;
	applyingRemote = true;
	try {
		if (!data.playing) {
			// mirrors stop()/pause() but keeps the SENDER's stamp, so latest-wins
			// still compares two comparable numbers
			const pausedAt = num(data.pausedAt);
			if (pausedAt === 0) {
				releaseBase(uuid); // a remote stop restores OUR copy of the base pose
				clearHead(uuid);
			}
			setPlay(uuid, { playing: false, pausedAt, changedAt: num(data.changedAt) });
			if (pausedAt > 0) posePaused(uuid); // land on the sender's exact frame
			return;
		}
		const object = objectFor(uuid);
		if (!object) return;
		ensureBase(uuid, object);
		// with the synced clock off, `at` is the sender's page time and means
		// nothing here — start from the same offset instead of a garbage elapsed
		const at = get(syncedAnimations) ? num(data.at) : syncedNow();
		setPlay(uuid, {
			clipId: typeof data.clipId === 'string' ? data.clipId : '',
			playing: true,
			at,
			pausedAt: num(data.pausedAt),
			speed: num(data.speed, 1) || 1,
			changedAt: num(data.changedAt)
		});
	} finally {
		applyingRemote = false;
	}
}

/** Merge a late-joiner snapshot (per-object latest-wins). @param {any} data */
export function applyAnimationsSnapshot(data) {
	const sets = data?.sets ?? data?.animations;
	if (sets && typeof sets === 'object') {
		for (const [uuid, anim] of Object.entries(sets)) applyAnimData({ uuid, anim });
	}
	const play = data?.playback;
	if (play && typeof play === 'object') {
		for (const [uuid, p] of Object.entries(/** @type {any} */ (play))) {
			applyAnimPlay({ uuid, ...(/** @type {any} */ (p)) });
		}
	}
}

/** Full-state reply on handshake (the sendJoints retry pattern — peerjs silently
 * drops anything sent before the connection opens). @param {string} peerId */
export function sendAnimations(peerId, attempt = 0) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	const sets = get(animations);
	if (!Object.keys(sets).length) return;
	const conn = peer.connections[peerId];
	if (!conn || !conn.open) {
		if (attempt < 20) setTimeout(() => sendAnimations(peerId, attempt + 1), 500);
		return;
	}
	conn.send({ type: 'animations', sets, playback: get(playback) });
}

// --- undo/redo ---------------------------------------------------------------

// One entry per edit (or per gesture): replaying writes the stored set locally
// AND replicates it, so peers follow an undo like any other edit (the 'joint'
// presence-kind precedent).
registerHistoryKind('anim', (entry, state) => {
	const target = state === entry.before ? entry.beforeSet : entry.afterSet;
	const set = normalizeAnimSet(target);
	if (!set) stop(entry.uuid);
	animations.update((map) => {
		const next = { ...map };
		if (set) next[entry.uuid] = { ...set, changedAt: Date.now() };
		else delete next[entry.uuid];
		return next;
	});
	broadcastAnim(entry.uuid);
	return true;
});

// --- authoring ---------------------------------------------------------------

/** Mutate an object's set through normalization, stamping `changedAt`. Records
 * one undo entry and broadcasts, unless a gesture is collecting both.
 * @param {string} uuid @param {(set: AnimSet) => AnimSet|null} fn */
function editSet(uuid, fn) {
	const before = gesture ? null : structuredClone(get(animations)[uuid] ?? null);
	let changed = false;
	animations.update((map) => {
		const set = normalizeAnimSet(map[uuid]) ?? emptySet();
		const next = fn(structuredClone(set));
		if (!next) return map;
		changed = true;
		return { ...map, [uuid]: { ...next, changedAt: Date.now() } };
	});
	if (!changed || gesture) return;
	recordAnimEntry(uuid, before, get(animations)[uuid]);
	broadcastAnim(uuid);
}

/** Mutate one clip. @param {string} uuid @param {string|null} clipId @param {(clip: Clip) => Clip|null} fn */
function editClip(uuid, clipId, fn) {
	editSet(uuid, (set) => {
		const id = clipId && set.clips[clipId] ? clipId : set.active;
		const clip = set.clips[id];
		if (!clip) return null;
		const next = fn(clip);
		if (!next) return null;
		set.clips[id] = next;
		return set;
	});
}

/** A visible default for the second key of a fresh track. @param {string} channel @param {number} from */
function defaultTo(channel, from) {
	if (channel === 'visible') return from >= 0.5 ? 0 : 1;
	if (channel.startsWith('scale')) return from * 1.5 || 1.5;
	if (isRotChannel(channel)) return from + Math.PI / 2;
	return from + 2;
}

/**
 * Add a movement track to the active clip: two keys, the first at the object's
 * current value and the second a visible delta, so it is demoable immediately.
 * @param {string} uuid @param {string} channel @param {any} [obj] @param {string} [clipId]
 */
export function addTrack(uuid, channel, obj, clipId) {
	const from = channelValue(obj ?? objectFor(uuid), channel);
	const id = newId();
	editClip(uuid, clipId ?? null, (clip) => ({
		...clip,
		tracks: [
			...clip.tracks,
			{
				id,
				channel,
				keys: [
					{ t: 0, v: from, ease: [...EASINGS['ease-in-out']] },
					{ t: clip.duration, v: defaultTo(channel, from) }
				]
			}
		]
	}));
	return id;
}

/** @param {string} uuid @param {string} trackId @param {string} [clipId] */
export function removeTrack(uuid, trackId, clipId) {
	editClip(uuid, clipId ?? null, (clip) => ({
		...clip,
		tracks: clip.tracks.filter((t) => t.id !== trackId)
	}));
}

/** Patch a track. Legacy `{from, to, bezier}` patches map onto the first/last keys.
 * @param {string} uuid @param {string} trackId @param {any} patch @param {string} [clipId] */
export function updateTrack(uuid, trackId, patch, clipId) {
	editClip(uuid, clipId ?? null, (clip) => ({
		...clip,
		tracks: clip.tracks.map((t) => {
			if (t.id !== trackId) return t;
			const next = { ...t, ...patch };
			const keys = [...t.keys];
			if ('from' in patch && keys.length) keys[0] = { ...keys[0], v: num(patch.from) };
			if ('to' in patch && keys.length) keys[keys.length - 1] = { ...keys[keys.length - 1], v: num(patch.to) };
			if ('bezier' in patch && keys.length) {
				const ease = normalizeEase(patch.bezier);
				keys[0] = ease ? { ...keys[0], ease } : { t: keys[0].t, v: keys[0].v };
			}
			delete next.from;
			delete next.to;
			delete next.bezier;
			next.keys = Array.isArray(patch.keys) ? patch.keys : keys;
			return next;
		})
	}));
}

/**
 * Patch the active clip (duration / loop / name).
 *
 * Changing `duration` RESCALES key times when the movement FILLS the clip (its
 * last key sits at the old end) — that is what a length control means, and it
 * keeps the v1 "dur stretches the movement" behaviour a migrated save expects.
 * When the keys stop short of the end the tail is a deliberate hold, so their
 * times are left alone and only the loop length changes.
 * @param {string} uuid @param {Partial<Clip>} patch @param {string} [clipId]
 */
export function updateAnim(uuid, patch, clipId) {
	editClip(uuid, clipId ?? null, (clip) => {
		const next = { ...clip, ...patch };
		next.duration = Math.max(num(next.duration, 2) || 2, 0.01);
		if (next.loop !== 'once' && next.loop !== 'pingpong') next.loop = 'loop';
		if (patch.duration !== undefined && next.duration !== clip.duration && clip.duration > 0) {
			const lastT = clip.tracks.reduce((m, t) => Math.max(m, t.keys[t.keys.length - 1]?.t ?? 0), 0);
			if (lastT >= clip.duration - 1e-4) {
				const k = next.duration / clip.duration;
				next.tracks = clip.tracks.map((t) => ({
					...t,
					keys: t.keys.map((key) => ({ ...key, t: key.t * k }))
				}));
			}
		}
		return next;
	});
}

// --- clips -------------------------------------------------------------------
// An object can hold several named movements ("Open", "Close", "Idle") and the
// window lists them beside the clips an imported model shipped with. `active` is
// the object's DEFAULT clip: it is scene data, so it replicates and saves, and it
// is what play() and the Play Animation node use when nobody names a clip.

/** @param {string} uuid @param {string} [name] @returns {string} the new clip id */
export function createClip(uuid, name) {
	const id = newId();
	editSet(uuid, (set) => {
		const count = Object.keys(set.clips).length + 1;
		set.clips[id] = {
			name: name || 'Clip ' + count,
			tracks: [],
			duration: 2,
			loop: 'loop'
		};
		set.active = id;
		return set;
	});
	return id;
}

/** @param {string} uuid @param {string} clipId @param {string} name */
export function renameClip(uuid, clipId, name) {
	const clean = String(name ?? '').trim();
	if (!clean) return;
	editClip(uuid, clipId, (clip) => ({ ...clip, name: clean }));
}

/** @param {string} uuid @param {string} clipId @returns {string} the copy's id */
export function duplicateClip(uuid, clipId) {
	const id = newId();
	editSet(uuid, (set) => {
		const source = set.clips[clipId] ?? set.clips[set.active];
		if (!source) return null;
		set.clips[id] = {
			...structuredClone(source),
			name: source.name + ' copy',
			// fresh track ids: two clips must never share one (a UI selection, and any
			// per-track lookup, is keyed by it)
			tracks: source.tracks.map((t) => ({ ...structuredClone(t), id: newId() }))
		};
		set.active = id;
		return set;
	});
	return id;
}

/** Delete a clip. Removing the last one clears the object's animation entirely.
 * @param {string} uuid @param {string} clipId */
export function deleteClip(uuid, clipId) {
	const set = getAnimSet(uuid);
	if (!set || !set.clips[clipId]) return;
	if (get(playback)[uuid]?.clipId === clipId) stop(uuid);
	if (Object.keys(set.clips).length <= 1) {
		const before = structuredClone(get(animations)[uuid] ?? null);
		animations.update((map) => {
			const next = { ...map };
			delete next[uuid];
			return next;
		});
		recordAnimEntry(uuid, before, null);
		broadcastAnim(uuid);
		return;
	}
	editSet(uuid, (next) => {
		delete next.clips[clipId];
		if (next.active === clipId) next.active = Object.keys(next.clips)[0];
		return next;
	});
}

/** Make a clip the object's default (replicated — it is scene data).
 * @param {string} uuid @param {string} clipId */
export function setActiveClip(uuid, clipId) {
	editSet(uuid, (set) => {
		if (!set.clips[clipId] || set.active === clipId) return null;
		set.active = clipId;
		return set;
	});
}

/** Insert (or replace) a key. Extends the clip when the key lands past its end.
 * @param {string} uuid @param {string} trackId @param {number} t @param {number} v
 * @param {{ease?: number[], clipId?: string}} [opts] */
export function addKey(uuid, trackId, t, v, opts = {}) {
	const at = Math.max(0, num(t));
	editClip(uuid, opts.clipId ?? null, (clip) => {
		const tracks = clip.tracks.map((track) => {
			if (track.id !== trackId) return track;
			const keys = track.keys.filter((k) => Math.abs(k.t - at) > 1e-4);
			const ease = normalizeEase(opts.ease) ?? [...EASINGS['ease-in-out']];
			keys.push({ t: at, v: num(v), ease });
			keys.sort((a, b) => a.t - b.t);
			return { ...track, keys };
		});
		return { ...clip, tracks, duration: Math.max(clip.duration, at) };
	});
}

/** Move or reshape a key by INDEX. @param {string} uuid @param {string} trackId @param {number} index
 * @param {{t?: number, v?: number, ease?: number[]|null}} patch @param {string} [clipId] */
export function updateKey(uuid, trackId, index, patch, clipId) {
	editClip(uuid, clipId ?? null, (clip) => {
		let end = clip.duration;
		const tracks = clip.tracks.map((track) => {
			if (track.id !== trackId) return track;
			const keys = track.keys.map((k, i) => {
				if (i !== index) return k;
				/** @type {Key} */
				const next = { t: k.t, v: k.v, ...(k.ease ? { ease: k.ease } : {}) };
				if (patch.t !== undefined) next.t = Math.max(0, num(patch.t));
				if (patch.v !== undefined) next.v = num(patch.v);
				if (patch.ease !== undefined) {
					const ease = normalizeEase(patch.ease);
					if (ease) next.ease = ease;
					else delete next.ease;
				}
				end = Math.max(end, next.t);
				return next;
			});
			keys.sort((a, b) => a.t - b.t);
			return { ...track, keys };
		});
		return { ...clip, tracks, duration: end };
	});
}

/** @param {string} uuid @param {string} trackId @param {number} index @param {string} [clipId] */
export function removeKey(uuid, trackId, index, clipId) {
	editClip(uuid, clipId ?? null, (clip) => ({
		...clip,
		tracks: clip.tracks.map((track) => {
			if (track.id !== trackId) return track;
			if (track.keys.length <= 1) return track; // a track always keeps one key
			return { ...track, keys: track.keys.filter((_, i) => i !== index) };
		})
	}));
}

// --- saving ------------------------------------------------------------------
// Authored clips are plain JSON, so a save carries them verbatim (17-D). Orphans
// are pruned at SERIALIZE time only — the store keeps an entry after its object
// is deleted so undoing that delete finds the animation intact (the flowGraphs
// serializeGraphs precedent).

/** Every authored animation, for a save payload. @returns {any} */
export function animationsSnapshot() {
	const map = get(animations);
	const group = get(objectsGroup);
	/** @type {any} */
	const out = {};
	for (const [uuid, raw] of Object.entries(map)) {
		const set = normalizeAnimSet(raw);
		if (!set) continue;
		if (group && !group.getObjectByProperty('uuid', uuid)) continue;
		out[uuid] = structuredClone(set);
	}
	return out;
}

/** Restore authored animations from a save payload. `replicate` pushes the whole
 * set to peers, the way a session load re-broadcasts its joints — an autosave
 * restore at boot leaves it off. @param {any} saved @param {boolean} [replicate] */
export function animationsRestore(saved, replicate = false) {
	if (!saved || typeof saved !== 'object') return 0;
	stopAll(); // never leave a preview running against objects that just changed
	/** @type {any} */
	const clean = {};
	for (const [uuid, raw] of Object.entries(/** @type {any} */ (saved))) {
		const set = normalizeAnimSet(raw);
		if (set) clean[uuid] = set;
	}
	animations.set(clean);
	if (replicate && Object.keys(clean).length) {
		/** @type {any} */
		const peer = get(peers);
		if (peer) peer.send({ type: 'animations', sets: clean, playback: {} });
	}
	return Object.keys(clean).length;
}

// A wipe is LOCAL on purpose: `clearscene` already replicates and every peer runs
// clearSceneLocal, so broadcasting here would be a second delete. Deleting one
// OBJECT deliberately keeps its animation (undo needs it) — the serializer prunes.

/** Forget an object's animation (scene wipe). @param {string} uuid */
export function dropAnimation(uuid) {
	stop(uuid);
	animations.update((map) => {
		if (!(uuid in map)) return map;
		const next = { ...map };
		delete next[uuid];
		return next;
	});
	playback.update((map) => {
		if (!(uuid in map)) return map;
		const next = { ...map };
		delete next[uuid];
		return next;
	});
}

/** Forget every authored animation (scene wipe). */
export function dropAllAnimations() {
	stopAll();
	animations.set({});
	playback.set({});
}

// --- transport ---------------------------------------------------------------

/** @param {string} uuid @returns {Play} */
function playOf(uuid) {
	return (
		get(playback)[uuid] ?? { clipId: '', playing: false, at: 0, pausedAt: 0, speed: 1, changedAt: 0 }
	);
}

/** @param {Play} p @param {number} now */
function elapsedOf(p, now) {
	return p.playing ? p.pausedAt + (now - p.at) * (p.speed || 1) : p.pausedAt;
}

/** @param {string} uuid @param {Partial<Play>} patch @param {boolean} [replicate] */
function setPlay(uuid, patch, replicate = false) {
	playback.update((map) => ({
		...map,
		[uuid]: { ...playOf(uuid), ...patch, changedAt: patch.changedAt ?? Date.now() }
	}));
	if (replicate) broadcastPlay(uuid);
}

/** @param {string} uuid */
function clearHead(uuid) {
	playheads.update((map) => {
		if (!(uuid in map)) return map;
		const next = { ...map };
		delete next[uuid];
		return next;
	});
}

/** Current clip seconds for an object (0 when idle). @param {string} uuid */
export function playheadOf(uuid) {
	const p = get(playback)[uuid];
	if (!p) return 0;
	const clip = clipOf(uuid, p.clipId);
	if (!clip) return 0;
	const elapsed = elapsedOf(p, syncedNow());
	return clip.loop === 'once' ? Math.min(elapsed, clip.duration) : clipTime(clip, elapsed);
}

/** Start (or resume) playback. @param {string} uuid @param {string} [clipId] @param {{speed?: number, from?: number}} [opts] */
export function play(uuid, clipId, opts = {}) {
	if (typeof uuid !== 'string') return;
	const obj = objectFor(uuid);
	if (!obj) return;
	const prev = playOf(uuid);
	const id = clipId ?? prev.clipId;
	const clip = clipOf(uuid, id);
	if (!clip) return;
	const set = getAnimSet(uuid);
	ensureBase(uuid, obj);
	const from = opts.from ?? (prev.pausedAt >= clip.duration && clip.loop === 'once' ? 0 : prev.pausedAt);
	setPlay(
		uuid,
		{
			clipId: id || set?.active || DEFAULT_CLIP,
			playing: true,
			at: syncedNow(),
			pausedAt: from,
			speed: opts.speed ?? prev.speed ?? 1
		},
		true
	);
}

/** Pose the object at its paused time, so a pause lands on the same frame on
 * every peer instead of leaving each one wherever its last tick got to.
 * @param {string} uuid */
function posePaused(uuid) {
	const p = get(playback)[uuid];
	const clip = clipOf(uuid, p?.clipId);
	const obj = objectFor(uuid);
	const base = bases.get(uuid);
	if (!p || p.playing || !clip || !obj || !base) return;
	const at = p.pausedAt;
	poseAt(obj, clip, clip.loop === 'once' ? Math.min(at, clip.duration) : clipTime(clip, at), base);
	playheads.update((map) => ({ ...map, [uuid]: at }));
}

/** @param {string} uuid */
export function pause(uuid) {
	if (typeof uuid !== 'string') return pauseAll();
	const p = get(playback)[uuid];
	if (!p?.playing) return;
	setPlay(uuid, { playing: false, pausedAt: elapsedOf(p, syncedNow()) }, true);
	posePaused(uuid);
}

export function pauseAll() {
	for (const uuid of Object.keys(get(playback))) pause(uuid);
}

/** Stop and restore the pose captured when playback began. Omit `uuid` to stop
 * everything (the transport button passes a click event — guarded).
 * @param {string} [uuid] */
export function stop(uuid) {
	if (typeof uuid !== 'string') return stopAll();
	releaseBase(uuid);
	if (get(playback)[uuid]) setPlay(uuid, { playing: false, pausedAt: 0 }, true);
	clearHead(uuid);
}

export function stopAll() {
	for (const uuid of new Set([...bases.keys(), ...Object.keys(get(playback))])) stop(uuid);
	playheads.set({});
}

/** Preview a specific time without running (scrubber drag). LOCAL — a scrub is a
 * look, not a broadcast. @param {string} uuid @param {number} seconds @param {string} [clipId] */
export function scrub(uuid, seconds, clipId) {
	const obj = objectFor(uuid);
	const p = playOf(uuid);
	const clip = clipOf(uuid, clipId ?? p.clipId);
	if (!obj || !clip) return;
	const at = Math.max(0, num(seconds));
	const base = ensureBase(uuid, obj);
	setPlay(uuid, {
		clipId: clipId ?? (p.clipId || DEFAULT_CLIP),
		pausedAt: at,
		at: syncedNow()
	});
	poseAt(obj, clip, clip.loop === 'once' ? Math.min(at, clip.duration) : clipTime(clip, at), base);
	playheads.update((map) => ({ ...map, [uuid]: at }));
}

/** @param {string} uuid @param {number} speed */
export function setSpeed(uuid, speed) {
	const p = playOf(uuid);
	const now = syncedNow();
	setPlay(uuid, { pausedAt: elapsedOf(p, now), at: now, speed: Math.max(0.05, num(speed, 1)) }, true);
}

/** Re-pose everything that is playing. Per-frame from the scene loop (Scene.svelte useTask). */
export function tickAnimationPreview() {
	const map = get(playback);
	const uuids = Object.keys(map);
	if (!uuids.length) return;
	const now = syncedNow();
	/** @type {Record<string, number>} */
	const heads = {};
	/** @type {string[]} */
	const finished = [];
	let any = false;
	for (const uuid of uuids) {
		const p = map[uuid];
		if (!p?.playing) continue;
		const clip = clipOf(uuid, p.clipId);
		const obj = objectFor(uuid);
		if (!clip || !obj) continue;
		const base = ensureBase(uuid, obj);
		const elapsed = elapsedOf(p, now);
		const dur = Math.max(clip.duration, 0.001);
		const done = clip.loop === 'once' && elapsed >= dur;
		poseAt(obj, clip, done ? dur : clipTime(clip, elapsed), base);
		heads[uuid] = done ? dur : elapsed % dur;
		any = true;
		if (done) finished.push(uuid);
	}
	if (any || Object.keys(get(playheads)).length) playheads.set(heads);
	// a 'once' clip ends on its own on EVERY peer at the same elapsed time, so
	// this is a local state change — never a broadcast.
	for (const uuid of finished) {
		const p = get(playback)[uuid];
		const clip = clipOf(uuid, p?.clipId);
		setPlay(uuid, { playing: false, pausedAt: clip ? clip.duration : 0 });
	}
}
