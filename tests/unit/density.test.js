import { describe, it, expect } from 'vitest';
import { applyDensity, DENSITIES, DEFAULT_DENSITY } from '../../src/lib/ui/density.js';

// NOTES-38 #19: density is ONE attribute on <html>; Comfortable (the design) is its absence,
// so a stale or unknown stored value can never leave the UI half-compact.
describe('applyDensity', () => {
	it('sets data-density only for compact', () => {
		const root = /** @type {HTMLElement} */ (/** @type {unknown} */ ({ dataset: {} }));
		applyDensity('compact', root);
		expect(root.dataset.density).toBe('compact');
		applyDensity('comfortable', root);
		expect(root.dataset.density).toBeUndefined();
		applyDensity('compact', root);
		applyDensity('bogus', root);
		expect(root.dataset.density).toBeUndefined();
		applyDensity(null, root);
		expect(root.dataset.density).toBeUndefined();
	});
	it('offers comfortable (default) and compact', () => {
		expect(DENSITIES.map((d) => d.value)).toEqual(['comfortable', 'compact']);
		expect(DEFAULT_DENSITY).toBe('comfortable');
	});
});
