import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, selectedObject } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { syncedAnimations } from '../stores/flowStore';
import {
	suspendAnimation,
	resumeAnimation,
	fireAnimFinished as notifyClipFinished,
	fireAnimMarker as notifyMarker
} from './flowRuntime';
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
 * @typedef {{ t: number, name: string }} Marker a named point in a clip (F5); crossing one pulses an Animation Marker node
 * @typedef {{ name: string, tracks: Track[], duration: number, loop: 'once'|'loop'|'pingpong', fps?: number, step?: number, markers?: Marker[] }} Clip
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
	/** @type {Clip} */
	const clip = { name, tracks, duration, loop };
	// FRAME RATE belongs to the clip, not the object and not the app: one object can
	// hold a 24fps swing and a 60fps flourish, and the rate is what its key times
	// MEAN. Absent = the editor default, so nothing existing changes.
	const fps = num(raw.fps, 0);
	if (fps >= 1 && fps <= 240) clip.fps = fps;
	// STEP is the second, different control: evaluate on a COARSER grid than the keys
	// were authored on — "on twos", the stepped look animators use deliberately, and
	// incidentally a cheap way to calm a heavy scene. Absent = smooth.
	const step = num(raw.step, 0);
	if (step >= 1 && step <= 240) clip.step = step;
	// F5 MARKERS belong to the CLIP, so they replicate, save and undo with everything
	// else and need no channel of their own. Carried like fps/step: absent = none, so
	// every existing save is byte-unchanged. Kept SORTED, which is what lets the
	// crossing test walk them in travel order.
	const markers = normalizeMarkers(raw.markers);
	if (markers.length) clip.markers = markers;
	return clip;
}

/** @param {any} raw @returns {{t: number, name: string}[]} */
function normalizeMarkers(raw) {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((/** @type {any} */ m) => ({
			t: Math.max(0, num(m?.t, 0)),
			name: typeof m?.name === 'string' && m.name.trim() ? m.name.trim() : 'Marker'
		}))
		.sort((a, b) => a.t - b.t);
}

/** Drop a marker at `t` on a clip (replicated + undoable through editClip).
 * @param {string} uuid @param {number} t @param {string} [name] @param {string} [clipId] */
export function addMarker(uuid, t, name, clipId) {
	const at = Math.max(0, num(t, 0));
	editClip(uuid, clipId ?? null, (clip) => {
		const markers = [...(clip.markers ?? [])];
		// a default name that says WHERE it is, so several markers stay tellable apart
		const label = (name ?? '').trim() || 'Marker ' + (markers.length + 1);
		markers.push({ t: at, name: label });
		markers.sort((a, b) => a.t - b.t);
		return { ...clip, markers };
	});
}

/** @param {string} uuid @param {number} index @param {{t?: number, name?: string}} patch @param {string} [clipId] */
export function updateMarker(uuid, index, patch, clipId) {
	editClip(uuid, clipId ?? null, (clip) => {
		const markers = [...(clip.markers ?? [])];
		const m = markers[index];
		if (!m) return null;
		markers[index] = {
			t: patch.t === undefined ? m.t : Math.max(0, num(patch.t, m.t)),
			name: patch.name === undefined ? m.name : String(patch.name).trim() || m.name
		};
		markers.sort((a, b) => a.t - b.t);
		return { ...clip, markers };
	});
}

/** @param {string} uuid @param {number} index @param {string} [clipId] */
export function removeMarker(uuid, index, clipId) {
	editClip(uuid, clipId ?? null, (clip) => {
		const markers = [...(clip.markers ?? [])];
		if (!markers[index]) return null;
		markers.splice(index, 1);
		return markers.length ? { ...clip, markers } : { ...clip, markers: [] };
	});
}

/** Markers of the clip on `uuid`'s transport (or its active clip).
 * @param {string} uuid @param {string} [clipId] */
export function markersOf(uuid, clipId) {
	return clipOf(uuid, clipId ?? get(playback)[uuid]?.clipId)?.markers ?? [];
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
			metalness: 'Metalness', roughness: 'Roughness', emissive: 'Emission',
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
				if (material.emissiveIntensity === undefined) continue;
				material.emissiveIntensity = Math.max(0, v);
				// three MULTIPLIES emissiveIntensity by the emissive COLOUR, and that
				// colour is black on every default material — so animating Glow moved
				// a number and changed no pixels ("glow channel not working").
				//
				// It needs something to scale. White was the first answer and it was
				// wrong in use: the object simply turned white, losing the colour that
				// made it that object. A glow with no colour of its own takes the
				// material's OWN colour instead — a red box glows red, which is what
				// "this thing is lit up" looks like. Set a Glow colour in the Inspector
				// for anything else (a white object flaring green) and it is honoured
				// here, because it is no longer black. captureBase/restoreBase carry
				// the original, so Stop puts it back — the rule `transparent` follows.
				if (material.emissive && material.emissive.getHex() === 0x000000 && v > 0) {
					if (material.color) material.emissive.copy(material.color);
					else material.emissive.setHex(0xffffff);
				}
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
		emissiveIntensity: material.emissiveIntensity,
		// the emissive COLOUR rides along because driving Glow lights a black
		// emissive (setChannel says why) — Stop has to put the black back
		emissive: material.emissive ? material.emissive.getHex() : null
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
			if (saved.emissive != null && material.emissive) material.emissive.setHex(saved.emissive);
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

/**
 * Re-take the base when the USER has moved the object since it was captured.
 *
 * The base is remembered per object and survives Stop, so this sequence threw the
 * move away: play (base taken at A) -> stop -> drag the object to B -> play again,
 * where `poseAt` starts with `restoreBase` and put it straight back at A. Under R1
 * that is doubly wrong: the whole point is that a movement replays from where the
 * object IS.
 *
 * "Moved" is decided by comparing the object with the position this module LAST
 * WROTE, not with a recomputed expectation. Recomputing looked tidier and was
 * wrong: `applyOriginPivot` legitimately moves a hinged object's position as part
 * of posing its ROTATION, so a door read as "moved" on every play and re-anchored
 * itself. Remembering what we set has no such blind spot — it covers the pivot, the
 * look channels and anything added later, for free.
 *
 * Only consulted while the transport is NOT playing: mid-playback the object is
 * posed by definition.
 * @param {string} uuid @param {any} object @param {Clip} clip
 */
function rebaseIfMoved(uuid, object, clip) {
	const base = bases.get(uuid);
	const p = get(playback)[uuid];
	if (!base || !clip || !p || p.playing) return;
	const written = posedPositions.get(uuid);
	if (!written) return; // nothing posed yet, so the base is already the live pose
	const actual = object.position.toArray();
	const moved = written.some((v, axis) => Math.abs(num(v) - num(actual[axis])) > 1e-4);
	if (!moved) return;
	// the user dragged it: this pose is the new anchor, and the offset it was
	// showing goes with the old base (Stop and Clear preview would do the same)
	bases.set(uuid, captureBase(object));
	posedPositions.delete(uuid);
}

/** The position `poseAt` last wrote per object — the reference rebaseIfMoved
 * compares against. @type {Map<string, number[]>} */
const posedPositions = new Map();

/**
 * F6: the base an ONION-SKIN ghost should be posed from — the stored base while a
 * preview is running, else the object exactly as it stands. Read-only: unlike
 * ensureBase it never stores anything and never suspends flow, because a viewing
 * aid must not change what the real object does.
 *
 * TRANSFORM ONLY (`materials: []`), which is what stops `restoreBase` writing the
 * base's opacity and colour over a ghost's own faint material.
 * @param {string} uuid @param {any} object
 */
export function ghostBase(uuid, object) {
	const stored = bases.get(uuid);
	return {
		pos: stored ? [...stored.pos] : object.position.toArray(),
		rot: stored ? [...stored.rot] : [object.rotation.x, object.rotation.y, object.rotation.z],
		scale: stored ? [...stored.scale] : object.scale.toArray(),
		visible: true,
		materials: []
	};
}

/** @param {string} uuid */
function releaseBase(uuid) {
	const base = bases.get(uuid);
	if (!base) return;
	const object = objectFor(uuid);
	if (object) restoreBase(object, base);
	bases.delete(uuid);
	posedPositions.delete(uuid); // nothing is posed any more (rebaseIfMoved)
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

// --- R1: position is RELATIVE ------------------------------------------------
//
// Position keys used to be absolute world values, so moving an object and pressing
// play snapped it back to wherever the clip had been authored. A movement is a
// movement — it should happen from where the thing IS. So a position track is read
// as an offset from its FIRST key, replayed on top of the pose the run started at:
//
//     world = base.pos[axis] + (key - firstKey)
//
// The stored data does not change shape, only its meaning, and clips saved before
// this reinterpret the same way (the user's call — a door authored at the origin
// and then moved now opens where it stands, which is what people expected it to do
// all along). Rotation and scale stay absolute: an angle and a factor already mean
// the same thing wherever the object sits.
//
// Every reader of a position key goes through these two functions, and the INVERSE
// matters as much as the forward direction: auto-key records the object's current
// WORLD value, so without `keyValueOf` it would bake the current base into the key
// and the movement would double on the next run.

/** @type {Record<string, number>} */
const POS_AXIS = { 'pos.x': 0, 'pos.y': 1, 'pos.z': 2 };

/**
 * The anchor a relative replay measures from: the value of the channel's FIRST key.
 *
 * MEMOISED per clip. This runs for every position channel of every posed frame, and
 * the naive version — find the track, then scan its keys — measurably thinned the
 * per-frame tick on a throttled page, which upsets anything reasoning about the
 * interval BETWEEN ticks (the marker-crossing checks started missing a marker).
 * `editClip` builds a NEW clip object on every edit, so a WeakMap keyed by the clip
 * invalidates itself for free.
 * @type {WeakMap<any, Map<string, number>>}
 */
const anchorCache = new WeakMap();

/** @param {Clip} clip @param {string} channel */
function channelAnchor(clip, channel) {
	if (!clip) return 0;
	let cached = anchorCache.get(clip);
	if (!cached) {
		cached = new Map();
		anchorCache.set(clip, cached);
	}
	const hit = cached.get(channel);
	if (hit !== undefined) return hit;
	const track = clip?.tracks?.find((entry) => entry.channel === channel);
	let anchor = 0;
	if (track?.keys?.length) {
		let first = track.keys[0];
		for (const key of track.keys) if (num(key.t) < num(first.t)) first = key;
		anchor = num(first.v);
	}
	cached.set(channel, anchor);
	return anchor;
}

/** The WORLD value a key means for an object whose run started at `basePos`.
 * @param {Clip} clip @param {string} channel @param {number} v @param {number[]} [basePos] */
export function worldValueOf(clip, channel, v, basePos) {
	const axis = POS_AXIS[channel];
	if (axis === undefined || !basePos) return v;
	return num(basePos[axis]) + (num(v) - channelAnchor(clip, channel));
}

/** The KEY value that records an object currently at `current` — the inverse of
 * worldValueOf, and what every write path must use.
 * @param {Clip} clip @param {string} channel @param {number} current @param {number[]} [basePos] */
export function keyValueOf(clip, channel, current, basePos) {
	const axis = POS_AXIS[channel];
	if (axis === undefined || !basePos) return current;
	return channelAnchor(clip, channel) + (num(current) - num(basePos[axis]));
}

/**
 * Pose the object at `seconds` of clip time. Unkeyed channels return to the base
 * pose first, so a clip is an absolute statement about the channels it drives —
 * except position, which is relative to the base (see above).
 * @param {any} obj @param {Clip} clip @param {number} seconds @param {any} base
 */
export function poseAt(obj, clip, seconds, base) {
	restoreBase(obj, base);
	// STEP quantises the time we sample at, which is what "on twos" means: the keys
	// keep their own resolution, the LOOK is coarser. Done here, at the single pose
	// choke point, so playback, a scrub and a bake all agree.
	const at = clip.step ? Math.floor(seconds * clip.step + 1e-6) / clip.step : seconds;
	const values = evaluateClip(clip, at);
	for (const channel in values)
		setChannel(obj, channel, worldValueOf(clip, channel, values[channel], base?.pos));
	applyOriginPivot(obj, base, values);
	obj.updateMatrix();
	// remember what we wrote, so a later play/scrub can tell the difference between
	// "the preview put it there" and "the user dragged it" (rebaseIfMoved)
	posedPositions.set(obj.uuid, obj.position.toArray());
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

/**
 * A visible default for the second key of a fresh track.
 *
 * `from + 2` is right for a position or a light intensity, and WRONG for every
 * channel `setChannel` CLAMPS to 0..1: opacity 1 -> 3 clamps straight back to 1,
 * so a fresh Opacity track ran 1 -> 1 and adding the channel appeared to do
 * nothing whatsoever. Roughness (default 1) and any colour component already at 1
 * were dead the same way. Reported as "animations don't apply immediately" — it
 * was never about timing, the track really was flat.
 *
 * The clamped channels therefore TOGGLE to the far end, whichever of 0/1 is
 * further from where the object already is: the rule `visible` always used.
 * @param {string} channel @param {number} from
 */
function defaultTo(channel, from) {
	if (channel === 'visible') return from >= 0.5 ? 0 : 1;
	if (channel.startsWith('scale')) return from * 1.5 || 1.5;
	if (isRotChannel(channel)) return from + Math.PI / 2;
	if (channel === 'opacity' || channel === 'metalness' || channel === 'roughness')
		return from >= 0.5 ? 0 : 1;
	if (channel.startsWith('color')) return from >= 0.5 ? 0 : 1;
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
	if (!moves?.length) return [];
	/** @type {({trackId: string, index: number}|null)[]} */
	const landed = moves.map(() => null);
	editClip(uuid, clipId ?? null, (clip) => {
		let end = clip.duration;
		const tracks = clip.tracks.map((track) => {
			const mine = moves
				.map((m, ordinal) => ({ ...m, ordinal }))
				.filter((m) => m.trackId === track.id);
			if (!mine.length) return track;
			// Tag each moved key with the ordinal of the move that produced it, so its
			// identity survives the re-sort. Matching them back up by TIME afterwards
			// looked equivalent and is not: two keys of one track dragged together
			// snap onto the same time constantly, both matched the same key, and one
			// of the pair was left behind or duplicated (the reported "moving multiple
			// points changes the position of some of them"). Array.sort is stable, so
			// two keys at an identical time keep their order and stay distinguishable.
			const tagged = track.keys.map((key, i) => {
				const move = mine.find((m) => m.index === i);
				/** @type {any} */
				const next = { t: key.t, v: key.v, ...(key.ease ? { ease: key.ease } : {}) };
				if (!move) return { key: next, ordinal: -1 };
				if (move.t !== undefined) next.t = Math.max(0, num(move.t));
				if (move.v !== undefined) next.v = num(move.v);
				end = Math.max(end, next.t);
				return { key: next, ordinal: move.ordinal };
			});
			tagged.sort((a, b) => a.key.t - b.key.t);
			tagged.forEach((entry, index) => {
				if (entry.ordinal >= 0) landed[entry.ordinal] = { trackId: track.id, index };
			});
			return { ...track, keys: tagged.map((entry) => entry.key) };
		});
		return { ...clip, tracks, duration: end };
	});
	return landed;
}

// --- the key clipboard -------------------------------------------------------
// One clipboard for the app, holding keys BY CHANNEL and relative to the earliest
// one copied. That is what makes it useful across clips and objects: paste puts the
// whole shape down at the playhead, and a channel the target has no track for gets
// one, so copying a door's swing onto another door is two keystrokes.

/** @type {{channel: string, keys: Key[]}[]} */
let clipboard = [];

/** @type {import('svelte/store').Writable<number>} how many keys are on the clipboard */
export const clipboardSize = writable(0);

/** Copy the given [trackId, index] pairs of a clip. @param {string} uuid
 * @param {[string, number][]} picks @param {string} [clipId] @returns {number} */
export function copyKeys(uuid, picks, clipId) {
	const clip = clipOf(uuid, clipId);
	if (!clip || !picks?.length) return 0;
	/** @type {Map<string, Key[]>} */
	const byChannel = new Map();
	let earliest = Infinity;
	for (const [trackId, index] of picks) {
		const track = clip.tracks.find((t) => t.id === trackId);
		const key = track?.keys[index];
		if (!track || !key) continue;
		earliest = Math.min(earliest, key.t);
		const list = byChannel.get(track.channel) ?? [];
		list.push({ t: key.t, v: key.v, ...(key.ease ? { ease: [...key.ease] } : {}) });
		byChannel.set(track.channel, list);
	}
	if (!byChannel.size) return 0;
	// store RELATIVE times, so a paste lands wherever the playhead is
	clipboard = [...byChannel.entries()].map(([channel, keys]) => ({
		channel,
		keys: keys
			.map((k) => ({ ...k, t: k.t - earliest }))
			.sort((a, b) => a.t - b.t)
	}));
	const total = clipboard.reduce((sum, entry) => sum + entry.keys.length, 0);
	clipboardSize.set(total);
	return total;
}

/** What is on the clipboard (for a menu label). */
export function clipboardInfo() {
	return {
		channels: clipboard.map((entry) => entry.channel),
		keys: clipboard.reduce((sum, entry) => sum + entry.keys.length, 0)
	};
}

/**
 * Paste the clipboard at `seconds`, creating a track for any channel the target
 * clip does not have yet (a paste that silently dropped half the shape would be
 * worse than refusing). Returns the pasted keys, so the caller can select them.
 * @param {string} uuid @param {number} seconds @param {string} [clipId]
 * @returns {[string, number][]}
 */
export function pasteKeys(uuid, seconds, clipId) {
	if (!clipboard.length) return [];
	const at = Math.max(0, num(seconds));
	const object = objectFor(uuid);
	/** @type {[string, number][]} */
	const landed = [];
	beginAnimGesture(uuid, 'Paste keys');
	for (const entry of clipboard) {
		let clip = clipOf(uuid, clipId);
		let track = clip?.tracks.find((t) => t.channel === entry.channel);
		if (!track) {
			const id = addTrack(uuid, entry.channel, object, clipId);
			clip = clipOf(uuid, clipId);
			track = clip?.tracks.find((t) => t.id === id);
			// addTrack seeds a demo pair; the paste owns this track
			if (track) {
				for (let i = track.keys.length - 1; i >= 1; i--) removeKey(uuid, track.id, i, clipId);
			}
		}
		if (!track) continue;
		for (const key of entry.keys) {
			addKey(uuid, track.id, at + key.t, key.v, { ease: key.ease, clipId });
		}
		const fresh = clipOf(uuid, clipId)?.tracks.find((t) => t.id === track.id);
		for (const key of entry.keys) {
			const index = fresh?.keys.findIndex((k) => Math.abs(k.t - (at + key.t)) < 1e-6) ?? -1;
			if (index >= 0) landed.push([track.id, index]);
		}
	}
	endAnimGesture();
	return landed;
}

/** Duplicate the given keys, offset by `offset` seconds (defaults to one clip after
 * the last of them). @param {string} uuid @param {[string, number][]} picks
 * @param {number} [offset] @param {string} [clipId] @returns {[string, number][]} */
export function duplicateKeys(uuid, picks, offset, clipId) {
	const clip = clipOf(uuid, clipId);
	if (!clip || !picks?.length) return [];
	const times = picks
		.map(([trackId, index]) => clip.tracks.find((t) => t.id === trackId)?.keys[index]?.t)
		.filter((t) => t !== undefined);
	if (!times.length) return [];
	const earliest = Math.min(...(/** @type {number[]} */ (times)));
	const latest = Math.max(...(/** @type {number[]} */ (times)));
	const shift = offset ?? Math.max(latest - earliest, 1 / 30) + (latest - earliest > 0 ? 0 : 0);
	/** @type {[string, number][]} */
	const landed = [];
	beginAnimGesture(uuid, 'Duplicate keys');
	for (const [trackId, index] of picks) {
		const track = clipOf(uuid, clipId)?.tracks.find((t) => t.id === trackId);
		const key = track?.keys[index];
		if (!track || !key) continue;
		const at = key.t + shift;
		addKey(uuid, trackId, at, key.v, { ease: key.ease, clipId });
		const fresh = clipOf(uuid, clipId)?.tracks.find((t) => t.id === trackId);
		const found = fresh?.keys.findIndex((k) => Math.abs(k.t - at) < 1e-6) ?? -1;
		if (found >= 0) landed.push([trackId, found]);
	}
	endAnimGesture();
	return landed;
}

/**
 * MIRROR the given keys in time about a pivot (the playhead by default): the shape
 * plays backwards. Values are untouched — a door closing is the same angles in the
 * other order, not the negative of them.
 * @param {string} uuid @param {[string, number][]} picks @param {number} pivot
 * @param {string} [clipId] @returns {number} how many moved
 */
export function mirrorKeys(uuid, picks, pivot, clipId) {
	const clip = clipOf(uuid, clipId);
	if (!clip || !picks?.length) return 0;
	/** @type {{trackId: string, index: number, t: number}[]} */
	const moves = [];
	for (const [trackId, index] of picks) {
		const track = clip.tracks.find((t) => t.id === trackId);
		const key = track?.keys[index];
		if (!track || !key) continue;
		moves.push({ trackId, index, t: Math.max(0, 2 * pivot - key.t) });
	}
	if (!moves.length) return 0;
	beginAnimGesture(uuid, 'Mirror keys');
	moveKeys(uuid, moves, clipId);
	endAnimGesture();
	return moves.length;
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
		// a STEPPED clip exports stepped: the look is part of the movement, so a
		// baked copy that smoothed it would not be the same animation
		const values = evaluateClip(clip, clip.step ? Math.floor(t * clip.step + 1e-6) / clip.step : t);
		// R1: position keys are relative, so the bake replays them from the object's
		// CURRENT pose — the same mapping poseAt uses, or the exported clip would
		// teleport the model back to wherever it was authored. Only a channel that
		// HAS a value is mapped: an unkeyed one is already the base, and running it
		// through the mapping would add the base to itself (its anchor is 0).
		const px = 'pos.x' in values ? worldValueOf(clip, 'pos.x', values['pos.x'], base.pos) : base.pos[0];
		const py = 'pos.y' in values ? worldValueOf(clip, 'pos.y', values['pos.y'], base.pos) : base.pos[1];
		const pz = 'pos.z' in values ? worldValueOf(clip, 'pos.z', values['pos.z'], base.pos) : base.pos[2];
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
	// R1: position keys are RELATIVE, so a recorded key is the INVERSE of the pose
	// mapping — without this, auto-key stores the current world value, the next run
	// adds the base to it again, and the movement doubles every time. The anchor is
	// the base the preview posed from, or the reference taken when REC was armed.
	const anchorPos = bases.get(uuid)?.pos ?? reference?.pos ?? null;
	for (const channel of watchableChannels(object)) {
		const current = channelValue(object, channel);
		const epsilon = STEPPED.has(channel) ? 0.5 : 1e-4;
		const track = byChannel.get(channel) ?? (channel.startsWith('scale.') ? uniform : undefined);
		if (track) {
			const sampled = sampleTrack(track, at);
			// compare in WORLD space: `sampled` is a key value, `current` is where the
			// object actually is
			const existing = sampled === null ? null : worldValueOf(clip, channel, sampled, anchorPos);
			if (existing !== null && Math.abs(existing - current) < epsilon) continue;
			writes.push({
				trackId: track.id,
				channel: track.channel,
				v: keyValueOf(clip, channel, current, anchorPos),
				from: null
			});
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
	// ...and the drag has just been ABSORBED into the clip, so it is no longer an
	// unrecorded user move: without this the next scrub would treat it as one and
	// re-anchor the whole clip onto it (rebaseIfMoved)
	posedPositions.set(uuid, object.position.toArray());
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
	// `pos` beside the values: R1 makes position keys relative, and a recorded key
	// is measured from this pose when no preview base exists (the object was posed
	// by hand rather than scrubbed to)
	autoKeyReference.set(uuid, { values, pos: object.position.toArray() });
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
 * Fold a RAW elapsed time (which keeps counting past the clip on a loop) into the
 * current pass, so that everything downstream reads the same frame.
 *
 * `elapsedOf` returns time since the run started — 7.3 s into a 2 s loop — and the
 * playing path is fine with that because `clipSecondsFor` takes it modulo the span.
 * `parkedPosition` does NOT: it adds the elapsed to the window start and clamps, so
 * a pause after the first lap parked the playhead at the very END (forward) or the
 * very START (reverse) while the object itself was posed mid-lap. That is the whole
 * of the reported "pause doesn't pause" and "it jumps to the first or last frame".
 *
 * An elapsed landing EXACTLY on a boundary keeps its span rather than folding to 0,
 * because parking at the end is a real position (the End button) — the same case
 * `parkedPosition` was written for.
 * @param {Clip} clip @param {number} elapsed @param {Play} [p] @returns {number}
 */
function foldElapsed(clip, elapsed, p) {
	const { span } = rangeOf(clip, p);
	if (!(span > 0)) return 0;
	const value = Math.max(0, num(elapsed));
	if (clip.loop === 'once') return Math.min(value, span);
	// pingpong's cycle is TWO spans (out and back), and clipSecondsFor reads the
	// direction from where in that cycle the phase sits — so fold to the cycle
	const period = clip.loop === 'pingpong' ? span * 2 : span;
	if (value <= period) return value;
	const rest = value % period;
	return rest === 0 ? period : rest;
}

/**
 * Where a PARKED playhead sits, read straight off the transport instead of through
 * the loop wrap: parking exactly at the end of a looping clip is a real thing to do
 * (the End button), and `(2/2) % 1` is 0, so it used to read back as the start —
 * which made "go to end" look like it did nothing and stepped the wrong way next.
 * Callers must hand it a FOLDED `pausedAt` (see foldElapsed).
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
	rebaseIfMoved(uuid, obj, clip); // the object may have been dragged since Stop
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
	// FOLD before storing: pausedAt is read back as a position inside one pass
	const clip = clipOf(uuid, p.clipId);
	const elapsed = elapsedOf(p, syncedNow());
	setPlay(uuid, { playing: false, pausedAt: clip ? foldElapsed(clip, elapsed, p) : elapsed }, true);
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
	rebaseIfMoved(uuid, obj, clip); // dragged since the last scrub? that pose is the anchor
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

// F5: where each playing object's playhead was on the PREVIOUS tick, so a marker
// crossing can be detected as an interval rather than an instant (a marker is a
// point and the playhead never lands exactly on one). Keyed by uuid and stamped
// with the clip, so switching clips cannot report a bogus crossing. LOCAL, like
// the once-clip end: every peer's runtime travels the same interval from the same
// synced stamp, so each fires its own pulse and no message is needed.
/** @type {Map<string, {clipId: string, seconds: number}>} */
const lastHead = new Map();

/** throttle for the properties-panel poke below (THREE objects are not reactive) */
let lastInspectorPoke = 0;

/**
 * Every marker the playhead passed travelling `from` -> `to`, in travel order.
 * The DESTINATION end is inclusive and the origin exclusive: a marker exactly
 * under a resting playhead would otherwise re-fire on every frame.
 * @param {{t: number, name: string}[]} markers @param {number} from @param {number} to
 */
function markersCrossed(markers, from, to) {
	if (to >= from) return markers.filter((m) => m.t > from && m.t <= to);
	return markers.filter((m) => m.t < from && m.t >= to).reverse();
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
	/** @type {{uuid: string, name: string}[]} */
	const crossed = [];
	let any = false;
	for (const uuid of uuids) {
		const p = map[uuid];
		if (!p?.playing) {
			lastHead.delete(uuid); // a fresh start must not cross from where it stopped
			continue;
		}
		const clip = clipOf(uuid, p.clipId);
		const obj = objectFor(uuid);
		if (!clip || !obj) continue;
		const base = ensureBase(uuid, obj);
		const elapsed = elapsedOf(p, now);
		// a once-clip ends at the end of its A/B WINDOW, which is the whole clip
		// unless in/out points were set
		const { from: rangeFrom, to: rangeTo, span } = rangeOf(clip, p);
		const done = clip.loop === 'once' && elapsed >= span;
		const seconds = clipSecondsFor(clip, done ? span : elapsed, !!p.reverse, p);
		poseAt(obj, clip, seconds, base);
		heads[uuid] = seconds;
		any = true;
		if (done) finished.push(uuid);

		// F5 marker crossings. Evaluated on the FINAL tick too — `seconds` is clamped
		// to the window end there, so a marker sitting on the last frame still fires.
		const markers = clip.markers;
		const prev = lastHead.get(uuid);
		if (markers?.length && prev && prev.clipId === (p.clipId ?? '')) {
			// A LOOP wraps: the playhead jumps from the window's far end back to its
			// near end, and the interval between prev and now is then the part it did
			// NOT travel. Fire the two real pieces instead of the empty gap between
			// them. 'pingpong' needs none of this — its reflection is continuous.
			const forward = !p.reverse;
			const wrapped = clip.loop === 'loop' && (forward ? seconds < prev.seconds : seconds > prev.seconds);
			if (!wrapped) {
				for (const m of markersCrossed(markers, prev.seconds, seconds)) crossed.push({ uuid, name: m.name });
			} else if (forward) {
				for (const m of markersCrossed(markers, prev.seconds, rangeTo)) crossed.push({ uuid, name: m.name });
				// nudge the origin below the window start so a marker sitting exactly
				// on it fires on every lap rather than never
				for (const m of markersCrossed(markers, rangeFrom - 1e-9, seconds)) crossed.push({ uuid, name: m.name });
			} else {
				for (const m of markersCrossed(markers, prev.seconds, rangeFrom)) crossed.push({ uuid, name: m.name });
				for (const m of markersCrossed(markers, rangeTo + 1e-9, seconds)) crossed.push({ uuid, name: m.name });
			}
		}
		lastHead.set(uuid, { clipId: p.clipId ?? '', seconds });
	}
	for (const { uuid, name } of crossed) notifyMarker(uuid, name);
	if (any || Object.keys(get(playheads)).length) {
		// `heads` only holds the objects that TICKED, i.e. the playing ones — so
		// replacing the map outright deleted the readout of anything paused, one
		// frame after `pause` wrote it. The pane then had no position to show for
		// the object it had just paused, which is the other half of "it jumps to
		// the first frame". Keep a paused object's head; drop only what no longer
		// has a transport at all (stop/reset clear those explicitly).
		const kept = get(playheads);
		/** @type {Record<string, number>} */
		const next = {};
		for (const uuid of Object.keys(kept)) if (map[uuid]) next[uuid] = kept[uuid];
		playheads.set(Object.assign(next, heads));
	}
	// The properties panel renders from a THREE object, and THREE objects are NOT
	// reactive — so while a clip played, every row sat at the value it had when the
	// panel opened. Poke the SELECTED object a few times a second: not per frame,
	// and deliberately not `objectsGroup`, which the object list and half the
	// deriveds in the app hang off.
	if (any) {
		const now = performance.now();
		if (now - lastInspectorPoke > 100) {
			const selected = get(selectedObject);
			if (selected?.uuid && map[selected.uuid]) {
				lastInspectorPoke = now;
				selectedObject.update((value) => value);
			}
		}
	}
	// a 'once' clip ends on its own on EVERY peer at the same elapsed time, so
	// this is a local state change — never a broadcast.
	for (const uuid of finished) {
		const p = get(playback)[uuid];
		const clip = clipOf(uuid, p?.clipId);
		setPlay(uuid, { playing: false, pausedAt: clip ? rangeOf(clip, p).span : 0 });
		// hand off to the graph: an Animation Finished node can start the next thing.
		// LOCAL like the end itself — every peer reaches it at the same elapsed time.
		notifyClipFinished(uuid);
	}
}
