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

/**
 * A patch that switches the kind, with the defaults the new kind needs (a density, a layer). Merged by
 * mergeFogPatch like any fog edit; near / far are left as they were (they are an older build's fog).
 * @param {any} fog @param {FogKind} kind
 */
export function fogKindPatch(fog, kind) {
	if (kind === 'linear') return { kind: 'linear' };
	/** @type {Record<string, any>} */
	const patch = { kind };
	if (!(Number(fog?.density) > 0)) patch.density = FOG_DENSITY_DEFAULT;
	if (kind === 'height') {
		if (!Number.isFinite(Number(fog?.base))) patch.base = 0;
		if (!(Number(fog?.thickness) > 0)) patch.thickness = FOG_THICKNESS_DEFAULT;
	}
	return patch;
}

/**
 * The fraction of fog colour one point gets — the same maths the shader runs, for tests and probes.
 * @param {any} fog @param {number} dist metres from the camera @param {number} camY @param {number} pointY
 */
export function fogFactorAt(fog, dist, camY, pointY) {
	const kind = fogKindOf(fog);
	if (kind === 'linear') {
		const near = Number(fog?.near) || 0;
		const far = Number(fog?.far) || 0;
		const t = Math.min(1, Math.max(0, (dist - near) / Math.max(1e-6, far - near)));
		return t * t * (3 - 2 * t); // smoothstep, as three
	}
	const d = fogDensityOf(fog);
	if (kind === 'distance') return 1 - Math.exp(-d * d * dist * dist);
	const h = /** @type {{base: number, thickness: number}} */ (heightFogOf(fog));
	const k = 1 / h.thickness;
	const h0 = Math.max(camY - h.base, 0);
	const h1 = Math.max(pointY - h.base, 0);
	const f = Math.abs(h1 - h0) > 1e-3 ? (Math.exp(-k * h0) - Math.exp(-k * h1)) / (k * (h1 - h0)) : Math.exp(-k * h0);
	return 1 - Math.exp(-d * dist * f);
}
