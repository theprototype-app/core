// 36 X3 — THE CONVEX DECOMPOSITION WORKER (the decimateWorker shape). V-HACD fills
// the mesh with ~100k voxels, which is about a second of work; on the main thread that
// is a second the window cannot repaint. One message each way, keyed by `id`:
//   in:  {id, positions: Float64Array, indices: Uint32Array, maxPieces}  (transferred)
//   out: {id, pieces: Float64Array[], ms} | {id, error}                  (transferred)
// The arithmetic is colliderDecomposeCore's, exactly what the unit suite runs in node.
import { ConvexMeshDecomposition } from './vendor/vhacd/vhacd.js';
import { decomposeMesh } from './colliderDecomposeCore';

/** @type {any} */
let decomposer = null;

self.onmessage = async (/** @type {MessageEvent} */ event) => {
	const { id, positions, indices, maxPieces } = event.data ?? {};
	try {
		decomposer ??= await ConvexMeshDecomposition.create();
		const started = performance.now();
		const pieces = decomposeMesh(decomposer, { positions, indices }, maxPieces);
		/** @type {any} */ (self).postMessage(
			{ id, pieces, ms: performance.now() - started },
			pieces.map((p) => p.buffer)
		);
	} catch (error) {
		/** @type {any} */ (self).postMessage({ id, error: String(/** @type {any} */ (error)?.message ?? error) });
	}
};
