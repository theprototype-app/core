// @ts-nocheck — fixture models built inline
// 57 M12 — animate imported parts: keys on named nodes -> a node-name .tpanim that plays back on
// the model (a spin is a spin, relative keys sit on the part's rest, missing parts are reported).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildPartsClip, rotationKeys } from '../../src/lib/tpanim/partsClip.js';
import { encodeTpanim, decodeTpanim, tpToThreeClip, clipFit } from '../../src/lib/tpanim/format.js';

/** a helicopter-ish model: body > mast > rotor, and a door hinged on the body */
function heli() {
	const root = new THREE.Group();
	root.name = 'Heli';
	const body = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1));
	body.name = 'body';
	root.add(body);
	const mast = new THREE.Object3D();
	mast.name = 'mast';
	mast.position.set(0, 0.6, 0);
	body.add(mast);
	const rotor = new THREE.Mesh(new THREE.BoxGeometry(4, 0.05, 0.2));
	rotor.name = 'rotor';
	rotor.position.set(0, 0.2, 0);
	rotor.rotation.y = 0.3; // a rest turn the relative keys must sit on
	mast.add(rotor);
	const door = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.05));
	door.name = 'Door Left';
	door.position.set(0.5, 0, 0.5);
	body.add(door);
	root.updateMatrixWorld(true);
	return { root, rotor, door };
}

const play = (root, clip, t) => {
	const mixer = new THREE.AnimationMixer(root);
	mixer.clipAction(clip).play();
	mixer.setTime(t);
	root.updateMatrixWorld(true);
	return () => {
		mixer.stopAllAction();
		mixer.uncacheRoot(root);
	};
};

describe('rotationKeys', () => {
	it('splits long Euler segments so a full turn turns', () => {
		const keys = rotationKeys([{ t: 0, rot: [0, 0, 0] }, { t: 2, rot: [0, 360, 0] }]);
		expect(keys.length).toBe(5); // 0, 90, 180, 270, 360
		expect(keys[2].t).toBeCloseTo(1, 9);
		const half = new THREE.Euler().setFromQuaternion(keys[2].q);
		expect(Math.abs(half.y) + Math.abs(half.x)).toBeGreaterThan(1); // 180°, not identity
	});
});

describe('buildPartsClip', () => {
	it('a rotor spin: relative to its rest, continuous, through the file and back', () => {
		const { root, rotor } = heli();
		const { tp, parts, missing } = buildPartsClip(root, { clip: 'Spin', tracks: [{ part: 'rotor', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1, rot: [0, 360, 0] }] }] });
		expect(parts).toEqual(['rotor']);
		expect(missing).toEqual([]);
		expect(tp.nodes.map((n) => n.name)).toEqual(['body', 'mast', 'rotor']);
		const back = decodeTpanim(encodeTpanim(tp));
		expect(back.loop).toBe(true);
		expect(back.provenance.tool).toBe('animate_parts');
		expect(clipFit(back, root).fit).not.toBe('none');
		const clip = tpToThreeClip(back);
		const yaw = [];
		for (const t of [0, 0.25, 0.5, 0.75, 1]) {
			const stop = play(root, clip, t);
			yaw.push(new THREE.Euler().setFromQuaternion(rotor.quaternion, 'YXZ').y);
			stop();
		}
		// at t=0 the rotor sits at its rest turn (0.3 rad); a quarter of the way it is 90° further
		expect(yaw[0]).toBeCloseTo(0.3, 4);
		const d = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
		expect(d(yaw[1], yaw[0])).toBeCloseTo(Math.PI / 2, 3);
		expect(d(yaw[2], yaw[1])).toBeCloseTo(Math.PI / 2, 3);
		// the position never moved
		expect(rotor.position.y).toBeCloseTo(0.2, 6);
	});

	it('a door opens by name (case-insensitive), absolute mode, and missing parts are listed', () => {
		const { root, door } = heli();
		const { tp, missing } = buildPartsClip(root, {
			clip: 'Open',
			mode: 'absolute',
			loop: false,
			tracks: [
				{ part: 'door left', keys: [{ t: 0, pos: [0.5, 0, 0.5], rot: [0, 0, 0] }, { t: 0.5, pos: [0.5, 0, 0.9], rot: [0, -80, 0] }] },
				{ part: 'nope', keys: [{ t: 0, pos: [0, 0, 0] }] }
			]
		});
		expect(missing).toEqual(['nope']);
		expect(tp.loop).toBe(false);
		expect(tp.duration).toBeCloseTo(0.5, 9);
		const stop = play(root, tpToThreeClip(tp, root), 0.5 - 1e-5); // setTime(duration) wraps a repeating action to 0
		expect(door.position.z).toBeCloseTo(0.9, 3);
		expect(THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(door.quaternion).y)).toBeCloseTo(-80, 1);
		stop();
	});

	it('returns no clip when nothing matched', () => {
		const { root } = heli();
		const out = buildPartsClip(root, { clip: 'X', tracks: [{ part: 'wing', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1, rot: [0, 90, 0] }] }] });
		expect(out.tp).toBe(null);
		expect(out.missing).toEqual(['wing']);
	});
});
