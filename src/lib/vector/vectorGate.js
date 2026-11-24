// 64-vector (restart on 1.78): the BOOT half of vector shapes. Everything that must be synchronous
// lives here and is small; the record, the path maths, the mesh builder, the tools, booleans and
// SVG are lazy chunks (`vectorCore.js` and the modules it reaches). The roundedBoxGate precedent:
//
//   - `VECTOR_SPEC` is the GEOMETRY_PARAMS 'Vector' entry. Its builder, cleaner and Inspector rows
//     come from the chunk; asked before the chunk has arrived, it builds an EMPTY geometry for that
//     moment, keeps the raw record, and the chunk then cleans and rebuilds every such shape
//     (`healVectors`) — so a peer's `geometry` message that lands first is never lost.
//   - the WIRE half (`vectorWireElement` / `rebuildVectorFromRecord`): an `object` message is
//     toJSON, binarypack recurses per element, and past ~45 000 floats the send overflows inside
//     `broadcast`'s catch and never leaves (commandsHandler's multiMaterialSyncable carries the same
//     measurement). A gradient or a stroke makes a shape heavy (a radial ellipse is 61 512 floats),
//     so a heavy shape travels WITHOUT its triangles and the receiver rebuilds them from the record.
//     A light shape sends the whole mesh, so an older peer sees it as a plain flat mesh.
//   - the stores the boot UI reads (Tools ▸ Draw shapes is checked, the toolbar mounts).
// A LEAF: three, svelte/store and sceneStore only (commandsHandler and history import it).
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../../stores/sceneStore';

export const VECTOR_GTYPE = 'Vector';
/** above this many floats (attributes + index) the triangles stay home */
export const WIRE_FLOAT_CAP = 45000;

/** the armed draw tool, null = off @type {import('svelte/store').Writable<null | 'rect' | 'ellipse' | 'star' | 'polygon' | 'pen'>} */
export const vectorTool = writable(null);
/** the shape whose points are being edited (uuid) @type {import('svelte/store').Writable<string | null>} */
export const vectorEditObject = writable(null);

/** is this object a vector shape? @param {any} object */
export function isVectorObject(object) {
	return !!object?.isMesh && object.userData?.geometryParams?.gtype === VECTOR_GTYPE;
}

/** @type {any} */ let core = null;
/** @type {Promise<any> | null} */ let loading = null;

/** the loaded core chunk, or null */
export function vectorCore() {
	return core;
}

/** load the core chunk once; when it lands, clean + rebuild every shape built while waiting */
export function loadVectorCore() {
	loading ??= import('./vectorCore.js').then((m) => {
		core = m;
		healVectors();
		// the Inspector's Geometry rows read VECTOR_SPEC.params, which were [] until now
		pokeScene();
		return m;
	});
	return loading;
}

/** a geometry stand-in while the chunk loads (no triangles: nothing to draw yet) */
function pendingGeometry() {
	const g = new THREE.BufferGeometry();
	g.userData.vectorPending = true;
	return g;
}

/**
 * Is this a vector shape whose record still IS its geometry? (A mesh edited by the generic mesh
 * tools carries `vertexEdited` / `faceEdited`: its triangles are no longer derivable.)
 * @param {any} object
 */
function rebuildable(object) {
	const u = object?.userData;
	return isVectorObject(object) && !u.vertexEdited && !u.faceEdited && !object.children?.length;
}

/** every shape in the scene still waiting for its triangles (or its cleaned record): build it now */
function healVectors() {
	const group = get(objectsGroup);
	if (!group || !core) return;
	let any = false;
	group.traverse((/** @type {any} */ o) => {
		if (!rebuildable(o)) return;
		if (!o.geometry?.userData?.vectorPending && o.geometry?.attributes?.position) return;
		const clean = core.cleanVector(o.userData.geometryParams.params ?? {});
		o.userData.geometryParams = { gtype: VECTOR_GTYPE, params: clean };
		o.geometry?.dispose?.();
		o.geometry = core.buildVectorGeometry(clean);
		any = true;
	});
	return any;
}

/** GEOMETRY_PARAMS.Vector: the `build`-hook shape (21-C1 Terrain / 37 R3 arch), through the chunk */
export const VECTOR_SPEC = {
	/** @param {any} params */
	build(params) {
		if (core) return core.buildVectorGeometry(params);
		void loadVectorCore();
		return pendingGeometry();
	},
	/** the ONE boundary (cleanVector); before the chunk lands the record is held as-is and cleaned by healVectors @param {any} params */
	clean(params) {
		if (core) return core.cleanVector(params);
		void loadVectorCore();
		return params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {};
	},
	get order() {
		return core ? core.VECTOR_ORDER : [];
	},
	get params() {
		return core ? core.VECTOR_PARAMS : [];
	}
};

/** @param {any} geometry */
function floatsOf(geometry) {
	let n = geometry?.index?.array?.length ?? 0;
	for (const a of Object.values(geometry?.attributes ?? {})) n += /** @type {any} */ (a).array?.length ?? 0;
	return n;
}

/**
 * The `element` an `object` message should carry for this mesh: null when it is not a rebuildable
 * vector shape (the caller sends whatever it always did), the full toJSON when it is light, and the
 * toJSON WITHOUT triangles when it is heavy. @param {any} object @returns {any | null}
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
 * Receive side: a vector shape that arrived without its triangles gets them back from its record
 * (now, or when the chunk lands). Anything else is left alone. @param {any} object @returns {boolean}
 */
export function rebuildVectorFromRecord(object) {
	if (!rebuildable(object) || object.geometry?.attributes?.position) return false;
	if (!core) {
		object.geometry?.dispose?.();
		object.geometry = pendingGeometry();
		void loadVectorCore();
		return true;
	}
	const clean = core.cleanVector(object.userData.geometryParams.params ?? {});
	object.userData.geometryParams = { gtype: VECTOR_GTYPE, params: clean };
	object.geometry?.dispose?.();
	object.geometry = core.buildVectorGeometry(clean);
	return true;
}

/** Tools ▸ Draw shapes / the palette row: arm a tool (the same one again disarms) @param {string} [kind] */
export function armVectorTool(kind = 'rect') {
	return import('./vectorTool.js').then((m) => m.armVectorTool(kind));
}

/** disarm the draw tool (nothing to do when it never loaded) */
export function disarmVectorTool() {
	if (get(vectorTool) === null) return Promise.resolve();
	return import('./vectorTool.js').then((m) => m.disarmVectorTool());
}

/** the menu's toggle */
export function toggleVectorTool() {
	return get(vectorTool) ? disarmVectorTool() : armVectorTool('rect');
}
