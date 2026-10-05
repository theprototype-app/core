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

/**
 * 36-fb F23: the POOLS a Fluid emitter's particles form, as water for buoyancy — the tank's
 * idea with a surface that varies across the pool (`surfaceAt(x, z)`, null = dry there).
 * Published by fluidEmitterRuntime every solver frame; a separate list so the tank's
 * publisher (which replaces its whole list) and the emitter's never overwrite each other.
 * @type {{uuid: string, tank: true, pool: true, contains: (x: number, y: number, z: number) => boolean,
 *   surfaceAt: (x: number, z: number) => number | null, surfaceY: number, spec: {density: number, linearDrag: number, angularDrag: number}}[]}
 */
let poolVolumes = [];

/** @param {typeof poolVolumes} list */
export function setPoolVolumes(list) {
	poolVolumes = list;
}

/** a tank's flat surface or a pool's local one @param {any} t @param {number} x @param {number} z */
const surfaceOfVolume = (t, x, z) => (t.surfaceAt ? t.surfaceAt(x, z) : t.surfaceY);
/** @type {any} */ let lastRoot = null;
const point = { x: 0, y: 0, z: 0 };
const opts = { volumes: /** @type {any[]} */ ([]) };
const one = { volumes: /** @type {any[]} */ ([]) };
/** @type {import('./buoyancy.js').WaterHit} */
const hitOut = { surfaceY: 0, flow: null, density: 1000, linearDrag: 1.5, angularDrag: 1, volume: null };

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
	return frameVolumes.length > 0 || tankVolumes.length > 0 || poolVolumes.length > 0;
}

/** is there any water this frame (after beginWaterFrame) */
export function waterActive() {
	return frameVolumes.length > 0 || tankVolumes.length > 0 || poolVolumes.length > 0;
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
		for (const t of poolVolumes.length ? [...tankVolumes, ...poolVolumes] : tankVolumes) {
			const sy = surfaceOfVolume(t, x, z);
			if (sy == null || y > sy || !t.contains(x, y, z)) continue;
			hitOut.surfaceY = sy;
			hitOut.flow = null;
			hitOut.density = t.spec.density;
			hitOut.linearDrag = t.spec.linearDrag;
			hitOut.angularDrag = t.spec.angularDrag;
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
	for (const t of poolVolumes.length ? [...tankVolumes, ...poolVolumes] : tankVolumes) {
		const sy = surfaceOfVolume(t, x, z);
		if (sy != null && t.contains(x, Math.min(y, sy - 0.01), z) && (!best || sy > best.surfaceY)) best = { surfaceY: sy, volume: t };
	}
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
	poolVolumes = [];
	lastRoot = null;
}
