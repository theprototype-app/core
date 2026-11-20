// 100 C1 — THE WEBGL HALF OF THE SWITCH (lazy: loaded with the Cinematic view). The main WebGL context is lost
// and restored ON PURPOSE; render/view.js (the boot seam) remembers that so Scene.svelte does not report it.
import { setMainReleased } from '../render/view.js';

/** @param {EventTarget} el @param {string} type @param {number} ms */
function once(el, type, ms) {
	return new Promise((resolve) => {
		const t = setTimeout(() => (el.removeEventListener(type, on), resolve(false)), ms);
		const on = () => (clearTimeout(t), el.removeEventListener(type, on), resolve(true));
		el.addEventListener(type, on);
	});
}

/**
 * Release the main WebGL renderer's GPU state: render lists dropped, the context lost on purpose
 * (every GL object goes with it). three keeps its JS state; `restoreMainContext` brings it back.
 * @param {any} renderer @param {number} [ms]
 */
export async function releaseMainContext(renderer, ms = 10000) {
	setMainReleased(true);
	const canvas = renderer.domElement;
	const lost = once(canvas, 'webglcontextlost', ms);
	renderer.renderLists?.dispose?.();
	renderer.forceContextLoss();
	const ok = await lost;
	// a TASK after the event: a loss nobody default-prevented cannot be restored, and the other
	// listeners (three's, Scene.svelte's) run after ours resolved
	await new Promise((resolve) => setTimeout(resolve, 0));
	return ok;
}

/** @param {any} renderer @param {number} [ms] */
export async function restoreMainContext(renderer, ms = 10000) {
	const canvas = renderer.domElement;
	const restored = once(canvas, 'webglcontextrestored', ms);
	renderer.forceContextRestore();
	const ok = await restored;
	setMainReleased(false);
	return ok;
}
