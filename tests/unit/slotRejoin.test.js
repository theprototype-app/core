// @ts-nocheck
// fix-late-joiners row 6: a multi-slot mesh above the toJSON cap goes by glTF (one primitive per group); the joiner folds
// the primitives back into ONE mesh from the slot layout the sender carries. Counterfactual: without the rejoin the
// loader's node is a Group of single-material meshes (asserted first).
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { slotLayoutOf } from '../../src/lib/slotGroups.js';
import { rejoinSlotPrimitives } from '../../src/lib/slotRejoin.js';
import { restoreGltfNames } from '../../src/lib/gltfNames.js';

beforeAll(() => {
	if (typeof globalThis.ProgressEvent === 'undefined')
		globalThis.ProgressEvent = class extends Event {
			constructor(type, init = {}) {
				super(type);
				Object.assign(this, init);
			}
		};
	if (typeof globalThis.FileReader === 'undefined')
		globalThis.FileReader = class {
			readAsDataURL(blob) {
				blob.arrayBuffer().then((buf) => {
					this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
					this.onloadend?.({ target: this });
					this.onload?.({ target: this });
				});
			}
			readAsArrayBuffer(blob) {
				blob.arrayBuffer().then((buf) => {
					this.result = buf;
					this.onloadend?.({ target: this });
					this.onload?.({ target: this });
				});
			}
		};
});

/** a 20k-vertex mesh with 3 slots: a fine sphere, its index split into three uneven groups (out of slot order) */
function bigSlotMesh(indexed = true) {
	let geometry = new THREE.SphereGeometry(1, 160, 124); // 161 * 125 = 20125 vertices
	geometry = new THREE.BufferGeometry().copy(geometry);
	if (!indexed) geometry = geometry.toNonIndexed();
	const n = indexed ? geometry.index.count : geometry.attributes.position.count;
	const a = 3 * Math.floor(n / 18); // ~ a sixth, on a triangle boundary
	const b = 3 * Math.floor(n / 6); // ~ a half
	geometry.clearGroups();
	geometry.addGroup(0, a, 2);
	geometry.addGroup(a, b - a, 0);
	geometry.addGroup(b, n - b, 1);
	const mats = [0xff0000, 0x00ff00, 0x0000ff].map((c) => new THREE.MeshStandardMaterial({ color: c }));
	const mesh = new THREE.Mesh(geometry, mats);
	mesh.name = 'Statue three slots';
	mesh.position.set(1, 2, 3);
	return mesh;
}

const roundTrip = async (mesh) => {
	const json = await new Promise((resolve, reject) => new GLTFExporter().parse(mesh, resolve, reject, { onlyVisible: false }));
	const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(JSON.stringify(json), '', resolve, reject));
	restoreGltfNames(gltf, json); // the joiner's order: names first, then the rejoin
	return gltf.scene.children[0];
};

describe('rejoinSlotPrimitives', () => {
	for (const indexed of [true, false]) {
		it(`a 20k-vertex mesh with 3 slots comes back as ONE mesh: same groups, index, slots (${indexed ? 'indexed' : 'non-indexed'})`, async () => {
			const mesh = bigSlotMesh(indexed);
			expect(mesh.geometry.attributes.position.count).toBeGreaterThan(15000);
			const layout = slotLayoutOf(mesh);
			const node = await roundTrip(mesh);
			// the bug: what a joiner held on v1.74.0
			expect(node.isGroup).toBe(true);
			expect(node.children.filter((c) => c.isMesh).length).toBe(3);
			const whole = rejoinSlotPrimitives(node, JSON.parse(JSON.stringify(layout)));
			expect(whole?.isMesh).toBe(true);
			expect(whole.material.length).toBe(3);
			expect(whole.geometry.groups).toEqual(mesh.geometry.groups.map((g) => ({ start: g.start, count: g.count, materialIndex: g.materialIndex })));
			// same material on each slot (by colour: the loader made new material objects)
			expect(whole.material.map((m) => m.color.getHex())).toEqual(mesh.material.map((m) => m.color.getHex()));
			if (indexed) expect(Array.from(whole.geometry.index.array)).toEqual(Array.from(mesh.geometry.index.array));
			else expect(whole.geometry.index).toBe(null);
			expect(whole.geometry.attributes.position.count).toBe(mesh.geometry.attributes.position.count);
			expect(whole.name).toBe('Statue three slots');
			expect(whole.position.toArray()).toEqual([1, 2, 3]);
			// every triangle inside a group whose slot exists
			const total = indexed ? whole.geometry.index.count : whole.geometry.attributes.position.count;
			expect(whole.geometry.groups.reduce((s, g) => s + g.count, 0)).toBe(total);
		});
	}

	it('refuses a layout that does not fit (a peer is untrusted): null, and the caller keeps the loaded node', async () => {
		const mesh = bigSlotMesh(true);
		const node = await roundTrip(mesh);
		const layout = slotLayoutOf(mesh);
		expect(rejoinSlotPrimitives(node, { ...layout, groups: layout.groups.slice(1) })).toBe(null);
		expect(rejoinSlotPrimitives(node, { ...layout, slots: 1e9 })).toBe(null);
		expect(rejoinSlotPrimitives(node, { ...layout, groups: [{ start: -1, count: 3, materialIndex: 0 }, ...layout.groups.slice(1)] })).toBe(null);
		expect(rejoinSlotPrimitives(node, null)).toBe(null);
		// 71-int: a count far beyond the index the glTF holds is refused BEFORE the index array is allocated
		const realloc = globalThis.Uint32Array;
		let biggest = 0;
		globalThis.Uint32Array = class extends realloc {
			constructor(n, ...rest) {
				super(n, ...rest);
				if (typeof n === 'number') biggest = Math.max(biggest, n);
			}
		};
		try {
			expect(rejoinSlotPrimitives(node, { ...layout, count: 48_000_000 })).toBe(null);
		} finally {
			globalThis.Uint32Array = realloc;
		}
		expect(biggest).toBeLessThan(48_000_000);
	});

	it('a single-material mesh has no layout (its message is byte-identical)', () => {
		expect(slotLayoutOf(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()))).toBe(null);
	});
});
