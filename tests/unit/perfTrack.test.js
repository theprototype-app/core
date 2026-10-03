import { describe, it, expect } from 'vitest';
import { createTrack } from '../../src/lib/perf/perfTrack.js';
import { validateTpprof } from '../../src/lib/perf/tpprof.js';

// 34 PF: the recorder's columns. A ring keeps the newest `capacity` frames, a log appends in
// chunks up to its cap, and both read back as T1 frames.

describe('a ring', () => {
	it('keeps the newest frames once it wraps, oldest first', () => {
		const r = createTrack({ capacity: 5, ring: true });
		for (let i = 1; i <= 8; i++) r.push(i * 10, 10, i, i * 100, 0);
		expect(r.length).toBe(5);
		expect(r.frames().map((f) => f.t)).toEqual([40, 50, 60, 70, 80]);
		expect(r.firstT).toBe(40);
		expect(r.lastT).toBe(80);
	});
	it('a time window is from < t <= to', () => {
		const r = createTrack({ capacity: 10, ring: true });
		for (let i = 1; i <= 6; i++) r.push(i * 10, 10, 1, 1, 0);
		expect(r.frames(20, 50).map((f) => f.t)).toEqual([30, 40, 50]);
	});
	it('null values read back as null, and frames are valid T1', () => {
		const r = createTrack({ capacity: 4, ring: true });
		r.push(16.66, 16.66, null, null, null);
		r.push(33.3, 16.64, 120, 250000, 2);
		const f = r.frames();
		expect(f[0]).toEqual({ t: 16.7, ms: 16.7, calls: null, tris: null, quality: null });
		expect(f[1]).toEqual({ t: 33.3, ms: 16.6, calls: 120, tris: 250000, quality: 2 });
		const doc = { tpprof: 1, meta: { build: 'x', version: '1', modules: {}, device: 'd', xr: false, startedAt: 0, mode: 'light' }, frames: f, events: [] };
		expect(validateTpprof(doc).ok).toBe(true);
	});
});

describe('a log', () => {
	it('appends across chunk boundaries', () => {
		const l = createTrack({ capacity: 10000 });
		for (let i = 0; i < 9000; i++) l.push(i, 1, i % 7, 0, 0);
		expect(l.length).toBe(9000);
		const f = l.frames();
		expect(f.length).toBe(9000);
		expect(f[4095].t).toBe(4095);
		expect(f[4096].t).toBe(4096);
		expect(f[8999].calls).toBe(8999 % 7);
	});
	it('refuses past its cap and says it is full', () => {
		const l = createTrack({ capacity: 3 });
		expect(l.push(1, 1, 1, 1, 0)).toBe(true);
		l.push(2, 1, 1, 1, 0);
		l.push(3, 1, 1, 1, 0);
		expect(l.full).toBe(false);
		expect(l.push(4, 1, 1, 1, 0)).toBe(false);
		expect(l.full).toBe(true);
		expect(l.length).toBe(3);
	});
	it('detailed columns carry CPU phases and GPU ms per frame', () => {
		const l = createTrack({ capacity: 10, cpu: true });
		l.push(10, 10, 5, 50, 0, [0.1, 1.5, 0.2, 0.3, 6, 1.9], 4.25);
		l.push(20, 10, 5, 50, 0, null, null);
		const [a, b] = l.frames();
		expect(a.cpu).toEqual({ input: 0.1, physics: 1.5, modules: 0.2, flow: 0.3, render: 6, other: 1.9 });
		expect(a.gpu).toBe(4.25);
		expect(b.cpu).toBeUndefined();
		expect(b.gpu).toBeUndefined();
	});
	it('clear forgets everything', () => {
		const l = createTrack({ capacity: 9000 });
		for (let i = 0; i < 5000; i++) l.push(i, 1, 1, 1, 0);
		l.clear();
		expect(l.length).toBe(0);
		expect(l.lastT).toBe(null);
		l.push(1, 1, 1, 1, 0);
		expect(l.frames().length).toBe(1);
	});
});
