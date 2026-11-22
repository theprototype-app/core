// 101 F3 — THE MAIN RENDERER, MADE IN ONE PLACE (a leaf: three + the WebGL 2 probe only).
//
// Before this file the main view's renderer was threlte's DEFAULT (a `new WebGLRenderer` inside
// @threlte/core's renderer context) and its settings were spread over ~8 files: the shadow map type
// on two `<Canvas>` lines, tone mapping and exposure in environment.js / xrLook.js, the pixel ratio
// in Scene.svelte, the context-loss listeners in Scene.svelte and the WebGL 2 probe in
// webglSupport.js. Roadmap 100's renderer switch needs ONE seam to swap: this is it.
//
// - `createMainRenderer(canvas, opts)` is handed to threlte as `<Canvas createRenderer>` (the prop
//   exists in @threlte/core 8.6.1: `createRendererContext` calls `createRenderer(canvas)` once per
//   Canvas mount and uses the result for its resize / render tasks and its unmount `dispose()`).
//   The options are threlte's own defaults, verbatim, so the picture is byte-identical.
// - `MAIN_SHADOW_MAP` is what both Canvas lines pass as `shadows` (threlte owns the effect that
//   writes `renderer.shadowMap.type` from it).
// - `setToneMapping` / `setExposure` / `mainPixelRatio` are the hooks every writer goes through,
//   so the 100 switch can map them onto another renderer in one file.
// - `watchContextLoss` is the one place the lost / restored listeners attach.
// Everything else a renderer needs (render targets, readbacks, the thumbnail renderer) lives in
// ./renderTargets.js and ./offscreen.js; `disposeRenderer()` in ./index.js releases all of it.
import * as THREE from 'three';

export { probeWebGL2 } from './webgl2Probe.js';

/** threlte 8.6.1's default constructor options for the main view (context/fragments/renderer.svelte.js) */
export const MAIN_RENDERER_OPTIONS = Object.freeze({ powerPreference: /** @type {const} */ ('high-performance'), antialias: true, alpha: true });

// 30 P0: threlte's Canvas defaults `shadows` to PCFSoftShadowMap, which three 0.185 deprecates and
// silently downgrades to PCFShadowMap on the first shadow render (with a console warning). Asking
// for PCF directly is the identical picture, minus the warning.
export const MAIN_SHADOW_MAP = THREE.PCFShadowMap;

/** @type {THREE.WebGLRenderer | null} */
let main = null;

/**
 * Make the main view's renderer (threlte `<Canvas createRenderer={createMainRenderer}>`).
 * @param {HTMLCanvasElement} canvas @param {THREE.WebGLRendererParameters} [opts] overrides (none today)
 * @returns {THREE.WebGLRenderer}
 */
export function createMainRenderer(canvas, opts = {}) {
	const renderer = new THREE.WebGLRenderer({ canvas, ...MAIN_RENDERER_OPTIONS, ...opts });
	main = renderer;
	return renderer;
}

/** the live main renderer (null before the Canvas mounts / after disposeRenderer({main: true})) */
export function mainRenderer() {
	return main;
}

/** forget the main renderer (disposeRenderer's half; the owner — threlte — disposes the object) */
export function forgetMainRenderer() {
	main = null;
}

/** the tone curve hook @param {any} renderer @param {number} mapping a THREE tone mapping constant */
export function setToneMapping(renderer, mapping) {
	renderer.toneMapping = mapping;
}

/** the exposure hook @param {any} renderer @param {number} exposure */
export function setExposure(renderer, exposure) {
	renderer.toneMappingExposure = exposure;
}

/** the main view's pixel ratio for a quality scale (Scene.svelte's governor watch) @param {number} scale */
export function mainPixelRatio(scale) {
	return (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1) * scale;
}

/**
 * Attach the lost / restored listeners to the main canvas. Returns the detach.
 * @param {HTMLCanvasElement} canvas @param {(event: Event) => void} onLost @param {(event: Event) => void} onRestored
 */
export function watchContextLoss(canvas, onLost, onRestored) {
	canvas.addEventListener('webglcontextlost', onLost);
	canvas.addEventListener('webglcontextrestored', onRestored);
	return () => {
		canvas.removeEventListener('webglcontextlost', onLost);
		canvas.removeEventListener('webglcontextrestored', onRestored);
	};
}
