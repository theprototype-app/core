// 106 S3 — the Cinematic view's two device switches, Reflections (SSR) and Global light (SSGI): On / Off / Auto,
// Auto = what the quality step decides; the drop lowers the step first and then a switch set to On; the chip's and
// the menu's words; the per-pass cost meter.
import { describe, it, expect } from 'vitest';
import { lightingPlan, planKey, stepText, costText, createCostMeter, asLightMode, QUALITY, HIGH_MAX_PIXELS } from '../../src/lib/cinematic/cinematicCore.js';

const P = 1600 * 900;

describe('asLightMode', () => {
	it('keeps on / off, anything else is auto', () => {
		expect(asLightMode('on')).toBe('on');
		expect(asLightMode('off')).toBe('off');
		for (const v of [undefined, null, '', 'yes', 1, true]) expect(asLightMode(v)).toBe('auto');
	});
});

describe('lightingPlan', () => {
	it('Auto follows the quality step, exactly as before 106', () => {
		for (const asked of /** @type {const} */ (['basic', 'standard', 'high'])) {
			const p = lightingPlan({ asked, pixels: P });
			expect(p.quality).toBe(asked);
			expect(p.gi).toBe(QUALITY[asked].gi);
			expect(p.ssr).toBe(QUALITY[asked].ssr);
			expect(p.scale).toBe(QUALITY[asked].scale);
			expect(p.off).toEqual([]);
		}
	});
	it('Off removes a pass at any step, On adds it at Basic (at half resolution)', () => {
		expect(lightingPlan({ asked: 'high', pixels: P, reflections: 'off' })).toMatchObject({ gi: true, ssr: false, scale: 1 });
		expect(lightingPlan({ asked: 'standard', pixels: P, globalLight: 'off' })).toMatchObject({ gi: false, ssr: true, scale: 0.5 });
		expect(lightingPlan({ asked: 'basic', pixels: P, reflections: 'on' })).toMatchObject({ gi: false, ssr: true, scale: 0.5 });
		expect(lightingPlan({ asked: 'basic', pixels: P, globalLight: 'on', reflections: 'on' })).toMatchObject({ gi: true, ssr: true, scale: 0.5 });
		expect(lightingPlan({ asked: 'basic', pixels: P, globalLight: 'off', reflections: 'off' })).toMatchObject({ gi: false, ssr: false, scale: 1 });
	});
	it('the window cap still applies (High is not drawn above 1440p)', () => {
		expect(lightingPlan({ asked: 'high', pixels: HIGH_MAX_PIXELS + 1 })).toMatchObject({ quality: 'standard', scale: 0.5 });
	});
	it('the drop takes the steps first (Auto passes follow), then a switch set to On, Global light first', () => {
		const o = { asked: /** @type {const} */ ('high'), pixels: P, reflections: /** @type {const} */ ('on'), globalLight: /** @type {const} */ ('on') };
		expect(lightingPlan({ ...o, drops: 0 }).steps).toBe(4);
		expect(lightingPlan({ ...o, drops: 1 })).toMatchObject({ quality: 'standard', gi: true, ssr: true, off: [], steps: 3 });
		expect(lightingPlan({ ...o, drops: 2 })).toMatchObject({ quality: 'basic', gi: true, ssr: true, off: [], steps: 2 });
		expect(lightingPlan({ ...o, drops: 3 })).toMatchObject({ quality: 'basic', gi: false, ssr: true, off: ['globalLight'], steps: 1 });
		expect(lightingPlan({ ...o, drops: 4 })).toMatchObject({ quality: 'basic', gi: false, ssr: false, off: ['globalLight', 'reflections'], steps: 0 });
		expect(lightingPlan({ ...o, drops: 9 }).steps).toBe(0);
	});
	it('Auto at Basic has nothing left to drop (the old rule: no drop below Basic)', () => {
		expect(lightingPlan({ asked: 'standard', pixels: P, drops: 1 })).toMatchObject({ quality: 'basic', gi: false, ssr: false, steps: 0 });
		expect(lightingPlan({ asked: 'basic', pixels: P }).steps).toBe(0);
	});
	it('a key per drawn configuration (the baked mask is part of it)', () => {
		const a = lightingPlan({ asked: 'standard', pixels: P });
		expect(planKey(a)).toBe(planKey(lightingPlan({ asked: 'standard', pixels: P, reflections: 'on', globalLight: 'on' })));
		expect(planKey(a)).not.toBe(planKey(lightingPlan({ asked: 'standard', pixels: P, reflections: 'off' })));
		expect(planKey(a)).not.toBe(planKey(a, true));
	});
});

describe('stepText', () => {
	it('names the step and the switches the drop turned off', () => {
		const o = { asked: /** @type {const} */ ('high'), pixels: P, reflections: /** @type {const} */ ('on'), globalLight: /** @type {const} */ ('on') };
		expect(stepText(lightingPlan({ ...o, drops: 0 }))).toBe('');
		expect(stepText(lightingPlan({ ...o, drops: 2 }))).toBe('Lowered to Basic to keep it smooth');
		expect(stepText(lightingPlan({ ...o, drops: 3 }))).toBe('Lowered to Basic, Global light off to keep it smooth');
		expect(stepText(lightingPlan({ ...o, drops: 4 }))).toBe('Lowered to Basic, Global light and Reflections off to keep it smooth');
		expect(stepText(lightingPlan({ asked: 'basic', pixels: P, reflections: 'on', drops: 1 }))).toBe('Reflections off to keep it smooth');
	});
});

describe('costText', () => {
	it('unknown = empty; scaled to the window; rounded', () => {
		expect(costText(undefined, P)).toBe('');
		expect(costText({ ms: 3.2, pixels: P }, P)).toBe('about 3 ms');
		expect(costText({ ms: 3, pixels: P }, P * 2)).toBe('about 6 ms');
		expect(costText({ ms: 0.2, pixels: P }, P)).toBe('under 1 ms');
	});
});

describe('createCostMeter', () => {
	it('a pass costs the median with it minus the median without it, once both sides have enough frames', () => {
		const m = createCostMeter({ min: 5 });
		const std = { gi: true, ssr: true, scale: 0.5 };
		const noR = { gi: true, ssr: false, scale: 0.5 };
		for (let i = 0; i < 5; i++) m.feed(std, 10 + (i % 2));
		expect(m.cost('reflections', std)).toBe(null);
		for (let i = 0; i < 4; i++) m.feed(noR, 7);
		expect(m.cost('reflections', std)).toBe(null);
		m.feed(noR, 7);
		expect(m.cost('reflections', std)).toBe(3);
		// Global light: needs a frame set without it
		expect(m.cost('globalLight', std)).toBe(null);
		for (let i = 0; i < 5; i++) m.feed({ gi: false, ssr: false, scale: 1 }, 4);
		// gi on, ssr off (7) vs nothing (4): any resolution for "nothing"
		expect(m.cost('globalLight', std)).toBe(3);
	});
	it('ignores frames that are not frames, never reports a negative cost', () => {
		const m = createCostMeter({ min: 2 });
		m.feed({ gi: false, ssr: true, scale: 0.5 }, 0);
		m.feed({ gi: false, ssr: true, scale: 0.5 }, 5000);
		expect(m.counts()).toEqual({});
		for (let i = 0; i < 2; i++) {
			m.feed({ gi: false, ssr: true, scale: 0.5 }, 3);
			m.feed({ gi: false, ssr: false, scale: 1 }, 4);
		}
		expect(m.cost('reflections', { gi: false, ssr: true, scale: 0.5 })).toBe(0);
	});
});
