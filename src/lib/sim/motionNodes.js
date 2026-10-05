// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { normalizeFlowPath, arcLengths, pointAt, arcLengthOf } from './flowPathCore.js';

// 36-fb F25 + F24: two EFFECT nodes for water machinery, a LEAF (three + flowPathCore) that
// flowRuntime calls from applyAnimation — it imports nothing of the runtime (the history cycle).
//
// ROTATE / MOTOR (`rotor`) — turns its object about one LOCAL axis (so a tilted wheel turns
// about its own axle, which the Euler-adding Spin cannot do), about the object's ORIGIN when it
// has one (a mill wheel hinged on its hub). Two regimes, chosen by what the object IS:
//   · not a dynamic body in a running simulation → KINEMATIC: the angle is a pure function of
//     the shared clock (rpm, with a spin-up ramp), the deterministic-netcode family of Spin.
//     Physics already turns a flow-animated object into a kinematic body, so the wheel shoves
//     boats, and the fluid sees its paddles move (fluidColliders measures ω) and is carried;
//   · a DYNAMIC body during a run (physics owns its pose) → a real MOTOR on the initiator:
//     each frame a torque impulse about the axle toward the target speed, capped by `torque`
//     (N·m), so water piling into the scoops slows it — the motor is as strong as it says.
//
// FLOAT ALONG FLOW (`flowfloat`) — a leaf, a toy boat: it rides a Flow path from where it was
// placed, at the path's speed (× `speed`), keeping its height above the water line, bobbing,
// turning to face the current; it wraps at the end (a closed loop circles forever). A pure
// function of (base pose, path, shared time): every peer computes the same pose, nothing is
// sent, and the base pose (where you put it) is what saves.

const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const qBase = new THREE.Quaternion();
const qSpin = new THREE.Quaternion();
const eul = new THREE.Euler();
const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vPivot = new THREE.Vector3();

/** rpm → rad/s @param {number} rpm */
const radPerSec = (rpm) => (rpm * Math.PI * 2) / 60;

/**
 * The rotor's angle at `time` (s on the shared, pause-folded clock): a constant speed after a
 * linear spin-up of `spinUp` seconds from t = 0 (continuous in angle and speed).
 * @param {number} rpm @param {number} spinUp @param {number} time
 */
export function rotorAngle(rpm, spinUp, time) {
	const w = radPerSec(rpm);
	const t = Math.max(0, time);
	if (spinUp > 0 && t < spinUp) return (w * t * t) / (2 * spinUp);
	return w * (t - Math.max(0, spinUp) / 2);
}

/**
 * @param {any} object @param {{pos: number[], rot: number[], scale: number[]}} base @param {any} data node data
 * @param {number} time @param {{suspended: boolean, physics: any, pivot: THREE.Vector3 | null, key: string, now: number}} ctx
 */
export function applyRotor(object, base, data, time, ctx) {
	const axis = AXES[/** @type {'x'|'y'|'z'} */ (data.axis)] ?? AXES.x;
	const on = data.on !== false && data.on !== 0;
	const rpm = Number.isFinite(+data.rpm) ? +data.rpm : 10;
	if (ctx.suspended) {
		// a dynamic body during a run: drive it (initiator only — physics authority)
		if (on) driveBody(object, axis, rpm, +data.torque || 0, ctx);
		return;
	}
	if (!on) return; // rests at its base pose
	const angle = rotorAngle(rpm, Math.max(0, +data.spinUp || 0), time);
	qBase.setFromEuler(eul.set(base.rot[0], base.rot[1], base.rot[2]));
	qSpin.setFromAxisAngle(axis, angle);
	object.quaternion.copy(qBase).multiply(qSpin);
	if (ctx.pivot) {
		// turn about the origin: the axle in the PARENT frame is the base rotation of the local axis
		vA.copy(axis).applyQuaternion(qBase);
		qSpin.setFromAxisAngle(vA, angle);
		vPivot.copy(ctx.pivot);
		object.position.fromArray(base.pos).sub(vPivot).applyQuaternion(qSpin).add(vPivot);
	}
}

/** @type {Map<string, number>} the last frame time per drive (dt for the torque cap) */
const lastDrive = new Map();

/**
 * One torque impulse about the axle toward the target speed, capped by the motor's torque.
 * @param {any} object @param {THREE.Vector3} axis local @param {number} rpm @param {number} torque N·m
 * @param {{physics: any, key: string, now: number}} ctx
 */
function driveBody(object, axis, rpm, torque, ctx) {
	const phys = ctx.physics;
	if (!phys?.isInitiator?.()) return;
	const vel = phys.bodyVelocityOf?.(object.uuid);
	if (!vel || vel.hold) return;
	const prev = lastDrive.get(ctx.key);
	lastDrive.set(ctx.key, ctx.now);
	const dt = prev ? Math.min(0.1, Math.max(0, (ctx.now - prev) / 1000)) : 1 / 60;
	if (!dt || torque <= 0) return;
	object.updateWorldMatrix(true, false);
	const axisW = vA.copy(axis).applyQuaternion(object.getWorldQuaternion(qBase)).normalize();
	const w = vel.angvel[0] * axisW.x + vel.angvel[1] * axisW.y + vel.angvel[2] * axisW.z;
	const dw = radPerSec(rpm) - w;
	// inertia about the axle ≈ m r² / 2 (a disc), r from the object's size
	const g = object.geometry;
	if (g && !g.boundingBox) g.computeBoundingBox();
	const size = g?.boundingBox ? g.boundingBox.getSize(vB).multiply(object.getWorldScale(new THREE.Vector3())) : vB.set(1, 1, 1);
	const r = Math.max(size.x, size.y, size.z) / 2;
	const mass = object.userData?.physics?.mass ?? 1;
	const want = (mass * r * r * 0.5) * dw;
	const cap = torque * dt;
	const j = Math.max(-cap, Math.min(cap, want));
	if (Math.abs(j) < 1e-6) return;
	phys.applyTorqueImpulse?.(object.uuid, [axisW.x * j, axisW.y * j, axisW.z * j]);
}

/** TEST: forget the drive clocks */
export function resetMotionNodes() {
	lastDrive.clear();
	floatCache.clear();
}

// ---------------------------------------------------------------- float along flow

/** @type {Map<string, {sig: string, s0: number, dy: number, yaw0: number}>} where a floater starts */
const floatCache = new Map();

/**
 * The path a floater rides: the wired one, else the NEAREST flow path (within 4 m) to where it
 * was placed — so a leaf dropped on a river needs no wiring at all.
 * @param {any} root objectsGroup @param {any} data @param {THREE.Vector3} at world
 */
function pathFor(root, data, at) {
	if (typeof data.path === 'string' && data.path && data.path !== '-None-') {
		const o = root?.getObjectByProperty('uuid', data.path);
		if (o?.userData?.flowPath) return o;
	}
	let best = null;
	let bestD = 16;
	root?.traverse((/** @type {any} */ o) => {
		if (!o.userData?.flowPath) return;
		const pts = worldPoints(o);
		const s = arcLengthOf(pts, [at.x, at.y, at.z]);
		const { cum } = arcLengths(pts);
		const p = pointAt(pts, cum, s).p;
		const d = (p[0] - at.x) ** 2 + (p[1] - at.y) ** 2 + (p[2] - at.z) ** 2;
		if (d < bestD) {
			bestD = d;
			best = o;
		}
	});
	return best;
}

/** a path's points in world space @param {any} o */
function worldPoints(o) {
	o.updateWorldMatrix(true, false);
	const spec = normalizeFlowPath(o.userData.flowPath);
	return spec.points.map((p) => vB.set(p[0], p[1], p[2]).applyMatrix4(o.matrixWorld).toArray());
}

/** yaw of a horizontal direction (three: rotation.y turns -Z toward -X) @param {number[]} t */
const yawOf = (t) => Math.atan2(t[0], t[2]);

/**
 * @param {any} object @param {{pos: number[], rot: number[], scale: number[]}} base @param {any} data
 * @param {number} time @param {{root: any, key: string}} ctx
 */
export function applyFlowFloat(object, base, data, time, ctx) {
	const parent = object.parent;
	if (!parent) return;
	parent.updateWorldMatrix(true, false);
	const baseW = vA.fromArray(base.pos).applyMatrix4(parent.matrixWorld).clone();
	const path = pathFor(ctx.root, data, baseW);
	if (!path) return;
	const spec = normalizeFlowPath(path.userData.flowPath);
	const pts = worldPoints(path);
	const { cum, total } = arcLengths(pts);
	if (total <= 0) return;
	// where it starts: cached by the base pose + the path's shape (a moved leaf re-anchors)
	const sig = base.pos.join(',') + '|' + path.uuid + '|' + pts.flat().map((v) => v.toFixed(3)).join(',');
	let start = floatCache.get(ctx.key);
	if (!start || start.sig !== sig) {
		const s0 = arcLengthOf(pts, [baseW.x, baseW.y, baseW.z]);
		const at = pointAt(pts, cum, s0);
		start = { sig, s0, dy: baseW.y - at.p[1], yaw0: yawOf(at.t) };
		floatCache.set(ctx.key, start);
	}
	const mult = Number.isFinite(+data.speed) ? +data.speed : 1;
	let s = start.s0 + spec.speed * mult * Math.max(0, time);
	s = ((s % total) + total) % total;
	const here = pointAt(pts, cum, s);
	const bob = (Number.isFinite(+data.bob) ? +data.bob : 0.03) * Math.sin(time * 2.1 + start.s0 * 3.7);
	const w = vB.set(here.p[0], here.p[1] + start.dy + bob, here.p[2]);
	object.position.copy(parent.worldToLocal(w));
	if (data.align !== false && Math.hypot(here.t[0], here.t[2]) > 1e-3) {
		qBase.setFromEuler(eul.set(base.rot[0], base.rot[1], base.rot[2]));
		qSpin.setFromAxisAngle(AXES.y, yawOf(here.t) - start.yaw0);
		object.quaternion.copy(qSpin).multiply(qBase);
	}
}
