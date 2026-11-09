// 78 F2 — ON HOVER, the input half: what THIS peer's pointer is over, at <= 15 Hz, on the objects
// some On Hover node watches (flowRuntime.hoverTargetUuids). Three pointers, one resolver
// (flowRuntime.hoverTargetAlong — the nearest visible hit, so a wall in front hides the bell):
//   · the MOUSE over the viewport in Interact, or Play's crosshair (the screen centre) while the
//     pointer is locked — a Play menu frees the mouse again;
//   · a phone TAP: a touch has no hover, so a tap on a watched object counts as hovering it for
//     a moment (TAP_HOLD) — "phone tap = hover";
//   · a VR controller's LASER, each hand.
// The hysteresis lives in hoverCore.hoverStep (an object must be missed for 120 ms to count as
// left). Each edge goes to flowRuntime.fireObjectHover, which stamps the On Hover nodes — the
// stamps replicate, so nothing here sends anything.
//
// Gated on gameFeelActive(): a hover is a GAME input (Play or Interact), never the editor — an
// author dragging the gizmo over the bell must not ring it. Started by flowRuntime the first
// time an On Hover node watches something (a primed import: this module imports flowRuntime).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalRenderer, globalCamera, isLocked, playPointerFree } from '../stores/sceneStore';
import { gameFeelActive } from './gameFeel';
import { hoverStep, OVER_RESTAMP } from './hoverCore.js';
import { hoverTargetUuids, hoverTargetAlong, fireObjectHover } from './flowRuntime';
import { controllerRayOf } from './vrGameInput';

/** how often the pointer is sampled (ms) — 15 Hz */
const SAMPLE_MS = 66;
/** how long a phone tap counts as hovering (seconds) */
export const TAP_HOLD = 1.0;

let started = false;
/** the mouse over the canvas, in NDC, or null when it is off the canvas */
let mouse = /** @type {{x: number, y: number} | null} */ (null);
/** uuid -> until (performance seconds): a phone tap's hover */
const taps = new Map();
/** this peer's hover state (hysteresis) */
const over = /** @type {Map<string, {lastSeen: number}>} */ (new Map());
/** uuid -> the last "over" re-stamp */
const overStamped = new Map();
/** @type {any} */ let attachedTo = null;
const stats = { samples: 0, enters: 0, leaves: 0, taps: 0 };

const nowS = () => performance.now() / 1000;
const raycaster = new THREE.Raycaster();

/** a ray from NDC through the current camera @param {number} x @param {number} y */
function rayAt(x, y) {
	const camera = /** @type {any} */ (get(globalCamera));
	if (!camera) return null;
	raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
	return raycaster;
}

/** client coords -> NDC on the canvas @param {any} el @param {number} cx @param {number} cy */
function ndcOf(el, cx, cy) {
	const r = el.getBoundingClientRect();
	if (!r.width || !r.height) return null;
	return { x: ((cx - r.left) / r.width) * 2 - 1, y: -((cy - r.top) / r.height) * 2 + 1 };
}

/** listen on the renderer's canvas (re-attached if the renderer is replaced) */
function attach() {
	const renderer = /** @type {any} */ (get(globalRenderer));
	const el = renderer?.domElement;
	if (!el || el === attachedTo) return;
	attachedTo = el;
	el.addEventListener('pointermove', (/** @type {PointerEvent} */ e) => {
		if (e.pointerType === 'touch') return;
		mouse = ndcOf(el, e.clientX, e.clientY);
	});
	el.addEventListener('pointerleave', (/** @type {PointerEvent} */ e) => {
		if (e.pointerType !== 'touch') mouse = null;
	});
	// phone: tap = hover (a touch never moves a pointer over anything)
	el.addEventListener('pointerdown', (/** @type {PointerEvent} */ e) => {
		if (e.pointerType !== 'touch' || !gameFeelActive()) return;
		const at = ndcOf(el, e.clientX, e.clientY);
		const ray = at ? rayAt(at.x, at.y) : null;
		const uuid = ray ? hoverTargetAlong(ray) : null;
		taps.clear();
		if (uuid) {
			taps.set(uuid, nowS() + TAP_HOLD);
			stats.taps++;
			sample(); // at once: a tap should not wait for the next sample
		}
	});
}

/** one sample: who is over what, and the edges */
function sample() {
	const watched = hoverTargetUuids();
	const now = nowS();
	/** @type {Set<string>} */
	const seen = new Set();
	if (watched.size && gameFeelActive()) {
		attach();
		stats.samples++;
		const renderer = /** @type {any} */ (get(globalRenderer));
		if (renderer?.xr?.isPresenting) {
			for (const index of [0, 1]) {
				const ray = controllerRayOf(index);
				const uuid = ray ? hoverTargetAlong(ray) : null;
				if (uuid) seen.add(uuid);
			}
		} else {
			const locked = get(isLocked) === true && !get(playPointerFree);
			const at = locked ? { x: 0, y: 0 } : mouse;
			const ray = at ? rayAt(at.x, at.y) : null;
			const uuid = ray ? hoverTargetAlong(ray) : null;
			if (uuid) seen.add(uuid);
		}
		for (const [uuid, until] of taps) {
			if (now < until) seen.add(uuid);
			else taps.delete(uuid);
		}
	}
	const { entered, left } = hoverStep(over, seen, now);
	for (const uuid of entered) {
		stats.enters++;
		overStamped.set(uuid, now);
		fireObjectHover(uuid, 'enter');
	}
	for (const uuid of left) {
		stats.leaves++;
		overStamped.delete(uuid);
		fireObjectHover(uuid, 'leave');
	}
	for (const uuid of over.keys()) {
		const last = overStamped.get(uuid) ?? 0;
		if (now - last >= OVER_RESTAMP) {
			overStamped.set(uuid, now);
			fireObjectHover(uuid, 'over');
		}
	}
}

/** start the sampler once (flowRuntime calls this when an On Hover node first watches something) */
export function ensureHoverInput() {
	if (started || typeof window === 'undefined') return;
	started = true;
	attach();
	setInterval(sample, SAMPLE_MS);
}

/** the suites' view @returns {any} */
export function hoverInputDebug() {
	return { ...stats, over: [...over.keys()], taps: [...taps.keys()], mouse };
}
