import * as THREE from 'three';
import { get } from 'svelte/store';
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
