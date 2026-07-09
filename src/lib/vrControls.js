import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import {
	objectsGroup,
	lockedObjects,
	globalCamera,
	showGrid,
	vrMenuHand,
	vrMenuOpen,
	vrTransformMode,
	vrSnapAngle,
	selectedObject
} from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { undo, redo, recordTransform } from './history';
import { snapEnabled, snapSettings } from './snapping';
import { selectObject, topLevelObjectOf } from './objectActions';
import { sceneCommand } from './commandsHandler.svelte';
import { sendPing } from './ping';
import { suspendAnimation, resumeAnimation } from './flowRuntime';

// VR interactions (all gated on an active XR session):
// - A/X button on the menu hand toggles the quick-menu
// - trigger = select objects / activate menu tiles (Scene.svelte routes it)
// - squeeze = grab the pointed-at object: Move or Rotate mode follows the
//   controller; squeezing with BOTH hands scales by controller distance.
// Grabs broadcast the regular `move` message and record undo entries, so
// peers can't tell VR edits from desktop gizmo edits.

/** name of the hovered quick-menu tile (for highlight) @type {import('svelte/store').Writable<string|null>} */
export const vrHovered = writable(null);
/** the quick-menu THREE group, registered by VRMenu.svelte for raycasts @type {import('svelte/store').Writable<any>} */
export const vrMenuGroup = writable(null);

/** @type {any} */ let renderer = null;
/** @type {{menu?: boolean, squeeze?: boolean, stick?: boolean}[]} */
const previousButtons = [{}, {}];
const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();
const tempVector = new THREE.Vector3();

/** @type {any} single-hand grab: { object, index, prevPos, prevQuat, before } */
let grab = null;
/** @type {any} two-hand scale: { object, startDistance, startScale, before } */
let scaleGrab = null;
let lastMoveSent = 0;

// --- clarity pack: controller rays, hover highlight, snap turn ---
/** @type {any[]} */ let rayLines = [];
/** @type {any} */ let hoveredObject = null;
let hoveredEmissive = 0;
let snapArmed = true;

function ensureRayLines() {
	if (rayLines.length > 0 || !renderer) return;
	for (let i = 0; i < 2; i++) {
		const geometry = new THREE.BufferGeometry().setFromPoints([
			new THREE.Vector3(0, 0, 0),
			new THREE.Vector3(0, 0, -1)
		]);
		const line = new THREE.Line(
			geometry,
			new THREE.LineBasicMaterial({ color: 0x8ab4ff, transparent: true, opacity: 0.7 })
		);
		line.name = 'vr-ray';
		line.scale.z = 5;
		renderer.xr.getController(i).add(line);
		rayLines.push(line);
	}
}

function setHovered(object) {
	if (hoveredObject === object) return;
	// restore the previous highlight
	if (hoveredObject?.material?.emissive) hoveredObject.material.emissive.setHex(hoveredEmissive);
	hoveredObject = null;
	if (object) {
		// tint the first emissive-capable mesh in the subtree
		let target = null;
		object.traverse((/** @type {any} */ node) => {
			if (!target && node.material?.emissive) target = node;
		});
		if (target) {
			hoveredObject = target;
			hoveredEmissive = target.material.emissive.getHex();
			target.material.emissive.setHex(0x2f4f9f);
		}
	}
}

/** Rays follow hits, pointed object glows @param {boolean} presenting */
function updateRaysAndHover(presenting) {
	ensureRayLines();
	rayLines.forEach((line) => (line.visible = presenting));
	if (!presenting) {
		setHovered(null);
		return;
	}
	const group = get(objectsGroup);
	const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
	for (let i = 0; i < 2; i++) {
		let distance = 5;
		let hitObject = null;
		if (group) {
			const hits = controllerRay(i).intersectObjects(group.children, true);
			if (hits.length > 0) {
				distance = hits[0].distance;
				hitObject = topLevelObjectOf(hits[0].object);
			}
		}
		if (rayLines[i]) rayLines[i].scale.z = distance;
		if (i === pointerIndex) setHovered(get(vrMenuOpen) ? null : hitObject);
	}
}

/** Thumbstick flick on the pointer hand rotates the rig in snaps around the viewer */
function updateSnapTurn(session) {
	const pointerHand = get(vrMenuHand) === 'right' ? 'left' : 'right';
	const source = [...session.inputSources].find((s) => s.handedness === pointerHand);
	const x = source?.gamepad?.axes?.[2] ?? 0;
	if (Math.abs(x) < 0.4) {
		snapArmed = true;
		return;
	}
	if (!snapArmed || Math.abs(x) < 0.7) return;
	snapArmed = false;

	const frame = renderer.xr.getFrame?.();
	const space = renderer.xr.getReferenceSpace();
	const pose = frame?.getViewerPose?.(space);
	if (!pose || !space) return;
	const p = pose.transform.position;
	const angle = THREE.MathUtils.degToRad(get(vrSnapAngle)) * (x > 0 ? -1 : 1);
	const s = Math.sin(angle);
	const c = Math.cos(angle);
	// rotate the reference space about the viewer position (turn in place)
	const q = { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) };
	const t = { x: p.x - (c * p.x + s * p.z), y: 0, z: p.z - (-s * p.x + c * p.z) };
	renderer.xr.setReferenceSpace(space.getOffsetReferenceSpace(new XRRigidTransform(t, q)));
}

/** @param {any} r */
export function initVRControls(r) {
	renderer = r;
}

/** @param {'left'|'right'} handedness @returns {number} controller index or -1 */
function controllerIndexFor(handedness) {
	const session = renderer?.xr.getSession();
	if (!session) return -1;
	return [...session.inputSources].findIndex((source) => source.handedness === handedness);
}

/** @param {number} index */
function controllerRay(index) {
	const controller = renderer.xr.getController(index);
	tempMatrix.identity().extractRotation(controller.matrixWorld);
	raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
	raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
	return raycaster;
}

/** Raycast the quick-menu tiles @param {number} index @returns {string|null} tile action name */
export function raycastMenu(index) {
	const menu = get(vrMenuGroup);
	if (!menu || !get(vrMenuOpen)) return null;
	const hits = controllerRay(index).intersectObject(menu, true);
	const tile = hits.find((h) => h.object.name?.startsWith('vrmenu-'));
	return tile ? tile.object.name.slice('vrmenu-'.length) : null;
}

/** @param {any} object */
function transformStateOf(object) {
	return {
		pos: object.position.toArray(),
		rot: object.rotation.toArray(),
		scale: object.scale.toArray()
	};
}

/** @param {any} object @param {boolean=} force */
function broadcastMove(object, force = false) {
	const now = Date.now();
	if (!force && now - lastMoveSent < 50) return;
	lastMoveSent = now;
	/** @type {any} */
	const peer = get(peers);
	if (peer)
		peer.send({
			type: 'move',
			uuid: object.uuid,
			pos: object.position.toArray(),
			rot: object.rotation.toArray(),
			scale: object.scale.toArray()
		});
}

/** @param {any} object @param {any} before */
function endGrab(object, before) {
	broadcastMove(object, true);
	const after = transformStateOf(object);
	if (JSON.stringify(before) !== JSON.stringify(after))
		recordTransform({ uuid: object.uuid, before: before, after: after });
	resumeAnimation(object.uuid); // release spot becomes the new animation base
}

/** @param {number} index */
function onSqueezeStart(index) {
	if (!get(objectsGroup)) return;
	const hits = controllerRay(index).intersectObjects(get(objectsGroup).children, true);
	if (hits.length === 0) return;
	const object = topLevelObjectOf(hits[0].object);
	if (!object) return;
	if (get(lockedObjects).find((lock) => lock[1] === object.uuid)) return;

	if (grab && grab.object === object && grab.index !== index) {
		// second hand on the same object -> two-hand scale
		const distance = controllerDistance();
		scaleGrab = {
			object,
			startDistance: Math.max(distance, 0.05),
			startScale: object.scale.clone(),
			before: grab.before
		};
		grab = null;
		return;
	}

	suspendAnimation(object.uuid); // animated objects park at their base while held
	const controller = renderer.xr.getController(index);
	grab = {
		object,
		index,
		prevPos: controller.getWorldPosition(new THREE.Vector3()),
		prevQuat: controller.getWorldQuaternion(new THREE.Quaternion()),
		before: transformStateOf(object)
	};
	selectObject(object.uuid); // locks it for peers, updates selection state
}

/** @param {number} index */
function onSqueezeEnd(index) {
	if (scaleGrab) {
		endGrab(scaleGrab.object, scaleGrab.before);
		scaleGrab = null;
		return;
	}
	if (grab && grab.index === index) {
		endGrab(grab.object, grab.before);
		grab = null;
	}
}

function controllerDistance() {
	const a = renderer.xr.getController(0).getWorldPosition(new THREE.Vector3());
	const b = renderer.xr.getController(1).getWorldPosition(tempVector);
	return a.distanceTo(b);
}

const deltaQuat = new THREE.Quaternion();

function updateGrab() {
	const controller = renderer.xr.getController(grab.index);
	const position = controller.getWorldPosition(new THREE.Vector3());
	const quaternion = controller.getWorldQuaternion(new THREE.Quaternion());
	const object = grab.object;

	if (get(vrTransformMode) === 'rotate') {
		deltaQuat.copy(grab.prevQuat).invert().premultiply(quaternion);
		object.quaternion.premultiply(deltaQuat);
	} else {
		tempVector.copy(position).sub(grab.prevPos);
		object.position.add(tempVector);
		if (get(snapEnabled)) {
			const step = get(snapSettings).translate;
			object.position.x = Math.round(object.position.x / step) * step;
			object.position.z = Math.round(object.position.z / step) * step;
		}
	}
	grab.prevPos.copy(position);
	grab.prevQuat.copy(quaternion);
	objectsGroup.update((value) => value);
	broadcastMove(object);
}

function updateScaleGrab() {
	const factorRaw = controllerDistance() / scaleGrab.startDistance;
	let factor = factorRaw;
	if (get(snapEnabled)) {
		const step = get(snapSettings).scale;
		factor = Math.max(Math.round(factorRaw / step) * step, step);
	}
	scaleGrab.object.scale.copy(scaleGrab.startScale).multiplyScalar(factor);
	objectsGroup.update((value) => value);
	broadcastMove(scaleGrab.object);
}

/** Spawn a primitive ~2m in front of the VR camera and replicate its position */
/** @param {string} command */
function spawnPrimitive(command) {
	sceneCommand(command);
	const object = get(selectedObject);
	const camera = get(globalCamera);
	if (!object?.uuid || !camera) return;
	camera.getWorldDirection(tempVector);
	tempVector.y = 0;
	tempVector.normalize().multiplyScalar(2);
	const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
	object.position.set(cameraPosition.x + tempVector.x, object.position.y, cameraPosition.z + tempVector.z);
	objectsGroup.update((value) => value);
	broadcastMove(object, true);
}

/** Quick-menu tile actions @param {string} name */
export function executeVRMenuAction(name) {
	if (name === 'move' || name === 'rotate') vrTransformMode.set(name);
	else if (name === 'snap') snapEnabled.update((v) => !v);
	else if (name === 'grid') {
		showGrid.update((v) => !v);
		if (localStorage.getItem('showGrid')) localStorage.removeItem('showGrid');
		else localStorage.setItem('showGrid', 'false');
	} else if (name === 'undo') undo();
	else if (name === 'redo') redo();
	else if (name === 'box') spawnPrimitive('/create Box 1 1 1');
	else if (name === 'wedge') spawnPrimitive('/create Wedge 1 1 1');
	else if (name === 'stairs') spawnPrimitive('/create Stairs 1 1 1 4');
	else if (name === 'hand') {
		vrMenuHand.update((hand) => {
			const next = hand === 'right' ? 'left' : 'right';
			localStorage.setItem('vrMenuHand', next);
			return next;
		});
	} else if (name === 'close') vrMenuOpen.set(false);
}

/** Per-frame update while presenting (called from Scene's useTask) */
export function updateVRControls() {
	const session = renderer?.xr.getSession();
	updateRaysAndHover(!!session);
	if (!session) return;
	updateSnapTurn(session);

	[...session.inputSources].forEach((source, index) => {
		if (index > 1 || !source.gamepad) return;
		const buttons = source.gamepad.buttons;
		const prev = previousButtons[index];

		// A/X (or B/Y) on the menu hand toggles the quick-menu
		const menuPressed = !!(buttons[4]?.pressed || buttons[5]?.pressed);
		if (menuPressed && !prev.menu && source.handedness === get(vrMenuHand))
			vrMenuOpen.update((v) => !v);
		prev.menu = menuPressed;

		// squeeze grabs
		const squeezePressed = !!buttons[1]?.pressed;
		if (squeezePressed && !prev.squeeze) onSqueezeStart(index);
		if (!squeezePressed && prev.squeeze) onSqueezeEnd(index);
		prev.squeeze = squeezePressed;

		// thumbstick press pings the pointed spot
		const stickPressed = !!buttons[3]?.pressed;
		if (stickPressed && !prev.stick) {
			const ray = controllerRay(index);
			const group = get(objectsGroup);
			const hits = group ? ray.intersectObjects(group.children, true) : [];
			const point = hits[0]?.point ?? ray.ray.at(4, new THREE.Vector3());
			sendPing(point);
		}
		prev.stick = stickPressed;
	});

	if (scaleGrab) updateScaleGrab();
	else if (grab) updateGrab();

	// hover highlight for menu tiles (pointer = the non-menu hand)
	if (get(vrMenuOpen)) {
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		vrHovered.set(pointerIndex >= 0 ? raycastMenu(pointerIndex) : null);
	} else if (get(vrHovered) !== null) {
		vrHovered.set(null);
	}
}
