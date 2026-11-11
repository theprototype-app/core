// @ts-nocheck - deliberately malformed inputs
import { describe, it, expect, vi } from 'vitest';
import { localThumb } from '../../src/lib/loadGuardCore.js';
import { boundGeometryParams, boundCreateArgs } from '../../src/lib/geometryParams.js';

describe('stored thumbnails', () => {
	it('keeps embedded images and this page blobs, drops other addresses', () => {
		expect(localThumb('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
		expect(localThumb('https://example.com/x.png')).toBe(null);
		expect(localThumb('//example.com/x.png')).toBe(null);
		expect(localThumb('data:text/html,hi')).toBe(null);
		expect(localThumb(null)).toBe(null);
		expect(localThumb({})).toBe(null);
		expect(localThumb('blob:https://example.com/abc')).toBe(null);
	});
});

describe('geometry params from messages', () => {
	it('keeps counts within a few times their slider range', () => {
		const out = boundGeometryParams('Sphere', { radius: 1, widthSegments: 1e9, heightSegments: -5 });
		expect(out.widthSegments).toBe(256);
		expect(out.heightSegments).toBe(2);
		expect(out.radius).toBe(1);
	});
	it('replaces non-finite numbers and bounds sizes', () => {
		const out = boundGeometryParams('Box', { width: Infinity, height: 1e12, widthSegments: 3 });
		expect(out.width).toBe(1);
		expect(out.height).toBe(10_000);
		expect(out.widthSegments).toBe(3);
	});
	it('leaves ordinary params unchanged', () => {
		const p = { radius: 2, tube: 0.4, radialSegments: 16, tubularSegments: 100 };
		expect(boundGeometryParams('Torus', p)).toEqual(p);
	});
	it('bounds create command numbers by the constructor order', () => {
		expect(boundCreateArgs('Sphere', [1, 1e9, 1e9, undefined])).toEqual([1, 256, 128, undefined]);
		expect(boundCreateArgs('Icosahedron', [1, 1e6, undefined, undefined])).toEqual([1, 12, undefined, undefined]);
		expect(boundCreateArgs('Box', [1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
		expect(boundCreateArgs('Wedge', [1e9, NaN, 2, 3])).toEqual([256, undefined, 2, 3]);
	});
});

describe('pack reference addresses', () => {
	it('allows the packs CDN at any ref and the sample upstream, refuses the rest', async () => {
		vi.resetModules();
		const { packAddress } = await import('../../src/lib/packRefs.js');
		const { PACKS_BASE } = await import('../../src/lib/packs.js');
		const base = String(PACKS_BASE).replace(/\/+$/, '');
		expect(packAddress('kenney-nature/tree/tree.glb')).toBe(base + '/kenney-nature/tree/tree.glb');
		const repo = base.slice(0, base.indexOf('@') + 1);
		if (repo) expect(packAddress(repo + 'main/a/b.glb')).toBe(repo + 'main/a/b.glb');
		const k = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Duck/glTF-Binary/Duck.glb';
		expect(packAddress(k)).toBe(k);
		expect(packAddress('https://example.com/x.glb')).toBe('data:,');
		if (typeof location !== 'undefined' && location.origin && location.origin !== 'null')
			expect(packAddress(location.origin + '/library/default/Duck/glTF-Binary/Duck.glb')).toBe(location.origin + '/library/default/Duck/glTF-Binary/Duck.glb');
		expect(packAddress('https://raw.githubusercontent.com/someone/else/main/x.glb')).toBe('data:,');
		expect(packAddress('../../someone/else@main/x.glb')).toBe('data:,');
		expect(packAddress('a/%2e%2e/%2e%2e/x.glb')).toBe('data:,');
		expect(packAddress('//example.com/x.glb')).toBe('data:,');
		expect(packAddress('javascript:alert(1)')).toBe('data:,');
		expect(packAddress(42)).toBe('data:,');
		if (repo) expect(packAddress(repo + 'main/../../../elsewhere/x.glb')).toBe('data:,');
	});
});

import { guardGltfElement, isSafeCssValue } from '../../src/lib/loadGuardCore.js';
import { fbxWithinLimits, MAX_FBX_ARRAY_BYTES } from '../../src/lib/fbxGuard.js';
import { zlibSync } from 'fflate';

/** A minimal binary FBX: one node 'A' with one compressed float array of `length` elements. */
function fbx(length, version = 7400, payload = new Uint8Array(8)) {
	const wide = version >= 7500;
	const word = wide ? 8 : 4;
	const stored = payload.length;
	const propLen = 1 + 12 + stored;
	const nodeLen = word * 3 + 1 + 1 + propLen;
	const nullLen = word * 3 + 1;
	const buf = new ArrayBuffer(27 + nodeLen + nullLen + 176); // + three's footer
	const u8 = new Uint8Array(buf);
	const dv = new DataView(buf);
	const magic = 'Kaydara FBX Binary  ';
	for (let i = 0; i < magic.length; i++) u8[i] = magic.charCodeAt(i);
	u8[21] = 0x1a;
	dv.setUint32(23, version, true);
	const put = (at, v) => (wide ? dv.setBigUint64(at, BigInt(v), true) : dv.setUint32(at, v, true));
	let at = 27;
	put(at, 27 + nodeLen);
	put(at + word, 1);
	put(at + word * 2, propLen);
	u8[at + word * 3] = 1;
	u8[at + word * 3 + 1] = 65;
	at += word * 3 + 2;
	u8[at] = 'f'.charCodeAt(0);
	dv.setUint32(at + 1, length, true);
	dv.setUint32(at + 5, 1, true);
	dv.setUint32(at + 9, stored, true);
	u8.set(payload, at + 13);
	return buf;
}

describe('FBX array sizes', () => {
	it('passes ordinary arrays and text files, refuses inflate claims over the limit', () => {
		expect(fbxWithinLimits(fbx(2, 7400, zlibSync(new Uint8Array(8))))).toBe(true);
		expect(fbxWithinLimits(fbx(2, 7500, zlibSync(new Uint8Array(8))))).toBe(true);
		expect(fbxWithinLimits(fbx(MAX_FBX_ARRAY_BYTES / 4 + 1))).toBe(false);
		expect(fbxWithinLimits(fbx(0xfffffff0, 7500))).toBe(false);
		expect(fbxWithinLimits(new TextEncoder().encode('; FBX 7.4.0 project file\nFBXHeaderExtension: {\n}'))).toBe(true);
		// a real zlib stream that inflates past what its array declares (a 'bomb')
		const bomb = zlibSync(new Uint8Array(4 * 1024 * 1024));
		expect(fbxWithinLimits(fbx(16, 7400, bomb))).toBe(false);
		const honest = zlibSync(new Uint8Array(64));
		expect(fbxWithinLimits(fbx(16, 7400, honest))).toBe(true);
		const broken = new Uint8Array(fbx(10));
		new DataView(broken.buffer).setUint32(27, 5, true); // end offset before its own start
		expect(fbxWithinLimits(broken)).toBe(false);
	});
});

describe('glTF accessor types', () => {
	it('refuses a type name that is not one of the seven', () => {
		const doc = (type) => ({ asset: { version: '2.0' }, accessors: [{ type, componentType: 5126, count: 1 }, { type: 'VEC4', componentType: 5126, count: 100_000_000 }] });
		expect(guardGltfElement(doc('constructor')).ok).toBe(false);
		expect(guardGltfElement(doc('__proto__')).ok).toBe(false);
		expect(guardGltfElement(doc('toString')).ok).toBe(false);
		expect(guardGltfElement({ asset: { version: '2.0' }, accessors: [{ type: 'VEC3', componentType: 5126, count: 3 }] }).ok).toBe(true);
	});
	it('counts what a compressed view decodes to', () => {
		const doc = { asset: { version: '2.0' }, buffers: [{ byteLength: 16 }], bufferViews: [{ buffer: 0, byteLength: 16, extensions: { EXT_meshopt_compression: { buffer: 0, byteLength: 16, count: 100_000_000, byteStride: 16 } } }] };
		expect(guardGltfElement(doc).ok).toBe(false);
		doc.bufferViews[0].extensions.EXT_meshopt_compression.count = 100;
		expect(guardGltfElement(doc).ok).toBe(true);
	});
});

describe('style values', () => {
	it('keeps colours, fonts and gradients, drops anything that loads or escapes', () => {
		for (const v of ['#ff0000', 'rgb(1 2 3 / 0.5)', 'accent', '"Inter", sans-serif', 'linear-gradient(90deg, red, blue)', 12]) expect(isSafeCssValue(v)).toBe(true);
		for (const v of ['url(https://x.example/p)', 'URL (x)', 'image-set("a.png" 1x)', 'a;background:red', 'u\\72l(x)', 'ur/**/l(x)', '{', '@import x', Infinity, {}]) expect(isSafeCssValue(v)).toBe(false);
	});
});

import { guardObjectJson, MAX_SHADOW_MAP } from '../../src/lib/loadGuardCore.js';

describe('object JSON sizes', () => {
	it('weighs spline points in a shape geometry', () => {
		const points = Array.from({ length: 20_000 }, (_, i) => [i, i % 7]);
		const json = {
			metadata: { type: 'Object' },
			shapes: [{ uuid: 's', curves: [{ type: 'SplineCurve', points }], holes: [] }],
			geometries: [{ uuid: 'g', type: 'ShapeGeometry', shapes: ['s'], curveSegments: 5000 }],
			materials: [{ uuid: 'm', type: 'MeshStandardMaterial' }],
			object: { uuid: 'o', type: 'Mesh', geometry: 'g', material: 'm' }
		};
		expect(guardObjectJson(json).ok).toBe(false);
		json.shapes[0].curves[0].points = points.slice(0, 20);
		json.geometries[0].curveSegments = 12;
		expect(guardObjectJson(json).ok).toBe(true);
	});
	it('refuses a light asking for a huge shadow map', () => {
		const json = (size) => ({ metadata: { type: 'Object' }, object: { uuid: 'l', type: 'DirectionalLight', shadow: { mapSize: [size, size] } } });
		expect(guardObjectJson(json(2048)).ok).toBe(true);
		expect(guardObjectJson(json(MAX_SHADOW_MAP * 2)).ok).toBe(false);
		expect(guardObjectJson(json('1e9')).ok).toBe(false);
	});
});

import { isImageDataUrl, stlWithinLimits } from '../../src/lib/loadGuardCore.js';
import { cleanFlowNode, cleanFlowEdge } from '../../src/lib/flowClean.js';
import { normalizeScenePost, MAX_POST_EFFECTS } from '../../src/lib/scenePost.js';

describe('round 3 rules', () => {
	it('checks the whole embedded image value', () => {
		expect(isImageDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
		expect(isImageDataUrl('data:image/png,x),url(https://elsewhere.example/p')).toBe(false);
		expect(isImageDataUrl('data:image/png;base64,A"),url("https://elsewhere.example/x')).toBe(false);
		expect(isImageDataUrl(' data:image/png;base64,AAAA')).toBe(false);
	});
	it('drops raw style fields from flow nodes and edges', () => {
		const node = { id: 'n', type: 'note', position: { x: 0, y: 0 }, data: {}, class: 'w-[150px]', style: 'background-image:url(https://elsewhere.example/x)' };
		const clean = cleanFlowNode(node);
		expect(clean.style).toBeUndefined();
		expect(clean.class).toBe('w-[150px]');
		const plain = { id: 'm', type: 'note', position: { x: 0, y: 0 }, data: {} };
		expect(cleanFlowNode(plain)).toBe(plain);
		const sized = { ...plain, width: 200, height: 120 };
		expect(cleanFlowNode(sized)).toBe(sized);
		const boxed = cleanFlowNode({ ...plain, width: '1px;background-image:url(https://elsewhere.example/x);x:', initialHeight: '2px;', height: 90 });
		expect(boxed.width).toBeUndefined();
		expect(boxed.initialHeight).toBeUndefined();
		expect(boxed.height).toBe(90);
		expect(cleanFlowNode({ ...plain, width: Infinity }).width).toBeUndefined();
		const edge = cleanFlowEdge({ id: 'e', source: 'a', target: 'b', style: 'x', labelStyle: 'y', markerEnd: { type: 'arrow', color: 'url(https://elsewhere.example/x)' } });
		expect(edge.style).toBeUndefined();
		expect(edge.labelStyle).toBeUndefined();
		expect(edge.markerEnd).toEqual({ type: 'arrow' });
		expect(cleanFlowEdge({ id: 'e', source: 'a', target: 'b', markerEnd: { type: 'arrowclosed', color: '#888' } }).markerEnd.color).toBe('#888');
	});
	it('refuses an STL whose header claims more triangles than it holds', () => {
		const binary = (faces, size) => {
			const b = new Uint8Array(size);
			new DataView(b.buffer).setUint32(80, faces, true);
			return b;
		};
		expect(stlWithinLimits(binary(2, 84 + 100))).toBe(true);
		expect(stlWithinLimits(binary(60_000_000, 84))).toBe(false);
		expect(stlWithinLimits(new TextEncoder().encode('solid x\n' + ' '.repeat(100) + '\nendsolid x'))).toBe(true);
	});
	it('caps a look at a handful of effects', () => {
		const effects = Array.from({ length: 2000 }, (_, i) => ({ kind: i % 2 ? 'bloom' : 'ao' }));
		expect(normalizeScenePost({ enabled: true, effects }).effects.length).toBe(MAX_POST_EFFECTS);
	});
});
