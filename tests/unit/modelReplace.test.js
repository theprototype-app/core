// @ts-nocheck — fixture-driven (node; the shipped avatar GLBs parsed by the real GLTFLoader)
// 59 T1/T7 — the pure halves of Replace from file:
//  F2  the clip keep rule (by bone name) and the clips it keeps, written INTO the new GLB's bytes
//      and read back by GLTFLoader with the same keys — on the shipped knight + its clip library,
//      which is the real re-rig case (one skeleton, clips authored in another file);
//  T7b the `extras.theprototype` stamp a re-exported file is recognised by, scene + root nodes;
//  T7c the sanity checks (~100× scale, Z-up, unapplied transforms) and the fix matrix, applied
//      to a GLB's root nodes losslessly.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { stampTpExtras, readTpExtras, transformRootNodes, appendAnimations, composeTRS, decomposeTRS } from '../../src/lib/glbEdit.js';
import { clipKeepPlan, clipToGlbAnimation, nodeIndexOf, clipSummary, trackTarget } from '../../src/lib/modelClips.js';
import { sanityIssues, fixMatrix } from '../../src/lib/modelSanity.js';
import { unpackGlb } from '../../src/lib/gltfOptimize/glbPost.js';

globalThis.self = globalThis; // GLTFLoader reads self.URL for embedded images

/** @param {string} name */
function fixture(name) {
	const b = fs.readFileSync(new URL('../../static/avatars/' + name, import.meta.url));
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/** GLTFLoader.parse, quiet about the texture node cannot decode @param {ArrayBuffer} bytes */
function parse(bytes) {
	return new Promise((resolve, reject) => {
		const err = console.error;
		const warn = console.warn;
		console.error = () => {};
		console.warn = () => {};
		new GLTFLoader().parse(
			bytes,
			'',
			(g) => {
				console.error = err;
				console.warn = warn;
				resolve(g);
			},
			(e) => {
				console.error = err;
				console.warn = warn;
				reject(e);
			}
		);
	});
}

/** a box GLB written by hand (no exporter in node): one root node over one mesh */
function boxGlb({ size = [1, 2, 0.5], rootScale = null, rootRotation = null } = {}) {
	const g = new THREE.BoxGeometry(size[0], size[1], size[2]).toNonIndexed();
	const pos = new Float32Array(g.attributes.position.array);
	const box = new THREE.Box3().setFromBufferAttribute(g.attributes.position);
	const json = {
		asset: { version: '2.0' },
		scene: 0,
		scenes: [{ nodes: [0] }],
		nodes: [{ name: 'Root', children: [1], ...(rootScale ? { scale: rootScale } : {}), ...(rootRotation ? { rotation: rootRotation } : {}) }, { name: 'Box', mesh: 0 }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
		accessors: [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: box.min.toArray(), max: box.max.toArray() }],
		bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }],
		buffers: [{ byteLength: pos.byteLength }]
	};
	return fixtureFrom(json, new Uint8Array(pos.buffer));
}

/** @param {any} json @param {Uint8Array} bin */
function fixtureFrom(json, bin) {
	// appendAnimations with nothing to append is the identity writer
	const text = new TextEncoder().encode(JSON.stringify(json));
	const jl = (text.byteLength + 3) & ~3;
	const bl = (bin.byteLength + 3) & ~3;
	const out = new Uint8Array(12 + 8 + jl + 8 + bl);
	const v = new DataView(out.buffer);
	v.setUint32(0, 0x46546c67, true);
	v.setUint32(4, 2, true);
	v.setUint32(8, out.byteLength, true);
	v.setUint32(12, jl, true);
	v.setUint32(16, 0x4e4f534a, true);
	out.set(text, 20);
	out.fill(0x20, 20 + text.byteLength, 20 + jl);
	v.setUint32(20 + jl, bl, true);
	v.setUint32(24 + jl, 0x004e4942, true);
	out.set(bin, 28 + jl);
	return out.buffer;
}

/** the parsed scene's box size @param {any} gltf */
function sizeOf(gltf) {
	gltf.scene.updateMatrixWorld(true);
	return new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3()).toArray();
}

describe('F2 — clips kept by bone name, written into the new GLB', () => {
	let clips;
	let knightBytes;
	let knight;
	beforeAll(async () => {
		clips = (await parse(fixture('clips.glb'))).animations;
		knightBytes = fixture('knight.glb');
		knight = await parse(knightBytes);
	});

	it('the clip library binds to the knight: every bone of every clip exists on it', () => {
		expect(clips.length).toBe(10);
		expect(knight.animations.length).toBe(0);
		const index = nodeIndexOf(knight.scene, knight.parser);
		const plan = clipKeepPlan(clips, [], (n) => index.has(n));
		expect(plan.dropped).toEqual([]);
		expect(plan.keep.map((c) => c.name)).toEqual(clips.map((c) => c.name));
	});

	it('a clip the new file carries under the same name wins; a clip naming a missing bone is dropped and listed', () => {
		const index = nodeIndexOf(knight.scene, knight.parser);
		const someBone = trackTarget(clips[0].tracks[0].name).node;
		const lacking = (n) => index.has(n) && n !== someBone;
		const plan = clipKeepPlan(clips, ['Idle'], lacking);
		expect(plan.keep.some((c) => c.name === 'Idle')).toBe(false);
		// every clip animates every bone here, so losing one bone drops all of the others
		expect(plan.keep).toEqual([]);
		expect(plan.dropped.length).toBe(9);
		expect(plan.dropped[0].missing).toEqual([someBone]);
		expect(clipSummary([], plan.dropped.slice(0, 1))).toContain('(no ' + someBone + ')');
		expect(clipSummary(['Run', 'Walk'], [])).toBe('kept clips Run, Walk');
	});

	it('kept clips go INTO the bytes and GLTFLoader reads back the same tracks (names, times, values)', async () => {
		const index = nodeIndexOf(knight.scene, knight.parser);
		const encoded = clips.map((c) => clipToGlbAnimation(c, index));
		expect(encoded.every((e) => e.skipped === 0)).toBe(true);
		const bytes = appendAnimations(knightBytes, encoded.map((e) => e.animation));
		const back = await parse(bytes);
		expect(back.animations.map((c) => c.name)).toEqual(clips.map((c) => c.name));
		for (let i = 0; i < clips.length; i++) {
			const a = clips[i];
			const b = back.animations[i];
			expect(b.tracks.length).toBe(a.tracks.length);
			expect(b.duration).toBeCloseTo(a.duration, 5);
			for (let t = 0; t < a.tracks.length; t++) {
				expect(b.tracks[t].name).toBe(a.tracks[t].name);
				expect(Array.from(b.tracks[t].times)).toEqual(Array.from(a.tracks[t].times));
				expect(Array.from(b.tracks[t].values)).toEqual(Array.from(a.tracks[t].values));
			}
		}
		// the knight's own geometry and skin are untouched: the original BIN is a prefix
		const before = unpackGlb(knightBytes);
		const after = unpackGlb(bytes);
		expect(Array.from(after.bin.subarray(0, before.bin.byteLength))).toEqual(Array.from(before.bin));
		expect(after.json.meshes).toEqual(before.json.meshes);
		expect(after.json.skins).toEqual(before.json.skins);
	});

	it('a shape-key track is skipped and counted, not mis-bound', () => {
		const index = new Map([['Box', 1]]);
		const clip = new THREE.AnimationClip('k', 1, [
			new THREE.VectorKeyframeTrack('Box.position', [0, 1], [0, 0, 0, 1, 0, 0]),
			new THREE.NumberKeyframeTrack('Box.morphTargetInfluences', [0, 1], [0, 1])
		]);
		const { animation, skipped } = clipToGlbAnimation(clip, index);
		expect(skipped).toBe(1);
		expect(animation.channels).toHaveLength(1);
		expect(animation.channels[0]).toMatchObject({ node: 1, path: 'translation', interpolation: 'LINEAR' });
		const step = new THREE.VectorKeyframeTrack('Box.scale', [0, 1], [1, 1, 1, 2, 2, 2], THREE.InterpolateDiscrete);
		expect(clipToGlbAnimation(new THREE.AnimationClip('s', 1, [step]), index).animation.channels[0].interpolation).toBe('STEP');
	});
});

describe('T7b — extras.theprototype', () => {
	it('stamps the scene and its root nodes, keeps other extras, and reads back from either', async () => {
		const bytes = boxGlb();
		expect(readTpExtras(bytes)).toBe(null);
		const stamped = stampTpExtras(bytes, { uuid: 'abc-123', name: 'Fox' });
		expect(readTpExtras(stamped)).toEqual({ uuid: 'abc-123', name: 'Fox' });
		const { json } = unpackGlb(stamped);
		expect(json.scenes[0].extras.theprototype.uuid).toBe('abc-123');
		expect(json.nodes[0].extras.theprototype.uuid).toBe('abc-123');
		expect(json.nodes[1].extras).toBeUndefined();
		// an exporter that drops the SCENE's custom properties still keeps the node's
		delete json.scenes[0].extras;
		const nodeOnly = fixtureFrom(json, unpackGlb(stamped).bin);
		expect(readTpExtras(nodeOnly)).toEqual({ uuid: 'abc-123', name: 'Fox' });
		// GLTFLoader hands both to userData, which is how a parsed file is recognised too
		const g = await parse(stamped);
		expect(g.scene.userData.theprototype.uuid).toBe('abc-123');
		expect(g.scene.children[0].userData.theprototype.uuid).toBe('abc-123');
		// the geometry is untouched
		expect(sizeOf(g).map((v) => +v.toFixed(5))).toEqual([1, 2, 0.5]);
	});

	it('reads a .gltf JSON text and shrugs at junk', () => {
		const text = JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [], extras: { theprototype: { uuid: 'u1', name: 'A' } } }] });
		expect(readTpExtras(new TextEncoder().encode(text))).toEqual({ uuid: 'u1', name: 'A' });
		expect(readTpExtras(new Uint8Array([1, 2, 3, 4]))).toBe(null);
		expect(readTpExtras(new TextEncoder().encode('solid stl file'))).toBe(null);
	});
});

describe('T7c — sanity checks', () => {
	it('flags ~100× either way with the power-of-ten fix, and nothing for a model of similar size', () => {
		const big = sanityIssues({ oldSize: [1, 2, 0.5], newSize: [100, 200, 50] });
		expect(big.map((i) => i.kind)).toEqual(['scale']);
		expect(big[0].factor).toBe(0.01);
		expect(big[0].message).toContain('100× larger');
		const small = sanityIssues({ oldSize: [1, 2, 0.5], newSize: [0.01, 0.02, 0.005] });
		expect(small[0].factor).toBe(100);
		expect(small[0].message).toContain('smaller');
		expect(sanityIssues({ oldSize: [1, 2, 0.5], newSize: [1.4, 2.6, 0.6] })).toEqual([]);
		expect(sanityIssues({ oldSize: [1, 2, 0.5], newSize: [10, 20, 5] })).toEqual([]);
		// no model to compare with (nothing measurable) says nothing
		expect(sanityIssues({ oldSize: null, newSize: [100, 200, 50] })).toEqual([]);
	});

	it('flags a model lying on its back (Y and Z swapped), not a merely different one', () => {
		expect(sanityIssues({ oldSize: [0.5, 2, 0.6], newSize: [0.5, 0.6, 2] }).map((i) => i.kind)).toEqual(['zup']);
		// with the cm/m mix-up on top: both
		expect(sanityIssues({ oldSize: [0.5, 2, 0.6], newSize: [50, 60, 200] }).map((i) => i.kind)).toEqual(['scale', 'zup']);
		expect(sanityIssues({ oldSize: [1, 1, 1], newSize: [1, 1.2, 0.9] })).toEqual([]);
		expect(sanityIssues({ oldSize: [1, 2, 1], newSize: [1, 2.5, 1.2] })).toEqual([]);
	});

	it('flags unapplied transforms on the root: a scale, or the same quarter turn about X on every root', () => {
		const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2).toArray();
		const scaled = sanityIssues({ oldSize: null, newSize: [1, 1, 1], topNodes: [{ scale: [100, 100, 100] }], canBake: true });
		expect(scaled.map((i) => i.kind)).toEqual(['transforms']);
		expect(scaled[0].fixable).toBe(true);
		expect(sanityIssues({ newSize: [1, 1, 1], topNodes: [{ quaternion: q }, { quaternion: q }] })[0].message).toContain('quarter turn');
		// a rig's bind pose cannot be re-baked: said, not offered
		expect(sanityIssues({ newSize: [1, 1, 1], topNodes: [{ scale: [0.01, 0.01, 0.01] }], canBake: false })[0].fixable).toBe(false);
		// one part turned among others is a model, not a mistake
		expect(sanityIssues({ newSize: [1, 1, 1], topNodes: [{ quaternion: q }, { quaternion: [0, 0, 0, 1] }] })).toEqual([]);
		expect(sanityIssues({ newSize: [1, 1, 1], topNodes: [{ scale: [1, 1, 1], quaternion: [0, 0, 0, 1] }] })).toEqual([]);
	});

	it('the fix matrix scales and stands the model up (+Z becomes +Y), losslessly on a GLB', async () => {
		const issues = sanityIssues({ oldSize: [0.5, 2, 0.6], newSize: [50, 60, 200] });
		const m = new THREE.Matrix4().fromArray(fixMatrix(issues));
		const up = new THREE.Vector3(0, 0, 1).applyMatrix4(m);
		expect(up.toArray().map((v) => +v.toFixed(6))).toEqual([0, 0.01, 0]);
		expect(fixMatrix([])).toBe(null);
		// on the bytes: a Z-up 100× box comes back the size and way up of the one it replaces
		const bytes = boxGlb({ size: [50, 60, 200] });
		const fixed = await parse(transformRootNodes(bytes, fixMatrix(issues)));
		expect(sizeOf(fixed).map((v) => +v.toFixed(4))).toEqual([0.5, 2, 0.6]);
		// a node that already had a scale keeps a TRS (no matrix appears)
		const { json } = unpackGlb(transformRootNodes(boxGlb({ rootScale: [2, 2, 2] }), fixMatrix([{ kind: 'scale', factor: 0.5, fixable: true }])));
		expect(json.nodes[0].matrix).toBeUndefined();
		expect(json.nodes[0].scale.map((v) => +v.toFixed(6))).toEqual([1, 1, 1]);
	});

	it('compose/decompose round trip', () => {
		const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -1.1, 2.0)).toArray();
		const d = decomposeTRS(composeTRS([1, 2, 3], q, [2, 2, 2]));
		expect(d.t).toEqual([1, 2, 3]);
		d.s.forEach((s) => expect(s).toBeCloseTo(2, 9));
		const sameRotation = Math.abs(d.q.reduce((acc, v, i) => acc + v * q[i], 0));
		expect(sameRotation).toBeCloseTo(1, 9);
	});
});
