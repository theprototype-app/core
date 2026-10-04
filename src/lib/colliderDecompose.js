// 36 X3: "Decompose" — V-HACD on an object's render mesh, the result written as its
// CUSTOM compound collider through the shared setPhysicsFor path (replicated, one
// props undo entry, live mid-sim rebuild). The work runs in vhacdWorker.js; only the
// result travels, so peers never run V-HACD. The arithmetic lives in
// colliderDecomposeCore.js (unit-tested in node against the same vendored build).
import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { colliderSpecOf } from './colliderSpec';
import { weldMesh, packPieces, clampPieces, decomposeMesh } from './colliderDecomposeCore';
import { setPhysicsFor } from './physics';

/** the uuid being decomposed right now (the Inspector disables its button), or null
 * @type {import('svelte/store').Writable<string | null>} */
export const decomposing = writable(null);

/** Resolve the Worker. A seam so a test can hand in something else. @returns {Worker} */
export let makeWorker = () => new Worker(new URL('./vhacdWorker.js', import.meta.url), { type: 'module' });

/** @param {() => Worker} factory */
export function setWorkerFactory(factory) {
	makeWorker = factory;
}

/** One job on a fresh Worker, terminated after (the decimate.js rule: a live worker
 * keeps its grown wasm heap). Falls back to the main thread when no Worker exists.
 * @param {{positions: Float64Array, indices: Uint32Array}} mesh @param {number} maxPieces
 * @returns {Promise<{pieces: Float64Array[], ms: number, where: string}>} */
async function run(mesh, maxPieces) {
	/** @type {Worker | null} */
	let worker = null;
	try {
		worker = typeof Worker === 'undefined' ? null : makeWorker();
	} catch {
		worker = null;
	}
	if (!worker) {
		const { ConvexMeshDecomposition } = await import('./vendor/vhacd/vhacd.js');
		const started = performance.now();
		const pieces = decomposeMesh(await ConvexMeshDecomposition.create(), mesh, maxPieces);
		return { pieces, ms: performance.now() - started, where: 'main' };
	}
	const w = worker;
	return new Promise((resolve, reject) => {
		const done = () => {
			try {
				w.terminate();
			} catch {
				/* already gone */
			}
		};
		w.onmessage = (event) => {
			done();
			if (event.data?.error) reject(new Error(event.data.error));
			else resolve({ pieces: event.data.pieces ?? [], ms: event.data.ms ?? 0, where: 'worker' });
		};
		w.onerror = (event) => {
			done();
			reject(new Error(event.message || 'decomposition worker failed'));
		};
		w.postMessage({ id: 1, positions: mesh.positions, indices: mesh.indices, maxPieces }, [
			mesh.positions.buffer,
			mesh.indices.buffer
		]);
	});
}

/**
 * Decompose an object's mesh into up to `maxPieces` convex pieces and make that its
 * custom collider. Stored verts are object-local UNSCALED (the custom-collider
 * convention — colliderSpec bakes the scale back in).
 * @param {string} uuid @param {number=} maxPieces 2..16
 * @returns {Promise<{pieces: number, dropped: number, ms: number, where: string} | null>}
 */
export async function decomposeCollider(uuid, maxPieces = 8) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!object || get(decomposing)) return null;
	const spec = colliderSpecOf(object, 'trimesh');
	const piece = spec?.kind === 'trimesh' ? spec.pieces?.[0] : null;
	if (!piece?.indices) {
		showToast('Nothing to decompose on "' + (object.name || object.type) + '"' + (spec?.reason ? ' (' + spec.reason + ')' : ''));
		return null;
	}
	const s = object.scale;
	const sx = Math.abs(s.x) > 1e-9 ? s.x : 1;
	const sy = Math.abs(s.y) > 1e-9 ? s.y : 1;
	const sz = Math.abs(s.z) > 1e-9 ? s.z : 1;
	const unscaled = new Float64Array(piece.verts.length);
	for (let i = 0; i < unscaled.length; i += 3) {
		unscaled[i] = piece.verts[i] / sx;
		unscaled[i + 1] = piece.verts[i + 1] / sy;
		unscaled[i + 2] = piece.verts[i + 2] / sz;
	}
	const budget = clampPieces(maxPieces);
	decomposing.set(uuid);
	try {
		const { pieces, ms, where } = await run(weldMesh(unscaled, piece.indices), budget);
		const packed = packPieces(pieces);
		if (!packed.colliderPieces.length) {
			showToast('Decompose found no convex pieces for "' + (object.name || object.type) + '"');
			return null;
		}
		setPhysicsFor(uuid, {
			collider: 'custom',
			colliderVerts: packed.colliderVerts,
			colliderPieces: packed.colliderPieces
		});
		const n = packed.colliderPieces.length;
		showToast(
			'Collider decomposed into ' + n + ' convex piece' + (n === 1 ? '' : 's') +
				(packed.dropped ? ' (' + packed.dropped + ' dropped to fit)' : '')
		);
		return { pieces: n, dropped: packed.dropped, ms: Math.round(ms), where };
	} catch (error) {
		showToast('Decompose failed: ' + /** @type {any} */ (error)?.message);
		return null;
	} finally {
		decomposing.set(null);
	}
}
