// 101 F3: the WebGL 2 probe, in the renderer seam (a leaf). webglSupport.js re-exports it for its
// callers (App.svelte / PlayApp.svelte ask it before mounting the <Canvas>).

/**
 * Can this browser give us a WebGL 2 context (all three r163+ draws with)? The probe context is
 * released at once, so it never counts against the browser's context limit. SSR = yes.
 * @param {Document} [doc] @returns {boolean}
 */
export function probeWebGL2(doc = typeof document !== 'undefined' ? document : undefined) {
	if (!doc) return true;
	try {
		const canvas = doc.createElement('canvas');
		const gl = /** @type {WebGL2RenderingContext | null} */ (canvas.getContext('webgl2'));
		if (!gl) return false;
		try {
			gl.getExtension('WEBGL_lose_context')?.loseContext();
		} catch {
			/* releasing is a courtesy */
		}
		return true;
	} catch {
		return false;
	}
}
