// 80a-fix4-ui G3 (device lab 2026-11-05): the sky quality picker said "Max (4K)" while it loaded the 8K Meadow sky.
// With the sky known, the Max label is the file Max fetches for it (skyFileTier, the runtime's rule).
import { describe, it, expect } from 'vitest';
import { skyMaxLabel, skyFileTier } from '../../src/lib/hdri/hdriCore.js';
import { bundledHdri, skyTiers } from '../../src/lib/hdri/catalog.js';

const PC = { memoryGB: 8 };
const PHONE = { memoryGB: 8, phone: true };

describe('G3 the Max label is the size actually loaded', () => {
	const meadow = bundledHdri('bundled:meadow');
	it('the catalog has Meadow with an 8K file (the premise)', () => {
		expect(meadow && skyTiers(meadow)).toContain('8k');
	});
	for (const [label, facts] of /** @type {const} */ ([['PC', PC], ['phone', PHONE], ['4 GB', { memoryGB: 4 }], ['small GPU', { memoryGB: 16, maxTexture: 4096 }]])) {
		it(`Meadow on a ${label}: label = the tier fetched`, () => {
			const tiers = skyTiers(/** @type {any} */ (meadow));
			const fetched = skyFileTier('max', tiers, facts);
			expect(skyMaxLabel(facts, tiers)).toBe('Max (' + fetched.toUpperCase() + ')');
		});
	}
	it('Meadow on a PC says 8K, a 4K-only sky says 4K', () => {
		expect(skyMaxLabel(PC, skyTiers(/** @type {any} */ (meadow)))).toBe('Max (8K)');
		expect(skyMaxLabel(PC, ['1k', '2k', '4k'])).toBe('Max (4K)');
	});
	it('no sky known: the device-level label as before', () => {
		expect(skyMaxLabel(PC)).toBe('Max (up to 8K)');
		expect(skyMaxLabel({ memoryGB: 4 })).toBe('Max (4K)');
	});
});
