// Roadmap 99 K3 -> K4 INPUT: the adapters an operator uses to move off the face-session globals and
// onto the one edit session + kernel. K3 ports NO operator (that is K4); this module is the seam
// they port through, and `K4_INPUT` is the list of what each operator reads today and which
// adapter replaces it. LAZY: nothing at boot imports it (the kernel stays out of the boot chunk).
//
// Contract every adapter keeps: a session with no kernel (no Worker, a mesh above the commit
// ceiling, a geometry that moved on from the one the kernel was built from) answers null, and the
// caller keeps its pre-K3 path — so a port can land operator by operator.

import { get } from 'svelte/store';
import { session } from './editSessionState';
import { whenSessionKernel, geometryChanged } from './editSession';
import { faceEditSelectedTris, edgeEditSelected } from './faceEdit';
import { MeshKernel } from './meshKernel/index.js';
import { commitStateFromKernel } from './meshCommitKernel.js';
import { selectionToIds, idsToSelection } from './meshSession.js';

/**
 * What operators read today (the face-session state K3 moved onto `session.face` / `session.vertex`)
 * and the adapter each one ports to in K4. Data, so the PR and the K4 brief list the same rows.
 */
export const K4_INPUT = [
	{
		reads: 'FS.workingTris (the triangle soup, `mi`/`uv` tags per triangle)',
		adapter: 'sessionKernel().mesh (faces, corners, per-corner attributes, material per face)'
	},
	{
		reads: 'FS.faces + currentPartition() (logical faces derived or stored)',
		adapter: 'sessionKernel().mesh faces (n-gons; the stored partition is the import input)'
	},
	{
		reads: 'FS.quadPartner (quad pairing for loops / rings)',
		adapter: 'kernel face sides + edge radial cycle (a quad IS a 4-sided face)'
	},
	{
		reads: 'faceEditSelectedTris (triangle indices)',
		adapter: 'liveSelectionIds().faces / trisOfFaceIds()'
	},
	{
		reads: 'edgeEditSelected (welded position-key pairs, keyOf 1e-4)',
		adapter: 'liveSelectionIds().edges (vertex-ID pairs)'
	},
	{
		reads: 'VS.handles[i].indices + VS.selection (attribute indices per welded vertex)',
		adapter: 'selectionIdsOf({handles}).verts / idsToSelection().attrs'
	},
	{
		reads: 'keyOf(x, y, z) welding inside each operator',
		adapter: 'the kernel import weld (SESSION_WELD = 1e-4), once per session'
	},
	{
		reads: "commitMesh({apply: 'session', after: {positions, groups, uvs}, faces})",
		adapter:
			'commitMesh({..., after: kernelCommitState(mesh, {ids: true})}) — the ID channels make undo ID-preserving and shareIds counts them once'
	},
	{
		reads: 'stashSelections / restoreSelection (index stash + geometry signature)',
		adapter:
			'session.selection (IDs, written by noteSelectionIds); restore reads it once operators keep IDs'
	}
];

/** the session's maps, but only while they still describe the live geometry */
function liveMaps() {
	const maps = session.kernelMaps;
	if (!maps || geometryChanged(session.entry, session.object?.geometry)) return null;
	return maps;
}

/**
 * The open session's kernel as a MeshKernel (rebuilt from the worker's transfer) plus its ID maps.
 * Awaits the build started on entry. @returns {Promise<{ mesh: any, maps: any } | null>}
 */
export async function sessionKernel() {
	await whenSessionKernel();
	const maps = liveMaps();
	if (!maps || !session.kernel) return null;
	return { mesh: MeshKernel.fromTransfer(session.kernel), maps };
}

/** the editor's position key (faceEdit's keyOf: 1e-4 quantisation) @param {number} x @param {number} y @param {number} z */
export function sessionKeyOf(x, y, z) {
	return `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
}

/**
 * Any selection as element IDs on the session kernel. @param {{ tris?: number[], handles?: number[][], edgeKeys?: string[] }} selection
 * @returns {{ faces: number[], verts: number[], edges: [number, number][] } | null}
 */
export function selectionIdsOf(selection) {
	const maps = liveMaps();
	return maps ? selectionToIds(maps, maps.geometry, selection, sessionKeyOf) : null;
}

/** the face-mode selection as IDs: faces from the picked triangles, edges from the picked keys */
export function liveSelectionIds() {
	return selectionIdsOf({ tris: get(faceEditSelectedTris), edgeKeys: get(edgeEditSelected) });
}

/** face IDs back to triangle indices of the live geometry @param {number[]} faces */
export function trisOfFaceIds(faces) {
	const maps = liveMaps();
	return maps ? idsToSelection(maps, maps.geometry, { faces, verts: [], edges: [] }).tris : null;
}

/** a kernel result as the state commitMesh records (Float32 positions/uvs, packed faces, IDs)
 * @param {any} mesh @param {{ ids?: boolean }} [options] */
export function kernelCommitState(mesh, options = {}) {
	return commitStateFromKernel(mesh, options);
}
