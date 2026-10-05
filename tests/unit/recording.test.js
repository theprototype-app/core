import { describe, it, expect } from 'vitest';
import { fixWebmDuration, readWebmDuration } from '../../src/lib/recording/webmDuration.js';
import {
	coerceRecordingPrefs,
	DEFAULT_RECORDING_PREFS,
	outputSize,
	coverRect,
	dprBoost,
	bitrateFor,
	estimateBytes,
	pickMimeType,
	recordingFileName,
	planOrbit,
	turntablePose,
	planFlythrough,
	flythroughPose,
	sphereOfBoxes,
	easeInOut
} from '../../src/lib/recording/recordingCore.js';

// 36-share (B13): the recorder's pure half — the webm Duration patch, the options, the camera paths.

/* ------------------------------------------------------- a minimal webm, byte by byte ---- */

/** @param {number[]} id @param {number[]} data @param {number} [sizeLen] */
function el(id, data, sizeLen = 1) {
	const size = [];
	let v = data.length;
	for (let i = sizeLen - 1; i >= 0; i--) {
		size[i] = v & 0xff;
		v >>= 8;
	}
	size[0] |= 0x80 >> (sizeLen - 1);
	return [...id, ...size, ...data];
}
const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const ascii = (/** @type {string} */ s) => [...s].map((c) => c.charCodeAt(0));

/**
 * EBML header + Segment{Info{TimecodeScale, MuxingApp, [Duration]}, Tracks, Cluster} — the shape
 * Chrome's MediaRecorder writes (unknown-size Segment and Cluster, no Duration).
 * @param {{knownSegment?: boolean, duration?: number, seekHead?: boolean, scale?: number}} [o]
 */
function makeWebm(o = {}) {
	const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], ascii('webm')));
	const scale = o.scale ?? 1000000;
	const scaleBytes = [(scale >> 16) & 0xff, (scale >> 8) & 0xff, scale & 0xff];
	const infoKids = [...el([0x2a, 0xd7, 0xb1], scaleBytes), ...el([0x4d, 0x80], ascii('Chrome'))];
	if (o.duration !== undefined) {
		const d = new Uint8Array(8);
		new DataView(d.buffer).setFloat64(0, o.duration);
		infoKids.push(...el([0x44, 0x89], [...d]));
	}
	const info = el([0x15, 0x49, 0xa9, 0x66], infoKids);
	const tracks = el([0x16, 0x54, 0xae, 0x6b], el([0xae], [0xd7, 0x81, 0x01]));
	const seek = o.seekHead ? el([0x11, 0x4d, 0x9b, 0x74], [0xec, 0x80]) : [];
	const cluster = [0x1f, 0x43, 0xb6, 0x75, ...UNKNOWN_SIZE, ...el([0xe7], [0x00])];
	const body = [...seek, ...info, ...tracks, ...cluster];
	const segSize = o.knownSegment ? el([], body, 4).slice(0, 4) : UNKNOWN_SIZE;
	return new Uint8Array([...header, 0x18, 0x53, 0x80, 0x67, ...segSize, ...body]);
}

describe('webm duration', () => {
	it('a MediaRecorder-shaped file has no duration until patched', () => {
		const raw = makeWebm();
		expect(readWebmDuration(raw)).toBeNull();
		const fixed = fixWebmDuration(raw, 2000);
		expect(fixed.length).toBe(raw.length + 11);
		expect(readWebmDuration(fixed)).toBeCloseTo(2000, 6);
	});
	it('keeps every byte after Info intact (the clusters are not touched)', () => {
		const raw = makeWebm();
		const fixed = fixWebmDuration(raw, 1234);
		const tail = raw.slice(raw.length - 20);
		expect([...fixed.slice(fixed.length - 20)]).toEqual([...tail]);
	});
	it('honours a non-default TimecodeScale', () => {
		const fixed = fixWebmDuration(makeWebm({ scale: 500000 }), 3000);
		expect(readWebmDuration(fixed)).toBeCloseTo(3000, 6);
	});
	it('grows a KNOWN segment size with the insert', () => {
		const raw = makeWebm({ knownSegment: true });
		const fixed = fixWebmDuration(raw, 900);
		expect(readWebmDuration(fixed)).toBeCloseTo(900, 6);
		// the segment size field (4 bytes after the 4-byte id, after the header) grew by 11
		const at = raw.indexOf(0x18);
		const size = (/** @type {Uint8Array} */ b) => ((b[at + 4] & 0x0f) << 24) | (b[at + 5] << 16) | (b[at + 6] << 8) | b[at + 7];
		expect(size(fixed) - size(raw)).toBe(11);
	});
	it('overwrites an existing Duration in place', () => {
		const raw = makeWebm({ duration: 5 });
		expect(readWebmDuration(raw)).toBeCloseTo(5, 6);
		const fixed = fixWebmDuration(raw, 4321);
		expect(fixed.length).toBe(raw.length);
		expect(readWebmDuration(fixed)).toBeCloseTo(4321, 6);
	});
	it('refuses (returns the input) where an insert would shift a SeekHead', () => {
		const raw = makeWebm({ seekHead: true });
		expect(fixWebmDuration(raw, 1000)).toBe(raw);
	});
	it('returns non-webm bytes and bad durations unchanged', () => {
		const junk = new Uint8Array([1, 2, 3, 4, 5]);
		expect(fixWebmDuration(junk, 1000)).toBe(junk);
		const raw = makeWebm();
		expect(fixWebmDuration(raw, 0)).toBe(raw);
		expect(fixWebmDuration(raw, NaN)).toBe(raw);
	});
});

/* ----------------------------------------------------------------------- options ---- */

describe('recording prefs', () => {
	it('defaults from nothing', () => {
		expect(coerceRecordingPrefs(null)).toEqual(DEFAULT_RECORDING_PREFS);
	});
	it('clamps and drops what it does not know', () => {
		const p = coerceRecordingPrefs({ duration: 999, fps: 25, quality: 'ultra', revolutions: 0.1, mode: 'flythrough', junk: 1 });
		expect(p.duration).toBe(60);
		expect(p.fps).toBe(30);
		expect(p.quality).toBe('medium');
		expect(p.revolutions).toBe(0.25);
		expect(p.mode).toBe('flythrough');
		expect('junk' in p).toBe(false);
		expect(coerceRecordingPrefs({ duration: 0.2 }).duration).toBe(1);
	});
});

describe('sizes, crops, bitrates', () => {
	it('fixed resolutions ignore the canvas; viewport rounds to even and caps the long side', () => {
		expect(outputSize('1080p', { w: 300, h: 200 })).toEqual({ w: 1920, h: 1080 });
		expect(outputSize('viewport', { w: 1281, h: 721 })).toEqual({ w: 1282, h: 722 });
		const big = outputSize('viewport', { w: 7680, h: 4320 });
		expect(Math.max(big.w, big.h)).toBe(3840);
		expect(big.w % 2 + big.h % 2).toBe(0);
	});
	it('cover-crops a wide canvas into a square and a tall one into 16:9', () => {
		expect(coverRect(1600, 900, 1080, 1080)).toEqual({ sx: 350, sy: 0, sw: 900, sh: 900 });
		const r = coverRect(900, 1600, 1920, 1080);
		expect(r.sx).toBe(0);
		expect(r.sw).toBe(900);
		expect(r.sh).toBeCloseTo(506.25, 6);
	});
	it('asks for more pixel ratio only when the crop is smaller than the output', () => {
		expect(dprBoost({ w: 1920, h: 1080 }, 1, { w: 1280, h: 720 })).toBe(1);
		expect(dprBoost({ w: 960, h: 540 }, 1, { w: 1920, h: 1080 })).toBeCloseTo(2, 6);
		expect(dprBoost({ w: 400, h: 300 }, 1, { w: 1920, h: 1080 })).toBe(3); // capped
		expect(dprBoost({ w: 960, h: 540 }, 2, { w: 1920, h: 1080 })).toBe(1);
	});
	it('bitrate scales with pixels, fps and quality and stays inside its clamps', () => {
		const hd = bitrateFor({ w: 1280, h: 720 }, 30, 'medium');
		expect(bitrateFor({ w: 1280, h: 720 }, 30, 'high')).toBe(hd * 2);
		expect(bitrateFor({ w: 64, h: 64 }, 24, 'low')).toBe(500000);
		expect(bitrateFor({ w: 3840, h: 2160 }, 60, 'high')).toBe(25000000);
		expect(estimateBytes(8000000, 10)).toBe(10000000);
	});
	it('picks webm first and mp4 last', () => {
		expect(pickMimeType((m) => m.startsWith('video/webm'))).toEqual({ mime: 'video/webm;codecs=vp9', ext: 'webm' });
		expect(pickMimeType((m) => m === 'video/mp4')).toEqual({ mime: 'video/mp4', ext: 'mp4' });
		expect(pickMimeType(() => false)).toBeNull();
		expect(
			pickMimeType(() => {
				throw new Error('no');
			})
		).toBeNull();
	});
	it('names a recording by mode and time', () => {
		const n = recordingFileName('turntable', new Date(2026, 9, 5, 14, 3, 2), 'webm');
		expect(n).toBe('Turntable 2026-10-05 14-03-02.webm');
		expect(/[*\\/]/.test(n)).toBe(false);
	});
});

/* --------------------------------------------------------------------- the paths ---- */

const len = (/** @type {number[]} */ v) => Math.hypot(v[0], v[1], v[2]);
const sub = (/** @type {number[]} */ a, /** @type {number[]} */ b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

describe('turntable', () => {
	const base = { position: /** @type {[number,number,number]} */ ([0, 5, 10]), center: /** @type {[number,number,number]} */ ([0, 1, 0]), radius: 2, fovDeg: 40, aspect: 16 / 9, frame: false, revolutions: 1, direction: /** @type {'ccw'} */ ('ccw') };
	it('starts where the camera is and keeps its distance without framing', () => {
		const orbit = planOrbit(base);
		const p0 = turntablePose(orbit, 0);
		expect(p0.position[0]).toBeCloseTo(0, 6);
		expect(p0.position[1]).toBeCloseTo(5, 6);
		expect(p0.position[2]).toBeCloseTo(10, 6);
		expect(p0.target).toEqual([0, 1, 0]);
	});
	it('a full revolution comes back to the start (the clip loops) at a constant distance', () => {
		const orbit = planOrbit(base);
		const a = turntablePose(orbit, 0).position;
		const b = turntablePose(orbit, 1).position;
		expect(len(sub(a, b))).toBeLessThan(1e-9);
		for (const t of [0.13, 0.5, 0.77]) expect(len(sub(turntablePose(orbit, t).position, base.center))).toBeCloseTo(orbit.distance, 6);
		const half = turntablePose(orbit, 0.5).position;
		expect(half[2]).toBeCloseTo(-10, 6);
	});
	it('direction flips the sweep', () => {
		const ccw = turntablePose(planOrbit(base), 0.25).position;
		const cw = turntablePose(planOrbit({ ...base, direction: 'cw' }), 0.25).position;
		expect(ccw[0]).toBeCloseTo(-cw[0], 6);
	});
	it('framing fits the sphere in the narrower field of view', () => {
		const tall = planOrbit({ ...base, frame: true, aspect: 0.5 });
		const wide = planOrbit({ ...base, frame: true, aspect: 2 });
		expect(tall.distance).toBeGreaterThan(wide.distance);
		expect(wide.distance).toBeCloseTo((2 / Math.sin((20 * Math.PI) / 180)) * 1.1, 6);
	});
	it('clamps a camera straight overhead to 75 degrees', () => {
		const top = planOrbit({ ...base, position: [0, 20, 0] });
		expect((top.elevation * 180) / Math.PI).toBeCloseTo(75, 6);
	});
});

describe('flythrough', () => {
	const views = [
		{ position: [0, 2, 10], target: [0, 1, 0], lens: { fov: 40 } },
		{ position: [10, 2, 0], target: [0, 1, 0], lens: { fov: 60 } },
		{ position: [0, 6, -10], target: [0, 0, 0], lens: null }
	];
	it('needs two usable views', () => {
		expect(planFlythrough([views[0]])).toBeNull();
		expect(planFlythrough([views[0], { position: [NaN, 0, 0], target: [0, 0, 0] }])).toBeNull();
	});
	it('passes through the first and last views at t=0 and t=1', () => {
		const path = /** @type {any} */ (planFlythrough(views));
		const a = flythroughPose(path, 0);
		const b = flythroughPose(path, 1);
		expect(len(sub(a.position, views[0].position))).toBeLessThan(1e-9);
		expect(len(sub(b.position, views[2].position))).toBeLessThan(1e-9);
		expect(a.fov).toBeCloseTo(40, 6);
	});
	it('passes through the middle view at its share of the path', () => {
		const path = /** @type {any} */ (planFlythrough(views));
		const share = path.cumulative[1] / path.cumulative[2];
		// invert the ease to find the t that lands on the middle knot
		let lo = 0;
		let hi = 1;
		for (let i = 0; i < 60; i++) {
			const mid = (lo + hi) / 2;
			if (easeInOut(mid) < share) lo = mid;
			else hi = mid;
		}
		const p = flythroughPose(path, lo);
		expect(len(sub(p.position, views[1].position))).toBeLessThan(1e-4);
		expect(p.fov).toBeCloseTo(60, 3);
	});
	it('a leg into a view without a lens holds the lens it had', () => {
		const path = /** @type {any} */ (planFlythrough(views));
		expect(flythroughPose(path, 0.97).fov).toBeCloseTo(60, 6);
	});
	it('is continuous (no jumps between frames)', () => {
		const path = /** @type {any} */ (planFlythrough(views));
		let prev = flythroughPose(path, 0).position;
		for (let i = 1; i <= 300; i++) {
			const p = flythroughPose(path, i / 300).position;
			expect(len(sub(p, prev))).toBeLessThan(0.5);
			prev = p;
		}
	});
});

describe('bounds', () => {
	it('a sphere around every box, null for nothing', () => {
		expect(sphereOfBoxes([])).toBeNull();
		const s = /** @type {any} */ (sphereOfBoxes([
			{ min: [-1, 0, -1], max: [1, 2, 1] },
			{ min: [3, 0, -1], max: [5, 2, 1] }
		]));
		expect(s.center).toEqual([2, 1, 0]);
		expect(s.radius).toBeCloseTo(Math.hypot(6, 2, 2) / 2, 6);
	});
});
