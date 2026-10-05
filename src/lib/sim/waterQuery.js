// 36-sim: the ONE adapter between the simulation code and contract W1 (36-water's
// `waterVolumes`). Physics, splashes and the fluid tank ask HERE, so the W1 shape is
// read in one place: `query(worldPoint) -> {volume, depth, surfaceY, flow}` plus the
// volume's normalized `spec` (density, linearDrag, angularDrag).
//
// COST. `waterVolumes.query` walks the scene for its volume list unless it is handed
// one, and buoyancy asks ~27 times per body per substep. So the list is taken ONCE per
// frame (`beginWaterFrame`) and every query of that frame reuses it — and a scene with
// no water pays one walk per frame and nothing else.
import { waterVolumes } from '../water/volumes.js';

/** @type {any[]} */ let frameVolumes = [];
/**
 * FLUID TANKS as water (36-sim): each tank publishes its particles' surface, so a toy in a
 * tank floats through the SAME buoyancy model as one in a pool (fraction-aware, damped),
 * instead of being shoved by raw particle reactions (measured: ducks thrown out of the tank).
 * @type {{uuid: string, tank: true, contains: (x: number, y: number, z: number) => boolean,
 *   surfaceY: number, spec: {density: number, linearDrag: number, angularDrag: number}}[]}
 */
let tankVolumes = [];

/** fluidRuntime publishes its tanks every frame @param {typeof tankVolumes} list */
export function setTankVolumes(list) {
	tankVolumes = list;
}
/** @type {any} */ let lastRoot = null;
const point = { x: 0, y: 0, z: 0 };
const opts = { volumes: /** @type {any[]} */ ([]) };
const one = { volumes: /** @type {any[]} */ ([]) };
/** @type {import('./buoyancy.js').WaterHit} */
const hitOut = { surfaceY: 0, flow: null, density: 1000, linearDrag: 1.5, angularDrag: 1, heaveDrag: 4, volume: null };

/**
 * Point W1 at the scene objects group when nothing else has (36-water's app wiring does
 * the same; setting the same root twice is harmless). @param {any} root
 */
export function ensureWaterRoot(root) {
	if (!root || root === lastRoot) return;
	lastRoot = root;
	waterVolumes.setRoot(root);
}

/** Take this frame's volume list. @returns {boolean} any water at all */
export function beginWaterFrame() {
	frameVolumes = lastRoot ? waterVolumes.list() : [];
	opts.volumes = frameVolumes;
	return frameVolumes.length > 0 || tankVolumes.length > 0;
}

/** 36-fb-water F12: this frame's W1 volumes (after beginWaterFrame) — the ground cuts holes for them */
export function currentWaterVolumes() {
	return frameVolumes;
}

/** is there any water this frame (after beginWaterFrame) */
export function waterActive() {
	return frameVolumes.length > 0 || tankVolumes.length > 0;
}

/**
 * Buoyancy's query: the W1 hit flattened into what buoyancyStep reads. The returned
 * object is REUSED (read it before the next call).
 * @param {number} x @param {number} y @param {number} z
 * @returns {import('./buoyancy.js').WaterHit | null}
 */
export function queryWater(x, y, z) {
	const hit = frameVolumes.length ? ((point.x = x), (point.y = y), (point.z = z), waterVolumes.query(point, opts)) : null;
	if (!hit) {
		for (const t of tankVolumes) {
			if (y > t.surfaceY || !t.contains(x, y, z)) continue;
			hitOut.surfaceY = t.surfaceY;
			hitOut.flow = null;
			hitOut.density = t.spec.density;
			hitOut.linearDrag = t.spec.linearDrag;
			hitOut.angularDrag = t.spec.angularDrag;
			hitOut.heaveDrag = 4;
			hitOut.volume = t;
			return hitOut;
		}
		return null;
	}
	const spec = hit.volume.spec;
	hitOut.surfaceY = hit.surfaceY;
	hitOut.flow = hit.flow;
	hitOut.density = spec.density;
	hitOut.linearDrag = spec.linearDrag;
	hitOut.angularDrag = spec.angularDrag;
	hitOut.heaveDrag = spec.heaveDrag ?? 4;
	hitOut.volume = hit.volume;
	return hitOut;
}

/**
 * The surface above/below a point inside a volume's FOOTPRINT, whether the point is wet
 * or not (a splash needs the surface while the body is still in the air).
 * @param {number} x @param {number} y @param {number} z
 * @returns {{surfaceY: number, volume: any} | null}
 */
export function waterSurfaceAt(x, y, z) {
	/** @type {{surfaceY: number, volume: any} | null} */
	let best = null;
	for (const v of frameVolumes) {
		const sy = waterVolumes.surfaceY(v, x, z);
		if (sy == null) continue;
		// inside the footprint = a point just under that surface is wet in this volume
		point.x = x;
		point.y = sy - 0.01;
		point.z = z;
		one.volumes = [v];
		if (!waterVolumes.query(point, one)) continue;
		if (!best || sy > best.surfaceY) best = { surfaceY: sy, volume: v };
	}
	for (const t of tankVolumes)
		if (t.contains(x, Math.min(y, t.surfaceY - 0.01), z) && (!best || t.surfaceY > best.surfaceY)) best = { surfaceY: t.surfaceY, volume: t };
	return best;
}

/** W2: a local ripple (never replicated). @param {any} volume @param {number[]} at @param {number} radius @param {number} strength */
export function disturbWater(volume, at, radius, strength) {
	if (volume?.tank) return false; // a tank's splash is its particles
	return waterVolumes.disturb(volume, at, radius, strength);
}

/** TEST: forget the root and the frame */
export function resetWaterQuery() {
	frameVolumes = [];
	opts.volumes = [];
	tankVolumes = [];
	lastRoot = null;
}
