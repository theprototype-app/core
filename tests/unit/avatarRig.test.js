// @ts-nocheck — drives the real RiggedAvatar on the shipped GLBs with plain objects
// 37-avatar-fix: the rigged body, headless. The GLBs in static/avatars/ are parsed from disk (the
// app's loader is mocked to read files instead of fetching), so these run on exactly what ships.
//  R22 — the idle head no longer spins: the neck offset is applied on top of the CLIP pose every
//        frame instead of accumulating on a bone the mixer skipped (three's PropertyMixer does not
//        re-apply a value that did not change).
//  R23 — feet on the ground: per character and per clip, the lowest point of the skinned body
//        stays within ±3 cm of the feet origin while a foot is planted; a walking sender's `feet`
//        anchors the body to its floor.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three';

globalThis.self = globalThis; // GLTFLoader reads self.URL for embedded images

vi.mock('../../src/lib/export/exportBoot.js', () => ({ pageUrl: (rel) => rel }));
vi.mock('../../src/lib/gltfLoader.js', async () => {
	const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
	return {
		loadGltf: (url) =>
			new Promise((resolve, reject) => {
				const b = fs.readFileSync(new URL('../../static/' + url, import.meta.url));
				// the atlas texture cannot decode in node; the loader logs it and carries on
				const err = console.error;
				console.error = () => {};
				new GLTFLoader().parse(
					b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
					'',
					(g) => {
						console.error = err;
						resolve(g);
					},
					(e) => {
						console.error = err;
						reject(e);
					}
				);
			})
	};
});

const { RiggedAvatar } = await import('../../src/lib/avatars/riggedAvatar.js');
const { CHARACTERS, feetBelowHead } = await import('../../src/lib/avatars/catalog.js');
const { SLOTS } = await import('../../src/lib/avatars/locomotion.js');

/** a body standing with its head at `head`, looking along yaw (+pitch), built and loaded */
async function standing(id, head = [0, 1.6, 0]) {
	const avatar = new RiggedAvatar('peer-' + id, { character: id, head: 'character', hat: 'none', body: '#4f83cc', outfit: '' });
	const parent = new THREE.Group();
	parent.add(avatar.object);
	const root = new THREE.Group();
	parent.add(root);
	root.position.fromArray(head);
	for (let i = 0; i < 200 && !avatar.ready; i++) await new Promise((r) => setTimeout(r, 5));
	expect(avatar.ready).toBe(true);
	return { avatar, root, parent };
}

/** the lowest point of the whole skinned body (every vertex), in the avatar group's frame */
function lowestVertex(avatar) {
	const mesh = avatar.inst.mesh;
	avatar.object.updateMatrixWorld(true);
	const m = new THREE.Matrix4().copy(avatar.object.matrixWorld).invert().multiply(mesh.matrixWorld);
	const v = new THREE.Vector3();
	let min = Infinity;
	for (let k = 0; k < mesh.geometry.attributes.position.count; k++) {
		mesh.getVertexPosition(k, v).applyMatrix4(m);
		if (v.y < min) min = v.y;
	}
	return min;
}

/** pin the blend to ONE clip slot and step the body through `seconds` of it */
function playOnly(avatar, root, slot, seconds, samples, onSample) {
	const dt = seconds / samples;
	for (let i = 0; i < samples; i++) {
		for (const s of SLOTS) avatar.weights[s] = s === slot ? 1 : 0;
		// the locomotion blend would pull the weights back toward idle: hold them by feeding a
		// root that does not move and re-pinning every frame (rates stay 1)
		avatar.update(dt, i * dt, root, null);
		for (const s of SLOTS) {
			avatar.actions[s]?.setEffectiveWeight(s === slot ? 1 : 0);
			avatar.actions[s]?.setEffectiveTimeScale(1);
		}
		avatar.mixer.update(0);
		avatar.planFeet();
		onSample(i);
	}
}

describe('R22 — the idle head holds still', () => {
	beforeAll(() => {});
	it('a head turned away from the body (inside the comfort cone) does not keep turning', async () => {
		const { avatar, root } = await standing('knight');
		// face -Z, then look 0.4 rad to the left: the body stays (cone 0.6), the neck turns
		root.rotation.set(0, 0, 0, 'YXZ');
		for (let i = 0; i < 30; i++) avatar.update(1 / 60, i / 60, root, null);
		root.rotation.set(0, 0.4, 0, 'YXZ');
		const t0 = 1;
		const samples = [];
		for (let i = 0; i < 240; i++) {
			avatar.update(1 / 60, t0 + i / 60, root, null);
			if (i % 60 === 59) samples.push(avatar.bones.head.getWorldQuaternion(new THREE.Quaternion()));
		}
		expect(avatar.state().top).toBe('idle');
		// four seconds of idle: the head's world orientation over successive seconds stays put
		// (the Idle clip's own sway is a few degrees; the old accumulation turned 0.28 rad per FRAME)
		for (let i = 1; i < samples.length; i++) expect(samples[i].angleTo(samples[0])).toBeLessThan(0.15);
		// ...and it faces where the root looks: yaw 0.4 left of the body
		// the KayKit head faces its local +Z; three's yaw convention: 0 faces -Z, positive turns left
		const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(samples[samples.length - 1]);
		const headYaw = Math.atan2(-fwd.x, -fwd.z);
		expect(Math.abs(headYaw - 0.4)).toBeLessThan(0.3);
		avatar.dispose();
	});

	it('COUNTERFACTUAL: without the clip-pose restore the same head spins', async () => {
		const { avatar, root } = await standing('knight');
		avatar.restoreClipPose = () => {};
		// the body settles facing -Z, then the head turns 0.4 rad inside the comfort cone
		root.rotation.set(0, 0, 0, 'YXZ');
		for (let i = 0; i < 30; i++) avatar.update(1 / 60, i / 60, root, null);
		root.rotation.set(0, 0.4, 0, 'YXZ');
		for (let i = 0; i < 30; i++) avatar.update(1 / 60, 0.5 + i / 60, root, null);
		const before = avatar.bones.head.getWorldQuaternion(new THREE.Quaternion());
		for (let i = 0; i < 60; i++) avatar.update(1 / 60, 1 + i / 60, root, null);
		const after = avatar.bones.head.getWorldQuaternion(new THREE.Quaternion());
		expect(after.angleTo(before)).toBeGreaterThan(0.3);
		avatar.dispose();
	});
});

describe('R23 — feet on the ground', () => {
	it('every character, every ground clip: the lowest point stays within ±3 cm while a foot is planted', async () => {
		const rows = [];
		for (const c of CHARACTERS) {
			const { avatar, root } = await standing(c.id);
			for (const slot of ['idle', 'walk', 'back', 'run', 'strafeLeft', 'strafeRight']) {
				let lo = Infinity;
				let planted = Infinity; // the lowest sample's height = the stance foot
				playOnly(avatar, root, slot, 1.07, 32, () => {
					const y = lowestVertex(avatar);
					lo = Math.min(lo, y);
					planted = Math.min(planted, Math.abs(y));
				});
				rows.push(`${c.id} ${slot} min ${(lo * 100).toFixed(1)} cm`);
				// never more than 3 cm into the floor
				expect(lo, `${c.id} ${slot}`).toBeGreaterThan(-0.03);
				// and a foot does touch it (within 3 cm) during the cycle
				expect(planted, `${c.id} ${slot}`).toBeLessThan(0.03);
			}
			avatar.dispose();
		}
		if (process.env.AVATAR_FEET_TABLE) fs.writeFileSync(process.env.AVATAR_FEET_TABLE, rows.join('\n') + '\n');
	}, 60000);

	it('walking clips stand ON the floor at every sample (no sinking, and the stance foot within 3 cm)', async () => {
		const { avatar, root } = await standing('skeleton-warrior'); // the deepest heel strike measured (7.8 cm)
		playOnly(avatar, root, 'walk', 1.07, 48, () => {
			const y = lowestVertex(avatar);
			expect(y).toBeGreaterThan(-0.03);
			expect(y).toBeLessThan(0.03);
		});
		avatar.dispose();
	});

	it('COUNTERFACTUAL: without the sole clamp the heel strike sinks past 3 cm', async () => {
		const { avatar, root } = await standing('skeleton-warrior');
		avatar.planFeet = () => {};
		let lo = Infinity;
		playOnly(avatar, root, 'walk', 1.07, 48, () => (lo = Math.min(lo, lowestVertex(avatar))));
		expect(lo).toBeLessThan(-0.05);
		avatar.dispose();
	});

	it('a walking sender’s feet anchor the body to its floor; without them the head guess stands in', async () => {
		const { avatar, root } = await standing('rogue', [2, 1.7, -1]);
		for (let i = 0; i < 10; i++) avatar.update(1 / 60, i / 60, root, null);
		expect(avatar.state().anchor).toBe('head');
		expect(avatar.object.position.y).toBeCloseTo(1.7 - feetBelowHead(), 5);
		// on a step 0.3 m up: the walker's floor
		root.userData.feet = 0.3;
		root.position.y = 2.0;
		for (let i = 0; i < 120; i++) avatar.update(1 / 60, 1 + i / 60, root, null);
		expect(avatar.state().anchor).toBe('wire');
		expect(Math.abs(avatar.object.position.y - 0.3)).toBeLessThan(0.005);
		// a nonsense value (feet above the head) is ignored
		root.userData.feet = 5;
		for (let i = 0; i < 120; i++) avatar.update(1 / 60, 3 + i / 60, root, null);
		expect(avatar.state().anchor).toBe('head');
		avatar.dispose();
	});
});

describe('R22 — the knocked-off idle', () => {
	it('the figure-8 is VERTICAL (an 8, not an ∞), closed, and scaled by the blend', async () => {
		const { swayAt, SWAY } = await import('../../src/lib/avatars/dizzy.js');
		let maxX = 0;
		let maxY = 0;
		for (let i = 0; i < 64; i++) {
			const p = swayAt((i / 64) * Math.PI * 2, 1);
			maxX = Math.max(maxX, Math.abs(p.x));
			maxY = Math.max(maxY, Math.abs(p.y));
		}
		expect(maxY).toBeCloseTo(SWAY.y, 5); // the lobes stack vertically: the tall axis is Y
		expect(maxX / SWAY.x).toBeLessThan(0.4); // and it is narrow across
		const a = swayAt(0, 1);
		const b = swayAt(Math.PI * 2, 1);
		expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-9); // closed
		// it crosses itself at the centre (the waist of the 8)
		expect(Math.hypot(swayAt(Math.PI / 2, 1).x, swayAt(Math.PI / 2, 1).y)).toBeLessThan(1e-9);
		expect(swayAt(1, 0)).toEqual({ x: 0, y: 0, roll: -0 });
	});

	it('a knocked-off peer: stars + star eyes blend in (one instanced mesh), sway the head, and blend out', async () => {
		const { avatar, root } = await standing('rogue');
		for (let i = 0; i < 30; i++) avatar.update(1 / 60, i / 60, root, null);
		expect(avatar.state().dizzy).toBe(0);
		expect(avatar.dizzy.mesh.visible).toBe(false);
		const restHead = avatar.bones.head.getWorldPosition(new THREE.Vector3());
		root.userData.knocked = true;
		avatar.update(1 / 60, 1, root, null);
		const early = avatar.state().dizzy;
		expect(early).toBeGreaterThan(0);
		expect(early).toBeLessThan(0.2); // a blend, not a snap
		const path = [];
		for (let i = 0; i < 240; i++) {
			avatar.update(1 / 60, 1 + i / 60, root, new THREE.Vector3(0, 1.6, 5));
			path.push(avatar.bones.head.getWorldPosition(new THREE.Vector3()).sub(restHead));
		}
		expect(avatar.state().dizzy).toBeGreaterThan(0.95);
		expect(avatar.dizzy.mesh.visible).toBe(true);
		expect(avatar.dizzy.mesh.count).toBe(7); // 5 stars + 2 eyes, ONE draw call
		// the head moved on BOTH axes of its own plane (the 8), a few cm, never wandered off
		const span = (k) => Math.max(...path.map((p) => p[k])) - Math.min(...path.map((p) => p[k]));
		expect(span('y')).toBeGreaterThan(0.03);
		expect(span('x') + span('z')).toBeGreaterThan(0.01);
		expect(Math.max(...path.map((p) => p.length()))).toBeLessThan(0.2);
		// the orbiting stars sit above the head, around it
		const head = avatar.bones.head.getWorldPosition(new THREE.Vector3());
		const m = new THREE.Matrix4();
		const p = new THREE.Vector3();
		for (let i = 0; i < 5; i++) {
			avatar.dizzy.mesh.getMatrixAt(i, m);
			p.setFromMatrixPosition(m).applyMatrix4(avatar.object.matrixWorld);
			expect(p.y).toBeGreaterThan(head.y + 0.3);
			expect(Math.hypot(p.x - head.x, p.z - head.z)).toBeLessThan(0.9);
		}
		// the eyes are on the FACE side of the head (the character faces -Z in world here)
		avatar.dizzy.mesh.getMatrixAt(5, m);
		p.setFromMatrixPosition(m).applyMatrix4(avatar.object.matrixWorld);
		expect(p.z).toBeLessThan(head.z);
		// wake up: it blends out and hides
		root.userData.knocked = false;
		for (let i = 0; i < 240; i++) avatar.update(1 / 60, 6 + i / 60, root, null);
		expect(avatar.state().dizzy).toBe(0);
		expect(avatar.dizzy.mesh.visible).toBe(false);
		avatar.dispose();
	});

	it('stylised heads and a photo card get star eyes too', async () => {
		for (const head of ['sphere', 'box', 'capsule', 'cone']) {
			const { avatar, root } = await standing('knight');
			avatar.setLook({ ...avatar.look, head });
			root.userData.knocked = true;
			for (let i = 0; i < 120; i++) avatar.update(1 / 60, i / 60, root, null);
			const m = new THREE.Matrix4();
			avatar.dizzy.mesh.getMatrixAt(5, m);
			const s = new THREE.Vector3().setFromMatrixScale(m);
			expect(s.x, head).toBeGreaterThan(0.05);
			avatar.dispose();
		}
	});
});

describe('R22 — the local idle watch', () => {
	it('no input for the threshold knocks you off; input or a head move wakes you; Off never', async () => {
		const st = await import('../../src/lib/avatars/avatarState.js');
		st.knockedAfterSeconds.set(20);
		const pos = [0, 1.7, 0];
		const q = [0, 0, 0, 1];
		st.tickIdle(pos, q, 0);
		st.noteActivity();
		const t0 = performance.now();
		expect(st.tickIdle(pos, q, t0 + 19000)).toBe(false);
		expect(st.tickIdle(pos, q, t0 + 21000)).toBe(true);
		// a tiny sway of a VR head is not input
		expect(st.tickIdle([0.01, 1.7, 0], q, t0 + 21500)).toBe(true);
		// a real move is
		expect(st.tickIdle([0.2, 1.7, 0], q, t0 + 22000)).toBe(false);
		expect(st.tickIdle([0.2, 1.7, 0], q, t0 + 41000)).toBe(false);
		expect(st.tickIdle([0.2, 1.7, 0], q, t0 + 43000)).toBe(true);
		// a turn of the head is too
		const turned = [0, Math.sin(0.1), 0, Math.cos(0.1)];
		expect(st.tickIdle([0.2, 1.7, 0], turned, t0 + 43500)).toBe(false);
		st.knockedAfterSeconds.set(0);
		expect(st.tickIdle([0.2, 1.7, 0], turned, t0 + 1e7)).toBe(false);
		st.knockedAfterSeconds.set(20);
	});
});
