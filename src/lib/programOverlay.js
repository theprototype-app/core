// 77 — THE PROGRAM OVERLAY SEAM: what the cut draws OVER the rendered frame (clips, titles,
// transitions) goes in the one place a frame is drawn (Outline.svelte's render task), right
// after the main render, so the recorder's and the export's capture stage sees it. A leaf with
// one null check per frame; the cut runtime (lib/cut/cutRuntime.js, a lazy chunk) registers.
// Not in a headset: the XR frame is the compositor's (deferred, QUESTIONS-77-cut-a fork 4).

/** @type {((renderer: any, scene: any, camera: any) => void) | null} */
let draw = null;

/** @param {(renderer: any, scene: any, camera: any) => void} fn @returns {() => void} */
export function setProgramOverlay(fn) {
	draw = fn;
	return () => {
		if (draw === fn) draw = null;
	};
}

/** @param {any} renderer @param {any} scene @param {any} camera */
export function drawProgramOverlay(renderer, scene, camera) {
	if (draw) draw(renderer, scene, camera);
}
