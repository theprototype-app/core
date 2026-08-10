import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { recordEntry } from './history';

// Per-object transform ORIGIN (17-D follow-up 3), stored as a LOCAL-space offset
// on `userData.origin`. This is 3ds Max's "affect pivot only" semantics: moving
// the origin does NOT move the mesh, it moves the point the tools transform
// AROUND. Absent (or all zeros) means the default — the object's own local zero,
// exactly how everything behaved before.
//
// Non-destructive on purpose. The alternative, baking the offset into vertices,
// goes through `meshgeo`, which stamps `faceEdited` and LOCKS the parametric
// Geometry rows: moving a Box's origin would cost you its width/height sliders
// forever, and a later param edit would rebuild the primitive centred on zero and
// silently discard the shift. Keeping it as data avoids both.
//
// It replicates and persists for free: `userData` rides object sync, GLTF extras
// and sessions (the `userData.physics` / `userData.camera` precedent), so an
// origin survives peers, save/load, duplicate, prefabs and .tpscene with no new
// wire message. glTF itself has no pivot concept, so an EXPORT has to bake it —
// see `bakeOriginForExport`.

/** @param {any} object @returns {number[]|null} local offset, null when default */
export function originOf(object) {
	const origin = object?.userData?.origin;
	if (!Array.isArray(origin) || origin.length !== 3) return null;
	return origin.every((n) => n === 0) ? null : origin.map(Number);
}

/** @param {any} object */
export function hasOrigin(object) {
	return !!originOf(object);
}

/** Where the origin sits in WORLD space (the object's own position when default).
 * @param {any} object @param {THREE.Vector3} [target] */
export function originWorld(object, target = new THREE.Vector3()) {
	if (!object) return target.set(0, 0, 0);
	const local = originOf(object);
	object.updateMatrixWorld?.(true);
	if (!local) return object.getWorldPosition(target);
	return target.fromArray(local).applyMatrix4(object.matrixWorld);
}

/** The object's LOCAL-space bounding box (geometry when it has one, else its
 * subtree measured in world and brought back). @param {any} object */
function localBounds(object) {
	if (object?.geometry) {
		object.geometry.computeBoundingBox?.();
		const box = object.geometry.boundingBox;
		if (box) return box.clone();
	}
	const world = new THREE.Box3().setFromObject(object);
	if (!isFinite(world.min.x)) return null;
	object.updateMatrixWorld?.(true);
	const inverse = object.matrixWorld.clone().invert();
	return world.clone().applyMatrix4(inverse);
}

/** Average vertex position in LOCAL space — the geometry median, which differs
 * from the box centre on lopsided meshes. Sampled on heavy meshes. @param {any} object */
function localMedian(object) {
	const position = object?.geometry?.attributes?.position;
	if (!position?.count) return null;
	const step = Math.max(1, Math.floor(position.count / 20000));
	const sum = new THREE.Vector3();
	let n = 0;
	for (let i = 0; i < position.count; i += step) {
		sum.x += position.getX(i);
		sum.y += position.getY(i);
		sum.z += position.getZ(i);
		n++;
	}
	return n ? sum.divideScalar(n) : null;
}

/**
 * The one write path — props history + replication + a poke, mirroring
 * `setPhysicsFor`. Pass null to clear (back to the object's own zero).
 * @param {string} uuid @param {number[]|null} local
 */
export function setOriginFor(uuid, local) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object) return null;
	const before = object.userData.origin ?? null;
	const next =
		local && !local.every((n) => n === 0) ? local.map((n) => Number(n.toFixed(6))) : null;
	if (next) object.userData.origin = next;
	else delete object.userData.origin;
	recordEntry({ kind: 'props', uuid, before: { origin: before }, after: { origin: next } });
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'objectParameters', parameter: 'origin', uuid, origin: next });
	objectsGroup.update((v) => v);
	return next;
}

/** Put the origin at a WORLD point (gizmo drop, picked vertex/face).
 * @param {string} uuid @param {any} worldPoint */
export function setOriginFromWorld(uuid, worldPoint) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object) return null;
	object.updateMatrixWorld(true);
	const local = new THREE.Vector3().copy(worldPoint).applyMatrix4(object.matrixWorld.clone().invert());
	return setOriginFor(uuid, local.toArray());
}

/** @param {string} uuid */
export function resetOrigin(uuid) {
	return setOriginFor(uuid, null);
}

/** The presets that actually get used in production. `bottom` is the one that
 * fixes imported props: it puts the pivot on the footprint so the model sits ON
 * the ground instead of floating or sinking.
 * @param {string} uuid @param {'bottom'|'center'|'median'|'world'|'children'} kind */
export function originPreset(uuid, kind) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object) return null;
	if (kind === 'world') {
		// the world zero expressed in the object's local space
		object.updateMatrixWorld(true);
		const local = new THREE.Vector3(0, 0, 0).applyMatrix4(object.matrixWorld.clone().invert());
		return setOriginFor(uuid, local.toArray());
	}
	if (kind === 'median') {
		const median = localMedian(object);
		return median ? setOriginFor(uuid, median.toArray()) : null;
	}
	if (kind === 'children') {
		// a group's pivot at the centre of what it contains
		const kids = object.children ?? [];
		if (!kids.length) return null;
		const world = new THREE.Box3();
		for (const child of kids) world.expandByObject(child);
		if (!isFinite(world.min.x)) return null;
		object.updateMatrixWorld(true);
		const local = world
			.getCenter(new THREE.Vector3())
			.applyMatrix4(object.matrixWorld.clone().invert());
		return setOriginFor(uuid, local.toArray());
	}
	const box = localBounds(object);
	if (!box) return null;
	const centre = box.getCenter(new THREE.Vector3());
	if (kind === 'bottom') centre.y = box.min.y;
	return setOriginFor(uuid, centre.toArray());
}

/**
 * Bake the offset for a GLTF/GLB export: glTF nodes carry only TRS, so a pivot
 * has to become real geometry. Called on a CLONE by the exporter path — never on
 * the live object, which would cost the parametric Geometry rows.
 * @param {any} root a clone about to be exported
 */
export function bakeOriginForExport(root) {
	root?.traverse?.((/** @type {any} */ object) => {
		const local = originOf(object);
		if (!local) return;
		const offset = new THREE.Vector3().fromArray(local);
		// everything the object owns shifts by -offset: its own geometry AND any
		// children, whose positions are relative to the origin being moved
		if (object.geometry) {
			object.geometry = object.geometry.clone();
			object.geometry.translate(-offset.x, -offset.y, -offset.z);
		}
		for (const child of object.children) child.position.sub(offset);
		// and the object itself moves by +offset in its PARENT frame: scale first,
		// then rotate (the other order lands it in the wrong place on a rotated or
		// non-uniformly scaled object)
		object.position.add(
			offset.clone().multiply(object.scale).applyQuaternion(object.quaternion)
		);
		delete object.userData.origin;
	});
	return root;
}
