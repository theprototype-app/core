import { writable, derived, get } from 'svelte/store';
import * as THREE from 'three';
import { objectsGroup, orbitControls } from '../stores/sceneStore';
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

/**
 * The OrbitControls that belong to the PREVIEW camera while Control is on.
 * Deliberately its OWN store instead of binding the shared `orbitControls`:
 * threlte clears a bound ref when the component unmounts, and with both sets of
 * controls bound to one store the unmount could land AFTER the editor controls
 * remounted — leaving the store empty. Everything that suppresses orbiting
 * (notably the transform-gizmo drag) writes through that store, so an empty one
 * meant dragging the gizmo ALSO orbited the camera, for the rest of the session.
 * @type {import('svelte/store').Writable<any>}
 */
export const previewOrbit = writable(null);

/**
 * Kill the preview's controls for good. OrbitControls listens on the DOM, so an
 * instance that is merely dropped keeps steering whatever camera threlte points it
 * at — after a preview that is the EDITOR camera again, and since nothing knows
 * about it any more the gizmo-drag suppression can't switch it off. That zombie is
 * what made "move an object, the view spins" survive the first fix.
 */
export function releasePreviewOrbit() {
	disposeControls(get(previewOrbit));
	previewOrbit.set(null);
}

/** the editor's orbit TARGET when the preview took over, and the instance we
 *  disposed doing so — the controls REMOUNT on exit with a default target
 *  (0, 1.5, 0), which threw your look-at point back to the world origin (16-Q6) */
/** @type {any} */ let savedTarget = null;
/** @type {any} */ let staleControls = null;

/** Put the look-at point back once the editor's controls have REMOUNTED. */
function restoreEditorTarget() {
	const target = savedTarget;
	savedTarget = null;
	if (!target) return;
	let tries = 0;
	const tick = () => {
		const controls = /** @type {any} */ (get(orbitControls));
		// wait for the FRESH instance: the store still holds the disposed one until
		// Scene remounts <OrbitControls>
		if (controls?.target && controls !== staleControls) {
			controls.target.copy(target);
			controls.update?.();
			staleControls = null;
			return;
		}
		if (tries++ < 60) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}

/** three's dispose() only detaches listeners, so a double call is harmless
 * @param {any} controls */
function disposeControls(controls) {
	try {
		controls?.dispose?.();
	} catch {
		/* nothing to do — the point is that its listeners are gone */
	}
}

/** Whichever controls are actually steering the view right now. */
export const activeOrbit = derived([previewOrbit, orbitControls], ([preview, editor]) => preview ?? editor);

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
	// 16-Q6: remember WHERE YOU WERE LOOKING. These controls are about to unmount and
	// the pair that mounts on exit starts with the default target, which recentred the
	// view on the world origin.
	const editor = /** @type {any} */ (get(orbitControls));
	savedTarget = editor?.target?.clone?.() ?? null;
	staleControls = editor ?? null;
	// THE fix for "moving an object with the gizmo also rotates my view" (16-Q5).
	// Scene gates the editor's OrbitControls on this store, so they are about to
	// UNMOUNT — and threlte does not dispose them, so they keep their DOM listeners
	// and go on rotating the camera on every left-drag, invisible to the suppression
	// path (which only knows about the fresh instance that mounts after the preview).
	// Disposing them here is what makes the zombie impossible.
	disposeControls(get(orbitControls));
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
	releasePreviewOrbit(); // before the component unmounts, so no zombie survives
	setMarkerHidden(findCameraObject(current.uuid), false);
	cameraPreview.set(null);
	frustumSuppressed.set(null);
	broadcast(null);
	restoreEditorTarget(); // 16-Q6: your look-at point survives the round trip
}

/** Take the controls (or give them back). */
export function toggleCameraControl() {
	const current = get(cameraPreview);
	if (!current) return;
	if (current.controlling) {
		endControl();
		releasePreviewOrbit();
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

/**
 * Seat OrbitControls behind a camera WITHOUT moving it. OrbitControls.update()
 * ends with `camera.lookAt(target)`, and a fresh instance targets the world
 * origin — so mounting it on a camera that was looking elsewhere snapped the view
 * to (0,0,0) the moment Control was pressed (the "preview jumps" bug). Putting the
 * target on the camera's own forward axis first makes that lookAt a no-op.
 * @param {any} controls @param {any} camera @param {number} [distance]
 */
export function seatOrbitBehind(controls, camera, distance = 6) {
	if (!controls?.target || !camera) return;
	const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
	controls.target.copy(camera.position).add(forward.multiplyScalar(distance));
	controls.update?.();
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
