// 102-int-1: values that ARRIVE (a peer's message, a scene file, the autosave) are checked before they
// reach the simulator, the mesh loader or the array drawing. Each case pins one check.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { normalizeJointDef, bodyTuningOf } from '../../src/lib/physicsTuning.js';
import { inflateSharedGeometries } from '../../src/lib/sharedGeometry.js';
import { coerceTouchLayout } from '../../src/lib/touchActions.js';
import { tickArrays, arraysDebug, ARRAY_SCENE_COPIES } from '../../src/lib/arrayRuntime.js';

const hinge = () => ({ id: 'j1', a: 'obj-a', b: 'obj-b', kind: 'revolute', anchorA: [0, 1, 0], anchorB: [0, 0, 0], axisA: [0, 1, 0] });

describe('a joint def from a file or a peer', () => {
	it('a valid def comes back as the same object (old scenes stay byte-identical)', () => {
		const def = hinge();
		expect(normalizeJointDef(def)).toBe(def);
		const weld = { id: 'w', a: 'p', b: 'q', kind: 'weld', anchorA: [0, 0, 0], anchorB: [0, 0, 0] };
		expect(normalizeJointDef(weld)).toBe(weld);
		const old = { id: 'o', a: 'p', b: 'q', kind: 'revolute', anchorA: [0, 0, 0], anchorB: [0, 0, 0] }; // no axisA: stays so
		expect(normalizeJointDef(old)).toBe(old);
	});
	it('drops what cannot be a joint', () => {
		expect(normalizeJointDef(null)).toBe(null);
		expect(normalizeJointDef({ ...hinge(), a: 'same', b: 'same' })).toBe(null);
		expect(normalizeJointDef({ ...hinge(), id: '' })).toBe(null);
		expect(normalizeJointDef({ ...hinge(), kind: { x: 1 } })).toBe(null);
	});
	it('clamps spring values and drops non-finite ones', () => {
		const out = normalizeJointDef({ id: 's', a: 'p', b: 'q', kind: 'spring', anchorA: [0, 0, 0], anchorB: [0, 0, 0], stiffness: 1e300, damping: NaN, rest: -4 });
		expect(out.stiffness).toBe(100000);
		expect('damping' in out).toBe(false);
		expect(out.rest).toBe(0);
		expect(normalizeJointDef({ id: 'r', a: 'p', b: 'q', kind: 'rope', anchorA: [0, 0, 0], anchorB: [0, 0, 0], length: Infinity }).length).toBe(undefined);
	});
	it('a bad anchor, a zero axis or bad limits never reach the engine', () => {
		const out = normalizeJointDef({ ...hinge(), anchorA: [NaN, 0, 0], axisA: [0, 0, 0], limits: [2, 1] });
		expect(out.anchorA).toEqual([0, 0, 0]);
		expect(out.axisA).toEqual([0, 1, 0]);
		expect('limits' in out).toBe(false);
		expect(normalizeJointDef({ ...hinge(), anchorB: [1e9, 0, 0] }).anchorB).toEqual([0, 0, 0]);
	});
	it('a motor keeps only finite known values, clamped', () => {
		const out = normalizeJointDef({ ...hinge(), motor: { vel: 1e12, maxForce: -5, pos: Infinity, extra: 3 } });
		expect(out.motor).toEqual({ vel: 1000, maxForce: 0 });
	});
	it('a body tuning value from a file is clamped like the Inspector clamps it', () => {
		expect(bodyTuningOf({ gravityScale: 1e30, linearDamping: -1e38 }, null)).toEqual({ gravityScale: 5, linear: 0, angular: 0 });
		expect(bodyTuningOf({ gravityScale: 0.5 }, { damping: { linear: 0.2, angular: 0.3 } })).toEqual({ gravityScale: 0.5, linear: 0.2, angular: 0.3 });
	});
});

describe('repeated meshes in a file', () => {
	const mesh = () => ({ type: 'BufferGeometry', data: { attributes: { position: { itemSize: 3, type: 'Float32Array', array: new Array(300).fill(1) } } } });
	const payload = (/** @type {number} */ uses) => ({
		sharedGeometries: [mesh()],
		objects: [{ geometries: Array.from({ length: uses }, (_, i) => ({ uuid: 'g' + i, type: 'BoxGeometry', sharedGeometry: 0 })) }]
	});
	it('expand when they fit', () => {
		const p = inflateSharedGeometries(payload(3));
		expect(p.objects[0].geometries.every((/** @type {any} */ g) => g.type === 'BufferGeometry')).toBe(true);
		expect(p.sharedGeometries).toBe(undefined);
	});
	it('a file that would expand past the limit is refused before any copy', () => {
		const p = payload(1000);
		expect(() => inflateSharedGeometries(p, 100000)).toThrow(/expands to more than/);
		expect(p.objects[0].geometries[0].type).toBe('BoxGeometry');
	});
});

describe('a touch layout from a scene', () => {
	it('an id naming an object machinery key is skipped', () => {
		const raw = JSON.parse('{"items": {"__proto__": {"x": 0.5, "y": 0.5, "size": 64}, "jump": {"x": 0.9, "y": 0.9, "size": 64}}}');
		const out = /** @type {any} */ (coerceTouchLayout(raw));
		expect(Object.getPrototypeOf(out.items)).toBe(Object.prototype);
		expect(Object.keys(out.items)).toEqual(['jump']);
	});
});

describe('arrays share one scene-wide budget', () => {
	it('copies past the budget are not drawn, and come back when an array goes', () => {
		const scene = new THREE.Scene();
		const root = new THREE.Group();
		scene.add(root);
		const carriers = [];
		const per = 499; // a 10 x 10 x 5 grid: 500 cells, the object is the first
		const n = Math.ceil(ARRAY_SCENE_COPIES / per) + 4;
		for (let i = 0; i < n; i++) {
			const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
			m.userData.array = { mode: 'grid', grid: [10, 10, 5] };
			root.add(m);
			carriers.push(m);
		}
		tickArrays(carriers, root);
		const d = arraysDebug();
		const drawn = Object.values(d.copies).reduce((s, c) => s + c, 0);
		expect(drawn).toBeLessThanOrEqual(ARRAY_SCENE_COPIES);
		expect(d.capped.length).toBeGreaterThan(0);
		// two arrays go: the capped ones get their share on the next frames
		const left = carriers.slice(2);
		for (const c of carriers.slice(0, 2)) root.remove(c);
		tickArrays(left, root);
		tickArrays(left, root);
		const after = arraysDebug();
		expect(Object.values(after.copies).reduce((s, c) => s + c, 0)).toBe(ARRAY_SCENE_COPIES);
		tickArrays([], root);
	});
});
