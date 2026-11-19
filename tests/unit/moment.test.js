// @ts-nocheck — a fixture suite (fake frames on a fake clock)
import { describe, it, expect } from 'vitest';
import {
	createMomentRing,
	momentBlocker,
	momentBlockerText,
	isLowMemory,
	momentFrameSize,
	clampTrim,
	defaultTrim,
	resampleFrames,
	momentFileName,
	createCostMeter,
	MOMENT_SECONDS,
	MOMENT_FPS,
	MOMENT_MAX_TRIM,
	MOMENT_MIN_TRIM
} from '../../src/lib/moment/momentCore.js';

// 95 SM1-SM3: the moment buffer's pure half — the rolling window on a FAKE clock, the eviction,
// the rate cap, when the buffer may run at all, the trim and the resample to the file's length.

/** a fake game: `seconds` of frames at `hz`, captured through the ring's own rate gate */
function play(ring, seconds, hz, { from = 0, bytes = 40_000 } = {}) {
	let kept = 0;
	for (let i = 0; i <= Math.round(seconds * hz); i++) {
		const t = from + i / hz;
		if (ring.due(t)) {
			ring.push({ t, bytes, data: i });
			kept++;
		}
	}
	return kept;
}

describe('moment ring (SM1)', () => {
	it('keeps only the last 10 s of a long Play', () => {
		const ring = createMomentRing();
		play(ring, 60, 60);
		const f = ring.frames();
		expect(ring.seconds).toBe(MOMENT_SECONDS);
		expect(f[f.length - 1].t).toBeCloseTo(60, 5);
		expect(f[0].t).toBeGreaterThanOrEqual(50 - 1e-9);
		expect(ring.span()).toBeLessThanOrEqual(10 + 1e-9);
		expect(ring.span()).toBeGreaterThan(9.8);
	});
	it('captures at the capped rate, not the display rate', () => {
		const ring = createMomentRing();
		play(ring, 10, 60);
		// 15 fps over 10 s ≈ 150 frames (+1 for the closed interval), never the 600 a 60 Hz game draws
		expect(ring.count()).toBeGreaterThanOrEqual(MOMENT_FPS * 10 - 2);
		expect(ring.count()).toBeLessThanOrEqual(MOMENT_FPS * 10 + 2);
	});
	it('a slow game keeps what it drew (no invented frames)', () => {
		const ring = createMomentRing();
		play(ring, 10, 4);
		expect(ring.count()).toBe(41);
	});
	it('evicts oldest first, through onEvict, and the byte cap bites too', () => {
		const evicted = [];
		const ring = createMomentRing({ maxBytes: 1_000_000, onEvict: (f) => evicted.push(f.data) });
		play(ring, 10, 60, { bytes: 100_000 });
		expect(ring.bytes()).toBeLessThanOrEqual(1_000_000);
		expect(ring.count()).toBe(10);
		expect(evicted.length).toBeGreaterThan(100);
		// oldest first: the evicted payloads ascend
		expect(evicted).toEqual([...evicted].sort((a, b) => a - b));
	});
	it('ages in a quiet stretch and drops an out-of-order frame', () => {
		const evicted = [];
		const ring = createMomentRing({ onEvict: (f) => evicted.push(f.t) });
		play(ring, 2, 60);
		ring.age(30);
		expect(ring.count()).toBe(0);
		expect(ring.push({ t: 31, bytes: 1, data: 'a' })).toBe(true);
		expect(ring.push({ t: 30.5, bytes: 1, data: 'late' })).toBe(false);
		expect(evicted).toContain(30.5);
	});
	it('clear() releases everything; take() hands it over without releasing', () => {
		const evicted = [];
		const ring = createMomentRing({ onEvict: (f) => evicted.push(f) });
		play(ring, 3, 30);
		const n = ring.count();
		const taken = ring.take();
		expect(taken.length).toBe(n);
		expect(evicted.length).toBe(0);
		expect(ring.count()).toBe(0);
		play(ring, 3, 30, { from: 10 });
		ring.clear();
		expect(evicted.length).toBe(ring.count() + n);
	});
	it('nothing is buffered outside Play: momentBlocker says idle', () => {
		const base = { playing: true, vr: false, player: false, sceneAllows: false, setting: true, lowMemory: false };
		expect(momentBlocker(base)).toBe('');
		expect(momentBlocker({ ...base, playing: false })).toBe('idle');
		expect(momentBlocker({ ...base, vr: true })).toBe('vr');
		expect(momentBlocker({ ...base, lowMemory: true })).toBe('memory');
		expect(momentBlocker({ ...base, setting: false })).toBe('setting');
		expect(momentBlocker({ ...base, capture: false })).toBe('browser');
		expect(momentBlocker({ ...base, slow: true })).toBe('slow');
		// SM3: a published game's player records nothing unless the author allows it
		expect(momentBlocker({ ...base, player: true })).toBe('player');
		expect(momentBlocker({ ...base, player: true, sceneAllows: true })).toBe('');
		for (const r of ['player', 'setting', 'browser', 'memory', 'slow', 'vr', 'idle']) expect(momentBlockerText(r)).not.toBe('');
		expect(momentBlockerText('')).toBe('');
	});
	it('low memory = deviceMemory under 4 GB; unknown is not low', () => {
		expect(isLowMemory({ deviceMemory: 2 })).toBe(true);
		expect(isLowMemory({ deviceMemory: 4 })).toBe(false);
		expect(isLowMemory({})).toBe(false);
		expect(isLowMemory(undefined)).toBe(false);
	});
	it('frames are capped small, aspect kept, even sides', () => {
		expect(momentFrameSize(1920, 1080)).toEqual({ w: 640, h: 360 });
		expect(momentFrameSize(1080, 2400, true)).toEqual({ w: 216, h: 480 });
		expect(momentFrameSize(301, 201)).toEqual({ w: 302, h: 202 });
	});
});

describe('trim + resample (SM2)', () => {
	it('defaults to the last 10 s, or all of a short take', () => {
		expect(defaultTrim(10)).toEqual({ start: 0, end: 10 });
		expect(defaultTrim(25)).toEqual({ start: 15, end: 25 });
		expect(defaultTrim(2)).toEqual({ start: 0, end: 2 });
	});
	it('holds 3-10 s: the other handle gives way', () => {
		expect(clampTrim(10, 4, 5, 'end')).toEqual({ start: 2, end: 5 });
		expect(clampTrim(10, 4, 5, 'start')).toEqual({ start: 4, end: 7 });
		expect(clampTrim(10, 9.5, 10, 'start')).toEqual({ start: 7, end: 10 });
		expect(clampTrim(10, 0, 0.5, 'end')).toEqual({ start: 0, end: 3 });
		expect(clampTrim(20, 0, 15, 'end')).toEqual({ start: 5, end: 15 });
		expect(clampTrim(20, 2, 15, 'start')).toEqual({ start: 2, end: 12 });
		const t = clampTrim(10, 1, 6);
		expect(t.end - t.start).toBeGreaterThanOrEqual(MOMENT_MIN_TRIM);
		expect(t.end - t.start).toBeLessThanOrEqual(MOMENT_MAX_TRIM);
	});
	it('the file has round(length × fps) frames whatever the capture rate', () => {
		// 4 fps captures (headless-slow), a 15 fps file of 3 s: 45 frames, each the latest capture
		const times = Array.from({ length: 41 }, (_, i) => i / 4);
		const idx = resampleFrames(times, 2, 5, 15);
		expect(idx.length).toBe(45);
		expect(idx[0]).toBe(8); // t = 2.0
		expect(idx[idx.length - 1]).toBe(19); // t ≈ 4.93 → the 4.75 capture
		expect(idx).toEqual([...idx].sort((a, b) => a - b));
		expect(resampleFrames([], 0, 3, 15)).toEqual([]);
		expect(resampleFrames(times, 3, 3, 15)).toEqual([]);
	});
	it('names the file Moment <date time>', () => {
		expect(momentFileName(new Date(2026, 10, 19, 14, 3, 22), 'gif')).toBe('Moment 2026-11-19 14-03-22.gif');
	});
});

describe('frame-cost meter (SM3)', () => {
	it('rolls a mean, a max and a p95 over its window', () => {
		const m = createCostMeter(4);
		for (const ms of [0.1, 0.2, 0.3, 0.4, 2]) m.add(ms);
		expect(m.samples()).toBe(5);
		expect(m.mean()).toBeCloseTo((0.2 + 0.3 + 0.4 + 2) / 4, 6);
		expect(m.max()).toBe(2);
		expect(m.p95()).toBe(2);
		m.add(NaN);
		expect(m.samples()).toBe(5);
		m.reset();
		expect(m.mean()).toBe(0);
	});
});

