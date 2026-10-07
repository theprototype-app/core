// VR controls — WORLD-GRAB SNAPPING (37 R10). The two-grip world gesture (grip.js, 71) yaws and scales the
// local world rig freely; with snapping on (Settings ▸ VR ▸ Controls ▸ World grab snapping, default on):
//   - the world's YAW moves in 15° steps of its ABSOLUTE heading, so 0° (the scene as authored) is always
//     a step — a twist lands squarely back on the room's axes;
//   - the SCALE sticks at the detents 1/10 · 1/5 · 1/2 · 1 · 2 · 5 · 10× (a band of ±7 % around each, in
//     log space), and slides freely between them;
//   - every step change and every detent catch ticks the hands, and a readout between them says where
//     you are ("2× · 45°").
// Hysteresis on both (a step or a detent is LEFT only a little past where it was taken), so a hand
// trembling on a boundary never chatters. The maths is pure (snapWorldGrab); grip.js calls it with
// the previous frame's result. The world rig is local, so none of this replicates.
//
// The ticks: haptics are silent in Edit (30b C4 — the user, from a Quest), but a detent you cannot feel
// is no detent, and this gesture lives in Edit. They are the lightest pulse the core sends, only on a
// step/detent change, and they go away with the setting (QUESTIONS-37-vr-world.md Q1).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene } from '../../stores/sceneStore';
import { renderer } from './core.js';
import { hapticPulse } from './haptics.js';
import { vrWorldSnap } from './prefs.js';

export const YAW_STEP = Math.PI / 12; // 15°
/** the scale detents (both ways from 1:1) */
export const SCALE_DETENTS = [0.1, 0.2, 0.5, 1, 2, 5, 10];
/** a detent catches within ±7 % (log space) and lets go past ±11 % */
const CATCH = Math.log(1.07);
const RELEASE = Math.log(1.11);
/** a yaw step is left 2° past its half-way line */
const YAW_HYSTERESIS = (2 * Math.PI) / 180;

/** @typedef {{step: number, detent: number | null}} SnapState */

/** the rig's absolute heading (radians, about +Y) @param {number[]} quat */
export function yawOf(quat) {
	const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(quat), 'YXZ');
	return e.y;
}

/**
 * Snap one frame of the gesture. Pure.
 * @param {{total: number, yaw: number, yaw0: number}} raw `total` = the wanted absolute scale, `yaw` =
 *   the wanted yaw DELTA since the grab began, `yaw0` = the rig's heading when it began
 * @param {SnapState | null} prev last frame's result (null on the first frame)
 * @returns {{total: number, yaw: number, step: number, detent: number | null}}
 */
export function snapWorldGrab(raw, prev) {
	// yaw: the nearest 15° step of the ABSOLUTE heading, held a little past half-way
	const abs = raw.yaw0 + raw.yaw;
	let step = Math.round(abs / YAW_STEP);
	if (prev && step !== prev.step && Math.abs(abs - prev.step * YAW_STEP) < YAW_STEP / 2 + YAW_HYSTERESIS) step = prev.step;
	const yaw = step * YAW_STEP - raw.yaw0;
	// scale: stick to a detent inside its band; keep a caught one until it is pulled clearly off
	const ln = Math.log(Math.max(raw.total, 1e-6));
	let detent = null;
	if (prev?.detent && Math.abs(ln - Math.log(prev.detent)) < RELEASE) detent = prev.detent;
	else for (const d of SCALE_DETENTS) if (Math.abs(ln - Math.log(d)) < CATCH) detent = d;
	return { total: detent ?? raw.total, yaw, step, detent };
}

/** "2×", "½×", "1.37×" @param {number} s */
export function scaleLabel(s) {
	const frac = { 0.5: '½', 0.2: '⅕', 0.1: '⅒' };
	const key = /** @type {keyof typeof frac} */ (Math.round(s * 1000) / 1000);
	if (frac[key]) return frac[key] + '×';
	if (Math.abs(s - Math.round(s)) < 1e-6) return Math.round(s) + '×';
	return (s >= 1 ? s.toFixed(1) : s.toFixed(2)) + '×';
}
/** "45°" in 0..359 @param {number} step */
export function yawLabel(step) {
	return (((step * 15) % 360) + 360) % 360 + '°';
}

// ---- the live gesture: state, ticks, readout --------------------------------------------------

/** @type {SnapState | null} */ let state = null;
/** @type {{ticks: number, last: string}} the suites' view */
const stats = { ticks: 0, last: '' };

/** grip.js, once per world-grab frame: snap (when on) and tick on a change.
 * @param {{total: number, yaw: number, yaw0: number}} raw @returns {{total: number, yaw: number}} */
export function applyWorldSnap(raw) {
	if (!get(vrWorldSnap)) {
		state = null;
		hideReadout();
		return raw;
	}
	const next = snapWorldGrab(raw, state);
	const changed = !!state && (next.step !== state.step || (next.detent !== state.detent && next.detent !== null));
	state = { step: next.step, detent: next.detent };
	if (changed) {
		stats.ticks++;
		hapticPulse(0.15, 12, undefined, true); // the one forced Edit pulse besides the mode switch (Q1)
	}
	showReadout(scaleLabel(next.total) + ' · ' + yawLabel(next.step), next.detent !== null);
	return next;
}

/** the gesture ended (grip.js) */
export function endWorldSnap() {
	state = null;
	hideReadout();
}

/** @returns {{on: boolean, active: boolean, step: number | null, detent: number | null, ticks: number, readout: string, readoutVisible: boolean}} */
export function worldSnapDebug() {
	return {
		on: !!get(vrWorldSnap),
		active: !!state,
		step: state?.step ?? null,
		detent: state?.detent ?? null,
		ticks: stats.ticks,
		readout: stats.last,
		readoutVisible: !!readout?.visible
	};
}

/** @type {any} */ let readout = null;
/** @type {any} */ let readoutCanvas = null;

function ensureReadout() {
	if (readout || typeof document === 'undefined') return readout;
	const scene = get(globalScene);
	if (!scene) return null;
	readoutCanvas = document.createElement('canvas');
	readoutCanvas.width = 256;
	readoutCanvas.height = 64;
	const texture = new THREE.CanvasTexture(readoutCanvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	readout = new THREE.Mesh(
		new THREE.PlaneGeometry(0.12, 0.03),
		new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false })
	);
	readout.name = 'vr-world-snap-readout';
	readout.renderOrder = 997;
	readout.visible = false;
	scene.add(readout); // scene root: never in objectsGroup, never the rig (it would scale with the world)
	return readout;
}

/** @param {string} text @param {boolean} caught */
function showReadout(text, caught) {
	const mesh = ensureReadout();
	if (!mesh || !renderer?.xr) return;
	// between the hands, a little above, facing the head
	const a = renderer.xr.getController(0).getWorldPosition(new THREE.Vector3());
	const b = renderer.xr.getController(1).getWorldPosition(new THREE.Vector3());
	mesh.position.copy(a.add(b).multiplyScalar(0.5)).add(new THREE.Vector3(0, 0.09, 0));
	const head = renderer.xr.getCamera?.()?.getWorldPosition?.(new THREE.Vector3());
	if (head) mesh.lookAt(head);
	mesh.visible = true;
	const key = text + (caught ? '!' : '');
	if (key === stats.last) return;
	stats.last = key;
	const ctx = readoutCanvas.getContext('2d');
	if (!ctx) return;
	ctx.clearRect(0, 0, 256, 64);
	// dark plate; a caught detent lights the accent (the radial's hover blue)
	ctx.fillStyle = caught ? 'rgba(37, 99, 235, 0.92)' : 'rgba(17, 24, 39, 0.85)';
	ctx.beginPath();
	ctx.roundRect?.(2, 2, 252, 60, 16);
	if (!ctx.roundRect) ctx.rect(2, 2, 252, 60);
	ctx.fill();
	ctx.fillStyle = '#ffffff';
	ctx.font = 'bold 30px sans-serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(text, 128, 34);
	mesh.material.map.needsUpdate = true;
}

function hideReadout() {
	if (readout) readout.visible = false;
}
