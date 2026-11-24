// 102 M7: the constraint core — solvers reach / clamp / follow the pole, the evaluation order,
// look-at, copy + parent offset, rotation limits, weights and the normalizer.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
	normalizeConstraint,
	normalizeConstraints,
	makeConstraint,
	evaluationOrder,
	dependenciesOf,
	applyConstraint,
	captureOffset,
	chainAbove,
	nodesWritten,
	lookRotation,
	worldPos,
	MAX_CONSTRAINTS
} from '../../src/lib/rig/constraintCore.js';

/** an arm: shoulder at the origin, elbow 1 m along +x, hand 1 m further */
function arm() {
	const root = new THREE.Group();
	const upper = new THREE.Object3D();
	const lower = new THREE.Object3D();
	const hand = new THREE.Object3D();
	upper.name = 'upper';
	lower.name = 'lower';
	hand.name = 'hand';
	lower.position.set(1, 0, 0);
	hand.position.set(1, 0, 0);
	root.add(upper);
	upper.add(lower);
	lower.add(hand);
	root.updateMatrixWorld(true);
	return { root, upper, lower, hand };
}

/** a target node at p (in its own root) @param {number[]} p */
function at(p) {
	const t = new THREE.Object3D();
	t.position.fromArray(p);
	t.updateMatrixWorld(true);
	return t;
}

const W = (/** @type {THREE.Object3D} */ n) => worldPos(n, new THREE.Vector3());

describe('normalize', () => {
	it('cleans, clamps and keeps an unknown kind verbatim', () => {
		const c = /** @type {any} */ (normalizeConstraint({ id: 'a', kind: 'lookat', weight: 7, aim: '+y', up: '-y', target: { uuid: 'u1', bone: 'Head' } }));
		expect(c.weight).toBe(1);
		expect(c.aim).toBe('+y');
		expect(c.up).not.toMatch(/y$/); // up may not share the aim axis
		expect(c.target).toEqual({ uuid: 'u1', bone: 'Head' });
		expect(normalizeConstraint({ id: 'b', kind: 'futurekind', extra: 3 })).toEqual({ id: 'b', kind: 'futurekind', extra: 3 });
		expect(normalizeConstraint({ kind: 'lookat' })).toBeNull(); // no id
		const chain = /** @type {any} */ (normalizeConstraint({ id: 'c', kind: 'ikchain', count: 99, iterations: -4 }));
		expect(chain.count).toBe(16);
		expect(chain.iterations).toBe(1);
		const lim = /** @type {any} */ (normalizeConstraint({ id: 'd', kind: 'limit', min: [10, 0, -500], max: [5, 20, 0] }));
		expect(lim.max[0]).toBe(10); // max never below min
		expect(lim.min[2]).toBe(-180);
	});
	it('drops duplicates and caps the list', () => {
		const many = Array.from({ length: 40 }, (_, i) => ({ id: 'x' + (i % 30), kind: 'limit' }));
		const out = normalizeConstraints(many);
		expect(out.length).toBe(MAX_CONSTRAINTS);
		expect(new Set(out.map((c) => c.id)).size).toBe(out.length);
		expect(normalizeConstraints('nope')).toEqual([]);
	});
	it('makes fresh ids', () => {
		const a = makeConstraint('ik2');
		const b = makeConstraint('ik2', new Set([/** @type {any} */ (a).id]));
		expect(/** @type {any} */ (a).id).not.toBe(/** @type {any} */ (b).id);
	});
});

describe('evaluation order', () => {
	it('runs an owner after what it reads, ties by depth then uuid', () => {
		const order = evaluationOrder([
			{ uuid: 'hand', depth: 1, deps: ['target'] },
			{ uuid: 'target', depth: 1, deps: ['mover'] },
			{ uuid: 'mover', depth: 2, deps: [] },
			{ uuid: 'aaa', depth: 0, deps: [] }
		]);
		expect(order).toEqual(['aaa', 'mover', 'target', 'hand']);
	});
	it('orders a cycle deterministically and never hangs', () => {
		const one = evaluationOrder([
			{ uuid: 'b', depth: 0, deps: ['a'] },
			{ uuid: 'a', depth: 0, deps: ['b'] }
		]);
		const two = evaluationOrder([
			{ uuid: 'a', depth: 0, deps: ['b'] },
			{ uuid: 'b', depth: 0, deps: ['a'] }
		]);
		expect(one).toEqual(two);
		expect(one.length).toBe(2);
	});
	it('reads targets and poles but not muted entries', () => {
		const list = normalizeConstraints([
			{ id: '1', kind: 'ik2', target: { uuid: 't' }, pole: { uuid: 'p' } },
			{ id: '2', kind: 'lookat', target: { uuid: 'm' }, mute: true }
		]);
		expect(dependenciesOf(list).sort()).toEqual(['p', 't']);
	});
});

describe('two-bone IK', () => {
	const ik = (/** @type {any} */ extra = {}) => /** @type {any} */ (normalizeConstraint({ id: 'k', kind: 'ik2', target: { uuid: 't' }, ...extra }));
	it('reaches a target in range', () => {
		const { upper, hand } = arm();
		const t = at([1.2, 0.8, 0]);
		const r = applyConstraint(hand, ik(), () => t);
		expect(r.ok).toBe(true);
		expect(W(hand).distanceTo(W(t))).toBeLessThan(1e-4);
		expect(upper.position.length()).toBe(0); // joints only rotate
	});
	it('straightens toward a target out of reach', () => {
		const { hand } = arm();
		const t = at([0, 5, 0]);
		const r = applyConstraint(hand, ik(), () => t);
		const h = W(hand);
		expect(h.length()).toBeCloseTo(2, 3); // the full limb, no stretch
		expect(h.clone().normalize().dot(new THREE.Vector3(0, 1, 0))).toBeGreaterThan(0.9999);
		expect(r.miss).toBeCloseTo(3, 2);
	});
	it('folds as far as it can for a target at the shoulder', () => {
		const { hand } = arm();
		const t = at([0, 0, 0]);
		applyConstraint(hand, ik(), () => t);
		expect(Number.isFinite(W(hand).x)).toBe(true);
	});
	it('bends the elbow toward the pole, and flips when the pole crosses', () => {
		const a = arm();
		const t = at([1.4, 0, 0]);
		const poleUp = at([0.7, 0, 1]);
		applyConstraint(a.hand, ik({ pole: { uuid: 'p' } }), (ref) => (ref.uuid === 'p' ? poleUp : t));
		expect(W(a.lower).z).toBeGreaterThan(0.5);
		expect(W(a.hand).distanceTo(W(t))).toBeLessThan(1e-4);
		const b = arm();
		const poleDown = at([0.7, 0, -1]);
		applyConstraint(b.hand, ik({ pole: { uuid: 'p' } }), (ref) => (ref.uuid === 'p' ? poleDown : t));
		expect(W(b.lower).z).toBeLessThan(-0.5);
	});
	it('copies the target rotation onto the tip when asked', () => {
		const { hand } = arm();
		const t = at([1, 1, 0]);
		t.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1);
		t.updateMatrixWorld(true);
		applyConstraint(hand, ik({ tipRotation: true }), () => t);
		const q = new THREE.Quaternion();
		hand.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3());
		expect(q.angleTo(t.quaternion)).toBeLessThan(1e-4);
	});
	it('weight 0.5 lands between the rest pose and the solve; muted does nothing', () => {
		const { hand } = arm();
		const t = at([0, 2, 0]);
		const rest = W(hand).clone();
		applyConstraint(hand, ik({ weight: 0.5 }), () => t);
		const half = W(hand);
		expect(half.distanceTo(rest)).toBeGreaterThan(0.2);
		expect(half.distanceTo(W(t))).toBeGreaterThan(0.2);
		const b = arm();
		const r = applyConstraint(b.hand, ik({ mute: true }), () => t);
		expect(r.ok).toBe(false);
		expect(W(b.hand).x).toBeCloseTo(2, 6);
	});
	it('refuses a chain that is too short or would climb past the stop node', () => {
		const { root, lower } = arm();
		expect(chainAbove(lower, 2, root)).toBeNull();
		expect(applyConstraint(lower, ik(), () => at([1, 1, 0]), { stop: root }).reason).toBe('chain too short');
	});
});

describe('chain IK (CCD)', () => {
	/** a tail of n links of 0.5 m along +x @param {number} n */
	function tail(n) {
		const root = new THREE.Group();
		/** @type {THREE.Object3D[]} */
		const links = [];
		let parent = /** @type {THREE.Object3D} */ (root);
		for (let i = 0; i <= n; i++) {
			const l = new THREE.Object3D();
			if (i) l.position.set(0.5, 0, 0);
			parent.add(l);
			links.push(l);
			parent = l;
		}
		root.updateMatrixWorld(true);
		return { root, links, tip: links[n] };
	}
	it('reaches a curled target with 4 joints', () => {
		const { links, tip } = tail(4);
		const t = at([0.8, 1.1, 0.3]);
		const c = /** @type {any} */ (normalizeConstraint({ id: 'k', kind: 'ikchain', count: 4, iterations: 20, target: { uuid: 't' } }));
		const r = applyConstraint(tip, c, () => t);
		expect(r.miss).toBeLessThan(0.01);
		expect(nodesWritten(tip, c)).toEqual([...links.slice(0, 4), tip]);
	});
	it('is deterministic from the same start', () => {
		const a = tail(5), b = tail(5);
		const c = /** @type {any} */ (normalizeConstraint({ id: 'k', kind: 'ikchain', count: 5, target: { uuid: 't' } }));
		applyConstraint(a.tip, c, () => at([1, 1, 1]));
		applyConstraint(b.tip, c, () => at([1, 1, 1]));
		expect(W(a.tip).toArray()).toEqual(W(b.tip).toArray());
	});
});

describe('look at, copy, parent, limit', () => {
	it('points the aim axis at the target with the up axis up', () => {
		const o = at([0, 0, 0]);
		const t = at([3, 0, 0]);
		const c = /** @type {any} */ (normalizeConstraint({ id: 'l', kind: 'lookat', target: { uuid: 't' } }));
		applyConstraint(o, c, () => t);
		const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion);
		const up = new THREE.Vector3(0, 1, 0).applyQuaternion(o.quaternion);
		expect(fwd.x).toBeCloseTo(1, 6);
		expect(up.y).toBeCloseTo(1, 6);
		// straight up: no NaN at the pole
		expect(lookRotation(new THREE.Vector3(0, 1, 0), '+z', '+y')).not.toBeNull();
		const camLike = /** @type {any} */ (normalizeConstraint({ id: 'l2', kind: 'lookat', aim: '-z', target: { uuid: 't' } }));
		const cam = at([0, 0, 0]);
		applyConstraint(cam, camLike, () => t);
		expect(new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).x).toBeCloseTo(1, 6);
	});
	it('works inside a rotated parent', () => {
		const parent = new THREE.Group();
		parent.rotation.y = 1.2;
		parent.position.set(1, 0, 0);
		const o = new THREE.Object3D();
		parent.add(o);
		parent.updateMatrixWorld(true);
		const t = at([1, 5, 0]);
		applyConstraint(o, /** @type {any} */ (normalizeConstraint({ id: 'l', kind: 'lookat', aim: '+y', up: '+z', target: { uuid: 't' } })), () => t);
		const q = new THREE.Quaternion();
		o.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3());
		expect(new THREE.Vector3(0, 1, 0).applyQuaternion(q).y).toBeCloseTo(1, 6);
	});
	it('copies chosen channels only', () => {
		const o = at([0, 0, 0]);
		const t = at([2, 3, 4]);
		t.rotation.z = 0.7;
		t.updateMatrixWorld(true);
		const c = /** @type {any} */ (normalizeConstraint({ id: 'c', kind: 'copy', position: [true, false, true], rotation: false, target: { uuid: 't' } }));
		applyConstraint(o, c, () => t);
		expect(o.position.toArray()).toEqual([2, 0, 4]);
		expect(o.quaternion.w).toBe(1);
	});
	it('parent: keeps the captured offset and follows', () => {
		const o = at([1, 0, 0]);
		const t = at([0, 0, 0]);
		const c = /** @type {any} */ (normalizeConstraint({ id: 'p', kind: 'copy', scale: true, target: { uuid: 't' } }));
		c.offset = captureOffset(o, t);
		t.position.set(0, 2, 0);
		t.rotation.y = Math.PI / 2;
		t.updateMatrixWorld(true);
		applyConstraint(o, c, () => t);
		expect(o.position.x).toBeCloseTo(0, 6);
		expect(o.position.y).toBeCloseTo(2, 6);
		expect(o.position.z).toBeCloseTo(-1, 6); // +x turned a quarter about y
	});
	it('limits rotation per axis', () => {
		const o = at([0, 0, 0]);
		o.rotation.set(1.5, -1.5, 0.2);
		o.updateMatrixWorld(true);
		const c = /** @type {any} */ (normalizeConstraint({ id: 'm', kind: 'limit', axes: [true, true, false], min: [-30, -30, -30], max: [30, 30, 30] }));
		applyConstraint(o, c, () => null);
		const e = new THREE.Euler().setFromQuaternion(o.quaternion, 'XYZ');
		expect(THREE.MathUtils.radToDeg(e.x)).toBeLessThanOrEqual(30.0001);
		expect(THREE.MathUtils.radToDeg(e.y)).toBeGreaterThanOrEqual(-30.0001);
	});
	it('does nothing without a target, or when it targets itself', () => {
		const o = at([0, 0, 0]);
		const c = /** @type {any} */ (normalizeConstraint({ id: 'l', kind: 'lookat', target: { uuid: 't' } }));
		expect(applyConstraint(o, c, () => null).reason).toBe('no target');
		expect(applyConstraint(o, c, () => o).reason).toBe('targets itself');
	});
});
