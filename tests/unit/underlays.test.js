// @ts-nocheck — plain records
// 60 Q5: the reference-image record's ONE normalizer (idb read, the wire, every edit) and the plane's
// height from the image's aspect.
import { describe, it, expect } from 'vitest';
import { normalizeUnderlay, underlayHeight, DEFAULT_OPACITY } from '../../src/lib/underlays.js';

describe('normalizeUnderlay', () => {
	it('refuses what is not an underlay', () => {
		expect(normalizeUnderlay(null)).toBe(null);
		expect(normalizeUnderlay({})).toBe(null);
		expect(normalizeUnderlay({ id: '' })).toBe(null);
		expect(normalizeUnderlay({ id: 'x'.repeat(65) })).toBe(null);
	});
	it('fills defaults and drops unknown fields', () => {
		const u = normalizeUnderlay({ id: 'a', evil: 1, owner: 'someone' });
		expect(u).toEqual({
			id: 'a',
			name: 'Reference',
			px: [1, 1],
			mode: 'ground',
			position: [0, 0, 0],
			quaternion: [0, 0, 0, 1],
			width: 10,
			opacity: DEFAULT_OPACITY,
			visible: true,
			shared: false,
			scene: '',
			at: 0
		});
	});
	it('clamps every number and rejects malformed vectors', () => {
		const u = normalizeUnderlay({ id: 'a', width: 1e9, opacity: 5, position: [1, 'x', 2], quaternion: [0, 0, 0], px: [0, -3] });
		expect(u.width).toBe(10000);
		expect(u.opacity).toBe(1);
		expect(u.position).toEqual([0, 0, 0]);
		expect(u.quaternion).toEqual([0, 0, 0, 1]);
		expect(u.px).toEqual([1, 1]);
		expect(normalizeUnderlay({ id: 'a', opacity: 0 }).opacity).toBe(0.02);
		expect(normalizeUnderlay({ id: 'a', width: -4 }).width).toBe(0.01);
	});
	it('keeps only an image data URL as the source', () => {
		expect(normalizeUnderlay({ id: 'a', src: 'data:image/png;base64,AAAA' }).src).toBe('data:image/png;base64,AAAA');
		expect('src' in normalizeUnderlay({ id: 'a', src: 'javascript:alert(1)' })).toBe(false);
		expect('src' in normalizeUnderlay({ id: 'a', src: 'https://example.org/x.png' })).toBe(false);
	});
	it('only "view" and "ground" placements exist', () => {
		expect(normalizeUnderlay({ id: 'a', mode: 'view' }).mode).toBe('view');
		expect(normalizeUnderlay({ id: 'a', mode: 'ceiling' }).mode).toBe('ground');
	});
});

describe('underlayHeight', () => {
	it('keeps the image aspect', () => {
		expect(underlayHeight({ width: 10, px: [64, 32] })).toBe(5);
		expect(underlayHeight({ width: 4, px: [100, 300] })).toBe(12);
	});
});
