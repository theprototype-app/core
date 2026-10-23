// @ts-nocheck
// 65 M6 — the smoke / ink fluid layer's pure rules (fluidLayerCore): params, budget, colour, stirrer.
import { describe, it, expect } from 'vitest';
import {
	FLUID_DEFAULTS,
	normalizeFluidParams,
	fluidTierFor,
	physicsFor,
	dyeColor,
	autoStir,
	pointerSplat
} from '../../src/lib/fluidLayerCore.js';

describe('normalizeFluidParams', () => {
	it('fills the defaults from nothing', () => {
		expect(normalizeFluidParams(undefined)).toEqual({ ...FLUID_DEFAULTS });
	});
	it('clamps numbers and refuses unknown choices', () => {
		const p = normalizeFluidParams({ style: 'lava', palette: 'nope', intensity: 99, curl: -5, fade: 'x', radius: 0, auto: 0 });
		expect(p.style).toBe('smoke');
		expect(p.palette).toBe('rainbow');
		expect(p.intensity).toBe(3);
		expect(p.curl).toBe(0);
		expect(p.fade).toBe(FLUID_DEFAULTS.fade);
		expect(p.radius).toBe(0.05);
		expect(p.auto).toBe(false);
	});
	it('keeps valid values', () => {
		const p = normalizeFluidParams({ style: 'ink', palette: 'ocean', intensity: 0.5, curl: 40, fade: 2, radius: 0.5, auto: true });
		expect(p).toEqual({ style: 'ink', palette: 'ocean', intensity: 0.5, curl: 40, fade: 2, radius: 0.5, auto: true });
	});
});

describe('fluidTierFor (the device budget)', () => {
	it('desktop gets the full grid', () => {
		expect(fluidTierFor({})).toMatchObject({ tier: 'high', simRes: 128, dyeRes: 512, iterations: 20 });
	});
	it('a governor-shrunk desktop drops to medium', () => {
		expect(fluidTierFor({ dprScale: 0.72 })).toMatchObject({ tier: 'medium', simRes: 96, iterations: 14 });
		expect(fluidTierFor({ dprScale: 0.8 }).tier).toBe('high');
	});
	it('a phone or a headset drops to low', () => {
		expect(fluidTierFor({ phone: true })).toMatchObject({ tier: 'low', simRes: 64, dyeRes: 256, iterations: 8 });
		expect(fluidTierFor({ xr: true }).tier).toBe('low');
	});
	it('a headset already capping particles gets no fluid', () => {
		expect(fluidTierFor({ xr: true, particlesCapped: true })).toBeNull();
		// a desktop capping particles still has it (the cap is about particle count)
		expect(fluidTierFor({ particlesCapped: true })).not.toBeNull();
	});
	it('every tier costs less than the one above', () => {
		const cost = (t) => t.simRes * t.simRes * t.iterations + t.dyeRes * t.dyeRes;
		expect(cost(fluidTierFor({ dprScale: 0.5 }))).toBeLessThan(cost(fluidTierFor({})));
		expect(cost(fluidTierFor({ xr: true }))).toBeLessThan(cost(fluidTierFor({ dprScale: 0.5 })));
	});
});

describe('physicsFor', () => {
	it('the velocity always fades, even when the dye never does', () => {
		const still = physicsFor(normalizeFluidParams({ fade: 0 }));
		expect(still.dyeFade).toBe(0);
		expect(still.velocityFade).toBeGreaterThan(0);
		expect(physicsFor(normalizeFluidParams({ fade: 5 })).velocityFade).toBeGreaterThan(still.velocityFade);
	});
});

describe('dyeColor', () => {
	it('is small positive linear RGB for every palette', () => {
		for (const palette of ['rainbow', 'ember', 'ocean', 'mono'])
			for (const t of [0, 3.3, 11]) {
				const c = dyeColor(palette, t);
				expect(c).toHaveLength(3);
				for (const v of c) {
					expect(v).toBeGreaterThanOrEqual(0);
					expect(v).toBeLessThanOrEqual(0.15 + 1e-9);
				}
			}
	});
	it('rainbow drifts with time, mono does not', () => {
		expect(dyeColor('rainbow', 0)).not.toEqual(dyeColor('rainbow', 4));
		expect(dyeColor('mono', 0)).toEqual(dyeColor('mono', 4));
	});
});

describe('autoStir', () => {
	it('stays inside the layer and its velocity matches its path', () => {
		for (let t = 0; t < 30; t += 0.7) {
			const s = autoStir(t);
			expect(s.x).toBeGreaterThan(0.1);
			expect(s.x).toBeLessThan(0.9);
			expect(s.y).toBeGreaterThan(0.1);
			expect(s.y).toBeLessThan(0.9);
			const h = 1e-4;
			const n = autoStir(t + h);
			expect((n.x - s.x) / h).toBeCloseTo(s.vx, 2);
			expect((n.y - s.y) / h).toBeCloseTo(s.vy, 2);
		}
	});
});

describe('pointerSplat', () => {
	it('is null for no movement', () => {
		expect(pointerSplat({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 0.016)).toBeNull();
	});
	it('turns a move into UV/s at the new position', () => {
		const s = pointerSplat({ x: 0.4, y: 0.5 }, { x: 0.5, y: 0.5 }, 0.1);
		expect(s.x).toBe(0.5);
		expect(s.vx).toBeCloseTo(1, 6);
		expect(s.vy).toBe(0);
	});
	it('clamps a frame hitch', () => {
		const s = pointerSplat({ x: 0, y: 0 }, { x: 1, y: 1 }, 0);
		expect(s.vx).toBe(6);
		expect(s.vy).toBe(6);
	});
});
