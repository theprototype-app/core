// 101 L1a guard — off-frame program compiles go through the seam.
//
// three r186's WebGPURenderer.compileAsync() calls `targetScene.onBeforeRender` and NEVER
// `onAfterRender` (common/Renderer.js: the compile path opens the bracket, only a real render
// closes it). lod.js counts that bracket (`renderDepth`), so an unclosed one leaves every LOD swap
// geometry on its mesh for good: LOD frozen, every pack piece serializes in full, saves throw and
// later loads fail (roadmap 100 spike, finding L1a, fixed there in be48fc4d).
//
// WebGLRenderer.compile/compileAsync reach the scene hooks only through a nodes handler 1.x never
// sets, so today this is the plain call. The guard is for the next caller and the next renderer:
// it COUNTS the hooks the call actually made and closes only what stayed open, so a renderer that
// brackets correctly is left alone and one that opens twice is closed twice.
// CI (`npm run check:render-seam`) fails a `.compileAsync(` anywhere outside src/lib/render/.

/**
 * Compile `object`'s programs for `camera` without drawing a frame, then close any scene render
 * bracket the renderer left open. Resolves when the renderer's own compile resolves (rejects
 * with its error, after the bracket is closed). A renderer without compileAsync resolves at once.
 * @param {any} renderer a WebGLRenderer or WebGPURenderer
 * @param {any} object what to compile (a scene, a group, a mesh)
 * @param {any} camera
 * @param {any} [targetScene] the scene whose lights/environment apply (three's 3rd argument);
 *   its hooks are the ones the renderer calls. Defaults to `object`.
 * @returns {Promise<{ closed: number }>} `closed` = how many brackets the guard closed
 */
export async function compileAsync(renderer, object, camera, targetScene = null) {
	if (!renderer?.compileAsync) return { closed: 0 };
	const scene = targetScene ?? object;
	const watch = watchSceneBracket(scene);
	try {
		await renderer.compileAsync(object, camera, targetScene ?? undefined);
	} finally {
		watch.release();
		for (let i = 0; i < watch.open(); i++) scene.onAfterRender?.(renderer, scene, camera, null);
	}
	return { closed: watch.open() };
}

/**
 * Wrap `scene.onBeforeRender` / `onAfterRender` with counters for the length of one call. Frames
 * drawn meanwhile open AND close their bracket (a render is synchronous), so the net count is
 * exactly what the compile left open. The originals are put back only if nobody replaced the
 * wrappers in the meantime (lod.js installs and uninstalls its hooks at runtime).
 * @param {any} scene
 */
export function watchSceneBracket(scene) {
	let before = 0;
	let after = 0;
	if (!scene || typeof scene !== 'object') return { open: () => 0, release() {} };
	const own = {
		before: Object.prototype.hasOwnProperty.call(scene, 'onBeforeRender'),
		after: Object.prototype.hasOwnProperty.call(scene, 'onAfterRender')
	};
	const orig = { before: scene.onBeforeRender, after: scene.onAfterRender };
	/** @this {any} @param {any[]} args */
	const wrapBefore = function (...args) {
		before++;
		return orig.before?.apply(this, args);
	};
	/** @this {any} @param {any[]} args */
	const wrapAfter = function (...args) {
		after++;
		return orig.after?.apply(this, args);
	};
	scene.onBeforeRender = wrapBefore;
	scene.onAfterRender = wrapAfter;
	return {
		open: () => Math.max(0, before - after),
		release() {
			if (scene.onBeforeRender === wrapBefore) {
				if (own.before) scene.onBeforeRender = orig.before;
				else delete scene.onBeforeRender;
			}
			if (scene.onAfterRender === wrapAfter) {
				if (own.after) scene.onAfterRender = orig.after;
				else delete scene.onAfterRender;
			}
		}
	};
}
