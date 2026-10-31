// 51-surface (E2 + E3) — SCATTER ON ANY SURFACE, the pure half (imports only the pure set format,
// terrainScatterCore, for its per-slot draws; vitest-covered).
//
// A terrain's scatter is (x, z) over its rectangle with the height read off its grid. A rock,
// a sphere or a house has neither, so a mesh host samples its own TRIANGLES:
//
//   buildSurface(positions, index?, normals?)  the host's local-space triangles + an area CDF
//   placeOnSurface(S, u, v)                     two uniform draws -> a point + normal, uniform BY AREA
//                                               (u picks the triangle, u's remainder + v pick the
//                                               barycentric, so a slot's u/v mean the same thing as
//                                               a terrain slot's u/v: where in the whole surface)
//   generateSurfaceSlots(gen, S, opts)          FILL: count or density over the whole surface,
//                                               masks, minimum spacing — deterministic from the
//                                               slot draws (the seed lives with the caller)
//   surfaceDab(existing, S, index, o)           the BRUSH: fill a sphere around the hit up to the
//                                               density, honouring what is already there
//   encode/decodeSurfaceRecords                 a painted instance as 16 bytes
//
// EVERYTHING IS IN THE HOST'S LOCAL FRAME — positions, normals, the height mask, the slope mask
// ("up" = local +Y). That is what "instances are stored relative to the host" means: move, turn or
// scale the object and they ride with it (the render holder copies its matrixWorld), and nothing a
// transform does can reshuffle a fill, because the masks never saw the transform.
//
// SPACING is Poisson-disk by DART THROWING in slot order: a candidate closer than `spacing` (3D) to
// an instance already accepted is rejected. Slot order is fixed by the draws, so the result is the
// same on every peer and after every reload.

import { slotDraws, slotSeed, pickSource, ATTEMPTS_PER_SLOT } from './terrainScatterCore.js';

const TAU = Math.PI * 2;
const Q = 65535;
const DEG = 180 / Math.PI;

/** caps the core enforces whatever the caller asks (the terrain core's numbers) */
export const SURFACE_MAX_INSTANCES = 8000;
/** COUNT mode keeps drawing slots until `count` are placed, up to this many attempts per instance */
export const ATTEMPTS_PER_INSTANCE = ATTEMPTS_PER_SLOT;
export const SLOPE_MAX = 180;
export const SPACING_MAX = 50;
/** bytes per painted instance on a mesh host */
export const SURFACE_RECORD = 16;

/**
 * @typedef {{tris: number, v: Float32Array, n: Float32Array, vn: Float32Array | null,
 *   cdf: Float64Array, area: number, min: number[], max: number[]}} Surface
 * @typedef {{x: number, y: number, z: number, nx: number, ny: number, nz: number}} SurfacePoint
 * @typedef {{id?: string, slot?: number, x: number, y: number, z: number, nx: number, ny: number, nz: number,
 *   yaw: number, scale: number, src?: number, tint?: number}} SurfaceInstance
 * @typedef {{slope?: number[], height?: number[], layer?: {i: number, min: number}}} Mask
 * @typedef {{u: number, v: number, yaw: number, scale: number, pick?: number, tint?: number}} Draws
 */

// ---- the surface -------------------------------------------------------------------------

/**
 * The host's triangles as flat arrays, an area CDF for area-uniform sampling and the local
 * bounds. Degenerate triangles get zero width in the CDF, so they are never drawn.
 * @param {ArrayLike<number>} pos xyz triples (local space)
 * @param {ArrayLike<number> | null} [index] triangle vertex indices (null = a triangle soup)
 * @param {ArrayLike<number> | null} [normals] per-vertex normals (smooth normals are interpolated;
 *   absent = each triangle's own face normal)
 * @returns {Surface | null} null for a surface with no area
 */
export function buildSurface(pos, index = null, normals = null) {
	const vertCount = Math.floor(pos.length / 3);
	const tris = Math.floor((index ? index.length : vertCount) / 3);
	if (!tris) return null;
	const v = new Float32Array(tris * 9);
	const n = new Float32Array(tris * 3);
	const vn = normals && normals.length >= vertCount * 3 ? new Float32Array(tris * 9) : null;
	const cdf = new Float64Array(tris);
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	let area = 0;
	for (let t = 0; t < tris; t++) {
		for (let c = 0; c < 3; c++) {
			const i = index ? index[t * 3 + c] : t * 3 + c;
			for (let a = 0; a < 3; a++) {
				const value = pos[i * 3 + a];
				v[t * 9 + c * 3 + a] = value;
				if (value < min[a]) min[a] = value;
				if (value > max[a]) max[a] = value;
				if (vn && normals) vn[t * 9 + c * 3 + a] = normals[i * 3 + a];
			}
		}
		const o = t * 9;
		const e1x = v[o + 3] - v[o], e1y = v[o + 4] - v[o + 1], e1z = v[o + 5] - v[o + 2];
		const e2x = v[o + 6] - v[o], e2y = v[o + 7] - v[o + 1], e2z = v[o + 8] - v[o + 2];
		const cx = e1y * e2z - e1z * e2y;
		const cy = e1z * e2x - e1x * e2z;
		const cz = e1x * e2y - e1y * e2x;
		const len = Math.hypot(cx, cy, cz);
		const a = Number.isFinite(len) ? len / 2 : 0;
		if (len > 0) {
			n[t * 3] = cx / len;
			n[t * 3 + 1] = cy / len;
			n[t * 3 + 2] = cz / len;
		} else n[t * 3 + 1] = 1;
		area += a;
		cdf[t] = area;
	}
	if (!(area > 0)) return null;
	return { tris, v, n, vn, cdf, area, min, max };
}

/** The triangle whose CDF interval holds `at` (binary search). @param {Float64Array} cdf @param {number} at */
function triangleAt(cdf, at) {
	let lo = 0;
	let hi = cdf.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (cdf[mid] <= at) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * A point on triangle `t` from its barycentric draws (r1, r2 uniform in [0, 1)) — uniform over the
 * triangle (the square-root warp). @param {Surface} S @param {number} t @param {number} r1 @param {number} r2
 * @returns {SurfacePoint & {tri: number}}
 */
export function pointOnTriangle(S, t, r1, r2) {
	const s = Math.sqrt(Math.min(1, Math.max(0, r1)));
	const b0 = 1 - s;
	const b1 = s * (1 - r2);
	const b2 = s * r2;
	const o = t * 9;
	const v = S.v;
	let nx = S.n[t * 3];
	let ny = S.n[t * 3 + 1];
	let nz = S.n[t * 3 + 2];
	if (S.vn) {
		const w = S.vn;
		const sx = w[o] * b0 + w[o + 3] * b1 + w[o + 6] * b2;
		const sy = w[o + 1] * b0 + w[o + 4] * b1 + w[o + 7] * b2;
		const sz = w[o + 2] * b0 + w[o + 5] * b1 + w[o + 8] * b2;
		const len = Math.hypot(sx, sy, sz);
		if (len > 1e-6) {
			nx = sx / len;
			ny = sy / len;
			nz = sz / len;
		}
	}
	return {
		x: v[o] * b0 + v[o + 3] * b1 + v[o + 6] * b2,
		y: v[o + 1] * b0 + v[o + 4] * b1 + v[o + 7] * b2,
		z: v[o + 2] * b0 + v[o + 5] * b1 + v[o + 8] * b2,
		nx,
		ny,
		nz,
		tri: t
	};
}

/**
 * Two uniform draws -> a point uniform over the whole surface BY AREA. `u` picks the triangle
 * through the CDF and its REMAINDER inside that triangle's interval is again uniform, so it serves
 * as the first barycentric draw; `v` is the second. @param {Surface} S @param {number} u @param {number} v
 */
export function placeOnSurface(S, u, v) {
	const at = Math.min(Math.max(u, 0), 1 - 1e-12) * S.area;
	const t = triangleAt(S.cdf, at);
	const start = t ? S.cdf[t - 1] : 0;
	const width = S.cdf[t] - start;
	const r1 = width > 0 ? (at - start) / width : 0.5;
	return pointOnTriangle(S, t, r1, v);
}

// ---- masks -------------------------------------------------------------------------------

/** @param {any} v @param {number} lo @param {number} hi */
function clampNum(v, lo, hi) {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : NaN;
}

/** @param {any} r @param {number} lo @param {number} hi @returns {number[] | null} */
function rangeOf(r, lo, hi) {
	if (!Array.isArray(r) || r.length < 2) return null;
	const a = clampNum(r[0], lo, hi);
	const b = clampNum(r[1], lo, hi);
	if (Number.isNaN(a) || Number.isNaN(b)) return null;
	return a <= b ? [a, b] : [b, a];
}

/**
 * The masks a set's generator carries (`gen.slope`, `gen.height`, `gen.layer`), validated. A mask
 * that lets everything through is DROPPED, so a default set writes no mask field at all.
 * slope = degrees between the surface normal and local up (0 flat, 90 a wall, 180 an underside);
 * height = local Y, metres; layer = a terrain paint layer 0..3 and the weight it must reach.
 * @param {any} gen @returns {Mask}
 */
export function maskOf(gen) {
	/** @type {Mask} */
	const out = {};
	const slope = rangeOf(gen?.slope, 0, SLOPE_MAX);
	if (slope && (slope[0] > 0 || slope[1] < SLOPE_MAX)) out.slope = slope;
	const height = rangeOf(gen?.height, -1e5, 1e5);
	if (height) out.height = height;
	const layer = gen?.layer;
	if (layer && typeof layer === 'object') {
		const i = Math.round(Number(layer.i));
		const min = clampNum(layer.min ?? 0.5, 0, 1);
		if (i >= 0 && i <= 3 && !Number.isNaN(min)) out.layer = { i, min };
	}
	return out;
}

/** @param {Mask} mask */
export function maskIsEmpty(mask) {
	return !mask.slope && !mask.height && !mask.layer;
}

/** Slope of a normal against local up, degrees. @param {number} ny the normal's Y (unit normal) */
export function slopeDeg(ny) {
	return Math.acos(Math.min(1, Math.max(-1, ny))) * DEG;
}

/**
 * Does a point pass the mask? `layerWeight(i)` reads the terrain paint weight of layer i at this
 * point (0..1); a host without paint has none, so a layer mask rejects everything there — which is
 * what the user asked for ("only on layer 2") on a surface that has no layer 2.
 * @param {Mask} mask @param {{y: number, ny: number}} p @param {((i: number) => number) | null} [layerWeight]
 */
export function passesMask(mask, p, layerWeight = null) {
	if (mask.slope) {
		const s = slopeDeg(p.ny);
		if (s < mask.slope[0] - 1e-9 || s > mask.slope[1] + 1e-9) return false;
	}
	if (mask.height && (p.y < mask.height[0] || p.y > mask.height[1])) return false;
	if (mask.layer) {
		const w = layerWeight ? layerWeight(mask.layer.i) : 0;
		if (!(w >= mask.layer.min)) return false;
	}
	return true;
}

/**
 * Splat weight of one layer at a local (x, z): the RGBA map the paint brush writes, sampled
 * bilinearly and normalized the way the shader blends it. @param {Uint8Array} bytes RGBA
 * @param {number} res @param {{minX: number, minZ: number, sizeX: number, sizeZ: number}} b
 * @param {number} x @param {number} z @param {number} i layer 0..3
 */
export function splatWeightAt(bytes, res, b, x, z, i) {
	const fx = Math.min(res - 1, Math.max(0, ((x - b.minX) / b.sizeX) * res - 0.5));
	const fz = Math.min(res - 1, Math.max(0, ((z - b.minZ) / b.sizeZ) * res - 0.5));
	const x0 = Math.floor(fx);
	const z0 = Math.floor(fz);
	const x1 = Math.min(res - 1, x0 + 1);
	const z1 = Math.min(res - 1, z0 + 1);
	const tx = fx - x0;
	const tz = fz - z0;
	const w = (/** @type {number} */ px, /** @type {number} */ pz) => {
		const o = (pz * res + px) * 4;
		const sum = bytes[o] + bytes[o + 1] + bytes[o + 2] + bytes[o + 3];
		return sum > 0 ? bytes[o + i] / sum : i === 0 ? 1 : 0;
	};
	const top = w(x0, z0) * (1 - tx) + w(x1, z0) * tx;
	const bottom = w(x0, z1) * (1 - tx) + w(x1, z1) * tx;
	return top * (1 - tz) + bottom * tz;
}

// ---- spacing (a 3D hash) ------------------------------------------------------------------

/** A spatial hash for the minimum-spacing test. 2D (y ignored) when `flat` — the terrain's
 * spacing is judged on the map, the way the brush always judged it. @param {number} spacing @param {boolean} [flat] */
export function spacingGrid(spacing, flat = false) {
	// numeric cell keys (a string key per probe was 80 % of a spaced 5,000 fill); a collision only
	// costs an extra distance test, never a wrong answer
	/** @type {Map<number, number[]>} xyz triples per cell */
	const cells = new Map();
	const s = spacing;
	const s2 = s * s;
	const key = (/** @type {number} */ i, /** @type {number} */ j, /** @type {number} */ k) =>
		(Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791)) & 0x3fffffff; // a small int: V8 keeps it a Smi
	return {
		/** @param {{x: number, y?: number, z: number}} p */
		free(p) {
			if (!(s > 0)) return true;
			const py = flat ? 0 : p.y ?? 0;
			const ci = Math.floor(p.x / s);
			const cj = Math.floor(py / s);
			const ck = Math.floor(p.z / s);
			const j0 = flat ? 0 : -1;
			const j1 = flat ? 0 : 1;
			for (let i = -1; i <= 1; i++)
				for (let j = j0; j <= j1; j++)
					for (let k = -1; k <= 1; k++) {
						const list = cells.get(key(ci + i, cj + j, ck + k));
						if (!list) continue;
						for (let q = 0; q < list.length; q += 3) {
							const dx = list[q] - p.x;
							const dy = list[q + 1] - py;
							const dz = list[q + 2] - p.z;
							if (dx * dx + dy * dy + dz * dz < s2) return false;
						}
					}
			return true;
		},
		/** @param {{x: number, y?: number, z: number}} p */
		add(p) {
			if (!(s > 0)) return;
			const py = flat ? 0 : p.y ?? 0;
			const k = key(Math.floor(p.x / s), Math.floor(py / s), Math.floor(p.z / s));
			const list = cells.get(k);
			if (list) list.push(p.x, py, p.z);
			else cells.set(k, [p.x, py, p.z]);
		}
	};
}

// ---- FILL ---------------------------------------------------------------------------------

/**
 * How many slots a fill draws, and when it stops. COUNT mode = keep drawing until `count` are
 * PLACED (a mask or the spacing rejects some), up to ATTEMPTS_PER_INSTANCE × count attempts.
 * DENSITY mode = density × area attempts: a mask that rejects a slot is exactly what keeps the
 * density right where the mask passes. @param {any} gen @param {number} area @param {number} room
 */
export function fillBudget(gen, area, room = SURFACE_MAX_INSTANCES) {
	const cap = Math.max(0, Math.min(room, SURFACE_MAX_INSTANCES));
	if (gen?.count != null) {
		const want = Math.max(0, Math.min(cap, Math.floor(Number(gen.count) || 0)));
		return { want, attempts: want * ATTEMPTS_PER_INSTANCE };
	}
	const attempts = Math.max(0, Math.floor((Number(gen?.density) || 0) * area));
	return { want: Math.min(cap, attempts), attempts };
}

/**
 * FILL a whole surface: one instance per slot that survives the mask and the spacing, slot k drawn
 * from `draws(k)` (the caller's seeded, per-slot stream — the same draws a terrain slot uses).
 * @param {any} gen {count | density, scaleMin, scaleMax, rot, spacing, slope, height, layer}
 * @param {Surface} S
 * @param {{draws: (k: number) => Draws, room?: number, layerWeight?: ((p: SurfacePoint, i: number) => number) | null,
 *   accept?: ((p: SurfacePoint, k: number) => boolean) | null}} opts
 * @returns {SurfaceInstance[]}
 */
export function generateSurfaceSlots(gen, S, opts) {
	if (!gen || !S) return [];
	const { want, attempts } = fillBudget(gen, S.area, opts.room);
	if (!want) return [];
	const mask = maskOf(gen);
	const spacing = Math.min(SPACING_MAX, Math.max(0, Number(gen.spacing) || 0));
	const grid = spacingGrid(spacing);
	const lo = Math.min(Number(gen.scaleMin ?? 1), Number(gen.scaleMax ?? 1));
	const hi = Math.max(Number(gen.scaleMin ?? 1), Number(gen.scaleMax ?? 1));
	const rot = gen.rot !== false;
	const lw = opts.layerWeight ?? null;
	/** @type {SurfaceInstance[]} */
	const out = [];
	for (let k = 0; k < attempts && out.length < want; k++) {
		const d = opts.draws(k);
		const p = placeOnSurface(S, d.u, d.v);
		if (!passesMask(mask, p, lw ? (i) => lw(p, i) : null)) continue;
		if (opts.accept && !opts.accept(p, k)) continue;
		if (!grid.free(p)) continue;
		grid.add(p);
		out.push({
			id: 'g' + k,
			slot: k,
			x: p.x,
			y: p.y,
			z: p.z,
			nx: p.nx,
			ny: p.ny,
			nz: p.nz,
			yaw: rot ? d.yaw * TAU : 0,
			scale: lo + (hi - lo) * d.scale,
			...(d.pick != null ? { pick: d.pick } : {}),
			...(d.tint != null ? { tint: d.tint * 2 - 1 } : {})
		});
	}
	return out;
}

// ---- the BRUSH on a surface ---------------------------------------------------------------

/**
 * A grid over the surface's triangles for brush queries: a triangle is listed in every cell its
 * bounding box touches. @param {Surface} S @param {number} [cells] cells along the longest side
 */
export function triangleIndex(S, cells = 48) {
	const size = Math.max(S.max[0] - S.min[0], S.max[1] - S.min[1], S.max[2] - S.min[2], 1e-6);
	const cell = size / cells;
	/** @type {Map<string, number[]>} */
	const map = new Map();
	const at = (/** @type {number} */ value, /** @type {number} */ a) => Math.floor((value - S.min[a]) / cell);
	for (let t = 0; t < S.tris; t++) {
		const o = t * 9;
		const lo = [0, 1, 2].map((a) => at(Math.min(S.v[o + a], S.v[o + 3 + a], S.v[o + 6 + a]), a));
		const hi = [0, 1, 2].map((a) => at(Math.max(S.v[o + a], S.v[o + 3 + a], S.v[o + 6 + a]), a));
		// a giant triangle (a ground plane) would list itself in thousands of cells: cap the spread
		// and let it sit in its corner cells only — the query still tests the triangle itself
		const spread = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
		const step = spread > 512 ? Math.ceil(Math.cbrt(spread / 512)) : 1;
		for (let i = lo[0]; i <= hi[0]; i += step)
			for (let j = lo[1]; j <= hi[1]; j += step)
				for (let k = lo[2]; k <= hi[2]; k += step) {
					const key = i + ',' + j + ',' + k;
					const list = map.get(key);
					if (list) list.push(t);
					else map.set(key, [t]);
				}
		if (step > 1) {
			const key = hi[0] + ',' + hi[1] + ',' + hi[2];
			const list = map.get(key);
			if (list) list.push(t);
			else map.set(key, [t]);
		}
	}
	return {
		cell,
		/** triangles that may come within `r` of a point @param {number[]} c @param {number} r */
		near(c, r) {
			/** @type {Set<number>} */
			const found = new Set();
			const lo = [0, 1, 2].map((a) => at(c[a] - r, a));
			const hi = [0, 1, 2].map((a) => at(c[a] + r, a));
			const big = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 4096;
			if (big) {
				for (let t = 0; t < S.tris; t++) found.add(t);
				return found;
			}
			for (let i = lo[0]; i <= hi[0]; i++)
				for (let j = lo[1]; j <= hi[1]; j++)
					for (let k = lo[2]; k <= hi[2]; k++) for (const t of map.get(i + ',' + j + ',' + k) ?? []) found.add(t);
			return found;
		}
	};
}

/** Squared distance from a point to triangle t (Ericson's closest-point). @param {Surface} S @param {number} t @param {number[]} p */
function distSqToTriangle(S, t, p) {
	const o = t * 9;
	const v = S.v;
	const ax = v[o], ay = v[o + 1], az = v[o + 2];
	const abx = v[o + 3] - ax, aby = v[o + 4] - ay, abz = v[o + 5] - az;
	const acx = v[o + 6] - ax, acy = v[o + 7] - ay, acz = v[o + 8] - az;
	const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
	const d1 = abx * apx + aby * apy + abz * apz;
	const d2 = acx * apx + acy * apy + acz * apz;
	/** @param {number} x @param {number} y @param {number} z */
	const at = (x, y, z) => (p[0] - x) ** 2 + (p[1] - y) ** 2 + (p[2] - z) ** 2;
	if (d1 <= 0 && d2 <= 0) return at(ax, ay, az);
	const bpx = p[0] - v[o + 3], bpy = p[1] - v[o + 4], bpz = p[2] - v[o + 5];
	const d3 = abx * bpx + aby * bpy + abz * bpz;
	const d4 = acx * bpx + acy * bpy + acz * bpz;
	if (d3 >= 0 && d4 <= d3) return at(v[o + 3], v[o + 4], v[o + 5]);
	const vc = d1 * d4 - d3 * d2;
	if (vc <= 0 && d1 >= 0 && d3 <= 0) {
		const w = d1 / (d1 - d3);
		return at(ax + abx * w, ay + aby * w, az + abz * w);
	}
	const cpx = p[0] - v[o + 6], cpy = p[1] - v[o + 7], cpz = p[2] - v[o + 8];
	const d5 = abx * cpx + aby * cpy + abz * cpz;
	const d6 = acx * cpx + acy * cpy + acz * cpz;
	if (d6 >= 0 && d5 <= d6) return at(v[o + 6], v[o + 7], v[o + 8]);
	const vb = d5 * d2 - d1 * d6;
	if (vb <= 0 && d2 >= 0 && d6 <= 0) {
		const w = d2 / (d2 - d6);
		return at(ax + acx * w, ay + acy * w, az + acz * w);
	}
	const va = d3 * d6 - d5 * d4;
	if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
		const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
		const bx = v[o + 3], by = v[o + 4], bz = v[o + 5];
		return at(bx + (v[o + 6] - bx) * w, by + (v[o + 7] - by) * w, bz + (v[o + 8] - bz) * w);
	}
	const denom = 1 / (va + vb + vc);
	const w2 = vb * denom;
	const w3 = vc * denom;
	return at(ax + abx * w2 + acx * w3, ay + aby * w2 + acy * w3, az + abz * w2 + acz * w3);
}

/**
 * One brush dab on a surface: add instances inside the SPHERE around the hit until it holds
 * `density × πr²` (the brush disc — on a surface that is roughly flat inside the brush that is the
 * patch's area, and it is the exact rule the terrain brush keeps), never more; what is already there
 * counts. Spacing = the set's minimum spacing, else 0.7 of the mean gap (the terrain brush's rule).
 * @param {SurfaceInstance[]} existing (read only)
 * @param {Surface} S @param {ReturnType<typeof triangleIndex>} index
 * @param {{cx: number, cy: number, cz: number, radius: number, density: number, scaleMin: number, scaleMax: number,
 *   randomRotation: boolean, rng: () => number, room?: number, spacing?: number, mask?: Mask}} o
 * @returns {SurfaceInstance[]} the NEW instances only
 */
export function surfaceDab(existing, S, index, o) {
	const r = o.radius;
	const density = Math.min(4, Math.max(0.01, o.density));
	const target = Math.floor(density * Math.PI * r * r);
	const spacing = o.spacing && o.spacing > 0 ? o.spacing : 0.7 / Math.sqrt(density);
	const c = [o.cx, o.cy, o.cz];
	const reach = r + spacing;
	const d2 = (/** @type {{x: number, y: number, z: number}} */ p) => (p.x - c[0]) ** 2 + (p.y - c[1]) ** 2 + (p.z - c[2]) ** 2;
	const near = existing.filter((p) => d2(p) <= reach * reach);
	let inside = near.filter((p) => d2(p) <= r * r).length;
	let want = Math.min(target - inside, o.room ?? Infinity);
	/** @type {SurfaceInstance[]} */
	const added = [];
	if (want <= 0) return added;
	// candidate triangles: those that come within r of the centre, with their areas as a local CDF
	const tris = [...index.near(c, r)].filter((t) => distSqToTriangle(S, t, c) <= r * r);
	if (!tris.length) return added;
	const cdf = new Float64Array(tris.length);
	let sum = 0;
	tris.forEach((t, k) => {
		sum += S.cdf[t] - (t ? S.cdf[t - 1] : 0);
		cdf[k] = sum;
	});
	if (!(sum > 0)) return added;
	const grid = spacingGrid(spacing);
	for (const p of near) grid.add(p);
	const lo = Math.min(o.scaleMin, o.scaleMax);
	const hi = Math.max(o.scaleMin, o.scaleMax);
	const mask = o.mask ?? {};
	let attempts = want * 12;
	while (want > 0 && attempts-- > 0) {
		const k = triangleAt(cdf, o.rng() * sum);
		const p = pointOnTriangle(S, tris[k], o.rng(), o.rng());
		if (d2(p) > r * r) continue;
		if (!passesMask(mask, p, null)) continue;
		if (!grid.free(p)) continue;
		grid.add(p);
		added.push({
			x: p.x,
			y: p.y,
			z: p.z,
			nx: p.nx,
			ny: p.ny,
			nz: p.nz,
			yaw: o.randomRotation ? o.rng() * TAU : 0,
			scale: Math.min(20, Math.max(0.05, lo + (hi - lo) * o.rng()))
		});
		inside++;
		want--;
	}
	return added;
}

/** Remove every instance inside the sphere. @param {SurfaceInstance[]} list
 * @param {number} cx @param {number} cy @param {number} cz @param {number} radius */
export function eraseInSphere(list, cx, cy, cz, radius) {
	const r2 = radius * radius;
	return list.filter((p) => (p.x - cx) ** 2 + (p.y - cy) ** 2 + (p.z - cz) ** 2 > r2);
}

// ---- the 16-byte record --------------------------------------------------------------------

/** @typedef {number[]} Box [minX, minY, minZ, sizeX, sizeY, sizeZ] */

/** A box that holds every instance and the surface (stored on the set, so a later mesh edit never
 * re-scales the records). @param {SurfaceInstance[]} list @param {{min: number[], max: number[]} | null} [S] @returns {Box} */
export function boxOf(list, S = null) {
	const min = S ? [...S.min] : [Infinity, Infinity, Infinity];
	const max = S ? [...S.max] : [-Infinity, -Infinity, -Infinity];
	for (const p of list) {
		const xyz = [p.x, p.y, p.z];
		for (let a = 0; a < 3; a++) {
			if (xyz[a] < min[a]) min[a] = xyz[a];
			if (xyz[a] > max[a]) max[a] = xyz[a];
		}
	}
	for (let a = 0; a < 3; a++) if (!Number.isFinite(min[a])) (min[a] = 0), (max[a] = 0);
	// a flat axis (a plane) still needs a size, or every record on it divides by zero
	return [min[0], min[1], min[2], ...[0, 1, 2].map((a) => Math.max(max[a] - min[a], 1e-3))];
}

/** @param {any} box @returns {Box | null} */
export function boxFrom(box) {
	if (!Array.isArray(box) || box.length !== 6 || !box.every((n) => Number.isFinite(n))) return null;
	if (!(box[3] > 0 && box[4] > 0 && box[5] > 0)) return null;
	return box.map(Number);
}

/** Octahedral normal encoding to two [0, 1] values. @param {number} x @param {number} y @param {number} z */
function octEncode(x, y, z) {
	const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
	let u = x / l1;
	let v = z / l1;
	if (y < 0) {
		const ou = u;
		u = (1 - Math.abs(v)) * (ou >= 0 ? 1 : -1);
		v = (1 - Math.abs(ou)) * (v >= 0 ? 1 : -1);
	}
	return [(u + 1) / 2, (v + 1) / 2];
}

/** @param {number} a @param {number} b [0, 1] each @returns {number[]} */
function octDecode(a, b) {
	let x = a * 2 - 1;
	let z = b * 2 - 1;
	const y = 1 - Math.abs(x) - Math.abs(z);
	if (y < 0) {
		const ox = x;
		x = (1 - Math.abs(z)) * (ox >= 0 ? 1 : -1);
		z = (1 - Math.abs(ox)) * (z >= 0 ? 1 : -1);
	}
	const len = Math.hypot(x, y, z) || 1;
	return [x / len, y / len, z / len];
}

const clampQ = (/** @type {number} */ n) => Math.max(0, Math.min(Q, Math.round(n)));

/**
 * A mesh host's painted instances as 16 bytes each: x, y, z (u16 across the box), the normal
 * (octahedral, 2 × u16), yaw (u16 over a full turn), scale (u16, thousandths), one u16 reserved.
 * 2,000 instances = 32 KB raw. @param {SurfaceInstance[]} list @param {Box} box @returns {Uint8Array}
 */
export function encodeSurfaceRecords(list, box) {
	const out = new Uint8Array(list.length * SURFACE_RECORD);
	const view = new DataView(out.buffer);
	list.forEach((p, k) => {
		const o = k * SURFACE_RECORD;
		view.setUint16(o, clampQ(((p.x - box[0]) / box[3]) * Q), true);
		view.setUint16(o + 2, clampQ(((p.y - box[1]) / box[4]) * Q), true);
		view.setUint16(o + 4, clampQ(((p.z - box[2]) / box[5]) * Q), true);
		const [a, b] = octEncode(p.nx, p.ny, p.nz);
		view.setUint16(o + 6, clampQ(a * Q), true);
		view.setUint16(o + 8, clampQ(b * Q), true);
		const yaw = ((p.yaw % TAU) + TAU) % TAU;
		view.setUint16(o + 10, clampQ((yaw / TAU) * Q), true);
		view.setUint16(o + 12, clampQ(p.scale * 1000), true);
		view.setUint16(o + 14, 0, true);
	});
	return out;
}

/** @param {Uint8Array} bytes @param {Box} box @returns {SurfaceInstance[]} */
export function decodeSurfaceRecords(bytes, box) {
	const n = Math.floor(bytes.length / SURFACE_RECORD);
	const view = new DataView(bytes.buffer, bytes.byteOffset, n * SURFACE_RECORD);
	/** @type {SurfaceInstance[]} */
	const out = new Array(n);
	for (let k = 0; k < n; k++) {
		const o = k * SURFACE_RECORD;
		const [nx, ny, nz] = octDecode(view.getUint16(o + 6, true) / Q, view.getUint16(o + 8, true) / Q);
		out[k] = {
			x: box[0] + (view.getUint16(o, true) / Q) * box[3],
			y: box[1] + (view.getUint16(o + 2, true) / Q) * box[4],
			z: box[2] + (view.getUint16(o + 4, true) / Q) * box[5],
			nx,
			ny,
			nz,
			yaw: (view.getUint16(o + 10, true) / Q) * TAU,
			scale: view.getUint16(o + 12, true) / 1000
		};
	}
	return out;
}

// ---- a mesh host's SET: its one instance list, its record codec ------------------------------

/** The 16-byte record codec a `host: 'mesh'` set's painted instances use (the `io.records` that
 * terrainScatterCore.withOverrides takes). */
export const surfaceRecords = {
	/** @param {Uint8Array} bytes @param {any} set */
	decode(bytes, set) {
		const box = boxFrom(set?.box);
		return box ? decodeSurfaceRecords(bytes, box) : [];
	},
	/** @param {SurfaceInstance[]} list */
	encode(list) {
		const box = boxOf(list);
		return { bytes: encodeSurfaceRecords(list, box), box };
	}
};

/** A painted record's tint draw: a hash of its quantized position (stable under erase, the same on
 * every peer). @param {DataView} view @param {number} o */
function recordTint(view, o) {
	const h = slotSeed(view.getUint32(o, true) ^ view.getUint16(o + 4, true), 0x51);
	return (h / 4294967296) * 2 - 1;
}

/**
 * EVERY instance a `host: 'mesh'` set draws — the surface twin of terrainScatterCore.instancesOf,
 * and the ONE list the renderer, the colliders, the brush and the edit tools read on a mesh: the
 * generated slots (the set's own seeded per-slot stream, so slot ids mean what they mean on a
 * terrain) with their hand edits applied, then the painted 16-byte records.
 * @param {any} set a normalized set @param {Surface | null} S the host's surface (null = no fill)
 * @param {(b64: string) => Uint8Array | null} decode
 * @param {{room?: number, accept?: ((p: SurfacePoint, k: number) => boolean) | null}} [opts]
 * @returns {(SurfaceInstance & {id: string, src: number, tint: number, index?: number})[]}
 */
export function surfaceInstancesOf(set, S, decode, opts = {}) {
	/** @type {any[]} */
	const out = [];
	if (set?.gen && S) {
		const seed = set.seed ?? 0;
		for (const inst of generateSurfaceSlots(set.gen, S, { draws: (k) => slotDraws(seed, k), room: opts.room, accept: opts.accept ?? null })) {
			const o = set.ov?.[String(inst.slot)];
			if (o?.del) continue;
			const { pick, ...rest } = /** @type {any} */ (inst);
			const base = { ...rest, src: pickSource(set.sources, pick ?? 0), tint: inst.tint ?? 0 };
			out.push(o ? { ...base, ...o } : base);
		}
	}
	const bytes = set?.count && set.data ? decode(set.data) : null;
	const box = boxFrom(set?.box);
	if (bytes && box) {
		const pick = set.pick ? decode(set.pick) : null;
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		decodeSurfaceRecords(bytes, box).forEach((inst, j) => {
			out.push({
				id: 'p' + j,
				index: j,
				...inst,
				src: pick && set.sources ? Math.min(pick[j] ?? 0, set.sources.length - 1) : 0,
				tint: recordTint(view, j * SURFACE_RECORD)
			});
		});
	}
	return out;
}
