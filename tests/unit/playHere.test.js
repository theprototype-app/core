// @ts-nocheck — plain fixture scenes
// 60 Q1: Play here — where the player lands. The ray straight down from the editor camera through
// a real three scene (boxes, a hidden box, a sensor, water, a reference image, the physics ground
// plane), the heading of the view, and the fallbacks: the scene's spawn, then the camera's own eye.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { playHereSpawnFrom, headingOf, surfaceBelowIn, notGround } from '../../src/lib/playHereCore.js';

const EYE = 1.7;
const GROUND_ON = { enabled: true, height: 0 };
const GROUND_OFF = { enabled: false, height: 0 };

/** a box whose top face sits at `top`, centred on (x, z), `size` wide */
function box(x, z, top, size = 2, userData = {}) {
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, 1, size), new THREE.MeshBasicMaterial());
	mesh.position.set(x, top - 0.5, z);
	Object.assign(mesh.userData, userData);
	return mesh;
}
function scene(...children) {
	const group = new THREE.Group();
	group.name = 'sceneObjects';
	for (const c of children) group.add(c);
	return group;
}
const below = (root, ground) => (eye) => surfaceBelowIn(root, eye, ground);

describe('surfaceBelowIn (the spawn raycast)', () => {
	it('lands on the first surface straight under the eye — the roof over the floor', () => {
		const root = scene(box(0, 0, 1), box(0, 0, 4, 1));
		expect(surfaceBelowIn(root, [0, 10, 0], GROUND_ON)).toBeCloseTo(4);
		// beside the tall box, the low one
		expect(surfaceBelowIn(root, [0.8, 10, 0.8], GROUND_ON)).toBeCloseTo(1);
	});
	it('falls through to the physics ground plane, and not when it is off', () => {
		const root = scene(box(0, 0, 1));
		expect(surfaceBelowIn(root, [20, 10, 20], GROUND_ON)).toBe(0);
		expect(surfaceBelowIn(root, [20, 10, 20], GROUND_OFF)).toBeNull();
		expect(surfaceBelowIn(null, [0, 3, 0], { enabled: true, height: 2 })).toBe(2);
	});
	it('a ground plane ABOVE the eye is not under it', () => {
		expect(surfaceBelowIn(scene(), [0, 1, 0], { enabled: true, height: 2 })).toBeNull();
	});
	it('a surface above the eye is not under it (inside a building you stand on its floor)', () => {
		const root = scene(box(0, 0, 0.5, 6), box(0, 0, 5, 6));
		expect(surfaceBelowIn(root, [0, 3, 0], GROUND_ON)).toBeCloseTo(0.5);
	});
	it('skips what a player cannot stand on: hidden, sensors, water, reference images', () => {
		const hidden = box(0, 0, 3);
		hidden.visible = false;
		const hiddenParent = new THREE.Group();
		hiddenParent.visible = false;
		hiddenParent.add(box(0, 0, 3.5));
		const root = scene(
			box(0, 0, 1),
			hidden,
			hiddenParent,
			box(0, 0, 4, 2, { physics: { sensor: true } }),
			box(0, 0, 5, 2, { water: { kind: 'surface' } }),
			box(0, 0, 6, 2, { underlay: true })
		);
		expect(surfaceBelowIn(root, [0, 10, 0], GROUND_ON)).toBeCloseTo(1);
		expect(notGround(hiddenParent.children[0], root)).toBe(true);
		expect(notGround(root.children[0], root)).toBe(false);
	});
	it('only meshes count (a line or points under the camera is not a floor)', () => {
		const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-1, 3, 0), new THREE.Vector3(1, 3, 0)]));
		const root = scene(line);
		expect(surfaceBelowIn(root, [0, 10, 0], GROUND_ON)).toBe(0);
	});
	it('reads world positions through parents (a group moved up carries its floor)', () => {
		const parent = new THREE.Group();
		parent.position.set(0, 3, 0);
		parent.add(box(0, 0, 1));
		expect(surfaceBelowIn(scene(parent), [0, 10, 0], GROUND_ON)).toBeCloseTo(4);
	});
});

describe('playHereSpawnFrom', () => {
	const spawn = { position: [5, 0, -5], yaw: 1.2 };
	it('stands the feet on the surface under the eye, facing the view', () => {
		const root = scene(box(30, -40, 2));
		const s = playHereSpawnFrom({ eye: [30, 12, -40], yaw: 0.5 }, below(root, GROUND_ON), spawn, EYE);
		expect(s.source).toBe('surface');
		expect(s.position[0]).toBe(30);
		expect(s.position[1]).toBeCloseTo(2);
		expect(s.position[2]).toBe(-40);
		expect(s.yaw).toBe(0.5);
	});
	it('nothing under the camera → the scene spawn, with its own facing', () => {
		const s = playHereSpawnFrom({ eye: [30, 12, -40], yaw: 0.5 }, below(scene(), GROUND_OFF), spawn, EYE);
		expect(s).toEqual({ position: [5, 0, -5], yaw: 1.2, source: 'spawn' });
	});
	it('below the ground plane → the scene spawn too', () => {
		const s = playHereSpawnFrom({ eye: [0, -3, 0], yaw: 0 }, below(scene(), GROUND_ON), spawn, EYE);
		expect(s.source).toBe('spawn');
	});
	it('no surface and no spawn → the eye stays where the camera is', () => {
		const s = playHereSpawnFrom({ eye: [1, 4, 2], yaw: -0.3 }, below(scene(), GROUND_OFF), null, EYE);
		expect(s.source).toBe('camera');
		expect(s.position[1] + EYE).toBeCloseTo(4);
		expect(s.yaw).toBe(-0.3);
	});
	it('a VR head height is the eye height there', () => {
		const s = playHereSpawnFrom({ eye: [0, 5, 0], yaw: 0 }, () => null, null, 1.4);
		expect(s.position[1]).toBeCloseTo(3.6);
	});
	it('a non-finite heading faces −Z rather than poisoning the camera', () => {
		const s = playHereSpawnFrom({ eye: [0, 5, 0], yaw: NaN }, () => 0, null, EYE);
		expect(s.yaw).toBe(0);
	});
});

describe('headingOf', () => {
	it('is rotation.y for a level view', () => {
		const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.8, 0, 'YXZ'));
		expect(headingOf(q)).toBeCloseTo(0.8);
	});
	it('keeps the heading of an editor camera tilted down (the usual three-quarter view)', () => {
		const cam = new THREE.PerspectiveCamera();
		cam.position.set(-10, 10, 10);
		cam.lookAt(0, 0, 0);
		// looking toward +X/−Z from (-10, _, 10): the heading is −45°
		expect(headingOf(cam.quaternion)).toBeCloseTo(-Math.PI / 4);
	});
	it('stays defined looking straight down', () => {
		const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0.6, 0, 'YXZ'));
		expect(headingOf(q)).toBeCloseTo(0.6, 5);
	});
});
