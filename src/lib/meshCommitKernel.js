// Roadmap 99 K2: the kernel's output as a commit state. `toMeshGeo` is the one commit shape;
// `compactMeshState` makes it what history keeps. Apart from meshCommit.js so the editors that
// import the sender load no kernel code until a kernel session (K3) does.
import { compactMeshState } from './meshCommit.js';
import { toMeshGeo } from './meshKernel/topo.js';

/** @typedef {import('./meshCommit.js').MeshState} MeshState */

/**
 * The kernel's output as a commit state — `toMeshGeo`, the one commit shape — with the ID
 * channels when asked (history keeps them so an undo rebuilds the same element IDs).
 * @param {import('./meshKernel/kernel.js').MeshKernel} mesh @param {{ ids?: boolean }} [options]
 * @returns {MeshState}
 */
export function commitStateFromKernel(mesh, options = {}) {
	const geo = toMeshGeo(mesh, { ids: !!options.ids });
	/** @type {MeshState} */
	const state = {
		positions: geo.positions,
		groups: geo.groups,
		uvs: geo.uvs,
		...(geo.colors ? { colors: geo.colors } : {})
	};
	if (geo.faceCounts) {
		state.faceCounts = geo.faceCounts;
		state.faceTris = geo.faceTris;
	}
	if (geo.ids) state.ids = geo.ids;
	return compactMeshState(state);
}
