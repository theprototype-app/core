// 64 D1: vector shapes in the headset (the radial rows are registered at boot by vectorBoot.js; this chunk is their actions):
//   Add ▸ Shapes ▸ Rectangle / Ellipse / Star / Polygon — 2 m ahead, upright, facing you
//   Selected ▸ Extrude (a vector shape) — steps the depth 0 -> 10 -> 25 -> 50 cm -> flat, one undo each
//   Add ▸ Shapes ▸ Pen — the laser pen (64-vector-edit row 5, below)
// A shape is an ordinary object, so the grip holds it like any other (grab, carry, two-hand scale).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalCamera, objectsGroup, selectedObject, vrMenuOpen, globalScene } from '../../stores/sceneStore';
import { placeVectorShape, vectorParamsOf, setVectorParams } from './vectorActions.js';
import { registerVRTriggerHooks, registerGripHooks, registerVRFrameHook } from '../vr/hooks.js';
import { controllerRay } from '../vr/pointer.js';
import { renderer } from '../vr/core.js';
import { hapticPulse } from '../vr/haptics.js';
import { hapticsAllowed } from '../gameSettings';
import { vectorLaserPen } from './vectorGate.js';
import { beginPenAt, penAddPoint, penHandleTo, finishPen, undoPenPoint, cancelDraft, setPenFrame, penSnap, penDraft, vectorToolDebug } from './vectorTool.js';

export const EXTRUDE_STEPS = [0, 0.1, 0.25, 0.5];

/** the next depth after `depth` in the cycle @param {number} depth */
export function nextExtrude(depth) {
	const i = EXTRUDE_STEPS.findIndex((d) => d > depth + 1e-6);
	return i < 0 ? 0 : EXTRUDE_STEPS[i];
}

/** place a shape 2 m ahead of the headset, at chest height @param {string} kind */
export function spawnVectorAhead(kind) {
	/** @type {any} */
	const camera = get(globalCamera);
	const group = /** @type {any} */ (get(objectsGroup));
	if (!camera || !group) return null;
	const eye = camera.getWorldPosition(new THREE.Vector3());
	const dir = camera.getWorldDirection(new THREE.Vector3());
	dir.y = 0;
	if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
	dir.normalize().multiplyScalar(2);
	// placeVectorShape stands the shape ON the point: put the point half a metre under the eye
	const world = eye.clone().add(dir).add(new THREE.Vector3(0, -1, 0));
	group.updateMatrixWorld(true);
	const local = group.worldToLocal(world);
	return placeVectorShape(kind, [local.x, local.y, local.z]);
}

/** Selected ▸ Extrude: step the selected shape's depth (one undo each); a shape another peer holds refuses */
export function stepExtrude() {
	const object = /** @type {any} */ (get(selectedObject));
	const p = vectorParamsOf(object);
	if (!p) return false;
	return setVectorParams(object.uuid, { depth: nextExtrude(p.depth ?? 0) });
}

/* -------------------------------------------------------------- laser pen ---- */
// 64-vector-edit row 5: THE PEN BY VR LASER. Arming puts a WORK PLANE 1.5 m ahead, upright and facing
// you (a faint 3 x 3 m sheet with a 25 cm grid). Then:
//   trigger ........ a point where the laser meets the plane (snapped like a desktop press); hold and
//                    pull to drag out a smooth point's handle; on the FIRST point it closes the path
//   grip ........... carries the plane (and the points on it) with the hand, released where it is
//   haptic ......... one short tick on the drawing hand per point placed (QUESTIONS Q1: a tool
//                    confirmation like the Edit/Interact switch tick; off with "Controller vibration")
//   radial ......... Finish path / Undo point / Pen off (visible while armed)
// The draft IS the desktop pen's (vectorTool.beginPenAt / penAddPoint / finishPen), so a finished path
// is the same ONE create entry, synced the same way. Input rides the VR trigger and grip hooks, so the
// rest of VR (grab, select, menus) does not learn the pen exists; the radial open = the pen stands down.

/** half the work plane's side (m) */
const PLANE_HALF = 1.5;
/** the trigger closes the path within this of the first point (m) */
const CLOSE_M = 0.04;
/** a held trigger becomes a handle drag past this (m) */
const DRAG_M = 0.02;

/** @type {null | {origin: THREE.Vector3, quat: THREE.Quaternion, visual: THREE.Group, offs: (() => void)[],
 *  drag: null | {slot: number, index: number, at: number[]}, grip: null | {slot: number, ctrl0: THREE.Matrix4, plane0: THREE.Matrix4},
 *  claimed: boolean[], ticks: number}} */
let laser = null;

export function laserPenActive() {
	return !!laser;
}

/** arm (or disarm) the laser pen */
export function toggleLaserPen() {
	return laser ? disarmLaserPen() : armLaserPen();
}

/** the plane 1.5 m ahead of the headset, upright, its +Z toward you and +X your right */
function planeAhead() {
	/** @type {any} */
	const camera = get(globalCamera);
	const eye = camera ? camera.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0, 1.6, 0);
	const dir = camera ? camera.getWorldDirection(new THREE.Vector3()) : new THREE.Vector3(0, 0, -1);
	dir.y = 0;
	if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
	dir.normalize();
	const n = dir.clone().negate();
	const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n).normalize();
	const up = new THREE.Vector3().crossVectors(n, right).normalize();
	const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, n));
	const origin = eye.clone().addScaledVector(dir, 1.5).add(new THREE.Vector3(0, -0.2, 0));
	return { origin, quat };
}

function buildVisual() {
	const g = new THREE.Group();
	g.name = 'vector-work-plane';
	g.userData.isEditOverlay = true;
	const sheet = new THREE.Mesh(
		new THREE.PlaneGeometry(PLANE_HALF * 2, PLANE_HALF * 2),
		new THREE.MeshBasicMaterial({ color: 0x4f8cff, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide })
	);
	sheet.name = 'vector-work-plane-sheet';
	/** @type {number[]} */
	const lines = [];
	for (let k = -PLANE_HALF; k <= PLANE_HALF + 1e-9; k += 0.25) lines.push(k, -PLANE_HALF, 0, k, PLANE_HALF, 0, -PLANE_HALF, k, 0, PLANE_HALF, k, 0);
	const lg = new THREE.BufferGeometry();
	lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
	const grid = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x8ec5ff, transparent: true, opacity: 0.25, depthWrite: false }));
	const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
	dot.name = 'vector-work-plane-dot';
	dot.renderOrder = 22;
	dot.visible = false;
	g.add(sheet, grid, dot);
	return g;
}

function syncVisual() {
	if (!laser) return;
	laser.visual.position.copy(laser.origin);
	laser.visual.quaternion.copy(laser.quat);
	laser.visual.updateMatrixWorld(true);
}

export function armLaserPen() {
	if (laser) return true;
	const { origin, quat } = planeAhead();
	const visual = buildVisual();
	/** @type {any} */ (get(globalScene))?.add(visual);
	laser = { origin, quat, visual, offs: [], drag: null, grip: null, claimed: [false, false], ticks: 0 };
	syncVisual();
	beginPenAt(origin.toArray(), quat.toArray());
	laser.offs.push(
		registerVRTriggerHooks({ start: triggerStart, end: triggerEnd, swallow: swallow }),
		registerGripHooks({ start: gripStart, end: gripEnd }),
		registerVRFrameHook(frame)
	);
	vectorLaserPen.set(true);
	return true;
}

export function disarmLaserPen() {
	if (!laser) return false;
	for (const off of laser.offs) off();
	/** @type {any} */ (get(globalScene))?.remove(laser.visual);
	laser.visual.traverse((/** @type {any} */ o) => {
		o.geometry?.dispose();
		o.material?.dispose();
	});
	laser = null;
	cancelDraft();
	vectorLaserPen.set(false);
	return true;
}

/** the laser of slot `index` on the plane, in plane coordinates (null off the sheet) @param {number} index */
function hitOf(index) {
	if (!laser) return null;
	const ray = controllerRay(index).ray;
	const n = new THREE.Vector3(0, 0, 1).applyQuaternion(laser.quat);
	const p = ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, laser.origin), new THREE.Vector3());
	if (!p) return null;
	const local = p.clone().sub(laser.origin).applyQuaternion(laser.quat.clone().invert());
	if (Math.abs(local.x) > PLANE_HALF || Math.abs(local.y) > PLANE_HALF) return null;
	return { world: p, at: [local.x, local.y] };
}

/** a short tick on the hand that placed the point @param {number} index */
function tick(index) {
	if (laser) laser.ticks++;
	if (!hapticsAllowed()) return;
	const hand = renderer?.xr?.getController?.(index)?.userData?.handedness;
	hapticPulse(0.25, 12, hand === 'left' || hand === 'right' ? hand : undefined, true);
}

/** a fresh draft on the same plane (after a finish) */
function restart() {
	if (laser) beginPenAt(laser.origin.toArray(), laser.quat.toArray());
}

/** @param {number} index */
function triggerStart(index) {
	if (!laser || get(vrMenuOpen)) return false;
	const hit = hitOf(index);
	if (!hit) return false;
	laser.claimed[index] = true;
	const nodes = vectorToolDebug().pen ?? [];
	const first = nodes[0];
	if (first && nodes.length >= 2 && Math.hypot(first.x - hit.at[0], first.y - hit.at[1]) < CLOSE_M) {
		finishPen(true);
		tick(index);
		restart();
		return true;
	}
	const at = penSnap(hit.at);
	if (!penAddPoint(at[0], at[1])) {
		restart();
		penAddPoint(at[0], at[1]);
	}
	tick(index);
	laser.drag = { slot: index, index: (vectorToolDebug().pen?.length ?? 1) - 1, at };
	return true;
}

/** @param {number} index */
function triggerEnd(index) {
	if (!laser?.drag || laser.drag.slot !== index) return false;
	laser.drag = null;
	return true;
}

/** eat the trailing 'select' of a press the pen took (it must not select what is behind the plane) @param {number} index */
function swallow(index) {
	if (!laser) return false;
	const slots = index >= 0 ? [index] : [0, 1];
	for (const i of slots)
		if (laser.claimed[i]) {
			laser.claimed[i] = false;
			return true;
		}
	return false;
}

/** the grip carries the plane @param {number} index */
function gripStart(index) {
	if (!laser || laser.grip) return false;
	const ctrl = renderer?.xr?.getController?.(index);
	if (!ctrl) return false;
	ctrl.updateMatrixWorld(true);
	laser.grip = { slot: index, ctrl0: ctrl.matrixWorld.clone(), plane0: new THREE.Matrix4().compose(laser.origin, laser.quat, new THREE.Vector3(1, 1, 1)) };
	return true;
}

/** @param {number} index */
function gripEnd(index) {
	if (!laser?.grip || laser.grip.slot !== index) return false;
	laser.grip = null;
	return true;
}

/** per frame: the carried plane, the handle being pulled, the laser's dot */
function frame() {
	if (!laser) return;
	if (laser.grip) {
		const ctrl = renderer?.xr?.getController?.(laser.grip.slot);
		if (ctrl) {
			ctrl.updateMatrixWorld(true);
			const m = ctrl.matrixWorld.clone().multiply(laser.grip.ctrl0.clone().invert()).multiply(laser.grip.plane0);
			const s = new THREE.Vector3();
			m.decompose(laser.origin, laser.quat, s);
			syncVisual();
			setPenFrame(laser.origin.toArray(), laser.quat.toArray());
		}
	}
	const dot = laser.visual.getObjectByName('vector-work-plane-dot');
	const slot = laser.drag?.slot ?? 1;
	const hit = hitOf(slot) ?? hitOf(1 - slot);
	if (dot) {
		dot.visible = !!hit;
		if (hit) dot.position.set(hit.at[0], hit.at[1], 0.002);
	}
	if (laser.drag) {
		const h = hitOf(laser.drag.slot);
		if (h && Math.hypot(h.at[0] - laser.drag.at[0], h.at[1] - laser.drag.at[1]) > DRAG_M) penHandleTo(laser.drag.index, h.at[0], h.at[1]);
	}
}

/** radial: Finish path (open) — the plane stays for the next one */
export function laserFinish() {
	const made = finishPen(false);
	restart();
	return made;
}

/** radial: Undo point */
export function laserUndoPoint() {
	undoPenPoint();
	if (laser && !(vectorToolDebug().pen?.length ?? 0)) restart();
}

/** suites: the pen's state */
export function laserPenDebug() {
	return {
		active: !!laser,
		origin: laser?.origin.toArray() ?? null,
		quat: laser?.quat.toArray() ?? null,
		points: get(penDraft).count,
		nodes: vectorToolDebug().pen,
		drag: laser?.drag ?? null,
		grip: !!laser?.grip,
		ticks: laser?.ticks ?? 0
	};
}
