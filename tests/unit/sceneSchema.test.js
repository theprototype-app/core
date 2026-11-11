// @ts-nocheck - hand-built loader JSON fixtures, deliberately out of schema
// 101 F2: the object / material schema (src/lib/sceneSchema.js).
//  1. REAL CONTENT round-trips with nothing dropped: every template, every test fixture (the 1.65
//     capture: every Add-menu object, every material type, maps, slots, the handshake sync and a
//     materials message) and, when SCENES_DIR names a scenes checkout, every scene in it.
//  2. OUT-OF-SCHEMA payloads are cleaned, every change is a `dropped` row, and three still parses
//     what is left.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'fflate';
import { validateObjectJson, validateMaterialSet, MAX_DEPTH, MAX_IMAGE_CHARS, isPlainJson } from '../../src/lib/sceneSchema.js';

const ROOT = path.resolve(__dirname, '../..');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** every .tpscene / .json under a dir @param {string} dir */
function contentFiles(dir) {
	if (!fs.existsSync(dir)) return [];
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...contentFiles(p));
		else if (/\.tpscene$/.test(e.name) || (/\.json$/.test(e.name) && !/^(inventory|package|manifest|index|known)/.test(e.name))) out.push(p);
	}
	return out;
}

/** every ObjectLoader element and materials payload inside one JSON document @param {any} doc */
function findPayloads(doc, out = { elements: [], sets: [] }) {
	if (!doc || typeof doc !== 'object') return out;
	if (!Array.isArray(doc) && doc.metadata?.type === 'Object' && doc.object) out.elements.push(doc);
	else if (!Array.isArray(doc) && Array.isArray(doc.materials) && !doc.metadata && !doc.asset && (doc.textures || doc.images)) out.sets.push(doc);
	else for (const v of Array.isArray(doc) ? doc : Object.values(doc)) findPayloads(v, out);
	return out;
}

/** @param {string} file */
function payloadsOf(file) {
	const bytes = new Uint8Array(fs.readFileSync(file));
	const out = { elements: [], sets: [] };
	if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
		for (const [name, data] of Object.entries(unzipSync(bytes)))
			if (name.endsWith('.json') && !name.startsWith('assets/')) findPayloads(JSON.parse(strFromU8(data)), out);
	} else findPayloads(JSON.parse(strFromU8(bytes)), out);
	return out;
}

const SOURCES = [path.join(ROOT, 'static/templates'), path.join(ROOT, 'tests/fixtures'), ...(process.env.SCENES_DIR ? [path.resolve(process.env.SCENES_DIR)] : [])];

describe('real content: nothing is dropped', () => {
	const files = SOURCES.flatMap(contentFiles);
	it('finds the content (premise)', () => {
		expect(files.some((f) => f.includes('schema-1.65'))).toBe(true);
		expect(files.length).toBeGreaterThan(5);
	});
	for (const file of files) {
		it(path.relative(ROOT, file), () => {
			const { elements, sets } = payloadsOf(file);
			for (const el of elements) {
				const before = JSON.stringify(el);
				const r = validateObjectJson(el);
				expect(r.ok).toBe(true);
				expect(r.dropped).toEqual([]);
				expect(JSON.stringify(el)).toBe(before); // byte-identical: the schema changed nothing
			}
			for (const set of sets) {
				const before = JSON.stringify(set);
				const r = validateMaterialSet(set);
				expect(r.dropped).toEqual([]);
				expect(JSON.stringify(set)).toBe(before);
			}
		});
	}
	it('the 1.65 capture covers every Add-menu kind and every switchable material type', () => {
		const { elements, sets } = payloadsOf(path.join(ROOT, 'tests/fixtures/schema-1.65/capture.tpscene'));
		const mats = new Set(elements.flatMap((e) => (e.materials ?? []).map((m) => m.type)));
		for (const t of ['MeshBasicMaterial', 'MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshPhongMaterial', 'MeshLambertMaterial', 'MeshToonMaterial', 'MeshMatcapMaterial', 'MeshNormalMaterial', 'MeshDepthMaterial', 'ShadowMaterial'])
			expect(mats.has(t)).toBe(true);
		expect(elements.length).toBeGreaterThanOrEqual(40);
		expect(sets.length).toBe(0);
	});
});

/** a minimal valid element around one mesh @param {any} [over] */
function mesh(over = {}) {
	return {
		metadata: { version: 4.7, type: 'Object', generator: 'Object3D.toJSON' },
		geometries: [{ uuid: 'g1', type: 'BoxGeometry', width: 1, height: 1, depth: 1 }],
		materials: [{ uuid: 'm1', type: 'MeshStandardMaterial', color: 0x336699, roughness: 0.5 }],
		object: { uuid: 'o1', type: 'Mesh', name: 'Box', layers: 1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], up: [0, 1, 0], geometry: 'g1', material: 'm1' },
		...over
	};
}
const reasons = (r) => r.dropped.map((d) => d.reason + ' ' + d.path);
const parses = (json) => new THREE.ObjectLoader().parse(json);

describe('out of schema: cleaned and counted', () => {
	it('a valid element passes untouched', () => {
		const el = mesh();
		const before = JSON.stringify(el);
		const r = validateObjectJson(el);
		expect(r).toMatchObject({ ok: true, dropped: [] });
		expect(JSON.stringify(el)).toBe(before);
	});

	it('an unknown material type becomes the standard fallback, counted', () => {
		const el = mesh({ materials: [{ uuid: 'm1', type: 'FancyMaterial', color: 0xff0000, name: 'x' }] });
		const r = validateObjectJson(el);
		expect(r.ok).toBe(true);
		expect(reasons(r)).toContain('type materials[0]');
		expect(el.materials[0]).toMatchObject({ type: 'MeshStandardMaterial', uuid: 'm1', color: 0xff0000 });
		expect(parses(el).material.type).toBe('MeshStandardMaterial');
	});

	it('a standard type carrying program fields takes the fallback', () => {
		const el = mesh({ materials: [{ uuid: 'm1', type: 'MeshStandardMaterial', color: 1, fragmentShader: 'void main(){}' }] });
		const r = validateObjectJson(el);
		expect(reasons(r)).toContain('program materials[0]');
		expect('fragmentShader' in el.materials[0]).toBe(false);
	});

	it('unknown fields are stripped at every level', () => {
		const el = mesh({ extra: 1 });
		el.object.onBeforeRender = 'x';
		el.materials[0].shaderHook = 'y';
		el.geometries[0].weird = { a: 1 };
		const r = validateObjectJson(el);
		expect(reasons(r)).toEqual(expect.arrayContaining(['field extra', 'field object.onBeforeRender', 'field materials[0].shaderHook', 'field geometries[0].weird']));
		expect(el.extra).toBeUndefined();
		expect(el.object.onBeforeRender).toBeUndefined();
		parses(el);
	});

	it('a field whose value breaks its rule is stripped (three falls back to its default)', () => {
		const el = mesh();
		el.object.matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, null, 0, 0, 1];
		el.object.visible = 'yes';
		el.materials[0].roughness = 'rough';
		el.materials[0].side = 7;
		const r = validateObjectJson(el);
		expect(reasons(r)).toEqual(expect.arrayContaining(['value object.matrix', 'value object.visible', 'value materials[0].roughness', 'value materials[0].side']));
		const o = parses(el);
		expect(o.matrix.elements.every(Number.isFinite)).toBe(true);
	});

	it('an unknown object type becomes an Object3D and keeps its children', () => {
		const el = mesh();
		el.object = { uuid: 's', type: 'Scene', background: 'tex', children: [el.object] };
		const r = validateObjectJson(el);
		expect(reasons(r)).toEqual(expect.arrayContaining(['type object', 'field object.background']));
		const o = parses(el);
		expect(o.type).toBe('Object3D');
		expect(o.children[0].type).toBe('Mesh');
	});

	it('an unknown geometry type becomes an empty buffer geometry', () => {
		const el = mesh({ geometries: [{ uuid: 'g1', type: 'MysteryGeometry', n: 1 }] });
		const r = validateObjectJson(el);
		expect(reasons(r)).toContain('type geometries[0]');
		expect(parses(el).geometry.type).toBe('BufferGeometry');
	});

	it('a buffer attribute with an unknown array type or non-numbers is dropped', () => {
		const el = mesh({
			geometries: [{ uuid: 'g1', type: 'BufferGeometry', data: { attributes: { position: { itemSize: 3, type: 'Float32Array', array: [0, 0, 0, 1, 0, 0, 0, 1, 0] }, bad: { itemSize: 3, type: 'Function', array: [1, 2, 3] }, strs: { itemSize: 1, type: 'Float32Array', array: ['a'] } }, extra: 1 } }]
		});
		const r = validateObjectJson(el);
		expect(reasons(r)).toEqual(expect.arrayContaining(['value geometries[0].data.attributes.bad', 'value geometries[0].data.attributes.strs', 'field geometries[0].data.extra']));
		expect(Object.keys(parses(el).geometry.attributes)).toEqual(['position']);
	});

	it('an image over the cap is dropped with its texture; an address that is not embedded is counted', () => {
		const big = 'data:image/png;base64,' + 'A'.repeat(MAX_IMAGE_CHARS);
		const el = mesh({
			images: [{ uuid: 'i1', url: big }, { uuid: 'i2', url: 'https://example.com/a.png' }, { uuid: 'i3', url: PNG, extra: 1 }],
			textures: [{ uuid: 't1', image: 'i1' }, { uuid: 't2', image: 'i2' }, { uuid: 't3', image: 'i3' }]
		});
		const r = validateObjectJson(el);
		expect(reasons(r)).toEqual(expect.arrayContaining(['image size images[0]', 'image images[1]', 'field images[2].extra']));
		expect(el.images.map((i) => i.uuid)).toEqual(['i3']);
		expect(el.textures.map((t) => t.uuid)).toEqual(['t3']);
		expect(r.images).toBe(1); // loadGuardCore's count: the not-embedded one
	});

	it('userData: a known key of the wrong kind, a prototype key, and non-JSON are dropped; unknown plain JSON stays', () => {
		const el = mesh();
		el.object.userData = JSON.parse('{"physics": "dynamic", "__proto__": {"polluted": true}, "mine": {"a": [1, 2]}, "shadow": false}');
		const r = validateObjectJson(el);
		expect(reasons(r)).toEqual(expect.arrayContaining(['userData kind object.userData.physics', 'userData object.userData.__proto__']));
		expect(el.object.userData).toEqual({ mine: { a: [1, 2] }, shadow: false });
		expect({}.polluted).toBeUndefined();
		expect(parses(el).userData.mine.a).toEqual([1, 2]);
	});

	it('userData over the per-key cap is dropped', () => {
		const el = mesh();
		el.object.userData = { huge: 'x'.repeat(3 * 1024 * 1024), small: 1 };
		const r = validateObjectJson(el);
		expect(reasons(r)).toContain('userData size object.userData.huge');
		expect(el.object.userData).toEqual({ small: 1 });
	});

	it('a tree deeper than MAX_DEPTH is cut at the cap', () => {
		const el = mesh();
		let node = el.object;
		for (let i = 0; i < MAX_DEPTH + 5; i++) {
			const child = { uuid: 'c' + i, type: 'Group' };
			node.children = [child];
			node = child;
		}
		const r = validateObjectJson(el);
		expect(r.ok).toBe(true);
		expect(r.dropped.some((d) => d.reason === 'depth')).toBe(true);
	});

	it('a light keeps its checked shadow block; a bad shadow camera goes', () => {
		const el = mesh();
		el.object = { uuid: 'l', type: 'DirectionalLight', color: 0xffffff, intensity: 1, target: 't', shadow: { bias: 0, mapSize: [1024, 1024], camera: { uuid: 'c', type: 'Mesh' }, extra: 1 } };
		const r = validateObjectJson(el);
		expect(reasons(r)).toEqual(expect.arrayContaining(['type object.shadow.camera', 'field object.shadow.extra']));
		expect(parses(el).shadow.mapSize.x).toBe(1024);
	});

	it('the size rules still refuse whole objects (loadGuardCore), before anything is edited', () => {
		const el = mesh({ geometries: [{ uuid: 'g1', type: 'BoxGeometry', widthSegments: 1e6, heightSegments: 1e6, depthSegments: 1 }] });
		el.object.extra = 1;
		const r = validateObjectJson(el);
		expect(r.ok).toBe(false);
		expect(r.dropped[0].path).toBe('');
		expect(el.object.extra).toBe(1); // refused, not walked
		expect(validateObjectJson(null).ok).toBe(false);
		expect(validateObjectJson([1]).ok).toBe(false);
	});

	it('a materials payload: unknown keys, bad groups and a program material are cleaned', () => {
		const set = {
			materials: [{ uuid: 'a', type: 'RawShaderMaterial', vertexShader: 'x' }, { uuid: 'b', type: 'MeshBasicMaterial', color: 1, odd: 2 }],
			textures: [],
			images: [],
			groups: [{ start: 0, count: 'all', materialIndex: 0 }],
			mapSources: ['hash', { x: 1 }],
			extra: true
		};
		const r = validateMaterialSet(set);
		expect(reasons(r)).toEqual(expect.arrayContaining(['field extra', 'type materials[0]', 'field materials[1].odd', 'value groups', 'value mapSources[1]']));
		expect(set.materials[0].type).toBe('MeshStandardMaterial');
		expect(set.mapSources).toEqual(['hash', null]);
		expect(validateMaterialSet({ materials: 'x' }).ok).toBe(false);
	});

	it('isPlainJson refuses prototype keys, non-finite numbers and deep nesting', () => {
		expect(isPlainJson(JSON.parse('{"a":{"constructor":1}}'), 0)).toBe(false);
		expect(isPlainJson({ a: Infinity }, 0)).toBe(false);
		let deep = 1;
		for (let i = 0; i < 100; i++) deep = [deep];
		expect(isPlainJson(deep, 0)).toBe(false);
		expect(isPlainJson({ a: [1, 'b', null, { c: true }] }, 0)).toBe(true);
	});

	it('a result lists at most 200 rows and counts the rest', () => {
		const el = mesh();
		for (let i = 0; i < 300; i++) el.object['f' + i] = i;
		const r = validateObjectJson(el);
		expect(r.dropped.length).toBe(201);
		expect(r.dropped[200]).toEqual({ path: '…', reason: '100 more' });
	});
});

describe('wireValidate rows use the schema verdicts', async () => {
	const { validateWireMessage } = await import('../../src/lib/wireValidate.js');
	const { objectJsonVerdict, materialSetVerdict } = await import('../../src/lib/sceneSchema.js');
	it('object: the ObjectLoader form needs a sane element; the uuids form is left to its applier check', () => {
		expect(validateWireMessage({ type: 'object', element: mesh() })).toBe(true);
		expect(validateWireMessage({ type: 'object', element: 'junk' })).toBe(false);
		expect(validateWireMessage({ type: 'object', element: { object: null } })).toBe(false);
		expect(validateWireMessage({ type: 'object', element: mesh({ materials: { length: 3 } }) })).toBe(false);
		expect(validateWireMessage({ type: 'object', element: mesh({ geometries: [{ uuid: 'g', type: 'BoxGeometry', widthSegments: 1e6, heightSegments: 1e6 }] }) })).toBe(false);
		expect(validateWireMessage({ type: 'object', element: {}, uuids: ['a'] })).toBe(true);
	});
	it('objectParameters materials: refused unless it is a slot list', () => {
		const ok = { materials: [{ uuid: 'a', type: 'MeshBasicMaterial' }], textures: [], images: [] };
		expect(validateWireMessage({ type: 'objectParameters', parameter: 'materials', uuid: 'u', payload: ok })).toBe(true);
		expect(validateWireMessage({ type: 'objectParameters', parameter: 'materials', uuid: 'u', payload: 'junk' })).toBe(false);
		expect(validateWireMessage({ type: 'objectParameters', parameter: 'materials', uuid: 'u', payload: { materials: [] } })).toBe(false);
		expect(validateWireMessage({ type: 'objectParameters', parameter: 'materials', uuid: 'u', payload: { materials: [1] } })).toBe(false);
		expect(validateWireMessage({ type: 'objectParameters', parameter: 'materials', payload: ok })).toBe(false);
	});
	it('the verdicts edit nothing', () => {
		const el = mesh({ extra: 1 });
		const before = JSON.stringify(el);
		expect(objectJsonVerdict(el)).toBe(true);
		const set = { materials: [{ uuid: 'a', type: 'RawShaderMaterial', vertexShader: 'x' }], odd: 1 };
		const setBefore = JSON.stringify(set);
		expect(materialSetVerdict(set)).toBe(true);
		expect(JSON.stringify(el)).toBe(before);
		expect(JSON.stringify(set)).toBe(setBefore);
	});
});
