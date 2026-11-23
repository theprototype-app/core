// 102b-papercuts (scout row 18): REAL DISTANCE AND HEIGHT FOG. A LEAF (imports nothing), so the rules are
// testable with no scene. The fog stays inside the environment preset payload, ADDITIVELY:
//
//   {color, near, far, fit?}                               linear fog, exactly as before (no `kind`)
//   {color, near, far, kind: 'distance', density}          exponential fog that thickens with distance
//   {color, near, far, kind: 'height', density, base, thickness}
//                                                          fog that lies on the ground: densest at `base`
//                                                          (m), thinning upward over `thickness` (m), and
//                                                          integrated along each view ray, so looking down
//                                                          into a valley fogs more than looking across it
//
// near / far stay in the document, so an older build (which only knows linear fog) still draws a fog.
// The editing half (switching kind, the shader maths for tests) is fogEdit.js, which only the lazy Fog rows load.

/** @typedef {'linear' | 'distance' | 'height'} FogKind */
export const FOG_KINDS = /** @type {const} */ (['linear', 'distance', 'height']);
export const FOG_DENSITY_DEFAULT = 0.02;
export const FOG_THICKNESS_DEFAULT = 6;

/** @param {any} fog @returns {FogKind} */
export function fogKindOf(fog) {
	return fog?.kind === 'distance' || fog?.kind === 'height' ? fog.kind : 'linear';
}

/** a density in (0, 1], else the default @param {any} fog */
export function fogDensityOf(fog) {
	const d = Number(fog?.density);
	return Number.isFinite(d) && d > 0 ? Math.min(d, 1) : FOG_DENSITY_DEFAULT;
}

/** the height layer, or null for a fog that has none @param {any} fog @returns {{base: number, thickness: number} | null} */
export function heightFogOf(fog) {
	if (fogKindOf(fog) !== 'height') return null;
	const base = Number(fog.base);
	const thickness = Number(fog.thickness);
	return {
		base: Number.isFinite(base) ? Math.max(-10000, Math.min(10000, base)) : 0,
		thickness: Number.isFinite(thickness) && thickness > 0.05 ? Math.min(thickness, 10000) : FOG_THICKNESS_DEFAULT
	};
}

/** the shared shader uniform's four numbers: [base, 1 / thickness, on, 0] @param {any} fog */
export function heightFogParams(fog) {
	const h = heightFogOf(fog);
	return h ? [h.base, 1 / h.thickness, 1, 0] : [0, 0, 0, 0];
}

/** 102b: the shared height-fog uniform value [base, 1/thickness, on, 0] (fogShader.js puts it in every fog
 * material; a leaf here so the Cinematic view and environment.js can read and write it without the patch) */
export const HEIGHT_FOG = new Float32Array(4);

/** write the layer (from heightFogParams) @param {number[]} params */
export function setHeightFog(params) {
	for (let i = 0; i < 4; i++) HEIGHT_FOG[i] = Number(params[i]) || 0;
}
