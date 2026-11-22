// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { normalizeArray, arrayCopyPoses } from './arrayCore.js';
import { textPathPolylineOf, textPathSourceKey } from './textPathSources.js';
import { isEditOverlay } from './editOverlays.js';
import { isProxyCarrier } from './proxyCarrier.js'; // 102-int-2

// 102b-arrange row 1 — THE ARRAY RUNTIME (a lazy chunk; arrayTick.js loads it once a scene holds
// an array). LOCAL per peer and never saved or sent: only `userData.array` travels, and every peer
// draws the same copies from it (golden rule 8).
//
// Per array, ONE InstancedMesh per mesh of the object, at the scene root (objectsGroup's parent,
// golden rule 5: serializers, pickers and the object list never see it). The instances SHARE the
// object's geometry and materials, so a colour, texture or mesh edit on the object shows on every
// copy the same frame, and the whole array costs one draw call per mesh of the object, not one per
// copy. Rebuilt only when something it depends on changes (the record, the object's pose or meshes,
// the followed path); a resting array costs a key compare per frame.
//
// What copies are NOT: objects. They have no collider, no logic, no click, and a glTF export of
// the object does not include them — "Make real objects" (arrayActions.js) turns them into objects.

const VISUAL_NAME = 'Array copies (visual)';

/** @typedef {{carrier: any, key: string, recRef: any, rec: any, meshes: {src: any, inst: any}[], shape: string}} Entry */

/** @type {Map<string, Entry>} */
const entries = new Map();
let visualParent = /** @type {any} */ (null);

const _inv = new THREE.Matrix4();
const _carrierInv = new THREE.Matrix4();
const _rel = new THREE.Matrix4();
const _copy = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _parentInv = new THREE.Matrix4();

/** is the object shown (it and every ancestor up to the root) @param {any} o @param {any} root */
function shown(o, root) {
	for (let n = o; n && n !== root; n = n.parent) if (!n.visible) return false;
	return true;
}

/** the meshes an array repeats: the object's own meshes, never edit overlays or other arrays' visuals
 * @param {any} carrier */
function meshesOf(carrier) {
	/** @type {any[]} */
	const out = [];
	carrier.traverse((/** @type {any} */ n) => {
		if (!n.isMesh || n.isInstancedMesh || n.isSkinnedMesh || isEditOverlay(n)) return;
		if (n.userData?.textPath) return; // a text's mesh is a hit proxy that draws nothing
		if (isProxyCarrier(n)) return; // 102-int-2: nor does a decal's or a splat's (their visuals live at the scene root)
		out.push(n);
	});
	return out;
}

/** the path an array follows, as points in the CARRIER'S PARENT frame, or null
 * @param {any} carrier @param {any} rec @param {any} root */
function pathIn(carrier, rec, root) {
	if (rec.mode !== 'path' || !rec.path || !root) return null;
	const pathObj = root.getObjectByProperty('uuid', rec.path);
	if (!pathObj || pathObj === carrier) return null;
	const line = textPathPolylineOf(pathObj);
	if (!line) return null;
	pathObj.updateWorldMatrix(true, false);
	_parentInv.copy(carrier.parent.matrixWorld).invert();
	_m.multiplyMatrices(_parentInv, pathObj.matrixWorld);
	return {
		points: line.points.map((p) => _p.fromArray(p).applyMatrix4(_m).toArray()),
		closed: !!line.closed
	};
}

/**
 * The copies' poses in the object's parent frame (what the runtime draws and what Make real objects
 * places). [] for an object with no (valid) record or a path that cannot be read.
 * @param {any} carrier @param {any} root objectsGroup
 */
export function copyPosesOf(carrier, root) {
	const rec = normalizeArray(carrier?.userData?.array);
	if (!rec || !carrier.parent) return [];
	carrier.parent.updateWorldMatrix(true, false);
	return arrayCopyPoses(
		rec,
		{ position: carrier.position.toArray(), quaternion: carrier.quaternion.toArray(), scale: carrier.scale.toArray() },
		pathIn(carrier, rec, root)
	);
}

/** what the drawn copies depend on, as one string @param {Entry} e @param {any} root */
function keyOf(e, root) {
	const c = e.carrier;
	const parts = [JSON.stringify(e.rec), shown(c, root) ? 1 : 0];
	for (const v of c.matrixWorld.elements) parts.push(Math.round(v * 1e5));
	for (const m of meshesOf(c)) {
		const mats = Array.isArray(m.material) ? m.material.map((/** @type {any} */ x) => x.uuid).join('+') : m.material?.uuid;
		parts.push(m.uuid, m.geometry?.uuid, mats, m.castShadow ? 1 : 0, m.receiveShadow ? 1 : 0);
		for (const v of m.matrixWorld.elements) parts.push(Math.round(v * 1e5));
	}
	if (e.rec?.mode === 'path' && e.rec.path) {
		const p = root.getObjectByProperty('uuid', e.rec.path);
		if (p) {
			for (const v of p.matrixWorld.elements) parts.push(Math.round(v * 1e5));
			const k = textPathSourceKey(p);
			parts.push(typeof k === 'object' ? JSON.stringify(k) : String(k));
		} else parts.push('no-path');
	}
	return parts.join(',');
}

/** @param {Entry} e */
function dropMeshes(e) {
	for (const { inst } of e.meshes) {
		inst.parent?.remove(inst);
		inst.dispose(); // the instance buffers only: geometry and materials belong to the object
	}
	e.meshes = [];
	e.shape = '';
}

/** (re)build an entry's instanced meshes and their matrices @param {Entry} e @param {any} root */
function rebuild(e, root) {
	const c = e.carrier;
	const poses = e.rec && shown(c, root) ? copyPosesOf(c, root) : [];
	const meshes = poses.length ? meshesOf(c) : [];
	const shape = meshes.map((m) => `${m.uuid}:${m.geometry?.uuid}`).join('|') + `#${poses.length}`;
	if (shape !== e.shape) {
		dropMeshes(e);
		for (const src of meshes) {
			const inst = new THREE.InstancedMesh(src.geometry, src.material, poses.length);
			inst.name = VISUAL_NAME;
			inst.userData.arrayVisual = c.uuid;
			inst.matrixAutoUpdate = false;
			inst.raycast = () => {}; // not pickable: a click on a copy goes to what is behind it
			visualParent.add(inst);
			e.meshes.push({ src, inst });
		}
		e.shape = shape;
	}
	if (!poses.length) return;
	_inv.copy(visualParent.matrixWorld).invert();
	_carrierInv.copy(c.matrixWorld).invert();
	for (const { src, inst } of e.meshes) {
		inst.material = src.material; // a material swap (Make it metal, a texture) follows
		inst.castShadow = src.castShadow;
		inst.receiveShadow = src.receiveShadow;
		_rel.multiplyMatrices(_carrierInv, src.matrixWorld);
		poses.forEach((pose, i) => {
			_copy.compose(_p.fromArray(pose.position), _q.fromArray(pose.quaternion), _s.fromArray(pose.scale));
			_m.multiplyMatrices(c.parent.matrixWorld, _copy).premultiply(_inv).multiply(_rel);
			inst.setMatrixAt(i, _m);
		});
		inst.instanceMatrix.needsUpdate = true;
		inst.computeBoundingSphere();
	}
}

/**
 * Per frame (arrayTick): one set of instanced copies per array. Nothing here is sent or saved.
 * @param {any[]} carriers objects holding `userData.array` @param {any} root objectsGroup
 */
export function tickArrays(carriers, root) {
	visualParent = root?.parent ?? null;
	/** @type {Set<string>} */
	const alive = new Set();
	if (visualParent) {
		visualParent.updateWorldMatrix(true, false);
		for (const c of carriers) {
			if (!c.parent || !c.userData?.array) continue;
			alive.add(c.uuid);
			let e = entries.get(c.uuid);
			if (e && e.carrier !== c) {
				dropMeshes(e); // a replaced object under the same uuid (an override sync, an undo)
				e = undefined;
			}
			if (!e) {
				e = { carrier: c, key: '', recRef: null, rec: null, meshes: [], shape: '' };
				entries.set(c.uuid, e);
			}
			if (c.userData.array !== e.recRef) {
				e.recRef = c.userData.array;
				e.rec = normalizeArray(e.recRef);
			}
			c.updateWorldMatrix(true, true);
			const key = keyOf(e, root);
			if (key === e.key) continue;
			e.key = key;
			rebuild(e, root);
		}
	}
	for (const [uuid, e] of entries) {
		if (alive.has(uuid)) continue;
		dropMeshes(e);
		entries.delete(uuid);
	}
}

/** the debug read: {uuid: copies drawn} plus the draw calls it costs */
export function arraysDebug() {
	/** @type {Record<string, number>} */
	const copies = {};
	let draws = 0;
	for (const [uuid, e] of entries) {
		copies[uuid] = e.meshes[0]?.inst.count ?? 0;
		draws += e.meshes.length;
	}
	return { copies, draws };
}
