// 31-perf P2 — THE LOD RULE. PURE and import-free: which level a mesh draws at a given
// distance, which simplified levels are worth building for a mesh of N triangles, and how
// the adaptive quality level leans on both. The runtime (`lod.js`) owns the geometry, the
// worker and the render-time swap; this file is only arithmetic, so vitest drives every
// threshold with invented numbers.
//
// DISTANCE IS MEASURED IN RADII. A level switches at `distance / radius > d[i]`, where the
// radius is the mesh's WORLD bounding sphere: a 1 m enemy and a 20 m statue both keep full
// detail while they fill the same share of the view, which is what a triangle budget cares
// about. (Screen-projected size would add the FOV; a headset's ~100 degree eye and the
// desktop's 40-50 degree lens differ by ~2x, which the quality bias covers in practice.)
//
// HYSTERESIS: a mesh standing on a switch distance would flip every frame as a head bobs —
// a visible pop each time. Going DOWN a level (coarser) needs the distance past the edge;
// coming back UP needs it back inside the edge by `hysteresis` of it.

/** @typedef {{ratios: number[], distances: number[], minTriangles: number, hysteresis: number, floorTriangles: number}} LodOptions */

/** @type {LodOptions} */
export const DEFAULT_LOD = Object.freeze({
	/** share of the source triangles each coarser level keeps */
	ratios: [0.5, 0.25, 0.1],
	/** distance / world radius at which level i+1 takes over from level i */
	distances: [8, 20, 50],
	/** auto LOD only considers a mesh at least this dense (explicit `api.lod` passes its own) */
	minTriangles: 3000,
	/** a level must come back inside its edge by this share of it before detail returns */
	hysteresis: 0.12,
	/** no level is built below this many triangles — past it a silhouette falls apart */
	floorTriangles: 120
});

/** The minimum an EXPLICIT `api.lod(object)` asks of a mesh: the module said so, but a
 * 12-triangle box has nothing to take away. */
export const EXPLICIT_MIN_TRIANGLES = 300;

/**
 * Normalise caller options onto the defaults: finite, positive, strictly decreasing ratios
 * and strictly increasing distances, the two arrays trimmed to the same length.
 * @param {Partial<LodOptions>} [opts] @returns {LodOptions}
 */
export function normalizeLodOptions(opts = {}) {
	const ratios = (Array.isArray(opts.ratios) ? opts.ratios : DEFAULT_LOD.ratios)
		.map(Number)
		.filter((r) => Number.isFinite(r) && r > 0 && r < 1);
	const distances = (Array.isArray(opts.distances) ? opts.distances : DEFAULT_LOD.distances)
		.map(Number)
		.filter((d) => Number.isFinite(d) && d > 0);
	/** @type {number[]} */
	const r = [];
	for (const v of ratios) if (!r.length || v < r[r.length - 1]) r.push(v);
	/** @type {number[]} */
	const d = [];
	for (const v of distances) if (!d.length || v > d[d.length - 1]) d.push(v);
	// a level with no distance can never be chosen; a distance with no level has nothing to show
	const n = Math.min(r.length, d.length);
	const num = (/** @type {any} */ v, /** @type {number} */ fallback) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);
	return {
		ratios: r.slice(0, n),
		distances: d.slice(0, n),
		minTriangles: num(opts.minTriangles, DEFAULT_LOD.minTriangles),
		hysteresis: Math.min(0.5, num(opts.hysteresis, DEFAULT_LOD.hysteresis)),
		floorTriangles: num(opts.floorTriangles, DEFAULT_LOD.floorTriangles)
	};
}

/**
 * Which coarser levels to BUILD for a mesh of `triangles`: each kept ratio must leave at
 * least `floorTriangles` and be meaningfully coarser (<= 80%) than the level before it,
 * or the level costs memory and a pop for nothing. Returns the kept indices into
 * `opts.ratios` (so distances stay paired with their ratio).
 * @param {number} triangles @param {LodOptions} opts @returns {number[]}
 */
export function levelsToBuild(triangles, opts) {
	/** @type {number[]} */
	const keep = [];
	let previous = triangles;
	opts.ratios.forEach((ratio, i) => {
		const target = Math.floor(triangles * ratio);
		if (target < opts.floorTriangles) return;
		if (target > previous * 0.8) return;
		keep.push(i);
		previous = target;
	});
	return keep;
}

/**
 * The level to draw: 0 = the source, i = the i-th built level. `edges[i]` is where level
 * i+1 takes over (already paired to what was built), `bias` scales every edge (< 1 =
 * coarser sooner), `current` is last frame's pick for the hysteresis band.
 * @param {number} distance world distance camera -> mesh centre
 * @param {number} radius world bounding radius (> 0)
 * @param {number[]} edges ascending, in radii
 * @param {number} bias
 * @param {number} current
 * @param {number} hysteresis
 * @returns {number}
 */
export function pickLevel(distance, radius, edges, bias, current, hysteresis) {
	if (!edges.length || !(radius > 0) || !Number.isFinite(distance)) return 0;
	const x = distance / radius;
	const b = bias > 0 && Number.isFinite(bias) ? bias : 1;
	let level = 0;
	for (let i = 0; i < edges.length; i++) {
		const edge = edges[i] * b;
		// crossing to a coarser level needs the full edge; staying coarse holds until the
		// distance is back inside the edge by the band
		const threshold = current > i ? edge * (1 - hysteresis) : edge;
		if (x > threshold) level = i + 1;
		else break;
	}
	return level;
}

/**
 * How far the adaptive quality leans on LOD: 1 at full quality, and each governor step
 * pulls the switch distances in. A step taken for FILL (resolution) or DRAW CALLS
 * (shadows) is also a device that is struggling in general, so triangles go with them.
 * Clamped at 0.35 so the nearest object always keeps real detail.
 * @param {number} level the governor level (0 = full) @param {number} [extra] a caller's
 *   own multiplier (the per-game Quality setting) @returns {number}
 */
export function lodBiasFor(level, extra = 1) {
	const l = Math.max(0, Math.floor(Number(level) || 0));
	const e = Number.isFinite(Number(extra)) && Number(extra) > 0 ? Number(extra) : 1;
	return Math.max(0.35, Math.min(2, Math.pow(0.85, l) * e));
}

/**
 * A content signature for a geometry: two parses of the same asset (two placements of one
 * pack piece, a module that loads its GLB per enemy) share one set of levels. Counts plus a
 * strided sample of the position floats, FNV-1a over their bits — collisions would need the
 * same vertex count, index count and 64 sampled coordinates.
 * @param {ArrayLike<number>} positions @param {number} indexCount @returns {string}
 */
export function geometrySignature(positions, indexCount) {
	const n = positions.length;
	let h = 0x811c9dc5;
	const f = new Float32Array(1);
	const u = new Uint32Array(f.buffer);
	const step = Math.max(1, Math.floor(n / 64));
	for (let i = 0; i < n; i += step) {
		f[0] = positions[i];
		h ^= u[0];
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return n + ':' + indexCount + ':' + h.toString(36);
}
