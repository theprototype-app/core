// @ts-nocheck — fixture indexes as plain literals; the module itself is typed
import { describe, it, expect } from 'vitest';
import {
	stableStringify,
	urlKey,
	urlOfKey,
	derivedKey,
	emptyIndex,
	normalizeIndex,
	blobsOf,
	usageOf,
	planEviction,
	orphanedBy,
	DEFAULT_CAP_MB,
	CAP_CHOICES_MB
} from '../../src/lib/assetCacheCore.js';

// 60 Q6: the local asset cache's pure half — cache keys, the index, the LRU plan.

const H = (c) => c.repeat(64); // a sha-256-shaped hex
const entry = (hash, bytes, lastUsed, kind = 'pack') => ({ hash, bytes, kind, lastUsed, at: 0 });

describe('cache keys', () => {
	it('url keys: absolute http(s) only, fragment dropped, optional version tag', () => {
		expect(urlKey('https://cdn.example/p/a.glb')).toBe('url:https://cdn.example/p/a.glb');
		expect(urlKey('https://cdn.example/p/a.glb#frag')).toBe('url:https://cdn.example/p/a.glb');
		expect(urlKey('https://x.test/hdri/sky.hdr', '1.41.0')).toBe(
			'url:https://x.test/hdri/sky.hdr#v=1.41.0'
		);
		expect(urlKey('blob:https://x/1')).toBeNull();
		expect(urlKey('data:,x')).toBeNull();
		expect(urlKey('hdri/sky.hdr')).toBeNull();
		expect(urlKey(undefined)).toBeNull();
	});
	it('urlOfKey inverts a url key (without its version)', () => {
		expect(urlOfKey(urlKey('https://a/b.glb'))).toBe('https://a/b.glb');
		expect(urlOfKey(urlKey('https://a/b.hdr', '9'))).toBe('https://a/b.hdr');
		expect(urlOfKey('derived:texture:abc:{}')).toBeNull();
	});
	it('derived keys: content hash + kind + settings, field order irrelevant', () => {
		const a = derivedKey('texture', H('a'), { maxTextureSize: 2048, textures: 'ktx2+fallback' });
		const b = derivedKey('texture', H('A'), { textures: 'ktx2+fallback', maxTextureSize: 2048 });
		expect(a).toBe(b);
		expect(a.startsWith('derived:texture:' + H('a') + ':')).toBe(true);
		expect(
			derivedKey('texture', H('a'), { maxTextureSize: 1024, textures: 'ktx2+fallback' })
		).not.toBe(a);
		expect(
			derivedKey('texture', H('b'), { maxTextureSize: 2048, textures: 'ktx2+fallback' })
		).not.toBe(a);
		expect(derivedKey('texture', 'not-a-hash', {})).toBeNull();
		expect(derivedKey('', H('a'), {})).toBeNull();
	});
	it('stableStringify sorts keys at every depth and drops undefined fields', () => {
		expect(stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(
			'{"a":{"d":[2,{"y":2,"z":1}]},"b":1}'
		);
		expect(stableStringify(null)).toBe('null');
		expect(stableStringify(undefined)).toBe('null');
	});
});

describe('normalizeIndex', () => {
	it('keeps good rows, drops malformed ones and unknown versions', () => {
		const raw = {
			v: 1,
			entries: {
				ok: {
					hash: H('a'),
					bytes: 10,
					kind: 'sky',
					lastUsed: 5,
					at: 1,
					type: 'image/vnd.radiance',
					meta: { r: 1 }
				},
				badHash: { hash: 'zz', bytes: 1, kind: 'pack' },
				badBytes: { hash: H('b'), bytes: -1, kind: 'pack' },
				oddKind: { hash: H('c'), bytes: 3, kind: 'weird' }
			}
		};
		const idx = normalizeIndex(raw);
		expect(Object.keys(idx.entries).sort()).toEqual(['oddKind', 'ok']);
		expect(idx.entries.ok).toEqual({
			hash: H('a'),
			bytes: 10,
			kind: 'sky',
			type: 'image/vnd.radiance',
			lastUsed: 5,
			at: 1,
			meta: { r: 1 }
		});
		expect(idx.entries.oddKind.kind).toBe('import');
		expect(normalizeIndex({ v: 2, entries: raw.entries })).toEqual(emptyIndex());
		expect(normalizeIndex(null)).toEqual(emptyIndex());
		expect(normalizeIndex('junk')).toEqual(emptyIndex());
	});
});

describe('usage', () => {
	it('counts a blob shared by two keys ONCE', () => {
		const idx = {
			v: 1,
			entries: {
				k1: entry(H('a'), 100, 1),
				k2: entry(H('a'), 100, 2, 'import'),
				k3: entry(H('b'), 50, 3, 'sky')
			}
		};
		expect(blobsOf(idx).get(H('a'))).toEqual({ bytes: 100, refs: 2 });
		const u = usageOf(idx);
		expect(u).toEqual({
			bytes: 150,
			keys: 3,
			blobs: 2,
			byKind: { pack: 100, sky: 50, texture: 0, import: 0 }
		});
	});
});

describe('planEviction (LRU)', () => {
	const idx = () => ({
		v: 1,
		entries: {
			old: entry(H('a'), 400, 10),
			mid: entry(H('b'), 300, 20),
			fresh: entry(H('c'), 300, 30)
		}
	});
	it('does nothing under the cap', () => {
		expect(planEviction(idx(), 1000)).toEqual({ keys: [], hashes: [], bytesAfter: 1000 });
	});
	it('drops the least recently used first until it fits', () => {
		expect(planEviction(idx(), 700)).toEqual({ keys: ['old'], hashes: [H('a')], bytesAfter: 600 });
		expect(planEviction(idx(), 350)).toEqual({
			keys: ['old', 'mid'],
			hashes: [H('a'), H('b')],
			bytesAfter: 300
		});
	});
	it('never drops a protected key (the one just written), even when it alone is over the cap', () => {
		expect(planEviction(idx(), 100, ['fresh'])).toEqual({
			keys: ['old', 'mid'],
			hashes: [H('a'), H('b')],
			bytesAfter: 300
		});
	});
	it('a shared blob is freed only when its LAST key goes', () => {
		const shared = {
			v: 1,
			entries: { a1: entry(H('a'), 500, 1), a2: entry(H('a'), 500, 50), b: entry(H('b'), 100, 10) }
		};
		// a1 goes first but frees nothing (a2 still names the blob); b goes next and frees 100
		expect(planEviction(shared, 550)).toEqual({
			keys: ['a1', 'b'],
			hashes: [H('b')],
			bytesAfter: 500
		});
	});
	it('is deterministic on equal timestamps (key order)', () => {
		const tie = { v: 1, entries: { z: entry(H('a'), 10, 1), y: entry(H('b'), 10, 1) } };
		expect(planEviction(tie, 10).keys).toEqual(['y']);
	});
});

describe('orphanedBy', () => {
	it('names only the blobs no remaining key refers to', () => {
		const idx = {
			v: 1,
			entries: { a1: entry(H('a'), 5, 1), a2: entry(H('a'), 5, 1), b: entry(H('b'), 5, 1) }
		};
		expect(orphanedBy(idx, ['a1'])).toEqual([]);
		expect(orphanedBy(idx, ['a1', 'a2', 'b']).sort()).toEqual([H('a'), H('b')]);
		expect(orphanedBy(idx, ['missing'])).toEqual([]);
	});
});

describe('the cap choices', () => {
	it('offer the default', () => {
		expect(CAP_CHOICES_MB).toContain(DEFAULT_CAP_MB);
	});
});
