// 102b-hud (row 19): GAME FEEL — camera shake, screen flash, hit pause. The runtime half of three flow
// actions (flowRuntime acts on the trigger's stamp edge; this owns what happens).
//
// All three are LOCAL presentation: they change what THIS device draws, never the scene, the
// simulation or anything replicated. Every peer that acts on the replicated stamp does its own, so
// "everyone" needs no message; "per player" (the default) acts only where the pulse was made (the
// press, the hit on this machine) — flowRuntime decides that, this file just plays the effect.
//   · shake: an offset on the PLAY camera for one draw (applied before the frame, taken off after),
//     desktop / phone Play only. Never in VR (a shaking headset view is a comfort problem) and never
//     on the editor camera.
//   · flash: a full-screen colour that fades out (a DOM overlay; pointer-events none), in Play and
//     Interact. Not drawn in a headset (the DOM is not there).
//   · hit pause: the next N ms of frames are not drawn (the last frame holds), the classic hit-stop.
//     Physics and the clock run on: the world is shared, only this view freezes.
// Reduced motion (the app's one setting, motion.js) turns shake to a quarter and flash to a third.
import { get } from 'svelte/store';
import { isLocked, editorMode } from '../stores/sceneStore';
import { reducedMotion } from './motion';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** the active shake, or null @type {null | {start: number, end: number, strength: number, frequency: number}} */
let shake = null;
/** the frame-hold deadline (performance.now ms) */
let holdUntil = 0;
/** suites: what fired @type {{shakes: number, flashes: number, pauses: number, lastFlash: any, lastShake: any}} */
const debug = { shakes: 0, flashes: 0, pauses: 0, lastFlash: null, lastShake: null };

const playing = () => get(isLocked) === true;
const reduced = () => {
	try {
		return !!get(reducedMotion);
	} catch {
		return false;
	}
};

/** @param {any} v @param {number} lo @param {number} hi @param {number} d */
const clamp = (v, lo, hi, d) => {
	const n = Number(v);
	return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};

/**
 * Start (or strengthen) a camera shake. Only while this device is in desktop / phone Play.
 * @param {{strength?: number, seconds?: number, frequency?: number}} [opts] strength in metres of
 *   sway at the start (0..1), seconds 0.05..3, frequency Hz 2..40
 * @returns {boolean} whether it started
 */
export function cameraShake(opts = {}) {
	if (!playing()) return false;
	let strength = clamp(opts.strength, 0, 1, 0.15);
	if (reduced()) strength *= 0.25;
	const seconds = clamp(opts.seconds, 0.05, 3, 0.35);
	const t = now();
	// a second hit while shaking keeps the stronger one and the later end
	const live = shake && t < shake.end ? shake : null;
	shake = {
		start: t,
		end: Math.max(t + seconds * 1000, live?.end ?? 0),
		strength: Math.max(strength, live ? live.strength * (1 - (t - live.start) / Math.max(1, live.end - live.start)) : 0),
		frequency: clamp(opts.frequency, 2, 40, 18)
	};
	debug.shakes++;
	debug.lastShake = { strength: shake.strength, seconds };
	return true;
}

/**
 * The shake offset for a frame at `t` (pure of the camera): position metres + a small roll / pitch.
 * @param {number} [t] @returns {null | {x: number, y: number, z: number, pitch: number, roll: number}}
 */
export function shakeOffset(t = now()) {
	if (!shake || t >= shake.end) {
		shake = null;
		return null;
	}
	const life = (t - shake.start) / Math.max(1, shake.end - shake.start);
	const amp = shake.strength * (1 - life) * (1 - life);
	const w = (shake.frequency * 2 * Math.PI * (t - shake.start)) / 1000;
	// three incommensurate sines per axis: smooth, not periodic-looking
	const n = (/** @type {number} */ a, /** @type {number} */ b) => Math.sin(w * a + b) * 0.6 + Math.sin(w * a * 1.7 + b * 2.3) * 0.4;
	return { x: amp * n(1, 0.3), y: amp * n(1.13, 1.7), z: amp * 0.3 * n(0.91, 4.1), pitch: amp * 0.08 * n(1.31, 2.2), roll: amp * 0.12 * n(0.77, 5.3) };
}

/**
 * The render seam (Outline.svelte): put the shake on `camera` for this one draw. Returns the undo,
 * or null when nothing applies (no shake, not Play, XR). @param {any} camera @param {boolean} xr
 * @returns {null | (() => void)}
 */
export function applyShake(camera, xr) {
	if (!shake || xr || !camera || !playing()) return null;
	const off = shakeOffset();
	if (!off) return null;
	const p = camera.position;
	const r = camera.rotation;
	const was = { x: p.x, y: p.y, z: p.z, rx: r.x, rz: r.z };
	p.set(p.x + off.x, p.y + off.y, p.z + off.z);
	r.x += off.pitch;
	r.z += off.roll;
	camera.updateMatrixWorld?.();
	return () => {
		p.set(was.x, was.y, was.z);
		r.x = was.rx;
		r.z = was.rz;
		camera.updateMatrixWorld?.();
	};
}

/**
 * Hold the frame for `ms` (a hit pause). Play or Interact; never in XR (the seam checks).
 * @param {number} [ms] 20..500 @returns {boolean}
 */
export function hitPause(ms = 80) {
	if (!(playing() || get(editorMode) === 'interact')) return false;
	holdUntil = Math.max(holdUntil, now() + clamp(ms, 20, 500, 80));
	debug.pauses++;
	return true;
}

/** the render seam: is this frame held? */
export function frameHeldByHitPause() {
	return holdUntil > 0 && now() < holdUntil;
}

/** @type {HTMLDivElement | null} */
let flashEl = null;

/**
 * A full-screen colour that fades out. Play or Interact; the DOM overlay sits under modals and
 * toasts and takes no pointer.
 * @param {{color?: string, seconds?: number, strength?: number}} [opts] strength 0..1 = the start opacity
 * @returns {boolean}
 */
export function screenFlash(opts = {}) {
	if (typeof document === 'undefined') return false;
	if (!(playing() || get(editorMode) === 'interact')) return false;
	let strength = clamp(opts.strength, 0, 1, 0.6);
	if (reduced()) strength /= 3;
	const seconds = clamp(opts.seconds, 0.05, 3, 0.25);
	const color = /^#[0-9a-f]{3,8}$/i.test(String(opts.color ?? '')) ? String(opts.color) : '#ffffff';
	if (!flashEl || !flashEl.isConnected) {
		flashEl = document.createElement('div');
		flashEl.id = 'tp-screen-flash';
		flashEl.setAttribute('aria-hidden', 'true');
		// the HUD tier: over the 3D view and the HUD, under menus, modals and toasts
		flashEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;opacity:0;z-index:var(--z-hud, 30);';
		document.body.appendChild(flashEl);
	}
	flashEl.style.background = color;
	flashEl.getAnimations?.().forEach((a) => a.cancel());
	if (typeof flashEl.animate === 'function')
		flashEl.animate([{ opacity: strength }, { opacity: 0 }], { duration: seconds * 1000, easing: 'ease-out', fill: 'forwards' });
	else flashEl.style.opacity = '0';
	debug.flashes++;
	debug.lastFlash = { color, strength, seconds };
	return true;
}

/** suites */
export function gameFeelFxDebug() {
	return { ...debug, shaking: !!shake, held: frameHeldByHitPause() };
}

/** suites / a scene change: stop everything */
export function resetGameFeelFx() {
	shake = null;
	holdUntil = 0;
	flashEl?.getAnimations?.().forEach((a) => a.cancel());
	if (flashEl) flashEl.style.opacity = '0';
}
