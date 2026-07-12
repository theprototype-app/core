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
	vrPropsPanelOpen,
	vrPrefabsPanelOpen,
	vrPrefabsPinned,
	vrEditMenuOpen,
	vrWireframeSelection,
	vrStatsOpen,
	vrGrabStyle,
	vrGrabbedHand
} from '../stores/sceneStore';
import { activeRing, findMenuEntry, ringEntries, sectorFromStick, pushRing, popRing, resetRings, hubEntry } from './vrRadialMenu';
import { paletteColorAt, barValueAt } from './vrPalette';
import { recordMaterialChange, setMaterialParam } from './materialsHandler';
import { prefabs, instantiatePrefab } from './prefabs';
import {
	editingObject,
	enterEditMode,
	exitEditMode,
	vrVertexEditable,
	vrRaycastHandle,
	vrBeginHandleDrag,
	vrDragHandleTo,
	vrEndHandleDrag,
	setHoveredHandle
} from './meshEdit';
import {
	faceEditObject,
	faceEditOp,
	faceEditAmount,
	enterFaceEdit,
	exitFaceEdit,
	vrFaceEditable,
	setFaceOp,
	adjustFaceAmount,
	commitArmedFaceOp,
	highlightFaceByTriangle,
	faceEditHighlight,
	faceIndexForTriangle,
	beginFaceGrab,
	applyFaceGrab,
	commitFaceGrab,
	beginFaceAdjust,
	adjustFaceGesture,
	commitFaceAdjust,
	cancelFaceAdjust,
	faceGesturePending
} from './faceEdit';
import { peers, showToast, messages } from '../stores/appStore';
import { undo, redo, recordTransform } from './history';
import { snapEnabled, snapSettings } from './snapping';
import {
	selectObject,
	topLevelObjectOf,
	toggleObjectVisibility,
	duplicateObject,
	deleteSelection,
	renameObject,
	focusObject
} from './objectActions';
import { vrKeyboardTarget, openVRKeyboard, pressVRKey, closeVRKeyboard } from './vrKeyboard';
import { sceneCommand } from './commandsHandler.svelte';
import { sendPing } from './ping';
import { suspendAnimation, resumeAnimation } from './flowRuntime';
import { drawMode, toggleDrawMode, addStrokePoint, endStroke } from './drawMode';
import { setPttHeld, cycleMicMode, vrMicMode, micActive, pttActive } from './voiceChat';
import {
	HOLD_MS,
	vrWindowAdjust,
	windowAnchor,
	offsetFromWorld,
	saveWindowPose
} from './vrWindowPoses';

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
/** last panel row-select {uuid, at} for double-click focus detection (120) */
let lastPanelSelect = { uuid: '', at: 0 };

/**
 * VR focus (120): teleport the rig so the viewer frames an object — the
 * desktop focusObject bails in VR (camera is XR-driven). Translation only
 * (matches teleport/world-pan): keep facing, stand back a framing distance.
 * @param {string} uuid
 */
export function vrFocusObject(uuid) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!object || !renderer?.xr?.isPresenting) return;
	const box = new THREE.Box3().setFromObject(object);
	if (!isFinite(box.min.x)) return;
	const center = box.getCenter(new THREE.Vector3());
	const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.3);
	const viewer = renderer.xr.getCamera().getWorldPosition(new THREE.Vector3());
	const dir = viewer.clone().sub(center);
	dir.y = 0;
	if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
	dir.normalize();
	const desired = center.clone().add(dir.multiplyScalar(radius * 3 + 0.5));
	desired.y = viewer.y; // keep eye height
	const move = desired.sub(viewer); // world displacement we want for the viewer
	const space = renderer.xr.getReferenceSpace();
	// getOffsetReferenceSpace moves the viewer by -(offset), so negate the move
	// @ts-ignore - XRRigidTransform is a WebXR global (no TS lib here)
	const offset = new XRRigidTransform({ x: -move.x, y: -move.y, z: -move.z });
	if (space) renderer.xr.setReferenceSpace(space.getOffsetReferenceSpace(offset));
	hapticPulse(0.3, 40);
}
/** the cursored row's action id, published by VRObjectsPanel @type {import('svelte/store').Writable<string|null>} */
export const vrPanelCursorAction = writable(null);
let panelScrollAt = 0;
/** the stats card THREE group (111 grab target) @type {import('svelte/store').Writable<any>} */
export const vrStatsGroup = writable(null);

// VR chat unread badge (117): messages arriving while the VR chat panel is
// closed accumulate; opening the panel clears the count
/** @type {import('svelte/store').Writable<number>} */
export const vrChatUnread = writable(0);
let lastMessageCount = 0;
messages.subscribe((list) => {
	const count = Array.isArray(list) ? list.length : 0;
	if (count > lastMessageCount && !get(vrChatPanelOpen)) vrChatUnread.update((n) => n + (count - lastMessageCount));
	lastMessageCount = count;
});
vrChatPanelOpen.subscribe((open) => {
	if (open) vrChatUnread.set(0);
});

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

// ---- VR properties panel (112): core editable set for the selection ----
/** the props panel THREE group @type {import('svelte/store').Writable<any>} */
export const vrPropsGroup = writable(null);
/** stick row cursor (objects-panel pattern): index into PROPS_ROWS */
export const vrPropsCursor = writable(0);
/** interactive rows top-to-bottom; axis rows nudge, the rest activate */
export const PROPS_ROWS = [
	'pos:x',
	'pos:y',
	'pos:z',
	'rot:x',
	'rot:y',
	'rot:z',
	'scale:x',
	'scale:y',
	'scale:z',
	'opacity',
	'visible'
	// 120: color/duplicate/delete removed — they live on the Edit ring + palette
];

/** Raycast the props panel controls @param {number} index @returns {string|null} props action */
export function raycastProps(index) {
	const panel = get(vrPropsGroup);
	if (!panel || !get(vrPropsPanelOpen)) return null;
	const hits = controllerRay(index).intersectObject(panel, true);
	const control = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vrprops-'));
	return control ? 'props:' + control.object.name.slice('vrprops-'.length) : null;
}

/** the Edit Mesh side-menu group (137) @type {import('svelte/store').Writable<any>} */
export const vrEditGroup = writable(null);
/** Raycast the Edit Mesh side-menu (137) — control names carry the FULL action
 * (edit:mode:faces / face:extrude / edit:close) @param {number} index */
export function raycastEdit(index) {
	const panel = get(vrEditGroup);
	if (!panel || !get(vrEditMenuOpen)) return null;
	const hits = controllerRay(index).intersectObject(panel, true);
	const control = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vredit-'));
	return control ? control.object.name.slice('vredit-'.length) : null;
}

/**
 * Snap-aware nudge step per transform kind (112). Pure for tests.
 * @param {string} kind pos|rot|scale @param {boolean} snapOn
 * @param {{translate: number, rotateDeg: number, scale: number}} settings
 */
export function nudgeStep(kind, snapOn, settings) {
	if (kind === 'pos') return snapOn ? settings.translate : 0.1;
	if (kind === 'rot') return ((snapOn ? settings.rotateDeg : 5) * Math.PI) / 180;
	return snapOn ? settings.scale : 0.1;
}

/** One nudge click/stick-tick: local apply + move replication + undo entry
 * @param {any} object @param {string} kind @param {string} axis @param {number} sign */
function nudgeTransform(object, kind, axis, sign) {
	const before = transformStateOf(object);
	const step = nudgeStep(kind, get(snapEnabled), get(snapSettings));
	if (kind === 'pos') object.position[axis] += sign * step;
	else if (kind === 'rot') object.rotation[axis] += sign * step;
	else object.scale[axis] = Math.max(0.01, object.scale[axis] + sign * step);
	recordTransform({ uuid: object.uuid, before, after: transformStateOf(object) });
	broadcastMove(object, true);
	objectsGroup.update((v) => v);
}

/** Props panel actions ('props:' prefix in executeVRMenuAction) @param {string} action */
function handlePropsAction(action) {
	if (action === 'close') {
		vrPropsPanelOpen.set(false);
		return;
	}
	const object = /** @type {any} */ (get(selectedObject));
	if (!object?.uuid) return;
	if (action === 'visible') toggleObjectVisibility(object.uuid);
	else if (action === 'duplicate') duplicateObject(undefined);
	else if (action === 'delete') {
		deleteSelection();
		vrPropsPanelOpen.set(false);
	} else if (action === 'color') executeVRMenuAction('obj:color');
	else if (action.startsWith('opacity:')) {
		if (!object.material) return;
		const sign = parseInt(action.slice('opacity:'.length)) || 0;
		const next = Math.min(Math.max((object.material.opacity ?? 1) + sign * 0.1, 0.1), 1);
		if (next < 1 && !object.material.transparent) setMaterialParam(object.uuid, 'transparent', true);
		setMaterialParam(object.uuid, 'opacity', Math.round(next * 10) / 10);
	} else if (action.startsWith('nudge:')) {
		const [kind, axis, sign] = action.slice('nudge:'.length).split(':');
		if (['x', 'y', 'z'].includes(axis)) nudgeTransform(object, kind, axis, parseInt(sign) || 1);
	}
}

/** Stick press / cursored activation for a PROPS_ROWS row @param {string} row */
export function propsRowAction(row) {
	if (row === 'opacity') return 'props:opacity:1';
	if (row.includes(':')) return 'props:nudge:' + row + ':1';
	return 'props:' + row;
}

// ---- VR prefabs window + ghost placement (115) ----
/** the prefabs window THREE group @type {import('svelte/store').Writable<any>} */
export const vrPrefabsGroup = writable(null);
/** grid cell cursor (stick up/down) */
export const vrPrefabsCursor = writable(0);
/** armed prefab {id, name} while a placement ghost rides the ray, else null
 * @type {import('svelte/store').Writable<any>} */
export const vrPrefabGhost = writable(null);
/** @type {any} the translucent THREE clone at the scene root */
let ghostObject = null;
/** @type {any} */
let ghostPrefab = null;

// ---- VR chat panel (117) ----
/** the chat panel THREE group @type {import('svelte/store').Writable<any>} */
export const vrChatGroup = writable(null);

/** Raycast the chat panel controls @param {number} index @returns {string|null} chat action */
export function raycastChat(index) {
	const panel = get(vrChatGroup);
	if (!panel || !get(vrChatPanelOpen)) return null;
	const hits = controllerRay(index).intersectObject(panel, true);
	const control = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vrchat-'));
	return control ? 'chat:' + control.object.name.slice('vrchat-'.length) : null;
}

// ---- VR keyboard (116): raycast the key grid, route presses ----
/** the keyboard THREE group @type {import('svelte/store').Writable<any>} */
export const vrKeyboardGroup = writable(null);

/** Raycast the keyboard keys @param {number} index @returns {string|null} kbd action */
export function raycastKeyboard(index) {
	const panel = get(vrKeyboardGroup);
	if (!panel || !get(vrKeyboardTarget)) return null;
	const hits = controllerRay(index).intersectObject(panel, true);
	const key = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vrkey-'));
	return key ? 'kbd:' + key.object.name.slice('vrkey-'.length) : null;
}

/** Raycast the prefabs window controls @param {number} index */
export function raycastPrefabs(index) {
	const panel = get(vrPrefabsGroup);
	if (!panel || !get(vrPrefabsPanelOpen)) return null;
	const hits = controllerRay(index).intersectObject(panel, true);
	const control = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vrprefabs-'));
	return control ? 'prefabs:' + control.object.name.slice('vrprefabs-'.length) : null;
}

/** Arm the placement ghost for a prefab id (trigger on a cell) @param {string} id */
function armPrefabGhost(id) {
	const prefab = get(prefabs).find((p) => p.id === id);
	const scene = get(globalScene);
	if (!prefab || !scene) return;
	cancelPrefabGhost();
	let clone;
	try {
		clone = new THREE.ObjectLoader().parse(prefab.element);
	} catch {
		return;
	}
	// fresh parse = own materials, safe to fade in place
	clone.traverse((/** @type {any} */ node) => {
		if (node.material) {
			node.material.transparent = true;
			node.material.opacity = 0.35;
			node.material.depthWrite = false;
		}
	});
	clone.name = 'vr-prefab-ghost';
	scene.add(clone);
	ghostObject = clone;
	ghostPrefab = prefab;
	vrPrefabGhost.set({ id: prefab.id, name: prefab.name });
	hapticPulse(0.2, 25);
}

/** Drop the ghost without placing (grip / panel close / menu open) */
export function cancelPrefabGhost() {
	if (ghostObject) {
		ghostObject.parent?.remove(ghostObject);
		ghostObject.traverse((/** @type {any} */ node) => node.geometry?.dispose?.());
	}
	ghostObject = null;
	ghostPrefab = null;
	vrPrefabGhost.set(null);
}

// closing the prefabs window (any path — ✕, menu open, exclusions) drops the ghost
vrPrefabsPanelOpen.subscribe((open) => {
	if (!open) cancelPrefabGhost();
});

/** Ghost follows the pointer ray: objects first, floor plane as fallback @param {number} index */
function updatePrefabGhost(index) {
	if (!ghostObject || index < 0) return;
	const ray = controllerRay(index);
	const group = get(objectsGroup);
	let point = null;
	if (group) {
		const hits = ray
			.intersectObjects(group.children, true)
			.filter((/** @type {any} */ h) => h.object !== ghostObject);
		if (hits.length) point = hits[0].point;
	}
	if (!point) {
		const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
		point = ray.ray.intersectPlane(floor, new THREE.Vector3());
	}
	if (point) ghostObject.position.copy(point);
}

/** Trigger while the ghost is armed: instantiate at the ghost spot, stay armed.
 * Returns true when a placement happened (Scene.svelte consumes the select). */
export function placePrefabGhost() {
	if (!ghostObject || !ghostPrefab) return false;
	// picking a cell re-arms instead of placing — the panel raycast runs first
	const group = get(objectsGroup);
	if (!group) return false;
	group.updateMatrixWorld(true);
	const local = group.worldToLocal(ghostObject.position.clone());
	const object = instantiatePrefab(ghostPrefab, local);
	if (!object) return false;
	hapticPulse(0.35, 40);
	return true;
}
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

// ---- VR window grab (111): grip-hold a follower window to re-place it ----
/** @type {{id: string, index: number, startedAt: number}|null} */
let windowGrabPending = null;
/** @type {any} pending detach: relPos/relQuat like the 100 rigid object grab */
let windowGrab = null;

function windowGroupFor(/** @type {string} */ id) {
	return get(
		{
			menu: vrMenuGroup,
			objects: vrPanelGroup,
			palette: vrPaletteGroup,
			stats: vrStatsGroup,
			props: vrPropsGroup,
			prefabs: vrPrefabsGroup,
			keyboard: vrKeyboardGroup,
			chat: vrChatGroup,
			editmenu: vrEditGroup
		}[id] ?? vrMenuGroup
	);
}

/** Which open window the controller ray lands on @param {number} index */
function windowHitAt(index) {
	let best = null;
	for (const id of ['menu', 'objects', 'palette', 'stats', 'props', 'prefabs', 'keyboard', 'chat', 'editmenu']) {
		const group = windowGroupFor(id);
		if (!group) continue;
		const hits = controllerRay(index).intersectObject(group, true);
		if (hits.length && (!best || hits[0].distance < best.distance))
			best = { id, distance: hits[0].distance };
	}
	return best && best.distance < 3 ? best.id : null;
}

function beginWindowAdjust() {
	const { id, index } = /** @type {any} */ (windowGrabPending);
	windowGrabPending = null;
	const group = windowGroupFor(id);
	if (!group) return;
	const controller = renderer.xr.getController(index);
	const cPos = controller.getWorldPosition(new THREE.Vector3());
	const cQuat = controller.getWorldQuaternion(new THREE.Quaternion());
	windowGrab = {
		id,
		index,
		relPos: group.position.clone().sub(cPos).applyQuaternion(cQuat.clone().invert()),
		relQuat: cQuat.clone().invert().multiply(group.quaternion),
		scale: group.scale.x || 1
	};
	vrWindowAdjust.set({ id, index });
	// gate that hand's stick (locomotion) — it scales the window now
	const session = renderer?.xr.getSession();
	vrGrabbedHand.set(session ? ([...session.inputSources][index]?.handedness ?? null) : null);
	hapticPulse(0.5, 60);
}

function updateWindowAdjust() {
	const group = windowGroupFor(windowGrab.id);
	if (!group || !group.parent) {
		// the window closed mid-adjust — drop the gesture
		windowGrab = null;
		vrWindowAdjust.set(null);
		vrGrabbedHand.set(null);
		return;
	}
	const controller = renderer.xr.getController(windowGrab.index);
	const cPos = controller.getWorldPosition(new THREE.Vector3());
	const cQuat = controller.getWorldQuaternion(new THREE.Quaternion());
	const pose = rigidGrabPose(cPos, cQuat, windowGrab.relPos, windowGrab.relQuat);
	group.position.copy(pose.position);
	group.quaternion.copy(pose.quaternion);
	// gripping hand's stick fwd/back resizes the window
	const session = renderer?.xr.getSession();
	const axes = session ? ([...session.inputSources][windowGrab.index]?.gamepad?.axes ?? []) : [];
	const y = Math.abs(axes[3] ?? 0) > 0.15 ? (axes[3] ?? 0) : 0;
	windowGrab.scale = Math.min(Math.max(windowGrab.scale * (1 - y * 0.02), 0.35), 3);
	group.scale.setScalar(windowGrab.scale);
}

function finishWindowAdjust() {
	const group = windowGroupFor(windowGrab.id);
	const anchor = windowAnchor(windowGrab.id);
	if (group && anchor)
		saveWindowPose(
			windowGrab.id,
			offsetFromWorld(anchor, group.position, group.quaternion, group.scale.x || 1)
		);
	windowGrab = null;
	vrWindowAdjust.set(null);
	vrGrabbedHand.set(null);
	hapticPulse(0.3, 40);
}

/** @type {any} active VR vertex-handle drag: {index, offset} */
let vertexGrab = null;
/** @type {any} active VR face grab (122): {index, pos0, quat0, push, scale} */
let faceGrabHand = null;

/**
 * Face-mode trigger (122): a pending extrude/inset adjust commits; otherwise
 * extrude/inset START a live adjust on the highlighted face, move/delete commit
 * immediately. A grip grab in progress ignores the trigger.
 */
export function vrFaceTrigger() {
	if (commitFaceAdjust()) return; // finalize a pending extrude/inset
	if (faceGesturePending()) return; // a grip grab owns the gesture
	const op = get(faceEditOp);
	const fi = get(faceEditHighlight);
	if (fi < 0) return;
	if (op === 'extrude' || op === 'inset') beginFaceAdjust(fi, /** @type {any} */ (op), get(faceEditAmount));
	else commitArmedFaceOp();
}

/** @param {number} index */
function onSqueezeStart(index) {
	// an armed prefab ghost cancels on grip (115) — nothing else grabs
	if (get(vrPrefabGhost)) {
		cancelPrefabGhost();
		return;
	}
	// face edit mode (122): grip the face under the ray to grab it (rigid
	// move/rotate; stick reels along the normal + scales). Exits are hub/Back.
	if (get(faceEditObject)) {
		const edited = get(objectsGroup)?.getObjectByProperty('uuid', get(faceEditObject));
		const hit = edited ? controllerRay(index).intersectObject(edited, false)[0] : null;
		const fi = hit && hit.faceIndex != null ? faceIndexForTriangle(hit.faceIndex) : -1;
		if (fi >= 0 && beginFaceGrab(fi)) {
			const controller = renderer.xr.getController(index);
			faceGrabHand = {
				index,
				pos0: controller.getWorldPosition(new THREE.Vector3()),
				quat0: controller.getWorldQuaternion(new THREE.Quaternion()),
				push: 0,
				scale: 1
			};
			hapticPulse(0.3, 30);
		}
		return;
	}
	// vertex edit mode (113): grip a handle to drag its vertex
	if (get(editingObject)) {
		const handle = vrRaycastHandle(controllerRay(index));
		if (handle >= 0) {
			const handleWorld = vrBeginHandleDrag(handle);
			if (handleWorld) {
				const controllerPos = renderer.xr
					.getController(index)
					.getWorldPosition(new THREE.Vector3());
				vertexGrab = { index, offset: handleWorld.sub(controllerPos) };
				hapticPulse(0.3, 30);
			}
			return;
		}
	}
	// grip on a follower window (111): hold to detach it into adjust mode
	const windowId = windowHitAt(index);
	if (windowId) {
		windowGrabPending = { id: windowId, index, startedAt: Date.now() };
		return;
	}
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
	// face grab (122): release commits the reshape as one meshgeo + undo entry
	if (faceGrabHand?.index === index) {
		faceGrabHand = null;
		commitFaceGrab();
		hapticPulse(0.2, 30);
		return;
	}
	// vertex handle drag (113): release commits the pull + one undo entry
	if (vertexGrab?.index === index) {
		vrEndHandleDrag();
		vertexGrab = null;
		hapticPulse(0.18, 24);
		return;
	}
	// window grab (111): a short grip is a no-op, a held one re-anchors
	if (windowGrabPending?.index === index) {
		windowGrabPending = null;
		return;
	}
	if (windowGrab?.index === index) {
		finishWindowAdjust();
		return;
	}
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
		// a pending extrude/inset adjust reverts on Back before leaving (122)
		if (faceGesturePending()) {
			cancelFaceAdjust();
			return;
		}
		// leaving the Faces ring exits face-edit mode (118)
		if (get(activeRing) === 'faces') exitFaceEdit();
		popRing();
		return;
	}
	if (name === 'obj:editmesh') {
		// 137: TOGGLE mesh-edit mode + the controller side-menu (Vertices/Faces)
		if (get(vrEditMenuOpen)) {
			exitEditMode();
			exitFaceEdit();
			vrEditMenuOpen.set(false);
			return;
		}
		const object = /** @type {any} */ (get(selectedObject));
		if (!object?.uuid) return;
		// default to Faces when the mesh qualifies, else Vertices, else refuse
		if (vrFaceEditable(object)) enterFaceEdit(object.uuid);
		else if (vrVertexEditable(object)) enterEditMode(object.uuid);
		else {
			showToast('This mesh is too dense to edit in VR');
			return;
		}
		if (get(faceEditObject) || get(editingObject)) {
			vrObjectsPanelOpen.set(false);
			vrPaletteOpen.set(false);
			vrPropsPanelOpen.set(false);
			vrChatPanelOpen.set(false);
			vrMenuOpen.set(false);
			vrEditMenuOpen.set(true);
		}
		return;
	}
	if (name === 'edit:close') {
		// side-menu close = exit mesh edit (137)
		exitEditMode();
		exitFaceEdit();
		vrEditMenuOpen.set(false);
		return;
	}
	if (name.startsWith('edit:mode:')) {
		// switch Vertices <-> Faces from the side-menu (137)
		const mode = name.slice('edit:mode:'.length);
		const object = /** @type {any} */ (get(selectedObject));
		if (!object?.uuid) return;
		if (mode === 'vertices') {
			exitFaceEdit();
			if (vrVertexEditable(object)) enterEditMode(object.uuid);
			else showToast('Too dense for vertex editing (max 500 verts)');
		} else {
			exitEditMode();
			if (vrFaceEditable(object)) enterFaceEdit(object.uuid);
			else showToast('Too dense for face editing (max 300 triangles)');
		}
		return;
	}
	if (name.startsWith('nav:')) {
		pushRing(name.slice(4));
		return;
	}
	if (name.startsWith('face:')) {
		// arm a face op (side-menu, 137); the pointer trigger picks + commits (118/122)
		setFaceOp(/** @type {any} */ (name.slice('face:'.length)));
		return;
	}
	if (name === 'chat') {
		// the VR chat panel (117) replaces the ring on screen
		vrChatPanelOpen.update((v) => !v);
		vrObjectsPanelOpen.set(false);
		vrPaletteOpen.set(false);
		vrPropsPanelOpen.set(false);
		vrMenuOpen.set(false);
		return;
	}
	if (name.startsWith('chat:')) {
		const action = name.slice('chat:'.length);
		if (action === 'close') vrChatPanelOpen.set(false);
		else if (action === 'input')
			openVRKeyboard({
				title: 'Chat message',
				onCommit: (text) => {
					const trimmed = text.trim();
					if (trimmed) /** @type {any} */ (get(peers))?.sendMessage(trimmed);
				}
			});
		return;
	}
	if (name === 'obj:color') {
		// the continuous palette (110) replaces the ring on screen
		vrPaletteOpen.set(true);
		vrObjectsPanelOpen.set(false);
		vrChatPanelOpen.set(false);
		vrPropsPanelOpen.set(false);
		vrMenuOpen.set(false);
		return;
	}
	if (name === 'obj:props') {
		// the properties panel (112) replaces the ring on screen
		vrPropsPanelOpen.set(true);
		vrObjectsPanelOpen.set(false);
		vrChatPanelOpen.set(false);
		vrPaletteOpen.set(false);
		vrMenuOpen.set(false);
		return;
	}
	if (name.startsWith('props:')) {
		handlePropsAction(name.slice('props:'.length));
		return;
	}
	if (name === 'prefabs') {
		// the thumbnail window (115) lazy-follows the view
		vrPrefabsPanelOpen.update((v) => !v);
		vrObjectsPanelOpen.set(false);
		vrChatPanelOpen.set(false);
		vrPaletteOpen.set(false);
		vrPropsPanelOpen.set(false);
		vrMenuOpen.set(false);
		return;
	}
	if (name.startsWith('prefabs:')) {
		const action = name.slice('prefabs:'.length);
		if (action === 'close') vrPrefabsPanelOpen.set(false);
		else if (action === 'pin') vrPrefabsPinned.update((v) => !v);
		else if (action.startsWith('select:')) armPrefabGhost(action.slice('select:'.length));
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
	if (name.startsWith('kbd:')) {
		pressVRKey(name.slice('kbd:'.length));
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
		// objects panel actions (101) + row actions v2 (116/120)
		if (name === 'panel:close') vrObjectsPanelOpen.set(false);
		else if (name.startsWith('panel:select:')) {
			// 120: selecting no longer closes the panel; a second select on the
			// SAME row within the double-click window focuses it instead
			const uuid = name.slice('panel:select:'.length);
			const now = Date.now();
			if (uuid === lastPanelSelect.uuid && now - lastPanelSelect.at < 400) {
				lastPanelSelect = { uuid: '', at: 0 };
				executeVRMenuAction('panel:focus:' + uuid);
			} else {
				lastPanelSelect = { uuid, at: now };
				selectObject(uuid);
				hapticPulse(0.2, 30);
			}
		} else if (name.startsWith('panel:focus:')) {
			const uuid = name.slice('panel:focus:'.length);
			selectObject(uuid);
			if (renderer?.xr?.isPresenting) vrFocusObject(uuid);
			else focusObject(uuid);
		} else if (name.startsWith('panel:props:')) {
			// open the 112 properties panel for this row's object
			selectObject(name.slice('panel:props:'.length));
			vrPropsPanelOpen.set(true);
			vrObjectsPanelOpen.set(false);
			vrPaletteOpen.set(false);
			vrChatPanelOpen.set(false);
		} else if (name.startsWith('panel:visible:')) {
			toggleObjectVisibility(name.slice('panel:visible:'.length));
		} else if (name.startsWith('panel:delete:')) {
			const uuid = name.slice('panel:delete:'.length);
			if (get(lockedObjects).find((lock) => lock[1] === uuid)) {
				showToast('That object is locked by another peer');
			} else {
				selectObject(uuid);
				deleteSelection();
			}
		} else if (name.startsWith('panel:rename:')) {
			const uuid = name.slice('panel:rename:'.length);
			if (get(lockedObjects).find((lock) => lock[1] === uuid)) {
				showToast('That object is locked by another peer');
				return;
			}
			const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
			openVRKeyboard({
				title: 'Rename object',
				initial: object?.name ?? '',
				onCommit: (text) => {
					if (text.trim()) renameObject(uuid, text.trim());
				}
			});
		}
		return;
	}
	if (name === 'move' || name === 'rotate') vrTransformMode.set(name);
	else if (name === 'objects') {
		// the native VR list panel (101) replaces the menu on screen
		vrObjectsPanelOpen.update((v) => !v);
		vrPaletteOpen.set(false);
		vrPropsPanelOpen.set(false);
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
	if (
		!get(vrMenuOpen) &&
		!get(vrObjectsPanelOpen) &&
		!get(vrPropsPanelOpen) &&
		!get(vrPrefabsPanelOpen) &&
		!get(vrChatPanelOpen) &&
		!get(vrKeyboardTarget) &&
		get(vrGrabbedHand) !== 'right'
	) {
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
					vrPropsPanelOpen.set(false);
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
				vrPropsPanelOpen.set(false);
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
			if (get(vrKeyboardTarget)) {
				// keyboard is modal on top (116): stick-press taps the hovered key
				const hovered = get(vrHovered);
				if (hovered) executeVRMenuAction(hovered);
			} else if (get(vrMenuOpen)) {
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
			} else if (get(vrPropsPanelOpen)) {
				// ray hover wins; otherwise activate the cursored row (112)
				const action = get(vrHovered) ?? propsRowAction(PROPS_ROWS[get(vrPropsCursor)]);
				if (action) executeVRMenuAction(action);
			} else if (get(vrPrefabsPanelOpen)) {
				// ray hover wins; otherwise arm the cursored cell (115)
				const cell = get(prefabs)[get(vrPrefabsCursor)];
				const action = get(vrHovered) ?? (cell ? 'prefabs:select:' + cell.id : null);
				if (action) executeVRMenuAction(action);
			} else if (get(vrChatPanelOpen)) {
				// ray hover wins; otherwise the stick-press opens the input (117)
				const action = get(vrHovered) ?? 'chat:input';
				executeVRMenuAction(action);
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

	// window grab (111): the hold timer arms, then the grip drives the window
	if (windowGrabPending && Date.now() - windowGrabPending.startedAt >= HOLD_MS)
		beginWindowAdjust();
	if (windowGrab) updateWindowAdjust();

	// prefab placement ghost (115) rides the pointer-hand ray
	if (get(vrPrefabGhost))
		updatePrefabGhost(controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right'));

	// vertex handle drag (113): the gripped handle rides the controller
	if (vertexGrab) {
		const controllerPos = renderer.xr
			.getController(vertexGrab.index)
			.getWorldPosition(new THREE.Vector3());
		const step = get(snapEnabled) ? get(snapSettings).translate : 0;
		vrDragHandleTo(controllerPos.add(vertexGrab.offset), step);
	} else if (get(editingObject)) {
		// vertex hover (119): the pointer ray tints the handle under it
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		const hit = pointerIndex >= 0 ? vrRaycastHandle(controllerRay(pointerIndex)) : -1;
		if (setHoveredHandle(hit) && hit >= 0) hapticPulse(0.1, 12);
	}

	// face edit (118/122)
	if (get(faceEditObject) && !get(vrMenuOpen)) {
		if (faceGrabHand) {
			// rigid face grab (122): move/rotate 1:1 from the grip hand; that
			// hand's stick reels along the normal (fwd/back) + scales (left/right)
			const controller = renderer.xr.getController(faceGrabHand.index);
			const pos1 = controller.getWorldPosition(new THREE.Vector3());
			const quat1 = controller.getWorldQuaternion(new THREE.Quaternion());
			const edited = get(objectsGroup)?.getObjectByProperty('uuid', get(faceEditObject));
			// world delta since grab-start, converted into the object's local frame
			const objQuatInv = edited
				? edited.getWorldQuaternion(new THREE.Quaternion()).invert()
				: new THREE.Quaternion();
			const dPosW = pos1.clone().sub(faceGrabHand.pos0);
			const dPos = dPosW.applyQuaternion(objQuatInv);
			const dQuat = objQuatInv
				.clone()
				.multiply(quat1.clone().multiply(faceGrabHand.quat0.clone().invert()))
				.multiply(objQuatInv.clone().invert());
			const axes = session.inputSources[faceGrabHand.index]?.gamepad?.axes ?? [];
			const sy = Math.abs(axes[3] ?? 0) > 0.15 ? axes[3] : 0;
			const sx = Math.abs(axes[2] ?? 0) > 0.15 ? axes[2] : 0;
			faceGrabHand.push += -sy * 0.01;
			faceGrabHand.scale = Math.min(Math.max(faceGrabHand.scale + sx * 0.01, 0.05), 5);
			applyFaceGrab({ dPos, dQuat, push: faceGrabHand.push, scale: faceGrabHand.scale });
		} else if (faceGesturePending()) {
			// live extrude/inset adjust (122): stick fwd/back = depth, l/r = cap scale
			const menuIndex = [...session.inputSources].findIndex((s) => s.handedness === get(vrMenuHand));
			const axes = menuIndex >= 0 ? (session.inputSources[menuIndex]?.gamepad?.axes ?? []) : [];
			const sy = Math.abs(axes[3] ?? 0) > 0.15 ? axes[3] : 0;
			const sx = Math.abs(axes[2] ?? 0) > 0.15 ? axes[2] : 0;
			if (sy || sx) adjustFaceGesture(-sy * 0.01, sx * 0.01);
		} else {
			// idle: the pointer ray highlights the face under it (121)
			const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
			if (pointerIndex >= 0) {
				const edited = get(objectsGroup)?.getObjectByProperty('uuid', get(faceEditObject));
				if (edited) {
					const hits = controllerRay(pointerIndex).intersectObject(edited, false);
					const tri = hits.length && hits[0].faceIndex != null ? hits[0].faceIndex : -1;
					if (highlightFaceByTriangle(tri) && tri >= 0) hapticPulse(0.1, 12);
				}
			}
		}
	}

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
	if (get(vrKeyboardTarget)) {
		// keyboard is modal on top (116): the pointer ray highlights keys, either
		// stick nudges through them left-to-right / row-to-row via the raycast
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		const hovered = pointerIndex >= 0 ? raycastKeyboard(pointerIndex) : null;
		if (hovered !== get(vrHovered)) {
			if (hovered) hapticPulse(0.1, 12);
			vrHovered.set(hovered);
		}
	} else if (get(vrMenuOpen)) {
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
			// 120: selection FOLLOWS the cursor (lock-respecting) so navigating
			// the list selects live — no separate press needed
			const children = get(objectsGroup)?.children ?? [];
			const idx = Math.min(Math.max(0, get(vrPanelCursor)), Math.max(0, children.length - 1));
			const target = children[idx];
			if (target && !get(lockedObjects).find((lock) => lock[1] === target.uuid))
				selectObject(target.uuid);
		}
	} else if (get(vrPropsPanelOpen)) {
		// props panel (112): ray highlights controls; EITHER stick moves the row
		// cursor, stick left/right nudges the cursored row, press activates it
		const sources = [...session.inputSources];
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		const menuIndex = sources.findIndex((s) => s.handedness === get(vrMenuHand));
		const hovered = pointerIndex >= 0 ? raycastProps(pointerIndex) : null;
		if (hovered !== get(vrHovered)) {
			if (hovered) hapticPulse(0.12, 14);
			vrHovered.set(hovered);
		}
		let x = 0;
		let y = 0;
		for (const index of [pointerIndex, menuIndex]) {
			const axes = index >= 0 ? (sources[index]?.gamepad?.axes ?? []) : [];
			if (Math.abs(axes[3] ?? 0) > Math.abs(y)) y = axes[3];
			if (Math.abs(axes[2] ?? 0) > Math.abs(x)) x = axes[2];
		}
		const now = Date.now();
		if (Math.abs(y) > 0.6 && Math.abs(y) >= Math.abs(x) && now - panelScrollAt > 220) {
			panelScrollAt = now;
			hapticPulse(0.08, 10);
			vrPropsCursor.update((v) =>
				Math.min(Math.max(0, v + (y > 0 ? 1 : -1)), PROPS_ROWS.length - 1)
			);
		} else if (Math.abs(x) > 0.6 && Math.abs(x) > Math.abs(y) && now - panelScrollAt > 220) {
			// left/right adjusts the cursored row (axis nudges + opacity)
			const row = PROPS_ROWS[get(vrPropsCursor)];
			const sign = x > 0 ? 1 : -1;
			if (row === 'opacity' || row.includes(':')) {
				panelScrollAt = now;
				hapticPulse(0.1, 12);
				executeVRMenuAction(
					row === 'opacity' ? 'props:opacity:' + sign : 'props:nudge:' + row + ':' + sign
				);
			}
		}
	} else if (get(vrPrefabsPanelOpen)) {
		// prefabs window (115): ray highlights cells; EITHER stick moves the
		// cell cursor, press arms the cursored prefab's ghost
		const sources = [...session.inputSources];
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		const menuIndex = sources.findIndex((s) => s.handedness === get(vrMenuHand));
		const hovered = pointerIndex >= 0 ? raycastPrefabs(pointerIndex) : null;
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
			const count = get(prefabs).length;
			vrPrefabsCursor.update((v) => Math.min(Math.max(0, v + (y > 0 ? 1 : -1)), Math.max(0, count - 1)));
		}
	} else if (get(vrChatPanelOpen)) {
		// chat panel (117): the pointer ray highlights close / input
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		const hovered = pointerIndex >= 0 ? raycastChat(pointerIndex) : null;
		if (hovered !== get(vrHovered)) {
			if (hovered) hapticPulse(0.12, 14);
			vrHovered.set(hovered);
		}
	} else if (get(vrEditMenuOpen)) {
		// Edit Mesh side-menu (137): the pointer ray highlights its rows
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		const hovered = pointerIndex >= 0 ? raycastEdit(pointerIndex) : null;
		if (hovered !== get(vrHovered)) {
			if (hovered) hapticPulse(0.12, 14);
			vrHovered.set(hovered);
		}
	} else if (get(vrHovered) !== null) {
		vrHovered.set(null);
	}
}
