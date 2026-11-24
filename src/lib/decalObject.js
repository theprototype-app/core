// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { normalizeDecal } from './decalCore.js';

// 102 M3: the DECAL CARRIER. A LEAF over three (decalEdit / commandsHandler / objectActions /
// the runtime call it; the textPathObject shape).
//
// The carrier is an ordinary mesh, a CHILD of the object it was placed on, holding
// `userData.decal`. It is a unit projector box (+Z out of the surface; its scale = width x height
// x depth). Its geometry is the HIT PROXY — the clipped target surface, rebuilt by decalRuntime —
// so clicks, VR rays, the selection outline and the object list treat it like any other mesh. Its
// own material draws nothing: what you see is a visual at the scene root that shares the
// geometry and is glued to the carrier every frame, so the image (an Explorer hash) never lands
// in a toJSON, an undo snapshot or a save.

/** the stand-in before the first build (and the shape every save and old build sees) */
export function decalPlaceholderGeometry() {
	const plane = new THREE.PlaneGeometry(1, 1);
	// baked: the toJSON path must carry plain vertices (customGeometryBuilders note)
	const g = new THREE.BufferGeometry().copy(plane);
	plane.dispose();
	return g;
}

/**
 * The proxy look: present for the raycaster and the outline pass, invisible on screen. Applied
 * again whenever the runtime meets a carrier (a GLTF round trip keeps opacity, drops colorWrite).
 * @param {any} object
 */
export function applyDecalProxyLook(object) {
	let m = object.material;
	if (!m || Array.isArray(m) || !m.isMeshBasicMaterial) {
		const old = m;
		m = object.material = new THREE.MeshBasicMaterial();
		if (old && !Array.isArray(old)) old.dispose?.();
	}
	if (m.colorWrite === false && m.depthWrite === false && m.opacity === 0 && m.transparent) return;
	m.transparent = true;
	m.opacity = 0;
	m.colorWrite = false;
	m.depthWrite = false;
	m.side = THREE.FrontSide;
	m.needsUpdate = true;
}

/**
 * Make `object` a decal carrier with this record (a fresh placement, a stamp, the agent).
 * @param {any} object @param {any} rec
 */
export function stampDecal(object, rec) {
	object.name = object.name && object.name !== 'Mesh' ? object.name : 'Decal';
	object.userData.decal = normalizeDecal(rec);
	// a sticker is not scenery you light or knock over
	object.castShadow = false;
	object.receiveShadow = false;
	object.userData.shadow = false;
	delete object.userData.physics;
	applyDecalProxyLook(object);
}

/** A new carrier mesh (not yet in the scene) @param {any} rec */
export function makeDecalCarrier(rec) {
	const mesh = new THREE.Mesh(decalPlaceholderGeometry(), new THREE.MeshBasicMaterial());
	stampDecal(mesh, rec);
	return mesh;
}

/**
 * Apply a record: the ONE place a decal's record changes (the write path, the remote applier and
 * undo). The runtime sees the new record by identity.
 * @param {any} object @param {any} raw
 */
export function applyDecalTo(object, raw) {
	const rec = normalizeDecal(raw);
	object.userData.decal = rec;
	return rec;
}
