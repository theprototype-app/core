// @ts-nocheck -- fixture-heavy: reference implementations and random clips, typed by their use
// 102 M8: Timeline curves — one evaluation, key modes, presets, value entry, copy / paste,
// the angle unwrap guard and the export maps (CUBICSPLINE when exact, sampled with a bound).
import { describe, it, expect } from 'vitest';
import { normalizeCurve, sampleCurve, fromLegacyKeys, easeSegment, sampleLegacyKeys, setHandle } from '../../src/lib/curveCore.js';
import {
	setKeyMode,
	keyModeOf,
	applyPreset,
	setKeys,
	copyKeys,
	pasteKeys,
	unwrapNear,
	unwrapSeries,
	valueBounds,
	toCubicSpline,
	sampleCubicSpline,
	sampleForExport,
	exportError
} from '../../src/lib/curveEdit.js';
import { sampleTrack, cubicBezierEase } from '../../src/lib/animationPreview.js';

// the 17-E evaluation exactly as v1.72.0 shipped it in animationPreview.js (the reference)
function refEase(bezier, x) {
	const [x1, y1, x2, y2] = bezier;
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const cx = 3 * x1;
	const bx = 3 * (x2 - x1) - cx;
	const ax = 1 - cx - bx;
	const cy = 3 * y1;
	const by = 3 * (y2 - y1) - cy;
	const ay = 1 - cy - by;
	const bezX = (t) => ((ax * t + bx) * t + cx) * t;
	const bezY = (t) => ((ay * t + by) * t + cy) * t;
	let lo = 0;
	let hi = 1;
	let t = x;
	for (let i = 0; i < 24; i++) {
		const xEst = bezX(t);
		if (Math.abs(xEst - x) < 1e-4) break;
		if (xEst < x) lo = t;
		else hi = t;
		t = (lo + hi) / 2;
	}
	return bezY(t);
}
function refSample(track, seconds, stepped) {
	const keys = track?.keys;
	if (!keys?.length) return null;
	if (seconds <= keys[0].t) return keys[0].v;
	const last = keys[keys.length - 1];
	if (seconds >= last.t) return last.v;
	let i = 0;
	while (i < keys.length - 1 && keys[i + 1].t <= seconds) i++;
	const a = keys[i];
	const b = keys[i + 1];
	if (stepped) return a.v;
	const span = b.t - a.t;
	const x = span > 1e-6 ? (seconds - a.t) / span : 1;
	const eased = a.ease ? refEase(a.ease, x) : x;
	return a.v + (b.v - a.v) * eased;
}

// a seeded generator, so a failure reproduces
function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}
function randomLegacy(r, n) {
	const keys = [];
	let t = 0;
	for (let k = 0; k < n; k++) {
		t += 0.1 + r() * 2;
		const key = { t, v: (r() - 0.5) * 10 };
		if (r() < 0.7) key.ease = [r(), (r() - 0.5) * 3, r(), (r() - 0.5) * 3];
		keys.push(key);
	}
	return keys;
}

const lin = (pairs) => normalizeCurve('number', pairs.map(([t, v], n) => ({ id: 'k' + n, t, v })));

describe('one evaluation (legacy Animation-window keys)', () => {
	it('sampleTrack / cubicBezierEase are byte-identical to the 1.72 implementation', () => {
		const r = rng(102);
		for (let c = 0; c < 40; c++) {
			const keys = randomLegacy(r, 2 + Math.floor(r() * 6));
			const end = keys[keys.length - 1].t + 0.5;
			for (const channel of ['pos.x', 'visible']) {
				const track = { id: 't', channel, keys };
				for (let s = -0.2; s <= end; s += 0.037) {
					expect(sampleTrack(track, s)).toBe(refSample(track, s, channel === 'visible'));
					expect(sampleLegacyKeys(keys, s, channel === 'visible')).toBe(refSample(track, s, channel === 'visible'));
				}
			}
			const e = keys.find((k) => k.ease)?.ease ?? [0.42, 0, 0.58, 1];
			for (let x = -0.1; x <= 1.1; x += 0.05) expect(cubicBezierEase(e, x)).toBe(refEase(e, x));
		}
		expect(sampleTrack(null, 1)).toBe(null);
		expect(sampleTrack({ channel: 'pos.x', keys: [] }, 1)).toBe(null);
	});

	it('fromLegacyKeys + sampleCurve evaluates the same curve (the migration a later lane runs)', () => {
		const r = rng(7);
		let worst = 0;
		for (let c = 0; c < 40; c++) {
			const keys = randomLegacy(r, 2 + Math.floor(r() * 6));
			const curve = fromLegacyKeys(keys);
			const end = keys[keys.length - 1].t;
			for (let s = 0; s <= end; s += 0.013) {
				// error as a fraction of the segment's own height: the legacy bisection stops at 1e-4 in
				// x (so a steep ease is off by slope x 1e-4), curveCore solves to 1e-9
				const n = Math.max(0, keys.findLastIndex((k) => k.t <= s));
				const dv = Math.abs((keys[Math.min(n + 1, keys.length - 1)].v ?? 0) - keys[n].v) || 1;
				worst = Math.max(worst, Math.abs(sampleCurve('number', curve, s) - sampleLegacyKeys(keys, s)) / dv);
			}
		}
		expect(worst).toBeLessThan(5e-3); // half a percent of the segment height
	});
});

describe('key modes', () => {
	it('maps the brief modes onto i / h and back', () => {
		let keys = lin([[0, 0], [1, 1], [2, 0]]);
		expect(keyModeOf(keys[1])).toBe('auto');
		for (const mode of ['auto', 'autoOver', 'aligned', 'free', 'linear', 'stepped']) {
			keys = setKeyMode('number', keys, ['k1'], mode);
			expect(keyModeOf(keys[1])).toBe(mode);
		}
		expect(setKeyMode('number', keys, ['k1'], 'nope')).toBe(keys);
	});

	it('stepped holds; linear is straight; broken handles move one side only', () => {
		let keys = setKeyMode('number', lin([[0, 0], [1, 1]]), ['k0'], 'stepped');
		expect(sampleCurve('number', keys, 0.9)).toBe(0);
		keys = setKeyMode('number', keys, ['k0'], 'linear');
		expect(sampleCurve('number', keys, 0.25)).toBeCloseTo(0.25, 9);
		keys = setKeyMode('number', lin([[0, 0], [1, 1], [2, 0]]), ['k1'], 'free');
		const before = keys[1].in.slice();
		keys = setHandle('number', keys, 'k1', 'out', [0.3, 0.4]);
		expect(keys[1].in).toEqual(before);
		expect(keys[1].out).toEqual([0.3, 0.4]);
	});
});

describe('ease presets', () => {
	it('ease in / out / in-out evaluate like the CSS curve on a rising segment', () => {
		for (const [name, bez] of [
			['easeIn', [0.42, 0, 1, 1]],
			['easeOut', [0, 0, 0.58, 1]],
			['easeInOut', [0.42, 0, 0.58, 1]]
		]) {
			const keys = applyPreset('number', lin([[1, 2], [3, 6]]), ['k0'], name);
			for (let x = 0.05; x < 1; x += 0.1) expect(sampleCurve('number', keys, 1 + 2 * x)).toBeCloseTo(2 + 4 * easeSegment(bez, x), 2);
		}
	});

	it('overshoot passes the end value; anticipate dips below the start', () => {
		const over = applyPreset('number', lin([[0, 0], [1, 1]]), ['k0'], 'overshoot');
		let max = -Infinity;
		for (let t = 0; t <= 1; t += 0.01) max = Math.max(max, sampleCurve('number', over, t));
		expect(max).toBeGreaterThan(1.05);
		const ant = applyPreset('number', lin([[0, 0], [1, 1]]), ['k0'], 'anticipate');
		let min = Infinity;
		for (let t = 0; t <= 1; t += 0.01) min = Math.min(min, sampleCurve('number', ant, t));
		expect(min).toBeLessThan(-0.05);
	});

	it('bounce touches the end value three times before it lands and never passes it', () => {
		const keys = applyPreset('number', lin([[0, 0], [2.75, 1]]), ['k0'], 'bounce');
		expect(keys.length).toBe(8);
		for (const t of [1, 2, 2.5]) expect(sampleCurve('number', keys, t)).toBeCloseTo(1, 9);
		expect(sampleCurve('number', keys, 1.5)).toBeCloseTo(0.75, 9);
		for (let t = 0; t <= 2.75; t += 0.01) expect(sampleCurve('number', keys, t)).toBeLessThanOrEqual(1 + 1e-9);
	});

	it('vec3 presets ease every component; quat takes only linear / stepped', () => {
		const v = normalizeCurve('vec3', [
			{ id: 'a', t: 0, v: [0, 0, 0] },
			{ id: 'b', t: 1, v: [1, 2, -3] }
		]);
		const e = applyPreset('vec3', v, ['a'], 'easeIn');
		const mid = sampleCurve('vec3', e, 0.5);
		const k = easeSegment([0.42, 0, 1, 1], 0.5);
		expect(mid[0]).toBeCloseTo(k, 2);
		expect(mid[1]).toBeCloseTo(2 * k, 2);
		expect(mid[2]).toBeCloseTo(-3 * k, 2);
		const q = normalizeCurve('quat', [
			{ id: 'a', t: 0, v: [0, 0, 0, 1] },
			{ id: 'b', t: 1, v: [0, 1, 0, 0] }
		]);
		expect(applyPreset('quat', q, ['a'], 'easeIn')).toBe(q);
		expect(applyPreset('quat', q, ['a'], 'stepped')[0].i).toBe('constant');
	});

	it('a key with no next key is left alone; flat segments stay flat', () => {
		const keys = lin([[0, 1], [1, 1]]);
		const out = applyPreset('number', keys, ['k1'], 'easeInOut');
		expect(out.map((k) => k.v)).toEqual([1, 1]);
		const flat = applyPreset('number', keys, ['k0'], 'overshoot');
		for (let t = 0; t <= 1; t += 0.1) expect(sampleCurve('number', flat, t)).toBeCloseTo(1, 9);
	});
});

describe('value entry, copy and paste', () => {
	it('setKeys moves a key in time and value; landing on another key replaces it', () => {
		let keys = lin([[0, 0], [1, 1], [2, 2]]);
		keys = setKeys('number', keys, ['k1'], { v: 5 });
		expect(keys[1].v).toBe(5);
		expect(keys[1].src).toBe('user');
		keys = setKeys('number', keys, ['k1'], { t: 2 });
		expect(keys.map((k) => k.id)).toEqual(['k0', 'k1']);
		expect(setKeys('number', keys, ['k1'], { v: 'x' })[1].v).toBe(5);
	});

	it('copy / paste keeps shape and spacing, fresh ids, replaces keys at the same moments', () => {
		const src = applyPreset('number', lin([[1, 0], [2, 1], [4, 3]]), ['k0'], 'easeIn');
		const clip = copyKeys('number', src, ['k0', 'k1']);
		expect(clip.keys.map((k) => k.t)).toEqual([0, 1]);
		const dest = lin([[0, 9], [10, 9]]);
		const { keys, ids } = pasteKeys('number', dest, clip, 10);
		expect(ids.length).toBe(2);
		expect(keys.map((k) => k.t)).toEqual([0, 10, 11]);
		expect(keys.find((k) => k.t === 10).id).not.toBe('k0');
		for (let x = 0.1; x < 1; x += 0.2) expect(sampleCurve('number', keys, 10 + x)).toBeCloseTo(sampleCurve('number', src, 1 + x), 9);
	});

	it('refuses a clip of another shape', () => {
		const clip = copyKeys('number', lin([[0, 0]]), ['k0']);
		const v = normalizeCurve('vec3', [{ id: 'a', t: 0, v: [0, 0, 0] }]);
		expect(pasteKeys('vec3', v, clip, 1).keys).toBe(v);
		expect(copyKeys('number', lin([[0, 0]]), ['nope'])).toBe(null);
	});

	it('the angle guard: a pasted rotation lands on the nearest whole turn', () => {
		const clip = copyKeys('number', lin([[0, -3.1], [1, -2.9]]), ['k0', 'k1']);
		const dest = lin([[0, 3.1]]);
		const { keys } = pasteKeys('number', dest, clip, 1, { period: 2 * Math.PI });
		expect(keys[1].v).toBeCloseTo(-3.1 + 2 * Math.PI, 9);
		expect(Math.abs(keys[1].v - keys[0].v)).toBeLessThan(0.2);
	});
});

describe('rotations: unwrap', () => {
	it('unwrapNear / unwrapSeries take the short way', () => {
		const d = Math.PI / 180;
		expect(unwrapNear(-179 * d, 179 * d, 2 * Math.PI) / d).toBeCloseTo(181, 9);
		expect(unwrapNear(10, 10, 0)).toBe(10);
		const s = unwrapSeries([170, -170, -150, 170].map((x) => x * d)).map((x) => x / d);
		expect(s[1]).toBeCloseTo(190, 9);
		expect(s[2]).toBeCloseTo(210, 9);
		expect(s[3]).toBeCloseTo(170, 9);
	});
});

describe('frame all', () => {
	it('valueBounds covers keys and handles', () => {
		const keys = applyPreset('number', lin([[0, 0], [1, 1]]), ['k0'], 'overshoot');
		const b = valueBounds('number', keys);
		expect(b.lo).toBe(0);
		expect(b.hi).toBeGreaterThan(1.5);
		expect(valueBounds('number', [])).toBe(null);
	});
});

describe('export maps', () => {
	it('an auto curve is EXACT as CUBICSPLINE (handles at thirds) and evaluates the same', () => {
		const keys = lin([[0, 0], [0.7, 2], [1.5, -1], [3, 4]]);
		const cs = toCubicSpline('number', keys);
		expect(cs).not.toBe(null);
		expect(cs.values.length).toBe(4 * 3);
		for (let t = 0; t <= 3; t += 0.01) expect(sampleCubicSpline(cs.times, cs.values, 1, t)[0]).toBeCloseTo(sampleCurve('number', keys, t), 6);
	});

	it('vec3 and mixed linear segments map exactly too', () => {
		const keys = setKeyMode(
			'vec3',
			normalizeCurve('vec3', [
				{ id: 'a', t: 0, v: [0, 0, 0] },
				{ id: 'b', t: 1, v: [1, 2, 3] },
				{ id: 'c', t: 2.5, v: [0, -1, 1] }
			]),
			['b'],
			'linear'
		);
		const cs = toCubicSpline('vec3', keys);
		expect(cs).not.toBe(null);
		for (let t = 0; t <= 2.5; t += 0.02) {
			const a = sampleCubicSpline(cs.times, cs.values, 3, t);
			const b = sampleCurve('vec3', keys, t);
			for (let c = 0; c < 3; c++) expect(a[c]).toBeCloseTo(b[c], 6);
		}
	});

	it('a handle off the third, a stepped segment or a quat is NOT exact (null → resample)', () => {
		expect(toCubicSpline('number', applyPreset('number', lin([[0, 0], [1, 1]]), ['k0'], 'easeIn'))).toBe(null);
		expect(toCubicSpline('number', setKeyMode('number', lin([[0, 0], [1, 1]]), ['k0'], 'stepped'))).toBe(null);
		expect(toCubicSpline('quat', normalizeCurve('quat', [{ t: 0, v: [0, 0, 0, 1] }, { t: 1, v: [0, 0, 0, 1] }]))).toBe(null);
	});

	it('the sampled bake has every key as a sample and a bounded error that shrinks with the rate', () => {
		const keys = applyPreset('number', lin([[0, 0], [1.013, 1], [2, 0]]), ['k0'], 'easeInOut');
		const { times, values } = sampleForExport('number', keys, 30);
		expect(times).toContain(1.013);
		expect(values[times.indexOf(1.013)]).toBe(1);
		const e30 = exportError('number', keys, 30);
		const e60 = exportError('number', keys, 60);
		expect(e30).toBeLessThan(0.01); // a unit move: under 1 % at 30 fps
		expect(e60).toBeLessThan(e30 / 2.5); // second order: ~4x smaller at twice the rate
		const step = setKeyMode('number', lin([[0, 0], [1, 1], [2, 0]]), ['k0', 'k1'], 'stepped');
		expect(exportError('number', step, 30)).toBe(0);
	});
});
