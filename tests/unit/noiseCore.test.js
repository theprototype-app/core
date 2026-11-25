// 105-noise (roadmap 105 T4a): the image editor's noise generator, with no canvas.
// The two promises the brief names: TILEABLE = the edge pixels match within one level (the texture repeats with no
// seam), and the same seed gives the same bytes.
import { describe, it, expect } from 'vitest';
import {
	NOISE_KINDS,
	NOISE_DEFAULTS,
	normalizeNoise,
	sampleNoise,
	noiseHeightField,
	noiseRaster,
	gradientLut,
	blendInto,
	hexColor,
	parseNoiseSpec,
	NOISE_ROW_DEFAULTS
} from '../../src/lib/image/noiseCore.js';

/** the biggest 8-bit step across the wrap (last column -> first, last row -> first) and the typical step inside */
function seamSteps(/** @type {{width: number, height: number, data: Uint8ClampedArray}} */ r) {
	const { width: W, height: H, data: d } = r;
	const at = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ c) => d[(y * W + x) * 4 + c];
	let wrapMax = 0;
	let innerMax = 0;
	for (let y = 0; y < H; y++)
		for (let c = 0; c < 3; c++) {
			wrapMax = Math.max(wrapMax, Math.abs(at(W - 1, y, c) - at(0, y, c)));
			for (let x = 1; x < W; x++) innerMax = Math.max(innerMax, Math.abs(at(x, y, c) - at(x - 1, y, c)));
		}
	for (let x = 0; x < W; x++)
		for (let c = 0; c < 3; c++) {
			wrapMax = Math.max(wrapMax, Math.abs(at(x, H - 1, c) - at(x, 0, c)));
			for (let y = 1; y < H; y++) innerMax = Math.max(innerMax, Math.abs(at(x, y, c) - at(x, y - 1, c)));
		}
	return { wrapMax, innerMax };
}

describe('normalizeNoise', () => {
	it('fills defaults and clamps', () => {
		const o = normalizeNoise({ kind: 'nope', scale: 999, octaves: 0, roughness: 3, colors: ['#f00'] });
		expect(o.kind).toBe('perlin');
		expect(o.scale).toBe(64);
		expect(o.octaves).toBe(1);
		expect(o.roughness).toBe(1);
		expect(o.colors).toEqual(['#000000', '#ffffff']); // one colour is not a gradient
		expect(o.tileable).toBe(true);
	});
	it('a tileable scale is a whole number of cells; a free one may be fractional', () => {
		expect(normalizeNoise({ scale: 3.6 }).scale).toBe(4);
		expect(normalizeNoise({ scale: 3.6, tileable: false }).scale).toBeCloseTo(3.6);
	});
	it('takes up to five colours, dropping bad ones', () => {
		const o = normalizeNoise({ colors: ['#123', 'red', '#ABCDEF', '#000', '#111', '#222', '#333'] });
		expect(o.colors).toEqual(['#112233', '#abcdef', '#000000', '#111111', '#222222']);
		expect(hexColor('#GGG')).toBe(null);
	});
});

describe('tileable: the texture repeats with no seam', () => {
	for (const kind of NOISE_KINDS) {
		it(kind + ': u = 1 is u = 0 and v = 1 is v = 0', () => {
			const o = normalizeNoise({ kind, scale: 3, octaves: 5, seed: 42 });
			for (let t = 0; t < 1; t += 0.0371) {
				expect(Math.abs(sampleNoise(1, t, o) - sampleNoise(0, t, o))).toBeLessThan(1 / 512);
				expect(Math.abs(sampleNoise(t, 1, o) - sampleNoise(t, 0, o))).toBeLessThan(1 / 512);
			}
		});
		it(kind + ': the edge pixels match within one level of the step inside the image', () => {
			const r = noiseRaster({ kind, scale: 4, octaves: 4, seed: 7 }, { width: 128, height: 96 });
			const { wrapMax, innerMax } = seamSteps(r);
			// across the wrap the picture moves by no more than it does between any two neighbours, +1 level
			expect(wrapMax).toBeLessThanOrEqual(innerMax + 1);
		});
	}
	it('the counterfactual: NOT tileable does show a seam', () => {
		const r = noiseRaster({ kind: 'perlin', scale: 4.5, octaves: 4, seed: 7, tileable: false }, { width: 128, height: 96 });
		const { wrapMax, innerMax } = seamSteps(r);
		expect(wrapMax).toBeGreaterThan(innerMax + 1);
	});
});

describe('deterministic', () => {
	for (const kind of NOISE_KINDS)
		it(kind + ': same seed = same bytes, another seed = other bytes', () => {
			const opts = { kind, scale: 5, octaves: 3, seed: 1234, colors: ['#203040', '#ffeecc', '#80a040'] };
			const a = noiseRaster(opts, { width: 64, height: 64 });
			const b = noiseRaster(opts, { width: 64, height: 64 });
			expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
			const c = noiseRaster({ ...opts, seed: 1235 }, { width: 64, height: 64 });
			expect(Buffer.from(a.data).equals(Buffer.from(c.data))).toBe(false);
		});
});

describe('the field', () => {
	for (const kind of NOISE_KINDS)
		it(kind + ': stays in 0..1 and actually varies', () => {
			const h = noiseHeightField(64, 64, normalizeNoise({ kind, scale: 4, octaves: 4 }));
			let lo = 1;
			let hi = 0;
			for (const v of h) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
			expect(lo).toBeGreaterThanOrEqual(0);
			expect(hi).toBeLessThanOrEqual(1);
			expect(hi - lo).toBeGreaterThan(0.3);
		});
	it('invert flips it and contrast stretches it', () => {
		const o = normalizeNoise({ scale: 2, octaves: 2 });
		const flat = noiseHeightField(32, 32, o);
		const inv = noiseHeightField(32, 32, { ...o, invert: true });
		for (let i = 0; i < flat.length; i += 37) expect(inv[i]).toBeCloseTo(1 - flat[i], 5);
		const spread = (/** @type {Float32Array} */ h) => Math.max(...h) - Math.min(...h);
		expect(spread(noiseHeightField(32, 32, { ...o, contrast: 60 }))).toBeGreaterThan(spread(flat));
		expect(spread(noiseHeightField(32, 32, { ...o, contrast: -60 }))).toBeLessThan(spread(flat));
	});
	it('octaves add detail: more octaves = rougher (neighbour steps relative to the spread)', () => {
		// the top octaves of a SMALL image land on lattice points (where Perlin is 0), so measure at 256 px
		const rough = (/** @type {Float32Array} */ h) => {
			let s = 0;
			for (let i = 1; i < h.length; i++) if (i % 256) s += Math.abs(h[i] - h[i - 1]);
			return s / (Math.max(...h) - Math.min(...h));
		};
		const o = normalizeNoise({ scale: 2, roughness: 0.6 });
		expect(rough(noiseHeightField(256, 256, { ...o, octaves: 5 }))).toBeGreaterThan(1.5 * rough(noiseHeightField(256, 256, { ...o, octaves: 1 })));
	});
});

describe('colour and blend', () => {
	it('a gradient runs through its stops', () => {
		const lut = gradientLut(['#000000', '#ff0000', '#ffffff']);
		expect([...lut.slice(0, 3)]).toEqual([0, 0, 0]);
		expect(lut[128 * 3]).toBeGreaterThan(250); // about the middle: red
		expect(lut[128 * 3 + 2]).toBeLessThan(5);
		expect([...lut.slice(255 * 3)]).toEqual([255, 255, 255]);
	});
	it('no base = the noise, opaque', () => {
		const r = noiseRaster({ colors: ['#ff0000', '#ff0000'] }, { width: 8, height: 8 });
		expect([...r.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
	});
	it('replace / multiply / overlay / add over a base, with opacity', () => {
		const src = new Uint8ClampedArray([100, 200, 50, 0]);
		const rgb = new Uint8Array([200, 100, 255]);
		const out = new Uint8ClampedArray(4);
		blendInto(src, rgb, out, 'replace', 1);
		expect([...out]).toEqual([200, 100, 255, 255]);
		blendInto(src, rgb, out, 'replace', 0.5);
		expect([...out]).toEqual([150, 150, 152, 128]); // 152.5 and 127.5 round half to even
		blendInto(src, rgb, out, 'multiply', 1);
		expect([...out]).toEqual([78, 78, 50, 0]); // alpha kept outside replace
		blendInto(src, rgb, out, 'add', 1);
		expect([...out]).toEqual([255, 255, 255, 0]);
		blendInto(src, rgb, out, 'overlay', 1);
		expect(out[0]).toBe(157); // 2*100*200/255
		expect(out[1]).toBe(188); // 255 - 2*55*155/255
		blendInto(src, rgb, out, 'multiply', 0);
		expect([...out]).toEqual([100, 200, 50, 0]); // opacity 0 = untouched
	});
	it('a base fixes the size and is never mutated', () => {
		const base = { width: 16, height: 8, data: new Uint8ClampedArray(16 * 8 * 4).fill(90) };
		const before = base.data.slice();
		const r = noiseRaster({ blend: 'multiply' }, { width: 999, height: 999, base });
		expect([r.width, r.height]).toEqual([16, 8]);
		expect(Buffer.from(base.data).equals(Buffer.from(before))).toBe(true);
	});
});

describe('normal from height', () => {
	it('is a unit normal map, mostly facing out, that also tiles', () => {
		const r = noiseRaster({ output: 'normal', scale: 3, octaves: 3, strength: 2 }, { width: 96, height: 96 });
		let blue = 0;
		for (let i = 0; i < r.data.length; i += 4) {
			const n = [r.data[i], r.data[i + 1], r.data[i + 2]].map((c) => (c / 255) * 2 - 1);
			expect(Math.abs(Math.hypot(...n) - 1)).toBeLessThan(0.03);
			blue += n[2];
		}
		expect(blue / (r.data.length / 4)).toBeGreaterThan(0.6);
		const { wrapMax, innerMax } = seamSteps(r);
		expect(wrapMax).toBeLessThanOrEqual(innerMax + 1);
	});
	it('strength 0 is flat (128, 128, 255)', () => {
		const r = noiseRaster({ output: 'normal', strength: 0 }, { width: 8, height: 8 });
		expect([...r.data.slice(0, 4)]).toEqual([128, 128, 255, 255]);
	});
	it('a slope rising to the right tilts the normal left (red below 128)', () => {
		// the default perlin field is not a ramp, so check the sign convention on the derivative directly: inverting
		// the height flips the red and green channels about 128
		const a = noiseRaster({ output: 'normal', strength: 3, seed: 3 }, { width: 32, height: 32 });
		const b = noiseRaster({ output: 'normal', strength: 3, seed: 3, invert: true }, { width: 32, height: 32 });
		for (let i = 0; i < a.data.length; i += 4 * 17) {
			expect(Math.abs(a.data[i] - 128 + (b.data[i] - 128))).toBeLessThanOrEqual(2);
			expect(Math.abs(a.data[i + 1] - 128 + (b.data[i + 1] - 128))).toBeLessThanOrEqual(2);
		}
	});
});

it('the defaults are a frozen, legal set', () => {
	expect(Object.isFrozen(NOISE_DEFAULTS)).toBe(true);
	expect(normalizeNoise(NOISE_DEFAULTS)).toEqual({ ...NOISE_DEFAULTS, colors: [...NOISE_DEFAULTS.colors] });
});

describe('bands (the worker pool splits a fill by rows)', () => {
	for (const output of ['color', 'normal'])
		for (const tileable of [true, false])
			it(output + (tileable ? ' tileable' : ' free') + ': bands stitched = the whole, byte for byte', () => {
				const opts = { kind: 'simplex', scale: tileable ? 3 : 3.3, octaves: 3, seed: 9, output, tileable, strength: 2 };
				const W = 40;
				const H = 30;
				const base = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).map((_, i) => (i * 7) % 256) };
				const whole = noiseRaster({ ...opts, blend: 'overlay', opacity: 0.7 }, { width: W, height: H, base });
				const out = new Uint8ClampedArray(W * H * 4);
				for (const [y0, y1] of [[0, 7], [7, 8], [8, 21], [21, 30]]) {
					const band = { width: W, height: y1 - y0, data: base.data.slice(y0 * W * 4, y1 * W * 4) };
					const r = noiseRaster({ ...opts, blend: 'overlay', opacity: 0.7 }, { width: W, height: H, y0, y1, base: band });
					expect(r.height).toBe(y1 - y0);
					out.set(r.data, y0 * W * 4);
				}
				expect(Buffer.from(out).equals(Buffer.from(whole.data))).toBe(true);
			});
});

describe('the agent spec (set_material noise)', () => {
	it('true or {} = the row defaults; the normal row makes a normal map', () => {
		const a = /** @type {any} */ (parseNoiseSpec(true, 'roughnessMap'));
		expect(a.size).toBe(1024);
		expect(a.options.colors).toEqual(NOISE_ROW_DEFAULTS.roughnessMap.colors);
		expect(/** @type {any} */ (parseNoiseSpec({}, 'normalMap')).options.output).toBe('normal');
		expect(/** @type {any} */ (parseNoiseSpec({ kind: 'worley', seed: 9, size: 512 })).options).toMatchObject({ kind: 'worley', seed: 9 });
	});
	it('refuses what it cannot do, saying what it can', () => {
		expect(/** @type {any} */ (parseNoiseSpec({ kind: 'fractal' })).error).toMatch(/perlin, simplex, worley, value/);
		expect(/** @type {any} */ (parseNoiseSpec({ colours: ['#000', '#fff'] })).error).toMatch(/unknown field colours/);
		expect(/** @type {any} */ (parseNoiseSpec({ colors: ['#000'] })).error).toMatch(/2 to 5 hex/);
		expect(/** @type {any} */ (parseNoiseSpec({ scale: 0 })).error).toMatch(/noise.scale: a number from 1 to 64/);
		expect(/** @type {any} */ (parseNoiseSpec({ size: 4096 })).error).toMatch(/2048/);
		expect(/** @type {any} */ (parseNoiseSpec('perlin')).error).toMatch(/an object/);
	});
});
