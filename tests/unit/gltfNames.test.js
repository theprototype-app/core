// @ts-nocheck
// fix-late-joiners: a joiner's objects keep their names (GLTFLoader sanitizes "Gate zone" to "Gate_zone").
// Counterfactual: without restoreGltfNames the parsed names are the sanitized ones (asserted below).
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { restoreGltfNames } from '../../src/lib/gltfNames.js';

beforeAll(() => {
	if (typeof globalThis.ProgressEvent === 'undefined')
		globalThis.ProgressEvent = class extends Event {
			constructor(type, init = {}) {
				super(type);
				Object.assign(this, init);
			}
		};
	// node has Blob but no FileReader; the exporter reads its buffers through one (meshKernelGltfTopo's shim)
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

const roundTrip = async (object) => {
	const json = await new Promise((resolve, reject) => new GLTFExporter().parse(object, resolve, reject, { onlyVisible: false }));
	const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(JSON.stringify(json), '', resolve, reject));
	return { json, gltf };
};

describe('restoreGltfNames', () => {
	it('puts back the names the loader sanitized, mesh and nested node alike', async () => {
		const zone = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		zone.name = 'Gate zone';
		zone.visible = false;
		const child = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		child.name = 'Guard route v1.2: left/right';
		zone.add(child);
		const { json, gltf } = await roundTrip(zone);
		const before = [];
		gltf.scene.traverse((o) => before.push(o.name));
		expect(before).toContain('Gate_zone'); // the bug: what a joiner held on v1.74.0
		expect(restoreGltfNames(gltf, json)).toBe(2);
		const names = [];
		gltf.scene.traverse((o) => names.push(o.name));
		expect(names).toContain('Gate zone');
		expect(names).toContain('Guard route v1.2: left/right');
	});

	it('accepts JSON text, and leaves a result with no associations alone', async () => {
		const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		m.name = 'Crate 7';
		const { json, gltf } = await roundTrip(m);
		expect(restoreGltfNames(gltf, JSON.stringify(json))).toBe(1);
		expect(restoreGltfNames({ scene: gltf.scene }, json)).toBe(0);
		expect(restoreGltfNames(gltf, 'not json')).toBe(0);
	});
});
