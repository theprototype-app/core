// 36-fb-water F12: the scene GROUND with holes where water goes below it.
//
// THE BUG. The scene ground (Configure Scene ▸ Physics ▸ Ground, on by default at y = 0) is
// one 1000 m slab. A pool sunk into the ground (Pool party: surface at 0, floor at -1.7) had
// that slab as an invisible LID at its surface: toys "floated" because they lay on the lid,
// and a body placed under the water rose until it hit the lid's underside and stuck there.
//
// THE FIX. Every water volume whose water reaches below the ground height cuts its world
// footprint out of the slab (axis-aligned rectangle subtraction: the remaining area as a few
// strips), and a tank or pool (box/cylinder — they have a bottom) gets a floor slab at its
// own bottom in that hole, so a heavy body still comes to rest inside it even when the pool
// was built without a floor collider. An ocean (plane: no bottom) gets no floor — its seabed
// or the out-of-bounds rule catches what sinks.
//
// A LEAF: imports nothing, pure maths over plain data, so it is a vitest unit. A rotated
// volume cuts its world AABB (a little more than its footprint).

export const GROUND_HALF = 500;
export const GROUND_THICK = 0.2;

/**
 * @typedef {{minX: number, maxX: number, minZ: number, maxZ: number, floorY: number | null}} GroundHole
 * @typedef {{cx: number, cz: number, hx: number, hz: number, top: number}} GroundSlab
 */

/** @param {ArrayLike<number>} m column-major 4x4 @param {number} x @param {number} y @param {number} z */
function apply(m, x, y, z) {
	return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

/**
 * The holes a set of W1 volumes cut into a ground at `height` (world AABB of each volume
 * from its local bounds + matrixWorld). A volume cuts only when its water reaches below the
 * ground: a raised tank standing on the ground leaves the ground whole.
 * @param {{shape: string, bounds: any, level: number, object: {matrixWorld: {elements: ArrayLike<number>}}}[]} volumes
 * @param {number} height
 * @returns {GroundHole[]}
 */
export function waterHoles(volumes, height) {
	/** @type {GroundHole[]} */
	const out = [];
	for (const v of volumes ?? []) {
		const m = v?.object?.matrixWorld?.elements;
		const b = v?.bounds;
		if (!m || !b) continue;
		const top = Number.isFinite(v.level) ? v.level : b.maxY;
		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
		for (let i = 0; i < 8; i++) {
			const p = apply(m, i & 1 ? b.maxX : b.minX, i & 2 ? top : b.minY, i & 4 ? b.maxZ : b.minZ);
			minX = Math.min(minX, p[0]);
			maxX = Math.max(maxX, p[0]);
			minY = Math.min(minY, p[1]);
			maxY = Math.max(maxY, p[1]);
			minZ = Math.min(minZ, p[2]);
			maxZ = Math.max(maxZ, p[2]);
		}
		const open = v.shape === 'plane';
		// the water must go below the ground (an ocean is bottomless) and not lie wholly
		// buried under it (a lid over a buried tank is the author's choice, leave it)
		if (!open && minY >= height - 1e-3) continue;
		if (maxY < height - GROUND_THICK) continue;
		if (!(maxX > minX && maxZ > minZ)) continue;
		out.push({ minX, maxX, minZ, maxZ, floorY: open ? null : minY });
	}
	return out;
}

/**
 * The ground as slabs: the [-GROUND_HALF, GROUND_HALF]² square at `height` minus every hole
 * (grid of the holes' edges → covered cells merged into strips), plus a floor slab per hole
 * that has a bottom. No holes → the one classic slab.
 * @param {number} height top face of the ground
 * @param {GroundHole[]} holes
 * @returns {GroundSlab[]}
 */
export function groundSlabs(height, holes) {
	const H = GROUND_HALF;
	const clampC = (/** @type {number} */ x) => Math.max(-H, Math.min(H, x));
	const cut = (holes ?? [])
		.map((h) => ({ ...h, minX: clampC(h.minX), maxX: clampC(h.maxX), minZ: clampC(h.minZ), maxZ: clampC(h.maxZ) }))
		.filter((h) => h.maxX - h.minX > 1e-4 && h.maxZ - h.minZ > 1e-4);
	if (!cut.length) return [{ cx: 0, cz: 0, hx: H, hz: H, top: height }];
	const uniq = (/** @type {number[]} */ a) => [...new Set(a)].sort((p, q) => p - q);
	const xs = uniq([-H, H, ...cut.flatMap((h) => [h.minX, h.maxX])]);
	const zs = uniq([-H, H, ...cut.flatMap((h) => [h.minZ, h.maxZ])]);
	const inHole = (/** @type {number} */ x, /** @type {number} */ z) =>
		cut.some((h) => x > h.minX && x < h.maxX && z > h.minZ && z < h.maxZ);
	// per row of cells: runs of solid cells along x; then rows with identical runs merge
	/** @type {{x0: number, x1: number, z0: number, z1: number}[]} */
	let open = [];
	/** @type {GroundSlab[]} */
	const out = [];
	const flush = (/** @type {{x0: number, x1: number, z0: number, z1: number}} */ r) =>
		out.push({ cx: (r.x0 + r.x1) / 2, cz: (r.z0 + r.z1) / 2, hx: (r.x1 - r.x0) / 2, hz: (r.z1 - r.z0) / 2, top: height });
	for (let j = 0; j + 1 < zs.length; j++) {
		const z0 = zs[j], z1 = zs[j + 1];
		const zc = (z0 + z1) / 2;
		/** @type {[number, number][]} */
		const runs = [];
		for (let i = 0; i + 1 < xs.length; i++) {
			if (inHole((xs[i] + xs[i + 1]) / 2, zc)) continue;
			const last = runs[runs.length - 1];
			if (last && last[1] === xs[i]) last[1] = xs[i + 1];
			else runs.push([xs[i], xs[i + 1]]);
		}
		/** @type {typeof open} */
		const next = [];
		for (const [x0, x1] of runs) {
			const k = open.findIndex((r) => r.x0 === x0 && r.x1 === x1 && r.z1 === z0);
			if (k >= 0) {
				const r = open.splice(k, 1)[0];
				r.z1 = z1;
				next.push(r);
			} else next.push({ x0, x1, z0, z1 });
		}
		open.forEach(flush);
		open = next;
	}
	open.forEach(flush);
	for (const h of cut)
		if (h.floorY != null && h.floorY < height)
			out.push({ cx: (h.minX + h.maxX) / 2, cz: (h.minZ + h.maxZ) / 2, hx: (h.maxX - h.minX) / 2, hz: (h.maxZ - h.minZ) / 2, top: h.floorY });
	return out;
}

/** a stable key for "did the holes change" (rebuild only then) @param {GroundHole[]} holes */
export function holesKey(holes) {
	return holes.map((h) => [h.minX, h.maxX, h.minZ, h.maxZ, h.floorY].map((n) => (n == null ? 'n' : n.toFixed(3))).join(',')).join(';');
}
