// 101 F3 — the renderer seam's front door: everything the app's renderers are made, configured,
// read back and released through. `disposeRenderer()` releases what the seam created; it is what
// roadmap 100's view switch calls before it creates the other renderer.
import { mainRenderer, forgetMainRenderer } from './mainRenderer.js';
import { disposeRenderTargets, liveRenderTargets } from './renderTargets.js';
import { disposeOffscreen, offscreenState } from './offscreen.js';

export * from './mainRenderer.js';
export * from './renderTargets.js';
export * from './offscreen.js';

/**
 * Release everything the seam created: every factory render target still alive, the shared
 * thumbnail renderer, the main renderer's render lists — and with `{ main: true }` the main
 * renderer itself (its animation loop stops; only a new `<Canvas>` brings a view back).
 * Owners keep their target objects: three re-uploads a disposed target on its next use.
 * @param {{ main?: boolean }} [opts]
 */
export function disposeRenderer(opts = {}) {
	const targets = disposeRenderTargets();
	const offscreen = disposeOffscreen();
	/** @type {any} */
	const r = mainRenderer();
	r?.renderLists?.dispose?.();
	let main = false;
	if (opts.main && r) {
		r.setAnimationLoop(null);
		r.dispose();
		forgetMainRenderer();
		main = true;
	}
	return { targets, offscreen, main };
}

/** one event on `el`, or a timeout @param {EventTarget} el @param {string} type @param {number} ms */
function once(el, type, ms) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`no ${type} in ${ms} ms`)), ms);
		el.addEventListener(type, () => (clearTimeout(t), resolve(true)), { once: true });
	});
}

/**
 * Dispose and RE-CREATE the main renderer's GPU state, on the same canvas: `disposeRenderer()`
 * (without `main`), then the context is lost on purpose and restored — three rebuilds its GL
 * state, Scene.svelte's restore listener marks every material for recompile, and every geometry,
 * texture and target re-uploads from JS memory on the next frame. This is the path roadmap 100's
 * switch runs with a different renderer class at the end (100 "How the switch works" §3); the
 * 101-seam e2e drives it and compares the frame before and after.
 * @param {{ timeout?: number }} [opts]
 */
export async function recycleMainRenderer(opts = {}) {
	/** @type {any} */
	const r = mainRenderer();
	if (!r) throw new Error('no main renderer');
	const ms = opts.timeout ?? 10000;
	const released = disposeRenderer();
	const canvas = r.domElement;
	const lost = once(canvas, 'webglcontextlost', ms);
	r.forceContextLoss();
	await lost;
	// a TASK, not a microtask: the promise resolves inside OUR lost listener, before the other
	// listeners (three's, Scene.svelte's) have called preventDefault — and a loss nobody
	// default-prevented cannot be restored (the browser ignores restoreContext)
	await new Promise((resolve) => setTimeout(resolve, 50));
	const restored = once(canvas, 'webglcontextrestored', ms);
	r.forceContextRestore();
	await restored;
	return { released, lost: true, restored: !r.getContext().isContextLost() };
}

/** what the seam holds right now (e2e + the 100 switch's checks) */
export function seamState() {
	/** @type {any} */
	const r = mainRenderer();
	return {
		main: !!r,
		targets: liveRenderTargets(),
		offscreen: offscreenState(),
		memory: r ? { ...r.info.memory, programs: r.info.programs?.length ?? 0 } : null
	};
}
