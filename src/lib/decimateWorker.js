// 26-F phase 2 — THE DECIMATION WORKER. Off the main thread, because a frozen tab is the
// thing roadmap 26 exists to prevent: a 2.4M-triangle scan is seconds of simplification,
// and on the main thread that is seconds of a window that cannot repaint or take input.
//
// The protocol is one message each way, keyed by `id`:
//   in:  {id, meshes: MeshIn[]}                 (typed arrays TRANSFERRED, never copied twice)
//   out: {id, results: MeshOut[]} | {id, error}  (result arrays transferred back)
// and the arithmetic is decimateCore's, so what runs here is exactly what the unit suite
// runs in node.
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { simplifyMesh } from './decimateCore';

/** @param {any} result */
function transferables(result) {
	/** @type {ArrayBuffer[]} */
	const out = [];
	for (const key of ['positions', 'normals', 'uvs', 'colors', 'index']) {
		const array = result[key];
		if (array?.buffer && !out.includes(array.buffer)) out.push(array.buffer);
	}
	return out;
}

self.onmessage = async (/** @type {MessageEvent} */ event) => {
	const { id, meshes } = event.data ?? {};
	try {
		await MeshoptSimplifier.ready;
		const started = performance.now();
		/** @type {any[]} */
		const results = [];
		for (const mesh of meshes ?? []) results.push(simplifyMesh(MeshoptSimplifier, mesh));
		const ms = performance.now() - started;
		/** @type {ArrayBuffer[]} */
		const transfer = [];
		for (const r of results) transfer.push(...transferables(r));
		/** @type {any} */ (self).postMessage({ id, results, ms }, transfer);
	} catch (error) {
		/** @type {any} */ (self).postMessage({ id, error: String(/** @type {any} */ (error)?.message ?? error) });
	}
};
