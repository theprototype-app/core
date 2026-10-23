// 65 M2 — the BACKGROUND LAYER's rules, pure (imports NOTHING; vitest runs it with no GPU).
// The runtime that owns the meshes and the uniforms is backgroundLayer.js; this is only what
// it decides: which mode a document asks for, which budget tier this device draws at, where a
// pointer lands on the VR sphere, and how the pointer is eased.

/** @typedef {'off'|'screen'|'plane'} LayerMode */
/** @typedef {{mode: LayerMode, target: string|null, pointer: boolean, scroll: boolean}} LayerSettings */

/** The modes a document may name. `screen` = full screen behind the scene, `plane` = drawn on a
 * picked scene object's surface, `off` = authored but not drawn. */
export const LAYER_MODES = /** @type {LayerMode[]} */ (['off', 'screen', 'plane']);

/**
 * ONE normalize at every boundary (the document's `layer` field rides inside the shader graph
 * document, so it arrives through the wire, undo and four save paths untouched).
 * Defaults: full screen, pointer on, scroll off.
 * @param {any} raw @returns {LayerSettings}
 */
export function normalizeLayer(raw) {
	const mode = LAYER_MODES.includes(raw?.mode) ? raw.mode : 'screen';
	return {
		mode,
		target: typeof raw?.target === 'string' && raw.target ? raw.target : null,
		pointer: raw?.pointer !== false,
		scroll: raw?.scroll === true
	};
}

/**
 * Which mode actually DRAWS on this device right now. A headset never gets the screen
 * triangle: a full-screen quad is head-locked (it turns with your head, which is how a
 * background makes people ill), so in XR a screen background becomes the big sphere around
 * you. A plane is world-space and stays a plane.
 * @param {LayerSettings} layer @param {{xr: boolean, targetFound: boolean}} ctx
 * @returns {'none'|'screen'|'sphere'|'plane'}
 */
export function drawModeFor(layer, ctx) {
	if (layer.mode === 'off') return 'none';
	if (layer.mode === 'plane') return ctx.targetFound ? 'plane' : 'none';
	return ctx.xr ? 'sphere' : 'screen';
}

/**
 * THE DEVICE BUDGET. `low` on a headset, on a phone, and on any device whose quality governor
 * has stepped down to the post-processing step or below (the same moment it gives up the scene
 * look) — the layer then caps fractal noise at 2 octaves. One graph, two costs, no second
 * document (the TP_OCTAVE_CAP define in the fBm prelude).
 * @param {{xr?: boolean, phone?: boolean, postOff?: boolean, dprScale?: number}} d
 * @returns {'high'|'low'}
 */
export function tierFor(d) {
	if (d.xr || d.phone || d.postOff) return 'low';
	if (Number.isFinite(d.dprScale) && /** @type {number} */ (d.dprScale) <= 0.61) return 'low';
	return 'high';
}

/** The fBm octave cap per tier (the shader's TP_OCTAVE_CAP). @param {'high'|'low'} tier */
export function octaveCapFor(tier) {
	return tier === 'low' ? 2 : 8;
}

/**
 * A world DIRECTION (from the head) to the sphere's layer UV — the same mapping the sphere's
 * vertex shader uses, so a controller pointing at a spot lights up that spot. u is MIRRORED
 * about the forward axis (0.5 straight ahead, 0 to the right, 1 to the left, and the back half a
 * reflection of the front) so a pattern that does not tile has no seam behind you; v is the
 * elevation, 0 straight down, 1 straight up.
 * @param {number} x @param {number} y @param {number} z @returns {[number, number]}
 */
export function sphereUv(x, y, z) {
	const len = Math.hypot(x, y, z) || 1;
	const dx = x / len, dy = y / len, dz = z / len;
	const u = Math.abs(Math.atan2(dz, dx)) / Math.PI;
	const v = Math.asin(Math.max(-1, Math.min(1, dy))) / Math.PI + 0.5;
	return [u, v];
}

/**
 * Ease the pointer towards where it is: exponential smoothing that is frame-rate independent
 * (the same feel at 60 and 90 Hz), plus the eased velocity in layer units per second.
 * @param {{x: number, y: number, vx: number, vy: number}} state mutated
 * @param {number} tx @param {number} ty target @param {number} dt seconds
 * @param {number} [rate] 1/s — higher follows tighter
 */
export function easePointer(state, tx, ty, dt, rate = 9) {
	const step = Math.max(0, Math.min(dt, 0.1));
	if (step <= 0) return state;
	const k = 1 - Math.exp(-rate * step);
	const nx = state.x + (tx - state.x) * k;
	const ny = state.y + (ty - state.y) * k;
	const vx = (nx - state.x) / step;
	const vy = (ny - state.y) / step;
	// the velocity is eased too, so one jumpy event does not flash a velocity-driven effect
	state.vx += (vx - state.vx) * k;
	state.vy += (vy - state.vy) * k;
	state.x = nx;
	state.y = ny;
	return state;
}

/**
 * Page scroll progress 0..1 (the embed / scroll-hero case), or null when the page does not
 * scroll — the editor's own page never does, so there the layer falls back to the wheel.
 * @param {{scrollTop: number, scrollHeight: number, clientHeight: number}|null|undefined} el
 */
export function pageScrollProgress(el) {
	if (!el) return null;
	const range = el.scrollHeight - el.clientHeight;
	if (!(range > 1)) return null;
	return Math.max(0, Math.min(1, el.scrollTop / range));
}
