// @ts-nocheck - hand-built loader JSON fixtures, deliberately malformed
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
	guardObjectJson,
	guardMaterialSet,
	isStandardMaterial,
	MAX_NUMBERS,
	STANDARD_MATERIAL_TYPES
} from '../../src/lib/loadGuardCore.js';
import { parseCheckedObject, checkMaterialSet, embeddedOnlyManager, loadGuardTotals, resetLoadGuard, isLocalImageUrl } from '../../src/lib/loadGuard.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const program = () =>
	new THREE.ShaderMaterial({
		vertexShader: 'void main(){ gl_Position = vec4(0.0); }',
		fragmentShader: 'void main(){ gl_FragColor = vec4(1.0); }',
		uniforms: { diffuse: { value: new THREE.Color(0x336699) } }
	});

/** every material type found anywhere in a parsed tree @param {any} root */
const typesIn = (root) => {
	const out = [];
	root.traverse((/** @type {any} */ o) => {
		if (!o.material) return;
		for (const m of [].concat(o.material)) out.push(m.type);
	});
	return out;
};

/** an image entry pointing at `url`, wired to the first material's map @param {any} json @param {any} url */
const withImage = (json, url) => {
	json.images = [{ uuid: 'img-1', url }];
	json.textures = [{ uuid: 'tex-1', image: 'img-1' }];
	json.materials[0].map = 'tex-1';
	return json;
};

beforeEach(() => resetLoadGuard());

describe('materials', () => {
	it('keeps standard materials byte for byte', () => {
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhysicalMaterial({ color: 0xff0000, roughness: 0.3 }));
		const json = mesh.toJSON();
		const before = JSON.stringify(json);
		const r = guardObjectJson(json);
		expect(r).toMatchObject({ ok: true, materials: 0, images: 0, textures: 0 });
		expect(JSON.stringify(json)).toBe(before);
	});

	it('replaces a program material, keeping uuid, name and colour', () => {
		const material = program();
		material.name = 'glow';
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
		const json = mesh.toJSON();
		const r = guardObjectJson(json);
		expect(r.ok).toBe(true);
		expect(r.materials).toBe(1);
		expect(json.materials[0]).toEqual({ type: 'MeshStandardMaterial', uuid: material.uuid, name: 'glow', color: 0x336699 });
		const parsed = new THREE.ObjectLoader().parse(json);
		expect(parsed.material.type).toBe('MeshStandardMaterial');
		expect(parsed.material.uuid).toBe(material.uuid);
		expect(parsed.material.color.getHex()).toBe(0x336699);
	});

	it('replaces RawShaderMaterial, the bare base type, unknown types and standard types carrying program fields', () => {
		for (const material of [
			{ uuid: 'a', type: 'RawShaderMaterial', vertexShader: 'x', fragmentShader: 'y' },
			{ uuid: 'b', type: 'Material' },
			{ uuid: 'c', type: 'MeshSomethingNewMaterial' },
			{ uuid: 'd', type: 'MeshStandardMaterial', fragmentShader: 'y' },
			{ uuid: 'e', type: 'MeshBasicMaterial', defines: { X: 1 } },
			{ uuid: 'f', type: 'MeshBasicMaterial', glslVersion: '300 es' },
			{ uuid: 'g', type: 'MeshBasicMaterial', extensions: { clipCullDistance: true } },
			{ uuid: 'h', type: 'MeshBasicMaterial', uniforms: {} },
			{ uuid: 'i', type: { toString: () => 'MeshBasicMaterial' } },
			null,
			'MeshBasicMaterial'
		]) {
			expect(isStandardMaterial(material)).toBe(false);
			const set = { materials: [material] };
			const r = guardMaterialSet(set);
			expect(r.materials).toBe(1);
			expect(set.materials[0].type).toBe('MeshStandardMaterial');
		}
	});

	it('every standard type round-trips untouched', () => {
		for (const type of STANDARD_MATERIAL_TYPES) {
			const material = new /** @type {any} */ (THREE)[type]();
			expect(isStandardMaterial(material.toJSON())).toBe(true);
		}
	});

	it('handles nested groups, material arrays and multi-material meshes', () => {
		// a plain BufferGeometry (a parametric one serializes its parameters, not its groups)
		const geometry = new THREE.BufferGeometry().copy(new THREE.BoxGeometry());
		geometry.clearGroups();
		geometry.addGroup(0, 18, 0);
		geometry.addGroup(18, 18, 1);
		const multi = new THREE.Mesh(geometry, [new THREE.MeshStandardMaterial(), program()]);
		const inner = new THREE.Group();
		inner.add(new THREE.Mesh(new THREE.SphereGeometry(), program()));
		inner.add(multi);
		const outer = new THREE.Group();
		outer.add(inner);
		outer.add(new THREE.Points(new THREE.BufferGeometry(), program()));
		outer.add(new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial()));
		outer.add(new THREE.Sprite(new THREE.SpriteMaterial()));
		const json = outer.toJSON();
		const r = guardObjectJson(json);
		expect(r.materials).toBe(3);
		const parsed = new THREE.ObjectLoader().parse(json);
		const types = typesIn(parsed);
		expect(types).not.toContain('ShaderMaterial');
		expect(types).toEqual(expect.arrayContaining(['LineDashedMaterial', 'SpriteMaterial', 'MeshStandardMaterial']));
		const back = parsed.getObjectByProperty('uuid', multi.uuid);
		expect(Array.isArray(back.material) && back.material.length).toBe(2);
		expect(back.geometry.groups.length).toBe(2);
	});

	it('a MultiMaterial entry (gone from three, so a bare Material) takes the fallback whole', () => {
		const set = { materials: [{ uuid: 'm', type: 'MultiMaterial', materials: [{ uuid: 's2', type: 'ShaderMaterial', fragmentShader: 'x' }] }] };
		expect(guardMaterialSet(set).materials).toBe(1);
		expect(set.materials[0]).toEqual({ type: 'MeshStandardMaterial', uuid: 'm' });
	});

	it('a preview address on a material is kept only when it is an embedded image', () => {
		const ok = { materials: [{ uuid: 'a', type: 'MeshBasicMaterial', userData: { mapDataUrl: PNG, mapSource: 'h' } }] };
		expect(guardMaterialSet(ok).images).toBe(0);
		expect(ok.materials[0].userData.mapDataUrl).toBe(PNG);
		for (const bad of ['https://example.com/x.png', '/x.png', 'data:text/html,x', 42]) {
			const set = {
				materials: [{ uuid: 'a', type: 'MeshBasicMaterial', userData: { mapDataUrl: bad, mapSource: 'h' } }, { uuid: 'b', type: 'ShaderMaterial', userData: { mapDataUrl: bad } }],
				mapDataUrls: [bad, PNG, null]
			};
			const r = guardMaterialSet(set);
			expect(set.materials[0].userData).toEqual({ mapSource: 'h' });
			expect(set.materials[1].userData).toEqual({});
			expect(set.mapDataUrls).toEqual([null, PNG, null]);
			expect(r.images).toBe(3);
		}
		expect(guardMaterialSet({ materials: [], mapDataUrls: { length: 1, 0: 'x' } }).ok).toBe(false);
	});

	it('an instanced mesh and a text carrier keep their data', () => {
		const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(), program(), 4);
		instanced.userData.textPath = { text: 'hello' };
		const json = instanced.toJSON();
		expect(guardObjectJson(json)).toMatchObject({ ok: true, materials: 1 });
		const parsed = /** @type {any} */ (new THREE.ObjectLoader().parse(json));
		expect(parsed.isInstancedMesh && parsed.count).toBe(4);
		expect(parsed.userData.textPath.text).toBe('hello');
	});
});

describe('images', () => {
	const mesh = () => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()).toJSON();

	it('keeps embedded images, raw pixel data and size-only records', () => {
		for (const url of [PNG, ' DATA:image/png;base64,AA', { data: [0, 0, 0, 255], width: 1, height: 1, type: 'Uint8Array' }, { width: 4, height: 4 }]) {
			const json = withImage(mesh(), url);
			expect(guardObjectJson(json)).toMatchObject({ ok: true, images: 0, textures: 0 });
			expect(json.images.length).toBe(1);
			expect(json.textures.length).toBe(1);
		}
	});

	it('drops any other url with the textures that read it, and the parse still works', () => {
		for (const url of ['https://example.com/a.png', '//example.com/a.png', '/api/x.png', 'a.png', 'blob:https://x/1', 'javascript:1', '', 42, null, undefined, ['https://example.com/a.png']]) {
			const json = withImage(mesh(), url);
			const r = guardObjectJson(json);
			expect(r).toMatchObject({ ok: true, images: 1, textures: 1 });
			expect(json.images).toEqual([]);
			expect(json.textures).toEqual([]);
			const parsed = new THREE.ObjectLoader().parse(json);
			expect(parsed.material.map).toBeFalsy();
		}
	});

	it('a cube image with ONE outside face is dropped whole', () => {
		const json = withImage(mesh(), [PNG, PNG, PNG, PNG, PNG, 'https://example.com/f.png']);
		expect(guardObjectJson(json)).toMatchObject({ images: 1, textures: 1 });
	});

	it('a texture naming an image that is not there goes too (three would throw on it)', () => {
		const json = mesh();
		json.images = [];
		json.textures = [{ uuid: 't', image: 'missing' }];
		expect(guardObjectJson(json)).toMatchObject({ ok: true, textures: 1 });
		expect(() => new THREE.ObjectLoader().parse(json)).not.toThrow();
	});

	it('the material set message drops outside images the same way', () => {
		const set = { materials: [{ uuid: 'm', type: 'MeshStandardMaterial', map: 't' }], textures: [{ uuid: 't', image: 'i' }], images: [{ uuid: 'i', url: 'https://example.com/x.png' }] };
		expect(guardMaterialSet(set)).toMatchObject({ ok: true, images: 1, textures: 1 });
	});
});

describe('size', () => {
	it('refuses an instance count larger than the matrices it carries', () => {
		const json = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 2).toJSON();
		json.object.count = 1e9;
		expect(guardObjectJson(json)).toMatchObject({ ok: false, reason: 'count' });
		json.object.count = -1;
		expect(guardObjectJson(json).ok).toBe(false);
		json.object.count = 1.5;
		expect(guardObjectJson(json).ok).toBe(false);
	});

	it('refuses batched mesh capacities that are not integers', () => {
		const json = { object: { type: 'BatchedMesh', maxInstanceCount: 1, maxVertexCount: NaN, maxIndexCount: 3 } };
		expect(guardObjectJson(json)).toMatchObject({ ok: false, reason: 'count' });
	});

	it('refuses a parametric geometry that would generate an absurd mesh, keeps editor-sized ones', () => {
		const ok = new THREE.Mesh(new THREE.PlaneGeometry(10, 10, 512, 512), new THREE.MeshStandardMaterial()).toJSON();
		expect(guardObjectJson(ok).ok).toBe(true);
		const bomb = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()).toJSON();
		Object.assign(bomb.geometries[0], { widthSegments: 1e5, heightSegments: 1e5, depthSegments: 1 });
		expect(guardObjectJson(bomb)).toMatchObject({ ok: false, reason: 'geometry' });
		const ico = { geometries: [{ uuid: 'g', type: 'IcosahedronGeometry', radius: 1, detail: 1e4 }], object: { type: 'Mesh' } };
		expect(guardObjectJson(ico).ok).toBe(false);
		const extrude = { geometries: [{ uuid: 'g', type: 'ExtrudeGeometry', shapes: [], options: { steps: 1e5, curveSegments: 1e5 } }], object: { type: 'Mesh' } };
		expect(guardObjectJson(extrude).ok).toBe(false);
	});

	it('refuses more numbers than the cap', () => {
		const json = { geometries: [{ uuid: 'g', type: 'BufferGeometry', data: { attributes: { position: { itemSize: 3, type: 'Float32Array', array: new Array(MAX_NUMBERS + 1) } } } }], object: { type: 'Mesh' } };
		expect(guardObjectJson(json)).toMatchObject({ ok: false, reason: 'size' });
	});

	it('walks a very deep tree without recursion and refuses a huge one', () => {
		let node = { type: 'Group', children: [] };
		const root = node;
		for (let i = 0; i < 50_000; i++) {
			const child = { type: 'Group', children: [] };
			node.children.push(child);
			node = child;
		}
		expect(() => guardObjectJson({ object: root })).not.toThrow();
		const wide = { type: 'Group', children: Array.from({ length: 200_001 }, () => ({ type: 'Group' })) };
		expect(guardObjectJson({ object: wide })).toMatchObject({ ok: false, reason: 'nodes' });
	});

	it('every resource list must be a real array (three walks anything with a length)', () => {
		for (const key of ['geometries', 'materials', 'textures', 'images', 'shapes', 'skeletons', 'animations']) {
			const json = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()).toJSON();
			json[key] = { length: 1, 0: { uuid: 'x', type: 'ShaderMaterial', fragmentShader: 'y' } };
			expect(guardObjectJson(json)).toMatchObject({ ok: false, reason: 'shape' });
		}
		const json = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()).toJSON();
		json.object.children = { length: 1, 0: {} };
		expect(guardObjectJson(json).ok).toBe(false);
		expect(guardObjectJson({ object: 5 }).ok).toBe(false);
	});

	it('every numeric payload must be an array or a typed array, never a number or an array-like', () => {
		const base = () => new THREE.Mesh(new THREE.BufferGeometry().copy(new THREE.BoxGeometry()), new THREE.MeshStandardMaterial()).toJSON();
		const cases = [
			(j) => (j.geometries[0].data.attributes.position.array = 30_000_000),
			(j) => (j.geometries[0].data.attributes.position.array = { length: 30_000_000 }),
			(j) => (j.geometries[0].data.index = { type: 'Uint16Array', array: 1e7 }),
			(j) => (j.geometries[0].data.morphAttributes = { position: [{ itemSize: 3, type: 'Float32Array', array: 1e7 }] }),
			(j) => (j.geometries[0].data.arrayBuffers = { a: 1e8 }),
			(j) => (j.geometries[0].data.attributes = 'x'),
			(j) => (j.images = [{ uuid: 'i', url: { data: 1e8, type: 'Float64Array', width: 1, height: 1 } }]),
			(j) => (j.images = [{ uuid: 'i', url: { data: [0, 0, 0, 0], type: 'Uint8Array', width: 16384, height: 16384 } }]),
			(j) => (j.images = [{ uuid: 'i', url: { width: 1e6, height: 1 } }]),
			(j) => (j.animations = [{ name: 'a', tracks: [{ name: 'x.position', type: 'vector', times: 1e8, values: [] }] }]),
			(j) => (j.animations = [{ name: 'a', tracks: { length: 1 } }]),
			(j) => (j.skeletons = [{ uuid: 's', bones: [], boneInverses: 1e8 }])
		];
		for (const mutate of cases) {
			const json = base();
			mutate(json);
			expect(guardObjectJson(json).ok).toBe(false);
		}
		const typed = base();
		typed.geometries[0].data.attributes.position.array = new Float32Array(typed.geometries[0].data.attributes.position.array);
		expect(guardObjectJson(typed).ok).toBe(true);
	});

	it('an instanced mesh must carry its matrices as an array covering its count', () => {
		const json = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 2).toJSON();
		json.object.instanceMatrix.array = 5_000_000;
		expect(guardObjectJson(json).ok).toBe(false);
		json.object.instanceMatrix = undefined;
		expect(guardObjectJson(json).ok).toBe(false);
	});

	it('segment counts must be plain numbers, and what they sweep is counted', () => {
		const plane = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial()).toJSON();
		plane.geometries[0].widthSegments = '3000';
		expect(guardObjectJson(plane)).toMatchObject({ ok: false, reason: 'geometry' });
		for (const bad of [-1, NaN, Infinity, null, [3]]) {
			const j = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial()).toJSON();
			j.geometries[0].heightSegments = bad;
			expect(guardObjectJson(j).ok).toBe(false);
		}
		const lathe = { geometries: [{ uuid: 'g', type: 'LatheGeometry', points: new Array(100_000).fill([1, 1]), segments: 400 }], object: { type: 'Mesh' } };
		expect(guardObjectJson(lathe).ok).toBe(false);
		const poly = { geometries: [{ uuid: 'g', type: 'PolyhedronGeometry', vertices: [], indices: new Array(300_000).fill(0), radius: 1, detail: 4 }], object: { type: 'Mesh' } };
		expect(guardObjectJson(poly).ok).toBe(false);
		const curves = Array.from({ length: 20_000 }, () => ({ type: 'LineCurve', v1: [0, 0], v2: [1, 1] }));
		const shape = { geometries: [{ uuid: 'g', type: 'ExtrudeGeometry', shapes: ['s'], options: { curveSegments: 12, steps: 100 } }], shapes: [{ uuid: 's', curves, holes: [] }], object: { type: 'Mesh' } };
		expect(guardObjectJson(shape).ok).toBe(false);
		const fine = new THREE.Mesh(new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(1, 0), new THREE.Vector2(0, 1)])), new THREE.MeshStandardMaterial()).toJSON();
		expect(guardObjectJson(fine).ok).toBe(true);
	});

	it('refuses a batched mesh (nothing here makes one)', () => {
		expect(guardObjectJson({ object: { type: 'Group', children: [{ type: 'BatchedMesh', maxInstanceCount: 1, maxVertexCount: 1, maxIndexCount: 1 }] } }).ok).toBe(false);
	});

	it('refuses things that are not object JSON at all', () => {
		for (const v of [null, undefined, 1, 'x', []]) expect(guardObjectJson(v).ok).toBe(false);
		for (const v of [null, {}, { materials: 'x' }, { materials: new Array(2000).fill({ type: 'MeshBasicMaterial' }) }])
			expect(guardMaterialSet(v).ok).toBe(false);
	});
});

describe('the reporting half', () => {
	it('parseCheckedObject parses the checked JSON and throws on a refusal', () => {
		const json = new THREE.Mesh(new THREE.BoxGeometry(), program()).toJSON();
		const object = /** @type {any} */ (parseCheckedObject(json, 'peerA', 'object'));
		expect(object.material.type).toBe('MeshStandardMaterial');
		expect(loadGuardTotals().materials).toBe(1);
		expect(() => parseCheckedObject(null, 'peerA', 'object')).toThrow();
		expect(loadGuardTotals().refused).toBe(1);
	});

	it('checkMaterialSet reports a refusal', () => {
		expect(checkMaterialSet({ materials: 'nope' }, 'peerA', 'materials')).toBe(false);
	});

	it('the loading manager lets embedded content through and nothing else', () => {
		const manager = embeddedOnlyManager('peerA', 'object');
		expect(manager.resolveURL(PNG)).toBe(PNG);
		globalThis.location = { origin: 'https://theprototype.app' };
		try {
			expect(manager.resolveURL('blob:https://theprototype.app/1')).toBe('blob:https://theprototype.app/1');
			for (const url of ['https://example.com/a.png', '/x.bin', 'x.bin', '//e.com/x', 'blob:https://example.com/1', 'blob:https://theprototype.app.example.com/1'])
				expect(manager.resolveURL(url)).toBe('data:,');
			expect(loadGuardTotals().fetches).toBe(6);
			expect(isLocalImageUrl(PNG)).toBe(true);
			expect(isLocalImageUrl('blob:https://theprototype.app/9')).toBe(true);
			for (const bad of ['https://example.com/x.png', 'data:text/html,1', '/x.png', 'blob:https://example.com/9', null]) expect(isLocalImageUrl(bad)).toBe(false);
		} finally {
			delete globalThis.location;
		}
	});
});

import { guardGltfElement, gltfJsonOf, MAX_GLTF_DATA_CHARS } from '../../src/lib/loadGuardCore.js';
import { checkGltf } from '../../src/lib/loadGuard.js';

describe('glTF', () => {
	const doc = (imageUri, bufferUri = 'data:application/octet-stream;base64,AAAA') => ({
		asset: { version: '2.0' },
		images: imageUri === undefined ? [{ bufferView: 0, mimeType: 'image/png' }] : [{ uri: imageUri }],
		buffers: [bufferUri === undefined ? { byteLength: 4 } : { byteLength: 4, uri: bufferUri }]
	});
	/** @param {any} json */
	const glb = (json) => {
		let text = JSON.stringify(json);
		while (text.length % 4) text += ' ';
		const jb = new TextEncoder().encode(text);
		const out = new ArrayBuffer(20 + jb.length);
		const v = new DataView(out);
		v.setUint32(0, 0x46546c67, true);
		v.setUint32(4, 2, true);
		v.setUint32(8, out.byteLength, true);
		v.setUint32(12, jb.length, true);
		v.setUint32(16, 0x4e4f534a, true);
		new Uint8Array(out, 20).set(jb);
		return out;
	};

	it('accepts what an exporter writes: data uris, or no uri at all (a .glb bufferView)', () => {
		expect(guardGltfElement(doc(PNG)).ok).toBe(true);
		expect(guardGltfElement(doc(undefined, undefined)).ok).toBe(true);
		expect(guardGltfElement(JSON.stringify(doc(PNG))).ok).toBe(true);
		expect(guardGltfElement(glb(doc(undefined, undefined))).ok).toBe(true);
		expect(guardGltfElement(new Uint8Array(glb(doc(PNG)))).ok).toBe(true);
		expect(guardGltfElement({ asset: { version: '2.0' } }).ok).toBe(true);
	});

	it('refuses any other image or buffer uri, in every container', () => {
		for (const bad of ['https://example.com/x.png', '/x.png', 'x.png', 'blob:https://x/1', '', 7]) {
			expect(guardGltfElement(doc(bad))).toMatchObject({ ok: false });
			expect(guardGltfElement(doc(PNG, bad))).toMatchObject({ ok: false });
			expect(guardGltfElement(JSON.stringify(doc(bad))).ok).toBe(false);
			expect(guardGltfElement(glb(doc(bad))).ok).toBe(false);
		}
	});

	it('refuses an unreadable element and malformed lists', () => {
		for (const v of [null, 42, 'not json', [], new ArrayBuffer(3), { images: 'x' }, { buffers: [null] }]) expect(guardGltfElement(v).ok).toBe(false);
		const broken = new Uint8Array(glb(doc(PNG)));
		new DataView(broken.buffer).setUint32(12, 1e6, true); // chunk longer than the file
		expect(gltfJsonOf(broken)).toBe(null);
	});

	it('refuses more embedded data than the cap', () => {
		const huge = { images: [{ uri: 'data:image/png;base64,' }], buffers: [] };
		huge.images[0].uri = { length: MAX_GLTF_DATA_CHARS + 1, startsWith: () => true };
		expect(guardGltfElement(huge).ok).toBe(false); // not a string: refused before its size matters
		const big = { buffers: [{ uri: 'data:,' + 'A'.repeat(1024) }] };
		expect(guardGltfElement(big).ok).toBe(true);
	});

	it('reads a .glb the way three does: one JSON chunk only, chunks inside the file', () => {
		const one = new Uint8Array(glb(doc(PNG)));
		// append a second JSON chunk naming an outside image: three would read THAT one
		let text = JSON.stringify(doc('https://example.com/x.png'));
		while (text.length % 4) text += ' ';
		const jb = new TextEncoder().encode(text);
		const two = new Uint8Array(one.length + 8 + jb.length);
		two.set(one);
		const v = new DataView(two.buffer);
		v.setUint32(8, two.length, true);
		v.setUint32(one.length, jb.length, true);
		v.setUint32(one.length + 4, 0x4e4f534a, true);
		two.set(jb, one.length + 8);
		expect(gltfJsonOf(two)).toBe(null);
		expect(guardGltfElement(two).ok).toBe(false);
	});

	it('caps accessors: no data view = three allocates from the count', () => {
		const base = { asset: { version: '2.0' }, bufferViews: [{ buffer: 0, byteLength: 36 }], buffers: [{ byteLength: 36 }] };
		expect(guardGltfElement({ ...base, accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }] }).ok).toBe(true);
		for (const accessors of [
			[{ componentType: 5126, count: 1e9, type: 'VEC3' }],
			[{ componentType: 5126, count: 3, type: 'VEC3', sparse: { count: 1e9 } }],
			[{ bufferView: 0, componentType: 5126, count: 1e6, type: 'VEC3' }],
			[{ bufferView: 7, componentType: 5126, count: 3, type: 'VEC3' }],
			[{ componentType: 5126, count: '3', type: 'VEC3' }],
			[{ componentType: 5126, count: 3, type: 'VEC9' }],
			{ length: 1 }
		])
			expect(guardGltfElement({ ...base, accessors }).ok).toBe(false);
	});

	it('uris: false checks sizes and lets a uri through (its loader refuses the fetch)', () => {
		expect(guardGltfElement(doc('tex.png'), { uris: false }).ok).toBe(true);
		expect(guardGltfElement({ accessors: [{ count: 1e9, type: 'SCALAR' }] }, { uris: false }).ok).toBe(false);
	});

	it('checkGltf counts a refusal', () => {
		resetLoadGuard();
		expect(checkGltf(doc('https://example.com/x.png'), 'peerA', 'object')).toBe(false);
		expect(loadGuardTotals().refused).toBe(1);
	});
});
