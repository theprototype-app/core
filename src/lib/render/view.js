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
//   · `mainContextReleased()`: the WebGL half of the switch loses and restores the context ON PURPOSE
//     (cinematic/mainContext.js, lazy); Scene.svelte's loss handler asks this and does not report a
//     lost 3D view for it;
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

/** the switch marks the WebGL context's loss as deliberate (cinematic/mainContext.js) @param {boolean} on */
export function setMainReleased(on) {
	owner.released = on;
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
