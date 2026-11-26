// @ts-nocheck — plain fixture documents
// 64-2d (D4 wave 1): the sprite / flipbook / layer / 2D-follow maths (src/lib/sprite2d/spriteCore.js).
import { describe, it, expect } from 'vitest';
import {
	parseFramesText,
	framesText,
	parseEventsText,
	eventsText,
	normalizeSprite,
	compactSprite,
	clipByName,
	clipFrames,
	clipDuration,
	clipFrameAt,
	clipEventsBetween,
	frameUv,
	frameSizePx,
	planeSize,
	snapToPixel,
	normalizeLayer2d,
	compactLayer2d,
	parallaxOffset,
	follow2dGoal,
	follow2dStep,
	clampView,
	normalizeFollow2d
} from '../../src/lib/sprite2d/spriteCore.js';

const clip = (over = {}) => normalizeSprite({ sheet: { cols: 4, rows: 2 }, clips: [{ name: 'c', fps: 10, ...over }] }).clips[0];

describe('normalizeSprite', () => {
	it('fills the defaults: a 1×1 sheet, nearest filter, 16 ppu, no clips', () => {
		const s = normalizeSprite({});
		expect(s).toEqual({
			ppu: 16,
			filter: 'nearest',
			snap: false,
			sheet: { cols: 1, rows: 1, count: 1, margin: 0, spacing: 0 },
			clips: [],
			play: '',
			frame: 0,
			flipX: false,
			flipY: false
		});
	});
	it('clamps a hostile document (the peer-bytes boundary)', () => {
		const s = normalizeSprite({
			ppu: -5,
			filter: 'bogus',
			sheet: { cols: 1e9, rows: 'x', count: 99999 },
			clips: [{ name: 'a', from: -3, to: 1e9, fps: 1e9, loop: 'weird' }, { name: '' }, { name: 'A' }],
			frame: 1e9,
			extra: 'dropped'
		});
		expect(s.ppu).toBe(0.01);
		expect(s.filter).toBe('nearest');
		expect(s.sheet.cols).toBe(64);
		expect(s.sheet.rows).toBe(1);
		expect(s.sheet.count).toBe(64);
		expect(s.clips).toHaveLength(1); // nameless dropped, 'A' collides with 'a' (first wins)
		expect(s.clips[0]).toMatchObject({ from: 0, to: 63, fps: 120, loop: 'loop' });
		expect(s.frame).toBe(63);
		expect('extra' in s).toBe(false);
	});
	it('compactSprite stores only what differs and round-trips', () => {
		expect(compactSprite({})).toEqual({});
		const raw = {
			ppu: 32,
			filter: 'linear',
			snap: true,
			sheet: { cols: 4, rows: 2, count: 7 },
			clips: [{ name: 'walk', from: 0, to: 3, fps: 8 }, { name: 'jump', frames: [4, 5, 6], fps: 12, loop: 'once', next: 'walk', events: [{ frame: 1, name: 'lift' }] }],
			play: 'walk',
			flipX: true
		};
		const c = compactSprite(raw);
		expect(c.sheet).toEqual({ cols: 4, rows: 2, count: 7 });
		expect(normalizeSprite(c)).toEqual(normalizeSprite(raw));
		expect(JSON.stringify(c).length).toBeLessThan(400);
	});
	it('clipByName is case-insensitive and trims', () => {
		const s = normalizeSprite({ clips: [{ name: 'Run' }] });
		expect(clipByName(s, ' run ')?.name).toBe('Run');
		expect(clipByName(s, 'walk')).toBe(null);
		expect(clipByName(s, '')).toBe(null);
	});
});

describe('flipbook timing', () => {
	it('frames: an explicit list wins, a range walks either way', () => {
		expect(clipFrames(clip({ frames: [0, 2, 1] }))).toEqual([0, 2, 1]);
		expect(clipFrames(clip({ from: 1, to: 4 }))).toEqual([1, 2, 3, 4]);
		expect(clipFrames(clip({ from: 3, to: 0 }))).toEqual([3, 2, 1, 0]);
	});
	it('loop: frame = floor(t * fps) mod n', () => {
		const c = clip({ from: 0, to: 3 });
		expect([0, 0.09, 0.1, 0.25, 0.39, 0.4, 0.55].map((t) => clipFrameAt(c, t).frame)).toEqual([0, 0, 1, 2, 3, 0, 1]);
		expect(clipFrameAt(c, 123.4).done).toBe(false);
		expect(clipDuration(c)).toBeCloseTo(0.4);
	});
	it('a step boundary is exact (no float drift at 0.3 s × 10 fps)', () => {
		expect(clipFrameAt(clip({ from: 0, to: 7 }), 0.3).frame).toBe(3);
		expect(clipFrameAt(clip({ from: 0, to: 7, fps: 12 }), 0.5).frame).toBe(6);
	});
	it('once: holds the last frame and reports done', () => {
		const c = clip({ from: 4, to: 6, loop: 'once' });
		expect(clipFrameAt(c, 0.25)).toMatchObject({ frame: 6, done: false });
		expect(clipFrameAt(c, 0.3)).toMatchObject({ frame: 6, done: true });
		expect(clipFrameAt(c, 99)).toMatchObject({ frame: 6, done: true });
	});
	it('pingpong: 0 1 2 3 2 1 0 1 …, period 2n-2', () => {
		const c = clip({ from: 0, to: 3, loop: 'pingpong' });
		const seq = [];
		for (let i = 0; i < 9; i++) seq.push(clipFrameAt(c, i / 10 + 0.001).frame);
		expect(seq).toEqual([0, 1, 2, 3, 2, 1, 0, 1, 2]);
		expect(clipDuration(c)).toBeCloseTo(0.6);
	});
	it('a single-frame clip never divides by zero', () => {
		const c = clip({ from: 2, to: 2 });
		expect(clipFrameAt(c, 5).frame).toBe(2);
		expect(clipFrameAt(clip({ from: 2, to: 2, loop: 'pingpong' }), 5).frame).toBe(2);
	});
	it('negative elapsed (a start stamp a hair in the future) shows frame 0', () => {
		expect(clipFrameAt(clip({ from: 1, to: 3 }), -0.2)).toMatchObject({ frame: 1, step: 0 });
	});
	it('two peers with the same stamp and clock agree on every frame', () => {
		const c = clip({ frames: [0, 1, 2, 1], fps: 12 });
		const start = 3600.123;
		for (let now = start; now < start + 2; now += 0.017) {
			const a = clipFrameAt(c, now - start).frame;
			const b = clipFrameAt(normalizeSprite(JSON.parse(JSON.stringify({ sheet: { cols: 4, rows: 2 }, clips: [{ name: 'c', frames: [0, 1, 2, 1], fps: 12 }] }))).clips[0], now - start).frame;
			expect(a).toBe(b);
		}
	});
});

describe('flipbook events', () => {
	const ev = (over) => clip({ from: 0, to: 3, events: [{ frame: 0, name: 'start' }, { frame: 2, name: 'step' }], ...over });
	it('fires the first frame when started from -1, then each frame as it is entered', () => {
		const c = ev();
		expect(clipEventsBetween(c, -1, 0).events.map((e) => e.name)).toEqual(['start']);
		expect(clipEventsBetween(c, 0, 1).events).toEqual([]);
		expect(clipEventsBetween(c, 1, 2).events.map((e) => e.name)).toEqual(['step']);
	});
	it('a skipped render frame does not skip an event', () => {
		expect(clipEventsBetween(ev(), 1, 3).events.map((e) => e.name)).toEqual(['step']);
		expect(clipEventsBetween(ev(), 3, 6).events.map((e) => e.name)).toEqual(['start', 'step']); // wrapped
	});
	it('a long sleep fires at most two passes, not hundreds', () => {
		expect(clipEventsBetween(ev(), 0, 4000).events.length).toBe(4);
	});
	it('once: events stop at the end and finished fires exactly once', () => {
		const c = ev({ loop: 'once' });
		const a = clipEventsBetween(c, -1, 3);
		expect(a.events.map((e) => e.name)).toEqual(['start', 'step']);
		expect(a.finished).toBe(false);
		expect(clipEventsBetween(c, 3, 4).finished).toBe(true);
		expect(clipEventsBetween(c, 4, 50).finished).toBe(false);
		// slept straight past the end: every event once, then finished
		const b = clipEventsBetween(c, -1, 9000);
		expect(b.events.map((e) => e.name)).toEqual(['start', 'step']);
		expect(b.finished).toBe(true);
	});
	it('pingpong passes an event frame on the way back too', () => {
		const c = clip({ from: 0, to: 3, loop: 'pingpong', events: [{ frame: 2, name: 'mid' }] });
		expect(clipEventsBetween(c, -1, 5).events.length).toBe(2); // steps 2 (up) and 4 (down)
	});
});

describe('sheet uv', () => {
	const sheet = normalizeSprite({ sheet: { cols: 4, rows: 2 } }).sheet;
	it('frame 0 is the TOP-left cell (flipY texture: v measured from the bottom)', () => {
		expect(frameUv(sheet, 0, 64, 32)).toEqual({ offset: [0, 0.5], repeat: [0.25, 0.5] });
		expect(frameUv(sheet, 5, 64, 32)).toEqual({ offset: [0.25, 0], repeat: [0.25, 0.5] });
	});
	it('margin + spacing (the Tiled convention) are honoured', () => {
		const s = normalizeSprite({ sheet: { cols: 2, rows: 1, margin: 1, spacing: 2 } }).sheet;
		// 36 px wide: 1 + 16 + 2 + 16 + 1
		expect(frameSizePx(s, 36, 18)).toEqual({ w: 16, h: 16 });
		const uv = frameUv(s, 1, 36, 18);
		expect(uv.offset[0]).toBeCloseTo(19 / 36);
		expect(uv.repeat[0]).toBeCloseTo(16 / 36);
		expect(uv.offset[1]).toBeCloseTo(1 / 18);
	});
	it('flipX mirrors inside the cell (negative repeat from the far edge)', () => {
		const uv = frameUv(sheet, 1, 64, 32, { flipX: true });
		expect(uv.offset[0]).toBeCloseTo(0.5);
		expect(uv.repeat[0]).toBeCloseTo(-0.25);
	});
	it('an out-of-range frame clamps to the last cell', () => {
		expect(frameUv(sheet, 99, 64, 32)).toEqual(frameUv(sheet, 7, 64, 32));
	});
	it('plane size and pixel snap use ppu', () => {
		expect(planeSize(32, 16, 16)).toEqual({ width: 2, height: 1 });
		expect(snapToPixel(1.03, 16)).toBe(1);
		expect(snapToPixel(1.04, 16)).toBe(1.0625);
		expect(snapToPixel(1.04, 0)).toBe(1.04);
	});
});

describe('layers + parallax', () => {
	it('defaults to 1 (moves with the world) and parallaxY follows parallax', () => {
		expect(normalizeLayer2d({})).toEqual({ parallax: 1, parallaxY: 1 });
		expect(normalizeLayer2d({ parallax: 0.5 })).toEqual({ parallax: 0.5, parallaxY: 0.5 });
		expect(compactLayer2d({ parallax: 0.5 })).toEqual({ parallax: 0.5 });
		expect(compactLayer2d({ parallax: 0.5, parallaxY: 1 })).toEqual({ parallax: 0.5, parallaxY: 1 });
	});
	it('offset = camera × (1 - factor): a sky rides along, the world stays put', () => {
		const cam = { x: 10, y: 2 };
		expect(parallaxOffset(cam, normalizeLayer2d({ parallax: 1 }))).toEqual([0, 0]);
		expect(parallaxOffset(cam, normalizeLayer2d({ parallax: 0 }))).toEqual([10, 2]);
		expect(parallaxOffset(cam, normalizeLayer2d({ parallax: 0.5, parallaxY: 1 }))).toEqual([5, 0]);
	});
	it('three layers scroll at three rates on screen', () => {
		// on-screen x of a layer point authored at 0 = offset - camera x
		const screen = (p, camX) => parallaxOffset({ x: camX, y: 0 }, normalizeLayer2d({ parallax: p }))[0] - camX;
		expect([0.2, 0.5, 1].map((p) => screen(p, 10))).toEqual([-2, -5, -10]);
	});
});

describe('2D camera follow', () => {
	it('the target moves freely inside the dead zone', () => {
		expect(follow2dGoal({ x: 0, y: 0 }, { x: 0.4, y: -0.4 }, { deadW: 1, deadH: 1 })).toEqual({ x: 0, y: 0 });
	});
	it('outside it, the camera moves just enough to put the target on the edge', () => {
		expect(follow2dGoal({ x: 0, y: 0 }, { x: 3, y: 0 }, { deadW: 1, deadH: 1 })).toEqual({ x: 2.5, y: 0 });
		expect(follow2dGoal({ x: 0, y: 0 }, { x: -3, y: 4 }, { deadW: 0, deadH: 2 })).toEqual({ x: -3, y: 3 });
	});
	it('the offset frames the target off-centre; an axis can be locked', () => {
		expect(follow2dGoal({ x: 0, y: 0 }, { x: 5, y: 5 }, { deadW: 0, deadH: 0, ox: 1, oy: -2 })).toEqual({ x: 4, y: 7 });
		expect(follow2dGoal({ x: 0, y: 1 }, { x: 5, y: 5 }, { deadW: 0, deadH: 0, followY: false })).toEqual({ x: 5, y: 1 });
	});
	it('bounds keep the VIEW inside, and a small box centres it', () => {
		const o = normalizeFollow2d({ minX: 0, maxX: 20, minY: 0, maxY: 0 });
		expect(clampView(-5, 3, { hw: 4, hh: 2 }, o)).toEqual({ x: 4, y: 3 });
		expect(clampView(50, 3, { hw: 4, hh: 2 }, o)).toEqual({ x: 16, y: 3 });
		expect(clampView(50, 3, { hw: 12, hh: 2 }, o)).toEqual({ x: 10, y: 3 });
	});
	it('damping is frame-rate independent; 0 is rigid', () => {
		const goal = { x: 10, y: 0 };
		let a = { x: 0, y: 0 };
		for (let i = 0; i < 30; i++) a = follow2dStep(a, goal, 0.2, 1 / 30);
		let b = { x: 0, y: 0 };
		for (let i = 0; i < 120; i++) b = follow2dStep(b, goal, 0.2, 1 / 120);
		expect(a.x).toBeCloseTo(b.x, 6);
		expect(follow2dStep({ x: 0, y: 0 }, goal, 0, 1 / 60)).toEqual(goal);
	});
});

describe('Inspector text forms', () => {
	it('parses and prints clip frames', () => {
		expect(parseFramesText('0-3')).toEqual({ frames: null, from: 0, to: 3 });
		expect(parseFramesText(' 3 - 0 ')).toEqual({ frames: null, from: 3, to: 0 });
		expect(parseFramesText('0, 1, 2, 1')).toEqual({ frames: [0, 1, 2, 1], from: 0, to: 0 });
		expect(parseFramesText('4')).toEqual({ frames: null, from: 4, to: 4 });
		expect(parseFramesText('a-b')).toBeNull();
		const sheet = { sheet: { cols: 4, rows: 2 } };
		for (const t of ['0-3', '3-0', '0, 1, 2, 1', '4']) {
			const clip = normalizeSprite({ ...sheet, clips: [{ name: 'c', ...parseFramesText(t) }] }).clips[0];
			expect(parseFramesText(framesText(clip))).toEqual(parseFramesText(t));
		}
	});
	it('parses and prints events', () => {
		expect(parseEventsText('2:land, 5 : step,junk')).toEqual([
			{ frame: 2, name: 'land' },
			{ frame: 5, name: 'step' }
		]);
		expect(eventsText(parseEventsText('2:land, 5:step'))).toBe('2:land, 5:step');
	});
});
