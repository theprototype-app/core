// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import {
	oscillateAt,
	tweenEvents,
	tweenProgress,
	easedPosition,
	openEvent,
	pivotPoint,
	clampNum,
	OSCILLATE_DEFAULTS
} from './tweenCore.js';

// 85 N1 / N2 — Oscillate and the Tween nodes (Move to / Rotate to / Scale to), the THREE half.
// A LEAF beside motionNodes.js: three and the pure core only, nothing of the runtime (the
// history cycle). flowRuntime.applyAnimation resolves the trigger stamps (they need the graph)
// and calls in here with plain numbers.
//
// Each effect ADDS to the pose the frame already has (the base restore, then every effect on the
// object in turn), so an Oscillate on a door that a Rotate To is opening sways about the open
// pose, and a Spin on the same object still turns it.

const AXES = /** @type {Record<string, THREE.Vector3>} */ ({
	x: new THREE.Vector3(1, 0, 0),
	y: new THREE.Vector3(0, 1, 0),
	z: new THREE.Vector3(0, 0, 1)
});
const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vC = new THREE.Vector3();
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();
const mA = new THREE.Matrix4();
const box = new THREE.Box3();
const DEG = Math.PI / 180;

/** @param {any} axis */
const axisOf = (axis) => AXES[axis] ?? AXES.y;

// ---- local bounds (for the pivot faces) --------------------------------------------------------

/** per object: its subtree's bounds in its OWN frame, rebuilt when the geometry changes
 * @type {WeakMap<any, {sig: string, min: number[], max: number[]} | null>} */
const boundsCache = new WeakMap();

/** @param {any} object */
function boundsSig(object) {
	let sig = '';
	object.traverse((/** @type {any} */ o) => {
		if (o.isMesh && o.geometry) sig += o.uuid + ':' + o.geometry.uuid + ',';
	});
	return sig;
}

/**
 * The object's subtree bounds in its own local frame (its own scale NOT applied — the pivot is
 * then scaled with the object), or null for an object with no mesh (a light, an empty).
 * @param {any} object
 */
export function localBounds(object) {
	const sig = boundsSig(object);
	const held = boundsCache.get(object);
	if (held && held.sig === sig) return held;
	if (!sig) {
		boundsCache.set(object, null);
		return null;
	}
	box.makeEmpty();
	object.traverse((/** @type {any} */ o) => {
		if (!o.isMesh || !o.geometry) return;
		if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
		const bb = o.geometry.boundingBox;
		if (!bb) return;
		// the mesh's matrix relative to the object, from the LOCAL chain
		mA.identity();
		for (let n = o; n && n !== object; n = n.parent) {
			n.updateMatrix();
			mA.premultiply(n.matrix);
		}
		for (let i = 0; i < 8; i++) {
			vA.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(mA);
			box.expandByPoint(vA);
		}
	});
	const out = box.isEmpty() ? null : { sig, min: box.min.toArray(), max: box.max.toArray() };
	boundsCache.set(object, out);
	return out;
}

/**
 * The pivot in the object's local frame: a face of its bounds, else its Origin (userData.origin,
 * the Spin rule), else its centre.
 * @param {any} object @param {string} pivot @returns {number[]}
 */
export function pivotLocal(object, pivot) {
	const face = pivot && pivot !== 'origin' ? pivotPoint(pivot, localBounds(object)) : null;
	if (face) return face;
	const origin = object?.userData?.origin;
	return Array.isArray(origin) && origin.length === 3 && origin.every(Number.isFinite) ? origin : [0, 0, 0];
}

/**
 * Turn the object by `angle` (radians) about its LOCAL `axis`, through `pivot` (local), from its
 * CURRENT pose — a door on its hinge, a sign on its hook.
 * @param {any} object @param {string} axis @param {number} angle @param {number[]} pivot
 */
export function rotateAbout(object, axis, angle, pivot) {
	if (!angle) return;
	const s = object.scale;
	const local = vA.fromArray(pivot).multiply(s);
	// the pivot in the parent frame, before the turn
	const world = vB.copy(local).applyQuaternion(object.quaternion).add(object.position);
	qA.setFromAxisAngle(axisOf(axis), angle);
	object.quaternion.multiply(qA);
	// keep the pivot where it was
	object.position.copy(world).sub(vC.copy(local).applyQuaternion(object.quaternion));
}

/**
 * Scale the object's CURRENT scale by `f` (per axis) keeping `pivot` (local) where it is — a
 * plant that grows from its foot.
 * @param {any} object @param {number[]} f @param {number[]} pivot
 */
function scaleAbout(object, f, pivot) {
	const before = vA.fromArray(pivot).multiply(object.scale).applyQuaternion(object.quaternion);
	object.scale.set(object.scale.x * f[0], object.scale.y * f[1], object.scale.z * f[2]);
	const after = vB.fromArray(pivot).multiply(object.scale).applyQuaternion(object.quaternion);
	object.position.add(before.sub(after));
}

// ---- N1 Oscillate ----------------------------------------------------------------------------------

/**
 * Oscillate / Swing: a sine (or triangle / bob) on rotation, position or scale, from the shared
 * clock — or, with a trigger wired, a swing that starts at the trigger's stamp and dies away with
 * `damping` (a bell that is struck, a sign that is knocked).
 * @param {any} object @param {any} data @param {number} time
 * @param {{start: number | null, armed: boolean}} s
 * @returns {number} the value applied (degrees / metres / fraction)
 */
export function applyOscillate(object, data, time, s) {
	const v = oscillateAt(data, time, s.start, s.armed);
	if (!v) return 0;
	const axis = typeof data?.axis === 'string' ? data.axis : OSCILLATE_DEFAULTS.axis;
	const property = data?.property ?? OSCILLATE_DEFAULTS.property;
	if (property === 'position') {
		// along the PARENT's axis, the Bounce rule: "y" is up whatever the object's tilt
		object.position.addScaledVector(axisOf(axis), v);
	} else if (property === 'scale') {
		const f = Math.max(0.001, 1 + v);
		scaleAbout(object, axis === 'all' ? [f, f, f] : [axis === 'x' ? f : 1, axis === 'y' ? f : 1, axis === 'z' ? f : 1], pivotLocal(object, data?.pivot ?? 'origin'));
	} else {
		rotateAbout(object, axis, v * DEG, pivotLocal(object, data?.pivot ?? OSCILLATE_DEFAULTS.pivot));
	}
	return v;
}

// ---- N2 Tweens ---------------------------------------------------------------------------------------

/** an `open` boolean's state per (node, object), kept per peer @type {Map<string, {value: boolean, events: any[], seen: number}>} */
const opens = new Map();
/** the last read per (node, object): the debug hook and the suites @type {Map<string, any>} */
const reads = new Map();
let frameNo = 0;

/** call once per runtime tick: forget the boolean states nobody read for a while */
export function tickTweenNodes() {
	frameNo++;
	if (frameNo % 120) return;
	for (const [key, o] of opens) if (frameNo - o.seen > 240) opens.delete(key);
	for (const [key, r] of reads) if (frameNo - r.seen > 240) reads.delete(key);
}

/**
 * Where a tween stands this frame (0 = rest, 1 = goal; back / elastic may overshoot).
 * `amount` wired = the position IS that number (a variable drives the door by hand).
 * @param {string} key @param {any} data @param {number} time
 * @param {{trigger: number | null, back: number | null, toggle: number | null, toggleCount: number, openWired: boolean, anyWired: boolean, amountWired: boolean}} s
 */
export function tweenPosition(key, data, time, s) {
	if (s.amountWired) {
		const a = clampNum(data?.amount, 0, -1, 2);
		return { pos: a, raw: a, moving: false, dir: a >= 0.5 ? 1 : 0 };
	}
	/** @type {any[]} */
	let open = [];
	if (s.openWired) {
		const held = opens.get(key);
		const next = openEvent(held, data?.open, time);
		opens.set(key, { ...next, seen: frameNo });
		open = next.events;
	}
	const events = tweenEvents({ trigger: s.trigger, back: s.back, toggle: s.toggle, toggleCount: s.toggleCount, open });
	const duration = clampNum(data?.duration, 1, 0.01, 600);
	const p = tweenProgress(events, time, duration, data?.repeat ?? 'none', !s.anyWired);
	const pos = easedPosition(p, typeof data?.easing === 'string' ? data.easing : 'smooth');
	return { pos, raw: p.raw, moving: p.moving, dir: p.dir };
}

/**
 * A goal given as an object (a uuid off an Object Selector) or a world / offset point.
 * @param {any} root the scene objects @param {any} v @returns {THREE.Object3D | null}
 */
function objectGoal(root, v) {
	if (typeof v !== 'string' || !v || !root) return null;
	return root.getObjectByProperty?.('uuid', v) ?? null;
}

/** a world point into the object's PARENT frame @param {any} object @param {THREE.Vector3} p */
function toParent(object, p) {
	if (object.parent) {
		object.parent.updateWorldMatrix(true, false);
		p.applyMatrix4(mA.copy(object.parent.matrixWorld).invert());
	}
	return p;
}

/**
 * Move To / Rotate To / Scale To at position `pos` (0 = the rest pose, 1 = the goal).
 * @param {string} type 'moveto' | 'rotateto' | 'scaleto' @param {any} object @param {any} base
 * @param {any} data @param {number} pos @param {{root: any}} ctx
 */
export function applyTween(type, object, base, data, pos, ctx) {
	if (!pos) return;
	if (type === 'moveto') {
		const goal = objectGoal(ctx.root, data?.to);
		let offset;
		if (goal) offset = toParent(object, goal.getWorldPosition(vC)).sub(vA.fromArray(base.pos));
		else {
			const p = Array.isArray(data?.to) && data.to.length === 3 && data.to.every(Number.isFinite) ? data.to : [clampNum(data?.x, 0, -1e4, 1e4), clampNum(data?.y, 0, -1e4, 1e4), clampNum(data?.z, 0, -1e4, 1e4)];
			offset = vC.fromArray(p);
			if (data?.space === 'world') offset = toParent(object, offset).sub(vA.fromArray(base.pos));
		}
		object.position.addScaledVector(offset, pos);
		return;
	}
	if (type === 'rotateto') {
		const goal = objectGoal(ctx.root, data?.to);
		if (goal) {
			// turn to MATCH another object's rotation (in the parent frame), about the centre
			goal.updateWorldMatrix(true, false);
			goal.getWorldQuaternion(qB);
			if (object.parent) qB.premultiply(object.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
			qA.copy(object.quaternion).slerp(qB, Math.max(0, Math.min(1, pos)));
			object.quaternion.copy(qA);
			return;
		}
		const angle = clampNum(data?.angle, 90, -3600, 3600) * DEG * pos;
		rotateAbout(object, data?.axis ?? 'y', angle, pivotLocal(object, data?.pivot ?? 'origin'));
		return;
	}
	if (type === 'scaleto') {
		const goal = objectGoal(ctx.root, data?.to);
		/** @type {number[]} */
		let f;
		if (goal) {
			goal.updateWorldMatrix(true, false);
			goal.getWorldScale(vC);
			f = [vC.x / (object.scale.x || 1), vC.y / (object.scale.y || 1), vC.z / (object.scale.z || 1)];
		} else {
			const k = clampNum(data?.factor, 2, 0.001, 1000);
			const axis = data?.axis ?? 'all';
			f = [axis === 'all' || axis === 'x' ? k : 1, axis === 'all' || axis === 'y' ? k : 1, axis === 'all' || axis === 'z' ? k : 1];
		}
		const g = f.map((k) => Math.max(0.001, 1 + (k - 1) * pos));
		scaleAbout(object, g, pivotLocal(object, data?.pivot ?? 'origin'));
	}
}

/** record a tween's read for the debug hook @param {string} key @param {any} read */
export function noteTweenRead(key, read) {
	reads.set(key, { ...read, seen: frameNo });
}

/** debug: the live tween reads */
export function tweenNodesDebug() {
	return { opens: opens.size, reads: Object.fromEntries([...reads].map(([k, r]) => [k, { pos: r.pos, moving: r.moving, dir: r.dir }])) };
}

export function resetTweenNodes() {
	opens.clear();
	reads.clear();
}
