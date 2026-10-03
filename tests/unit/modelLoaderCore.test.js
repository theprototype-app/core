// 34 R7 — the RULES of api.loadModel (src/lib/modelLoaderCore.js), pure: the options' one
// boundary, where a packaged path / a URL / a P1 level file resolves, the KTX2 sniff that
// decides whether the transcoder is fetched, and the pack-row key of a pack item URL.
import { describe, it, expect } from 'vitest';
import {
	normalizeModelOptions,
	resolveModelUrl,
	levelFileUrl,
	gltfUsesExtension,
	packRowKeyOf,
	COLLIDER_KINDS
} from '../../src/lib/modelLoaderCore.js';

/** a minimal GLB: header + one JSON chunk (+ an empty BIN chunk) @param {object} json */
function glb(json) {
	const text = new TextEncoder().encode(JSON.stringify(json));
	const pad = (4 - (text.length % 4)) % 4;
	const jsonLen = text.length + pad;
	const total = 12 + 8 + jsonLen + 8;
	const buf = new ArrayBuffer(total);
	const view = new DataView(buf);
	view.setUint32(0, 0x46546c67, true);
	view.setUint32(4, 2, true);
	view.setUint32(8, total, true);
	view.setUint32(12, jsonLen, true);
	view.setUint32(16, 0x4e4f534a, true);
	const u8 = new Uint8Array(buf);
	u8.set(text, 20);
	for (let i = 0; i < pad; i++) u8[20 + text.length + i] = 0x20;
	view.setUint32(20 + jsonLen, 0, true);
	view.setUint32(24 + jsonLen, 0x004e4942, true);
	return buf;
}

describe('normalizeModelOptions', () => {
	it('defaults: automatic LOD, shadows as the file says, no collider, shared materials', () => {
		expect(normalizeModelOptions()).toEqual({ lod: 'auto', castShadow: null, receiveShadow: null, collider: null, ownMaterials: false });
		expect(normalizeModelOptions(null)).toEqual(normalizeModelOptions({}));
	});
	it('lod false / off / none means no levels at all', () => {
		for (const v of [false, 'off', 'none']) expect(normalizeModelOptions({ lod: v }).lod).toBe(false);
	});
	it('lod options keep only finite lists and a non-negative minTriangles', () => {
		expect(normalizeModelOptions({ lod: { ratios: [0.5, 0.2], distances: [6, 18], minTriangles: 500 } }).lod).toEqual({ ratios: [0.5, 0.2], distances: [6, 18], minTriangles: 500 });
		expect(normalizeModelOptions({ lod: { ratios: [0.5, NaN], distances: 'far', minTriangles: -3 } }).lod).toEqual({});
	});
	it('lod files (contract P1) keep a file and a ratio strictly inside (0, 1); none left = auto', () => {
		expect(normalizeModelOptions({ lod: [{ file: ' a.lod1.glb ', ratio: 0.5 }, { file: 'b.glb', ratio: 3 }, { ratio: 0.2 }] }).lod).toEqual([{ file: 'a.lod1.glb', ratio: 0.5 }, { file: 'b.glb' }]);
		expect(normalizeModelOptions({ lod: [{ nope: 1 }] }).lod).toBe('auto');
	});
	it('shadows are booleans or nothing; collider only a hint kind; ownMaterials only true', () => {
		const o = normalizeModelOptions({ castShadow: 'yes', receiveShadow: true, collider: 'custom', ownMaterials: 1 });
		expect(o.castShadow).toBe(null);
		expect(o.receiveShadow).toBe(true);
		expect(o.collider).toBe(null);
		expect(o.ownMaterials).toBe(false);
		for (const k of COLLIDER_KINDS) expect(normalizeModelOptions({ collider: k }).collider).toBe(k);
	});
});

describe('resolveModelUrl', () => {
	const assets = { 'assets/enemy.glb': 'blob:https://x/1', 'assets/enemy.lod1.glb': 'blob:https://x/2' };
	it('a packaged path resolves to its blob URL (with or without ./)', () => {
		expect(resolveModelUrl('assets/enemy.glb', assets)).toBe('blob:https://x/1');
		expect(resolveModelUrl('./assets/enemy.glb', assets)).toBe('blob:https://x/1');
	});
	it('URLs pass through; a relative path the module does not have is null (never the page)', () => {
		expect(resolveModelUrl('https://cdn/x.glb', assets)).toBe('https://cdn/x.glb');
		expect(resolveModelUrl('blob:https://y/9', null)).toBe('blob:https://y/9');
		expect(resolveModelUrl('/library/x.glb', null)).toBe('/library/x.glb');
		expect(resolveModelUrl('assets/missing.glb', assets)).toBe(null);
		expect(resolveModelUrl('assets/enemy.glb', null)).toBe(null);
		expect(resolveModelUrl('', assets)).toBe(null);
		expect(resolveModelUrl(/** @type {any} */ (42), assets)).toBe(null);
	});
});

describe('levelFileUrl', () => {
	const assets = { 'assets/tree.glb': 'blob:https://x/1', 'assets/tree.lod1.glb': 'blob:https://x/2' };
	it('a packaged model finds its level beside it in the package', () => {
		expect(levelFileUrl('assets/tree.glb', 'blob:https://x/1', 'tree.lod1.glb', assets)).toBe('blob:https://x/2');
		expect(levelFileUrl('assets/tree.glb', 'blob:https://x/1', 'tree.lod2.glb', assets)).toBe(null);
	});
	it('a URL model finds its level beside the URL; absolute files pass through', () => {
		expect(levelFileUrl('https://cdn/p/Tree/glTF-Binary/tree.glb', 'https://cdn/p/Tree/glTF-Binary/tree.glb', 'tree.lod1.glb', null)).toBe('https://cdn/p/Tree/glTF-Binary/tree.lod1.glb');
		expect(levelFileUrl('x', 'https://cdn/x.glb', 'https://other/l.glb', null)).toBe('https://other/l.glb');
	});
	it('a bare blob has no folder to look in', () => {
		expect(levelFileUrl('blob:https://y/9', 'blob:https://y/9', 'l.glb', null)).toBe(null);
	});
});

describe('gltfUsesExtension', () => {
	it('reads extensionsUsed / extensionsRequired from a GLB JSON chunk', () => {
		expect(gltfUsesExtension(glb({ asset: { version: '2.0' }, extensionsUsed: ['KHR_texture_basisu'] }), 'KHR_texture_basisu')).toBe(true);
		expect(gltfUsesExtension(glb({ asset: { version: '2.0' }, extensionsRequired: ['KHR_texture_basisu'] }), 'KHR_texture_basisu')).toBe(true);
		expect(gltfUsesExtension(glb({ asset: { version: '2.0' }, extensionsUsed: ['EXT_meshopt_compression'] }), 'KHR_texture_basisu')).toBe(false);
	});
	it('reads a .gltf JSON and a Uint8Array view too', () => {
		const text = new TextEncoder().encode(JSON.stringify({ extensionsUsed: ['KHR_texture_basisu'] }));
		expect(gltfUsesExtension(text, 'KHR_texture_basisu')).toBe(true);
		const padded = new Uint8Array(glb({ extensionsUsed: ['KHR_texture_basisu'] }).byteLength + 8);
		padded.set(new Uint8Array(glb({ extensionsUsed: ['KHR_texture_basisu'] })), 8);
		expect(gltfUsesExtension(padded.subarray(8), 'KHR_texture_basisu')).toBe(true);
	});
	it('anything unexpected is false, never a throw', () => {
		expect(gltfUsesExtension(new ArrayBuffer(4), 'KHR_texture_basisu')).toBe(false);
		expect(gltfUsesExtension(new TextEncoder().encode('{nope'), 'KHR_texture_basisu')).toBe(false);
	});
});

describe('packRowKeyOf', () => {
	const base = 'https://cdn.jsdelivr.net/gh/theprototype-app/packs@format-1';
	it('a pack item URL names its <pack>/<item folder>', () => {
		expect(packRowKeyOf(base + '/props-kit/WallTorch/glTF-Binary/WallTorch.glb', base)).toBe('props-kit/WallTorch');
		expect(packRowKeyOf(base + '/props-kit/WallTorch/glTF-Binary/WallTorch.glb', base + '/')).toBe('props-kit/WallTorch');
	});
	it('anything else is not a pack item', () => {
		expect(packRowKeyOf('blob:https://x/1', base)).toBe('');
		expect(packRowKeyOf(base + '/index.json', base)).toBe('');
		expect(packRowKeyOf('https://elsewhere/a/b/c.glb', base)).toBe('');
	});
});
