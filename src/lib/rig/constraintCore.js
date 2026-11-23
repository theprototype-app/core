// 102 M7 — CONSTRAINTS AND IK, the pure half (three's maths only: no scene, no stores, no wire).
//
// A constraint lives in the OWNER object's `userData.constraints` (an ordered list, saved and
// replicated with the object); it poses the owner itself (`bone: ''`) or one named node inside it
// (a bone of a rigged model, or a child part of a built object). The runtime
// (constraintRuntime.js) calls `applyConstraint` for each entry, in list order, after animation
// and before physics, on every peer from the replicated targets: no pose ever travels.
//
// Kinds (fixed set; an unknown kind is preserved verbatim and skipped — a newer peer's work is
// never deleted by an older editor):
//   lookat  — an axis of the owner points at the target; another axis keeps to world up
//   copy    — copy the target's world position / rotation / scale (per channel); with an
//             `offset` it is a "Parent": the owner keeps the pose it had relative to the target
//   limit   — clamp the owner's local rotation per axis (degrees, Euler XYZ)
//   ik2     — two-bone IK (arm, leg): the tip reaches the target, the middle joint bends toward
//             the pole (where it bends now when there is no pole)
//   ikchain — CCD chain IK over `count` joints above the tip (tails, tentacles, cranes)
//
// We checked three's CCDIKSolver first: it takes a SkinnedMesh plus bone INDICES and a target
// BONE, so it can neither drive a plain object chain nor aim at a scene object, and it has no
// pole. The VRM look-at drives eyes only (its own schema). Both are kept for what they do; this
// module is the one solver roadmaps 96 (bones for built meshes) and 65 (animate anything) call.

import * as THREE from 'three';

export const CONSTRAINT_KINDS = Object.freeze(['lookat', 'copy', 'limit', 'ik2', 'ikchain']);
export const MAX_CONSTRAINTS = 16;
export const AXES = Object.freeze(['+x', '-x', '+y', '-y', '+z', '-z']);
const NAME_MAX = 200;

/** @typedef {{uuid: string, bone?: string}} TargetRef */
/** @typedef {{id: string, kind: string, mute: boolean, weight: number, bone: string, target: TargetRef | null, [k: string]: any}} Constraint */

const clamp01 = (/** @type {any} */ v, /** @type {number} */ d) => {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
};
const str = (/** @type {any} */ v, /** @type {number} */ max = NAME_MAX) => (typeof v === 'string' ? v.slice(0, max) : '');
const finite = (/** @type {any} */ v, /** @type {number} */ d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const axis = (/** @type {any} */ v, /** @type {string} */ d) => (AXES.includes(v) ? v : d);
const bools3 = (/** @type {any} */ v, /** @type {boolean} */ d) =>
	Array.isArray(v) ? [0, 1, 2].map((i) => (typeof v[i] === 'boolean' ? v[i] : d)) : [d, d, d];

/** @param {any} t @returns {TargetRef | null} */
export function normalizeTarget(t) {
	if (!t || typeof t !== 'object' || typeof t.uuid !== 'string' || !t.uuid || t.uuid.length > 64) return null;
	const bone = str(t.bone);
	return bone ? { uuid: t.uuid, bone } : { uuid: t.uuid };
}

let idSeq = 0;
/** A short id, unique inside one object's list. @param {Set<string>} [taken] */
export function newConstraintId(taken = new Set()) {
	for (;;) {
		const id = 'c' + Date.now().toString(36).slice(-4) + (idSeq++ % 1296).toString(36);
		if (!taken.has(id)) return id;
	}
}

/** Defaults for a new constraint of `kind`. @param {string} kind @param {Set<string>} [taken] */
export function makeConstraint(kind, taken) {
	return normalizeConstraint({ id: newConstraintId(taken), kind });
}

/**
 * One entry, cleaned. Unknown kinds keep every field (verbatim) and are skipped at evaluation.
 * @param {any} c @returns {Constraint | null}
 */
export function normalizeConstraint(c) {
	if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
	const id = str(c.id, 24);
	if (!id) return null;
	if (!CONSTRAINT_KINDS.includes(c.kind)) {
		if (typeof c.kind !== 'string' || !c.kind || c.kind.length > 24) return null;
		return /** @type {Constraint} */ ({ ...c, id });
	}
	/** @type {Constraint} */
	const out = { id, kind: c.kind, mute: c.mute === true, weight: clamp01(c.weight, 1), bone: str(c.bone), target: normalizeTarget(c.target) };
	if (typeof c.name === 'string' && c.name) out.name = str(c.name, 60);
	if (c.kind === 'lookat') {
		out.aim = axis(c.aim, '+z');
		let up = axis(c.up, '+y');
		if (up[1] === out.aim[1]) up = out.aim[1] === 'y' ? '+z' : '+y'; // the up axis must be another axis
		out.up = up;
	} else if (c.kind === 'copy') {
		out.position = bools3(c.position, true);
		out.rotation = typeof c.rotation === 'boolean' ? c.rotation : true;
		out.scale = typeof c.scale === 'boolean' ? c.scale : false;
		out.offset = Array.isArray(c.offset) && c.offset.length === 10 && c.offset.every(Number.isFinite) ? c.offset.slice() : null;
	} else if (c.kind === 'limit') {
		out.axes = bools3(c.axes, true);
		out.min = [0, 1, 2].map((i) => Math.max(-180, Math.min(180, finite(c.min?.[i], -45))));
		out.max = [0, 1, 2].map((i) => Math.max(out.min[i], Math.min(180, finite(c.max?.[i], 45))));
	} else if (c.kind === 'ik2') {
		out.pole = normalizeTarget(c.pole);
		out.tipRotation = c.tipRotation === true;
	} else if (c.kind === 'ikchain') {
		out.count = Math.max(2, Math.min(16, Math.round(finite(c.count, 3))));
		out.iterations = Math.max(1, Math.min(32, Math.round(finite(c.iterations, 12))));
	}
	return out;
}

/** The whole list: at most 16 entries, unique ids, order kept. @param {any} list @returns {Constraint[]} */
export function normalizeConstraints(list) {
	if (!Array.isArray(list)) return [];
	/** @type {Constraint[]} */
	const out = [];
	const seen = new Set();
	for (const raw of list) {
		const c = normalizeConstraint(raw);
		if (!c || seen.has(c.id)) continue;
		seen.add(c.id);
		out.push(c);
		if (out.length >= MAX_CONSTRAINTS) break;
	}
	return out;
}

/** Object uuids a constraint list reads (targets + poles). @param {Constraint[]} list */
export function dependenciesOf(list) {
	const out = new Set();
	for (const c of list) {
		if (c.mute) continue;
		if (c.target?.uuid) out.add(c.target.uuid);
		if (c.pole?.uuid) out.add(c.pole.uuid);
	}
	return [...out];
}

/**
 * THE EVALUATION ORDER, the same on every peer: an owner runs after every owner it reads (its
 * targets, its poles, its nearest constrained ancestor); ties go by tree depth, then uuid. A
 * cycle (A looks at B, B looks at A) cannot be ordered, so its members fall back to depth + uuid
 * order — deterministic, one frame behind for one of them, never a hang.
 * @param {{uuid: string, depth: number, deps: string[]}[]} entries
 * @returns {string[]}
 */
export function evaluationOrder(entries) {
	const byId = new Map(entries.map((e) => [e.uuid, e]));
	const key = (/** @type {{depth: number, uuid: string}} */ e) => e;
	const sorted = [...entries].sort((a, b) => a.depth - b.depth || (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0)).map(key);
	/** @type {Map<string, number>} */
	const state = new Map(); // 1 = visiting, 2 = done
	/** @type {string[]} */
	const out = [];
	/** @param {string} id */
	const visit = (id) => {
		const s = state.get(id);
		if (s === 2 || s === 1) return; // done, or on the stack (a cycle: leave it to the sorted pass)
		const e = byId.get(id);
		if (!e) return;
		state.set(id, 1);
		const deps = [...new Set(e.deps)].filter((d) => d !== id && byId.has(d));
		deps.sort((a, b) => {
			const ea = /** @type {any} */ (byId.get(a)), eb = /** @type {any} */ (byId.get(b));
			return ea.depth - eb.depth || (a < b ? -1 : a > b ? 1 : 0);
		});
		for (const d of deps) visit(d);
		state.set(id, 2);
		out.push(id);
	};
	for (const e of sorted) visit(e.uuid);
	return out;
}

// ---------------------------------------------------------------------------------------------
// Maths on live Object3Ds (a node's local pose is written; matrices are refreshed as we go)

const AXIS_VEC = /** @type {Record<string, THREE.Vector3>} */ ({
	'+x': new THREE.Vector3(1, 0, 0),
	'-x': new THREE.Vector3(-1, 0, 0),
	'+y': new THREE.Vector3(0, 1, 0),
	'-y': new THREE.Vector3(0, -1, 0),
	'+z': new THREE.Vector3(0, 0, 1),
	'-z': new THREE.Vector3(0, 0, -1)
});

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

/** Refresh one node's world matrix from its (already fresh) parent, and its subtree. @param {THREE.Object3D} node */
export function refreshWorld(node) {
	node.updateMatrix();
	if (node.parent) node.matrixWorld.multiplyMatrices(node.parent.matrixWorld, node.matrix);
	else node.matrixWorld.copy(node.matrix);
	for (const child of node.children) child.updateMatrixWorld(true);
}

/** @param {THREE.Object3D} node @param {THREE.Vector3} [out] */
export function worldPos(node, out = new THREE.Vector3()) {
	return out.setFromMatrixPosition(node.matrixWorld);
}

/** @param {THREE.Object3D} node @param {THREE.Quaternion} [out] */
export function worldQuat(node, out = new THREE.Quaternion()) {
	node.matrixWorld.decompose(_v3, out, _v2);
	return out;
}

/** The parent's world rotation (identity at the root). @param {THREE.Object3D} node @param {THREE.Quaternion} out */
function parentWorldQuat(node, out) {
	if (!node.parent) return out.identity();
	return worldQuat(node.parent, out);
}

/** Set a node's WORLD rotation by changing its local quaternion. @param {THREE.Object3D} node @param {THREE.Quaternion} wq */
export function setWorldQuat(node, wq) {
	parentWorldQuat(node, _q2);
	node.quaternion.copy(_q2.invert().multiply(wq)).normalize();
	refreshWorld(node);
}

/** Turn a node so its world rotation becomes dq × (current world rotation). @param {THREE.Object3D} node @param {THREE.Quaternion} dq */
function turnWorld(node, dq) {
	const wq = worldQuat(node, new THREE.Quaternion());
	setWorldQuat(node, dq.clone().multiply(wq));
}

/**
 * LOOK AT: the world rotation that points `aim` (owner axis) along `dir` and keeps `up` (another
 * owner axis) as close to world +Y as it can; `dir` parallel to world up keeps the up axis
 * toward world +Z instead (no flip-flop at the pole).
 * @param {THREE.Vector3} dir world direction (any length > 0) @param {string} aim @param {string} up
 * @returns {THREE.Quaternion | null}
 */
export function lookRotation(dir, aim, up) {
	if (dir.lengthSq() < 1e-12) return null;
	const a = dir.clone().normalize();
	let u = new THREE.Vector3(0, 1, 0);
	if (Math.abs(a.dot(u)) > 0.9999) u = new THREE.Vector3(0, 0, 1);
	u.sub(a.clone().multiplyScalar(u.dot(a))).normalize();
	const third = new THREE.Vector3().crossVectors(a, u);
	const A = AXIS_VEC[aim], U = AXIS_VEC[up];
	const T = new THREE.Vector3().crossVectors(A, U);
	_m1.makeBasis(a, u, third);
	_m2.makeBasis(A, U, T).transpose(); // orthonormal: inverse = transpose
	return new THREE.Quaternion().setFromRotationMatrix(_m1.multiply(_m2));
}

/**
 * TWO-BONE IK on three live nodes (upper → lower → tip, each the parent of the next or any
 * descendant of it). Moves the upper and lower joints' local rotations only. Out of reach = the
 * limb straightens toward the target; closer than |l1 − l2| = it folds as far as it can.
 * `pole` (world) is where the middle joint should point; null = the side it bends to now.
 * @param {THREE.Object3D} upper @param {THREE.Object3D} lower @param {THREE.Object3D} tip
 * @param {THREE.Vector3} target @param {THREE.Vector3 | null} pole
 * @returns {number} the remaining miss (m)
 */
export function solveTwoBone(upper, lower, tip, target, pole) {
	const A = worldPos(upper, new THREE.Vector3());
	const B = worldPos(lower, new THREE.Vector3());
	const C = worldPos(tip, new THREE.Vector3());
	const l1 = B.distanceTo(A), l2 = C.distanceTo(B);
	if (l1 < 1e-6 || l2 < 1e-6) return C.distanceTo(target);
	const dv = target.clone().sub(A);
	const full = dv.length();
	const d = Math.min(Math.max(full, Math.abs(l1 - l2) + 1e-5, 1e-5), (l1 + l2) * 0.99999);
	const dir = full > 1e-6 ? dv.divideScalar(full) : C.clone().sub(A).normalize();
	// the bend plane: toward the pole, else toward where the middle joint is now
	const h = pole ? pole.clone().sub(A) : B.clone().sub(A);
	let perp = h.sub(dir.clone().multiplyScalar(h.dot(dir)));
	if (perp.lengthSq() < 1e-12) {
		// the knee is on the line (a straight limb): bend toward the current tip-side normal, else any
		const side = C.clone().sub(A).cross(dir);
		perp = side.lengthSq() > 1e-12 ? side.cross(dir) : Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
		perp.sub(dir.clone().multiplyScalar(perp.dot(dir)));
	}
	perp.normalize();
	const cosA = Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
	const knee = A.clone().addScaledVector(dir, l1 * cosA).addScaledVector(perp, l1 * Math.sqrt(Math.max(0, 1 - cosA * cosA)));
	turnWorld(upper, new THREE.Quaternion().setFromUnitVectors(B.clone().sub(A).normalize(), knee.clone().sub(A).normalize()));
	const B2 = worldPos(lower, new THREE.Vector3()), C2 = worldPos(tip, new THREE.Vector3());
	const goal = A.clone().addScaledVector(dir, d);
	const from = C2.clone().sub(B2), to = goal.sub(B2);
	if (from.lengthSq() > 1e-12 && to.lengthSq() > 1e-12) turnWorld(lower, new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize()));
	return worldPos(tip, _v1).distanceTo(target);
}

/**
 * CCD over `joints` (root first) toward `target`, the tip being `tip`. Deterministic: the same
 * start pose gives the same answer, so every peer that starts from the same base agrees.
 * @param {THREE.Object3D[]} joints @param {THREE.Object3D} tip @param {THREE.Vector3} target @param {number} iterations
 * @returns {number} the remaining miss (m)
 */
export function solveCcd(joints, tip, target, iterations) {
	for (let it = 0; it < iterations; it++) {
		for (let k = joints.length - 1; k >= 0; k--) {
			const j = joints[k];
			const J = worldPos(j, _v1.clone());
			const u = worldPos(tip, _v2.clone()).sub(J);
			const w = target.clone().sub(J);
			if (u.lengthSq() < 1e-12 || w.lengthSq() < 1e-12) continue;
			turnWorld(j, _q1.setFromUnitVectors(u.normalize(), w.normalize()).clone());
		}
		if (worldPos(tip, _v1).distanceTo(target) < 1e-4) break;
	}
	return worldPos(tip, _v1).distanceTo(target);
}

/** Clamp a node's local rotation to per-axis Euler limits (degrees). @param {THREE.Object3D} node @param {Constraint} c */
export function clampRotation(node, c) {
	const e = new THREE.Euler().setFromQuaternion(node.quaternion, 'XYZ');
	const k = ['x', 'y', 'z'];
	for (let i = 0; i < 3; i++) {
		if (!c.axes[i]) continue;
		const lo = THREE.MathUtils.degToRad(c.min[i]), hi = THREE.MathUtils.degToRad(c.max[i]);
		/** @type {any} */ (e)[k[i]] = Math.min(hi, Math.max(lo, /** @type {any} */ (e)[k[i]]));
	}
	node.quaternion.setFromEuler(e);
	refreshWorld(node);
}

/** The world matrix a copy / parent constraint wants. @param {THREE.Object3D} targetNode @param {Constraint} c */
function copyWorld(targetNode, c) {
	const m = targetNode.matrixWorld.clone();
	if (c.offset) {
		const o = c.offset;
		m.multiply(new THREE.Matrix4().compose(new THREE.Vector3(o[0], o[1], o[2]), new THREE.Quaternion(o[3], o[4], o[5], o[6]).normalize(), new THREE.Vector3(o[7], o[8], o[9])));
	}
	return m;
}

/**
 * The "Parent" offset: the owner's pose relative to the target right now (p3 q4 s3), so a
 * copy constraint with it keeps the owner where it is and then follows.
 * @param {THREE.Object3D} owner @param {THREE.Object3D} targetNode @returns {number[]}
 */
export function captureOffset(owner, targetNode) {
	const rel = targetNode.matrixWorld.clone().invert().multiply(owner.matrixWorld);
	const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
	rel.decompose(p, q, s);
	return [...p.toArray(), ...q.toArray(), ...s.toArray()].map((v) => Math.round(v * 1e6) / 1e6);
}

/** Snapshot a node's local pose (for the weight blend). @param {THREE.Object3D} n */
export function poseOf(n) {
	return { p: n.position.clone(), q: n.quaternion.clone(), s: n.scale.clone() };
}

/** Blend a node from `before` to its current pose by `w` (lerp / slerp), then refresh. @param {THREE.Object3D} n @param {{p: THREE.Vector3, q: THREE.Quaternion, s: THREE.Vector3}} before @param {number} w */
function blendFrom(n, before, w) {
	if (w >= 1) return;
	n.position.lerpVectors(before.p, n.position, w);
	n.quaternion.slerpQuaternions(before.q, n.quaternion.clone(), w);
	n.scale.lerpVectors(before.s, n.scale, w);
	refreshWorld(n);
}

/**
 * Apply ONE constraint to its owner node, weighted. `resolve(ref)` finds a target node (null =
 * not in the scene yet: the constraint does nothing this frame). Matrices of the owner's
 * ancestors and of every target must be fresh; the owner's subtree is refreshed here.
 * @param {THREE.Object3D} owner the node `c.bone` names ('' = the object)
 * @param {Constraint} c
 * @param {(ref: TargetRef) => THREE.Object3D | null} resolve
 * @param {{weight?: number, stop?: THREE.Object3D | null}} [opts] `weight` = the effective weight (a
 *   runtime override, else c.weight); `stop` = the node an IK chain may not climb into (the scene's
 *   objects group: a chain of nested objects never reaches the world root)
 * @returns {{ok: boolean, miss?: number, reason?: string}}
 */
export function applyConstraint(owner, c, resolve, opts = {}) {
	const weight = opts.weight ?? c.weight;
	if (c.mute || !(weight > 0)) return { ok: false, reason: 'off' };
	if (!CONSTRAINT_KINDS.includes(c.kind)) return { ok: false, reason: 'unknown kind' };
	if (c.kind === 'limit') {
		const before = poseOf(owner);
		clampRotation(owner, c);
		blendFrom(owner, before, weight);
		return { ok: true };
	}
	const targetNode = c.target ? resolve(c.target) : null;
	if (!targetNode) return { ok: false, reason: 'no target' };
	if (targetNode === owner) return { ok: false, reason: 'targets itself' };
	const target = worldPos(targetNode, new THREE.Vector3());
	if (c.kind === 'lookat') {
		const dir = target.sub(worldPos(owner, _v1.clone()));
		const wq = lookRotation(dir, c.aim, c.up);
		if (!wq) return { ok: false, reason: 'on target' };
		const before = poseOf(owner);
		setWorldQuat(owner, wq);
		blendFrom(owner, before, weight);
		return { ok: true };
	}
	if (c.kind === 'copy') {
		const want = copyWorld(targetNode, c);
		const local = owner.parent ? owner.parent.matrixWorld.clone().invert().multiply(want) : want;
		const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
		local.decompose(p, q, s);
		const before = poseOf(owner);
		if (c.position[0]) owner.position.x = p.x;
		if (c.position[1]) owner.position.y = p.y;
		if (c.position[2]) owner.position.z = p.z;
		if (c.rotation) owner.quaternion.copy(q);
		if (c.scale) owner.scale.copy(s);
		refreshWorld(owner);
		blendFrom(owner, before, weight);
		return { ok: true };
	}
	// IK: the owner is the TIP; the joints are its ancestors
	const joints = chainAbove(owner, c.kind === 'ik2' ? 2 : c.count, opts.stop ?? null);
	if (!joints) return { ok: false, reason: 'chain too short' };
	const befores = joints.map(poseOf);
	const tipBefore = poseOf(owner);
	let miss;
	if (c.kind === 'ik2') {
		const poleNode = c.pole ? resolve(c.pole) : null;
		miss = solveTwoBone(joints[0], joints[1], owner, target, poleNode ? worldPos(poleNode, new THREE.Vector3()) : null);
		if (c.tipRotation) setWorldQuat(owner, worldQuat(targetNode, new THREE.Quaternion()));
	} else {
		miss = solveCcd(joints, owner, target, c.iterations);
	}
	if (weight < 1) {
		joints.forEach((j, i) => blendFrom(j, befores[i], weight));
		blendFrom(owner, tipBefore, weight);
	}
	return { ok: true, miss };
}

/**
 * The `count` joints above a tip, root first, or null when the tip has fewer ancestors below
 * `stop` (and below the scene). @param {THREE.Object3D} tip @param {number} count @param {THREE.Object3D | null} [stop]
 */
export function chainAbove(tip, count, stop = null) {
	/** @type {THREE.Object3D[]} */
	const out = [];
	let n = tip.parent;
	while (n && n !== stop && !(/** @type {any} */ (n).isScene) && out.length < count) {
		out.unshift(n);
		n = n.parent;
	}
	return out.length === count ? out : null;
}

/**
 * Every node a constraint writes (for base capture + parking): the owner, plus the IK joints.
 * @param {THREE.Object3D} owner @param {Constraint} c @param {THREE.Object3D | null} [stop]
 */
export function nodesWritten(owner, c, stop = null) {
	if (c.kind === 'ik2' || c.kind === 'ikchain') {
		const joints = chainAbove(owner, c.kind === 'ik2' ? 2 : c.count, stop) ?? [];
		return [...joints, owner];
	}
	return [owner];
}
