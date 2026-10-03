// 34 PF (profiler-xr): the live perf stream's wire — packing, its validator, and what a
// light stream costs on the real serializer (peerjs's binarypack, which the data channel uses).
import { describe, it, expect } from 'vitest';
import { pack } from 'peerjs-js-binarypack';
import { packFrames, unpackFrames, trimCapture, FRAME_COLS, CPU_COLS, LIVE_BATCH_MS, LIGHT_BUDGET_BPS, MAX_CAPTURE_OBJECTS } from '../../src/lib/perf/liveWire.js';
import { validateWireMessage } from '../../src/lib/wireValidate.js';
import { validateTpprof } from '../../src/lib/perf/tpprof.js';

/**
 * n frames at `hz` starting at ring time t, heavy-scene numbers (worst case for int width)
 * @param {number} n @param {number} [hz] @param {number} [t] @param {boolean} [cpu]
 */
function frames(n, hz = 90, t = 123456.7, cpu = false) {
	return Array.from({ length: n }, (_, i) => ({
		t: t + (i * 1000) / hz,
		ms: 11.1 + (i % 7) * 0.37,
		calls: 140 + (i % 13),
		tris: 412345 + i * 17,
		quality: i % 3,
		...(cpu ? { cpu: [0.21, 1.4, 0.8, 0.3, 4.2, 0.5] } : {})
	}));
}

describe('packFrames / unpackFrames', () => {
	it('round-trips the light columns at the format precision', () => {
		const src = frames(45);
		const batch = packFrames(src);
		expect(batch.f.length).toBe(45 * FRAME_COLS);
		expect(batch.c).toBeUndefined();
		const back = unpackFrames(batch);
		expect(back.length).toBe(45);
		for (let i = 0; i < 45; i++) {
			expect(Math.abs(back[i].t - src[i].t)).toBeLessThanOrEqual(0.1);
			expect(Math.abs(back[i].ms - src[i].ms)).toBeLessThanOrEqual(0.005);
			expect(back[i].calls).toBe(src[i].calls);
			expect(back[i].tris).toBe(src[i].tris);
			expect(back[i].quality).toBe(src[i].quality);
			expect(back[i].cpu).toBeUndefined();
		}
	});
	it('every packed value is an integer (binarypack writes ints compactly)', () => {
		const { f } = packFrames(frames(30));
		expect(f.every((v) => Number.isInteger(v))).toBe(true);
	});
	it('carries the CPU phases only when asked and present', () => {
		const withCpu = packFrames(frames(10, 90, 0, true), true);
		expect(withCpu.c?.length).toBe(10 * CPU_COLS);
		const back = unpackFrames(withCpu);
		expect(back[0].cpu).toEqual({ input: 0.21, physics: 1.4, modules: 0.8, flow: 0.3, render: 4.2, other: 0.5 });
		// light watchers: the same frames without `c`
		expect(packFrames(frames(10, 90, 0, true), false).c).toBeUndefined();
	});
	it('a frame with no measurement keeps null (not 0) through the wire', () => {
		const back = unpackFrames(packFrames([{ t: 5, ms: 16.7, calls: null, tris: null, quality: null }]));
		expect(back[0]).toMatchObject({ calls: null, tris: null, quality: null });
	});
	it('unpacked frames are valid T1 frames', () => {
		const doc = { tpprof: 1, meta: { build: 'x', version: '1', modules: {}, device: 'd', xr: true, refreshRate: 90, framebufferScale: 1, scene: null, game: null, startedAt: 0, mode: 'detailed' }, frames: unpackFrames(packFrames(frames(20, 90, 0, true), true)).map((f, i) => ({ ...f, t: i * 11 })), events: [] };
		const v = validateTpprof(doc);
		expect(v.errors).toEqual([]);
	});
});

describe('the light stream fits its budget on the real serializer', () => {
	it('90 Hz and 120 Hz light batches stay far under 20 KB/s', () => {
		for (const hz of [72, 90, 120]) {
			const perBatch = Math.round((hz * LIVE_BATCH_MS) / 1000);
			const b = packFrames(frames(perBatch, hz));
			const msg = { type: 'perflive', op: 'frames', seq: 999, base: 1791003830153, ...b, rec: { id: 'mfa1-abc123', mode: 'light', startedAt: 1791003830153, frames: 54000 } };
			const bytes = /** @type {ArrayBuffer} */ (pack(msg)).byteLength;
			const bps = (bytes * 1000) / LIVE_BATCH_MS;
			expect(bps, `${hz} Hz -> ${bps} B/s`).toBeLessThan(LIGHT_BUDGET_BPS / 4);
		}
	});
});

describe('trimCapture', () => {
	it('keeps the heaviest objects and folds the rest so totals still add up', () => {
		const objects = Array.from({ length: 500 }, (_, i) => ({ uuid: 'u' + i, name: 'o' + i, path: 'Scene/o' + i, calls: 1, tris: 10, material: 'm', shadow: false }));
		const cap = trimCapture({ t: 0, frames: 3, objects });
		expect(cap.objects.length).toBe(MAX_CAPTURE_OBJECTS);
		expect(cap.objects.reduce((a, o) => a + o.calls, 0)).toBe(500);
		expect(cap.objects.reduce((a, o) => a + o.tris, 0)).toBe(5000);
		expect(cap.objects.at(-1)?.name).toBe('(301 more)');
	});
	it('leaves a small capture alone', () => {
		const cap = { t: 0, frames: 3, objects: [{ uuid: 'a', name: 'a', path: '', calls: 2, tris: 4, material: '', shadow: false }] };
		expect(trimCapture(cap)).toBe(cap);
	});
});

describe('wireValidate: perflive', () => {
	const ok = (/** @type {any} */ d) => validateWireMessage({ type: 'perflive', ...d });
	it('accepts every well-formed op', () => {
		expect(ok({ op: 'watch', mode: 'light' })).toBe(true);
		expect(ok({ op: 'watch', mode: 'detailed' })).toBe(true);
		expect(ok({ op: 'unwatch' })).toBe(true);
		expect(ok({ op: 'detail', frames: 3 })).toBe(true);
		expect(ok({ op: 'capture', frames: 3 })).toBe(false); // `capture` is the REPLY: it must carry one
		expect(ok({ op: 'hello', base: 1, meta: {}, rec: null })).toBe(true);
		expect(ok({ op: 'frames', seq: 1, base: 1, ...packFrames(frames(5, 90, 0, true), true) })).toBe(true);
		expect(ok({ op: 'capture', base: 1, t: 2, cap: { objects: [] } })).toBe(true);
		expect(ok({ op: 'state', rec: null })).toBe(true);
		expect(ok({ op: 'some-future-op' })).toBe(true);
	});
	it('refuses what would poison a recording', () => {
		expect(ok({})).toBe(false);
		expect(ok({ op: 'watch', mode: 'everything' })).toBe(false);
		expect(ok({ op: 'frames', base: 1, t0: 0, f: [1, 2, 3] })).toBe(false); // not whole frames
		expect(ok({ op: 'frames', base: 1, t0: 0, f: [1, 2, 3, NaN, 5] })).toBe(false);
		expect(ok({ op: 'frames', base: 1, t0: 0, f: [1, 2, 3, '4', 5] })).toBe(false);
		expect(ok({ op: 'frames', base: 1, t0: 0, f: [1, 2, 3, 4, 5], c: [1] })).toBe(false); // c not 6 per frame
		expect(ok({ op: 'frames', base: Infinity, t0: 0, f: [] })).toBe(false);
		expect(ok({ op: 'capture', base: 1, t: 2, cap: { objects: 'x' } })).toBe(false);
		expect(ok({ op: 'hello', base: 1 })).toBe(false);
	});
});
