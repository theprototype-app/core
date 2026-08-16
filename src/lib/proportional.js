import { writable } from 'svelte/store';

// 19-A P4: PROPORTIONAL EDITING's shared state, split out of meshEdit as a LEAF
// (svelte/store only) so faceEdit can read it too. faceEdit cannot import
// meshEdit — meshEdit already imports faceEdit, and a static back-edge closes a
// TDZ cycle — so the stores live below both. meshEdit RE-EXPORTS them, which
// keeps every import site and the __stores.meshEdit.* test paths byte-compatible.

/** armed like a tool — an in-session mode, not a saved preference
 * @type {import('svelte/store').Writable<boolean>} */
export const proportionalEdit = writable(false);

/** falloff radius in OBJECT-LOCAL units (the grab math runs in local space in
 * BOTH the vertex and the face/edge paths, so one number means one thing).
 * Local pref: it is a working-scale choice, and the same number is right for
 * the next session on the same kind of model.
 * @type {import('svelte/store').Writable<number>} */
export const proportionalRadius = writable(
	typeof localStorage !== 'undefined'
		? Math.min(Math.max(parseFloat(localStorage.getItem('proportionalRadius') ?? '') || 1, 0.01), 100)
		: 1
);
proportionalRadius.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('proportionalRadius', String(value));
});

/**
 * Smooth falloff: 1 at the dragged element, 0 at the radius, with zero slope at both ends so
 * neither the centre nor the rim shows a crease. (Smoothstep — Blender's "Smooth" preset.)
 * @param {number} t 0..1 @returns {number}
 */
export function falloffWeight(t) {
	if (t <= 0) return 1;
	if (t >= 1) return 0;
	return 1 - t * t * (3 - 2 * t);
}

// ---- 19-A P7b: WHEEL-driven radius during a live drag ------------------------
// While a proportional drag is live the mouse wheel resizes the falloff radius
// (multiplicative, ~1.1 per step) and the owner RECAPTURES its weights from the
// new radius against the drag-start positions. The owners (meshEdit's vertex
// drag, faceEdit's face/edge grab) register a recapture callback at drag begin
// and clear it at drag end — the callback doubling as the "is a proportional
// drag live" predicate that trackpadNav's window-wheel pan checks.
//
// The listener suppresses BOTH competing wheel consumers: OrbitControls listens
// on the CANVAS, so stopPropagation from this window-CAPTURE handler never lets
// the event descend to it; trackpadNav's own listener is on the SAME node
// (window, capture) where stopPropagation cannot help — it imports
// `proportionalWheelActive` and early-outs instead. This module stays a leaf:
// the listener adds no imports, only a `window` guard.

/** @type {(() => void) | null} the live drag's recapture, or null (no drag) */
let wheelRecapture = null;

/** Arm the wheel for a live proportional drag. @param {() => void} recapture
 * re-derives the falloff weights from the CURRENT radius (against drag-start
 * positions) and re-applies the gesture so the surface reshapes immediately. */
export function beginProportionalWheel(recapture) {
	wheelRecapture = recapture;
}

/** Disarm the wheel (drag end/commit/cancel/session exit). Idempotent. */
export function endProportionalWheel() {
	wheelRecapture = null;
}

/** True while a proportional drag owns the wheel — trackpadNav's pan guard. */
export function proportionalWheelActive() {
	return !!wheelRecapture;
}

/** @param {WheelEvent} e */
function onProportionalWheel(e) {
	if (!wheelRecapture) return;
	// the PAGE must not scroll/zoom, and OrbitControls (canvas) must not dolly —
	// capture at window runs before the event ever descends to the canvas
	e.preventDefault();
	e.stopPropagation();
	const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
	proportionalRadius.update((r) => Math.min(Math.max(r * factor, 0.01), 100));
	wheelRecapture();
}

if (typeof window !== 'undefined')
	window.addEventListener('wheel', onProportionalWheel, { passive: false, capture: true });

// ---- anchor providers (registration seam) -----------------------------------
// The radius RING needs "where is the current selection" per element mode, but
// that state lives in meshEdit (vertices) and faceEdit (edges/faces) — importing
// either from here would re-create the cycle this module exists to break, and a
// primed dynamic import risks the HMR dual-instance trap. So the owners REGISTER
// a provider instead (the registerGizmoPrefListener pattern).

/** @type {Record<string, () => any>} per-mode anchor providers */
const anchorProviders = {};

/**
 * Register the anchor provider for one element mode. The provider returns
 * `{point, normal, object}` (WORLD-space point + unit normal + the edited THREE
 * object, whose world scale converts the local radius), or null when there is
 * nothing selected.
 * @param {'vertices'|'edges'|'faces'} mode @param {() => any} fn
 */
export function registerProportionalAnchor(mode, fn) {
	anchorProviders[mode] = fn;
}

/** The current anchor for a mode, or null (no provider / nothing selected).
 * @param {string} mode @returns {any} */
export function proportionalAnchor(mode) {
	return anchorProviders[mode]?.() ?? null;
}
