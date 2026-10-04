// 36-sim: the ONE adapter between the simulation code and contract W1 (36-water's
// `waterVolumes`). Physics, splashes and the fluid tank ask HERE, so the W1 shape is
// read in one place: `query(worldPoint) -> {volume, depth, surfaceY, flow}` plus the
// volume's own `userData.water` (density, linearDrag, angularDrag).
//
// Until W1 is merged this is inert (no water anywhere) — every consumer is a no-op.

/** @type {any} */ let volumes = null;

/** @param {any} api W1's waterVolumes (list/query/onChange/disturb) */
export function setWaterVolumes(api) {
	volumes = api;
}

/** is there any water in the scene at all (the per-frame early-out) */
export function waterActive() {
	return !!volumes && volumes.list().length > 0;
}

/**
 * Buoyancy's query: the W1 hit flattened into what buoyancyStep reads.
 * @param {number} x @param {number} y @param {number} z
 * @returns {import('./buoyancy.js').WaterHit | null}
 */
export function queryWater(x, y, z) {
	return null;
}

/** W2: a local ripple (never replicated). @param {any} volume @param {number[]} point @param {number} radius @param {number} strength */
export function disturbWater(volume, point, radius, strength) {
	volumes?.disturb?.(volume, point, radius, strength);
}

/**
 * The surface above/below a point inside a volume's FOOTPRINT, whether the point is wet
 * or not (splashes need the surface while the body is still in the air).
 * @param {number} x @param {number} y @param {number} z
 * @returns {{surfaceY: number, volume: any} | null}
 */
export function waterSurfaceAt(x, y, z) {
	return null;
}
