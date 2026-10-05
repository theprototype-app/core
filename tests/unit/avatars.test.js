// @ts-nocheck — assertions on plain objects; the modules themselves are typed
// 36-avatars (plan 76): the pure halves of the rigged avatars — the catalog, the 3-point body
// estimate, the locomotion blend from the camera stream, and the two-bone arm IK.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three';
import {
	CHARACTERS,
	resolveCharacter,
	outfitMask,
	characterChoices,
	feetBelowHead,
	CLIP_NAMES
} from '../../src/lib/avatars/catalog.js';
import {
	wrapAngle,
	angleDelta,
	yawPitchOf,
	forwardOfQuat,
	handsYaw,
	nextBodyYaw,
	neckAngles,
	armConfidence
} from '../../src/lib/avatars/bodyEstimate.js';
import {
	newTracker,
	trackPose,
	bodyFrameVelocity,
	locomotionWeights,
	approachWeights,
	SLOTS
} from '../../src/lib/avatars/locomotion.js';
import { measureArm, solveArm, orientWrist } from '../../src/lib/avatars/armIK.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

describe('catalog', () => {
	it('matches the build report shipped beside the GLBs (a rebuild cannot ship a stale table)', () => {
		const built = JSON.parse(fs.readFileSync(new URL('../../static/avatars/avatars.json', import.meta.url), 'utf8'));
		expect(built.characters.map((c) => c.id)).toEqual(CHARACTERS.map((c) => c.id));
		for (const c of CHARACTERS) {
			const b = built.characters.find((x) => x.id === c.id);
			expect(b.file).toBe(c.file);
			expect(b.tris).toBe(c.tris);
			expect(b.height).toBe(c.height);
			expect(b.outfitCells).toEqual(c.outfitCells);
			expect(fs.existsSync(new URL('../../static/avatars/' + c.file, import.meta.url))).toBe(true);
		}
		for (const clip of Object.values(CLIP_NAMES)) expect(built.clips).toContain(clip);
	});

	it('keeps every character inside the per-avatar budget (<= 10k tris)', () => {
		for (const c of CHARACTERS) expect(c.tris).toBeLessThanOrEqual(10000);
	});

	it('auto picks the same character for the same peer id on every peer, and varies across ids', () => {
		const a = resolveCharacter('auto', 'peer-abc');
		expect(resolveCharacter(undefined, 'peer-abc')).toBe(a);
		expect(resolveCharacter('auto', 'peer-abc')).toBe(a);
		const seen = new Set();
		for (let i = 0; i < 60; i++) seen.add(resolveCharacter('auto', 'p' + i).id);
		expect(seen.size).toBeGreaterThan(4);
	});

	it('classic means the floating head; an id this build does not know falls back to auto', () => {
		expect(resolveCharacter('classic', 'x')).toBe(null);
		expect(resolveCharacter('mage', 'x').id).toBe('mage');
		expect(resolveCharacter('from-a-newer-build', 'x')).toBe(resolveCharacter('auto', 'x'));
	});

	it('packs outfit cells into a 32-bit mask', () => {
		expect(outfitMask([0, 3])).toBe(9);
		expect(outfitMask([31])).toBe(2 ** 31);
		expect(outfitMask([40, -1])).toBe(0);
	});

	it('offers auto first and classic last', () => {
		const list = characterChoices();
		expect(list[0].value).toBe('auto');
		expect(list.at(-1).value).toBe('classic');
		expect(feetBelowHead()).toBeGreaterThan(1.2);
	});
});

describe('bodyEstimate', () => {
	it('wraps angles and takes the short way round', () => {
		expect(close(Math.abs(wrapAngle(3 * Math.PI)), Math.PI)).toBe(true);
		expect(close(wrapAngle(7), 7 - 2 * Math.PI)).toBe(true);
		expect(close(angleDelta(3, -3), 2 * Math.PI - 6)).toBe(true);
	});

	it('reads yaw/pitch with three conventions (0 faces -Z, +yaw turns left)', () => {
		expect(close(yawPitchOf([0, 0, -1]).yaw, 0)).toBe(true);
		expect(close(yawPitchOf([-1, 0, 0]).yaw, Math.PI / 2)).toBe(true);
		expect(yawPitchOf([0, 1, -1]).pitch).toBeGreaterThan(0.7);
		const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 1.1, 0, 'YXZ'));
		const f = forwardOfQuat([q.x, q.y, q.z, q.w]);
		const ref = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
		expect(close(f[0], ref.x) && close(f[1], ref.y) && close(f[2], ref.z)).toBe(true);
		expect(close(yawPitchOf(f).yaw, 1.1)).toBe(true);
	});

	it('holds the body still while the head glances inside the comfort cone, follows past it', () => {
		const still = nextBodyYaw({ bodyYaw: 0, headYaw: 0.4, speed: 0, dt: 0.5 });
		expect(still).toBe(0);
		let body = 0;
		for (let i = 0; i < 120; i++) body = nextBodyYaw({ bodyYaw: body, headYaw: 1.6, speed: 0, dt: 1 / 60 });
		// turned until the head is back inside the cone, not all the way
		expect(angleDelta(body, 1.6)).toBeLessThan(0.6);
		expect(body).toBeLessThan(1.6);
	});

	it('turns fully toward the head while walking', () => {
		let body = 0;
		for (let i = 0; i < 120; i++) body = nextBodyYaw({ bodyYaw: body, headYaw: 1.0, speed: 1.2, dt: 1 / 60 });
		expect(Math.abs(angleDelta(body, 1.0))).toBeLessThan(0.02);
	});

	it('pulls the body toward both hands held out in front', () => {
		expect(handsYaw([0, 1.6, 0], [-0.2, 1.2, -0.5], [0.2, 1.2, -0.5])).toBeCloseTo(0, 5);
		expect(handsYaw([0, 1.6, 0], [0, 1.2, 0], [0.05, 1.2, 0])).toBe(null);
		expect(handsYaw([0, 1.6, 0], null, [0.2, 1.2, -0.5])).toBe(null);
		let body = 0;
		const hy = handsYaw([0, 1.6, 0], [-0.6, 1.2, -0.1], [-0.6, 1.2, 0.1]); // hands to the left
		for (let i = 0; i < 300; i++) body = nextBodyYaw({ bodyYaw: body, headYaw: 0, handsYaw: hy, speed: 1, dt: 1 / 60 });
		expect(body).toBeGreaterThan(0.3);
	});

	it('clamps the neck', () => {
		const n = neckAngles(3, 2, 0);
		expect(n.yaw).toBe(1.2);
		expect(n.pitch).toBe(0.9);
	});

	it('fades IK out for stale or unreachable hands', () => {
		expect(armConfidence({ ageMs: 50, distance: 0.4, reach: 0.5 })).toBe(1);
		expect(armConfidence({ ageMs: 2000, distance: 0.4, reach: 0.5 })).toBe(0);
		expect(armConfidence({ ageMs: 50, distance: 1, reach: 0.5 })).toBe(0);
		const mid = armConfidence({ ageMs: 800, distance: 0.4, reach: 0.5 });
		expect(mid > 0 && mid < 1).toBe(true);
	});
});

describe('locomotion', () => {
	/** feed a straight walk at `speed` m/s along -Z sampled at 20 Hz */
	function walk(speed, seconds = 1.5, hz = 20, dir = [0, 0, -1]) {
		const tr = newTracker();
		for (let i = 0; i <= seconds * hz; i++) {
			const t = i / hz;
			trackPose(tr, [dir[0] * speed * t, dir[1] * speed * t, dir[2] * speed * t], t);
		}
		return tr;
	}

	it('recovers the speed of a 20 Hz stream', () => {
		const tr = walk(1.3);
		expect(Math.hypot(...tr.vel)).toBeCloseTo(1.3, 1);
	});

	it('does not spike between samples: a frame with no new sample keeps the estimate', () => {
		const tr = walk(1.3);
		const before = Math.hypot(...tr.vel);
		trackPose(tr, tr.last, tr.lastT + 0.016); // a render frame, no new sample
		expect(Math.hypot(...tr.vel)).toBeCloseTo(before, 6);
	});

	it('decays to rest when the stream stops', () => {
		const tr = walk(1.3);
		trackPose(tr, tr.last, tr.lastT + 0.5);
		expect(Math.hypot(...tr.vel)).toBeLessThan(0.05);
	});

	it('reads a teleport as a teleport, not a sprint', () => {
		const tr = walk(1.3);
		trackPose(tr, [50, 0, 0], tr.lastT + 0.05);
		expect(Math.hypot(...tr.vel)).toBe(0);
	});

	it('splits velocity into the body frame', () => {
		const f = bodyFrameVelocity([0, 0, -2], 0);
		expect(f.forward).toBeCloseTo(2);
		expect(f.strafe).toBeCloseTo(0);
		const r = bodyFrameVelocity([1, 0, 0], 0);
		expect(r.strafe).toBeCloseTo(1);
		const turned = bodyFrameVelocity([-1, 0, 0], Math.PI / 2); // facing -X, moving -X
		expect(turned.forward).toBeCloseTo(1);
	});

	it('idles when still, walks, runs, backs up, strafes and flies', () => {
		const top = (v) => {
			const { weights } = locomotionWeights(v);
			return Object.entries(weights).sort((a, b) => b[1] - a[1])[0][0];
		};
		expect(top({ forward: 0, strafe: 0, vertical: 0 })).toBe('idle');
		expect(top({ forward: 1.3, strafe: 0, vertical: 0 })).toBe('walk');
		expect(top({ forward: 4, strafe: 0, vertical: 0 })).toBe('run');
		expect(top({ forward: -1, strafe: 0, vertical: 0 })).toBe('back');
		expect(top({ forward: 0, strafe: -1.5, vertical: 0 })).toBe('strafeLeft');
		expect(top({ forward: 0, strafe: 1.5, vertical: 0 })).toBe('strafeRight');
		expect(top({ forward: 0.2, strafe: 0, vertical: 3 })).toBe('air');
		for (const v of [{ forward: 1, strafe: 0.7, vertical: 0 }, { forward: 2.2, strafe: 0, vertical: 0 }]) {
			const sum = Object.values(locomotionWeights(v).weights).reduce((a, b) => a + b, 0);
			expect(sum).toBeCloseTo(1, 6);
		}
	});

	it('plays the walk faster the faster the peer moves', () => {
		expect(locomotionWeights({ forward: 2, strafe: 0, vertical: 0 }).rates.walk).toBeGreaterThan(
			locomotionWeights({ forward: 1, strafe: 0, vertical: 0 }).rates.walk
		);
	});

	it('eases weights and keeps them normalised', () => {
		const cur = { idle: 1 };
		approachWeights(cur, { walk: 1 }, 0.05);
		expect(cur.walk > 0 && cur.walk < 1).toBe(true);
		expect(SLOTS.reduce((s, k) => s + (cur[k] ?? 0), 0)).toBeCloseTo(1, 6);
		for (let i = 0; i < 100; i++) approachWeights(cur, { walk: 1 }, 0.05);
		expect(cur.walk).toBeCloseTo(1, 3);
	});
});

describe('armIK', () => {
	/** a chain like KayKit's: bones run along local +Y, the upper arm turned sideways */
	function rig() {
		const root = new THREE.Group();
		root.scale.setScalar(0.95);
		const chest = new THREE.Bone();
		chest.position.set(0, 1, 0);
		const upper = new THREE.Bone();
		upper.position.set(0.21, 0.13, 0);
		upper.quaternion.set(-0.514, -0.485, -0.485, 0.514).normalize();
		const lower = new THREE.Bone();
		lower.position.set(0, 0.242, 0);
		const wrist = new THREE.Bone();
		wrist.position.set(0, 0.26, 0);
		const hand = new THREE.Bone();
		hand.position.set(0, 0.074, 0);
		root.add(chest);
		chest.add(upper);
		upper.add(lower);
		lower.add(wrist);
		wrist.add(hand);
		root.updateMatrixWorld(true);
		return { root, upper, lower, wrist, hand, arm: { upper, lower, wrist, rest: measureArm(upper, lower, wrist) } };
	}
	const wpos = (o) => o.getWorldPosition(new THREE.Vector3());

	it('puts the wrist on a reachable target and keeps both segment lengths', () => {
		const r = rig();
		const shoulder = wpos(r.upper);
		const a0 = shoulder.distanceTo(wpos(r.lower));
		const b0 = wpos(r.lower).distanceTo(wpos(r.wrist));
		const target = shoulder.clone().add(new THREE.Vector3(0.15, -0.2, -0.25));
		const pole = shoulder.clone().add(new THREE.Vector3(0.3, -0.6, 0.2));
		const res = solveArm(r.arm, target, pole);
		expect(res.reached).toBeLessThan(1e-4);
		expect(res.stretch).toBe(1);
		expect(shoulder.distanceTo(wpos(r.lower))).toBeCloseTo(a0, 5);
		expect(wpos(r.lower).distanceTo(wpos(r.wrist))).toBeCloseTo(b0, 5);
	});

	it('bends the elbow toward the pole', () => {
		const r = rig();
		const shoulder = wpos(r.upper);
		const target = shoulder.clone().add(new THREE.Vector3(0, -0.1, -0.3));
		solveArm(r.arm, target, shoulder.clone().add(new THREE.Vector3(0, -1, 0)));
		const down = wpos(r.lower).y;
		solveArm(r.arm, target, shoulder.clone().add(new THREE.Vector3(0, 1, 0)));
		const up = wpos(r.lower).y;
		expect(down).toBeLessThan(up);
	});

	it('stretches the arm to reach a target past its rest length, up to the cap', () => {
		const r = rig();
		const shoulder = wpos(r.upper);
		const len = shoulder.distanceTo(wpos(r.lower)) + wpos(r.lower).distanceTo(wpos(r.wrist));
		const target = shoulder.clone().add(new THREE.Vector3(0, 0, -len * 1.2));
		const res = solveArm(r.arm, target, shoulder.clone().add(new THREE.Vector3(0, -1, 0)));
		expect(res.stretch).toBeGreaterThan(1.15);
		expect(res.reached).toBeLessThan(0.01);
		const far = shoulder.clone().add(new THREE.Vector3(0, 0, -len * 3));
		const capped = solveArm(r.arm, far, shoulder.clone().add(new THREE.Vector3(0, -1, 0)));
		expect(capped.stretch).toBeCloseTo(1.45, 5);
		expect(capped.reached).toBeGreaterThan(0.3);
	});

	it('weight 0 restores the rest translations and leaves the pose alone', () => {
		const r = rig();
		const shoulder = wpos(r.upper);
		solveArm(r.arm, shoulder.clone().add(new THREE.Vector3(0, 0, -2)), shoulder);
		const q = r.upper.quaternion.clone();
		solveArm(r.arm, shoulder, shoulder, 0);
		expect(r.lower.position.y).toBeCloseTo(0.242, 6);
		expect(r.upper.quaternion.equals(q)).toBe(true);
	});

	it('points the wrist with the controller', () => {
		const r = rig();
		const want = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -0.7, 0.2));
		orientWrist(r.wrist, want, new THREE.Quaternion());
		const got = r.wrist.getWorldQuaternion(new THREE.Quaternion());
		expect(got.angleTo(want)).toBeLessThan(1e-5);
	});
});
