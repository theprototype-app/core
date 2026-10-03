import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	validateTpprof,
	summarize,
	windowOf,
	encodeTpprof,
	decodeTpprof,
	percentile,
	REPORT_LIMITS,
	TPPROF_VERSION
} from '../../src/lib/perf/tpprof.js';

// 34 R1/PF — contract T1. The schema file and the validator must agree, a beacon window must
// stay inside what the cloud hook accepts, and a `.tpprof` must round-trip.

/** a small valid light recording: n frames at `ms` each, with one stall in the middle
 * @returns {any} (tests mutate it into invalid shapes on purpose) */
function rec(n = 20, ms = 16.7, extra = {}) {
	const frames = [];
	let t = 0;
	for (let i = 0; i < n; i++) {
		const f = i === Math.floor(n / 2) ? 140 : ms;
		t += f;
		frames.push({ t: Math.round(t * 10) / 10, ms: f, calls: 100 + i, tris: 200000 + i, quality: 0 });
	}
	return {
		tpprof: 1,
		meta: { build: 'abc1234', version: '1.20.0', modules: { waves: '2.4.0' }, device: 'Quest 3', xr: true, refreshRate: 72, framebufferScale: 1, scene: 'Waves', game: 'waves', startedAt: 1790000000000, mode: 'light' },
		frames,
		events: [{ t: frames[Math.floor(n / 2)].t, kind: 'stall', detail: { ms: 140, doing: ['scene-load'] } }],
		...extra
	};
}

describe('the schema file', () => {
	const schema = JSON.parse(readFileSync(new URL('../../src/lib/perf/tpprof.schema.json', import.meta.url), 'utf8'));
	it('is version 1 and requires what the validator requires', () => {
		expect(schema.properties.tpprof.const).toBe(TPPROF_VERSION);
		expect(schema.required).toEqual(['tpprof', 'meta', 'frames', 'events']);
		expect(schema.definitions.meta.required).toEqual(['build', 'version', 'modules', 'device', 'xr', 'startedAt', 'mode']);
		expect(schema.definitions.frame.required).toEqual(['t', 'ms']);
		expect(schema.definitions.meta.properties.mode.enum).toEqual(['light', 'detailed']);
	});
	it('every meta key the validator types is declared in the schema', () => {
		for (const k of ['refreshRate', 'framebufferScale', 'durationMs', 'scene', 'game', 'gpu', 'name', 'session', 'kind', 'pinned', 'gpuTimer']) {
			expect(schema.definitions.meta.properties[k], k).toBeTruthy();
		}
	});
});

describe('validateTpprof', () => {
	it('a light recording is valid', () => {
		expect(validateTpprof(rec())).toEqual({ ok: true, errors: [] });
	});
	it('a detailed recording with captures, cpu phases and notes is valid', () => {
		const doc = rec(5, 16, {
			captures: [{ t: 40, frames: 3, objects: [{ uuid: 'u1', name: 'Crate', path: 'Scene/Crate', module: null, calls: 2, tris: 1200, material: 'MeshStandardMaterial', shadow: false, ms: 0.1 }], cpu: { render: 4.1 }, memory: { heap: null, geometries: 4, textures: 2 } }],
			notes: [{ t: 50, text: 'stutter here', screenshot: 'data:image/jpeg;base64,AAAA' }]
		});
		doc.meta.mode = 'detailed';
		doc.frames[0].cpu = { input: 0.1, physics: 1.2, modules: 0.4, flow: 0.3, render: 5 };
		expect(validateTpprof(doc).ok).toBe(true);
	});
	it('unknown keys are kept and never an error (forward compatible)', () => {
		const doc = rec(3, 16, { futureThing: { a: 1 } });
		doc.meta.newMetaKey = 'x';
		doc.frames[0].newFrameKey = 3;
		expect(validateTpprof(doc).ok).toBe(true);
	});
	it('reports every wrong known key with a path', () => {
		const doc = rec(3);
		doc.tpprof = 2;
		doc.meta.xr = 'yes';
		doc.meta.mode = 'heavy';
		doc.frames[1].ms = -1;
		doc.frames[2].calls = 1.5;
		doc.events.push({ t: 1, kind: '' });
		const { ok, errors } = validateTpprof(doc);
		expect(ok).toBe(false);
		expect(errors).toEqual(
			expect.arrayContaining([
				'/tpprof: must be 1',
				'/meta/xr: required boolean',
				"/meta/mode: must be 'light' or 'detailed'",
				'/frames/1/ms: required number >= 0',
				'/frames/2/calls: integer >= 0 or null',
				'/events/1/kind: string, 1-40 chars'
			])
		);
	});
	it('a non-object and a missing meta are refused, not thrown', () => {
		expect(validateTpprof(null).ok).toBe(false);
		expect(validateTpprof({ tpprof: 1, frames: [], events: [] }).errors).toContain('/meta: required object');
	});
	it('report mode holds a window to what the endpoint accepts', () => {
		const sample = windowOf(rec(), 0, 10000);
		expect(validateTpprof(sample, { report: 'sample' }).ok).toBe(true);
		const detailed = { ...sample, meta: { ...sample.meta, mode: 'detailed' }, captures: [] };
		expect(validateTpprof(detailed, { report: 'sample' }).errors).toEqual(
			expect.arrayContaining(['/meta/mode: a report is a light recording', '/captures: a report carries no captures'])
		);
		const noted = { ...sample, notes: [{ t: 1, text: 'x' }] };
		expect(validateTpprof(noted, { report: 'sample' }).errors).toContain('/notes: only a moment carries notes');
		expect(validateTpprof(noted, { report: 'moment' }).ok).toBe(true);
		const big = rec(REPORT_LIMITS.sample.frames + 1, 5);
		expect(validateTpprof(big, { report: 'sample' }).errors).toContain('/frames: at most 1500 for a sample');
		const shot = { ...sample, notes: [{ t: 1, screenshot: 'data:image/jpeg;base64,' + 'A'.repeat(300) }] };
		expect(validateTpprof(shot, { report: 'moment' }).ok).toBe(false);
	});
});

describe('summarize', () => {
	it('fps p50 / p5, frame ms percentiles, calls, tris and stalls', () => {
		const s = summarize(rec(20, 16.7));
		expect(s.frames).toBe(20);
		expect(s.msP50).toBe(16.7);
		expect(s.msMax).toBe(140);
		expect(s.fpsP50).toBe(59.9);
		expect(s.callsP50).toBe(109);
		expect(s.callsMax).toBe(119);
		expect(s.trisMax).toBe(200019);
		expect(s.stalls).toBe(1);
		expect(s.durationMs).toBe(Math.round(19 * 16.7 + 140));
	});
	it('an empty recording summarises to nulls, not NaN', () => {
		const s = summarize({ frames: [], events: [] });
		expect(s).toMatchObject({ frames: 0, fpsP50: null, msP95: null, callsMax: null, stalls: 0 });
	});
	it('percentile is nearest-rank, as the cloud script computes it', () => {
		const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		expect(percentile(a, 50)).toBe(5);
		expect(percentile(a, 95)).toBe(10);
		expect(percentile([], 50)).toBe(null);
	});
});

describe('windowOf', () => {
	it('cuts, re-bases t to the window and moves startedAt with it', () => {
		const doc = rec(20, 16.7);
		const from = doc.frames[4].t;
		const to = doc.frames[14].t;
		const w = windowOf(doc, from, to, { kind: 'sample', session: 'abcdefgh' });
		expect(w.frames.length).toBe(10);
		expect(w.frames[0].t).toBeCloseTo(doc.frames[5].t - from, 5);
		expect(w.meta.startedAt).toBe(Math.round(doc.meta.startedAt + from));
		expect(w.meta.durationMs).toBe(Math.round(to - from));
		expect(w.meta.kind).toBe('sample');
		expect(w.events.length).toBe(1);
		expect(validateTpprof(w).ok).toBe(true);
		// the source is untouched
		expect(doc.frames.length).toBe(20);
	});
	it('a window with no captures or notes omits the keys', () => {
		const w = windowOf(rec(), 0, 50);
		expect('captures' in w).toBe(false);
		expect('notes' in w).toBe(false);
	});
});

describe('.tpprof encode / decode', () => {
	it('round-trips through gzip and carries the summary', () => {
		const doc = rec(50);
		const bytes = encodeTpprof(doc);
		expect(bytes[0]).toBe(0x1f);
		expect(bytes[1]).toBe(0x8b);
		const back = decodeTpprof(bytes);
		expect(back.frames).toEqual(doc.frames);
		expect(back.summary?.stalls).toBe(1);
	});
	it('also opens plain JSON (a beacon export) as text or bytes', () => {
		const doc = rec(3);
		expect(decodeTpprof(JSON.stringify(doc)).meta.build).toBe('abc1234');
		expect(decodeTpprof(new TextEncoder().encode(JSON.stringify(doc))).frames.length).toBe(3);
	});
	it('refuses garbage and invalid documents with a readable message', () => {
		expect(() => decodeTpprof('nope')).toThrow(/neither gzip nor JSON/);
		expect(() => decodeTpprof(JSON.stringify({ tpprof: 1 }))).toThrow(/Not a valid performance recording: \/meta/);
	});
	it('a 10-s light window at 90 Hz stays under the sample byte cap', () => {
		const doc = rec(900, 11.1);
		for (const f of doc.frames) {
			f.calls = 148;
			f.tris = 299999;
			f.quality = 3;
		}
		const size = JSON.stringify(windowOf(doc, 0, 1e9, { kind: 'sample', session: 'abcdefgh1234' })).length;
		expect(size).toBeLessThan(REPORT_LIMITS.sample.bytes);
		// and under sendBeacon's 64 KB in-flight quota, which is what lets one window go on hide
		expect(size).toBeLessThan(64 * 1024);
	});
});
