// 98 P1 — the bake's ray tracer: a flat BVH over a triangle soup and first-hit / any-hit
// queries, in plain JS over typed arrays. ZERO IMPORTS, so the Worker carries no three.js
// and the unit layer runs it in node.
//
// TSL-portable (roadmap 2.0 rule): no GLSL anywhere in the bake. The tracer is logic in plain
// JS; a later WebGPU bake can replace it with a compute pass behind the same `traceFirst` /
// `occluded` shape without the caller changing.
//
// Triangles: Float32Array, 9 floats per triangle (a.xyz b.xyz c.xyz), in WORLD space.

const LEAF = 4;
const BINS = 12;

/**
 * @typedef {{
 *   tris: Float32Array, order: Uint32Array, count: number,
 *   bounds: Float32Array, kids: Int32Array, start: Uint32Array, size: Uint32Array, nodes: number
 * }} Bvh
 */

/**
 * Build a BVH (binned SAH, 12 bins; median split when every centroid shares a bin).
 * @param {Float32Array} tris @returns {Bvh}
 */
export function buildBvh(tris) {
	const count = Math.floor(tris.length / 9);
	const order = new Uint32Array(count);
	const cent = new Float32Array(count * 3);
	for (let i = 0; i < count; i++) {
		order[i] = i;
		const o = i * 9;
		cent[i * 3] = (tris[o] + tris[o + 3] + tris[o + 6]) / 3;
		cent[i * 3 + 1] = (tris[o + 1] + tris[o + 4] + tris[o + 7]) / 3;
		cent[i * 3 + 2] = (tris[o + 2] + tris[o + 5] + tris[o + 8]) / 3;
	}
	const maxNodes = Math.max(1, count * 2);
	const bounds = new Float32Array(maxNodes * 6);
	const kids = new Int32Array(maxNodes).fill(-1); // left child; right = left + 1
	const start = new Uint32Array(maxNodes);
	const size = new Uint32Array(maxNodes);
	let nodes = 1;
	start[0] = 0;
	size[0] = count;
	const stack = [0];
	const binCount = new Uint32Array(BINS);
	const binBox = new Float32Array(BINS * 6);
	while (stack.length) {
		const node = /** @type {number} */ (stack.pop());
		const s = start[node];
		const n = size[node];
		// node bounds + centroid bounds
		let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
		let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
		for (let k = s; k < s + n; k++) {
			const t = order[k];
			const o = t * 9;
			for (let v = 0; v < 9; v += 3) {
				const px = tris[o + v], py = tris[o + v + 1], pz = tris[o + v + 2];
				if (px < x0) x0 = px; if (px > x1) x1 = px;
				if (py < y0) y0 = py; if (py > y1) y1 = py;
				if (pz < z0) z0 = pz; if (pz > z1) z1 = pz;
			}
			const cx = cent[t * 3], cy = cent[t * 3 + 1], cz = cent[t * 3 + 2];
			if (cx < cx0) cx0 = cx; if (cx > cx1) cx1 = cx;
			if (cy < cy0) cy0 = cy; if (cy > cy1) cy1 = cy;
			if (cz < cz0) cz0 = cz; if (cz > cz1) cz1 = cz;
		}
		const b = node * 6;
		bounds[b] = x0; bounds[b + 1] = y0; bounds[b + 2] = z0;
		bounds[b + 3] = x1; bounds[b + 4] = y1; bounds[b + 5] = z1;
		if (n <= LEAF) continue;
		const ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0;
		const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
		const lo = axis === 0 ? cx0 : axis === 1 ? cy0 : cz0;
		const extent = axis === 0 ? ex : axis === 1 ? ey : ez;
		let mid = -1;
		if (extent > 0) {
			// binned SAH along the widest centroid axis
			binCount.fill(0);
			for (let i = 0; i < BINS; i++) {
				binBox[i * 6] = binBox[i * 6 + 1] = binBox[i * 6 + 2] = Infinity;
				binBox[i * 6 + 3] = binBox[i * 6 + 4] = binBox[i * 6 + 5] = -Infinity;
			}
			const scale = BINS / extent;
			for (let k = s; k < s + n; k++) {
				const t = order[k];
				const bin = Math.min(BINS - 1, Math.floor((cent[t * 3 + axis] - lo) * scale));
				binCount[bin]++;
				const o = t * 9;
				const bb = bin * 6;
				for (let v = 0; v < 9; v += 3) {
					for (let a = 0; a < 3; a++) {
						const p = tris[o + v + a];
						if (p < binBox[bb + a]) binBox[bb + a] = p;
						if (p > binBox[bb + 3 + a]) binBox[bb + 3 + a] = p;
					}
				}
			}
			let best = Infinity;
			let bestSplit = -1;
			for (let split = 1; split < BINS; split++) {
				const cost = sideCost(binBox, binCount, 0, split) + sideCost(binBox, binCount, split, BINS);
				if (cost < best) {
					best = cost;
					bestSplit = split;
				}
			}
			if (bestSplit > 0) {
				// partition in place: bins < bestSplit to the left
				let i = s;
				let j = s + n - 1;
				while (i <= j) {
					const t = order[i];
					const bin = Math.min(BINS - 1, Math.floor((cent[t * 3 + axis] - lo) * scale));
					if (bin < bestSplit) i++;
					else {
						order[i] = order[j];
						order[j] = t;
						j--;
					}
				}
				mid = i;
			}
		}
		if (mid <= s || mid >= s + n) mid = s + (n >> 1); // degenerate: plain halves
		const left = nodes;
		nodes += 2;
		kids[node] = left;
		start[left] = s;
		size[left] = mid - s;
		start[left + 1] = mid;
		size[left + 1] = s + n - mid;
		stack.push(left, left + 1);
	}
	return { tris, order, count, bounds, kids, start, size, nodes };
}

/** @param {Float32Array} box @param {Uint32Array} counts @param {number} a @param {number} b */
function sideCost(box, counts, a, b) {
	let n = 0;
	let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
	for (let i = a; i < b; i++) {
		if (!counts[i]) continue;
		n += counts[i];
		const o = i * 6;
		if (box[o] < x0) x0 = box[o];
		if (box[o + 1] < y0) y0 = box[o + 1];
		if (box[o + 2] < z0) z0 = box[o + 2];
		if (box[o + 3] > x1) x1 = box[o + 3];
		if (box[o + 4] > y1) y1 = box[o + 4];
		if (box[o + 5] > z1) z1 = box[o + 5];
	}
	if (!n) return 0;
	const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
	return n * (dx * dy + dy * dz + dz * dx);
}

/** The last first-hit: distance and triangle index (no allocation per ray). */
export const hit = { t: Infinity, tri: -1 };

const EPS = 1e-7;
const STACK = new Int32Array(128);

/**
 * Nearest hit along o + d*t, t in (tMin, tMax). Writes `hit`; returns true on a hit.
 * Both faces count (a bake must see the back of a wall as a wall).
 * @param {Bvh} bvh @param {number} ox @param {number} oy @param {number} oz
 * @param {number} dx @param {number} dy @param {number} dz @param {number} tMax @param {boolean} [any] stop at the first hit
 */
export function traceFirst(bvh, ox, oy, oz, dx, dy, dz, tMax, any = false) {
	hit.t = tMax;
	hit.tri = -1;
	if (!bvh.count) return false;
	const { tris, order, bounds, kids, start, size } = bvh;
	const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
	let sp = 0;
	STACK[sp++] = 0;
	while (sp) {
		const node = STACK[--sp];
		const b = node * 6;
		// slab test
		let t0 = (bounds[b] - ox) * ix, t1 = (bounds[b + 3] - ox) * ix;
		let tmin = t0 < t1 ? t0 : t1, tmax = t0 < t1 ? t1 : t0;
		t0 = (bounds[b + 1] - oy) * iy;
		t1 = (bounds[b + 4] - oy) * iy;
		let a = t0 < t1 ? t0 : t1, c = t0 < t1 ? t1 : t0;
		if (a > tmin) tmin = a;
		if (c < tmax) tmax = c;
		t0 = (bounds[b + 2] - oz) * iz;
		t1 = (bounds[b + 5] - oz) * iz;
		a = t0 < t1 ? t0 : t1;
		c = t0 < t1 ? t1 : t0;
		if (a > tmin) tmin = a;
		if (c < tmax) tmax = c;
		if (tmax < 0 || tmin > tmax || tmin > hit.t) continue;
		const left = kids[node];
		if (left < 0) {
			const s = start[node];
			const e = s + size[node];
			for (let k = s; k < e; k++) {
				const tri = order[k];
				const o = tri * 9;
				// Möller–Trumbore
				const e1x = tris[o + 3] - tris[o], e1y = tris[o + 4] - tris[o + 1], e1z = tris[o + 5] - tris[o + 2];
				const e2x = tris[o + 6] - tris[o], e2y = tris[o + 7] - tris[o + 1], e2z = tris[o + 8] - tris[o + 2];
				const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
				const det = e1x * px + e1y * py + e1z * pz;
				if (det > -EPS && det < EPS) continue;
				const inv = 1 / det;
				const tx = ox - tris[o], ty = oy - tris[o + 1], tz = oz - tris[o + 2];
				const u = (tx * px + ty * py + tz * pz) * inv;
				if (u < 0 || u > 1) continue;
				const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
				const v = (dx * qx + dy * qy + dz * qz) * inv;
				if (v < 0 || u + v > 1) continue;
				const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
				if (t > EPS && t < hit.t) {
					hit.t = t;
					hit.tri = tri;
					if (any) return true;
				}
			}
		} else if (sp < STACK.length - 2) {
			STACK[sp++] = left;
			STACK[sp++] = left + 1;
		}
	}
	return hit.tri >= 0;
}

/** Any hit before tMax (shadow rays). @param {Bvh} bvh @param {number} ox @param {number} oy @param {number} oz @param {number} dx @param {number} dy @param {number} dz @param {number} tMax */
export function occluded(bvh, ox, oy, oz, dx, dy, dz, tMax) {
	return traceFirst(bvh, ox, oy, oz, dx, dy, dz, tMax, true);
}

/** Face normal of a triangle (unit), into `out`. @param {Float32Array} tris @param {number} tri @param {Float32Array | number[]} out */
export function faceNormal(tris, tri, out) {
	const o = tri * 9;
	const e1x = tris[o + 3] - tris[o], e1y = tris[o + 4] - tris[o + 1], e1z = tris[o + 5] - tris[o + 2];
	const e2x = tris[o + 6] - tris[o], e2y = tris[o + 7] - tris[o + 1], e2z = tris[o + 8] - tris[o + 2];
	let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
	const len = Math.hypot(nx, ny, nz) || 1;
	out[0] = nx / len;
	out[1] = ny / len;
	out[2] = nz / len;
	return out;
}
