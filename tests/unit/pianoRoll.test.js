// 75 MU2: the piano roll's clip with no browser — the one normalizer (grid, bounds, dedupe,
// order, cap), the stable stored form, the absolute group moves, and which notes a sixteenth
// of the transport plays (a pure function of clip + beat, which is what lets every peer
// schedule the clip itself).
import { describe, it, expect } from 'vitest';
import { normalizeRoll, encodeRoll, withNote, withoutNotes, shiftNotes, notesStartingAt, noteKey, MAX_ROLL_NOTES, ROLL_STEP } from '../../src/lib/pianoRoll.js';

describe('normalizeRoll', () => {
	it('an empty or broken document is an empty one-bar clip that plays', () => {
		for (const raw of [undefined, null, '', 'not json', 42, {}]) expect(normalizeRoll(raw)).toEqual({ bars: 1, on: true, notes: [] });
	});
	it('reads the stored string, tuples and objects alike', () => {
		const a = normalizeRoll('{"bars":2,"on":false,"notes":[[60,0,1,0.8]]}');
		const b = normalizeRoll({ bars: 2, on: false, notes: [{ p: 60, s: 0, l: 1, v: 0.8 }] });
		expect(a).toEqual(b);
		expect(a).toEqual({ bars: 2, on: false, notes: [{ p: 60, s: 0, l: 1, v: 0.8 }] });
	});
	it('snaps to the sixteenth, keeps notes inside the clip, clamps pitch and velocity', () => {
		const r = normalizeRoll({ bars: 1, notes: [[60.4, 0.13, 0.6, 2], [200, 1, 1, 0.5], [61, 3.9, 8, 0], [62, 4, 1, 1], [63, -1, 1, 1]] });
		expect(r.notes).toEqual([
			{ p: 60, s: 0.25, l: 0.5, v: 1 },
			{ p: 127, s: 1, l: 1, v: 0.5 },
			{ p: 61, s: 3.75, l: 0.25, v: 0.05 },
			{ p: 62, s: 3.75, l: 0.25, v: 1 },
			{ p: 63, s: 0, l: 1, v: 1 }
		].sort((x, y) => x.s - y.s || x.p - y.p));
		expect(r.notes.every((n) => n.s + n.l <= 4)).toBe(true);
	});
	it('one note per pitch per start (the later wins), sorted, capped', () => {
		expect(normalizeRoll({ notes: [[60, 0, 1, 0.3], [60, 0, 2, 0.9]] }).notes).toEqual([{ p: 60, s: 0, l: 2, v: 0.9 }]);
		const many = Array.from({ length: 900 }, (_, i) => [i % 128, (Math.floor(i / 128) % 16) * ROLL_STEP, 0.25, 1]);
		expect(normalizeRoll({ bars: 8, notes: many }).notes.length).toBe(MAX_ROLL_NOTES);
	});
	it('bars outside the choices fall back to 1', () => {
		expect(normalizeRoll({ bars: 3 }).bars).toBe(1);
		expect(normalizeRoll({ bars: 8 }).bars).toBe(8);
	});
});

describe('encodeRoll', () => {
	it('is stable: the same clip in any order encodes to the same string', () => {
		const a = encodeRoll({ bars: 1, on: true, notes: [{ p: 64, s: 1, l: 1, v: 0.8 }, { p: 60, s: 0, l: 1, v: 0.8 }] });
		const b = encodeRoll(normalizeRoll(a));
		expect(a).toBe(b);
		expect(a).toBe('{"bars":1,"on":true,"notes":[[60,0,1,0.8],[64,1,1,0.8]]}');
	});
});

describe('edits', () => {
	const base = normalizeRoll({ bars: 1, notes: [[60, 0, 1, 0.8], [64, 0, 1, 0.8], [67, 2, 1, 0.8]] });
	it('withNote replaces the note on its slot; withoutNotes removes', () => {
		const r = withNote(base, { p: 60, s: 0, l: 2, v: 0.5 });
		expect(r.notes.find((n) => n.p === 60)).toEqual({ p: 60, s: 0, l: 2, v: 0.5 });
		expect(r.notes.length).toBe(3);
		expect(withoutNotes(base, (n) => n.p === 67).notes.map(noteKey)).toEqual(['60@0', '64@0']);
	});
	it('shiftNotes moves a chord as a group, from the snapshot', () => {
		const keys = new Set(['60@0', '64@0']);
		const r = shiftNotes(base, keys, { dBeat: 1.1, dPitch: 2 });
		expect(r.notes.map(noteKey)).toEqual(['62@1', '66@1', '67@2']);
		// absolute: the same offset from the same snapshot gives the same result
		expect(shiftNotes(base, keys, { dBeat: 1.1, dPitch: 2 })).toEqual(r);
	});
	it('a group move clamps at the edges and keeps the chord shape', () => {
		const keys = new Set(['60@0', '64@0']);
		const r = shiftNotes(base, keys, { dBeat: -5, dPitch: 100 });
		expect(r.notes.filter((n) => n.s === 0).map((n) => n.p)).toEqual([123, 127]);
	});
	it('a stretch never goes below a sixteenth nor past the clip end', () => {
		const keys = new Set(['67@2']);
		expect(shiftNotes(base, keys, { dLength: -5 }).notes.find((n) => n.p === 67)?.l).toBe(ROLL_STEP);
		expect(shiftNotes(base, keys, { dLength: 9 }).notes.find((n) => n.p === 67)?.l).toBe(2);
	});
	it('a moved note landing on another replaces it', () => {
		const r = shiftNotes(base, new Set(['67@2']), { dBeat: -2, dPitch: -3 });
		expect(r.notes.map(noteKey)).toEqual(['60@0', '64@0']);
	});
});

describe('notesStartingAt', () => {
	const roll = normalizeRoll({ bars: 1, notes: [[60, 0, 1, 1], [62, 0.25, 1, 1], [64, 3.75, 0.25, 1]] });
	it('plays the notes that start in this sixteenth, at absolute beats', () => {
		expect(notesStartingAt(roll, 0).map((n) => [n.p, n.at])).toEqual([[60, 0]]);
		expect(notesStartingAt(roll, 0.25).map((n) => [n.p, n.at])).toEqual([[62, 0.25]]);
		expect(notesStartingAt(roll, 0.5)).toEqual([]);
	});
	it('loops: the clip repeats every bar', () => {
		expect(notesStartingAt(roll, 4).map((n) => [n.p, n.at])).toEqual([[60, 4]]);
		expect(notesStartingAt(roll, 39.75).map((n) => [n.p, n.at])).toEqual([[64, 39.75]]);
	});
	it('every sixteenth of one loop plays each note exactly once', () => {
		const played = [];
		for (let b = 8; b < 12; b += ROLL_STEP) played.push(...notesStartingAt(roll, b).map((n) => n.p));
		expect(played.sort()).toEqual([60, 62, 64]);
	});
});
