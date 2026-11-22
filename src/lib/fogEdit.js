// 102b-papercuts: the EDITING half of fogModes.js (the boot keeps only what drawing a fog needs). Loaded by the
// lazy Fog kind rows and the unit tests.
import { fogKindOf, fogDensityOf, heightFogOf, FOG_DENSITY_DEFAULT, FOG_THICKNESS_DEFAULT } from './fogModes.js';

/** @typedef {import('./fogModes.js').FogKind} FogKind */

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
