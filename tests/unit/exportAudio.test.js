// 102b-sound (row 2): where a frame-exact export's sounds land on the file's clock — the same mapping
// the frames use (frameClock.timelineTime / rangeTime), checked against it.
import { describe, it, expect } from 'vitest';
import { timelineSegments, planTimelineAudio, planMusicBed } from '../../src/lib/recording/exportAudioCore.js';
import { timelineTime, rangeTime } from '../../src/lib/recording/frameClock.js';

/** @param {any[]} items @param {boolean} [muted] */
const audioTrack = (items, muted = false) => ({ kind: 'audio', muted, items });
/** @param {number} t @param {number} dur @param {string} [sound] @param {number} [gain] */
const clip = (t, dur, sound = 'h1', gain = 1) => ({ t, dur, sound, gain });

describe('timelineSegments', () => {
	it('a plain take: one stretch from the start, ending at the timeline end (the frames hold after it)', () => {
		expect(timelineSegments({ duration: 4 }, 6)).toEqual([{ at: 0, len: 4, tl: 0 }]);
		expect(timelineSegments({ duration: 4, start: 1 }, 2)).toEqual([{ at: 0, len: 2, tl: 1 }]);
	});
	it('a looping timeline wraps where the frames wrap', () => {
		const segs = timelineSegments({ duration: 2, start: 0.5, loop: true }, 5);
		expect(segs).toEqual([
			{ at: 0, len: 1.5, tl: 0.5 },
			{ at: 1.5, len: 2, tl: 0 },
			{ at: 3.5, len: 1.5, tl: 0 }
		]);
		// every segment agrees with the frame clock at its first frame
		for (const s of segs) expect(timelineTime(Math.round(s.at * 30), 30, { duration: 2, start: 0.5, loop: true })).toBeCloseTo(s.tl, 6);
	});
	it("Film's chosen shots: the ranges back to back, as rangeTime poses them", () => {
		const ranges = [
			[1, 2],
			[5, 7.5]
		];
		const segs = timelineSegments({ duration: 10 }, 3.5, ranges);
		expect(segs).toEqual([
			{ at: 0, len: 1, tl: 1 },
			{ at: 1, len: 2.5, tl: 5 }
		]);
		expect(rangeTime(30, 30, ranges)).toBeCloseTo(5, 6);
	});
	it('nothing to place: no length, no timeline', () => {
		expect(timelineSegments({ duration: 4 }, 0)).toEqual([]);
		expect(timelineSegments({ duration: 0 }, 3)).toEqual([]);
	});
});

describe('planTimelineAudio', () => {
	it('places each clip at its time, for its window', () => {
		const seq = { duration: 10, tracks: [audioTrack([clip(1, 2, 'a', 0.5), clip(4, 3, 'b')])] };
		expect(planTimelineAudio(seq, 10)).toEqual([
			{ sound: 'a', gain: 0.5, at: 1, offset: 0, dur: 2 },
			{ sound: 'b', gain: 1, at: 4, offset: 0, dur: 3 }
		]);
	});
	it('a take starting mid-clip starts the clip mid-way; the file end cuts it', () => {
		const seq = { duration: 10, start: 2, tracks: [audioTrack([clip(1, 4)])] };
		expect(planTimelineAudio(seq, 2)).toEqual([{ sound: 'h1', gain: 1, at: 0, offset: 1, dur: 2 }]);
	});
	it('a loop plays the clip again every lap', () => {
		const seq = { duration: 2, loop: true, tracks: [audioTrack([clip(0.5, 1)])] };
		const p = planTimelineAudio(seq, 5);
		expect(p.map((x) => x.at)).toEqual([0.5, 2.5, 4.5]);
		expect(p[2].dur).toBeCloseTo(0.5, 9);
	});
	it("shots: only what each chosen range holds", () => {
		const seq = { duration: 10, tracks: [audioTrack([clip(0, 3, 'a'), clip(6, 2, 'b')])] };
		const p = planTimelineAudio(seq, 3, [
			[2, 4],
			[6.5, 7.5]
		]);
		expect(p).toEqual([
			{ sound: 'a', gain: 1, at: 0, offset: 2, dur: 1 },
			{ sound: 'b', gain: 1, at: 2, offset: 0.5, dur: 1 }
		]);
	});
	it('muted tracks, clips with no sound yet and other track kinds make no sound', () => {
		const seq = { duration: 10, tracks: [audioTrack([clip(0, 2)], true), audioTrack([{ t: 0, dur: 2, sound: '' }]), { kind: 'camera', items: [clip(0, 2)] }] };
		expect(planTimelineAudio(seq, 10)).toEqual([]);
	});
});

describe('planMusicBed', () => {
	const music = { hash: 'm', playing: true, startedAt: 1000 };
	it('starts at the phase heard now, at the listener gain', () => {
		expect(planMusicBed(music, 0.6, 1000 + 12500, 10)).toEqual({ sound: 'm', gain: 0.6, offset: 2.5 });
	});
	it('no track, stopped, muted or unreadable = no bed', () => {
		expect(planMusicBed({ ...music, playing: false }, 1, 2000, 10)).toBe(null);
		expect(planMusicBed({ ...music, hash: null }, 1, 2000, 10)).toBe(null);
		expect(planMusicBed(music, 0, 2000, 10)).toBe(null);
		expect(planMusicBed(music, 1, 2000, 0)).toBe(null);
	});
});
