// 102b-sound (row 1): the pure halves of "sound in videos and moments" — the PCM slice by time, the
// moment's trim of its sound, the containers a live take with sound can use, the audio codecs per
// container, and that the voice bus is never part of what is recorded.
import { describe, it, expect } from 'vitest';
import { slicePcm, pcmLevel, SCENE_BUSES } from '../../src/lib/recording/sceneAudio.js';
import { momentAudioSlice } from '../../src/lib/moment/momentCore.js';
import { pickAvMimeType, pickMimeType, coerceRecordingPrefs, DEFAULT_RECORDING_PREFS } from '../../src/lib/recording/recordingCore.js';
import { audioCodecCandidates, NO_AUDIO_ENCODER } from '../../src/lib/recording/exportSinks.js';

const RATE = 1000; // 1 frame = 1 ms, so the arithmetic reads in the test

/** a chunk of `n` frames at `t` filled with `v` */
const chunk = (t, n, v) => ({ t, l: new Float32Array(n).fill(v), r: new Float32Array(n).fill(-v) });

describe('slicePcm', () => {
	it('cuts [t0, t1) out of time-stamped chunks', () => {
		const chunks = [chunk(10, 100, 0.5), chunk(10.1, 100, 0.25)];
		const s = slicePcm(chunks, RATE, 10.05, 10.15);
		expect(s.frames).toBe(100);
		expect(s.filled).toBe(100);
		expect(s.channels[0][0]).toBe(0.5);
		expect(s.channels[0][49]).toBe(0.5);
		expect(s.channels[0][50]).toBe(0.25);
		expect(s.channels[1][0]).toBe(-0.5);
	});
	it('pads what no chunk covers with silence and says how much was real', () => {
		const s = slicePcm([chunk(10, 50, 1)], RATE, 9.9, 10.1);
		expect(s.frames).toBe(200);
		expect(s.filled).toBe(50);
		expect(s.channels[0][99]).toBe(0);
		expect(s.channels[0][100]).toBe(1);
		expect(s.channels[0][150]).toBe(0);
	});
	it('a gap between two chunks (the buffer was frozen) stays silent', () => {
		const s = slicePcm([chunk(0, 10, 1), chunk(0.02, 10, 1)], RATE, 0, 0.03);
		expect([...s.channels[0].slice(8, 22)]).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
	});
	it('nothing in range = all silence, zero filled', () => {
		const s = slicePcm([chunk(5, 10, 1)], RATE, 0, 1);
		expect(s.filled).toBe(0);
		expect(pcmLevel(s.channels).peak).toBe(0);
	});
});

describe('momentAudioSlice', () => {
	const audio = { sampleRate: RATE, channels: [Float32Array.from({ length: 100 }, (_, i) => i), Float32Array.from({ length: 100 }, (_, i) => -i)] };
	it('takes the trimmed part, t = 0 at the first kept frame', () => {
		const s = /** @type {any} */ (momentAudioSlice(audio, 0.02, 0.03));
		expect(s.channels[0].length).toBe(30);
		expect(s.channels[0][0]).toBe(20);
		expect(s.channels[1][29]).toBe(-49);
	});
	it('pads past the end of the sound', () => {
		const s = /** @type {any} */ (momentAudioSlice(audio, 0.09, 0.03));
		expect(s.channels[0][9]).toBe(99);
		expect(s.channels[0][10]).toBe(0);
	});
	it('no sound, or no length, is null', () => {
		expect(momentAudioSlice(null, 0, 1)).toBe(null);
		expect(momentAudioSlice(audio, 0, 0)).toBe(null);
	});
});

describe('containers and codecs', () => {
	it('a live take with sound asks for webm + opus first, mp4 + aac for Safari', () => {
		expect(pickAvMimeType(() => true)).toEqual({ mime: 'video/webm;codecs=vp9,opus', ext: 'webm' });
		expect(pickAvMimeType((m) => m.startsWith('video/mp4'))).toEqual({ mime: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4' });
		expect(pickAvMimeType(() => false)).toBe(null);
		expect(
			pickAvMimeType((m) => {
				if (m.includes('vp9')) throw new Error('odd browser');
				return m.includes('vp8');
			})
		).toEqual({ mime: 'video/webm;codecs=vp8,opus', ext: 'webm' });
	});
	it('the silent container choice is unchanged (feature unused = the same file)', () => {
		expect(pickMimeType(() => true)).toEqual({ mime: 'video/webm;codecs=vp9', ext: 'webm' });
	});
	it('audio codecs per container', () => {
		expect(audioCodecCandidates('mp4')).toEqual(['aac', 'opus']);
		expect(audioCodecCandidates('webm')).toEqual(['opus', 'vorbis']);
		expect(NO_AUDIO_ENCODER).toMatch(/silent/);
	});
	it('the sound option defaults on and is kept as a boolean', () => {
		expect(DEFAULT_RECORDING_PREFS.sound).toBe(true);
		expect(coerceRecordingPrefs({ sound: false }).sound).toBe(false);
		expect(coerceRecordingPrefs({ sound: 'yes' }).sound).toBe(true);
	});
});

describe('what is recorded', () => {
	it('every bus but voice', () => {
		expect(SCENE_BUSES).not.toContain('voice');
		expect(SCENE_BUSES).toEqual(expect.arrayContaining(['music', 'sfx', 'instruments']));
	});
	it('pcmLevel reads peak and rms', () => {
		const l = pcmLevel([new Float32Array([0.5, -1, 0, 0])]);
		expect(l.peak).toBe(1);
		expect(l.rms).toBeCloseTo(Math.sqrt(1.25 / 4));
	});
});
