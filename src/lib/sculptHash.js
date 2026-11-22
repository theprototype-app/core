// 99 K6 (lane 99-live): the sculpt brush's spatial-hash helpers, loaded LAZILY by terrainSculpt.js
// (`sculptHashReady`) together with the kernel's SpatialHash — terrainSculpt is in the boot graph, these are not
// needed to draw a frame. The design notes live at terrainSculpt's "99 K6" section.
import { SpatialHash } from './meshKernel/spatialHash.js';

/** @typedef {{ hash: any, pos: Float64Array, cell: number, drift: number, cx: number, cy: number, cz: number, half: number }} BrushHash */

/** the caller's counters and rebuild policy (terrainSculpt owns them) */
let hashStats = { builds: 0, hashed: 0, scanned: 0 };
let policyOf = () => 'adaptive';
/** @param {{ builds: number, hashed: number, scanned: number }} stats @param {() => string} policy */
export function setup(stats, policy) {
	hashStats = stats;
	policyOf = policy;
}

/** a hash over `n` points of `pos` (x,y,z), with its bounding sphere-ish extent for the nearest search
 * @param {Float64Array} pos @param {number} n @param {number} cell @returns {BrushHash} */
export function buildBrushHash(pos, n, cell) {
	let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
	for (let i = 0; i < n * 3; i += 3) {
		const x = pos[i], y = pos[i + 1], z = pos[i + 2];
		if (x < x0) x0 = x;
		if (x > x1) x1 = x;
		if (y < y0) y0 = y;
		if (y > y1) y1 = y;
		if (z < z0) z0 = z;
		if (z > z1) z1 = z;
	}
	hashStats.builds++;
	return {
		hash: new SpatialHash(pos, { cellSize: cell, count: n }),
		pos,
		cell,
		drift: 0,
		cx: (x0 + x1) / 2,
		cy: (y0 + y1) / 2,
		cz: (z0 + z1) / 2,
		half: Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2
	};
}

/** may a hash built at `cell` serve a dab of `radius`? (a query window stays within the dedupe scratch)
 * @param {BrushHash | null} h @param {number} radius */
export function hashFits(h, radius) {
	return !!h && policyOf() !== 'dab' && radius <= h.cell * 2 && radius >= h.cell / 4 && (policyOf() === 'stroke' || h.drift <= h.cell / 2);
}

/** the query pad: a float sum may land a hair off the exact distance test the brush then applies */
export const pad = (/** @type {number} */ r) => r * (1 + 1e-9) + 1e-12;

/** candidate scratch, reused across dabs */
export let cand = new Int32Array(4096);
let mark = new Uint8Array(0);

/** Every index the hash finds within `r` of (x,y,z) into `cand`, ASCENDING (the linear scan's visiting order).
 * Returns the count. @param {BrushHash} h @param {number} n @param {number} x @param {number} y @param {number} z @param {number} r */
export function ascendingWithin(h, n, x, y, z, r) {
	let count = 0;
	h.hash.query(x, y, z, r, (/** @type {number} */ i) => {
		if (count === cand.length) {
			const grown = new Int32Array(cand.length * 2);
			grown.set(cand);
			cand = grown;
		}
		cand[count++] = i;
	});
	if (count * 8 > n) {
		// a dense window: one flag sweep beats a sort
		if (mark.length < n) mark = new Uint8Array(n);
		for (let k = 0; k < count; k++) mark[cand[k]] = 1;
		let w = 0;
		for (let i = 0; i < n; i++)
			if (mark[i]) {
				mark[i] = 0;
				cand[w++] = i;
			}
	} else cand.subarray(0, count).sort();
	return count;
}

/** The index nearest (x,y,z) by the caller's exact `dist`, ties to the LOWEST index — the linear scan's answer —
 * through widening hash queries padded by the drift; -1 when there is none.
 * @param {BrushHash} h @param {number} x @param {number} y @param {number} z @param {number} start
 * @param {(i: number) => number} dist */
export function nearestVia(h, x, y, z, start, dist) {
	const bound = Math.hypot(x - h.cx, y - h.cy, z - h.cz) + h.half + h.drift;
	if (!Number.isFinite(bound)) {
		// a non-finite point or centre: no window is safe to widen — the linear scan's own answer
		let best = -1;
		let bestD = Infinity;
		for (let i = 0; i < h.hash.size; i++) {
			const d = dist(i);
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		}
		return best;
	}
	for (let r = Math.max(start, h.cell / 4, 1e-9); ; r *= 4) {
		let best = -1;
		let bestD = Infinity;
		h.hash.query(x, y, z, pad(r) + h.drift, (/** @type {number} */ i) => {
			const d = dist(i);
			if (d < bestD || (d === bestD && i < best)) {
				bestD = d;
				best = i;
			}
		});
		// any point nearer than the best has a distance <= r too, so this window held it
		if ((best >= 0 && bestD <= r) || r > bound) return best;
	}
}

/** the columns as hash points (x, 0, z) @param {{x: number, z: number}[]} colPos */
export function columnXZ(colPos) {
	const xz = new Float64Array(colPos.length * 3);
	for (let i = 0; i < colPos.length; i++) {
		xz[i * 3] = colPos[i].x;
		xz[i * 3 + 2] = colPos[i].z;
	}
	return xz;
}

