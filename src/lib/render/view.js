// 100 C1 — WHO DRAWS THE MAIN VIEW (a boot-path leaf: no imports).
//
// Normally the WebGL renderer draws the main view: Outline.svelte's render task runs the composer.
// While the Cinematic view is on ($lib/cinematic, a lazy chunk), a WebGPU renderer draws the SAME
// live scene on its own canvas, and the WebGL renderer's context is RELEASED (one renderer in GPU
// memory at a time). Everything the boot path needs to know about that lives here:
//   · `viewOwnsFrame()` / `drawView(delta)`: the render task hands its frame to the other renderer
//     (threlte's scheduler keeps running: flows, physics, gizmos, the recorder's stages);
//   · `frameCanvas(renderer)` / `frameCount(renderer)`: the canvas a frame lands on and a counter
//     that moves once per drawn frame, for whoever copies frames (video export, the moment buffer);
//   · `releaseMainContext` / `restoreMainContext`: the WebGL half of the switch (context lost and
//     restored ON PURPOSE — Scene.svelte's loss handler asks `mainContextReleased()` and does not
//     report a lost 3D view for it);
//   · `setViewSelection` / `viewSelection()`: the outlined objects (Outline.svelte owns the sets).

/** @type {{ draw: ((delta: number) => void) | null, canvas: HTMLCanvasElement | null, frames: number, released: boolean, selection: (() => { selected: any[], locked: any[] }) | null }} */
const owner = { draw: null, canvas: null, frames: 0, released: false, selection: null };

/** is another renderer drawing the main view right now? */
export function viewOwnsFrame() {
	return owner.draw !== null;
}

/** the render task's frame, drawn by the view's renderer @param {number} delta */
export function drawView(delta) {
	if (!owner.draw) return;
	owner.draw(delta);
	owner.frames++;
}

/**
 * Hand the main view to another renderer (null gives it back).
 * @param {{ draw: (delta: number) => void, canvas: HTMLCanvasElement } | null} o
 */
export function setViewOwner(o) {
	owner.draw = o?.draw ?? null;
	owner.canvas = o?.canvas ?? null;
}

/** the canvas the main view's frames land on @param {any} renderer the WebGL main renderer */
export function frameCanvas(renderer) {
	return owner.draw && owner.canvas ? owner.canvas : (renderer?.domElement ?? null);
}

/** a number that moves once per drawn main-view frame @param {any} renderer the WebGL main renderer */
export function frameCount(renderer) {
	return owner.draw ? -1 - owner.frames : (renderer?.info?.render?.frame ?? 0);
}

/** was the main WebGL context lost on purpose (the view switch), not by the browser? */
export function mainContextReleased() {
	return owner.released;
}

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
	owner.released = true;
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
	owner.released = false;
	return ok;
}

/** @type {any[]} geometry disposals held while the view draws */
const heldDisposals = [];

/**
 * Dispose a geometry that may SHARE an interleaved buffer with live meshes (lodGroup's swap geometries).
 * Under the WebGPU renderer, disposing one geometry destroys the shared GPU buffer under every other mesh
 * using it (spike W1: "Buffer used in submit while destroyed", the kit walls vanish) — so while the view
 * draws, such a disposal waits until the WebGL renderer has the frame again.
 * @param {any} geometry
 */
export function disposeSharedGeometry(geometry) {
	if (owner.draw && geometry?.attributes && Object.values(geometry.attributes).some((a) => /** @type {any} */ (a)?.isInterleavedBufferAttribute)) {
		heldDisposals.push(geometry);
		return;
	}
	geometry?.dispose?.();
}

/** run the held disposals (the view gave the frame back) @returns {number} how many */
export function flushHeldDisposals() {
	const list = heldDisposals.splice(0);
	for (const g of list) g.dispose();
	return list.length;
}

/** Outline.svelte registers where the outlined objects are @param {(() => { selected: any[], locked: any[] }) | null} fn */
export function setViewSelection(fn) {
	owner.selection = fn;
}

/** the outlined objects right now */
export function viewSelection() {
	return owner.selection?.() ?? { selected: [], locked: [] };
}
