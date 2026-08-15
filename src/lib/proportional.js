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
