import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, lockedObjects } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { beginHistoryBatch, endHistoryBatch } from './history';
import {
	readTriangles,
	trisToPositions,
	trisToGroups,
	trisToUVs,
	commitMeshGeoTriple,
	faceEditObject
} from './faceEdit';
import { editingObject } from './meshEdit';
import { readStoredFaces } from './meshTopology';
import { deleteObjectsByUuid } from './objectActions';
import { booleanGeometry, openEdgeCount } from './meshBooleanCore';
// re-exported for the e2e debug hook (the suite measures results with the same rule)
export { openEdgeCount } from './meshBooleanCore';
import { canEditObject, warnViewerReadOnly } from './objectPermissions';

// B10 (36-mesh-ops): CSG BOOLEANS — union / subtract / intersect two meshes with
// three-bvh-csg, as a ONE-SHOT: the first object's geometry becomes the result
// and the second (the "cutter") is removed unless kept.
//
// Replication adds NOTHING to the wire. The result is an ordinary geometry
// snapshot on the target — `commitMeshGeoTriple`, the same `meshgeo` message
// (raw Float32 positions + uvs) every mesh edit already sends, so peers apply
// the result instead of re-running the CSG (the library is not guaranteed to be
// bit-identical across machines, and a geometry snapshot is). The cutter goes
// through the normal delete path. Both ride ONE history batch: Ctrl+Z gives
// back the original shape AND the cutter in one step.
//
// three-bvh-csg is LAZY-loaded: it is ~1.4 MB unpacked and only this action
// needs it, so it never touches the editor's first load.
//
// Limits, said in the toasts and the docs: the result wears the TARGET's first
// material slot (the cutter's materials are not merged in); the inputs should
// be CLOSED meshes — the library still answers for open ones, but the result
// then has holes, and the toast reports how many open edges came out.

/** @typedef {import('./meshBooleanCore').BooleanOp} BooleanOp */

/** @type {Promise<any> | null} */
let csgModule = null;
function loadCsg() {
	csgModule ??= import('three-bvh-csg');
	return csgModule;
}

const LABEL = { union: 'Union', subtract: 'Subtract', intersect: 'Intersect' };

/**
 * Boolean two scene meshes: `targetUuid` takes the result, `cutterUuid` is
 * removed (unless `keepCutter`). ONE undo step; replicated as a meshgeo
 * snapshot + a delete. Refuses (with a toast saying why) for non-meshes,
 * locked or read-only objects, an object in a mesh-edit session, an empty
 * result, and a result past the sync size cap.
 * @param {string} targetUuid @param {string} cutterUuid @param {BooleanOp} op
 * @param {{keepCutter?: boolean}} [options]
 * @returns {Promise<boolean>}
 */
export async function booleanObjects(targetUuid, cutterUuid, op, options = {}) {
	const group = get(objectsGroup);
	const target = group?.getObjectByProperty('uuid', targetUuid);
	const cutter = group?.getObjectByProperty('uuid', cutterUuid);
	if (!target?.geometry?.attributes?.position || !cutter?.geometry?.attributes?.position) {
		showToast('Boolean needs two MESH objects (ungroup a group first, or Convert to mesh)');
		return false;
	}
	if (targetUuid === cutterUuid) return false;
	const locks = get(lockedObjects);
	if (locks.some((lock) => lock[1] === targetUuid || lock[1] === cutterUuid)) {
		showToast('One of those objects is locked by another peer');
		return false;
	}
	if (!canEditObject(target) || (!options.keepCutter && !canEditObject(cutter))) {
		warnViewerReadOnly();
		return false;
	}
	const editing = [get(faceEditObject), get(editingObject)];
	if (editing.includes(targetUuid) || editing.includes(cutterUuid)) {
		showToast('Finish the mesh edit first (Done), then run the boolean');
		return false;
	}
	let csg;
	try {
		csg = await loadCsg();
	} catch (error) {
		console.log('three-bvh-csg failed to load', error);
		showToast('The boolean tool could not load — check the connection and try again');
		return false;
	}
	target.updateMatrixWorld(true);
	cutter.updateMatrixWorld(true);
	/** @type {THREE.BufferGeometry} */
	let result;
	try {
		result = booleanGeometry(csg, target.geometry, target.matrixWorld, cutter.geometry, cutter.matrixWorld, op);
	} catch (error) {
		console.log('boolean failed', error);
		showToast('The boolean failed on these shapes — try closed meshes (no holes)');
		return false;
	}
	const inputTris = readTriangles(target.geometry);
	const tris = readTriangles(result);
	result.dispose();
	if (!tris.length) {
		showToast(
			op === 'intersect'
				? 'Nothing left: the two objects do not overlap'
				: 'Nothing left: the second object swallows the first'
		);
		return false;
	}
	const before = {
		positions: trisToPositions(inputTris),
		groups: trisToGroups(inputTris),
		uvs: trisToUVs(inputTris),
		faces: readStoredFaces(target.geometry)
	};
	// one slot: the result wears the target's first material (the documented limit)
	for (const t of tris) t.mi = 0;
	const after = { positions: trisToPositions(tris), groups: null, uvs: trisToUVs(tris), faces: null };
	const openIn = openEdgeCount(inputTris) + openEdgeCount(readTriangles(cutter.geometry));
	const openOut = openEdgeCount(tris);
	beginHistoryBatch();
	let ok = false;
	try {
		ok = commitMeshGeoTriple(targetUuid, before, after);
		if (ok && Array.isArray(target.material) && target.material.length > 1)
			// a single-slot result on a multi-slot material would draw nothing past slot 0
			// — keep slot 0 and say so (the material array itself is left alone)
			showToast('The result uses the first material slot only');
		if (ok && !options.keepCutter) deleteObjectsByUuid([cutterUuid]);
	} finally {
		endHistoryBatch(LABEL[op] ?? 'Boolean');
	}
	if (!ok) return false;
	showToast(
		LABEL[op] +
			' done — ' +
			tris.length +
			' triangles' +
			(openOut
				? ` (${openOut} open edges${openIn ? ': the inputs were not closed meshes' : ''})`
				: '')
	);
	return true;
}
