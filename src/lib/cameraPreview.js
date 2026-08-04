import { writable, get } from 'svelte/store';
import * as THREE from 'three';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast, specatorMode } from '../stores/appStore';
import { recordTransformSet } from './history';
import { findCameraObject, cameraSpec } from './cameraObjects';
import { frustumSuppressed } from './cameraHelpers';

// 16-P5 preview mode: render the scene through a camera OBJECT for real (a true
// PerspectiveCamera/OrthographicCamera built from userData.camera — an ortho
// camera looks genuinely orthographic, and fov/near/far are exact). Store-only
// so any UI can reach it; `CameraPreview.svelte` mounts the actual camera and
// Outline.svelte follows the swap.
//
// CONTROL (user's ask): while previewing, "Control" hands the camera to the
// normal viewport navigation — WASD + mouse, exactly like flying the editor
// camera, because the preview camera becomes threlte's default camera AND owns
// the OrbitControls, which is what Scene's per-frame nav call already drives.
// Every controlled frame writes the pose back onto the MARKER (throttled `move`
// broadcasts), and ending control leaves ONE undo entry for the whole ride
// (the possess.js "one undo per ride" precedent).

/** @type {import('svelte/store').Writable<{uuid: string, controlling: boolean} | null>} */
export const cameraPreview = writable(null);

/** who else is previewing what: peerId -> uuid (replicated, presence-style)
 * @type {import('svelte/store').Writable<Record<string, string>>} */
export const cameraPreviews = writable({});

/** pose the marker had when Control began (for the single undo entry) */
/** @type {any} */
let controlBefore = null;
let lastBroadcast = 0;
/** the marker's own `visible` flag before we hid it for the preview */
/** @type {boolean | null} */
let markerWasVisible = null;

/** Looking THROUGH a camera means standing inside its body mesh — hide it while
 *  previewing (LOCAL only: `visible` is normally replicated, but this is our view,
 *  the same way spectator mode hides the avatar you're watching from).
 *  @param {any} object @param {boolean} hide */
function setMarkerHidden(object, hide) {
	if (!object) return;
	if (hide) {
		if (markerWasVisible === null) markerWasVisible = object.visible;
		object.visible = false;
	} else if (markerWasVisible !== null) {
		object.visible = markerWasVisible;
		markerWasVisible = null;
	}
	objectsGroup.update((value) => value);
}

/** Broadcast our preview state so peers can see (and join) it. @param {string|null} uuid */
function broadcast(uuid) {
	/** @type {any} */
	const peer = get(peers);
	if (peer?.peer?.id) peer.send({ type: 'campreview', peerId: peer.peer.id, uuid });
}

/** @param {string} uuid */
export function startCameraPreview(uuid) {
	const object = findCameraObject(uuid);
	if (!object) return false;
	if (get(specatorMode)) {
		showToast('Stop watching a peer before previewing a camera');
		return false;
	}
	// switching straight from another preview: restore that marker first
	const previous = get(cameraPreview);
	if (previous && previous.uuid !== uuid) setMarkerHidden(findCameraObject(previous.uuid), false);
	cameraPreview.set({ uuid, controlling: false });
	frustumSuppressed.set(uuid); // you are inside this frustum — hide its wireframe
	setMarkerHidden(object, true);
	broadcast(uuid);
	return true;
}

export function stopCameraPreview() {
	const current = get(cameraPreview);
	if (!current) return;
	if (current.controlling) endControl();
	setMarkerHidden(findCameraObject(current.uuid), false);
	cameraPreview.set(null);
	frustumSuppressed.set(null);
	broadcast(null);
}

/** Take the controls (or give them back). */
export function toggleCameraControl() {
	const current = get(cameraPreview);
	if (!current) return;
	if (current.controlling) {
		endControl();
		cameraPreview.set({ ...current, controlling: false });
		return;
	}
	const object = findCameraObject(current.uuid);
	if (!object) return;
	controlBefore = {
		position: object.position.toArray(),
		rotation: object.rotation.toArray(),
		scale: object.scale.toArray()
	};
	cameraPreview.set({ ...current, controlling: true });
	showToast('Flying the camera — WASD to move, drag to look, Exit when done');
}

/** Seal the ride: ONE undo entry + a final authoritative pose. */
function endControl() {
	const current = get(cameraPreview);
	const object = current ? findCameraObject(current.uuid) : null;
	if (!object || !controlBefore) {
		controlBefore = null;
		return;
	}
	const after = {
		position: object.position.toArray(),
		rotation: object.rotation.toArray(),
		scale: object.scale.toArray()
	};
	const moved =
		after.position.some((/** @type {number} */ v, /** @type {number} */ i) => Math.abs(v - controlBefore.position[i]) > 1e-4) ||
		after.rotation.some((/** @type {number} */ v, /** @type {number} */ i) => Math.abs(v - controlBefore.rotation[i]) > 1e-4);
	if (moved) {
		recordTransformSet([{ uuid: object.uuid, before: controlBefore, after }]);
		sendPose(object, true);
	}
	controlBefore = null;
}

const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const parentQuat = new THREE.Quaternion();
const inverse = new THREE.Matrix4();

/** Write a camera's world pose onto its marker (parent-aware).
 * @param {any} camera @param {any} object */
export function writeBackPose(camera, object) {
	if (!camera || !object) return false;
	tmpPos.copy(camera.position);
	tmpQuat.copy(camera.quaternion);
	const parent = object.parent;
	if (parent) {
		parent.updateWorldMatrix(true, false);
		inverse.copy(parent.matrixWorld).invert();
		tmpPos.applyMatrix4(inverse);
		parent.matrixWorld.decompose(new THREE.Vector3(), parentQuat, tmpScale);
		tmpQuat.premultiply(parentQuat.invert());
	}
	const moved = object.position.distanceToSquared(tmpPos) > 1e-10 || object.quaternion.angleTo(tmpQuat) > 1e-5;
	if (!moved) return false;
	object.position.copy(tmpPos);
	object.quaternion.copy(tmpQuat);
	object.updateMatrix();
	sendPose(object, false);
	return true;
}

/** @param {any} object @param {boolean} force bypass the throttle (final pose) */
function sendPose(object, force) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	const now = Date.now();
	if (!force && now - lastBroadcast < 100) return; // ~10Hz while flying
	lastBroadcast = now;
	peer.send({
		type: 'move',
		uuid: object.uuid,
		pos: object.position.toArray(),
		rot: object.rotation.toArray(),
		scale: object.scale.toArray()
	});
}

/** Remote peer started/stopped previewing. @param {any} data */
export function applyRemoteCameraPreview(data) {
	if (!data?.peerId) return;
	cameraPreviews.update((map) => {
		const next = { ...map };
		if (data.uuid) next[data.peerId] = data.uuid;
		else delete next[data.peerId];
		return next;
	});
}

/** A peer left: drop its preview state. @param {string} peerId */
export function clearPeerPreview(peerId) {
	cameraPreviews.update((map) => {
		if (!(peerId in map)) return map;
		const next = { ...map };
		delete next[peerId];
		return next;
	});
}

/** Tell a newly connected peer what we're previewing (handshake, send-on-open). */
export function sendCameraPreviewState() {
	const current = get(cameraPreview);
	if (current) broadcast(current.uuid);
}

/** Join what a peer is previewing (from the Users list). @param {string} peerId */
export function joinPeerPreview(peerId) {
	const uuid = get(cameraPreviews)[peerId];
	if (!uuid) return;
	if (!findCameraObject(uuid)) return showToast('That camera is no longer in the scene');
	startCameraPreview(uuid);
}

/** Name for the banner. @param {string} uuid */
export function previewLabel(uuid) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!object) return 'camera';
	const spec = cameraSpec(object);
	const name = object.name || 'Camera';
	// don't say "(ortho)" twice — the default ortho marker is already named that
	return spec.kind === 'orthographic' && !/ortho/i.test(name) ? name + ' (ortho)' : name;
}
