// 31 (Stars Room S3): THE CLAP, the runtime half. clapGesture.js is the pure detector; this
// feeds it this peer's two VR hands every frame and, when a clap lands, hands the meeting
// point to flowRuntime.fireClap — which pulses every On Clap node (the spawner, the burst,
// the sound and the buzz are ordinary nodes wired to it).
//
//   feeds   — the VR hands through the SAME seam the knock uses (Scene passes vrControls'
//             handSnapshot in; this module never imports vrControls), carried into the
//             OBJECTS GROUP's frame so a bent world rig cannot put the star somewhere the
//             hands are not — the frame every peer shares (golden rule: key by content).
//   gates   — a headset, the game (Interact or Play — the editor stays still, the game-feel
//             rule), and a graph that is listening (an On Clap node not switched off by
//             its `enabled` input — the Stars Room wires it to a player setting). A hand
//             that GRIPS is carrying something, not clapping.
//   the test hook — `feedClap(left, right, t)` drives the detector with world positions
//             and the caller's clock (the knock's feedProbe shape); the gates still apply,
//             except the headset one, which a headless page cannot satisfy.

import * as THREE from 'three';
import { get } from 'svelte/store';
import { isVRMode, objectsGroup } from '../stores/sceneStore';
import { gameFeelActive } from './gameFeel';
import { createClapState, stepClap } from './clapGesture';
import { fireClap, clapWanted, clapOptions } from './flowRuntime';

/** @type {((hand: 'left'|'right') => any) | null} */
let hands = null;
let started = false;
const state = createClapState();
const debug = { claps: 0, lastPoint: /** @type {number[] | null} */ (null), fired: 0 };
const _l = new THREE.Vector3();
const _r = new THREE.Vector3();

/**
 * One frame of the detector over two WORLD positions. Returns the clap point (objects
 * group's frame) when one landed.
 * @param {number[] | null} left @param {number[] | null} right @param {number} now ms
 * @returns {number[] | null}
 */
function step(left, right, now) {
	if (!gameFeelActive() || !clapWanted()) {
		stepClap(state, null, null, now); // not listening: no hold survives the gap
		return null;
	}
	const group = get(objectsGroup);
	/** @param {number[] | null} p @param {any} v */
	const local = (p, v) => {
		if (!p) return null;
		v.set(p[0], p[1], p[2]);
		if (group) group.worldToLocal(v);
		return [v.x, v.y, v.z];
	};
	if (group) group.updateWorldMatrix(true, false);
	const result = stepClap(state, local(left, _l), local(right, _r), now, clapOptions());
	if (!result.fired || !result.point) return null;
	debug.claps++;
	debug.lastPoint = [...result.point];
	debug.fired += fireClap(result.point);
	return result.point;
}

/** Per frame, from Scene's useTask beside tickKnock. @param {number} now */
export function tickClap(now) {
	if (!started || !hands) return;
	if (!get(isVRMode)) return;
	const l = hands('left');
	const r = hands('right');
	const usable = (/** @type {any} */ s) => (s?.position && !s.gripped ? s.position : null);
	step(usable(l), usable(r), now);
}

/**
 * THE TEST HOOK: one detector frame with the caller's hands (WORLD positions) and clock.
 * @param {number[] | null} left @param {number[] | null} right @param {number} t ms
 * @returns {number[] | null} the clap point when one landed
 */
export function feedClap(left, right, t) {
	return step(left, right, t);
}

/** Wire the hand seam. Called from Scene's onMount beside startKnock (the TDZ rule).
 * @param {{hands?: (hand: 'left'|'right') => any}} [options] */
export function startClap(options = {}) {
	if (started || typeof window === 'undefined') return () => {};
	started = true;
	hands = options.hands ?? null;
	return stopClap;
}

export function stopClap() {
	started = false;
	hands = null;
	Object.assign(state, createClapState());
}

/** test/debug view */
export function clapDebug() {
	return { ...debug, state: { ...state } };
}
