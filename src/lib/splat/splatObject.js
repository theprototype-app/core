// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { normalizeSplat } from './splatCore.js';

// 102-splats: the SPLAT CARRIER (a three leaf; the textPathObject shape).
//
// An ordinary mesh in objectsGroup holding `userData.splat`. Its geometry is a box over the scan's
// bounds (or its crop box) — the HIT PROXY: clicks, VR rays, the selection outline, the object list and
// the transform gizmo treat it like any other mesh. Its material draws nothing; the splats you see are a
// Spark mesh at the scene root that splatRuntime glues to it every frame. The proxy is see-through to
// the click (opacity 0 < selectThrough's threshold), so things inside a scanned room stay clickable and
// the splat takes a click only where nothing else is hit.

/** @param {any} o */
export function isSplatObject(o) {
	return !!(o?.isMesh && o.userData?.splat && typeof o.userData.splat === 'object');
}

/**
 * The box the carrier's geometry spans: the crop box when there is one, else the bounds.
 * @param {{bounds: number[], crop: number[] | null}} rec
 */
export function proxyBox(rec) {
	return rec.crop ?? rec.bounds;
}

/** a key for the box the geometry was built over, so a rebuild happens only when it changes @param {number[]} b */
const boxKey = (b) => b.map((x) => Math.round(x * 1e4)).join(',');

/**
 * A box geometry over `box` in the carrier's space (baked to plain vertices: the /create and GLTF
 * paths must carry real positions).
 * @param {number[]} box
 */
export function splatProxyGeometry(box) {
	const sx = Math.max(1e-3, box[3] - box[0]);
	const sy = Math.max(1e-3, box[4] - box[1]);
	const sz = Math.max(1e-3, box[5] - box[2]);
	const g = new THREE.BoxGeometry(sx, sy, sz);
	g.translate((box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2);
	g.userData.splatBox = boxKey(box);
	return g;
}

/**
 * The proxy look: present for the raycaster and the outline pass, invisible on screen. Re-applied
 * whenever the runtime meets a carrier (a GLTF round trip keeps opacity but drops colorWrite).
 * @param {any} object
 */
export function applySplatProxyLook(object) {
	let m = object.material;
	if (!m || Array.isArray(m) || !m.isMeshBasicMaterial) {
		const old = m;
		m = object.material = new THREE.MeshBasicMaterial();
		if (old && !Array.isArray(old)) old.dispose?.();
	}
	object.castShadow = false;
	object.receiveShadow = false;
	if (m.colorWrite === false && m.depthWrite === false && m.opacity === 0 && m.transparent) return;
	m.transparent = true;
	m.opacity = 0;
	m.colorWrite = false;
	m.depthWrite = false;
	m.needsUpdate = true;
}

/**
 * Write a record onto a carrier and keep its proxy box in step (a new crop or bounds rebuilds it).
 * @param {any} object @param {any} rec
 */
export function applySplatTo(object, rec) {
	const r = normalizeSplat(rec);
	object.userData.splat = r;
	const box = proxyBox(r);
	if (object.geometry?.userData?.splatBox !== boxKey(box)) {
		const old = object.geometry;
		object.geometry = splatProxyGeometry(box);
		old?.dispose?.();
	}
	applySplatProxyLook(object);
	return r;
}

/**
 * A fresh carrier for a splat file (local; the caller adds it through the ordinary import path,
 * which records the create and replicates it).
 * @param {any} rec @param {string} [name]
 */
export function makeSplatCarrier(rec, name = 'Splat') {
	const object = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
	object.name = name;
	applySplatTo(object, rec);
	// a scan is scenery: no physics body unless the author asks, never a shadow caster
	object.userData.shadow = false;
	return object;
}
