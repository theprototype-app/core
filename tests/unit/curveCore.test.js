// 68: the one property-track keyframe model — normalize, evaluate, mutate, reduce
import { describe, it, expect } from 'vitest';
import {
	normalizeCurve,
	sampleCurve,
	fromLegacyKeys,
	insertKey,
	moveKeys,
	deleteKeys,
	setInterp,
	setHandle,
	replaceRange,
	hasUserEdits,
	resampleUniform,
	reduceSamples,
	reducePose,
	maxError,
	quatAngleDeg,
	slerp,
	valueError
} from '../../src/lib/curveCore.js';
import {
	normalizeSequence,
	normalizeTrack,
	propsAt,
	contentEnd,
	snapTargets,
	crossedStarts,
	shotAt,
	liveItems
} from '../../src/lib/sequenceCore.js';

// The Animation window's 17-E evaluation, quoted from animationPreview.js (cubicBezierEase +
// sampleTrack) so the migration can be checked against the real thing without three/svelte.
/** @param {number[]} bezier @param {number} x */
function legacyEase(bezier, x) {
	const [x1, y1, x2, y2] = bezier;
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const cx = 3 * x1;
	const bx = 3 * (x2 - x1) - cx;
	const ax = 1 - cx - bx;
	const cy = 3 * y1;
	const by = 3 * (y2 - y1) - cy;
	const ay = 1 - cy - by;
	const bezX = (/** @type {number} */ t) => ((ax * t + bx) * t + cx) * t;
	const bezY = (/** @type {number} */ t) => ((ay * t + by) * t + cy) * t;
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
/** @param {any[]} keys @param {number} s */
function legacySample(keys, s) {
	if (s <= keys[0].t) return keys[0].v;
	const last = keys[keys.length - 1];
	if (s >= last.t) return last.v;
	let i = 0;
	while (i < keys.length - 1 && keys[i + 1].t <= s) i++;
	const a = keys[i];
	const b = keys[i + 1];
	const span = b.t - a.t;
	const x = span > 1e-6 ? (s - a.t) / span : 1;
	const eased = a.ease ? legacyEase(a.ease, x) : x;
	return a.v + (b.v - a.v) * eased;
}

describe('curveCore normalize', () => {
	it('drops bad keys, sorts by time, dedupes ids, keeps unknown fields', () => {
		const keys = normalizeCurve('number', [
			{ id: 'b', t: 2, v: 5, note: 'x' },
			{ id: 'a', t: 1, v: 3 },
			{ id: 'a', t: 3, v: 9 },
			{ t: 'nope', v: 1 },
			{ t: 4, v: null },
			null
		]);
		expect(keys.map((k) => k.id)).toEqual(['a', 'b']);
		expect(keys[1].note).toBe('x');
		expect(keys[0].i).toBe('bezier');
		expect(keys[0].h).toBe('autoClamped');
	});
	it('quat keys are normalized and sign-continuous; never bezier', () => {
		const keys = normalizeCurve('quat', [
			{ t: 0, v: [0, 0, 0, 2] },
			{ t: 1, v: [0, 0, 0, -1], i: 'bezier' }
		]);
		expect(keys[0].v).toEqual([0, 0, 0, 1]);
		expect(keys[1].v[3]).toBe(1); // flipped onto the near hemisphere
		expect(keys[1].i).toBe('linear');
	});
	it('autoClamped never overshoots and an extremum stays flat', () => {
		const keys = normalizeCurve('number', [
			{ t: 0, v: 0 },
			{ t: 1, v: 10 },
			{ t: 2, v: 10.5 },
			{ t: 3, v: 0 }
		]);
		// the peak key is an extremum → flat handles
		expect(keys[2].out[1]).toBeCloseTo(0, 12);
		expect(keys[2].in[1]).toBeCloseTo(0, 12);
		for (let t = 0; t <= 3; t += 0.01) {
			const v = sampleCurve('number', keys, t);
			expect(v).toBeLessThanOrEqual(10.5 + 1e-9);
			expect(v).toBeGreaterThanOrEqual(0 - 1e-9);
		}
	});
	it('every peer derives identical auto handles (pure + deterministic)', () => {
		const raw = [
			{ id: 'x', t: 0, v: 1 },
			{ id: 'y', t: 0.7, v: 4, h: 'auto' },
			{ id: 'z', t: 2, v: -1 }
		];
		expect(JSON.stringify(normalizeCurve('number', raw))).toBe(JSON.stringify(normalizeCurve('number', structuredClone(raw).reverse())));
	});
	it('free handles are stored, clamped to their segment', () => {
		const keys = normalizeCurve('number', [
			{ id: 'a', t: 0, v: 0, h: 'free', out: [5, 10] },
			{ id: 'b', t: 1, v: 1 }
		]);
		expect(keys[0].out[0]).toBeCloseTo(1, 9);
		expect(keys[0].out[1]).toBeCloseTo(2, 9); // scaled with the time clamp: same direction
	});
});

describe('curveCore evaluate', () => {
	it('holds before the first and after the last key', () => {
		const keys = normalizeCurve('number', [
			{ t: 1, v: 2 },
			{ t: 3, v: 6 }
		]);
		expect(sampleCurve('number', keys, 0)).toBe(2);
		expect(sampleCurve('number', keys, 9)).toBe(6);
		expect(sampleCurve('number', [], 1)).toBe(null);
	});
	it('linear, constant and step', () => {
		const lin = normalizeCurve('number', [
			{ t: 0, v: 0, i: 'linear' },
			{ t: 2, v: 10 }
		]);
		expect(sampleCurve('number', lin, 0.5)).toBeCloseTo(2.5, 9);
		const hold = setInterp('number', lin, [lin[0].id], 'constant');
		expect(sampleCurve('number', hold, 1.9)).toBe(0);
		const step = normalizeCurve('step', [
			{ t: 0, v: 1 },
			{ t: 1, v: 0 }
		]);
		expect(sampleCurve('step', step, 0.99)).toBe(1);
		expect(sampleCurve('step', step, 1)).toBe(0);
	});
	it('vec3 bezier evaluates every component on one time parameter', () => {
		const keys = normalizeCurve('vec3', [
			{ t: 0, v: [0, 0, 0], i: 'bezier', h: 'vector' },
			{ t: 1, v: [3, 6, -3], h: 'vector' }
		]);
		// vector handles point at the neighbour by thirds → a straight line in value AND time
		const v = sampleCurve('vec3', keys, 0.25);
		expect(v[0]).toBeCloseTo(0.75, 6);
		expect(v[1]).toBeCloseTo(1.5, 6);
		expect(v[2]).toBeCloseTo(-0.75, 6);
	});
	it('quat segments slerp', () => {
		const a = [0, 0, 0, 1];
		const b = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)]; // 90° about Y
		const keys = normalizeCurve('quat', [
			{ t: 0, v: a },
			{ t: 1, v: b }
		]);
		expect(quatAngleDeg(sampleCurve('quat', keys, 0.5), slerp(a, b, 0.5))).toBeLessThan(1e-4);
		expect(quatAngleDeg(sampleCurve('quat', keys, 0.5), a)).toBeCloseTo(45, 4);
	});
});

describe('curveCore legacy migration (17-E ease → absolute handles)', () => {
	const legacy = [
		{ t: 0, v: 0, ease: [0.42, 0, 0.58, 1] },
		{ t: 0.8, v: 5, ease: [0.25, 0.1, 0.25, 1] },
		{ t: 2, v: -3 },
		{ t: 2.5, v: -3, ease: [0, 0, 0.58, 1] }, // a FLAT eased segment
		{ t: 3, v: -3 },
		{ t: 4, v: 1 }
	];
	it('evaluates identically to the Animation window (within its own 1e-4 solver tolerance)', () => {
		const keys = fromLegacyKeys(legacy);
		for (let t = -0.5; t <= 4.5; t += 0.013) expect(Math.abs(sampleCurve('number', keys, t) - legacySample(legacy, t))).toBeLessThan(2e-3);
	});
	it('a key with no ease is linear; a stepped channel becomes a step curve', () => {
		const keys = fromLegacyKeys(legacy);
		expect(keys[2].i).toBe('linear');
		expect(keys[0].i).toBe('bezier');
		const step = fromLegacyKeys(
			[
				{ t: 0, v: 1 },
				{ t: 1, v: 0 }
			],
			true
		);
		expect(step.every((k) => k.i === 'constant')).toBe(true);
	});
});

describe('curveCore mutators', () => {
	const base = normalizeCurve('number', [
		{ id: 'a', t: 0, v: 0 },
		{ id: 'b', t: 1, v: 1 },
		{ id: 'c', t: 2, v: 0 }
	]);
	it('insertKey replaces a key at the same moment and keeps its id', () => {
		const k = insertKey('number', base, 1, 7);
		expect(k.length).toBe(3);
		expect(k[1]).toMatchObject({ id: 'b', v: 7 });
		expect(insertKey('number', base, 1.5, 3).length).toBe(4);
	});
	it('moveKeys addresses keys by ID (a re-sort does not change what is selected) and marks them user-edited', () => {
		const k = moveKeys('number', base, ['a'], 1.5, 2);
		expect(k.map((x) => x.id)).toEqual(['b', 'a', 'c']);
		expect(k.find((x) => x.id === 'a')).toMatchObject({ t: 1.5, v: 2, src: 'user' });
	});
	it('deleteKeys / setHandle(free) / replaceRange / hasUserEdits', () => {
		expect(deleteKeys('number', base, ['b']).map((k) => k.id)).toEqual(['a', 'c']);
		const h = setHandle('number', base, 'b', 'out', [0.3, 2]);
		expect(h[1].h).toBe('free');
		expect(h[1].out).toEqual([0.3, 2]);
		expect(hasUserEdits(h, 0.5, 1.5)).toBe(true);
		const r = replaceRange('number', base, 0.5, 1.5, [{ id: 'n', t: 1.2, v: 4, src: 'rec' }]);
		expect(r.map((k) => k.id)).toEqual(['a', 'n', 'c']);
		expect(hasUserEdits(r, 0, 2)).toBe(false);
	});
});

describe('curveCore reduction (error bound)', () => {
	// a hand-held wobble: two sines + a slow drift, 30 Hz for 10 s
	const samples = resampleUniform(
		'number',
		Array.from({ length: 301 }, (_, n) => {
			const t = n / 30 + (n % 3 === 1 ? 0.004 : 0); // timestamp jitter
			return { t, v: 2 * Math.sin(t * 1.3) + 0.3 * Math.sin(t * 7.1) + 0.05 * t };
		}),
		30
	);
	it('resamples jittered stamps onto a uniform grid', () => {
		for (let n = 1; n < samples.length - 1; n++) expect(samples[n].t - samples[n - 1].t).toBeCloseTo(1 / 30, 6);
	});
	it('linear RDP stays within budget at every sample', () => {
		const keys = reduceSamples('number', samples, 0.01);
		expect(maxError('number', keys, samples).error).toBeLessThanOrEqual(0.01 + 1e-9);
		expect(keys.length).toBeLessThan(samples.length / 2);
		expect(keys.every((k) => k.src === 'rec')).toBe(true);
	});
	it('the bezier fit stays within budget and never uses more keys than linear', () => {
		const lin = reduceSamples('number', samples, 0.01);
		const bez = reduceSamples('number', samples, 0.01, { fit: 'bezier' });
		expect(maxError('number', bez, samples).error).toBeLessThanOrEqual(0.01 + 1e-9);
		expect(bez.length).toBeLessThanOrEqual(lin.length);
	});
	it('a pose reduces with SHARED key times inside 1 cm / 0.5°', () => {
		const pose = Array.from({ length: 300 }, (_, n) => {
			const t = n / 30;
			const yaw = 0.6 * Math.sin(t * 0.8);
			return {
				t,
				pos: [Math.sin(t) * 2, 1.6 + 0.02 * Math.sin(t * 9), t * 0.5],
				quat: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
			};
		});
		const { position, quaternion } = reducePose(pose, { pos: 0.01, angDeg: 0.5 });
		expect(position.map((k) => k.t)).toEqual(quaternion.map((k) => k.t));
		expect(position.length).toBeLessThan(150);
		for (const s of pose) {
			expect(valueError('vec3', s.pos, sampleCurve('vec3', position, s.t))).toBeLessThanOrEqual(0.01 + 1e-9);
			expect(quatAngleDeg(s.quat, sampleCurve('quat', quaternion, s.t))).toBeLessThanOrEqual(0.5 + 1e-6);
		}
	});
});

describe('sequenceCore prop tracks', () => {
	const seq = normalizeSequence({
		id: 's',
		duration: 10,
		tracks: [
			{ id: 'cam', kind: 'camera', items: [{ id: 'shot', t: 0, dur: 4, camera: 'C' }] },
			{
				id: 'fov',
				kind: 'prop',
				target: 'C',
				path: 'camera.fov',
				type: 'number',
				raw: { hash: 'abc', rate: 30 },
				keys: [
					{ id: 'k1', t: 0, v: 50, i: 'linear' },
					{ id: 'k2', t: 6, v: 20 }
				]
			},
			{ id: 'pos', kind: 'prop', target: 'C', path: 'position', type: 'vec3', muted: true, keys: [{ t: 0, v: [0, 0, 0] }] }
		]
	});
	it('normalizes a prop track (curve keys, raw rides through, no items)', () => {
		const tr = seq.tracks[1];
		expect(tr.kind).toBe('prop');
		expect(tr.items).toEqual([]);
		expect(tr.raw).toEqual({ hash: 'abc', rate: 30 });
		expect(tr.keys[0].h).toBe('autoClamped');
		expect(normalizeTrack({ kind: 'prop', type: 'weird' }).type).toBe('number');
	});
	it('propsAt evaluates unmuted prop tracks and honours the skip set', () => {
		const at = propsAt(seq, 3);
		expect(at.length).toBe(1);
		expect(at[0]).toMatchObject({ target: 'C', path: 'camera.fov' });
		expect(at[0].value).toBeCloseTo(35, 9);
		expect(propsAt(seq, 3, new Set(['C']))).toEqual([]);
	});
	it('shots, crossings and live items ignore prop tracks; the content end and snapping see keys', () => {
		expect(shotAt(seq, 1)?.item.id).toBe('shot');
		expect(crossedStarts(seq, -1, 10).map((c) => c.track.id)).toEqual(['cam']);
		expect(liveItems(seq, 1, 'prop')).toEqual([]);
		expect(contentEnd(seq)).toBe(6);
		expect(snapTargets(seq)).toContain(6);
	});
});
