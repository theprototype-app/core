// 92-input GC4a + GC4: the play views — what a Character Controller asks for, the steer rule (side / top:
// keys are world directions) and the one-draw camera pose (third: behind and pulled in by a wall).
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { playViewSettings as settingsOrNull, PLAY_VIEW_DEFAULTS } from '../../src/lib/playViewSettings.js';
/** @param {any} d @returns {any} */
const playViewSettings = (d) => settingsOrNull(d);
import { playViewImpl } from '../../src/lib/playView.js';
import { objectsGroup } from '../../src/stores/sceneStore';

/** a play camera seated like Player.svelte's: a group at y = 0.9 */
function rig(x = 0, eye = 1.7, z = 0, yaw = 0, pitch = 0) {
	const group = new THREE.Group();
	group.position.y = 0.9;
	const cam = new THREE.PerspectiveCamera();
	group.add(cam);
	cam.position.set(x, eye - 0.9, z);
	cam.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
	group.updateMatrixWorld(true);
	return cam;
}
const world = (/** @type {any} */ c) => c.getWorldPosition(new THREE.Vector3());

describe('playViewSettings', () => {
	it('first person (or no camera at all) is no view: every saved node is unchanged', () => {
		expect(playViewSettings({})).toBe(null);
		expect(playViewSettings({ camera: 'first' })).toBe(null);
		expect(playViewSettings(null)).toBe(null);
		expect(playViewSettings({ camera: 'drone' })).toBe(null);
	});
	it('each view reads its own defaults, and clamps', () => {
		expect(playViewSettings({ camera: 'third' })).toMatchObject({ camera: 'third', distance: 4, collide: true });
		expect(playViewSettings({ camera: 'side' })).toMatchObject({ distance: 12, lookAhead: 2.5, collide: false });
		expect(playViewSettings({ camera: 'top' })).toMatchObject({ distance: 16, angle: 60 });
		// the start distance sits inside the zoom limits; max never below min
		expect(playViewSettings({ camera: 'top', distance: 100, maxZoom: 20 }).distance).toBe(20);
		expect(playViewSettings({ camera: 'third', minZoom: 8, maxZoom: 2 }).maxZoom).toBe(8);
		expect(playViewSettings({ camera: 'top', angle: 5 }).angle).toBe(15);
		expect(playViewSettings({ camera: 'third', collide: false }).collide).toBe(false);
		expect(Object.keys(PLAY_VIEW_DEFAULTS)).toEqual(['third', 'side', 'top']);
	});
});

describe('the views', () => {
	beforeEach(() => {
		playViewImpl.reset();
		objectsGroup.set(null);
	});

	it('third person draws from behind the head and puts the camera back after the draw', () => {
		const cam = rig(0, 1.7, 0, 0);
		const v = playViewSettings({ camera: 'third' });
		const undo = playViewImpl.apply(cam, v);
		const p = world(cam);
		// facing -Z, so behind is +Z: 4 m back, 0.5 m up
		expect(p.z).toBeCloseTo(4, 5);
		expect(p.y).toBeCloseTo(2.2, 5);
		expect(p.x).toBeCloseTo(0, 5);
		undo();
		expect(world(cam).z).toBeCloseTo(0, 6);
		expect(world(cam).y).toBeCloseTo(1.7, 6);
		// the body stands where the player is
		expect(playViewImpl.body.position[1]).toBeCloseTo(1.7, 5);
	});

	it('third person: a wall behind the player pulls the camera in front of it', () => {
		const group = new THREE.Group();
		const wall = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 0.2), new THREE.MeshBasicMaterial());
		wall.position.set(0, 2, 2);
		group.add(wall);
		group.updateMatrixWorld(true);
		objectsGroup.set(group);
		const cam = rig();
		const undo = playViewImpl.apply(cam, playViewSettings({ camera: 'third' }));
		// wall face at z = 1.9, minus the margin
		expect(world(cam).z).toBeLessThan(1.9);
		expect(world(cam).z).toBeGreaterThan(1.4);
		undo();
		// collide off: straight through
		playViewImpl.reset();
		const undo2 = playViewImpl.apply(cam, playViewSettings({ camera: 'third', collide: false }));
		expect(world(cam).z).toBeCloseTo(4, 5);
		undo2();
		// a trigger volume never stops the camera
		playViewImpl.reset();
		wall.userData.physics = { sensor: true };
		const undo3 = playViewImpl.apply(cam, playViewSettings({ camera: 'third' }));
		expect(world(cam).z).toBeCloseTo(4, 5);
		undo3();
	});

	it('side: the view sits on +Z looking at the plane, ahead of the way you face', () => {
		const cam = rig(3, 1.7, -2, -Math.PI / 2); // facing +X
		const undo = playViewImpl.apply(cam, playViewSettings({ camera: 'side' }));
		const p = world(cam);
		expect(p.z).toBeCloseTo(-2 + 12, 5);
		expect(p.x).toBeCloseTo(3 + 2.5, 5); // the first frame takes the look-ahead whole
		const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
		expect(fwd.z).toBeCloseTo(-1, 3);
		undo();
	});

	it('top: a fixed angle above, looking down at the player; the wheel zooms between the limits', () => {
		const cam = rig(0, 1.7, 0);
		const v = playViewSettings({ camera: 'top', angle: 90, distance: 10, minZoom: 6, maxZoom: 12 });
		let undo = playViewImpl.apply(cam, v);
		const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
		expect(fwd.y).toBeCloseTo(-1, 3);
		expect(world(cam).y).toBeCloseTo(0.5 + 10, 3);
		undo();
		for (let i = 0; i < 20; i++) playViewImpl.zoom(1, v);
		expect(playViewImpl.debug().zoom).toBe(12);
		for (let i = 0; i < 40; i++) playViewImpl.zoom(-1, v);
		expect(playViewImpl.debug().zoom).toBe(6);
	});

	it('steer: side + top turn the player to its world direction and walk forward; W/S do nothing in side', () => {
		const cam = rig();
		const top = playViewSettings({ camera: 'top' });
		const yawOf = () => new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ').y;
		let m = playViewImpl.steer(cam, { forward: 0, backward: 0, left: 0, right: 1 }, top);
		expect(m).toMatchObject({ forward: 1, backward: 0, left: 0, right: 0 });
		expect(yawOf()).toBeCloseTo(-Math.PI / 2, 5); // facing +X
		m = playViewImpl.steer(cam, { forward: 0, backward: 1, left: 0, right: 0 }, top);
		expect(Math.abs(yawOf())).toBeCloseTo(Math.PI, 5); // facing +Z (toward the camera)
		const side = playViewSettings({ camera: 'side' });
		m = playViewImpl.steer(cam, { forward: 1, backward: 0, left: 0, right: 0 }, side);
		expect(m.forward).toBe(0);
		m = playViewImpl.steer(cam, { forward: 0, backward: 0, left: 1, right: 0 }, side);
		expect(m.forward).toBe(1);
		expect(yawOf()).toBeCloseTo(Math.PI / 2, 5); // facing -X
	});

	it('side: the plane Play started on holds', () => {
		const cam = rig(0, 1.7, 3);
		playViewImpl.lockPlane(cam);
		cam.position.z += 0.7;
		cam.updateMatrixWorld();
		playViewImpl.lockPlane(cam);
		expect(world(cam).z).toBeCloseTo(3, 6);
	});
});
