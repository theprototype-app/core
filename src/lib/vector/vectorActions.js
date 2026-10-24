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
import { peers } from '../../stores/appStore';
import { recordObjectPresence } from '../history';
import { applyGeometry } from '../geometryEdit';
import { selectObject } from '../objectActions';
import { buildVectorGeometry, vectorMaterial } from './vectorMesh.js';
import { cleanVector, vectorDefaults, KIND_NAMES } from './vectorRecord.js';

export const VECTOR_GTYPE = 'Vector';

/** is this object a vector shape? @param {any} object */
export function isVector(object) {
	return object?.userData?.geometryParams?.gtype === VECTOR_GTYPE && !!object.isMesh;
}

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
	if (opts.position) Array.isArray(opts.position) ? mesh.position.fromArray(opts.position) : mesh.position.copy(opts.position);
	if (opts.quaternion) Array.isArray(opts.quaternion) ? mesh.quaternion.fromArray(opts.quaternion) : mesh.quaternion.copy(opts.quaternion);
	if (opts.scale) Array.isArray(opts.scale) ? mesh.scale.fromArray(opts.scale) : mesh.scale.copy(opts.scale);
	group.add(mesh);
	mesh.updateMatrixWorld(true);
	pokeScene();
	if (opts.record !== false) recordObjectPresence('create', mesh);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'object', element: mesh.toJSON() });
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
		if (Math.hypot(dx, dz) > 1e-6) quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(dx, dz));
	}
	return addVectorShape(params, { position: at, quaternion });
}

/** edit a shape's record: one undo entry + one message (applyGeometry) @param {string} uuid @param {Record<string, any>} patch */
export function setVectorParams(uuid, patch) {
	return applyGeometry(uuid, patch);
}
