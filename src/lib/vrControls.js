import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import {
	objectsGroup,
	lockedObjects,
	globalCamera,
	globalScene,
	showGrid,
	vrMenuHand,
	vrMenuOpen,
	vrTransformMode,
	vrSnapAngle,
	selectedObject,
	isVRMode,
	worldRig,
	vrPassthrough,
	vrMenuHold,
	vrObjectsPanelOpen,
	vrChatPanelOpen,
	vrPaletteOpen,
	vrWireframeSelection,
	vrStatsOpen,
	vrGrabStyle,
	vrGrabbedHand
} from '../stores/sceneStore';
import { activeRing, findMenuEntry, ringEntries, sectorFromStick, pushRing, popRing, hubEntry } from './vrRadialMenu';
import { paletteColorAt, barValueAt } from './vrPalette';
import { recordMaterialChange } from './materialsHandler';
import { peers, showToast } from '../stores/appStore';
import { undo, redo, recordTransform } from './history';
import { snapEnabled, snapSettings } from './snapping';
import { selectObject, topLevelObjectOf } from './objectActions';
import { sceneCommand } from './commandsHandler.svelte';
import { sendPing } from './ping';
import { suspendAnimation, resumeAnimation } from './flowRuntime';
import { drawMode, toggleDrawMode, addStrokePoint, endStroke } from './drawMode';
import { setPttHeld, cycleMicMode, vrMicMode, micActive, pttActive } from './voiceChat';

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
/** the objects panel THREE group (101) @type {import('svelte/store').Writable<any>} */
export const vrPanelGroup = writable(null);
/** objects panel row CURSOR (109.4) — the stick moves it, press selects it */
export const vrPanelCursor = writable(0);
/** the cursored row's action id, published by VRObjectsPanel @type {import('svelte/store').Writable<string|null>} */
export const vrPanelCursorAction = writable(null);
let panelScrollAt = 0;

/** @type {any} */ let renderer = null;
/** @type {{menu?: boolean, squeeze?: boolean, stick?: boolean, trigger?: boolean, a?: boolean}[]} */
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

/**
 * Pure locomotion math (agreed VR map): left stick moves/strafes — toward the
 * aim direction when flying, horizontally otherwise; holding the left grip
 * switches the stick to the old pan/elevate behavior. Offsets follow the
 * reference-space convention used across this file (positive = viewer moves
 * along negative axis), matching the previous stick feel.
 * @param {{x: number, y: number, grip: boolean, flying: boolean, aimDir: {x:number,y:number,z:number}, cameraDir: {x:number,y:number,z:number}, speed?: number}} input
 */
export function computeMoveOffset({ x, y, grip, flying, aimDir, cameraDir, speed = 0.05 }) {
	const offset = { x: 0, y: 0, z: 0 };
	const dead = (v) => (Math.abs(v) > 0.15 ? v : 0);
	const sx = dead(x);
	const sy = dead(y);
	if (!sx && !sy) return offset;

	if (grip) {
		// pan/elevate (the old left-stick behavior)
		offset.x += speed * 2 * sx * cameraDir.z;
		offset.z += -speed * 2 * sx * cameraDir.x;
		offset.y += speed * 2 * sy;
		return offset;
	}

	// forward/back along the aim (fly) or the horizontal camera direction
	// (stick up = axes[3] negative = forward, same sign rule the old code used)
	const dir = flying ? aimDir : { x: cameraDir.x, y: 0, z: cameraDir.z };
	const length = Math.hypot(dir.x, dir.y, dir.z) || 1;
	const forward = { x: dir.x / length, y: dir.y / length, z: dir.z / length };
	offset.x += speed * sy * forward.x;
	offset.y += flying ? speed * sy * forward.y : 0;
	offset.z += speed * sy * forward.z;
	// strafe stays horizontal
	offset.x += speed * sx * cameraDir.z;
	offset.z += -speed * sx * cameraDir.x;
	return offset;
}

// --- teleport: hold the right stick UP = ballistic arc, release = blink ---

const arcRaycaster = new THREE.Raycaster();

/**
 * Sample a ballistic arc from origin along direction; lands on the ground
 * plane (y=0) or an upward-facing surface of a scene object.
 * @param {any} origin @param {any} direction @param {any=} group
 * @returns {{points: any[], target: any | null}}
 */
export function computeTeleportArc(origin, direction, group) {
	const speed = 8;
	const gravity = -9.8;
	const step = 1 / 12;
	const maxT = 2.5;
	const velocity = direction.clone().normalize().multiplyScalar(speed);
	const points = [origin.clone()];
	let previous = origin.clone();
	let target = null;

	for (let t = step; t <= maxT && !target; t += step) {
		const point = new THREE.Vector3(
			origin.x + velocity.x * t,
			origin.y + velocity.y * t + 0.5 * gravity * t * t,
			origin.z + velocity.z * t
		);
		if (group) {
			const segment = point.clone().sub(previous);
			const length = segment.length();
			arcRaycaster.set(previous, segment.normalize());
			arcRaycaster.far = length;
			const hits = arcRaycaster.intersectObjects(group.children, true);
			const landing = hits.find((hit) => {
				if (!hit.face) return false;
				const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
				return normal.y > 0.5; // only land on top-ish faces
			});
			if (landing) {
				target = landing.point.clone();
				points.push(target.clone());
				break;
			}
		}
		if (previous.y > 0 && point.y <= 0) {
			const k = previous.y / (previous.y - point.y);
			target = new THREE.Vector3(
				previous.x + (point.x - previous.x) * k,
				0,
				previous.z + (point.z - previous.z) * k
			);
			points.push(target.clone());
			break;
		}
		points.push(point.clone());
		previous = point;
	}
	return { points, target };
}

let teleportEngaged = false;
/** @type {any} */ let lastArc = null;
/** @type {any} */ let arcGroup = null;
/** @type {any} */ let arcLine = null;
/** @type {any} */ let arcDisc = null;
/** @type {any} */ let blinkSphere = null;

function ensureArcVisuals() {
	if (arcGroup) return;
	const scene = get(globalScene);
	if (!scene) return;
	arcGroup = new THREE.Group();
	arcGroup.name = 'teleport-arc';
	arcLine = new THREE.Line(
		new THREE.BufferGeometry(),
		new THREE.LineBasicMaterial({ color: 0x22cc66, transparent: true, opacity: 0.9, depthTest: false })
	);
	arcDisc = new THREE.Mesh(
		new THREE.CircleGeometry(0.35, 24),
		new THREE.MeshBasicMaterial({ color: 0x22cc66, transparent: true, opacity: 0.5, depthTest: false, side: THREE.DoubleSide })
	);
	arcDisc.rotation.x = -Math.PI / 2;
	arcGroup.add(arcLine, arcDisc);
	arcGroup.visible = false;
	scene.add(arcGroup);
}

/** @param {any[]} points @param {boolean} valid @param {any} target */
function showArc(points, valid, target) {
	ensureArcVisuals();
	if (!arcGroup) return;
	arcGroup.visible = true;
	arcLine.geometry.dispose();
	arcLine.geometry = new THREE.BufferGeometry().setFromPoints(points);
	const color = valid ? 0x22cc66 : 0xcc3344;
	arcLine.material.color.setHex(color);
	arcDisc.material.color.setHex(color);
	arcDisc.visible = !!target;
	if (target) arcDisc.position.set(target.x, target.y + 0.02, target.z);
}

function hideArc() {
	if (arcGroup) arcGroup.visible = false;
}

/** @param {any} target */
function executeTeleport(target) {
	const space = renderer?.xr.getReferenceSpace();
	if (!space) return;
	const viewer = renderer.xr.getCamera().getWorldPosition(new THREE.Vector3());
	// reference-space convention: offset = -(viewer displacement); height kept
	const t = { x: viewer.x - target.x, y: 0, z: viewer.z - target.z };
	renderer.xr.setReferenceSpace(space.getOffsetReferenceSpace(new XRRigidTransform(t)));
	// blink to soften the jump
	const camera = get(globalCamera);
	if (camera) {
		if (!blinkSphere) {
			blinkSphere = new THREE.Mesh(
				new THREE.SphereGeometry(0.2, 16, 12),
				new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 1, depthTest: false })
			);
			blinkSphere.renderOrder = 999;
		}
		blinkSphere.material.opacity = 1;
		blinkSphere.visible = true;
		camera.add(blinkSphere);
	}
	hapticPulse(0.4, 60);
}

/** @param {any} session */
function updateTeleport(session) {
	const sources = [...session.inputSources];
	const source = sources.find((s) => s.handedness === 'right');
	const x = source?.gamepad?.axes?.[2] ?? 0;
	const y = source?.gamepad?.axes?.[3] ?? 0;

	if (!teleportEngaged) {
		// stick pushed clearly UP and more up than sideways -> arm
		if (y < -0.7 && Math.abs(y) > Math.abs(x)) teleportEngaged = true;
		else {
			hideArc();
			return;
		}
	} else if (y > -0.4) {
		// released -> blink if we had a valid landing
		teleportEngaged = false;
		if (lastArc?.target) executeTeleport(lastArc.target);
		lastArc = null;
		hideArc();
		return;
	}

	const index = sources.indexOf(source);
	const controller = renderer.xr.getController(index);
	const origin = controller.getWorldPosition(new THREE.Vector3());
	const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(
		controller.getWorldQuaternion(new THREE.Quaternion())
	);
	lastArc = computeTeleportArc(origin, direction, get(objectsGroup));
	showArc(lastArc.points, !!lastArc.target, lastArc.target);
}

/** @type {any} */ let micHud = null;

/** Small camera-locked dot, top right: green = transmitting, grey = muted */
function updateMicHud(presenting) {
	const camera = get(globalCamera);
	if (!camera) return;
	if (!micHud) {
		micHud = new THREE.Mesh(
			new THREE.CircleGeometry(0.012, 16),
			new THREE.MeshBasicMaterial({ color: 0x555b66, transparent: true, opacity: 0.9, depthTest: false })
		);
		micHud.renderOrder = 998;
		micHud.position.set(0.28, 0.18, -0.8);
	}
	const show = presenting && get(vrMicMode) !== 'off';
	micHud.visible = show;
	if (show) {
		if (micHud.parent !== camera) camera.add(micHud);
		const transmitting = get(micActive) || get(pttActive);
		micHud.material.color.setHex(transmitting ? 0x22cc55 : 0x555b66);
	}
}

function updateBlink() {
	if (!blinkSphere || !blinkSphere.visible) return;
	blinkSphere.material.opacity -= 0.12;
	if (blinkSphere.material.opacity <= 0) {
		blinkSphere.visible = false;
		blinkSphere.parent?.remove(blinkSphere);
	}
}

/** Thumbstick flick on the RIGHT hand rotates the rig in snaps around the viewer */
function updateSnapTurn(session) {
	if (teleportEngaged) return; // the stick is busy aiming a teleport
	const source = [...session.inputSources].find((s) => s.handedness === 'right');
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

/**
 * Buzz the VR controllers if the session's gamepads support it (no-op on
 * desktop). Used by modules for press feedback.
 * @param {number} intensity 0..1 @param {number} durationMs
 */
export function hapticPulse(intensity = 0.5, durationMs = 50) {
	const session = renderer?.xr?.getSession?.();
	session?.inputSources?.forEach((source) => {
		const actuator = source.gamepad?.hapticActuators?.[0];
		actuator?.pulse?.(intensity, durationMs);
	});
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

/** Raycast the objects panel rows (101) @param {number} index @returns {string|null} panel action */
export function raycastPanel(index) {
	const panel = get(vrPanelGroup);
	if (!panel || !get(vrObjectsPanelOpen)) return null;
	const hits = controllerRay(index).intersectObject(panel, true);
	const row = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vrpanel-'));
	return row ? 'panel:' + row.object.name.slice('vrpanel-'.length) : null;
}

/** the palette THREE group (110) @type {import('svelte/store').Writable<any>} */
export const vrPaletteGroup = writable(null);

/** True when the controller ray lands on the palette (110) — the paint loop
 * owns that trigger, so trigger-select must not fire @param {number} index */
export function raycastPalette(index) {
	const palette = get(vrPaletteGroup);
	if (!palette || !get(vrPaletteOpen)) return false;
	const hits = controllerRay(index).intersectObject(palette, true);
	return hits.some((/** @type {any} */ h) => h.object.name?.startsWith('vrpalette-'));
}
/** the live lightness (bar) value @type {import('svelte/store').Writable<number>} */
export const vrPaletteLightness = writable(0.55);
let paintGesture = /** @type {any} */ (null);
let lastColorSent = 0;

/** Continuous palette painting while the trigger is held (110)
 * @param {number} index @param {boolean} triggerHeld */
function updatePalettePaint(index, triggerHeld) {
	const paletteGroup = get(vrPaletteGroup);
	const object = /** @type {any} */ (get(selectedObject));
	if (!paletteGroup || !object?.uuid || !object?.material?.color) {
		paintGesture = null;
		return;
	}
	if (!triggerHeld) {
		if (paintGesture) {
			// one undo entry + one final replicated color per pick gesture
			const after = '#' + object.material.color.getHexString();
			recordMaterialChange(object.uuid, 'color', null, paintGesture.before, after);
			/** @type {any} */ (get(peers))?.send({ type: 'color', uuid: object.uuid, color: after });
			paintGesture = null;
		}
		return;
	}
	const hits = controllerRay(index).intersectObject(paletteGroup, true);
	const hit = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vrpalette-'));
	if (!hit) return;
	if (hit.object.name === 'vrpalette-close') {
		vrPaletteOpen.set(false);
		paintGesture = null;
		return;
	}
	if (hit.object.name === 'vrpalette-bar') {
		vrPaletteLightness.set(barValueAt(hit.uv?.x ?? 0.5));
		return;
	}
	if (hit.object.name === 'vrpalette-disc') {
		const picked = paletteColorAt(hit.uv?.x ?? 0.5, hit.uv?.y ?? 0.5, get(vrPaletteLightness));
		if (!picked) return;
		if (!paintGesture)
			paintGesture = { before: '#' + object.material.color.getHexString() };
		object.material.color.set(picked.hex);
		const now = Date.now();
		if (now - lastColorSent > 120) {
			lastColorSent = now;
			/** @type {any} */ (get(peers))?.send({ type: 'color', uuid: object.uuid, color: picked.hex });
		}
	}
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

/** @type {{index: number, prev: any} | null} right-grip drag-the-world pan */
let worldPan = null;

// ---- world grab (71): BOTH grips in empty air scale/rotate/pan the world ---
// The gesture transforms the world-grab-rig LOCALLY (peers see nothing —
// broadcasts stay in objectsGroup-local coords, which never change here).

const WORLD_SCALE_MIN = 0.05;
const WORLD_SCALE_MAX = 20;

const emptyAirSqueeze = [false, false];
/** @type {{a0: any, b0: any, rig0: {pos: any, quat: any, scale: number}} | null} */
let worldGrab = null;

/** current uniform world scale (1 outside a grab / on desktop) */
export function worldScale() {
	return get(worldRig)?.scale.x ?? 1;
}

/** Snap the world back to 1:1 (quick-menu tile + VR session end) */
export function resetWorldRig() {
	const rig = get(worldRig);
	if (!rig) return;
	rig.position.set(0, 0, 0);
	rig.quaternion.identity();
	rig.scale.set(1, 1, 1);
	rig.updateMatrixWorld(true);
}

/**
 * Pure gesture math (headless-testable): given both hands' start/current
 * positions and the rig's start state, produce the rig transform that keeps
 * the world point between the hands glued to them while scaling by the
 * hands' distance ratio and yawing by the hands' axis rotation.
 * @param {{a: number[], b: number[]}} start
 * @param {{a: number[], b: number[]}} now
 * @param {{pos: number[], quat: number[], scale: number}} rig0
 */
export function computeWorldGrabTransform(start, now, rig0) {
	const a0 = new THREE.Vector3().fromArray(start.a);
	const b0 = new THREE.Vector3().fromArray(start.b);
	const a = new THREE.Vector3().fromArray(now.a);
	const b = new THREE.Vector3().fromArray(now.b);
	const mid0 = a0.clone().add(b0).multiplyScalar(0.5);
	const mid = a.clone().add(b).multiplyScalar(0.5);
	const d0 = Math.max(a0.distanceTo(b0), 0.05);
	const d = Math.max(a.distanceTo(b), 0.001);
	// clamp the TOTAL scale, then work with the relative ratio
	const total = THREE.MathUtils.clamp(rig0.scale * (d / d0), WORLD_SCALE_MIN, WORLD_SCALE_MAX);
	const ratio = total / rig0.scale;
	// yaw from the hands' axis on the ground plane (angle0 - angleNow, +Y up)
	const angle0 = Math.atan2(b0.z - a0.z, b0.x - a0.x);
	const angle = Math.atan2(b.z - a.z, b.x - a.x);
	const yaw = angle0 - angle;
	const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
	const quat0 = new THREE.Quaternion().fromArray(rig0.quat);
	// rig' = T(mid) · R(yaw) · S(ratio) · T(-mid0) applied to the rig's start
	const pos = new THREE.Vector3()
		.fromArray(rig0.pos)
		.sub(mid0)
		.multiplyScalar(ratio)
		.applyQuaternion(qYaw)
		.add(mid);
	return {
		pos: pos.toArray(),
		quat: qYaw.multiply(quat0).toArray(),
		scale: total
	};
}

function beginWorldGrab() {
	const rig = get(worldRig);
	if (!rig) return;
	worldPan = null; // the two-hand gesture replaces the single-hand pan
	worldGrab = {
		a0: renderer.xr.getController(0).getWorldPosition(new THREE.Vector3()),
		b0: renderer.xr.getController(1).getWorldPosition(new THREE.Vector3()),
		rig0: { pos: rig.position.toArray(), quat: rig.quaternion.toArray(), scale: rig.scale.x }
	};
}

function updateWorldGrab() {
	const rig = get(worldRig);
	if (!rig || !worldGrab) return;
	const a = renderer.xr.getController(0).getWorldPosition(new THREE.Vector3());
	const b = renderer.xr.getController(1).getWorldPosition(tempVector);
	const next = computeWorldGrabTransform(
		{ a: worldGrab.a0.toArray(), b: worldGrab.b0.toArray() },
		{ a: a.toArray(), b: b.toArray() },
		worldGrab.rig0
	);
	rig.position.fromArray(next.pos);
	rig.quaternion.fromArray(next.quat);
	rig.scale.setScalar(next.scale);
	rig.updateMatrixWorld(true);
}

/** convert a real-space delta vector into rig-local (grabbed objects live there) */
function realDeltaToRigLocal(vector) {
	const rig = get(worldRig);
	if (!rig) return vector;
	return vector.applyQuaternion(rig.quaternion.clone().invert()).divideScalar(rig.scale.x);
}

/**
 * Which top-level object contains a world point (100.3): grabbing with the
 * controller INSIDE an object needs no pointer. Exported for headless tests.
 * @param {any} point THREE.Vector3 @param {any} group objectsGroup
 */
export function containedTopLevel(point, group) {
	if (!group) return null;
	const box = new THREE.Box3();
	for (const child of group.children) {
		box.setFromObject(child);
		if (isFinite(box.min.x) && box.containsPoint(point)) return child;
	}
	return null;
}

/** @param {number} index */
function onSqueezeStart(index) {
	if (!get(objectsGroup)) return;
	const controller = renderer.xr.getController(index);
	const hits = controllerRay(index).intersectObjects(get(objectsGroup).children, true);
	let object = hits.length ? topLevelObjectOf(hits[0].object) : null;
	if (!object) {
		// hand inside an object grabs it without a pointer (100.3)
		object = containedTopLevel(controller.getWorldPosition(new THREE.Vector3()), get(objectsGroup));
	}
	if (!object) {
		emptyAirSqueeze[index] = true;
		// both hands gripping air -> world grab (zoom/rotate/pan the world)
		if (emptyAirSqueeze[0] && emptyAirSqueeze[1]) {
			beginWorldGrab();
			return;
		}
		// gripping air with the RIGHT hand pans the world with the controller
		const session = renderer?.xr.getSession();
		const handedness = session ? [...session.inputSources][index]?.handedness : null;
		if (handedness === 'right')
			worldPan = { index, prev: renderer.xr.getController(index).getWorldPosition(new THREE.Vector3()) };
		return;
	}
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
		vrGrabbedHand.set(null);
		return;
	}

	suspendAnimation(object.uuid); // animated objects park at their base while held
	const cPos = controller.getWorldPosition(new THREE.Vector3());
	const cQuat = controller.getWorldQuaternion(new THREE.Quaternion());
	// rigid attach (100): the object's pose RELATIVE to the controller, in the
	// object's parent space, stays constant while held — like a skewer
	object.parent.updateMatrixWorld(true);
	const parentQuat = object.parent.getWorldQuaternion(new THREE.Quaternion());
	const parentInv = object.parent.matrixWorld.clone().invert();
	const pPos = cPos.clone().applyMatrix4(parentInv);
	const pQuat = parentQuat.clone().invert().multiply(cQuat);
	grab = {
		object,
		index,
		style: get(vrGrabStyle),
		relPos: object.position.clone().sub(pPos).applyQuaternion(pQuat.clone().invert()),
		relQuat: pQuat.clone().invert().multiply(object.quaternion),
		startScale: object.scale.clone(),
		scaleFactor: 1,
		prevPos: cPos,
		prevQuat: cQuat,
		before: transformStateOf(object)
	};
	const session = renderer?.xr.getSession();
	vrGrabbedHand.set(session ? ([...session.inputSources][index]?.handedness ?? null) : null);
	hapticPulse(0.25, 30);
	selectObject(object.uuid); // locks it for peers, updates selection state
}

/** @param {number} index */
function onSqueezeEnd(index) {
	emptyAirSqueeze[index] = false;
	if (worldGrab) {
		// releasing either grip ends the world gesture; a still-held RIGHT grip
		// resumes the single-hand world pan without re-squeezing
		worldGrab = null;
		const other = index === 0 ? 1 : 0;
		if (emptyAirSqueeze[other]) {
			const session = renderer?.xr.getSession();
			const handedness = session ? [...session.inputSources][other]?.handedness : null;
			if (handedness === 'right')
				worldPan = { index: other, prev: renderer.xr.getController(other).getWorldPosition(new THREE.Vector3()) };
		}
		return;
	}
	if (worldPan?.index === index) worldPan = null;
	if (scaleGrab) {
		endGrab(scaleGrab.object, scaleGrab.before);
		scaleGrab = null;
		return;
	}
	if (grab && grab.index === index) {
		endGrab(grab.object, grab.before);
		grab = null;
		vrGrabbedHand.set(null);
		hapticPulse(0.18, 24);
	}
}

function controllerDistance() {
	const a = renderer.xr.getController(0).getWorldPosition(new THREE.Vector3());
	const b = renderer.xr.getController(1).getWorldPosition(tempVector);
	return a.distanceTo(b);
}

const deltaQuat = new THREE.Quaternion();

/**
 * Pure rigid-grab pose (100): controller pose in the object's parent space +
 * the constant relative offset -> object pose. Exported for headless tests.
 * @param {any} pPos controller position (parent space) @param {any} pQuat controller quaternion (parent space)
 * @param {any} relPos @param {any} relQuat
 */
export function rigidGrabPose(pPos, pQuat, relPos, relQuat) {
	return {
		position: pPos.clone().add(relPos.clone().applyQuaternion(pQuat)),
		quaternion: pQuat.clone().multiply(relQuat)
	};
}

/**
 * One frame of stick input while gripping (100.2): forward/back reels the
 * relative distance, left/right scales. Pure + clamped.
 * @param {{length: number, scale: number, x: number, y: number}} input
 */
export function grabStickAdjust({ length, scale, x, y }) {
	const dead = (/** @type {number} */ v) => (Math.abs(v) > 0.15 ? v : 0);
	const reel = dead(y);
	const grow = dead(x);
	return {
		// stick forward (y negative in xr-standard) pushes the object AWAY,
		// pulling back reels it in
		length: Math.min(Math.max(length * (1 - reel * 0.03), 0.05), 60),
		scale: Math.min(Math.max(scale * (1 + grow * 0.025), 0.02), 25)
	};
}

function updateGrab() {
	const controller = renderer.xr.getController(grab.index);
	const position = controller.getWorldPosition(new THREE.Vector3());
	const quaternion = controller.getWorldQuaternion(new THREE.Quaternion());
	const object = grab.object;

	if (grab.style === 'rigid') {
		// controller-as-handle (100): the object keeps its grab-start offset and
		// follows position AND rotation 1:1; the grab hand's stick reels + scales
		object.parent.updateMatrixWorld(true);
		const parentQuat = object.parent.getWorldQuaternion(new THREE.Quaternion());
		const parentInv = object.parent.matrixWorld.clone().invert();
		const pPos = position.clone().applyMatrix4(parentInv);
		const pQuat = parentQuat.clone().invert().multiply(quaternion);

		const session = renderer?.xr.getSession();
		const axes = session ? ([...session.inputSources][grab.index]?.gamepad?.axes ?? []) : [];
		const adjusted = grabStickAdjust({
			length: Math.max(grab.relPos.length(), 0.05),
			scale: grab.scaleFactor,
			x: axes[2] ?? 0,
			y: axes[3] ?? 0
		});
		if (grab.relPos.lengthSq() > 1e-8) grab.relPos.setLength(adjusted.length);
		if (adjusted.scale !== grab.scaleFactor) {
			grab.scaleFactor = adjusted.scale;
			object.scale.copy(grab.startScale).multiplyScalar(grab.scaleFactor);
		}

		const pose = rigidGrabPose(pPos, pQuat, grab.relPos, grab.relQuat);
		object.position.copy(pose.position);
		object.quaternion.copy(pose.quaternion);
		if (get(snapEnabled)) {
			const step = get(snapSettings).translate;
			object.position.x = Math.round(object.position.x / step) * step;
			object.position.z = Math.round(object.position.z / step) * step;
		}
		grab.prevPos.copy(position);
		grab.prevQuat.copy(quaternion);
		objectsGroup.update((value) => value);
		broadcastMove(object);
		return;
	}

	// legacy gizmo-style grabs (vrGrabStyle 'move' / 'rotate')
	if (grab.style === 'rotate') {
		deltaQuat.copy(grab.prevQuat).invert().premultiply(quaternion);
		// under a grabbed world (71) the hand delta converts into rig-local
		const rig = get(worldRig);
		if (rig) {
			const rigQuat = rig.quaternion;
			deltaQuat.premultiply(rigQuat.clone().invert()).multiply(rigQuat);
		}
		object.quaternion.premultiply(deltaQuat);
	} else {
		tempVector.copy(position).sub(grab.prevPos);
		realDeltaToRigLocal(tempVector); // 1:1 when the world is unscaled
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
	// spawn point is a REAL-space spot 2m ahead; convert into the (possibly
	// grabbed/scaled) world before writing objectsGroup-local coords
	const spawn = new THREE.Vector3(
		cameraPosition.x + tempVector.x,
		object.position.y,
		cameraPosition.z + tempVector.z
	);
	const group = get(objectsGroup);
	if (group) {
		group.updateMatrixWorld(true);
		const local = group.worldToLocal(spawn.clone());
		object.position.set(local.x, object.position.y, local.z);
	} else {
		object.position.set(spawn.x, object.position.y, spawn.z);
	}
	objectsGroup.update((value) => value);
	broadcastMove(object, true);
}

/** Radial-menu sector actions (74): navigation + registry first, then the
 * built-in switch @param {string} name */
export function executeVRMenuAction(name) {
	// ring navigation + close (109: a STACK — Back pops one level)
	if (name === 'close') {
		vrMenuOpen.set(false);
		return;
	}
	if (name === 'back') {
		popRing();
		return;
	}
	if (name.startsWith('nav:')) {
		pushRing(name.slice(4));
		return;
	}
	if (name === 'chat') {
		// the VR chat panel (117) replaces the ring on screen
		vrChatPanelOpen.update((v) => !v);
		vrObjectsPanelOpen.set(false);
		vrPaletteOpen.set(false);
		vrMenuOpen.set(false);
		return;
	}
	if (name === 'obj:color') {
		// the continuous palette (110) replaces the ring on screen
		vrPaletteOpen.set(true);
		vrObjectsPanelOpen.set(false);
		vrChatPanelOpen.set(false);
		vrMenuOpen.set(false);
		return;
	}
	if (name === 'wireframe') {
		vrWireframeSelection.update((v) => {
			const next = !v;
			try {
				localStorage.setItem('vrWireframe', String(next));
			} catch {}
			return next;
		});
		return;
	}
	if (name === 'palette:close') {
		vrPaletteOpen.set(false);
		return;
	}
	// registry entries carry their own action (env presets, mic modes, object
	// ops, color swatches, module-registered entries)
	const entry = findMenuEntry(name);
	if (entry?.action) {
		entry.action();
		if (entry.closes) vrMenuOpen.set(false);
		return;
	}
	if (name.startsWith('panel:')) {
		// objects panel actions (101)
		if (name === 'panel:close') vrObjectsPanelOpen.set(false);
		else if (name.startsWith('panel:select:')) {
			selectObject(name.slice('panel:select:'.length));
			vrObjectsPanelOpen.set(false);
			hapticPulse(0.3, 40);
		}
		return;
	}
	if (name === 'move' || name === 'rotate') vrTransformMode.set(name);
	else if (name === 'objects') {
		// the native VR list panel (101) replaces the menu on screen
		vrObjectsPanelOpen.update((v) => !v);
		vrPaletteOpen.set(false);
		vrMenuOpen.set(false);
	} else if (name === 'stats') {
		vrStatsOpen.update((v) => {
			const next = !v;
			try {
				localStorage.setItem('vrStats', String(next));
			} catch {}
			return next;
		});
	} else if (name === 'grabmode') {
		// cycle the grip style (100): rigid (default) -> legacy move -> legacy rotate
		const order = ['rigid', 'move', 'rotate'];
		const next = order[(order.indexOf(get(vrGrabStyle)) + 1) % order.length];
		vrGrabStyle.set(next);
		try {
			localStorage.setItem('vrGrabStyle', next);
		} catch {}
		showToast(
			next === 'rigid'
				? 'Grab: rigid (controller is the handle — stick reels + scales)'
				: 'Grab: legacy ' + next
		);
	} else if (name === 'snap') snapEnabled.update((v) => !v);
	else if (name === 'grid') {
		showGrid.update((v) => !v);
		if (localStorage.getItem('showGrid')) localStorage.removeItem('showGrid');
		else localStorage.setItem('showGrid', 'false');
	} else if (name === 'undo') undo();
	else if (name === 'redo') redo();
	else if (name === 'box') spawnPrimitive('/create Box 1 1 1');
	else if (name === 'wedge') spawnPrimitive('/create Wedge 1 1 1');
	else if (name === 'stairs') spawnPrimitive('/create Stairs 1 1 1 4');
	else if (name === 'sphere') spawnPrimitive('/create Sphere 0.7');
	else if (name === 'cylinder') spawnPrimitive('/create Cylinder 0.5 0.5 1');
	else if (name === 'torus') spawnPrimitive('/create Torus 0.6 0.25');
	else if (name === 'hand') {
		vrMenuHand.update((hand) => {
			const next = hand === 'right' ? 'left' : 'right';
			localStorage.setItem('vrMenuHand', next);
			return next;
		});
	} else if (name === 'draw') {
		toggleDrawMode();
		vrMenuOpen.set(false);
	} else if (name === 'mic') {
		cycleMicMode();
	} else if (name === 'world') {
		resetWorldRig(); // back to 1:1 mid-session
	} else if (name === 'passthru') {
		// WebXR can't hot-swap session modes — the preference applies next entry
		const next = !get(vrPassthrough);
		vrPassthrough.set(next);
		try {
			localStorage.setItem('vrPassthrough', String(next));
		} catch {}
		showToast('Passthrough ' + (next ? 'on' : 'off') + ' — takes effect on the next VR entry');
	} else if (name === 'exitvr') {
		vrMenuOpen.set(false);
		isVRMode.set(false);
		renderer?.xr?.getSession?.()?.end();
	} else if (name === 'close') vrMenuOpen.set(false);
}

/** Right-stick click: ping where the controller ray lands (87.6) @param {number} index */
function pingFromController(index) {
	const point = pingPointFromRay(controllerRay(index), get(objectsGroup));
	if (!point) return;
	sendPing(point);
	hapticPulse(0.4, 60);
}

/**
 * Where a controller ray pings: the first object hit, else where it meets the
 * ground plane, else nowhere (aiming at the sky). Exported for headless tests.
 * @param {THREE.Raycaster} ray @param {any} group @returns {THREE.Vector3 | null}
 */
export function pingPointFromRay(ray, group) {
	const hits = group ? ray.intersectObjects(group.children, true) : [];
	if (hits[0]) return hits[0].point;
	const planePoint = new THREE.Vector3();
	return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), planePoint)
		? planePoint
		: null;
}

/** Per-frame update while presenting (called from Scene's useTask) */
export function updateVRControls() {
	const session = renderer?.xr.getSession();
	updateRaysAndHover(!!session);
	updateBlink();
	updateMicHud(!!session);
	if (!session) {
		hideArc();
		teleportEngaged = false;
		return;
	}
	// open menu/panel are modal for the sticks: sector nav / scrolling own them;
	// a RIGHT-hand grab owns the right stick too (reel/scale beats teleport, 100)
	if (!get(vrMenuOpen) && !get(vrObjectsPanelOpen) && get(vrGrabbedHand) !== 'right') {
		updateTeleport(session);
		updateSnapTurn(session);
	}

	[...session.inputSources].forEach((source, index) => {
		if (index > 1 || !source.gamepad) return;
		const buttons = source.gamepad.buttons;
		const prev = previousButtons[index];

		// B/Y on the menu hand: toggle the radial menu, or (hold mode, 74) hold
		// to show + release over a sector to activate it
		const menuPressed = !!buttons[5]?.pressed;
		if (source.handedness === get(vrMenuHand)) {
			if (get(vrMenuHold)) {
				if (menuPressed && !prev.menu) {
					vrObjectsPanelOpen.set(false); // ring replaces the panel (101)
					vrPaletteOpen.set(false);
					vrMenuOpen.set(true);
				}
				if (!menuPressed && prev.menu) {
					const hovered = get(vrHovered);
					vrMenuOpen.set(false);
					if (hovered) executeVRMenuAction(hovered);
				}
			} else if (menuPressed && !prev.menu) {
				vrObjectsPanelOpen.set(false);
				vrPaletteOpen.set(false);
				vrMenuOpen.update((v) => !v);
			}
		}
		prev.menu = menuPressed;


		// right A held = push-to-talk
		const aPressed = !!buttons[4]?.pressed;
		if (source.handedness === 'right' && aPressed !== !!prev.a) setPttHeld(aPressed);
		prev.a = aPressed;

		// squeeze grabs
		const squeezePressed = !!buttons[1]?.pressed;
		if (squeezePressed && !prev.squeeze) onSqueezeStart(index);
		if (!squeezePressed && prev.squeeze) onSqueezeEnd(index);
		prev.squeeze = squeezePressed;

		// thumbstick CLICK (buttons[3] — the press, not the axes): with the menu
		// open it activates the hovered sector (74); otherwise the RIGHT stick
		// pings the pointed spot with the v2 visual/chime + a haptic tick (87.6)
		const stickPressed = !!buttons[3]?.pressed;
		if (stickPressed && !prev.stick) {
			if (get(vrMenuOpen)) {
				// activate the hovered sector; a centered stick presses the HUB
				// (the 'middle option', 109)
				const hovered = get(vrHovered);
				if (hovered) executeVRMenuAction(hovered);
				else
					executeVRMenuAction(
						hubEntry(get(activeRing), !!(/** @type {any} */ (get(selectedObject))?.uuid)).id
					);
			} else if (get(vrObjectsPanelOpen)) {
				// ray hover wins; otherwise the row cursor's action (109.4)
				const action = get(vrHovered) ?? get(vrPanelCursorAction);
				if (action) executeVRMenuAction(action);
			} else if (source.handedness === 'right') pingFromController(index);
		}
		prev.stick = stickPressed;

		// draw mode: holding the trigger draws at the controller tip
		const triggerPressed = !!buttons[0]?.pressed;
		if (get(drawMode)) {
			if (triggerPressed)
				addStrokePoint(renderer.xr.getController(index).getWorldPosition(new THREE.Vector3()));
			if (!triggerPressed && prev.trigger) endStroke();
		}
		// continuous palette painting (110): hold the trigger over the disc
		if (get(vrPaletteOpen) && source.handedness !== get(vrMenuHand))
			updatePalettePaint(index, triggerPressed);
		prev.trigger = triggerPressed;
	});

	if (scaleGrab) updateScaleGrab();
	else if (grab) updateGrab();

	// both-grips world grab (71): scale/rotate/pan the rig around the hands
	if (worldGrab) updateWorldGrab();

	// drag-the-world: the grabbed spot follows the hand (prev stays fixed at
	// grab start — the applied offset self-corrects the measured delta)
	if (worldPan) {
		const current = renderer.xr.getController(worldPan.index).getWorldPosition(new THREE.Vector3());
		const delta = current.sub(worldPan.prev);
		if (delta.lengthSq() > 1e-8) {
			const space = renderer.xr.getReferenceSpace();
			if (space)
				renderer.xr.setReferenceSpace(
					space.getOffsetReferenceSpace(new XRRigidTransform({ x: delta.x, y: delta.y, z: delta.z }))
				);
		}
	}

	// sector highlight (74/109): pointer-hand ray first, then the MENU hand's
	// own thumbstick (one-handed control), then the pointer stick as fallback;
	// a hover change gives a small haptic tick
	if (get(vrMenuOpen)) {
		const sources = [...session.inputSources];
		const menuIndex = sources.findIndex((s) => s.handedness === get(vrMenuHand));
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		let hovered = pointerIndex >= 0 ? raycastMenu(pointerIndex) : null;
		if (!hovered) {
			const entries = ringEntries(get(activeRing));
			for (const index of [menuIndex, pointerIndex]) {
				if (index < 0) continue;
				const axes = sources[index]?.gamepad?.axes ?? [];
				const sector = sectorFromStick(axes[2] ?? 0, axes[3] ?? 0, entries.length);
				if (sector !== null) {
					hovered = entries[sector]?.id ?? null;
					break;
				}
			}
		}
		if (hovered !== get(vrHovered)) {
			if (hovered) hapticPulse(0.15, 18);
			vrHovered.set(hovered);
		}
	} else if (get(vrObjectsPanelOpen)) {
		// objects panel (101/109): ray highlights rows; EITHER stick moves a row
		// cursor (scrolls with it), stick-press/trigger selects the cursored row
		const sources = [...session.inputSources];
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		const menuIndex = sources.findIndex((s) => s.handedness === get(vrMenuHand));
		const hovered = pointerIndex >= 0 ? raycastPanel(pointerIndex) : null;
		if (hovered !== get(vrHovered)) {
			if (hovered) hapticPulse(0.12, 14);
			vrHovered.set(hovered);
		}
		let y = 0;
		for (const index of [pointerIndex, menuIndex])
			if (index >= 0 && Math.abs(sources[index]?.gamepad?.axes?.[3] ?? 0) > Math.abs(y))
				y = sources[index].gamepad.axes[3];
		const now = Date.now();
		if (Math.abs(y) > 0.6 && now - panelScrollAt > 220) {
			panelScrollAt = now;
			hapticPulse(0.08, 10);
			vrPanelCursor.update((v) => Math.max(0, v + (y > 0 ? 1 : -1)));
		}
	} else if (get(vrHovered) !== null) {
		vrHovered.set(null);
	}
}
