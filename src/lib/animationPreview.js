import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { suspendAnimation, resumeAnimation } from './flowRuntime';

// Animation window v1 (roadmap #9 tail, ex-backlog). A LOCAL-ONLY transform
// animator: each object owns a list of "movement" tracks; each track animates one
// transform channel from `from` to `to` over the shared duration, shaped by a
// cubic-bezier easing curve (two draggable control points, like an After Effects
// speed graph). Play/Pause/Stop preview the result by driving the object per frame
// from the scene loop (tickAnimationPreview); Stop restores the pose captured when
// Play began. NOT replicated and NO layer blending in v1 (deliberate scope) — so
// it never enters peer sync or the golden-rule broadcast path; it is purely a local
// authoring/preview tool. Persisting + replicating authored clips is a later batch.

/**
 * @typedef {{ id: string, channel: string, from: number, to: number, bezier: number[] }} Track
 * @typedef {{ tracks: Track[], duration: number, loop: 'once'|'loop'|'pingpong' }} Anim
 */

/** @type {import('svelte/store').Writable<Record<string, Anim>>} uuid -> authored animation */
export const animations = writable({});

/** live playback readout for the UI scrubber (not read per frame by the runtime) */
export const playback = writable({ playing: false, uuid: /** @type {string|null} */ (null), time: 0 });

// transform channels a track can drive (rotation in degrees at the UI, radians here)
export const CHANNELS = ['pos.x', 'pos.y', 'pos.z', 'rot.x', 'rot.y', 'rot.z', 'scale'];

/** cubic-bezier control points [x1,y1,x2,y2] with fixed endpoints (0,0),(1,1) */
export const EASINGS = /** @type {Record<string, number[]>} */ ({
	linear: [0, 0, 1, 1],
	ease: [0.25, 0.1, 0.25, 1],
	'ease-in': [0.42, 0, 1, 1],
	'ease-out': [0, 0, 0.58, 1],
	'ease-in-out': [0.42, 0, 0.58, 1]
});

let trackSeq = 0;

// --- playback state (module-local; not in the store so the tick stays cheap) ----
let playing = false;
/** @type {string|null} */ let playUuid = null;
let startedAt = 0; // performance.now() reference, back-dated by the pause offset
let pausedAt = 0; // elapsed seconds captured at pause (resume point)
/** @type {any} */ let baseSnapshot = null; // pose to restore on Stop

/** @param {any} object */
function captureBase(object) {
	return {
		pos: object.position.toArray(),
		rot: [object.rotation.x, object.rotation.y, object.rotation.z],
		scale: object.scale.toArray()
	};
}

/** @param {any} object @param {any} base */
function restoreBase(object, base) {
	object.position.fromArray(base.pos);
	object.rotation.set(base.rot[0], base.rot[1], base.rot[2]);
	object.scale.fromArray(base.scale);
	object.updateMatrix(); // serializers read object.matrix, not the live pose (see flowRuntime)
}

/** @param {string} uuid */
function objectFor(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
}

// --- authoring API -----------------------------------------------------------

/** @param {string} uuid */
export function getAnim(uuid) {
	return get(animations)[uuid] ?? null;
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
		default: return 0;
	}
}

/** @param {string} channel */
export function channelLabel(channel) {
	return (
		{
			'pos.x': 'Position X', 'pos.y': 'Position Y', 'pos.z': 'Position Z',
			'rot.x': 'Rotation X', 'rot.y': 'Rotation Y', 'rot.z': 'Rotation Z',
			scale: 'Scale'
		}[channel] ?? channel
	);
}

/**
 * Add a movement track. `from` defaults to the object's current value; `to` gets a
 * sensible visible delta so the movement is demoable immediately.
 * @param {string} uuid @param {string} channel @param {any} obj
 */
export function addTrack(uuid, channel, obj) {
	const from = channelValue(obj, channel);
	const isRot = channel.startsWith('rot');
	const to = channel === 'scale' ? from * 1.5 || 1.5 : isRot ? from + Math.PI / 2 : from + 2;
	/** @type {Track} */
	const track = { id: 't' + ++trackSeq, channel, from, to, bezier: [...EASINGS['ease-in-out']] };
	animations.update((map) => {
		const anim = map[uuid] ?? { tracks: [], duration: 2, loop: 'loop' };
		return { ...map, [uuid]: { ...anim, tracks: [...anim.tracks, track] } };
	});
	return track.id;
}

/** @param {string} uuid @param {string} trackId */
export function removeTrack(uuid, trackId) {
	animations.update((map) => {
		const anim = map[uuid];
		if (!anim) return map;
		return { ...map, [uuid]: { ...anim, tracks: anim.tracks.filter((t) => t.id !== trackId) } };
	});
}

/** @param {string} uuid @param {string} trackId @param {Partial<Track>} patch */
export function updateTrack(uuid, trackId, patch) {
	animations.update((map) => {
		const anim = map[uuid];
		if (!anim) return map;
		return {
			...map,
			[uuid]: { ...anim, tracks: anim.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) }
		};
	});
}

/** @param {string} uuid @param {Partial<Anim>} patch */
export function updateAnim(uuid, patch) {
	animations.update((map) => {
		const anim = map[uuid] ?? { tracks: [], duration: 2, loop: 'loop' };
		return { ...map, [uuid]: { ...anim, ...patch } };
	});
}

// --- saving ------------------------------------------------------------------
// Authored tracks used to live only in memory: saving a scene and loading it back
// lost every movement the user had built here (17-D follow-up). They are plain
// JSON, so a save carries them verbatim.

/** Every authored animation, for a save payload. @returns {any} */
export function animationsSnapshot() {
	return structuredClone(get(animations));
}

/** Restore authored animations from a save payload. @param {any} saved */
export function animationsRestore(saved) {
	if (!saved || typeof saved !== 'object') return 0;
	stop(); // never leave a scrub running against objects that just changed
	const clean = /** @type {any} */ ({});
	for (const [uuid, anim] of Object.entries(/** @type {any} */ (saved))) {
		const entry = /** @type {any} */ (anim);
		if (!entry || !Array.isArray(entry.tracks)) continue;
		clean[uuid] = {
			tracks: entry.tracks,
			duration: Number(entry.duration) || 2,
			loop: entry.loop === 'once' || entry.loop === 'pingpong' ? entry.loop : 'loop'
		};
	}
	animations.set(clean);
	return Object.keys(clean).length;
}

/** Forget an object's animation (removal / scene wipe). @param {string} uuid */
export function dropAnimation(uuid) {
	if (playUuid === uuid) stop();
	animations.update((map) => {
		const next = { ...map };
		delete next[uuid];
		return next;
	});
}

// --- easing ------------------------------------------------------------------

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
	}
}

/** Pose the object at normalized time x in [0,1]. @param {any} obj @param {Anim} anim @param {number} x */
function applyAnimAt(obj, anim, x) {
	for (const track of anim.tracks) {
		const eased = cubicBezierEase(track.bezier, x);
		setChannel(obj, track.channel, track.from + (track.to - track.from) * eased);
	}
	obj.updateMatrix();
}

/** Normalized time for a loop mode at elapsed seconds. @param {Anim} anim @param {number} elapsed */
function phase(anim, elapsed) {
	const dur = Math.max(anim.duration, 0.001);
	if (anim.loop === 'once') return Math.min(elapsed / dur, 1);
	if (anim.loop === 'pingpong') {
		const p = (elapsed / dur) % 2;
		return p <= 1 ? p : 2 - p;
	}
	return (elapsed / dur) % 1;
}

// --- transport ---------------------------------------------------------------

/** @param {string} uuid */
export function play(uuid) {
	const obj = objectFor(uuid);
	if (!obj) return;
	if (playUuid && playUuid !== uuid) stop(); // one preview at a time
	suspendAnimation(uuid); // park a flow-driven object at its base so it doesn't fight us
	if (!baseSnapshot || playUuid !== uuid) baseSnapshot = captureBase(obj);
	playUuid = uuid;
	startedAt = performance.now() - pausedAt * 1000; // resume from the pause offset
	playing = true;
	playback.set({ playing: true, uuid, time: pausedAt });
}

export function pause() {
	if (!playing) return;
	pausedAt = (performance.now() - startedAt) / 1000;
	playing = false;
	playback.update((p) => ({ ...p, playing: false }));
}

export function stop() {
	playing = false;
	pausedAt = 0;
	const obj = playUuid ? objectFor(playUuid) : null;
	if (obj && baseSnapshot) restoreBase(obj, baseSnapshot);
	const was = playUuid;
	if (was) resumeAnimation(was); // released pose becomes the new flow base (no-op if untracked)
	baseSnapshot = null;
	playback.set({ playing: false, uuid: was, time: 0 });
}

/** Preview a specific time without running (scrubber drag). @param {string} uuid @param {number} seconds */
export function scrub(uuid, seconds) {
	const obj = objectFor(uuid);
	const anim = get(animations)[uuid];
	if (!obj || !anim) return;
	if (!baseSnapshot || playUuid !== uuid) {
		baseSnapshot = captureBase(obj);
		playUuid = uuid;
	}
	pausedAt = seconds;
	if (!playing) startedAt = performance.now() - seconds * 1000;
	applyAnimAt(obj, anim, phase(anim, seconds));
	playback.set({ playing, uuid, time: seconds });
}

/** Per-frame from the scene loop (Scene.svelte useTask). */
export function tickAnimationPreview() {
	if (!playing || !playUuid) return;
	const obj = objectFor(playUuid);
	const anim = get(animations)[playUuid];
	if (!obj || !anim) return;
	const dur = Math.max(anim.duration, 0.001);
	const elapsed = (performance.now() - startedAt) / 1000;
	if (anim.loop === 'once' && elapsed >= dur) {
		applyAnimAt(obj, anim, 1);
		playing = false;
		pausedAt = 0;
		playback.set({ playing: false, uuid: playUuid, time: dur });
		return;
	}
	applyAnimAt(obj, anim, phase(anim, elapsed));
	playback.set({ playing: true, uuid: playUuid, time: elapsed % dur });
}
