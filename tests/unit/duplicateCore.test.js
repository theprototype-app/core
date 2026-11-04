import { describe, it, expect } from 'vitest';
import { duplicatePlan, seededRandom, DUPLICATE_MAX } from '../../src/lib/ai/duplicateCore.js';

const base = { position: [1, 0, 0], rotation: [0, 0.5, 0], scale: [1, 2, 1] };

describe('duplicatePlan (create_objects from, mcp-shapes item 7)', () => {
	it('copy i sits at base + i x offset, same turn and size without randomness', () => {
		const r = /** @type {any} */ (duplicatePlan({ count: 3, offset: [2, 0, 0] }, base));
		expect(r.poses.map((p) => p.position)).toEqual([[3, 0, 0], [5, 0, 0], [7, 0, 0]]);
		expect(r.poses.every((p) => p.rotation[1] === 0.5 && p.scale[1] === 2)).toBe(true);
	});
	it('the same seed makes the same copies; another seed does not', () => {
		const a = duplicatePlan({ count: 5, randomRot: true, randomScale: 0.2, seed: 7 }, base);
		const b = duplicatePlan({ count: 5, randomRot: true, randomScale: 0.2, seed: 7 }, base);
		const c = duplicatePlan({ count: 5, randomRot: true, randomScale: 0.2, seed: 8 }, base);
		expect(a).toEqual(b);
		expect(a).not.toEqual(c);
	});
	it('randomness stays inside its range and only on the axes asked for', () => {
		const r = /** @type {any} */ (duplicatePlan({ count: 50, randomRot: 0.3, randomScale: [0.5, 1.5] }, base));
		for (const p of r.poses) {
			expect(p.rotation[0]).toBe(0);
			expect(Math.abs(p.rotation[1] - 0.5)).toBeLessThanOrEqual(0.3);
			const f = p.scale[0];
			expect(f).toBeGreaterThanOrEqual(0.5);
			expect(f).toBeLessThanOrEqual(1.5);
			expect(p.scale[1]).toBeCloseTo(2 * f, 5); // uniform: the source's proportions stay
		}
	});
	it('names a bad field', () => {
		expect(/** @type {any} */ (duplicatePlan({ count: 0 }, base)).error).toMatch(/count/);
		expect(/** @type {any} */ (duplicatePlan({ count: DUPLICATE_MAX + 1 }, base)).error).toMatch(/count/);
		expect(/** @type {any} */ (duplicatePlan({ offset: [1, 2] }, base)).error).toMatch(/offset/);
		expect(/** @type {any} */ (duplicatePlan({ randomRot: 'lots' }, base)).error).toMatch(/randomRot/);
		expect(/** @type {any} */ (duplicatePlan({ randomScale: 3 }, base)).error).toMatch(/randomScale/);
		expect(/** @type {any} */ (duplicatePlan({ seed: 1.5 }, base)).error).toMatch(/seed/);
	});
	it('seededRandom is deterministic and in [0, 1)', () => {
		const a = seededRandom(42);
		const b = seededRandom(42);
		for (let i = 0; i < 100; i++) {
			const x = a();
			expect(x).toBe(b());
			expect(x >= 0 && x < 1).toBe(true);
		}
	});
});
