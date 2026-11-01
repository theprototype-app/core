// @ts-nocheck — the rig ops on the shipped KayKit GLB, parsed back with three
// 57 M6: rename / move-in-rest / add / delete / mirror edit the GLB and KEEP THE BIND (every skinned
// vertex stays where it was at rest), and the automatic weights are a surface heat diffusion.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
	renameBone,
	moveBoneRest,
	addBone,
	deleteBone,
	mirrorBones,
	mirrorName,
	sideOfName,
	setPrimitiveWeights,
	worldOf,
	nodeIndex
} from '../../src/lib/rig/rigOps.js';
import { readGlb, readAccessor } from '../../src/lib/download/glbEdit.js';
import {
	heatWeights,
	smoothWeights,
	normalizeWeights,
	brushWeights,
	surfaceGraph
} from '../../src/lib/rig/weightsCore.js';

globalThis.self = globalThis;
const knight = () => {
	const b = fs.readFileSync(new URL('../../static/avatars/knight.glb', import.meta.url));
	return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const parse = (bytes) =>
	new Promise((resolve, reject) => {
		const err = console.error;
		const warn = console.warn;
		console.error = () => {};
		console.warn = () => {};
		new GLTFLoader().parse(
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
			'',
			(g) => ((console.error = err), (console.warn = warn), resolve(g)),
			(e) => ((console.error = err), (console.warn = warn), reject(e))
		);
	});

/** every skinned vertex of the first skinned mesh, at rest, in world space */
async function restVertices(bytes) {
	const g = await parse(bytes);
	g.scene.updateMatrixWorld(true);
	let mesh = null;
	g.scene.traverse((o) => o.isSkinnedMesh && !mesh && (mesh = o));
	const out = [];
	const v = new THREE.Vector3();
	for (let i = 0; i < mesh.geometry.attributes.position.count; i += 37) {
		mesh.getVertexPosition(i, v);
		out.push(v.clone().applyMatrix4(mesh.matrixWorld));
	}
	return { out, g, mesh };
}
const maxGap = (a, b) => Math.max(...a.map((p, i) => p.distanceTo(b[i])));

describe('57 M6 rig ops keep the bind', () => {
	it('rename: the bone has its new name, nothing else changed', async () => {
		const bytes = renameBone(knight(), 'upperarml', 'arm_upper_L');
		const { g } = await parse(bytes).then((g) => ({ g }));
		expect(g.scene.getObjectByName('arm_upper_L')?.isBone).toBe(true);
		expect(g.scene.getObjectByName('upperarml')).toBeUndefined();
		expect(() => renameBone(knight(), 'nope', 'x')).toThrow(/no bone/);
	});

	it('move in the rest pose: the joint moves, the skinned mesh does not', async () => {
		const before = await restVertices(knight());
		const doc = readGlb(knight());
		const i = nodeIndex(doc.json, 'upperarml');
		const t = doc.json.nodes[i].translation ?? [0, 0, 0];
		const bytes = moveBoneRest(knight(), 'upperarml', [t[0] + 0.05, t[1] - 0.03, t[2]]);
		const after = await restVertices(bytes);
		expect(maxGap(before.out, after.out)).toBeLessThan(1e-4);
		const p0 = new THREE.Vector3(),
			p1 = new THREE.Vector3();
		before.g.scene.getObjectByName('upperarml').getWorldPosition(p0);
		after.g.scene.getObjectByName('upperarml').getWorldPosition(p1);
		expect(p0.distanceTo(p1)).toBeGreaterThan(0.02);
	});

	it('add a bone: one more joint, weightless, mesh unchanged', async () => {
		const before = await restVertices(knight());
		const bytes = addBone(knight(), 'head', 'ponytail', [0, 0.2, -0.1]);
		const doc = readGlb(bytes);
		expect(doc.json.skins[0].joints.length).toBe(readGlb(knight()).json.skins[0].joints.length + 1);
		expect(doc.json.accessors[doc.json.skins[0].inverseBindMatrices].count).toBe(
			doc.json.skins[0].joints.length
		);
		const after = await restVertices(bytes);
		expect(after.g.scene.getObjectByName('ponytail')?.isBone).toBe(true);
		expect(maxGap(before.out, after.out)).toBeLessThan(1e-4);
	});

	it('delete a bone: children move up, weights go to the parent, the mesh stays put', async () => {
		const before = await restVertices(knight());
		const bytes = deleteBone(knight(), 'wristl');
		const doc = readGlb(bytes);
		const skin = doc.json.skins[0];
		expect(skin.joints.length).toBe(readGlb(knight()).json.skins[0].joints.length - 1);
		const J = readAccessor(
			doc,
			doc.json.meshes[doc.json.nodes.find((n) => n.skin === 0 && n.mesh !== undefined).mesh]
				.primitives[0].attributes.JOINTS_0
		);
		expect(Math.max(...J)).toBeLessThan(skin.joints.length);
		const after = await restVertices(bytes);
		expect(after.g.scene.getObjectByName('handl')?.parent?.name).toBe('lowerarml');
		expect(maxGap(before.out, after.out)).toBeLessThan(1e-4);
		expect(() => deleteBone(knight(), 'Rig')).toThrow();
	});

	it('mirror left -> right: a displaced right arm comes back to the mirror of the left', async () => {
		const doc = readGlb(knight());
		const r = nodeIndex(doc.json, 'upperarmr');
		const t = doc.json.nodes[r].translation;
		const moved = moveBoneRest(knight(), 'upperarmr', [t[0] - 0.1, t[1] + 0.1, t[2]]);
		const { bytes, pairs } = mirrorBones(moved, 'left');
		expect(pairs.some(([a, b]) => a === 'upperarm.l' && b === 'upperarm.r')).toBe(true);
		const W = worldOf(readGlb(bytes).json);
		const j = readGlb(bytes).json;
		const pl = new THREE.Vector3().setFromMatrixPosition(W[nodeIndex(j, 'upperarml')]);
		const pr = new THREE.Vector3().setFromMatrixPosition(W[nodeIndex(j, 'upperarmr')]);
		expect(pr.distanceTo(new THREE.Vector3(-pl.x, pl.y, pl.z))).toBeLessThan(1e-4);
		const before = await restVertices(knight());
		expect(maxGap(before.out, (await restVertices(bytes)).out)).toBeLessThan(1e-4);
	});

	it('mirror names across conventions', () => {
		expect(mirrorName('mixamorigLeftArm')).toBe('mixamorigRightArm');
		expect(mirrorName('upperarm.l')).toBe('upperarm.r');
		expect(mirrorName('thigh_r')).toBe('thigh_l');
		expect(mirrorName('J_Bip_L_Hand')).toBe('J_Bip_R_Hand');
		expect(mirrorName('spine')).toBe('');
		expect(sideOfName('upperarm.l')).toBe('left');
		expect(sideOfName('RightHand')).toBe('right');
	});

	it('new weights land in the file', async () => {
		const doc = readGlb(knight());
		const meshIdx = doc.json.nodes.find((n) => n.skin === 0 && n.mesh !== undefined).mesh;
		const count =
			doc.json.accessors[doc.json.meshes[meshIdx].primitives[0].attributes.POSITION].count;
		const J = new Uint16Array(count * 4);
		const W = new Float32Array(count * 4);
		for (let i = 0; i < count; i++) W[i * 4] = 1; // everything on joint 0
		const { mesh } = await restVertices(setPrimitiveWeights(knight(), meshIdx, 0, J, W));
		expect(Array.from(mesh.geometry.attributes.skinWeight.array.slice(0, 4))).toEqual([1, 0, 0, 0]);
	});
});

describe('57 M6 weights', () => {
	/** a bar along +Y, 0..2, 8 rings of 6 vertices, two bones (0..1, 1..2) */
	function bar() {
		const g = new THREE.CylinderGeometry(0.1, 0.1, 2, 6, 16, false);
		g.translate(0, 1, 0);
		return {
			positions: new Float32Array(g.attributes.position.array),
			index: new Uint32Array(g.index.array)
		};
	}
	const bones = [
		{ head: [0, 0, 0], tail: [0, 1, 0] },
		{ head: [0, 1, 0], tail: [0, 2, 0] }
	];
	it('heat weights: each half follows its bone, the joint blends, every vertex sums to 1', () => {
		const m = bar();
		const { joints, weights } = heatWeights(m, bones);
		const n = m.positions.length / 3;
		const w1 = (i) =>
			[0, 1, 2, 3].reduce((s, k) => s + (joints[i * 4 + k] === 1 ? weights[i * 4 + k] : 0), 0);
		for (let i = 0; i < n; i++) {
			const sum = weights[i * 4] + weights[i * 4 + 1] + weights[i * 4 + 2] + weights[i * 4 + 3];
			expect(sum).toBeCloseTo(1, 5);
			const y = m.positions[i * 3 + 1];
			if (y < 0.3) expect(w1(i)).toBeLessThan(0.2);
			if (y > 1.7) expect(w1(i)).toBeGreaterThan(0.8);
			if (Math.abs(y - 1) < 0.07)
				(expect(w1(i)).toBeGreaterThan(0.2), expect(w1(i)).toBeLessThan(0.8));
		}
	});

	it('heat travels over the SURFACE: two separate legs never share a bone through the air', () => {
		const a = new THREE.CylinderGeometry(0.05, 0.05, 1, 6, 6);
		a.translate(-0.12, 0.5, 0);
		const b = a.clone();
		b.translate(0.24, 0, 0);
		const pos = new Float32Array([...a.attributes.position.array, ...b.attributes.position.array]);
		const off = a.attributes.position.count;
		const idx = new Uint32Array([...a.index.array, ...Array.from(b.index.array, (i) => i + off)]);
		// bones running down the middle of each leg; a vertex on the inner side of the right leg is
		// closer to the LEFT bone through the air than... it must still be the right leg's
		const legs = [
			{ head: [-0.12, 1, 0], tail: [-0.12, 0, 0] },
			{ head: [0.12, 1, 0], tail: [0.12, 0, 0] }
		];
		const { joints, weights } = heatWeights({ positions: pos, index: idx }, legs);
		for (let i = 0; i < pos.length / 3; i++) {
			const own = pos[i * 3] < 0 ? 0 : 1;
			const w = [0, 1, 2, 3].reduce(
				(s, k) => s + (joints[i * 4 + k] === own ? weights[i * 4 + k] : 0),
				0
			);
			expect(w).toBeGreaterThan(0.99);
		}
	});

	it('smooth softens a hard cut; normalize caps at 4 and sums to 1; the brush adds around a point', () => {
		const m = bar();
		const n = m.positions.length / 3;
		const J = new Uint16Array(n * 4);
		const W = new Float32Array(n * 4);
		for (let i = 0; i < n; i++) {
			J[i * 4] = m.positions[i * 3 + 1] < 1 ? 0 : 1;
			W[i * 4] = 1;
		}
		const s = smoothWeights(m, J, W, { steps: 3 });
		let blended = 0;
		for (let i = 0; i < n; i++) if (s.weights[i * 4] < 0.999) blended++;
		expect(blended).toBeGreaterThan(0);
		const raw = new Float32Array([0.5, 0.5, 0.5, 0.5]);
		const nz = normalizeWeights(new Uint16Array([3, 2, 1, 0]), raw);
		expect(nz.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
		const touched = brushWeights(m.positions, J, W, [0, 0.5, 0], 0.3, 1, 0.8);
		expect(touched).toBeGreaterThan(0);
		const g = surfaceGraph(m);
		expect(g.count).toBeLessThan(n); // the cylinder seam welds
	});
});
