import { describe, it, expect } from 'vitest';
import { frameCount, frameTime, pathT, timelineTime, frameDurations, frameStamp, GIF_MAX_FPS, sinkHasRoom } from '../../src/lib/recording/frameClock.js';
import { webpChunks, parseWebpStill, muxAnimatedWebp, readAnimatedWebp } from '../../src/lib/recording/webpAnim.js';
import { exportPlan, estimateExportBytes, codecCandidates, probeCaps, formatBytes, HERO_MAX_FRAMES } from '../../src/lib/recording/videoExportCore.js';
import { coerceRecordingPrefs, DEFAULT_RECORDING_PREFS, recordingFileName } from '../../src/lib/recording/recordingCore.js';
import { scrollProgress, frameIndexAt, fitRect, nextTarget, glideMs } from '../../src/lib/recording/heroMath.js';
import { heroId, heroData, heroScript, heroSnippet, heroDemoPage, heroSizeReport, heroSizeText, HERO_BANNER } from '../../src/lib/recording/heroCore.js';

// 65 M4 + M7: the frame-exact export's pure halves — frame scheduling, the animated WebP muxer, the
// export plan (formats × browser capabilities), and the website section's maths and text.

/* ------------------------------------------------------------ frame scheduling ---- */

describe('frame scheduling', () => {
	it('a take has round(duration × fps) frames', () => {
		expect(frameCount(2, 30)).toBe(60);
		expect(frameCount(8, 24)).toBe(192);
		expect(frameCount(1.5, 25)).toBe(38); // 37.5 rounds up
		expect(frameCount(0.01, 12)).toBe(1); // never zero for a real take
		expect(frameCount(0, 30)).toBe(0);
		expect(frameCount(5, 0)).toBe(0);
	});
	it('frame i shows i / fps — no wall clock anywhere', () => {
		expect(frameTime(0, 30)).toBe(0);
		expect(frameTime(45, 30)).toBe(1.5);
		expect(frameTime(59, 60)).toBeCloseTo(0.98333, 5);
	});
	it('a loop never draws its last instant; an open path arrives', () => {
		expect(pathT(0, 60, true)).toBe(0);
		expect(pathT(59, 60, true)).toBeCloseTo(59 / 60);
		expect(pathT(59, 60, false)).toBe(1);
		expect(pathT(0, 1, false)).toBe(0);
		expect(pathT(5, 1, true)).toBe(0);
	});
	it('timeline time holds at the end, or loops inside a looping sequence', () => {
		expect(timelineTime(30, 30, { duration: 4 })).toBe(1);
		expect(timelineTime(150, 30, { duration: 4 })).toBe(4);
		expect(timelineTime(150, 30, { duration: 4, loop: true })).toBe(1);
		expect(timelineTime(0, 30, { duration: 4, start: 1.5 })).toBe(1.5);
		expect(timelineTime(10, 30, { duration: 0 })).toBe(0);
	});
	it('cumulative durations add up EXACTLY (no drift) in every container clock', () => {
		for (const fps of [12, 15, 24, 25, 30, 50, 60]) {
			for (const n of [1, 7, 60, 191, 1800]) {
				for (const unit of [100, 1000, 1e6]) {
					const d = frameDurations(n, fps, unit);
					expect(d.length).toBe(n);
					expect(d.reduce((s, x) => s + x, 0)).toBe(Math.round((n * unit) / fps));
					// each duration is the rounded step either side, never off by more than one unit
					const per = unit / fps;
					for (const x of d) expect(Math.abs(x - per)).toBeLessThanOrEqual(1);
					// stamps agree with the durations
					expect(frameStamp(n, fps, unit)).toBe(d.reduce((s, x) => s + x, 0));
				}
			}
		}
	});
	it('30 fps in GIF centiseconds alternates 3/3/4 — 100 cs per second exactly', () => {
		expect(frameDurations(6, 30, 100)).toEqual([3, 4, 3, 3, 4, 3]);
		expect(frameDurations(30, 30, 100).reduce((s, x) => s + x, 0)).toBe(100);
	});
	it('GIF_MAX_FPS is the fastest rate whose every delay is ≥ 2 cs (browsers clamp below that)', () => {
		expect(Math.min(...frameDurations(500, GIF_MAX_FPS, 100))).toBeGreaterThanOrEqual(2);
		expect(Math.min(...frameDurations(500, 60, 100))).toBeLessThan(2);
	});
	it('backpressure: a full sink holds the frame', () => {
		expect(sinkHasRoom(0)).toBe(true);
		expect(sinkHasRoom(3)).toBe(true);
		expect(sinkHasRoom(4)).toBe(false);
		expect(sinkHasRoom(1, 1)).toBe(false);
	});
});

/* ------------------------------------------------------------ animated WebP ---- */

/** @param {string} id @param {number[]} data */
function riffChunk(id, data) {
	const out = [...id].map((c) => c.charCodeAt(0));
	const n = data.length;
	out.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255, ...data);
	if (n & 1) out.push(0);
	return out;
}
/** @param {number[][]} chunks */
function riff(chunks) {
	const body = [...'WEBP'].map((c) => c.charCodeAt(0)).concat(...chunks);
	const n = body.length;
	return new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255], body));
}
/** a lossless still header: 0x2f + 14 bits w-1 + 14 bits h-1 + alpha bit (+ some fake payload, odd length)
 * @param {number} w @param {number} h @param {boolean} alpha @param {number[]} [extra] */
function vp8lStill(w, h, alpha, extra = [1, 2, 3]) {
	const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14) | ((alpha ? 1 : 0) << 28);
	return riff([riffChunk('VP8L', [0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255, ...extra])]);
}
/** a lossy still: VP8X (alpha) + ALPH + VP8 with the 9d 01 2a start code @param {number} w @param {number} h */
function vp8Still(w, h) {
	const vp8x = [0x10, 0, 0, 0, (w - 1) & 255, ((w - 1) >> 8) & 255, 0, (h - 1) & 255, ((h - 1) >> 8) & 255, 0];
	const vp8 = [0, 0, 0, 0x9d, 0x01, 0x2a, w & 255, (w >> 8) & 0x3f, h & 255, (h >> 8) & 0x3f, 7, 7];
	return riff([riffChunk('VP8X', vp8x), riffChunk('ALPH', [9, 9, 9]), riffChunk('VP8 ', vp8)]);
}

describe('animated WebP muxer', () => {
	it('reads stills: size and alpha from VP8L, and from VP8X + ALPH + VP8', () => {
		expect(parseWebpStill(vp8lStill(320, 180, true))).toMatchObject({ width: 320, height: 180, alpha: true });
		expect(parseWebpStill(vp8lStill(7, 5, false))).toMatchObject({ width: 7, height: 5, alpha: false });
		const lossy = parseWebpStill(vp8Still(640, 360));
		expect(lossy).toMatchObject({ width: 640, height: 360, alpha: true });
		expect(lossy.chunks.map((c) => c.id)).toEqual(['ALPH', 'VP8 ']);
	});
	it('refuses what is not a WebP still', () => {
		expect(() => parseWebpStill(new Uint8Array([1, 2, 3]))).toThrow(/not a WebP/);
		// a chunk claiming more bytes than the file holds
		const bad = riff([riffChunk('VP8L', [0x2f, 1, 2, 3])]);
		bad[16] = 200;
		expect(() => webpChunks(bad)).toThrow(/truncated/);
		expect(() => parseWebpStill(riff([riffChunk('EXIF', [1, 2])]))).toThrow(/no image/);
	});
	it('muxes frames verbatim with exact durations, loop forever, no blending', () => {
		const stills = [vp8lStill(64, 32, true, [1]), vp8lStill(64, 32, true, [2, 2]), vp8lStill(64, 32, true, [3, 3, 3])];
		const durations = frameDurations(3, 30, 1000);
		const out = muxAnimatedWebp(stills, { width: 64, height: 32, durationsMs: durations });
		const back = readAnimatedWebp(out);
		expect(back).toMatchObject({ width: 64, height: 32, loop: 0, alpha: true });
		expect(back.frames.map((f) => f.durationMs)).toEqual(durations);
		expect(back.frames.every((f) => f.width === 64 && f.height === 32)).toBe(true);
		// the RIFF size field covers the file exactly
		const riffSize = out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24);
		expect(riffSize + 8).toBe(out.length);
		// each ANMF carries the still's own image chunk byte for byte, and the no-blend flag
		const anmf = webpChunks(out).filter((c) => c.id === 'ANMF');
		expect(anmf.length).toBe(3);
		expect(anmf.every((c) => c.data[15] === 0x02)).toBe(true);
		const inner = webpChunks(riff([Array.from(anmf[2].data.subarray(16))]));
		expect(Array.from(inner[0].data)).toEqual(Array.from(webpChunks(stills[2])[0].data));
	});
	it('an opaque animation does not claim alpha; a lossy still keeps ALPH + VP8', () => {
		expect(readAnimatedWebp(muxAnimatedWebp([vp8lStill(8, 8, false)], { width: 8, height: 8, durationsMs: [40] })).alpha).toBe(false);
		const lossy = muxAnimatedWebp([vp8Still(16, 16), vp8Still(16, 16)], { width: 16, height: 16, durationsMs: [50, 50], loop: 3 });
		expect(readAnimatedWebp(lossy)).toMatchObject({ loop: 3, alpha: true });
	});
	it('refuses frames of another size, and no frames', () => {
		expect(() => muxAnimatedWebp([vp8lStill(8, 8, false), vp8lStill(9, 8, false)], { width: 8, height: 8, durationsMs: [1, 1] })).toThrow(/frame 1/);
		expect(() => muxAnimatedWebp([], { width: 8, height: 8, durationsMs: [] })).toThrow(/no frames/);
	});
});

/* ------------------------------------------------------------ the export plan ---- */

const ALL = { webcodecs: true, mediaRecorder: true, webpEncode: true };
const CANVAS = { w: 1600, h: 900 };
/** @param {any} patch */
const prefs = (patch) => coerceRecordingPrefs({ ...DEFAULT_RECORDING_PREFS, ...patch });

describe('export plan', () => {
	it('prefs: the new keys default and clamp', () => {
		const d = coerceRecordingPrefs(null);
		expect(d).toMatchObject({ format: 'mp4', sequence: '', transparent: false, heroTrigger: 'scroll', heroEase: 'outQuad', heroSmooth: 400, heroFit: 'cover' });
		const p = coerceRecordingPrefs({ mode: 'timeline', format: 'avi', heroTrigger: 'wiggle', heroEase: 'bogus', heroSmooth: 99999, heroFit: 'contain', resolution: '4k', fps: 50 });
		expect(p).toMatchObject({ mode: 'timeline', format: 'mp4', heroTrigger: 'scroll', heroEase: 'outQuad', heroSmooth: 2000, heroFit: 'contain', resolution: '4k', fps: 50 });
		expect(recordingFileName('timeline', new Date(2026, 9, 23, 9, 5, 7), 'mp4')).toBe('Timeline 2026-10-23 09-05-07.mp4');
	});
	it('MP4 / WebM go through WebCodecs when present, frame count exact', () => {
		const plan = exportPlan(prefs({ format: 'mp4', duration: 2, fps: 30, resolution: '1080p' }), ALL, CANVAS);
		expect(plan).toMatchObject({ path: 'webcodecs', ext: 'mp4', frames: 60, size: { w: 1920, h: 1080 }, blocker: '' });
		expect(exportPlan(prefs({ format: 'webm' }), ALL, CANVAS)).toMatchObject({ path: 'webcodecs', ext: 'webm' });
	});
	it('falls back to the live MediaRecorder (webm) without WebCodecs — and says so', () => {
		const plan = exportPlan(prefs({ format: 'mp4', mode: 'timeline' }), { ...ALL, webcodecs: false }, CANVAS);
		expect(plan.path).toBe('mediarecorder');
		expect(plan.ext).toBe('webm');
		expect(plan.notes.join(' ')).toMatch(/no WebCodecs/);
		expect(plan.notes.join(' ')).toMatch(/real time/);
		expect(exportPlan(prefs({ format: 'mp4' }), { webcodecs: false, mediaRecorder: false, webpEncode: true }, CANVAS).blocker).toMatch(/cannot write video/);
	});
	it('GIF caps the frame rate at 50 and warns on big sizes', () => {
		const plan = exportPlan(prefs({ format: 'gif', fps: 60, duration: 2, resolution: '1080p' }), ALL, CANVAS);
		expect(plan.fps).toBe(50);
		expect(plan.frames).toBe(100);
		expect(plan.notes.join(' ')).toMatch(/at most 50 fps/);
		expect(plan.notes.join(' ')).toMatch(/Small/);
	});
	it('transparency only where the format keeps it', () => {
		expect(exportPlan(prefs({ format: 'png', transparent: true }), ALL, CANVAS).alpha).toBe(true);
		expect(exportPlan(prefs({ format: 'webp', transparent: true }), ALL, CANVAS).alpha).toBe(true);
		const mp4 = exportPlan(prefs({ format: 'mp4', transparent: true }), ALL, CANVAS);
		expect(mp4.alpha).toBe(false);
		expect(mp4.notes.join(' ')).toMatch(/no transparency/);
	});
	it('WebP needs a WebP encoder; a website section falls back to JPEG frames', () => {
		const noWebp = { ...ALL, webpEncode: false };
		expect(exportPlan(prefs({ format: 'webp' }), noWebp, CANVAS).blocker).toMatch(/cannot encode WebP/);
		const hero = exportPlan(prefs({ format: 'hero', duration: 2, fps: 24 }), noWebp, CANVAS);
		expect(hero.blocker).toBe('');
		expect(hero.notes.join(' ')).toMatch(/JPEG/);
	});
	it('caps the frames a website section and a stills export hold', () => {
		expect(exportPlan(prefs({ format: 'hero', duration: 20, fps: 30 }), ALL, CANVAS).blocker).toMatch(String(HERO_MAX_FRAMES));
		expect(exportPlan(prefs({ format: 'png', duration: 60, fps: 60 }), ALL, CANVAS).blocker).toMatch(/1800/);
		expect(exportPlan(prefs({ format: 'mp4', duration: 60, fps: 60 }), ALL, CANVAS).blocker).toBe('');
	});
	it('a take longer than the timeline is named', () => {
		const plan = exportPlan(prefs({ format: 'mp4', mode: 'timeline', duration: 10 }), ALL, CANVAS, { duration: 4 });
		expect(plan.notes.join(' ')).toMatch(/longer than the timeline/);
	});
	it('estimates scale with pixels and frames', () => {
		const a = exportPlan(prefs({ format: 'gif', resolution: '480p', duration: 2, fps: 15 }), ALL, CANVAS);
		const b = exportPlan(prefs({ format: 'gif', resolution: '480p', duration: 4, fps: 15 }), ALL, CANVAS);
		expect(estimateExportBytes(b, 'medium')).toBeCloseTo(estimateExportBytes(a, 'medium') * 2, -2);
		expect(estimateExportBytes(exportPlan(prefs({ format: 'mp4', duration: 8 }), ALL, CANVAS), 'high')).toBeGreaterThan(
			estimateExportBytes(exportPlan(prefs({ format: 'mp4', duration: 8 }), ALL, CANVAS), 'low')
		);
	});
	it('codec order and the capability probe', () => {
		expect(codecCandidates('mp4')[0]).toBe('avc');
		expect(codecCandidates('webm')[0]).toBe('vp9');
		expect(probeCaps({ VideoEncoder: function () {}, VideoFrame: function () {}, MediaRecorder: function () {} }, true)).toEqual(ALL);
		expect(probeCaps({}, false)).toEqual({ webcodecs: false, mediaRecorder: false, webpEncode: false });
		expect(formatBytes(512)).toBe('1 KB');
		expect(formatBytes(3 * 1048576)).toBe('3.0 MB');
	});
});

/* ------------------------------------------------------------ website section ---- */

describe('website section maths', () => {
	it('pass mode: 0 entering at the bottom, 1 leaving at the top', () => {
		expect(scrollProgress({ top: 800, height: 400 }, 800, 'pass')).toBe(0);
		expect(scrollProgress({ top: -400, height: 400 }, 800, 'pass')).toBe(1);
		expect(scrollProgress({ top: 200, height: 400 }, 800, 'pass')).toBe(0.5);
		expect(scrollProgress({ top: 5000, height: 400 }, 800, 'pass')).toBe(0);
	});
	it('track mode: 0 at the top of the track, 1 when its bottom meets the viewport bottom', () => {
		expect(scrollProgress({ top: 0, height: 2400 }, 800, 'track')).toBe(0);
		expect(scrollProgress({ top: -800, height: 2400 }, 800, 'track')).toBe(0.5);
		expect(scrollProgress({ top: -1600, height: 2400 }, 800, 'track')).toBe(1);
		expect(scrollProgress({ top: 300, height: 2400 }, 800, 'track')).toBe(0);
		// a track no taller than the viewport cannot scroll: before or after
		expect(scrollProgress({ top: 10, height: 500 }, 800, 'track')).toBe(0);
		expect(scrollProgress({ top: -10, height: 500 }, 800, 'track')).toBe(1);
	});
	it('frame index and fit', () => {
		expect(frameIndexAt(0, 48)).toBe(0);
		expect(frameIndexAt(1, 48)).toBe(47);
		expect(frameIndexAt(0.5, 3)).toBe(1);
		expect(frameIndexAt(2, 10)).toBe(9);
		expect(frameIndexAt(NaN, 10)).toBe(0);
		const cover = fitRect(1920, 1080, 960, 960, 'cover');
		expect(cover.h).toBe(960);
		expect(cover.w).toBeCloseTo(1706.667, 2);
		expect(cover.x).toBeCloseTo(-373.333, 2);
		const c = fitRect(1920, 1080, 960, 960, 'contain');
		expect(c.w).toBe(960);
		expect(c.y).toBe(210);
	});
	it('hover and click destinations; glide times', () => {
		expect(nextTarget('hover', 'enter', 0)).toBe(1);
		expect(nextTarget('hover', 'leave', 1)).toBe(0);
		expect(nextTarget('click', 'click', 0)).toBe(1);
		expect(nextTarget('click', 'click', 1)).toBe(0);
		expect(nextTarget('click', 'enter', 1)).toBe(1);
		expect(glideMs('scroll', 0, 1, { smooth: 400, duration: 3 })).toBe(400);
		expect(glideMs('hover', 0.5, 1, { smooth: 400, duration: 3 })).toBe(1500);
	});
	it('the script: banner, data, runtime, mounted on its own <script>; `<` escaped', () => {
		const data = heroData({ id: heroId('My Logo — Intro!'), label: '</script><b>', w: 640, h: 360, fps: 24, duration: 2, trigger: 'scroll', ease: 'outQuad', smooth: 400, fit: 'cover', mime: 'image/webp', frames: ['AAAA'] });
		expect(data.id).toBe('tp-hero-my-logo-intro');
		const js = heroScript('var TPHero={mount:function(){}};', data);
		expect(js.startsWith(HERO_BANNER)).toBe(true);
		expect(js).toMatch(/anime\.js v4 \(MIT/);
		expect(js).toMatch(/TPHero\.mount\(D,s\);\}\)\(document\.currentScript\);/);
		expect(js).not.toMatch(/<\/script/i);
		// the data round-trips
		const D = JSON.parse(js.slice(js.indexOf('var D=') + 6, js.indexOf(';\nvar TPHero')));
		expect(D.label).toBe('</script><b>');
		expect(D.frames).toEqual(['AAAA']);
	});
	it('snippets: scroll gets a sticky track; hover/click a plain canvas; attributes escaped', () => {
		const s = heroSnippet('tp-hero-x', 'tp-hero-x.js', { w: 16, h: 9, label: 'A "logo"', trigger: 'scroll' });
		expect(s).toMatch(/data-tp-hero-track/);
		expect(s).toMatch(/position:sticky/);
		expect(s).toMatch(/aria-label="A &quot;logo&quot;"/);
		expect(s).toMatch(/<script src="tp-hero-x\.js" defer><\/script>/);
		const h = heroSnippet('tp-hero-x', 'tp-hero-x.js', { w: 16, h: 9, label: 'x', trigger: 'hover' });
		expect(h).not.toMatch(/track/);
		expect(heroDemoPage('tp-hero-x', 'tp-hero-x.js', { w: 16, h: 9, label: 'x', trigger: 'click', title: 'T <1>' })).toMatch(/<title>T &lt;1&gt;<\/title>[\s\S]*Click/);
	});
	it('size report', () => {
		const r = heroSizeReport({ frameBytes: [100, 300, 200], runtimeBytes: 30000, scriptBytes: 31000, gzipBytes: 20000 });
		expect(r).toEqual({ frames: 3, framesBytes: 600, averageFrameBytes: 200, largestFrameBytes: 300, runtimeBytes: 30000, scriptBytes: 31000, gzipBytes: 20000 });
		expect(heroSizeText(r, formatBytes)).toMatch(/Frames: 3/);
	});
});
