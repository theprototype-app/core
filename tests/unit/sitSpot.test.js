// 85 I3: where a Sit Spot puts your eyes, and which way it faces you
import { describe, it, expect } from 'vitest';
// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { seatPose } from '../../src/lib/sitSpotCore.js';

const seat = () => {
	const m = new THREE.Mesh(new THREE.BoxGeometry(1, 0.5, 1));
	m.position.set(2, 0.25, -3);
	return m;
};

describe('seatPose', () => {
	it('puts the eyes eyeHeight above the seat top, centred', () => {
		const p = seatPose(seat(), { eyeHeight: 0.7 });
		expect(p.eye[0]).toBeCloseTo(2, 9);
		expect(p.eye[1]).toBeCloseTo(0.5 + 0.7, 9);
		expect(p.eye[2]).toBeCloseTo(-3, 9);
		expect(p.floor).toBeCloseTo(0, 9);
	});
	it('faces the seat front: +z front looks toward +z (yaw PI)', () => {
		const p = seatPose(seat(), { facing: '+z' });
		const look = [-Math.sin(p.yaw), -Math.cos(p.yaw)];
		expect(look[0]).toBeCloseTo(0, 9);
		expect(look[1]).toBeCloseTo(1, 9);
	});
	it('follows the seat turning, and forward shifts toward the front', () => {
		const s = seat();
		s.rotation.y = Math.PI / 2; // local +z now points to world +x
		const p = seatPose(s, { facing: '+z', forward: 0.2 });
		expect(-Math.sin(p.yaw)).toBeCloseTo(1, 9);
		expect(p.eye[0]).toBeCloseTo(2.2, 9);
	});
});
