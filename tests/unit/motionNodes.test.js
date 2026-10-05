// @ts-nocheck — plain fixtures; the code under test is typed
// 36-fb F25 + F24: the Rotate / Motor node (kinematic angle, local axis, origin pivot, the
// torque-capped drive) and Float Along Flow (a pure function of base, path and time).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { rotorAngle, applyRotor, applyFlowFloat, resetMotionNodes } from '../../src/lib/sim/motionNodes.js';
import { stampFlowPath, flowPathGeometry } from '../../src/lib/sim/flowPathObject.js';

const base = (o) => ({ pos: o.position.toArray(), rot: [o.rotation.x, o.rotation.y, o.rotation.z], scale: o.scale.toArray() });

describe('Rotate / Motor', () => {
	it('angle: constant rpm after a continuous spin-up', () => {
		expect(rotorAngle(60, 0, 1)).toBeCloseTo(Math.PI * 2, 6); // 60 rpm = one turn a second
		expect(rotorAngle(60, 2, 1)).toBeCloseTo(Math.PI / 2, 6); // half way up the ramp: ω t² / 2T
		expect(rotorAngle(60, 2, 3)).toBeCloseTo(Math.PI * 2 * 2, 6); // after it: ω (t - T/2)
		expect(rotorAngle(-30, 0, 2)).toBeCloseTo(-Math.PI * 2, 6);
	});
	it('turns about the LOCAL axis: a wheel tilted 90° about z still turns about its own x', () => {
		const o = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
		o.rotation.set(0, 0, Math.PI / 2);
		const b = base(o);
		applyRotor(o, b, { axis: 'x', rpm: 15, spinUp: 0 }, 1, { suspended: false, physics: null, pivot: null, key: 'k', now: 0 });
		// the local x axis is unchanged by a spin about it
		const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(o.quaternion);
		const ax0 = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(...b.rot));
		expect(ax.distanceTo(ax0)).toBeLessThan(1e-6);
		// and the object did turn (a quarter turn at 15 rpm after 1 s)
		const y = new THREE.Vector3(0, 1, 0).applyQuaternion(o.quaternion);
		const y0 = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(...b.rot));
		expect(y.angleTo(y0)).toBeCloseTo(Math.PI / 2, 5);
	});
	it('turns about the origin pivot (a wheel on its hub): the position orbits the pivot', () => {
		const o = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
		o.position.set(2, 1, 0);
		const pivot = new THREE.Vector3(2, 0, 0);
		applyRotor(o, base(o), { axis: 'z', rpm: 15, spinUp: 0 }, 1, { suspended: false, physics: null, pivot, key: 'k', now: 0 });
		expect(o.position.distanceTo(pivot)).toBeCloseTo(1, 6);
		expect(o.position.x).toBeCloseTo(1, 5); // a quarter turn about +z moves +y to -x
	});
	it('off = rests at its base pose; a dynamic body is never posed, it is driven (initiator only, torque-capped)', () => {
		const o = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 0.2));
		o.userData.physics = { mode: 'dynamic', mass: 4 };
		const b = base(o);
		applyRotor(o, b, { axis: 'z', rpm: 30, on: false }, 5, { suspended: false, physics: null, pivot: null, key: 'k', now: 0 });
		expect(o.quaternion.w).toBeCloseTo(1, 9);
		const impulses = [];
		const physics = { isInitiator: () => true, bodyVelocityOf: () => ({ angvel: [0, 0, 0], hold: null }), applyTorqueImpulse: (u, j) => impulses.push(j) };
		resetMotionNodes();
		applyRotor(o, b, { axis: 'z', rpm: 30, torque: 10 }, 5, { suspended: true, physics, pivot: null, key: 'd', now: 1000 });
		applyRotor(o, b, { axis: 'z', rpm: 30, torque: 10 }, 5, { suspended: true, physics, pivot: null, key: 'd', now: 1016 });
		expect(o.quaternion.w).toBeCloseTo(1, 9); // no pose write
		expect(impulses.length).toBe(2);
		const last = impulses[1];
		expect(last[0]).toBe(0);
		expect(last[2]).toBeGreaterThan(0);
		expect(last[2]).toBeLessThanOrEqual(10 * 0.016 + 1e-9); // torque × dt
		// a non-initiator never drives
		const quiet = [];
		applyRotor(o, b, { axis: 'z', rpm: 30, torque: 10 }, 5, { suspended: true, physics: { ...physics, isInitiator: () => false, applyTorqueImpulse: (u, j) => quiet.push(j) }, pivot: null, key: 'q', now: 0 });
		expect(quiet.length).toBe(0);
	});
});

describe('Float Along Flow', () => {
	function scene() {
		const root = new THREE.Group();
		const path = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
		stampFlowPath(path);
		path.userData.flowPath = { ...path.userData.flowPath, points: [[0, 0, 0], [4, 0, 0]], speed: 0.5 };
		root.add(path);
		const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.1));
		leaf.position.set(1, 0.05, 0.1);
		root.add(leaf);
		root.updateMatrixWorld(true);
		return { root, path, leaf };
	}
	it('rides the nearest path from where it was placed, keeping its height, wrapping at the end', () => {
		resetMotionNodes();
		const { root, leaf } = scene();
		const b = base(leaf);
		applyFlowFloat(leaf, b, { speed: 1, bob: 0, align: true }, 2, { root, key: 'f' });
		expect(leaf.position.x).toBeCloseTo(2, 5); // 1 + 0.5 m/s × 2 s
		expect(leaf.position.y).toBeCloseTo(0.05, 5);
		applyFlowFloat(leaf, b, { speed: 1, bob: 0 }, 8, { root, key: 'f' });
		expect(leaf.position.x).toBeCloseTo(1, 5); // 1 + 4 = 5 → wraps on a 4 m path
	});
	it('the same base, path and time give the same pose (the netcode)', () => {
		resetMotionNodes();
		const a = scene();
		const b = scene();
		applyFlowFloat(a.leaf, base(a.leaf), { speed: 1.3, bob: 0.03 }, 3.7, { root: a.root, key: 'a' });
		applyFlowFloat(b.leaf, base(b.leaf), { speed: 1.3, bob: 0.03 }, 3.7, { root: b.root, key: 'b' });
		expect(a.leaf.position.toArray()).toEqual(b.leaf.position.toArray());
		expect(a.leaf.quaternion.toArray()).toEqual(b.leaf.quaternion.toArray());
	});
	it('no flow path near: it stays where it is', () => {
		resetMotionNodes();
		const { root, leaf } = scene();
		leaf.position.set(30, 0, 30);
		const b = base(leaf);
		applyFlowFloat(leaf, b, {}, 5, { root, key: 'n' });
		expect(leaf.position.toArray()).toEqual([30, 0, 30]);
	});
});

describe('flow path geometry', () => {
	it('river and pipe both survive a toJSON → ObjectLoader round trip (saves, peer sync)', () => {
		for (const kind of ['river', 'pipe']) {
			const m = new THREE.Mesh(flowPathGeometry({ kind, points: [[0, 0, 0], [1, 0.5, 0], [2, 0, 1]] }), new THREE.MeshStandardMaterial());
			const back = new THREE.ObjectLoader().parse(m.toJSON());
			expect(back.geometry.attributes.position.count).toBe(m.geometry.attributes.position.count);
		}
	});
	it('a river ribbon faces up and spans its width', () => {
		const g = flowPathGeometry({ points: [[0, 0, 0], [3, 0, 0]], width: 0.6 });
		g.computeBoundingBox();
		expect(g.boundingBox.max.z - g.boundingBox.min.z).toBeCloseTo(0.6, 5);
		expect(g.attributes.normal.getY(0)).toBeGreaterThan(0.99);
	});
});
