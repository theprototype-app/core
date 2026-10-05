// 36-water — contracts W1 (water volumes) + W2 (surface disturbances).
//
// W1: an object is water iff `userData.water` holds a water blob (plain JSON — it replicates
// through the normal objectParameters path and rides GLTF extras / sessions / autosave like
// userData.physics; NO new message type). This module is the ONE reader everybody shares:
// the renderer (waterRuntime), buoyancy (36-sim), colliders (36-colliders) and modules
// (`api.water.*`). It imports NOTHING (unit layer, workers, the headless sim) and duck-types
// the scene: any object with `uuid`, `userData`, `matrixWorld.elements` and a geometry (or
// child meshes) works — a three.js Object3D or a plain stand-in in a test.
//
//   import { waterVolumes } from '$lib/water/volumes.js';
//   waterVolumes.setRoot(objectsGroup);          // the app does this once (Scene)
//   waterVolumes.list()                          // → Volume[]
//   waterVolumes.query({x, y, z})                // → {volume, depth, surfaceY, flow} | null
//   const off = waterVolumes.onChange((list) => …)  // set / spec changed; off() unsubscribes
//   waterVolumes.disturb(volume, point, radius, strength)   // W2, local visual only
//
// Blob (version 1):
//   { version: 1, shape: 'box'|'plane'|'cylinder',
//     level,        // m, LOCAL Y of the still surface; null/absent = top of the bounds
//     density,      // kg/m³ (fresh water 1000)
//     linearDrag, angularDrag,   // per-second damping a body feels while submerged
//     flow: [x,y,z],// m/s in the volume's LOCAL frame (query returns it in world space)
//     preset,       // id of the preset it came from ('pool', 'ocean', … or 'user:<name>')
//     look: {…}, waves: {…}, bubbles: {…} }   // render params (presets.js / waves.js)
//
// Shapes, all in the object's local frame, footprint from its local bounds:
//   box      — x/z rectangle, from the bottom of the bounds up to `level`
//   cylinder — x/z ellipse inscribed in the bounds, bottom of the bounds up to `level`
//   plane    — x/z rectangle with NO bottom (an ocean: depth grows without limit)
// Keep water upright: the surface is the local level plane, so a tilted volume tilts it.
//
// Waves: `query` lifts surfaceY by the Gerstner height at that x/z and the clock time
// (`setClock`), so a floating body bobs with what every peer renders. Pass {flat: true}
// for the still level. Ripples (W2) are NOT in the query — they are each peer's own visual.

import { waveComponents, waveHeightAt } from './waves.js';

export const WATER_VERSION = 1;
export const WATER_SHAPES = ['box', 'plane', 'cylinder'];

/** Physics defaults of a blob (render defaults live with the presets). */
export const WATER_PHYSICS_DEFAULTS = Object.freeze({
	density: 1000,
	linearDrag: 1.5,
	angularDrag: 1,
	// 36-fb-water F12: how hard a floating body's up-and-down bob is damped (x the drag);
	// 4 = the 36-sim tuning (a crate near critical damping), lower = it bobs longer
	heaveDrag: 4,
	flow: Object.freeze([0, 0, 0])
});

/** @param {any} v @param {number} d */
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** @param {any} v */
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Is this a water blob (anything with an object-shaped userData.water)? @param {any} w */
export function isWaterBlob(w) {
	return !!w && typeof w === 'object' && !Array.isArray(w);
}

/**
 * A full, clamped copy of a blob — what every reader should consume. Unknown keys under
 * look/waves/bubbles pass through (forward compatible); top-level physics fields are typed.
 * @param {any} raw
 */
export function normalizeWater(raw) {
	const w = obj(raw);
	const flow = Array.isArray(w.flow) ? w.flow : WATER_PHYSICS_DEFAULTS.flow;
	return {
		...w,
		version: WATER_VERSION,
		shape: WATER_SHAPES.includes(w.shape) ? w.shape : 'box',
		level: typeof w.level === 'number' && Number.isFinite(w.level) ? w.level : null,
		density: Math.max(1, num(w.density, WATER_PHYSICS_DEFAULTS.density)),
		linearDrag: Math.max(0, num(w.linearDrag, WATER_PHYSICS_DEFAULTS.linearDrag)),
		angularDrag: Math.max(0, num(w.angularDrag, WATER_PHYSICS_DEFAULTS.angularDrag)),
		heaveDrag: Math.min(20, Math.max(0, num(w.heaveDrag, WATER_PHYSICS_DEFAULTS.heaveDrag))),
		flow: [num(flow[0], 0), num(flow[1], 0), num(flow[2], 0)],
		preset: typeof w.preset === 'string' ? w.preset : '',
		look: { ...obj(w.look) },
		waves: { ...obj(w.waves) },
		bubbles: { ...obj(w.bubbles) }
	};
}

// ── small matrix helpers (three's column-major Matrix4.elements layout) ──────────────

/** @param {ArrayLike<number>} m @param {number} x @param {number} y @param {number} z */
function applyM(m, x, y, z) {
	return [
		m[0] * x + m[4] * y + m[8] * z + m[12],
		m[1] * x + m[5] * y + m[9] * z + m[13],
		m[2] * x + m[6] * y + m[10] * z + m[14]
	];
}

/** Inverse of an affine column-major 4×4 (null when singular). @param {ArrayLike<number>} m */
export function invertAffine(m) {
	const a = m[0],
		b = m[4],
		c = m[8];
	const d = m[1],
		e = m[5],
		f = m[9];
	const g = m[2],
		h = m[6],
		i = m[10];
	const A = e * i - f * h;
	const B = -(d * i - f * g);
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	if (!det || !Number.isFinite(det)) return null;
	const r = 1 / det;
	const i00 = A * r,
		i01 = -(b * i - c * h) * r,
		i02 = (b * f - c * e) * r;
	const i10 = B * r,
		i11 = (a * i - c * g) * r,
		i12 = -(a * f - c * d) * r;
	const i20 = C * r,
		i21 = -(a * h - b * g) * r,
		i22 = (a * e - b * d) * r;
	const tx = m[12],
		ty = m[13],
		tz = m[14];
	return [
		i00,
		i10,
		i20,
		0,
		i01,
		i11,
		i21,
		0,
		i02,
		i12,
		i22,
		0,
		-(i00 * tx + i01 * ty + i02 * tz),
		-(i10 * tx + i11 * ty + i12 * tz),
		-(i20 * tx + i21 * ty + i22 * tz),
		1
	];
}

/** Identity when an object has no matrixWorld (a plain test stand-in). @param {any} o */
function worldElements(o) {
	return o?.matrixWorld?.elements ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

// ── local bounds ──────────────────────────────────────────────────────────────────────

/** @param {any} geometry */
function geometryBox(geometry) {
	if (!geometry) return null;
	if (!geometry.boundingBox && typeof geometry.computeBoundingBox === 'function')
		geometry.computeBoundingBox();
	const bb = geometry.boundingBox;
	if (bb) return [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z];
	const pos = geometry.attributes?.position?.array;
	if (!pos || pos.length < 3) return null;
	const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	for (let k = 0; k < pos.length; k += 3) grow(box, pos[k], pos[k + 1], pos[k + 2]);
	return box;
}

/** @param {number[]} box @param {number} x @param {number} y @param {number} z */
function grow(box, x, y, z) {
	if (x < box[0]) box[0] = x;
	if (y < box[1]) box[1] = y;
	if (z < box[2]) box[2] = z;
	if (x > box[3]) box[3] = x;
	if (y > box[4]) box[4] = y;
	if (z > box[5]) box[5] = z;
}

/**
 * The object's bounds in ITS OWN local frame: its geometry, else the union of its direct
 * children's geometry boxes through their local matrices (an imported model's group).
 * A unit cube when nothing has geometry. Renderer-only meshes tagged
 * `userData.__waterVisual` are skipped (the surface must not measure itself).
 * @param {any} o
 */
export function localBounds(o) {
	const own = geometryBox(o?.geometry);
	if (own) return own;
	const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	for (const child of o?.children ?? []) {
		if (child?.userData?.__waterVisual) continue;
		const cb = geometryBox(child.geometry);
		if (!cb) continue;
		const m = child.matrix?.elements ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
		for (let k = 0; k < 8; k++) {
			const p = applyM(m, k & 1 ? cb[3] : cb[0], k & 2 ? cb[4] : cb[1], k & 4 ? cb[5] : cb[2]);
			grow(box, p[0], p[1], p[2]);
		}
	}
	if (box[0] === Infinity) return [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5];
	return box;
}

// ── the registry ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   uuid: string, object: any, spec: ReturnType<typeof normalizeWater>, shape: string,
 *   bounds: {minX:number,minY:number,minZ:number,maxX:number,maxY:number,maxZ:number},
 *   level: number
 * }} Volume
 */

/** @type {any} */
let root = null;
/** @type {() => number} seconds on the shared clock */
let clock = () => 0;
/** @type {Set<(list: Volume[]) => void>} */
const listeners = new Set();
let lastSignature = '';
/** @type {Map<string, Volume>} */
const cache = new Map();
/** @type {Map<string, {x:number,z:number,radius:number,strength:number,t:number}[]>} */
const ripples = new Map();
/** @type {Map<string, {key:string, comps: ReturnType<typeof waveComponents>}>} */
const waveCache = new Map();

/** Most live ripples a volume keeps (the shader's uniform array size). */
export const MAX_RIPPLES = 16;
/** Seconds a ripple lives. */
export const RIPPLE_LIFE = 3;

/** @param {any} o @returns {Volume} */
function volumeFor(o) {
	const spec = normalizeWater(o.userData.water);
	const b = localBounds(o);
	const level = spec.level ?? b[4];
	const bounds = { minX: b[0], minY: b[1], minZ: b[2], maxX: b[3], maxY: b[4], maxZ: b[5] };
	let v = cache.get(o.uuid);
	if (!v || v.object !== o) {
		v = { uuid: o.uuid, object: o, spec, shape: spec.shape, bounds, level };
		cache.set(o.uuid, v);
	} else {
		v.spec = spec;
		v.shape = spec.shape;
		v.bounds = bounds;
		v.level = level;
	}
	return v;
}

/** @param {any} o @param {(o: any) => void} fn */
function walk(o, fn) {
	if (!o) return;
	fn(o);
	for (const c of o.children ?? []) walk(c, fn);
}

/** Every water volume under the root (fresh specs each call). @returns {Volume[]} */
function list() {
	/** @type {Volume[]} */
	const out = [];
	/** @type {Set<string>} */
	const seen = new Set();
	walk(root, (o) => {
		if (o === root || !isWaterBlob(o.userData?.water)) return;
		out.push(volumeFor(o));
		seen.add(o.uuid);
	});
	for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
	return out;
}

/** @param {Volume|any|string} v */
function resolve(v) {
	if (!v) return null;
	if (typeof v === 'string') return list().find((x) => x.uuid === v) ?? null;
	if (v.spec && v.object) return v;
	if (v.uuid && isWaterBlob(v.userData?.water)) return volumeFor(v);
	return null;
}

/** @param {Volume} v */
function comps(v) {
	const key = JSON.stringify(v.spec.waves ?? {});
	const hit = waveCache.get(v.uuid);
	if (hit && hit.key === key) return hit.comps;
	const c = waveComponents(v.spec.waves);
	waveCache.set(v.uuid, { key, comps: c });
	return c;
}

/** @param {any} p @returns {[number, number, number]} */
function xyz(p) {
	if (Array.isArray(p)) return [num(p[0], 0), num(p[1], 0), num(p[2], 0)];
	return [num(p?.x, 0), num(p?.y, 0), num(p?.z, 0)];
}

/** Is the local point inside the footprint (x/z) of the volume? @param {Volume} v @param {number} lx @param {number} lz */
function inFootprint(v, lx, lz) {
	const b = v.bounds;
	if (v.shape === 'cylinder') {
		const cx = (b.minX + b.maxX) / 2;
		const cz = (b.minZ + b.maxZ) / 2;
		const rx = (b.maxX - b.minX) / 2;
		const rz = (b.maxZ - b.minZ) / 2;
		if (rx <= 0 || rz <= 0) return false;
		const nx = (lx - cx) / rx;
		const nz = (lz - cz) / rz;
		return nx * nx + nz * nz <= 1;
	}
	return lx >= b.minX && lx <= b.maxX && lz >= b.minZ && lz <= b.maxZ;
}

/**
 * Still-surface world Y (+ waves unless flat) above a local x/z of the volume.
 * @param {Volume} v @param {number} lx @param {number} lz @param {boolean} flat @param {number} t
 */
function surfaceAt(v, lx, lz, flat, t) {
	const m = worldElements(v.object);
	const s = applyM(m, lx, v.level, lz);
	return flat ? s[1] : s[1] + waveHeightAt(comps(v), s[0], s[2], t);
}

/**
 * The volume containing a world point (the top-most surface when volumes overlap), or null.
 * @param {any} worldPoint {x,y,z} or [x,y,z]
 * @param {{flat?: boolean, time?: number, volumes?: Volume[]}} [opts]
 * @returns {{volume: Volume, depth: number, surfaceY: number, flow: [number, number, number]} | null}
 */
function query(worldPoint, opts = {}) {
	const [x, y, z] = xyz(worldPoint);
	const t = num(opts.time, clock());
	/** @type {any} */
	let best = null;
	for (const v of opts.volumes ?? list()) {
		const m = worldElements(v.object);
		const inv = invertAffine(m);
		if (!inv) continue;
		const [lx, ly, lz] = applyM(inv, x, y, z);
		if (!inFootprint(v, lx, lz)) continue;
		if (v.shape !== 'plane' && ly < v.bounds.minY) continue;
		const surfaceY = surfaceAt(v, lx, lz, !!opts.flat, t);
		if (y > surfaceY) continue;
		if (best && best.surfaceY >= surfaceY) continue;
		const f = v.spec.flow;
		// the flow is local: rotate (no translation) by the world matrix, undoing scale
		const sx = Math.hypot(m[0], m[1], m[2]) || 1;
		const sy = Math.hypot(m[4], m[5], m[6]) || 1;
		const sz = Math.hypot(m[8], m[9], m[10]) || 1;
		/** @type {[number, number, number]} */
		const flow = [
			(m[0] / sx) * f[0] + (m[4] / sy) * f[1] + (m[8] / sz) * f[2],
			(m[1] / sx) * f[0] + (m[5] / sy) * f[1] + (m[9] / sz) * f[2],
			(m[2] / sx) * f[0] + (m[6] / sy) * f[1] + (m[10] / sz) * f[2]
		];
		best = { volume: v, depth: surfaceY - y, surfaceY, flow };
	}
	return best;
}

/**
 * World Y of the (wavy unless flat) surface of `volume` above world x/z — ignores the
 * footprint (a renderer or a camera probe wants the plane even just outside).
 * @param {Volume|any|string} volume @param {number} x @param {number} z @param {{flat?: boolean, time?: number}} [opts]
 */
function surfaceY(volume, x, z, opts = {}) {
	const v = resolve(volume);
	if (!v) return null;
	const inv = invertAffine(worldElements(v.object));
	if (!inv) return null;
	const l = applyM(inv, x, 0, z);
	// re-solve local x/z on the surface plane (a non-upright volume shifts it)
	const s = applyM(inv, x, applyM(worldElements(v.object), l[0], v.level, l[2])[1], z);
	return surfaceAt(v, s[0], s[2], !!opts.flat, num(opts.time, clock()));
}

/** Volumes signature: uuids + specs + matrices (what a consumer would rebuild on). */
function signature(vols = list()) {
	return vols
		.map(
			(v) =>
				v.uuid +
				JSON.stringify(v.spec) +
				Array.from(worldElements(v.object), (n) => n.toFixed(4)).join(',')
		)
		.join('|');
}

/**
 * Re-read the scene and tell listeners when the volume set or any spec/transform changed.
 * The renderer calls it once per frame; a headless consumer calls it after edits.
 * @returns {boolean} changed
 */
function refresh() {
	const vols = list();
	const sig = signature(vols);
	if (sig === lastSignature) return false;
	lastSignature = sig;
	for (const fn of [...listeners]) {
		try {
			fn(vols);
		} catch (err) {
			console.warn('[water] onChange listener failed', err);
		}
	}
	return true;
}

/** Tell every listener now, changed or not (a consumer that just attached, or a test). */
function notify() {
	lastSignature = '\u0000'; // matches no real signature, the empty one included
	return refresh();
}

/** @param {(list: Volume[]) => void} fn @returns {() => void} unsubscribe */
function onChange(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/**
 * W2 — a local, visual-only ripple on `volume`'s surface at a world point. Each peer
 * renders its own ripples from its own (shared-physics) events; nothing is sent.
 * @param {Volume|any|string} volume @param {any} worldPoint @param {number} radius m @param {number} strength 0..1+
 * @returns {boolean} accepted
 */
function disturb(volume, worldPoint, radius = 0.3, strength = 0.5) {
	const v = resolve(volume);
	if (!v) return false;
	const [x, , z] = xyz(worldPoint);
	const t = clock();
	const list0 = (ripples.get(v.uuid) ?? []).filter((r) => t - r.t < RIPPLE_LIFE && t >= r.t);
	list0.push({
		x,
		z,
		radius: Math.max(0.01, num(radius, 0.3)),
		strength: Math.max(0, num(strength, 0.5)),
		t
	});
	while (list0.length > MAX_RIPPLES) list0.shift();
	ripples.set(v.uuid, list0);
	return true;
}

/** Live ripples of a volume (renderer feed). @param {Volume|any|string} volume */
function ripplesOf(volume) {
	const uuid = typeof volume === 'string' ? volume : volume?.uuid;
	const t = clock();
	const live = (ripples.get(uuid) ?? []).filter((r) => t - r.t < RIPPLE_LIFE && t >= r.t);
	if (live.length) ripples.set(uuid, live);
	else ripples.delete(uuid);
	return live;
}

/** The scene subtree that holds replicated objects (objectsGroup). @param {any} group */
function setRoot(group) {
	root = group;
	cache.clear();
}

/** Seconds on the shared clock (the app wires the flow tick clock). @param {() => number} fn */
function setClock(fn) {
	clock = typeof fn === 'function' ? fn : () => 0;
}

/** Test seam: drop all state. */
function reset() {
	root = null;
	clock = () => 0;
	listeners.clear();
	cache.clear();
	ripples.clear();
	waveCache.clear();
	lastSignature = '';
}

export const waterVolumes = {
	list,
	query,
	surfaceY,
	onChange,
	refresh,
	notify,
	disturb,
	ripplesOf,
	get: resolve,
	setRoot,
	setClock,
	now: () => clock(),
	reset
};
