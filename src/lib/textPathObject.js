// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { TEXT_PATH_DEFAULTS, normalizeTextPath } from './textPathCore.js';

// 64 D2: the TEXT CARRIER (Add ▸ Text ▸ Text on a path). A LEAF over three
// (geometries.svelte.js / objectActions / commandsHandler call it, the flowPathObject shape).
//
// The carrier is an ordinary mesh in objectsGroup holding `userData.textPath`. Its geometry is
// the HIT PROXY — each glyph's quad sat on the path, rebuilt by textPathRuntime after every
// layout — so clicks, VR rays, the selection outline and the object list treat it like any
// other mesh. Its material draws nothing (the proxy look below); the letters you see are a
// troika text at the scene root that the runtime glues to it (golden rule 5).

/** the stand-in before the first layout lands (and on a peer that has not laid it out yet) */
export function textPlaceholderGeometry() {
	const plane = new THREE.PlaneGeometry(1.6, 0.4);
	// baked: the /create path's toJSON must carry plain vertices (customGeometryBuilders note)
	const g = new THREE.BufferGeometry().copy(plane);
	plane.dispose();
	return g;
}

/**
 * The proxy look: present for the raycaster and the outline pass, invisible on screen. Applied
 * again whenever the runtime meets a carrier, since a GLTF round trip keeps opacity but drops
 * colorWrite.
 * @param {any} object
 */
export function applyTextProxyLook(object) {
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
	m.side = THREE.DoubleSide;
	m.needsUpdate = true;
}

/**
 * Stamp a fresh text object (from the replicated /create, deterministic on every peer).
 * @param {any} object
 */
export function stampTextPath(object) {
	object.name = 'Text';
	object.userData.textPath = JSON.parse(JSON.stringify(TEXT_PATH_DEFAULTS));
	// letters are not scenery you light or knock over
	object.castShadow = false;
	object.receiveShadow = false;
	object.userData.shadow = false;
	applyTextProxyLook(object);
}

/**
 * Apply a record to an object: the ONE place a text object changes — the write path, the
 * remote applier and undo all call it. The runtime sees the new record by identity and lays it
 * out again (the troika half is asynchronous).
 * @param {any} object @param {any} raw @returns {import('./textPathCore.js').TextPathRecord}
 */
export function applyTextPathTo(object, raw) {
	const rec = normalizeTextPath(raw);
	object.userData.textPath = rec;
	return rec;
}
