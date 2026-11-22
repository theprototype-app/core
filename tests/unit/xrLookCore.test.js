// @ts-nocheck — plain fixtures; the module under test is typed
// 72 LK3 — what a stack becomes in a headset: the GLSL in stack order, the plain curve when no grade
// is asked for, nothing at all for a scene with no look, and an honest list of what stays behind.
import { describe, it, expect } from 'vitest';
import { planXrLook, xrSupportOf, lutAffine } from '../../src/lib/xrLookCore.js';

const fx = (kind, params = {}) => ({ kind, params });

describe('planXrLook', () => {
	it('no look: nothing to do', () => {
		const p = planXrLook([], { baseCurve: 'ACESFilmicToneMapping' });
		expect(p.active).toBe(false);
		expect(p.glsl).toBe('');
	});
	it('a curve alone needs no shader hook', () => {
		const p = planXrLook([fx('tonemapping', { mode: 'AGX' })]);
		expect(p).toMatchObject({ active: true, glsl: '', curve: 'AgXToneMapping', baked: ['tonemapping'] });
	});
	it('a neutral grade is not a grade', () => {
		const p = planXrLook([fx('huesaturation', { hue: 0, saturation: 0 }), fx('brightnesscontrast', {})], { baseCurve: 'AgXToneMapping' });
		expect(p.active).toBe(false);
		expect(p.glsl).toBe('');
	});
	it('runs in stack order, with the environment curve last when the stack has none', () => {
		const p = planXrLook([fx('brightnesscontrast', { contrast: 0.5 }), fx('huesaturation', { saturation: -1 })], { baseCurve: 'ACESFilmicToneMapping' });
		const lines = p.glsl.split('\n').map((l) => l.trim());
		expect(lines[0]).toContain('* 2.0'); // contrast 0.5 => 1 / (1 - 0.5)
		expect(lines[1]).toContain('* 1.0'); // saturation -1: all the way to the mean
		expect(lines[2]).toBe('color = ACESFilmicToneMapping(color);');
		expect(p.curve).toBe('ACESFilmicToneMapping');
	});
	it("a stack's curve sits where the author put it, and only one runs", () => {
		const p = planXrLook(
			[fx('huesaturation', { saturation: -0.5 }), fx('tonemapping', { mode: 'NEUTRAL' }), fx('brightnesscontrast', { brightness: 0.1 }), fx('tonemapping', { mode: 'AGX' })],
			{ baseCurve: 'ACESFilmicToneMapping' }
		);
		const lines = p.glsl.split('\n').map((l) => l.trim());
		expect(lines[1]).toBe('color = NeutralToneMapping(color);');
		expect(lines.filter((l) => /ToneMapping\(color\)/.test(l))).toHaveLength(1);
		expect(lines[2]).toContain('color + vec3(-0.4)');
	});
	it('no curve at all on a scene with no sky image: the desktop has none there either', () => {
		const p = planXrLook([fx('brightnesscontrast', { brightness: 0.1 })], { baseCurve: '' });
		expect(p.glsl).not.toMatch(/ToneMapping/);
		expect(p.curve).toBe('');
	});
	it('the vignette travels beside the shader, and alone it is still a look', () => {
		const p = planXrLook([fx('vignette', { offset: 0.3, darkness: 0.7 })], { baseCurve: 'AgXToneMapping' });
		expect(p).toMatchObject({ active: true, glsl: '', curve: 'AgXToneMapping', vignette: { offset: 0.3, darkness: 0.7, eskil: false } });
	});
	it('says what stays on the desktop', () => {
		const p = planXrLook([fx('bloom'), fx('ao'), fx('smaa'), fx('grain'), fx('graph'), fx('huesaturation', { hue: 0.2 })], { baseCurve: '' });
		expect(p.skipped).toEqual(['bloom', 'ao', 'grain', 'graph']);
		expect(p.baked).toEqual(['huesaturation']);
		expect(xrSupportOf('bloom')).toBe('none');
		expect(xrSupportOf('lut')).toBe('approx');
		expect(xrSupportOf('tonemapping')).toBe('baked');
	});
	it('a LUT with no bytes yet is listed, not a hole in the shader', () => {
		const none = planXrLook([fx('lut', { lut: 'abc' })], { lutFit: () => null });
		expect(none).toMatchObject({ active: false, skipped: ['lut'] });
		const fit = planXrLook([fx('lut', { lut: 'abc' })], { lutFit: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] });
		expect(fit.glsl).toContain('pow(clamp(color');
		expect(fit.baked).toEqual(['lut']);
	});
	it('the key moves only when the output would', () => {
		const a = planXrLook([fx('huesaturation', { saturation: -0.5 })]);
		const b = planXrLook([fx('huesaturation', { saturation: -0.5 })]);
		const c = planXrLook([fx('huesaturation', { saturation: -0.4 })]);
		expect(a.key).toBe(b.key);
		expect(a.key).not.toBe(c.key);
	});
});

describe('lutAffine', () => {
	const cube = (size, fn) => {
		const data = new Float32Array(size ** 3 * 4);
		for (let z = 0; z < size; z++)
			for (let y = 0; y < size; y++)
				for (let x = 0; x < size; x++) {
					const o = (z * size * size + y * size + x) * 4;
					const v = fn(x / (size - 1), y / (size - 1), z / (size - 1));
					data.set([...v, 1], o);
				}
		return data;
	};
	it('recovers an identity', () => {
		const m = lutAffine(cube(17, (r, g, b) => [r, g, b]), 17);
		[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0].forEach((v, i) => expect(m[i]).toBeCloseTo(v, 5));
	});
	it('recovers a tint and a channel swap with an offset', () => {
		const m = lutAffine(cube(17, (r, g, b) => [0.5 * g + 0.1, b, 0.8 * r]), 17);
		[0, 0.5, 0, 0.1, 0, 0, 1, 0, 0.8, 0, 0, 0].forEach((v, i) => expect(m[i]).toBeCloseTo(v, 5));
	});
	it('reads an 8-bit table', () => {
		const f = cube(9, (r, g, b) => [r, g, b]);
		const bytes = new Uint8Array(f.length);
		for (let i = 0; i < f.length; i++) bytes[i] = Math.round(f[i] * 255);
		expect(lutAffine(bytes, 9)[0]).toBeCloseTo(1, 2);
	});
});
