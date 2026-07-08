import * as THREE from 'three';
import { get } from 'svelte/store';
import { dropToSurface } from './snapping';
import { recordTransform } from './history';
import {
	objectsGroup,
	TControls,
	selectedObject,
	lockedObjects,
	globalCamera,
	orbitControls,
	isVRMode
} from '../stores/sceneStore';
import {
	peers,
	showSidebar,
	propertiesClose,
	lightPropertiesClose,
	specatorMode,
	showToast
} from '../stores/appStore';

// Shared object selection used by the object list, viewport clicks and VR rays.
// Mirrors the original Objects.svelte behavior: selecting an unlocked object
// attaches the gizmo and broadcasts a lock (peers replace this peer's previous
// lock, so switching selection moves the lock automatically).

/** @param {string} uuid @param {boolean} openProperties - force the properties drawer open (list ⚙️ behavior) */
export function selectObject(uuid, openProperties = false) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object) return;

	/** @type {any} */
	const controls = get(TControls);
	/** @type {any} */
	const peer = get(peers);
	const locked = get(lockedObjects);

	if (!locked.find((lockedUuid) => lockedUuid[1] === uuid)) {
		selectedObject.set(object);
		// the transform gizmo does not exist in VR mode
		if (controls && !get(isVRMode)) controls.attach(object);
		if (peer) peer.send({ type: 'lock', uuid: uuid, peerId: peer.peer.id });
	} else {
		if (controls && !get(isVRMode)) controls.detach();
		selectedObject.set(object);
	}

	// open or refresh the matching properties drawer
	if (openProperties || !get(propertiesClose) || !get(lightPropertiesClose)) {
		showSidebar(object.type.endsWith('Light') ? 'lightProperties' : 'properties');
	}
}

export function deselectObject() {
	/** @type {any} */
	const controls = get(TControls);
	if (controls && !get(isVRMode)) controls.detach();
	// selectedObject keeps the last object on purpose — open panels bind to
	// $selectedObject.position/material and would crash on an empty value
	propertiesClose.set(true);
	lightPropertiesClose.set(true);
}

/**
 * Walk an intersected mesh up to its top-level ancestor inside objectsGroup
 * @param {any} object
 */
export function topLevelObjectOf(object) {
	const group = get(objectsGroup);
	let current = object;
	while (current.parent && current.parent !== group) current = current.parent;
	return current.parent === group ? current : null;
}

/** Collect an object and all descendants in a stable depth-first order @param {any} object @param {any[]} list */
function collectTree(object, list = []) {
	list.push(object);
	object.children.forEach((/** @type {any} */ child) => collectTree(child, list));
	return list;
}

/** @param {any} clone - give cloned meshes their own materials (three's clone() shares them) */
function detachMaterials(clone) {
	collectTree(clone).forEach((node) => {
		if (node.material)
			node.material = Array.isArray(node.material)
				? node.material.map((/** @type {any} */ m) => m.clone())
				: node.material.clone();
	});
}

/**
 * Duplicate an object (Ctrl+D / context menu) and replicate the copy to peers.
 * Peers clone their own instance of the source, so no geometry re-export is needed.
 * @param {string=} uuid - defaults to the selected object
 */
export function duplicateObject(uuid) {
	const group = get(objectsGroup);
	const targetUuid = uuid ?? get(selectedObject)?.uuid;
	const source = targetUuid ? group?.getObjectByProperty('uuid', targetUuid) : null;
	if (!source) {
		showToast('Nothing selected to duplicate');
		return null;
	}
	const clone = source.clone(true);
	detachMaterials(clone);
	const cloneNodes = collectTree(clone);
	cloneNodes.forEach((node) => (node.uuid = crypto.randomUUID()));
	clone.name = (source.name || source.type) + ' copy';
	clone.position.x += 0.5;
	clone.position.z += 0.5;
	source.parent.add(clone);
	objectsGroup.update((value) => value);

	/** @type {any} */
	const peer = get(peers);
	if (peer)
		peer.send({
			type: 'duplicate',
			sourceUuid: source.uuid,
			uuids: cloneNodes.map((node) => node.uuid),
			name: clone.name,
			pos: clone.position.toArray()
		});

	selectObject(clone.uuid);
	return clone;
}

/**
 * Apply a duplicate made by a peer: clone the same source locally and assign
 * the uuids the originator generated (same depth-first order on both sides).
 * @param {string} sourceUuid @param {string[]} uuids @param {string} name @param {number[]} pos
 */
export function applyRemoteDuplicate(sourceUuid, uuids, name, pos) {
	const group = get(objectsGroup);
	const source = group?.getObjectByProperty('uuid', sourceUuid);
	if (!source) return;
	const clone = source.clone(true);
	detachMaterials(clone);
	collectTree(clone).forEach((node, index) => {
		if (uuids[index]) node.uuid = uuids[index];
	});
	clone.name = name;
	clone.position.fromArray(pos);
	source.parent.add(clone);
	objectsGroup.update((value) => value);
}

/** Toggle visibility and replicate (same message Properties uses) @param {string} uuid */
export function toggleObjectVisibility(uuid) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object) return;
	object.visible = !object.visible;
	objectsGroup.update((value) => value);
	/** @type {any} */
	const peer = get(peers);
	if (peer)
		peer.send({ type: 'objectParameters', parameter: 'visible', uuid: uuid, visible: object.visible });
}

/** Rename an object and replicate @param {string} uuid @param {string} name */
export function renameObject(uuid, name) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object || !name) return;
	object.name = name;
	objectsGroup.update((value) => value);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'name', uuid: uuid, name: name });
}

/**
 * One-shot "Align to ground": drop the selected object onto the surface below,
 * replicate and record an undoable history entry.
 * @param {string=} uuid - defaults to the selected object
 */
export function alignToGround(uuid) {
	const group = get(objectsGroup);
	const targetUuid = uuid ?? get(selectedObject)?.uuid;
	const object = targetUuid ? group?.getObjectByProperty('uuid', targetUuid) : null;
	if (!object) {
		showToast('Nothing selected to align');
		return;
	}
	const before = {
		pos: object.position.toArray(),
		rot: object.rotation.toArray(),
		scale: object.scale.toArray()
	};
	if (!dropToSurface(object, group)) return;
	const after = {
		pos: object.position.toArray(),
		rot: object.rotation.toArray(),
		scale: object.scale.toArray()
	};
	recordTransform({ uuid: object.uuid, before: before, after: after });
	objectsGroup.update((value) => value);
	/** @type {any} */
	const peer = get(peers);
	if (peer)
		peer.send({ type: 'move', uuid: object.uuid, pos: after.pos, rot: after.rot, scale: after.scale });
}

let focusAnimation = 0;

/**
 * Smoothly pan/zoom the editor camera to frame an object (F key).
 * @param {string=} uuid - defaults to the selected object
 */
export function focusObject(uuid) {
	if (get(specatorMode) || get(isVRMode)) return;
	const group = get(objectsGroup);
	const targetUuid = uuid ?? get(selectedObject)?.uuid;
	const object = targetUuid ? group?.getObjectByProperty('uuid', targetUuid) : null;
	if (!object) {
		showToast('Nothing selected to focus on');
		return;
	}
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const controls = get(orbitControls);
	if (!camera || !controls) return;

	const box = new THREE.Box3().setFromObject(object);
	const center = box.getCenter(new THREE.Vector3());
	const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.5);
	const fov = THREE.MathUtils.degToRad(camera.fov);
	const distance = THREE.MathUtils.clamp((radius / Math.tan(fov / 2)) * 1.2, 1, 200);

	// keep the current view direction: pan the target, dolly to framing distance
	const direction = camera.position.clone().sub(controls.target).normalize();
	const endPosition = center.clone().add(direction.multiplyScalar(distance));
	const startPosition = camera.position.clone();
	const startTarget = controls.target.clone();

	const duration = 400;
	const started = performance.now();
	const token = ++focusAnimation; // cancel a previous focus animation

	/** @param {number} now */
	function step(now) {
		if (token !== focusAnimation) return;
		const t = Math.min((now - started) / duration, 1);
		const ease = 1 - Math.pow(1 - t, 3);
		camera.position.lerpVectors(startPosition, endPosition, ease);
		controls.target.lerpVectors(startTarget, center, ease);
		controls.update();
		if (t < 1) requestAnimationFrame(step);
	}
	requestAnimationFrame(step);
}
