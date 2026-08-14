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
 * @typedef {{ clipId: string, playing: boolean, at: number, pausedAt: number, speed: number, reverse?: boolean, startedFrom?: number, rangeIn?: number, rangeOut?: number, changedAt: number }} Play
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

// Channels a track can drive (rotation in radians here, degrees at the UI).
// Transform first, then the look: fading something out, tinting it, dimming a lamp
// and dulling a highlight are the everyday product-viz moves, and each is one
// scalar — the same shape as a position, which is why they fit the same keys. A
// colour is three channels, exactly as a scalar keyframe system does it.
export const CHANNELS = [
	'pos.x', 'pos.y', 'pos.z',
	'rot.x', 'rot.y', 'rot.z',
	'scale', 'scale.x', 'scale.y', 'scale.z',
	'visible',
	'opacity',
	'color.r', 'color.g', 'color.b',
	'metalness', 'roughness', 'emissive',
	'light.intensity'
];

/** channels that HOLD their value until the next key instead of interpolating */
export const STEPPED = new Set(['visible']);

/** channels that drive the MATERIAL rather than the transform (they need the
 * material state captured so Stop can put it back, and glTF cannot carry them) */
export const MATERIAL_CHANNELS = new Set([
	'opacity', 'color.r', 'color.g', 'color.b', 'metalness', 'roughness', 'emissive'
]);

/** @param {string} channel */
export function isMaterialChannel(channel) {
	return MATERIAL_CHANNELS.has(channel) || channel === 'light.intensity';
}

/** Every material of an object as a flat list — a mesh with UV slots has an ARRAY,
 * and an animated look should drive all of them. @param {any} obj */
function materialsOf(obj) {
	const material = obj?.material;
	if (!material) return [];
	return Array.isArray(material) ? material.filter(Boolean) : [material];
}

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

/** The clip id behind a NAME — flow nodes and the SDK name clips, they do not
 * know ids. Falls back to null so a caller can use the object's default clip.
 * @param {string} uuid @param {string} name */
export function clipIdByName(uuid, name) {
	const set = getAnimSet(uuid);
	if (!set || !name) return null;
	const wanted = String(name).trim().toLowerCase();
	for (const [id, clip] of Object.entries(set.clips)) {
		if (id === name || clip.name.trim().toLowerCase() === wanted) return id;
	}
	return null;
}

/** Is this object's authored animation running? @param {string} uuid */
export function isPlaying(uuid) {
	return !!get(playback)[uuid]?.playing;
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
	const material = materialsOf(obj)[0];
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
		case 'opacity': return material?.opacity ?? 1;
		case 'color.r': return material?.color?.r ?? 1;
		case 'color.g': return material?.color?.g ?? 1;
		case 'color.b': return material?.color?.b ?? 1;
		case 'metalness': return material?.metalness ?? 0;
		case 'roughness': return material?.roughness ?? 1;
		case 'emissive': return material?.emissiveIntensity ?? 0;
		case 'light.intensity': return obj.isLight ? (obj.intensity ?? 1) : 0;
		default: return 0;
	}
}

/** Can this object be animated on this channel at all? (the picker greys out the
 * rest — offering `light.intensity` on a box is a dead track) @param {any} obj
 * @param {string} channel */
export function channelApplies(obj, channel) {
	if (!obj) return false;
	if (channel === 'light.intensity') return !!obj.isLight;
	if (!MATERIAL_CHANNELS.has(channel)) return true;
	const material = materialsOf(obj)[0];
	if (!material) return false;
	if (channel === 'metalness') return material.metalness !== undefined;
	if (channel === 'roughness') return material.roughness !== undefined;
	if (channel === 'emissive') return material.emissiveIntensity !== undefined;
	if (channel.startsWith('color')) return !!material.color;
	return true;
}

/** @param {string} channel */
export function channelLabel(channel) {
	return (
		{
			'pos.x': 'Position X', 'pos.y': 'Position Y', 'pos.z': 'Position Z',
			'rot.x': 'Rotation X', 'rot.y': 'Rotation Y', 'rot.z': 'Rotation Z',
			scale: 'Scale', 'scale.x': 'Scale X', 'scale.y': 'Scale Y', 'scale.z': 'Scale Z',
			visible: 'Visible',
			opacity: 'Opacity',
			'color.r': 'Colour R', 'color.g': 'Colour G', 'color.b': 'Colour B',
			metalness: 'Metalness', roughness: 'Roughness', emissive: 'Glow',
			'light.intensity': 'Light intensity'
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

/**
 * The A/B window playback runs inside: the whole clip unless in/out points are
 * set. Animators loop a few seconds while they tune them, and it is part of the
 * TRANSPORT (so it replicates and every peer evaluates the same window) rather
 * than a local view setting — a door can legitimately play only part of a clip.
 * Absent fields mean the whole clip, so existing data behaves exactly as before.
 * @param {Clip} clip @param {{rangeIn?: number, rangeOut?: number}} [play]
 */
export function rangeOf(clip, play) {
	const dur = Math.max(clip.duration, 0.001);
	const from = Math.min(Math.max(num(play?.rangeIn, 0), 0), dur);
	const toRaw = play?.rangeOut === undefined ? dur : num(play.rangeOut, dur);
	const to = Math.min(Math.max(toRaw, from + 0.01), dur);
	return { from, to, span: to - from };
}

/**
 * The clip position to pose, honouring direction and the A/B window.
 *
 * Playback REVERSES rather than needing a mirrored clip: a door authored
 * closed->open plays backwards to shut, which is what "toggle" means on a door
 * and what the Play Animation node uses. Elapsed always counts UP; only the
 * mapping to clip time flips.
 * @param {Clip} clip @param {number} elapsed @param {boolean} [reverse]
 * @param {{rangeIn?: number, rangeOut?: number}} [play]
 */
export function clipSecondsFor(clip, elapsed, reverse = false, play = undefined) {
	const { from, to, span } = rangeOf(clip, play);
	let phase01;
	if (clip.loop === 'once') phase01 = Math.min(elapsed / span, 1);
	else if (clip.loop === 'pingpong') {
		const p = (elapsed / span) % 2;
		phase01 = p <= 1 ? p : 2 - p;
	} else phase01 = (elapsed / span) % 1;
	return reverse ? to - phase01 * span : from + phase01 * span;
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
		case 'light.intensity':
			if (obj.isLight) obj.intensity = Math.max(0, v);
			break;
		case 'opacity': {
			// An opacity below 1 does NOTHING without the transparent flag, and that
			// flag changes the render program, so it needs needsUpdate — and Stop has
			// to put both back (restoreBase does).
			const opacity = Math.min(1, Math.max(0, v));
			for (const material of materialsOf(obj)) {
				material.opacity = opacity;
				const wantsTransparent = opacity < 1 || material.transparent;
				if (wantsTransparent && !material.transparent) {
					material.transparent = true;
					material.needsUpdate = true;
				}
			}
			break;
		}
		case 'color.r': case 'color.g': case 'color.b': {
			const key = channel.slice(-1);
			for (const material of materialsOf(obj)) {
				if (material.color) material.color[key] = Math.min(1, Math.max(0, v));
			}
			break;
		}
		case 'metalness': case 'roughness': {
			for (const material of materialsOf(obj)) {
				if (material[channel] !== undefined) material[channel] = Math.min(1, Math.max(0, v));
			}
			break;
		}
		case 'emissive': {
			for (const material of materialsOf(obj)) {
				if (material.emissiveIntensity !== undefined) material.emissiveIntensity = Math.max(0, v);
			}
			break;
		}
	}
}

// --- base pose ---------------------------------------------------------------

/** @type {Map<string, any>} uuid -> pose captured when playback began */
const bases = new Map();

/** @param {any} object */
function captureBase(object) {
	// The LOOK is captured beside the transform, so Stop restores a faded or tinted
	// object as faithfully as a moved one. `transparent` rides along because
	// animating opacity has to switch it on and that is a render-program change.
	const materials = materialsOf(object).map((material) => ({
		opacity: material.opacity,
		transparent: !!material.transparent,
		color: material.color ? [material.color.r, material.color.g, material.color.b] : null,
		metalness: material.metalness,
		roughness: material.roughness,
		emissiveIntensity: material.emissiveIntensity
	}));
	return {
		pos: object.position.toArray(),
		rot: [object.rotation.x, object.rotation.y, object.rotation.z],
		scale: object.scale.toArray(),
		visible: object.visible !== false,
		materials,
		intensity: object.isLight ? object.intensity : undefined
	};
}

/** @param {any} object @param {any} base */
function restoreBase(object, base) {
	object.position.fromArray(base.pos);
	object.rotation.set(base.rot[0], base.rot[1], base.rot[2]);
	object.scale.fromArray(base.scale);
	object.visible = base.visible !== false;
	if (base.intensity !== undefined && object.isLight) object.intensity = base.intensity;
	if (base.materials?.length) {
		const live = materialsOf(object);
		for (let i = 0; i < live.length && i < base.materials.length; i++) {
			const material = live[i];
			const saved = base.materials[i];
			if (saved.opacity !== undefined) material.opacity = saved.opacity;
			if (material.transparent !== saved.transparent) {
				material.transparent = saved.transparent;
				material.needsUpdate = true;
			}
			if (saved.color && material.color) material.color.setRGB(saved.color[0], saved.color[1], saved.color[2]);
			if (saved.metalness !== undefined) material.metalness = saved.metalness;
			if (saved.roughness !== undefined) material.roughness = saved.roughness;
			if (saved.emissiveIntensity !== undefined) material.emissiveIntensity = saved.emissiveIntensity;
		}
	}
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
			reverse: !!data.reverse,
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
 * `duration` is the clip's LENGTH and nothing else: keys keep the times they were
 * authored at, so lengthening leaves a hold at the end and shortening parks the
 * tail past it (the keys are still there — nothing is destroyed by typing in a
 * number field). That is the split every animation tool makes:
 *   - length  -> this, non-destructive;
 *   - timing  -> `retimeClip`, an explicit "make the movement itself longer";
 *   - speed   -> `setSpeed`, playback rate, which changes no data at all.
 * @param {string} uuid @param {Partial<Clip>} patch @param {string} [clipId]
 */
export function updateAnim(uuid, patch, clipId) {
	editClip(uuid, clipId ?? null, (clip) => {
		const next = { ...clip, ...patch };
		next.duration = Math.max(num(next.duration, 2) || 2, 0.01);
		if (next.loop !== 'once' && next.loop !== 'pingpong') next.loop = 'loop';
		return next;
	});
}

/**
 * RETIME: stretch or squash the movement itself, scaling every key time by the
 * same ratio so the shape is preserved and only its pace changes. This is the
 * destructive half of the old duration field, now something you ask for.
 * @param {string} uuid @param {number} duration @param {string} [clipId]
 */
export function retimeClip(uuid, duration, clipId) {
	const target = Math.max(num(duration, 2) || 2, 0.01);
	let ratio = 1;
	editClip(uuid, clipId ?? null, (clip) => {
		if (clip.duration <= 0) return null;
		// scale against the movement's own SPAN when it stops short of the clip end,
		// so "retime to 4s" makes the movement take 4s either way
		const lastT = clip.tracks.reduce((m, t) => Math.max(m, t.keys[t.keys.length - 1]?.t ?? 0), 0);
		const span = lastT > 1e-4 ? lastT : clip.duration;
		ratio = target / span;
		if (Math.abs(ratio - 1) < 1e-9) return null;
		return {
			...clip,
			duration: target,
			tracks: clip.tracks.map((t) => ({
				...t,
				keys: t.keys.map((key) => ({ ...key, t: key.t * ratio }))
			}))
		};
	});
	// The transport stores ELAPSED seconds, so rescaling the keys without rescaling
	// it leaves the playhead pointing somewhere else entirely: a door that had just
	// finished shutting reported itself two thirds open, and the next toggle swung
	// it the wrong way.
	if (ratio !== 1) {
		const p = get(playback)[uuid];
		if (p) {
			const now = syncedNow();
			setPlay(uuid, { at: now, pausedAt: elapsedOf(p, now) * ratio });
		}
	}
	return ratio;
}

// --- clips -------------------------------------------------------------------
// An object can hold several named movements ("Open", "Close", "Idle") and the
// window lists them beside the clips an imported model shipped with. `active` is
// the object's DEFAULT clip: it is scene data, so it replicates and saves, and it
// is what play() and the Play Animation node use when nobody names a clip.

/**
 * Point the TRANSPORT at a clip: stop whatever was running (which restores the
 * base pose) and rewind onto the new one.
 *
 * Every path that changes which clip is current goes through here — picking one in
 * the list, creating one, duplicating one, adding a preset. Without it the panel
 * showed the new clip while playback carried on with the old one, which is exactly
 * what "after creating a new clip it still plays the old animation" was.
 * @param {string} uuid @param {string} clipId
 */
function switchTransportTo(uuid, clipId) {
	stop(uuid);
	setPlay(uuid, { clipId, pausedAt: 0, reverse: false }, true);
}

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
	switchTransportTo(uuid, id);
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
	switchTransportTo(uuid, id);
	return id;
}

/** Delete a clip. Removing the last one clears the object's animation entirely.
 * @param {string} uuid @param {string} clipId */
export function deleteClip(uuid, clipId) {
	const set = getAnimSet(uuid);
	if (!set || !set.clips[clipId]) return;
	if (get(playback)[uuid]?.clipId === clipId) resetPreview(uuid);
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

/**
 * Make a clip the one being edited, and the object's default (it is scene data,
 * so it replicates and saves).
 *
 * The TRANSPORT has to follow. It stores which clip it is playing, and leaving
 * that pointing at the previous clip is what made picking a clip in the list look
 * like nothing happened: the panel showed the new clip's keys while play() still
 * ran the old one ("the previous clip got stuck"). Switching therefore returns the
 * object to its base pose and rewinds — a clip is an absolute statement about the
 * channels it drives, so continuing at the old clip's time would be meaningless.
 * @param {string} uuid @param {string} clipId
 */
export function setActiveClip(uuid, clipId) {
	const set = getAnimSet(uuid);
	if (!set || !set.clips[clipId]) return;
	const p = get(playback)[uuid];
	const wasPlaying = !!p?.playing;
	if (set.active !== clipId) {
		editSet(uuid, (next) => {
			if (!next.clips[clipId] || next.active === clipId) return null;
			next.active = clipId;
			return next;
		});
	}
	if (p && p.clipId === clipId) return; // transport already on this clip
	switchTransportTo(uuid, clipId);
	// picking a clip while something was running keeps it running — on the new clip
	if (wasPlaying) play(uuid, clipId, { from: 0 });
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

/**
 * Move SEVERAL keys in one edit — what a multi-selection drag needs. Each entry
 * names a track, the key's CURRENT index and its new time/value; every track is
 * rewritten once and re-sorted afterwards, so a drag across two channels stays one
 * store write (and therefore one broadcast, one undo entry through the gesture).
 * @param {string} uuid
 * @param {{trackId: string, index: number, t?: number, v?: number}[]} moves
 * @param {string} [clipId]
 */
export function moveKeys(uuid, moves, clipId) {
	if (!moves?.length) return;
	editClip(uuid, clipId ?? null, (clip) => {
		let end = clip.duration;
		const tracks = clip.tracks.map((track) => {
			const mine = moves.filter((m) => m.trackId === track.id);
			if (!mine.length) return track;
			const keys = track.keys.map((key, i) => {
				const move = mine.find((m) => m.index === i);
				if (!move) return key;
				/** @type {Key} */
				const next = { t: key.t, v: key.v, ...(key.ease ? { ease: key.ease } : {}) };
				if (move.t !== undefined) next.t = Math.max(0, num(move.t));
				if (move.v !== undefined) next.v = num(move.v);
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

// --- baking to a THREE clip --------------------------------------------------
// An authored clip is keys over OUR channels, which nothing outside this module
// understands. Baking SAMPLES it into real KeyframeTracks so the same movement
// can leave through the GLTF exporter or drive an AnimationMixer.
//
// It is a sample, not a translation, on purpose: our per-segment cubic-bezier
// easing has no glTF equivalent (glTF interpolation is LINEAR, STEP or
// CUBICSPLINE with tangents), and euler tracks do not exist there at all — so
// rotation is composed to quaternions per sample. 30 fps keeps a 2s door at 61
// keys, small enough to ship and dense enough that the ease reads correctly.

const BAKE_FPS = 30;

/**
 * Sample an authored clip into a THREE.AnimationClip targeting `object`.
 * @param {any} object @param {Clip} clip @param {{fps?: number, name?: string}} [opts]
 * @returns {any} an AnimationClip, or null when the clip drives nothing
 */
export function clipToThreeClip(object, clip, opts = {}) {
	if (!object || !clip?.tracks?.length) return null;
	const fps = Math.max(4, num(opts.fps, BAKE_FPS) || BAKE_FPS);
	const duration = Math.max(clip.duration, 0.001);
	const frames = Math.max(1, Math.round(duration * fps));
	const times = [];
	for (let i = 0; i <= frames; i++) times.push(Math.min((i / fps), duration));

	const channels = new Set(clip.tracks.map((t) => t.channel));
	const wantsPos = ['pos.x', 'pos.y', 'pos.z'].some((c) => channels.has(c));
	const wantsRot = ['rot.x', 'rot.y', 'rot.z'].some((c) => channels.has(c));
	const wantsScale = ['scale', 'scale.x', 'scale.y', 'scale.z'].some((c) => channels.has(c));
	const wantsVisible = channels.has('visible');

	const base = {
		pos: object.position.toArray(),
		rot: [object.rotation.x, object.rotation.y, object.rotation.z],
		scale: object.scale.toArray()
	};
	const local = originOffsetOf(object);
	/** @type {number[]} */
	const pos = [];
	/** @type {number[]} */
	const rot = [];
	/** @type {number[]} */
	const scale = [];
	/** @type {boolean[]} */
	const visible = [];
	const quat = new THREE.Quaternion();
	const euler = new THREE.Euler();
	const originVec = new THREE.Vector3();
	const scaleVec = new THREE.Vector3();
	const offsetA = new THREE.Vector3();
	const offsetB = new THREE.Vector3();

	for (const t of times) {
		const values = evaluateClip(clip, t);
		const px = values['pos.x'] ?? base.pos[0];
		const py = values['pos.y'] ?? base.pos[1];
		const pz = values['pos.z'] ?? base.pos[2];
		const rx = values['rot.x'] ?? base.rot[0];
		const ry = values['rot.y'] ?? base.rot[1];
		const rz = values['rot.z'] ?? base.rot[2];
		const uniform = values['scale'];
		const sx = values['scale.x'] ?? uniform ?? base.scale[0];
		const sy = values['scale.y'] ?? uniform ?? base.scale[1];
		const sz = values['scale.z'] ?? uniform ?? base.scale[2];
		let fx = px;
		let fy = py;
		let fz = pz;
		// the ORIGIN pivot has to be baked in as well, or an exported door spins
		// about its own centre (glTF has no pivot concept)
		if (local && wantsRot) {
			originVec.fromArray(local);
			offsetA
				.copy(originVec)
				.multiply(scaleVec.fromArray(base.scale))
				.applyEuler(euler.set(base.rot[0], base.rot[1], base.rot[2]));
			offsetB.copy(originVec).multiply(scaleVec.set(sx, sy, sz)).applyEuler(euler.set(rx, ry, rz));
			fx += offsetA.x - offsetB.x;
			fy += offsetA.y - offsetB.y;
			fz += offsetA.z - offsetB.z;
		}
		if (wantsPos || (local && wantsRot)) pos.push(fx, fy, fz);
		if (wantsRot) {
			quat.setFromEuler(euler.set(rx, ry, rz));
			rot.push(quat.x, quat.y, quat.z, quat.w);
		}
		if (wantsScale) scale.push(sx, sy, sz);
		if (wantsVisible) visible.push((values['visible'] ?? 1) >= 0.5);
	}

	const name = object.name || object.uuid;
	const tracks = [];
	if (pos.length) tracks.push(new THREE.VectorKeyframeTrack(name + '.position', times, pos));
	if (rot.length) tracks.push(new THREE.QuaternionKeyframeTrack(name + '.quaternion', times, rot));
	if (scale.length) tracks.push(new THREE.VectorKeyframeTrack(name + '.scale', times, scale));
	if (visible.length) tracks.push(new THREE.BooleanKeyframeTrack(name + '.visible', times, visible));
	if (!tracks.length) return null;
	return new THREE.AnimationClip(opts.name ?? clip.name, duration, tracks);
}

/** Every authored clip of an object, baked. @param {any} object @param {string} uuid */
export function bakeAnimations(object, uuid) {
	const set = getAnimSet(uuid);
	if (!set) return [];
	return Object.values(set.clips)
		.map((clip) => clipToThreeClip(object, clip))
		.filter(Boolean);
}

/** Baked clips for every object in a subtree that has authored animation — what a
 * GLTF export hands to the exporter's `animations` option. @param {any} root */
export function bakeAnimationsForExport(root) {
	if (!root) return [];
	const sets = get(animations);
	/** @type {any[]} */
	const clips = [];
	root.traverse?.((/** @type {any} */ object) => {
		if (!sets[object.uuid]) return;
		for (const clip of bakeAnimations(object, object.uuid)) clips.push(clip);
	});
	// a root that IS the animated object (traverse covers it, but a bare mesh
	// passed straight in has no traverse in some call paths)
	if (!root.traverse && sets[root.uuid]) clips.push(...bakeAnimations(root, root.uuid));
	return clips;
}

// --- presets -----------------------------------------------------------------
// Recipes for the movements people actually build. The door is the one the whole
// origin/hinge story exists for: place the origin on the hinge edge (Inspector ▸
// origin, or "Bottom"/"Move origin"), then this keys rot.y 0 -> 90 and the swing
// happens about that edge. `once` so a Play Animation toggle opens and shuts it.

/** @type {Record<string, {name: string, duration: number, loop: 'once'|'loop'|'pingpong', tracks: {channel: string, keys: {t: number, v: number, ease?: number[]}[]}[], needsOrigin?: boolean}>} */
export const PRESETS = {
	door: {
		name: 'Door',
		duration: 0.8,
		loop: 'once',
		needsOrigin: true,
		tracks: [
			{ channel: 'rot.y', keys: [{ t: 0, v: 0, ease: [...EASINGS['ease-out']] }, { t: 0.8, v: Math.PI / 2 }] }
		]
	},
	drawer: {
		name: 'Drawer',
		duration: 0.6,
		loop: 'once',
		tracks: [
			{ channel: 'pos.z', keys: [{ t: 0, v: 0, ease: [...EASINGS['ease-out']] }, { t: 0.6, v: 0.8 }] }
		]
	},
	elevator: {
		name: 'Elevator',
		duration: 3,
		loop: 'pingpong',
		tracks: [
			{ channel: 'pos.y', keys: [{ t: 0, v: 0, ease: [...EASINGS['ease-in-out']] }, { t: 3, v: 3 }] }
		]
	},
	turntable: {
		name: 'Turntable',
		duration: 6,
		loop: 'loop',
		tracks: [{ channel: 'rot.y', keys: [{ t: 0, v: 0 }, { t: 6, v: Math.PI * 2 }] }]
	},
	pulse: {
		name: 'Pulse',
		duration: 1.2,
		loop: 'loop',
		tracks: [
			{
				channel: 'scale',
				keys: [
					{ t: 0, v: 1, ease: [...EASINGS['ease-in-out']] },
					{ t: 0.6, v: 1.15, ease: [...EASINGS['ease-in-out']] },
					{ t: 1.2, v: 1 }
				]
			}
		]
	},
	fade: {
		name: 'Blink out',
		duration: 1,
		loop: 'once',
		tracks: [{ channel: 'visible', keys: [{ t: 0, v: 1 }, { t: 0.5, v: 0 }] }]
	}
};

/**
 * Add a preset as a NEW clip, with its keys offset by the object's current pose
 * so the movement starts where the object stands.
 * @param {string} kind @param {string} uuid @param {any} [obj]
 * @returns {{clipId: string, needsOrigin: boolean}|null}
 */
export function applyPreset(kind, uuid, obj) {
	const preset = PRESETS[kind];
	if (!preset) return null;
	const object = obj ?? objectFor(uuid);
	const id = newId();
	editSet(uuid, (set) => {
		set.clips[id] = {
			name: preset.name,
			duration: preset.duration,
			loop: preset.loop,
			tracks: preset.tracks.map((track) => {
				const base = channelValue(object, track.channel);
				const offset = track.channel === 'visible' || track.channel.startsWith('scale') ? 0 : base;
				return {
					id: newId(),
					channel: track.channel,
					keys: track.keys.map((k) => ({
						t: k.t,
						// scale presets are RELATIVE to the object's own scale, transforms
						// are relative to where it stands, visibility is absolute
						v: track.channel.startsWith('scale') ? k.v * (base || 1) : k.v + offset,
						...(k.ease ? { ease: [...k.ease] } : {})
					}))
				};
			})
		};
		set.active = id;
		return set;
	});
	switchTransportTo(uuid, id); // a preset is a new clip: the transport follows it
	return { clipId: id, needsOrigin: !!preset.needsOrigin && !originOffsetOf(object) };
}

// --- auto-key ----------------------------------------------------------------
// A record toggle: while it is on, posing the object writes keys at the playhead
// instead of being lost. This is the workflow difference between "type numbers
// into a key list" and "pose it, move the playhead, pose it again".

/** @type {import('svelte/store').Writable<string|null>} uuid being recorded, null = off */
export const autoKeyFor = writable(/** @type {string|null} */ (null));

/** @param {string|null} uuid */
export function setAutoKey(uuid) {
	autoKeyFor.set(uuid);
	// arming takes the reference pose; disarming forgets it
	if (uuid) rememberAutoKeyReference(uuid);
	else autoKeyReference.clear();
}

/**
 * The pose auto-key measures against: the base an armed object was captured at,
 * or its live values when nothing has posed it yet. Kept per object so a drag can
 * be compared with where the object STARTED, not with the clip.
 * @type {Map<string, any>}
 */
const autoKeyReference = new Map();

/** Channels worth watching for a change. Transform always; the look only where
 * the object actually has it, so a box is never offered a light intensity.
 * @param {any} object */
function watchableChannels(object) {
	return CHANNELS.filter((channel) => channel !== 'scale' && channelApplies(object, channel));
}

/**
 * Write a key at `seconds` for every channel that CHANGED — called after a gizmo
 * drag, an Inspector edit, or from the window's "key the pose" action.
 *
 * A channel with a track is compared against what the clip says at that time; a
 * channel with NO track is compared against the reference pose and, if the user
 * moved it, gets a track created (with a key at 0 holding the value it started
 * from, so the movement runs FROM the original pose rather than snapping). That
 * is the difference between recording an animation and filling in a table: arm
 * REC, drag at 1s, and the movement exists.
 * @param {string} uuid @param {number} seconds @returns {number} keys written
 */
export function captureAutoKey(uuid, seconds) {
	if (get(autoKeyFor) !== uuid) return 0;
	const clip = activeClip(uuid);
	const object = objectFor(uuid);
	if (!clip || !object) return 0;
	const at = Math.max(0, num(seconds));
	const reference = autoKeyReference.get(uuid) ?? null;
	/** @type {{trackId: string|null, channel: string, v: number, from: number|null}[]} */
	const writes = [];
	const byChannel = new Map(clip.tracks.map((track) => [track.channel, track]));
	// uniform scale is a legacy alias for the three axes; if a track already drives
	// it, keep using that one rather than adding per-axis tracks beside it
	const uniform = byChannel.get('scale');
	for (const channel of watchableChannels(object)) {
		const current = channelValue(object, channel);
		const epsilon = STEPPED.has(channel) ? 0.5 : 1e-4;
		const track = byChannel.get(channel) ?? (channel.startsWith('scale.') ? uniform : undefined);
		if (track) {
			const existing = sampleTrack(track, at);
			if (existing !== null && Math.abs(existing - current) < epsilon) continue;
			writes.push({ trackId: track.id, channel: track.channel, v: current, from: null });
			continue;
		}
		// no track yet: only record a channel the user actually MOVED, which needs a
		// reference pose to compare with (armed REC takes one)
		const before = reference?.values?.[channel];
		if (before === undefined || Math.abs(before - current) < epsilon) continue;
		writes.push({ trackId: null, channel, v: current, from: at > 1e-4 ? before : null });
	}
	if (!writes.length) return 0;
	beginAnimGesture(uuid, 'Auto-key');
	for (const write of writes) {
		let trackId = write.trackId;
		if (!trackId) {
			trackId = addTrack(uuid, write.channel, object);
			// addTrack seeds a demo two-key movement; auto-key owns this track, so
			// replace it with just the pose the object came FROM
			const fresh = activeClip(uuid)?.tracks.find((t) => t.id === trackId);
			if (fresh) {
				for (let i = fresh.keys.length - 1; i >= 0; i--) removeKey(uuid, trackId, i);
				updateKey(uuid, trackId, 0, { t: 0, v: write.from ?? write.v });
			}
		}
		addKey(uuid, trackId, at, write.v);
	}
	endAnimGesture();
	// the new pose becomes the reference, so the NEXT drag is measured from here
	rememberAutoKeyReference(uuid);
	return writes.length;
}

/** Snapshot the object's values so the next change can be detected per channel.
 * @param {string} uuid */
export function rememberAutoKeyReference(uuid) {
	const object = objectFor(uuid);
	if (!object) return;
	/** @type {Record<string, number>} */
	const values = {};
	for (const channel of watchableChannels(object)) values[channel] = channelValue(object, channel);
	autoKeyReference.set(uuid, { values });
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
	resetPreview(); // never leave a preview posing objects that just changed
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
		get(playback)[uuid] ?? {
			clipId: '', playing: false, at: 0, pausedAt: 0, speed: 1, reverse: false, changedAt: 0
		}
	);
}

/** @param {Play} p @param {number} now */
function elapsedOf(p, now) {
	return p.playing ? p.pausedAt + (now - p.at) * (p.speed || 1) : p.pausedAt;
}

/**
 * Where a PARKED playhead sits, read straight off the transport instead of through
 * the loop wrap: parking exactly at the end of a looping clip is a real thing to do
 * (the End button), and `(2/2) % 1` is 0, so it used to read back as the start —
 * which made "go to end" look like it did nothing and stepped the wrong way next.
 * @param {Clip} clip @param {Play} [p]
 */
function parkedPosition(clip, p) {
	const { from, to } = rangeOf(clip, p);
	const raw = p?.reverse ? to - num(p?.pausedAt) : from + num(p?.pausedAt);
	return Math.min(Math.max(raw, 0), Math.max(clip.duration, 0.001));
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

/** Where an object's clip currently sits, for a caller deciding what to do next
 * (the Play Animation node's toggle). @param {string} uuid */
export function transportOf(uuid) {
	const p = get(playback)[uuid];
	const clip = clipOf(uuid, p?.clipId);
	const duration = clip ? Math.max(clip.duration, 0.001) : 0;
	const reverse = !!p?.reverse;
	const elapsed = p ? elapsedOf(p, syncedNow()) : 0;
	const range = clip ? rangeOf(clip, p) : { from: 0, to: 0, span: 0 };
	return {
		playing: !!p?.playing,
		reverse,
		duration,
		position: !clip ? 0 : p?.playing ? clipSecondsFor(clip, elapsed, reverse, p) : parkedPosition(clip, p),
		clipId: p?.clipId ?? '',
		rangeIn: range.from,
		rangeOut: range.to,
		ranged: !!clip && (range.from > 1e-6 || range.to < duration - 1e-6),
		startedFrom: p?.startedFrom ?? 0
	};
}

/** Set the A/B window playback loops inside (absolute clip seconds). Pass nulls
 * to clear it. @param {string} uuid @param {number|null} from @param {number|null} to */
export function setRange(uuid, from, to) {
	const clip = clipOf(uuid, get(playback)[uuid]?.clipId);
	if (!clip) return;
	/** @type {any} */
	const patch = {};
	patch.rangeIn = from === null ? 0 : Math.max(0, num(from));
	patch.rangeOut = to === null ? clip.duration : Math.max(patch.rangeIn + 0.01, num(to, clip.duration));
	// restart the window so the playhead cannot sit outside it
	patch.at = syncedNow();
	patch.pausedAt = 0;
	setPlay(uuid, patch, true);
}

/** Current clip seconds for an object (0 when idle). @param {string} uuid */
export function playheadOf(uuid) {
	return transportOf(uuid).position;
}

/**
 * Start (or resume) playback.
 *
 * `at` lets a caller stamp playback with a moment every peer agrees on — the Play
 * Animation node passes the replicated TRIGGER timestamp, so a door opens in phase
 * even though the message reaches each peer at a different time. `replicate: false`
 * is for exactly that case: the trigger stamp already travelled, so re-sending the
 * transport would fire it twice.
 * @param {string} uuid @param {string|null} [clipId]
 * @param {{speed?: number, from?: number, reverse?: boolean, at?: number, replicate?: boolean}} [opts]
 */
export function play(uuid, clipId, opts = {}) {
	if (typeof uuid !== 'string') return;
	const obj = objectFor(uuid);
	if (!obj) return;
	const prev = playOf(uuid);
	const set = getAnimSet(uuid);
	// a stale stored id (its clip was deleted, or a peer renamed the set) must not
	// strand playback — fall back to the object's default clip
	const asked = clipId ?? prev.clipId;
	const id = set?.clips?.[asked] ? asked : (set?.active ?? asked);
	const clip = clipOf(uuid, id);
	if (!clip) return;
	ensureBase(uuid, obj);
	const reverse = opts.reverse ?? false;
	const { span } = rangeOf(clip, prev);
	const from = opts.from ?? (prev.pausedAt >= span && clip.loop === 'once' ? 0 : prev.pausedAt);
	setPlay(
		uuid,
		{
			clipId: id || set?.active || DEFAULT_CLIP,
			playing: true,
			at: opts.at ?? syncedNow(),
			pausedAt: from,
			speed: opts.speed ?? prev.speed ?? 1,
			reverse,
			// where this run began, so Stop can come back to it rather than to the
			// start of the clip (that was a real complaint: pressing stop threw away
			// the frame you were working from)
			startedFrom: from
		},
		opts.replicate !== false
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
	const seconds = parkedPosition(clip, p);
	poseAt(obj, clip, seconds, base);
	playheads.update((map) => ({ ...map, [uuid]: seconds }));
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

/**
 * Stop playing and return to the frame this run STARTED from — the deck-standard
 * behaviour, and what "stop" has to mean while you are tuning a movement: pressing
 * it used to rewind to the beginning of the clip and throw away the frame you had
 * scrubbed to. `resetPreview` is the separate, explicit way back to the untouched
 * pose. Omit `uuid` to stop everything (the transport button passes a click event
 * — guarded).
 * @param {string} [uuid] @param {{replicate?: boolean}} [opts]
 */
export function stop(uuid, opts = {}) {
	if (typeof uuid !== 'string') return stopAll();
	const p = get(playback)[uuid];
	if (!p) return;
	const back = num(p.startedFrom, 0);
	setPlay(uuid, { playing: false, pausedAt: back, reverse: false }, opts.replicate !== false);
	posePaused(uuid);
}

export function stopAll() {
	for (const uuid of Object.keys(get(playback))) stop(uuid);
}

/**
 * Drop the preview entirely: the object goes back to the pose it had before
 * anything previewed it and the playhead rewinds. This is the one that RELEASES
 * the captured base, so the next play captures a fresh one.
 * @param {string} [uuid]
 */
export function resetPreview(uuid) {
	if (typeof uuid !== 'string') {
		for (const id of new Set([...bases.keys(), ...Object.keys(get(playback))])) resetPreview(id);
		playheads.set({});
		return;
	}
	releaseBase(uuid);
	if (get(playback)[uuid]) {
		setPlay(uuid, { playing: false, pausedAt: 0, reverse: false, startedFrom: 0 }, true);
	}
	clearHead(uuid);
}

/** Preview a specific time without running (scrubber drag). LOCAL — a scrub is a
 * look, not a broadcast. @param {string} uuid @param {number} seconds @param {string} [clipId] */
export function scrub(uuid, seconds, clipId) {
	const obj = objectFor(uuid);
	const p = playOf(uuid);
	const clip = clipOf(uuid, clipId ?? p.clipId);
	if (!obj || !clip) return;
	// the caller works in absolute clip seconds; the transport counts ELAPSED from
	// the A/B window's start, so convert once here
	const { from } = rangeOf(clip, p);
	const position = Math.min(Math.max(num(seconds), 0), clip.duration);
	const elapsed = Math.max(0, position - from);
	const base = ensureBase(uuid, obj);
	setPlay(uuid, {
		clipId: clipId ?? (p.clipId || DEFAULT_CLIP),
		pausedAt: elapsed,
		at: syncedNow(),
		reverse: false, // a scrub reads the timeline left to right
		startedFrom: elapsed // Stop comes back to the frame you scrubbed to
	});
	poseAt(obj, clip, position, base);
	playheads.update((map) => ({ ...map, [uuid]: position }));
}

/** Every distinct key time in the active clip, sorted — what the prev/next-key
 * transport buttons step through. @param {string} uuid @param {string} [clipId] */
export function keyTimes(uuid, clipId) {
	const clip = clipOf(uuid, clipId);
	if (!clip) return [];
	const times = new Set([0]);
	for (const track of clip.tracks) for (const key of track.keys) times.add(Math.round(key.t * 1e4) / 1e4);
	return [...times].sort((a, b) => a - b);
}

/** @param {string} uuid @param {number} speed */
export function setSpeed(uuid, speed) {
	// (transport speed change; rebases the stamp so the pose does not jump)
	const p = playOf(uuid);
	const now = syncedNow();
	setPlay(uuid, { pausedAt: elapsedOf(p, now), at: now, speed: Math.max(0.05, num(speed, 1)) }, true);
}

/**
 * Park every previewed object at its BASE pose while a serializer reads the scene,
 * and return a closure that puts the previews back.
 *
 * The same rule as flow animations (golden rule 10): a save must carry the pose
 * the user authored, not the frame a scrub happens to be showing. This matters
 * more now that a scrub SURVIVES switching objects — the previewed pose can sit
 * there for minutes, and without this an autosave would bake it.
 * flowRuntime.parkAnimatedAtBase calls in here, so every existing serializer gets
 * it for free.
 * @returns {() => void} idempotent restore
 */
export function parkAuthoredAtBase() {
	/** @type {string[]} */
	const parked = [];
	for (const [uuid, base] of bases) {
		const object = objectFor(uuid);
		if (!object) continue;
		restoreBase(object, base);
		parked.push(uuid);
	}
	let done = false;
	return () => {
		if (done) return;
		done = true;
		for (const uuid of parked) {
			const p = get(playback)[uuid];
			const clip = clipOf(uuid, p?.clipId);
			const object = objectFor(uuid);
			const base = bases.get(uuid);
			if (!p || !clip || !object || !base) continue;
			const elapsed = elapsedOf(p, syncedNow());
			poseAt(object, clip, clipSecondsFor(clip, elapsed, !!p.reverse, p), base);
		}
	};
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
		// a once-clip ends at the end of its A/B WINDOW, which is the whole clip
		// unless in/out points were set
		const { span } = rangeOf(clip, p);
		const done = clip.loop === 'once' && elapsed >= span;
		const seconds = clipSecondsFor(clip, done ? span : elapsed, !!p.reverse, p);
		poseAt(obj, clip, seconds, base);
		heads[uuid] = seconds;
		any = true;
		if (done) finished.push(uuid);
	}
	if (any || Object.keys(get(playheads)).length) playheads.set(heads);
	// a 'once' clip ends on its own on EVERY peer at the same elapsed time, so
	// this is a local state change — never a broadcast.
	for (const uuid of finished) {
		const p = get(playback)[uuid];
		const clip = clipOf(uuid, p?.clipId);
		setPlay(uuid, { playing: false, pausedAt: clip ? rangeOf(clip, p).span : 0 });
	}
}
