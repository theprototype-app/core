// 39 P2/P3/P4: the pure halves of drag-to-place — what a pack row says about an item's size, the
// ghost tier rule, and the files one pack item downloads.
import { describe, it, expect } from 'vitest';
import { dimsFromRow, boxFromSize, sizeOfBox, unknownDims, dimsLabel, costLabel, UNKNOWN_BOX } from '../../src/lib/placementDims.js';
import { ghostTier, normalizePreviewMode, normalizeTriBudget } from '../../src/lib/placementPrefs.js';
import { packItemUrls } from '../../src/lib/packs.js';

describe('dimsFromRow', () => {
	it('reads size + box + tris + bytes from a row', () => {
		const d = dimsFromRow({ size: [1.655, 1.541, 1.152], box: [-0.693, 0.099, -0.613, 0.962, 1.64, 0.539], tris: 4212, bytes: 120484 });
		expect(d).toMatchObject({ size: [1.655, 1.541, 1.152], tris: 4212, bytes: 120484, known: true, source: 'row', animated: false });
		expect(d?.box[1]).toBe(0.099);
	});
	it('a size alone gets the bottom-centre box', () => {
		expect(dimsFromRow({ size: [2, 3, 1] })?.box).toEqual([-1, 0, -0.5, 1, 3, 0.5]);
	});
	it('a box alone gives the size', () => {
		expect(dimsFromRow({ box: [-1, 0, -2, 1, 4, 2] })?.size).toEqual([2, 4, 4]);
	});
	it('a NUMERIC size is the old manifest byte count, not dimensions', () => {
		expect(dimsFromRow({ size: 123456 })).toBeNull();
		expect(dimsFromRow({ size: 123456, box: [0, 0, 0, 1, 1, 1] })?.bytes).toBe(123456);
	});
	it('refuses malformed dims (unknown instead of a wrong ghost)', () => {
		expect(dimsFromRow({ size: [1, 2] })).toBeNull();
		expect(dimsFromRow({ size: [1, -2, 3] })).toBeNull();
		expect(dimsFromRow({ box: [1, 0, 0, 0, 1, 1] })).toBeNull();
		expect(dimsFromRow(null)).toBeNull();
	});
	it('a behaviour or animated flag marks it animated (never a kit reference)', () => {
		expect(dimsFromRow({ size: [1, 1, 1], animated: true })?.animated).toBe(true);
		expect(dimsFromRow({ size: [1, 1, 1], behavior: { type: 'door' } })?.animated).toBe(true);
	});
	it('unknown is the 1 m box', () => {
		expect(unknownDims()).toMatchObject({ known: false, box: UNKNOWN_BOX, size: [1, 1, 1] });
	});
	it('labels read W × D × H (y is the height)', () => {
		expect(dimsLabel([1.655, 1.541, 1.152])).toBe('1.66 × 1.15 × 1.54 m');
		expect(costLabel(/** @type {any} */ ({ tris: 4212, bytes: 120484 }))).toBe('4.2k tris · 118 KB');
		expect(sizeOfBox(boxFromSize([2, 1, 3]))).toEqual([2, 1, 3]);
	});
});

describe('ghostTier (P2/P3)', () => {
	it('not decoded is always the box', () => {
		expect(ghostTier({ decoded: false, tris: 10 }, 'full', 50000)).toBe('box');
	});
	it('within budget: the model only under the budget', () => {
		expect(ghostTier({ decoded: true, tris: 4212 }, 'budget', 50000)).toBe('model');
		expect(ghostTier({ decoded: true, tris: 200000 }, 'budget', 50000)).toBe('box');
		expect(ghostTier({ decoded: true, tris: null }, 'budget', 50000)).toBe('box');
	});
	it('full ignores the budget; box is always the box', () => {
		expect(ghostTier({ decoded: true, tris: 200000 }, 'full', 50000)).toBe('model');
		expect(ghostTier({ decoded: true, tris: 10 }, 'box', 50000)).toBe('box');
	});
	it('normalizers', () => {
		expect(normalizePreviewMode('nope')).toBe('budget');
		expect(normalizeTriBudget('20000')).toBe(20000);
		expect(normalizeTriBudget(-1)).toBeGreaterThan(0);
	});
});

describe('packItemUrls (P5)', () => {
	it('an item downloads its LOD0 and its LOD files beside it', () => {
		const item = { glbUrl: 'https://cdn/x/kit/Wall/glTF-Binary/wall.glb', lods: [{ file: 'wall.lod1.glb', ratio: 0.5 }, { file: '../evil.glb', ratio: 0.2 }] };
		expect(packItemUrls(item)).toEqual(['https://cdn/x/kit/Wall/glTF-Binary/wall.glb', 'https://cdn/x/kit/Wall/glTF-Binary/wall.lod1.glb']);
		expect(packItemUrls({})).toEqual([]);
	});
});
