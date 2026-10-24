// 64 D1: a vector shape ON THE WIRE. A LEAF (three + the record/mesh leaves) because the three
// places that send or receive an object — the creator (vectorActions), history's re-add
// (undo a delete / redo a create) and the ingest (commandsHandler) — are on both sides of the
// history cycle.
//
// THE FINDING: an `object` message is toJSON, whose attributes are PLAIN NUMBER ARRAYS, and
// binarypack recurses per element, so past ~45 000 floats the send blows the stack inside
// `broadcast`'s catch and the message never leaves — silently (commandsHandler's
// multiMaterialSyncable carries the same measurement). A gradient or a stroke is what makes a
// shape heavy: measured, a radial ellipse is 61 512 floats, a dashed star 55 242, a stroked
// circle 75 966 — so exactly the shapes worth drawing never reached a peer.
//
// A shape is fully described by its record (`userData.geometryParams`), so a HEAVY one travels
// WITHOUT its triangles and the receiver rebuilds them (`rebuildVectorFromRecord`, called right
// after the parse). A light one still sends the whole mesh, byte-identical to before, so a peer
// on an older build loses nothing it used to get.
import * as THREE from 'three';
import { buildVectorGeometry } from './vectorMesh.js';
import { cleanVector } from './vectorRecord.js';

/** above this many floats (attributes + index) the triangles stay home */
export const WIRE_FLOAT_CAP = 45000;

/** @param {any} geometry */
function floatsOf(geometry) {
	let n = geometry?.index?.array?.length ?? 0;
	for (const a of Object.values(geometry?.attributes ?? {})) n += /** @type {any} */ (a).array?.length ?? 0;
	return n;
}

/**
 * Is this a vector shape whose record still IS its geometry? (A mesh edited by the generic
 * mesh tools carries `vertexEdited` / `faceEdited`: its triangles are no longer derivable.)
 * @param {any} object
 */
function rebuildable(object) {
	const u = object?.userData;
	return !!object?.isMesh && u?.geometryParams?.gtype === 'Vector' && !u.vertexEdited && !u.faceEdited && !object.children?.length;
}

/**
 * The `element` an `object` message should carry for this mesh: null when it is not a
 * rebuildable vector shape (the caller sends whatever it always did), the full toJSON when it
 * is light, and the toJSON WITHOUT triangles when it is heavy. @param {any} object
 * @returns {any | null}
 */
export function vectorWireElement(object) {
	if (!rebuildable(object)) return null;
	if (floatsOf(object.geometry) <= WIRE_FLOAT_CAP) return object.toJSON();
	const real = object.geometry;
	object.geometry = new THREE.BufferGeometry();
	try {
		return object.toJSON();
	} finally {
		object.geometry.dispose();
		object.geometry = real;
	}
}

/**
 * Receive side: a vector shape that arrived without its triangles gets them back from its
 * record. Anything else is left alone. @param {any} object @returns {boolean} rebuilt
 */
export function rebuildVectorFromRecord(object) {
	if (!rebuildable(object) || object.geometry?.attributes?.position) return false;
	const fresh = buildVectorGeometry(cleanVector(object.userData.geometryParams.params ?? {}));
	object.geometry?.dispose?.();
	object.geometry = fresh;
	return true;
}
