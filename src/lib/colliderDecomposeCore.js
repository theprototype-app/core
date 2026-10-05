// 36 X3: automatic convex decomposition (V-HACD) for CUSTOM colliders — the arithmetic,
// imports NOTHING. The worker (vhacdWorker.js) and the unit suite run exactly this; the
// app half (colliderDecompose.js) only moves the mesh in and the result out.
//
// Why: a DYNAMIC concave body (an arch you can knock over, a cup, a U-shaped crate) can
// not use the exact trimesh (36 X2 is static-only), and its convex hull seals every
// opening. Decomposing it into N convex pieces gives the existing compound CUSTOM
// collider (one convexHull per piece, userData.physics.colliderVerts/colliderPieces)
// a shape that keeps the openings. Only the RESULT replicates (plain floats in
// userData), so the decomposition need not be bit-identical across machines — it runs
// on the peer that pressed the button.

/** the replicated float cap a custom collider fits under (colliderSpec CUSTOM_MAX_FLOATS) */
export const DECOMPOSE_MAX_FLOATS = 1200;
export const DECOMPOSE_MIN_PIECES = 2;
export const DECOMPOSE_MAX_PIECES = 16;
/** voxels V-HACD fills the mesh with: ~1 s for a block on a laptop core, in a worker */
export const DECOMPOSE_VOXELS = 100000;

/**
 * Hull vertex budget for a piece count, so the WHOLE result fits the replicated cap:
 * pieces x verts x 3 <= 1200, at most 32 per hull, at least 8.
 * @param {number} maxPieces @returns {number}
 */
export function vertexBudget(maxPieces) {
	const pieces = clampPieces(maxPieces);
	return Math.max(8, Math.min(32, Math.floor(DECOMPOSE_MAX_FLOATS / 3 / pieces)));
}

/** @param {any} n @returns {number} */
export function clampPieces(n) {
	const v = Math.round(Number(n));
	return Number.isFinite(v) ? Math.min(DECOMPOSE_MAX_PIECES, Math.max(DECOMPOSE_MIN_PIECES, v)) : 8;
}

/**
 * Weld a triangle soup into an indexed mesh (V-HACD's flood fill needs shared vertices
 * to see a closed surface; three's extrusions are non-indexed). Quantized to 1e-5.
 * @param {ArrayLike<number>} verts xyz @param {ArrayLike<number> | null} indices
 * @returns {{positions: Float64Array, indices: Uint32Array}}
 */
export function weldMesh(verts, indices) {
	const count = verts.length / 3;
	const order = indices ?? Array.from({ length: count }, (_, i) => i);
	/** @type {Map<string, number>} */
	const seen = new Map();
	/** @type {number[]} */
	const out = [];
	const remap = new Int32Array(count).fill(-1);
	for (let i = 0; i < count; i++) {
		const x = verts[i * 3];
		const y = verts[i * 3 + 1];
		const z = verts[i * 3 + 2];
		const key = Math.round(x * 1e5) + ',' + Math.round(y * 1e5) + ',' + Math.round(z * 1e5);
		let at = seen.get(key);
		if (at === undefined) {
			at = out.length / 3;
			seen.set(key, at);
			out.push(x, y, z);
		}
		remap[i] = at;
	}
	/** @type {number[]} */
	const tris = [];
	for (let t = 0; t + 2 < order.length; t += 3) {
		const a = remap[order[t]];
		const b = remap[order[t + 1]];
		const c = remap[order[t + 2]];
		if (a === b || b === c || a === c) continue; // degenerate after the weld
		tris.push(a, b, c);
	}
	return { positions: Float64Array.from(out), indices: Uint32Array.from(tris) };
}

/** V-HACD options for a piece budget @param {number} maxPieces */
export function decomposeOptions(maxPieces) {
	return {
		maxHulls: clampPieces(maxPieces),
		maxVerticesPerHull: vertexBudget(maxPieces),
		voxelResolution: DECOMPOSE_VOXELS,
		messages: /** @type {'none'} */ ('none')
	};
}

/**
 * Run the decomposition with a ConvexMeshDecomposition instance (the vendored vhacd-js).
 * @param {{computeConvexHulls: (mesh: any, options: any) => {positions: Float64Array}[]}} decomposer
 * @param {{positions: Float64Array, indices: Uint32Array}} mesh welded @param {number} maxPieces
 * @returns {Float64Array[]} one vertex array per convex piece
 */
export function decomposeMesh(decomposer, mesh, maxPieces) {
	if (mesh.positions.length < 12 || mesh.indices.length < 12) return [];
	return decomposer.computeConvexHulls(mesh, decomposeOptions(maxPieces)).map((h) => h.positions);
}

/**
 * Pack the pieces as a custom collider (flat xyz + [start, count] float ranges per
 * piece, numbers rounded to 0.1 mm so the replicated userData stays small), dropping
 * whole pieces past the cap rather than cutting one in half.
 * @param {ArrayLike<number>[]} pieces
 * @returns {{colliderVerts: number[], colliderPieces: number[][], dropped: number}}
 */
export function packPieces(pieces) {
	/** @type {number[]} */
	const verts = [];
	/** @type {number[][]} */
	const ranges = [];
	let dropped = 0;
	for (const piece of pieces) {
		if (piece.length < 12 || piece.length % 3 !== 0) {
			dropped++;
			continue;
		}
		if (verts.length + piece.length > DECOMPOSE_MAX_FLOATS) {
			dropped++;
			continue;
		}
		ranges.push([verts.length, piece.length]);
		for (let i = 0; i < piece.length; i++) verts.push(Math.round(piece[i] * 1e4) / 1e4);
	}
	return { colliderVerts: verts, colliderPieces: ranges, dropped };
}
