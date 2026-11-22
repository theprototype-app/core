// @ts-nocheck — node polyfill + exporter plumbing
// Roadmap 99 K1 row 2: does the stored face partition (`geometry.userData.__topo`) survive the GLTF
// AUTOSAVE path? Measured with three's own GLTFExporter -> GLTFLoader, the pair autosave.js uses
// (JSON glTF with embedded data URIs, default options), on what faceEdit commits: a non-indexed
// soup with a quad partition, with and without material groups.
//
// THE ANSWER (as measured here, three r186):
// - single material: YES. GLTFExporter writes geometry.userData as the PRIMITIVE's `extras`
//   (serializeUserData(geometry, primitive)) and GLTFLoader's addPrimitiveAttributes assigns
//   primitive extras back to geometry.userData. Triangle order and count are kept (non-indexed in,
//   non-indexed out), so readStoredFaces() validates it and the quads come back as data.
// - material groups (a multi-slot mesh): the exporter SPLITS the mesh into one primitive per group
//   and every primitive carries the WHOLE partition, so each child's copy is invalid for its own
//   triangle count and readStoredFaces() DROPS it (the A7 invariant: never a wrong result). That
//   mesh is not restored from the GLTF anyway: autosave's multiMaterial sidecar is a toJSON, and
//   BufferGeometry.toJSON keeps userData, so the partition survives there too.
// CLAUDE.md's line "GLTF-based autosave does NOT round-trip geometry.userData" is out of date for
// the single-material case; this test is the guard for the claim either way.
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshKernel } from '$lib/meshKernel/index.js';
import { toBufferGeometry } from '$lib/meshKernel/three.js';
import { fromBufferGeometry } from '$lib/meshKernel/geometry.js';
import { readStoredFaces } from '$lib/meshTopology.js';

beforeAll(() => {
	// ...and FileLoader (the data-URI buffers) reports through ProgressEvent
	if (typeof globalThis.ProgressEvent === 'undefined')
		globalThis.ProgressEvent = class extends Event {
			constructor(type, init = {}) {
				super(type);
				Object.assign(this, init);
			}
		};
	// node has Blob but no FileReader; the exporter reads its buffers through one
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

/** a quad grid committed the way the kernel (and faceEdit's composeFaces) store it */
function quadGridGeometry(n) {
	const m = new MeshKernel({ attributes: { uv: 2 } });
	const id = [];
	for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) id.push(m.addVertex(x, y, 0));
	for (let y = 0; y < n; y++)
		for (let x = 0; x < n; x++) {
			const q = [y * (n + 1) + x, y * (n + 1) + x + 1, (y + 1) * (n + 1) + x + 1, (y + 1) * (n + 1) + x];
			const uv = q.flatMap((k) => [(k % (n + 1)) / n, Math.floor(k / (n + 1)) / n]);
			m.addFace(q.map((k) => id[k]), { attrs: { uv }, material: x % 2 });
		}
	return toBufferGeometry(m).geometry;
}

/** export a scene the way autosave does (default options -> JSON with data URIs), load it back */
async function roundTrip(root) {
	const json = await new Promise((resolve, reject) => new GLTFExporter().parse(root, resolve, reject));
	const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(json, '', resolve, reject));
	const meshes = [];
	gltf.scene.traverse((o) => o.isMesh && meshes.push(o));
	return { json, meshes };
}

describe('__topo through the GLTF autosave pair', () => {
	it('single material: the partition survives as primitive extras and still validates', async () => {
		const geometry = quadGridGeometry(3);
		geometry.clearGroups(); // one slot
		expect(readStoredFaces(geometry)?.length).toBe(9);
		const scene = new THREE.Scene();
		scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
		const { json, meshes } = await roundTrip(scene);
		expect(json.meshes[0].primitives[0].extras?.__topo).toBeTruthy(); // where it rides
		expect(meshes.length).toBe(1);
		const back = meshes[0].geometry;
		expect(back.userData.__topo).toEqual(geometry.userData.__topo);
		expect(readStoredFaces(back)?.length).toBe(9); // validated against the loaded triangle count
		// and the kernel reads the quads back as n-gons
		const { report } = fromBufferGeometry(back);
		expect(report).toMatchObject({ partition: 'used', ngons: 9, fallbackFaces: 0 });
	});
	it('material groups: split into per-slot primitives, each copy fails validation and is dropped', async () => {
		const geometry = quadGridGeometry(2); // slots 0 and 1 alternate per column
		expect(geometry.groups.length).toBeGreaterThan(1);
		const mats = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
		const scene = new THREE.Scene();
		scene.add(new THREE.Mesh(geometry, mats));
		const { meshes } = await roundTrip(scene);
		expect(meshes.length).toBe(geometry.groups.length); // one primitive per GROUP (runs), not per slot
		for (const mesh of meshes) {
			expect(mesh.geometry.userData.__topo).toEqual(geometry.userData.__topo); // the whole partition, copied
			expect(readStoredFaces(mesh.geometry)).toBe(null); // ...which does not fit: dropped, never trusted
		}
		// the multiMaterial sidecar is a toJSON: BufferGeometry.toJSON keeps userData
		const restored = new THREE.ObjectLoader().parse(new THREE.Mesh(geometry, mats).toJSON());
		expect(readStoredFaces(restored.geometry)?.length).toBe(4);
	});
});
