// 102b-sound (row 3): a sound's trim / fade / normalise — the clamps, the DSP, the scene-singleton
// rules (latest wins, a save without edits has no field, a restore without the field clears) and the
// preview WAV.
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
	normalizeSoundEdit,
	normalizeSoundEdits,
	soundEdits,
	setSoundEdit,
	applyRemoteSoundEdits,
	soundEditsSnapshot,
	soundEditsRestore,
	soundEditOf,
	soundEditKey,
	soundEditDsp,
	NORMALIZE_PEAK
} from '../../src/lib/soundEdits.js';
import { encodeWav } from '../../src/lib/soundEditSync.js';
import { applySoundEdit } from '../../src/lib/soundEditDsp.js';

const RATE = 100; // 1 sample = 10 ms

beforeEach(() => soundEdits.set({ edits: {}, changedAt: 0 }));

describe('normalizeSoundEdit', () => {
	it('clamps, and an edit that changes nothing is no edit', () => {
		expect(normalizeSoundEdit({ start: -2, end: 0, fadeIn: 0, fadeOut: 0 })).toBe(null);
		expect(normalizeSoundEdit({ fadeIn: 99 })).toEqual({ start: 0, end: 0, fadeIn: 30, fadeOut: 0, normalize: false });
		expect(normalizeSoundEdit({ start: 2, end: 1 })).toEqual({ start: 2, end: 0, fadeIn: 0, fadeOut: 0, normalize: false });
		expect(normalizeSoundEdit({ normalize: 'yes' })).toBe(null);
		expect(normalizeSoundEdit({ normalize: true })?.normalize).toBe(true);
	});
	it('a map drops bad keys and empty edits', () => {
		expect(normalizeSoundEdits({ a: { start: 1 }, b: { start: 0 }, '': { start: 1 } })).toEqual({ a: { start: 1, end: 0, fadeIn: 0, fadeOut: 0, normalize: false } });
		expect(normalizeSoundEdits(null)).toEqual({});
	});
});

describe('applySoundEdit', () => {
	const ramp = () => [Float32Array.from({ length: 100 }, () => 0.5)];
	it('keeps [start, end)', () => {
		const out = applySoundEdit([Float32Array.from({ length: 100 }, (_, i) => i)], RATE, { start: 0.2, end: 0.5, fadeIn: 0, fadeOut: 0, normalize: false });
		expect(out[0].length).toBe(30);
		expect(out[0][0]).toBe(20);
		expect(out[0][29]).toBe(49);
	});
	it('end 0 = to the end of the file', () => {
		const out = applySoundEdit(ramp(), RATE, { start: 0.9, end: 0, fadeIn: 0, fadeOut: 0, normalize: false });
		expect(out[0].length).toBe(10);
	});
	it('fades in from silence and out to silence', () => {
		const out = applySoundEdit(ramp(), RATE, { start: 0, end: 0, fadeIn: 0.1, fadeOut: 0.2, normalize: false });
		expect(out[0][0]).toBe(0);
		expect(out[0][5]).toBeCloseTo(0.25);
		expect(out[0][10]).toBeCloseTo(0.5);
		expect(out[0][99]).toBe(0);
		expect(out[0][89]).toBeCloseTo(0.25);
	});
	it('normalises the peak to -1 dB', () => {
		const out = applySoundEdit([Float32Array.from([0.1, -0.2, 0.05])], RATE, { start: 0, end: 0, fadeIn: 0, fadeOut: 0, normalize: true });
		expect(Math.max(...out[0].map(Math.abs))).toBeCloseTo(NORMALIZE_PEAK, 5);
	});
	it('never writes the original', () => {
		const src = ramp();
		applySoundEdit(src, RATE, { start: 0, end: 0, fadeIn: 0.5, fadeOut: 0, normalize: true });
		expect(src[0][0]).toBe(0.5);
	});
});

describe('the scene singleton', () => {
	it('set, reset, and the key a playing loop restarts on (once the DSP chunk is in)', async () => {
		setSoundEdit('h', { start: 1 }, { silent: true });
		await soundEditDsp();
		expect(soundEditOf('h')?.start).toBe(1);
		expect(soundEditKey('h')).toBe('1,0,0,0,0');
		setSoundEdit('h', { fadeIn: 0.5 }, { silent: true });
		expect(soundEditOf('h')).toEqual({ start: 1, end: 0, fadeIn: 0.5, fadeOut: 0, normalize: false });
		setSoundEdit('h', null, { silent: true });
		expect(soundEditOf('h')).toBe(null);
		expect(soundEditKey('h')).toBe('');
	});
	it('the newest map wins on the wire', () => {
		setSoundEdit('h', { start: 1 }, { silent: true });
		const mine = get(soundEdits).changedAt;
		applyRemoteSoundEdits({ edits: { h: { start: 9 } }, changedAt: mine - 1 });
		expect(soundEditOf('h')?.start).toBe(1);
		applyRemoteSoundEdits({ edits: { h: { start: 2 }, x: { fadeOut: 1 } }, changedAt: mine + 1 });
		expect(soundEditOf('h')?.start).toBe(2);
		expect(soundEditOf('x')?.fadeOut).toBe(1);
	});
	it('a save holds the field only when something is edited; a restore without it clears', () => {
		expect(soundEditsSnapshot()).toBe(null);
		setSoundEdit('h', { end: 3 }, { silent: true });
		expect(soundEditsSnapshot()).toEqual({ h: { start: 0, end: 3, fadeIn: 0, fadeOut: 0, normalize: false } });
		soundEditsRestore(undefined);
		expect(soundEditsSnapshot()).toBe(null);
		soundEditsRestore({ k: { start: 0.5 } });
		expect(soundEditOf('k')?.start).toBe(0.5);
	});
});

describe('encodeWav', () => {
	it('writes a 16-bit PCM WAV', async () => {
		const blob = encodeWav([new Float32Array([0, 1, -1]), new Float32Array([0.5, 0, 0])], 8000);
		const v = new DataView(await blob.arrayBuffer());
		expect(blob.type).toBe('audio/wav');
		expect(v.byteLength).toBe(44 + 3 * 2 * 2);
		expect(v.getUint16(22, true)).toBe(2);
		expect(v.getUint32(24, true)).toBe(8000);
		expect(v.getInt16(44 + 4, true)).toBe(0x7fff);
		expect(v.getInt16(44 + 8, true)).toBe(-0x8000);
	});
});
