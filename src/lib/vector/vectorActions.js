// 64 D1: vector shapes as SCENE OBJECTS — creation, placement and edits.
//
// A shape is an ordinary Mesh stamped `userData.geometryParams = {gtype: 'Vector', params}`, so
// everything after creation is the existing machinery: a param edit (the Inspector rows, a
// colour, a pen edit) is `applyGeometry` -> the `geometry` message + ONE `'geometry'` undo entry,
// and a late joiner / a save / a prefab carries the stamp in toJSON + GLTF extras. Creation is
// the splineTool.finishSpline shape: build locally, `recordObjectPresence('create')`, one
// `{type: 'object', element: mesh.toJSON()}` (the vertex colours ride the geometry, the stamp
// rides userData). This module reaches history, so menu builders import it PRIMED (dynamic).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, globalCamera, pokeScene } from '../../stores/sceneStore';
import { peers, showToast } from '../../stores/appStore';
import { heldByOther } from '../lockHeld'; // 80a
import { recordObjectPresence, recordEntry, registerHistoryKind } from '../history';
import { showConfirm } from '../confirmDialog.js';
import { applyGeometry } from '../geometryEdit';
import { selectObject } from '../objectActions';
import { buildVectorGeometry, vectorMaterial } from './vectorMesh.js';
import { cleanVector, vectorDefaults, KIND_NAMES } from './vectorRecord.js';
import { vectorWireElement, VECTOR_GTYPE, isVectorObject, loadVectorCore } from './vectorGate.js';

// any vector chunk on screen means the Geometry rows are wanted: the core chunk (mostly these same modules)
void loadVectorCore();

export { VECTOR_GTYPE };

/** is this object a vector shape? @param {any} object */
export const isVector = isVectorObject;

/** the record of a vector shape (null for anything else) @param {any} object @returns {Record<string, any> | null} */
export function vectorParamsOf(object) {
	return isVector(object) ? object.userData.geometryParams.params : null;
}

/**
 * A standalone vector mesh (no scene side effects). @param {Record<string, any>} params
 * @param {string} [name] @returns {THREE.Mesh}
 */
export function makeVectorMesh(params, name) {
	const clean = cleanVector(params);
	const mesh = new THREE.Mesh(buildVectorGeometry(clean), vectorMaterial());
	mesh.name = name || KIND_NAMES[/** @type {keyof typeof KIND_NAMES} */ (clean.kind)] || 'Shape';
	mesh.userData.geometryParams = { gtype: VECTOR_GTYPE, params: clean };
	// a flat shape is scenery: no physics stamp (the FUN_PRIMITIVES default is for /create solids)
	return mesh;
}

/**
 * Add a vector shape to the scene: one create undo entry, one `object` message.
 * `position` / `quaternion` are in objectsGroup's frame.
 * @param {Record<string, any>} params
 * @param {{position?: THREE.Vector3 | number[] | null, quaternion?: THREE.Quaternion | number[] | null, scale?: THREE.Vector3 | number[] | null, name?: string, select?: boolean, record?: boolean}} [opts]
 * @returns {THREE.Mesh | null}
 */
export function addVectorShape(params, opts = {}) {
	const group = get(objectsGroup);
	if (!group) return null;
	const mesh = makeVectorMesh(params, opts.name);
	if (opts.position)
		Array.isArray(opts.position)
			? mesh.position.fromArray(opts.position)
			: mesh.position.copy(opts.position);
	if (opts.quaternion)
		Array.isArray(opts.quaternion)
			? mesh.quaternion.fromArray(opts.quaternion)
			: mesh.quaternion.copy(opts.quaternion);
	if (opts.scale)
		Array.isArray(opts.scale) ? mesh.scale.fromArray(opts.scale) : mesh.scale.copy(opts.scale);
	group.add(mesh);
	mesh.updateMatrixWorld(true);
	pokeScene();
	if (opts.record !== false) recordObjectPresence('create', mesh);
	/** @type {any} */
	const peer = get(peers);
	// a heavy shape (a gradient, a stroke) goes without its triangles — vectorWire.js
	const element = vectorWireElement(mesh) ?? mesh.toJSON();
	if (peer) peer.send({ type: 'object', element });
	// 64-extrude: a heavy shape went without its triangles — a build without vector shapes gets the mesh itself
	if (peer && !element.geometries?.[0]?.data?.attributes?.position)
		void import('./vectorOldPeers.js').then((m) => m.scheduleOldPeerSolid(mesh.uuid));
	if (opts.select !== false) selectObject(mesh.uuid);
	return mesh;
}

/**
 * The Add menu's placement: a default shape of `kind` standing on the clicked point, turned to
 * face the camera (yaw only), its bottom on the surface. @param {string} kind
 * @param {number[] | null | undefined} point world point (objectsGroup frame — the Add menu's)
 * @param {Record<string, any>} [patch]
 */
export function placeVectorShape(kind, point, patch = {}) {
	const params = cleanVector({ ...vectorDefaults(kind), ...patch, kind });
	const geometry = buildVectorGeometry(params);
	geometry.computeBoundingBox();
	const lift = geometry.boundingBox ? -geometry.boundingBox.min.y : 0.5;
	geometry.dispose();
	const at = new THREE.Vector3(...(point ?? [0, 0, 0]));
	at.y += Number.isFinite(lift) ? lift : 0.5;
	/** @type {any} */
	const camera = get(globalCamera);
	const quaternion = new THREE.Quaternion();
	if (camera?.position) {
		const dx = camera.position.x - at.x;
		const dz = camera.position.z - at.z;
		if (Math.hypot(dx, dz) > 1e-6)
			quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(dx, dz));
	}
	return addVectorShape(params, { position: at, quaternion });
}

/** edit a shape's record: one undo entry + one message (applyGeometry) @param {string} uuid @param {Record<string, any>} patch */
export function setVectorParams(uuid, patch) {
	// 80a: a shape another peer holds refuses edits
	if (heldByOther(uuid)) {
		showToast('This shape is locked by another peer');
		return false;
	}
	return applyGeometry(uuid, patch);
}

/* ------------------------------------------------------------------ bake ---- */

// 64-extrude: BAKE → MESH, the 1.61 text object's word and behaviour: the shape becomes a plain mesh
// (its triangles, colours and kernel faces stay; the record goes), so Edit mode owns it from then on
// and no point / depth edit rebuilds it. ONE undo step brings the record back. Every peer already
// holds the same build of the same record, so the wire carries only the drop: the `geometry` message
// with an additive `vectorBake` (an older peer cannot build a Vector and ignores it).

/** can this object bake? (a shape whose mesh is still its record) @param {any} object */
export function canBakeVector(object) {
	const u = object?.userData;
	return (
		isVector(object) &&
		!u.vertexEdited &&
		!u.faceEdited &&
		!!object.geometry?.attributes?.position?.count
	);
}

/** drop the record, keep the mesh, tell peers @param {any} object */
function dropRecord(object) {
	const gp = object.userData.geometryParams;
	delete object.userData.geometryParams;
	pokeScene();
	/** @type {any} */
	const peer = get(peers);
	peer?.send({
		type: 'geometry',
		uuid: object.uuid,
		gtype: VECTOR_GTYPE,
		params: gp?.params ?? {},
		vectorBake: true
	});
}

/** Bake a shape to a mesh: one undo entry. @param {string} uuid @returns {{ok: true} | {ok: false, error: string}} */
export function bakeVectorToMesh(uuid) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!object) return { ok: false, error: 'That shape is gone.' };
	if (heldByOther(uuid)) return { ok: false, error: 'This shape is locked by another peer' };
	if (!canBakeVector(object))
		return {
			ok: false,
			error: isVector(object)
				? 'This shape is already mesh-edited: it is a mesh now.'
				: 'That is not a vector shape.'
		};
	const before = {
		gtype: VECTOR_GTYPE,
		params: cleanVector(object.userData.geometryParams.params)
	};
	dropRecord(object);
	recordEntry({ kind: 'vectorbake', uuid, before, after: null });
	return { ok: true };
}

/** the menu's Bake: asks first, as the text Bake does @param {string} uuid */
export async function confirmBakeVector(uuid) {
	const ok = await showConfirm({
		title: 'Bake to mesh',
		message:
			'Turn this shape into a normal mesh? You can then edit its vertices and faces, but not its points, depth or bevel. Undo brings the shape back.',
		confirmLabel: 'Bake'
	});
	if (!ok) return null;
	const out = bakeVectorToMesh(uuid);
	if (!out.ok) showToast(out.error);
	return out;
}

// undo: the record comes back and the mesh is rebuilt from it (the ordinary geometry message);
// redo: the record goes again
registerHistoryKind('vectorbake', (/** @type {any} */ entry, /** @type {any} */ state) => {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', entry.uuid);
	if (!object) return false;
	if (!state) {
		if (isVector(object)) dropRecord(object);
		return true;
	}
	const params = cleanVector(state.params);
	object.geometry?.dispose?.();
	object.geometry = buildVectorGeometry(params);
	object.userData.geometryParams = { gtype: VECTOR_GTYPE, params };
	delete object.userData.vertexEdited;
	delete object.userData.faceEdited;
	pokeScene();
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'geometry', uuid: entry.uuid, gtype: VECTOR_GTYPE, params });
	return true;
});
