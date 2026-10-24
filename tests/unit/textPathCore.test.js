// @ts-nocheck — plain fixtures; the code under test is typed
// 64 D2: text on a path, headless — the record boundary, the curves, arc-length sampling and the
// per-glyph layout (a letter lands on the path, turned to its tangent, with its own size /
// offset / rotation), plus the glyph -> character recovery and the letter remap on text edits.
import { describe, it, expect } from 'vitest';
import {
	normalizeTextPath,
	normalizeLetterStyle,
	remapLetters,
	builtinPolyline,
	makeSampler,
	letterFrame,
	layoutOnPath,
	mergeLetterStyles,
	indexColorRanges,
	decodeGlyphChars,
	glyphColors,
	glyphQuads,
	TEXT_PATH_DEFAULTS,
	TEXT_FONTS,
	MAX_TEXT
} from '../../src/lib/textPathCore.js';

const close = (a, b, eps = 1e-5) => expect(Math.abs(a - b)).toBeLessThan(eps);

/** a fake troika layout: n one-em-wide characters on one line, a glyph per char */
function fakeInfo(n, { advance = 1, lines = 1, lh = 1.2 } = {}) {
	const caret = [];
	const bounds = [];
	const chars = [];
	const perLine = Math.ceil(n / lines);
	for (let c = 0; c < n; c++) {
		const k = Math.floor(c / perLine);
		const x = (c % perLine) * advance;
		caret.push(x, x + advance, -0.2 - k * lh);
		bounds.push(x + 0.1, -k * lh, x + advance - 0.1, 0.7 - k * lh);
		chars.push(c);
	}
	return { glyphBounds: new Float32Array(bounds), glyphChars: Int32Array.from(chars), caretPositions: new Float32Array(caret), lineHeight: lh, fontSize: 1 };
}

/** apply glyph g's affine rows to a point */
function apply(rows, g, x, y) {
	const o = g * 12;
	return [0, 1, 2].map((i) => rows[o + i * 4] * x + rows[o + i * 4 + 1] * y + rows[o + i * 4 + 3]);
}

const flatLine = (len) => makeSampler({ points: [[0, 0, 0], [len, 0, 0]], closed: false });
const P = { normal: [0, 0, 1], orient: 'flat', align: 'start', offset: 0, shift: 0 };

describe('normalizeTextPath', () => {
	it('defaults for garbage, clamps and types every field', () => {
		const d = normalizeTextPath(null);
		expect(d.text).toBe(TEXT_PATH_DEFAULTS.text);
		expect(d.path.kind).toBe('arc');
		const r = normalizeTextPath({ text: 42, font: 'comic', size: -3, color: 'red', spacing: 99, align: 'justify', side: 'up', orient: 'x', offset: 7, path: { kind: 'spiral', radius: 1e9, sweep: 0 } });
		expect(r.text).toBe(TEXT_PATH_DEFAULTS.text);
		expect(r.font).toBe('sans');
		expect(r.size).toBe(0.01);
		expect(r.color).toBe('#ffffff');
		expect(r.spacing).toBe(5);
		expect(r.align).toBe('center');
		expect(r.side).toBe('left');
		expect(r.orient).toBe('auto');
		expect(r.offset).toBe(1);
		expect(r.path).toMatchObject({ kind: 'arc', radius: 100, sweep: 5 });
	});
	it('caps the text by code points and keeps only real fonts', () => {
		expect(Array.from(normalizeTextPath({ text: '😀'.repeat(MAX_TEXT + 9) }).text).length).toBe(MAX_TEXT);
		for (const f of TEXT_FONTS) expect(normalizeTextPath({ font: f.id }).font).toBe(f.id);
	});
	it('a link without a target falls back to the default curve', () => {
		expect(normalizeTextPath({ path: { kind: 'object' } }).path.kind).toBe('arc');
		expect(normalizeTextPath({ path: { kind: 'object', target: 'abc' } }).path).toMatchObject({ kind: 'object', target: 'abc' });
	});
	it('letters: valid indices only, untouched fields dropped, empty styles gone', () => {
		const r = normalizeTextPath({ text: 'abc', letters: { 0: { color: '#FF0000', size: 1, dx: 0 }, 1: { size: 1 }, 2: { rot: 45, dy: 0.5 }, 9: { size: 2 }, x: { size: 2 } } });
		expect(r.letters).toEqual({ 0: { color: '#ff0000' }, 2: { dy: 0.5, rot: 45 } });
		expect(normalizeLetterStyle({ size: 99, dx: -99 })).toEqual({ size: 10, dx: -20 });
		expect(normalizeLetterStyle({})).toBe(null);
	});
	it('is idempotent (the record a peer receives equals the one it would send back)', () => {
		const r = normalizeTextPath({ text: 'Hello', letters: { 1: { color: '#00ff00' } }, path: { kind: 'wave' } });
		expect(normalizeTextPath(JSON.parse(JSON.stringify(r)))).toEqual(r);
	});
});

describe('remapLetters', () => {
	const letters = { 0: { color: '#ff0000' }, 4: { size: 2 } };
	it('a prepended letter shifts every style one place', () => {
		expect(remapLetters('Hello', 'xHello', letters)).toEqual({ 1: { color: '#ff0000' }, 5: { size: 2 } });
	});
	it('an appended letter keeps every index', () => {
		expect(remapLetters('Hello', 'Hello!', letters)).toEqual(letters);
	});
	it('an edited middle drops only the edited letters', () => {
		expect(remapLetters('Hello', 'HeLLo', letters)).toEqual(letters);
		expect(remapLetters('Hello', 'Hxo', letters)).toEqual({ 0: { color: '#ff0000' }, 2: { size: 2 } });
	});
});

describe('curves and the sampler', () => {
	it('an arc is centred on the origin and reads clockwise over the top', () => {
		const line = builtinPolyline({ kind: 'arc', radius: 2, sweep: 180 });
		const s = makeSampler(line);
		close(s.total, Math.PI * 2, 0.01); // half of a 2 m circle, sampled
		const mid = s.pointAt(s.total / 2);
		close(mid[0], 0, 1e-3);
		close(mid[1], 2, 1e-3);
		const t = s.tangentAt(s.total / 2);
		close(t[0], 1, 1e-3); // clockwise: heading +x at the crown
	});
	it('a circle is closed and its centre point is the crown', () => {
		const s = makeSampler(builtinPolyline({ kind: 'circle', radius: 1 }));
		expect(s.closed).toBe(true);
		close(s.total, Math.PI * 2, 0.01);
		const top = s.pointAt(s.total / 2);
		close(top[1], 1, 1e-3);
	});
	it('line and wave lengths, arc length lookups, side=right walks backwards', () => {
		const line = makeSampler(builtinPolyline({ kind: 'line', length: 4 }));
		close(line.total, 4);
		expect(line.pointAt(1)).toEqual([-1, 0, 0]);
		const back = makeSampler(builtinPolyline({ kind: 'line', length: 4 }), true);
		expect(back.pointAt(1)).toEqual([1, 0, 0]);
		expect(back.tangentAt(1)[0]).toBe(-1);
		const wave = makeSampler(builtinPolyline({ kind: 'wave', length: 4, amplitude: 0.5, wavelength: 2 }));
		expect(wave.total).toBeGreaterThan(4);
	});
	it('a degenerate polyline does not throw', () => {
		const s = makeSampler({ points: [[1, 1, 1], [1, 1, 1]] });
		expect(Number.isFinite(s.total)).toBe(true);
		expect(s.pointAt(0).every(Number.isFinite)).toBe(true);
	});
	it('letter frames: flat lies in the plane, upright stands along the normal', () => {
		const [x, y, z] = letterFrame([1, 0, 0], [0, 0, 1], 'flat');
		expect(y.map((v) => Math.round(v))).toEqual([0, 1, 0]);
		expect(z.map((v) => Math.round(v))).toEqual([0, 0, 1]);
		const [, yu] = letterFrame([1, 0, 0], [0, 1, 0], 'upright');
		expect(yu.map((v) => Math.round(v))).toEqual([0, 1, 0]);
		const [, yf] = letterFrame([1, 0, 0], [0, 1, 0], 'flat'); // lying on the ground, up = left of travel
		expect(yf.map((v) => Math.round(v))).toEqual([0, 0, -1]);
		expect(x).toEqual([1, 0, 0]);
	});
});

describe('layoutOnPath', () => {
	it('on a straight path the layout is the straight layout', () => {
		const info = fakeInfo(3);
		const { rows, hidden } = layoutOnPath(info, mergeLetterStyles(3, {}), flatLine(10), P);
		expect([...hidden]).toEqual([0, 0, 0]);
		for (let g = 0; g < 3; g++) {
			const p = apply(rows, g, g + 0.1, 0.7);
			close(p[0], g + 0.1);
			close(p[1], 0.7);
		}
	});
	it('alignment: center and end shift the line along the path; offset adds a fraction of it', () => {
		const info = fakeInfo(2);
		const c = layoutOnPath(info, mergeLetterStyles(2, {}), flatLine(10), { ...P, align: 'center' }).rows;
		close(apply(c, 0, 0.5, 0)[0], 4.5); // line width 2, centred on 5
		const e = layoutOnPath(info, mergeLetterStyles(2, {}), flatLine(10), { ...P, align: 'end' }).rows;
		close(apply(e, 1, 1.5, 0)[0], 9.5);
		const o = layoutOnPath(info, mergeLetterStyles(2, {}), flatLine(10), { ...P, offset: 0.1 }).rows;
		close(apply(o, 0, 0.5, 0)[0], 1.5);
	});
	it('fit spreads the letters to the ends', () => {
		const info = fakeInfo(3);
		const { rows } = layoutOnPath(info, mergeLetterStyles(3, {}), flatLine(10), { ...P, align: 'fit' });
		close(apply(rows, 0, 0.5, 0)[0], 0.5);
		close(apply(rows, 2, 2.5, 0)[0], 9.5);
	});
	it('letters past the end of an open path are hidden; a closed path wraps them', () => {
		const info = fakeInfo(5);
		const open = layoutOnPath(info, mergeLetterStyles(5, {}), flatLine(3), P);
		expect([...open.hidden]).toEqual([0, 0, 0, 1, 1]);
		expect(Array.from(open.rows.slice(36, 48)).every((v) => v === 0)).toBe(true);
		const ring = makeSampler({ points: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], closed: true });
		expect([...layoutOnPath(info, mergeLetterStyles(5, {}), ring, P).hidden]).toEqual([0, 0, 0, 0, 0]);
	});
	it('on a circle each letter sits on the circle, turned to its tangent', () => {
		const info = fakeInfo(4, { advance: 0.5 });
		const s = makeSampler(builtinPolyline({ kind: 'circle', radius: 2 }));
		const { rows } = layoutOnPath(info, mergeLetterStyles(4, {}), s, { ...P, align: 'center' });
		for (let g = 0; g < 4; g++) {
			const pivot = apply(rows, g, g * 0.5 + 0.25, 0); // the advance centre on the baseline
			close(Math.hypot(pivot[0], pivot[1]), 2, 2e-3);
			const up = apply(rows, g, g * 0.5 + 0.25, 1);
			// flat in the circle's plane, the letters' up points away from the centre (outside, read clockwise)
			expect(Math.hypot(up[0], up[1])).toBeGreaterThan(2.9);
		}
	});
	it('side=right puts the letters on the other side of the curve', () => {
		const info = fakeInfo(2, { advance: 0.5 });
		const s = makeSampler(builtinPolyline({ kind: 'circle', radius: 2 }), true);
		const { rows } = layoutOnPath(info, mergeLetterStyles(2, {}), s, { ...P, align: 'center' });
		const up = apply(rows, 0, 0.25, 1);
		expect(Math.hypot(up[0], up[1])).toBeLessThan(1.1);
	});
	it('per-letter size scales about the letter and pushes the rest along', () => {
		const info = fakeInfo(3);
		const styles = mergeLetterStyles(3, { 1: { size: 2 } });
		const { rows } = layoutOnPath(info, styles, flatLine(10), P);
		// letter 1's advance doubles: its centre moves to 2.0, its top to 2*0.7
		const top = apply(rows, 1, 1.5, 0.7);
		close(top[0], 2);
		close(top[1], 1.4);
		// letter 2 follows the wider advance
		close(apply(rows, 2, 2.5, 0)[0], 3.5);
	});
	it('per-letter offset (em) and rotation (degrees) about the letter', () => {
		const info = fakeInfo(1);
		const { rows } = layoutOnPath({ ...info, fontSize: 2 }, mergeLetterStyles(1, { 0: { dx: 0.5, dy: 1, rot: 90 } }), flatLine(10), P);
		const pivot = apply(rows, 0, 0.5, 0);
		close(pivot[0], 0.5 + 1);
		close(pivot[1], 2);
		const right = apply(rows, 0, 1.5, 0); // one unit right of the pivot turns to one unit up
		close(right[0], 1.5);
		close(right[1], 3);
	});
	it('shift moves the baseline off the path; a second line runs below the first', () => {
		const info = fakeInfo(4, { lines: 2, lh: 1.2 });
		const { rows } = layoutOnPath(info, mergeLetterStyles(4, {}), flatLine(10), { ...P, shift: 0.3 });
		close(apply(rows, 0, 0.5, 0)[1], 0.3);
		const second = apply(rows, 2, 0.5, -1.2);
		close(second[0], 0.5); // the second line restarts at the path's start
		close(second[1], -1.2 + 0.3);
	});
	it('upright on a ground path stands the letters up', () => {
		const info = fakeInfo(1);
		const s = makeSampler({ points: [[0, 0, 0], [0, 0, -5]] }); // heading -z on the ground
		const { rows } = layoutOnPath(info, mergeLetterStyles(1, {}), s, { ...P, normal: [0, 1, 0], orient: 'upright' });
		const top = apply(rows, 0, 0.5, 0.7);
		close(top[1], 0.7);
		close(top[2], -0.5);
	});
});

describe('glyphs <-> characters, colours, the hit proxy', () => {
	it('index colour ranges decode back to character indices', () => {
		const ranges = indexColorRanges(70000);
		expect(ranges[66000]).toBe(66000);
		const bytes = new Uint8Array([0, 0, 2, 0, 1, 1, 1, 0, 0]);
		expect([...decodeGlyphChars(bytes)]).toEqual([2, 257, 65536]);
		expect(decodeGlyphChars(null).length).toBe(0);
	});
	it('glyph colours: a letter colour wins over the base', () => {
		const out = glyphColors([0, 1], mergeLetterStyles(2, { 1: { color: '#ff8000' } }), '#0000ff');
		expect([...out]).toEqual([0, 0, 255, 255, 128, 0]);
	});
	it('mergeLetterStyles: an override adds offsets, multiplies size, replaces colour', () => {
		const [s] = mergeLetterStyles(1, { 0: { size: 2, dx: 1, color: '#111111' } }, [{ size: 0.5, dx: 1, rot: 10, color: '#222222', opacity: 0.5 }]);
		expect(s).toEqual({ color: '#222222', size: 1, dx: 2, dy: 0, rot: 10, opacity: 0.5 });
	});
	it('the hit proxy is one quad per visible glyph, on the path', () => {
		const info = fakeInfo(5);
		const { rows, hidden } = layoutOnPath(info, mergeLetterStyles(5, {}), flatLine(3), P);
		const { positions, index } = glyphQuads(info.glyphBounds, rows, hidden);
		expect(positions.length).toBe(3 * 4 * 3);
		expect(index.length).toBe(3 * 6);
		close(positions[0], 0.1);
	});
});
