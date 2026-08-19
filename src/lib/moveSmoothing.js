import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';


// 21-B: a thrown crate is SMOOTH on the peer watching it.
//
// The physics initiator broadcasts `move` on a 100 ms gate (and only while a
// body is actually moving), so a watching peer receives ~10 poses a second and
// `moveGeometry` SNAPS to each one. At walking pace that is invisible; on a
// 20 m/s throw it is a slideshow — reported as "the updates are choppy on the
// remote peer, like 10-20 fps".
//
// Raising the send rate was the obvious fix and the wrong one: it costs
// bandwidth for every body in every scene to solve a problem that only exists on
// the RECEIVER, and it would still be a step function between packets. This
// interpolates instead — free on the wire, and it works just as well for a peer
// on a bad connection, whose packets are the ones that arrive late.
//
// The trade is one interval of display latency (~100 ms): the object is rewound
// to where it was and eased to where it now is, rather than jumping. That is the
// standard interpolation bargain, and it is invisible next to the choppiness it
// removes. The initiator's own view is untouched — it never goes through here.
//
// SCOPE, deliberately narrow, and gated on what is OBSERVED rather than on
// session state: an object carrying physics params whose moves arrive as a
// STREAM (two inside 400 ms). remoteSimulating was the obvious gate and the
// wrong one — a late joiner is never told that a sim is already running, so the
// peer that needs this most would have been the one peer without it.
//
// A single move — a gizmo nudge, an undo, a module write — has no cadence and
// snaps exactly as before, so nothing outside a live stream changes.

/** @typedef {{from: {pos: THREE.Vector3, quat: THREE.Quaternion},
 *   to: {pos: THREE.Vector3, quat: THREE.Quaternion}, t0: number, dur: number}} Ease */
/** @type {Map<string, Ease>} */
const eases = new Map();
/** @type {Map<string, {last: number, interval: number}>} */
const cadence = new Map();
/** @type {Map<string, any>} the belt-and-braces landing timers */
const landings = new Map();

const MIN_MS = 50;
const MAX_MS = 250;
/** a jump this big is a teleport (respawn, undo, a thrown body's own apply) —
 * smearing across it would draw the object through everything in between */
const SNAP_DISTANCE = 3;
/** two moves closer together than this are a STREAM, not a one-off write */
const STREAM_MS = 400;

/**
 * A remote `move` has just been applied to `object`. `before` is the pose it had
 * a moment ago; the object is rewound there and eased forward from the next
 * frame, so what the viewer sees is continuous instead of stepped.
 * @param {string} uuid @param {any} object
 * @param {{pos: THREE.Vector3, quat: THREE.Quaternion}} before
 */
export function noteRemoteMove(uuid, object, before) {
	if (!object) return false;
	if (!object.userData?.physics) return false; // scenery snaps exactly as before
	const now = performance.now();
	// how fast is this peer actually sending? Measured per object rather than
	// assumed, so a slower stream eases over a longer window instead of arriving
	// early and stalling
	const beat = cadence.get(uuid);
	const gap = beat ? now - beat.last : Infinity;
	const interval = beat
		? Math.min(MAX_MS, Math.max(MIN_MS, beat.interval * 0.7 + gap * 0.3))
		: MAX_MS / 2;
	cadence.set(uuid, { last: now, interval });
	// Gate on the STREAM itself, not on a session flag. remoteSimulating is the
	// obvious test and the wrong one: a late joiner is never told that a sim is
	// already running, so the peer most in need of this would be the one peer
	// without it. A single move (a gizmo nudge, an undo) has no cadence and snaps
	// exactly as before; two inside 400 ms is a stream, and a stream is what looks
	// choppy.
	if (!(gap < STREAM_MS)) return false;

	if (before.pos.distanceTo(object.position) > SNAP_DISTANCE) {
		eases.delete(uuid);
		return false;
	}
	eases.set(uuid, {
		from: { pos: before.pos.clone(), quat: before.quat.clone() },
		to: { pos: object.position.clone(), quat: object.quaternion.clone() },
		t0: now,
		dur: interval
	});
	// rewind: the ease starts where the eye last saw it
	object.position.copy(before.pos);
	object.quaternion.copy(before.quat);
	// BELT AND BRACES. The ease is advanced by the frame loop, and a frame loop
	// can stall — a backgrounded tab is throttled to a few frames a second or
	// fewer. If the stream then STOPS (the body settled), the object would sit
	// wherever the last frame left it: measured 1.8 m short on a page rendering at
	// ~4 fps. A timer lands it on the exact target regardless, so interpolation can
	// only ever affect WHEN the pose is reached, never WHICH pose.
	clearTimeout(landings.get(uuid));
	landings.set(
		uuid,
		setTimeout(() => {
			landings.delete(uuid);
			const pending = eases.get(uuid);
			if (!pending) return;
			object.position.copy(pending.to.pos);
			object.quaternion.copy(pending.to.quat);
			eases.delete(uuid);
			objectsGroup.update((value) => value);
		}, interval + 60)
	);
	return true;
}

/** Per frame, from Scene's useTask. Writes the exact target pose on the last
 * step, so an interrupted or finished ease never leaves the object short. */
export function tickMoveSmoothing() {
	if (eases.size === 0) return;
	const group = get(objectsGroup);
	const now = performance.now();
	for (const [uuid, ease] of [...eases.entries()]) {
		const object = group?.getObjectByProperty('uuid', uuid);
		if (!object) {
			eases.delete(uuid);
			continue;
		}
		const t = ease.dur > 0 ? (now - ease.t0) / ease.dur : 1;
		if (t >= 1) {
			object.position.copy(ease.to.pos);
			object.quaternion.copy(ease.to.quat);
			eases.delete(uuid);
			continue;
		}
		object.position.lerpVectors(ease.from.pos, ease.to.pos, t);
		object.quaternion.slerpQuaternions(ease.from.quat, ease.to.quat, t);
	}
	objectsGroup.update((value) => value);
}

/** the sim stopped, the peer left, the scene changed — land everything at once */
export function clearMoveSmoothing() {
	const group = get(objectsGroup);
	for (const [uuid, ease] of eases) {
		const object = group?.getObjectByProperty('uuid', uuid);
		if (!object) continue;
		object.position.copy(ease.to.pos);
		object.quaternion.copy(ease.to.quat);
	}
	for (const timer of landings.values()) clearTimeout(timer);
	landings.clear();
	eases.clear();
	cadence.clear();
}

/** test/debug view */
export function moveSmoothingDebug() {
	return { active: eases.size, intervals: [...cadence.values()].map((c) => Math.round(c.interval)) };
}
