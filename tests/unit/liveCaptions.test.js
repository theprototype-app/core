// 77 C3 — live subtitles: consent comes only from the speaker's own connection, one elected
// transcriber relays, and a receiver shows a line only for a consenting speaker from the
// transcriber (or the speaker themself).
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { peers } from '../../src/stores/appStore';
import { captionEngines } from '../../src/lib/captionEngines';
import {
	electTranscriber,
	applyLiveCaption,
	relayLiveLine,
	dropPeerLiveCaption,
	liveStates,
	liveLines,
	liveCaptionConsent,
	liveTranscribe,
	transcriberId,
	consentingSpeakers,
	publishLiveState,
	sendLiveState
} from '../../src/lib/liveCaptions';
import { to16k } from '../../src/lib/liveCaptionCapture';

/** @type {any[]} */
let sent = [];
beforeEach(() => {
	sent = [];
	peers.set(/** @type {any} */ ({ peer: { id: 'mmm' }, send: (/** @type {any} */ m) => sent.push(m) }));
	liveStates.set({});
	liveLines.set([]);
	liveCaptionConsent.set(false);
	liveTranscribe.set('auto');
	captionEngines.set([]);
});

describe('electTranscriber', () => {
	it('picks the lowest id, ignores empties, null when nobody volunteers', () => {
		expect(electTranscriber(['zz', 'aa', 'mm'])).toBe('aa');
		expect(electTranscriber(['', 'b'])).toBe('b');
		expect(electTranscriber([])).toBe(null);
	});
});

describe('consent rows', () => {
	it('a row is written by its own connection only, and false deletes it', () => {
		applyLiveCaption({ type: 'livecap', op: 'state', consent: true, transcribe: false }, 'bob');
		expect(get(liveStates)).toEqual({ bob: { consent: true, transcribe: false } });
		expect(get(consentingSpeakers)).toEqual(['bob']);
		applyLiveCaption({ type: 'livecap', op: 'state', consent: false, transcribe: false }, 'bob');
		expect(get(liveStates)).toEqual({});
	});
	it('our own consent counts us as a speaker', () => {
		liveCaptionConsent.set(true);
		expect(get(consentingSpeakers)).toEqual(['mmm']);
	});
});

describe('election', () => {
	it('the lowest volunteering id transcribes; this device volunteers on auto only with a local engine', () => {
		applyLiveCaption({ op: 'state', consent: false, transcribe: true }, 'zed');
		expect(get(transcriberId)).toBe('zed');
		captionEngines.set([/** @type {any} */ ({ id: 'local', local: true, languages: ['en'], transcribe: async () => ({ segments: [] }) })]);
		expect(get(transcriberId)).toBe('mmm');
		applyLiveCaption({ op: 'state', consent: false, transcribe: true }, 'aaa');
		expect(get(transcriberId)).toBe('aaa');
		liveTranscribe.set('off');
		applyLiveCaption({ op: 'state', consent: false, transcribe: false }, 'aaa');
		expect(get(transcriberId)).toBe('zed');
	});
});

describe('lines', () => {
	it('shown only for a consenting speaker, from the elected transcriber or the speaker', () => {
		applyLiveCaption({ op: 'state', consent: false, transcribe: true }, 'ttt');
		// no consent yet → refused
		expect(applyLiveCaption({ op: 'line', speaker: 'bob', text: 'hello', id: 1 }, 'ttt')).toBe(false);
		applyLiveCaption({ op: 'state', consent: true, transcribe: false }, 'bob');
		expect(applyLiveCaption({ op: 'line', speaker: 'bob', text: '  hello   there ', id: 2 }, 'ttt')).toBe(true);
		expect(get(liveLines).map((l) => [l.speaker, l.text])).toEqual([['bob', 'hello there']]);
		// a third peer who is not the transcriber cannot put words in bob's mouth
		expect(applyLiveCaption({ op: 'line', speaker: 'bob', text: 'fake', id: 3 }, 'eve')).toBe(false);
		// bob may caption himself
		expect(applyLiveCaption({ op: 'line', speaker: 'bob', text: 'me again', id: 4 }, 'bob')).toBe(true);
		expect(get(liveLines)).toHaveLength(1);
		expect(get(liveLines)[0].text).toBe('me again');
		// withdrawing consent drops the line on screen at once
		applyLiveCaption({ op: 'state', consent: false, transcribe: false }, 'bob');
		expect(get(liveLines)).toEqual([]);
	});
	it('a line about us needs OUR consent', () => {
		applyLiveCaption({ op: 'state', consent: false, transcribe: true }, 'aaa');
		expect(applyLiveCaption({ op: 'line', speaker: 'mmm', text: 'hi', id: 1 }, 'aaa')).toBe(false);
		liveCaptionConsent.set(true);
		expect(applyLiveCaption({ op: 'line', speaker: 'mmm', text: 'hi', id: 1 }, 'aaa')).toBe(true);
	});
	it('the transcriber relays only consenting speakers, and caps the text', () => {
		captionEngines.set([/** @type {any} */ ({ id: 'local', local: true, languages: ['en'], transcribe: async () => ({ segments: [] }) })]);
		expect(relayLiveLine('bob', 'nope')).toBe(false);
		applyLiveCaption({ op: 'state', consent: true, transcribe: false }, 'bob');
		expect(relayLiveLine('bob', 'x'.repeat(400))).toBe(true);
		const msg = sent.find((m) => m.op === 'line');
		expect(msg).toMatchObject({ type: 'livecap', op: 'line', speaker: 'bob' });
		expect(msg.text).toHaveLength(300);
	});
	it('a departing peer takes its row and its line along', () => {
		applyLiveCaption({ op: 'state', consent: true, transcribe: false }, 'bob');
		applyLiveCaption({ op: 'line', speaker: 'bob', text: 'bye', id: 1 }, 'bob');
		dropPeerLiveCaption('bob');
		expect(get(liveStates)).toEqual({});
		expect(get(liveLines)).toEqual([]);
	});
});

describe('the wire', () => {
	it('publishes on change only; the late-joiner reply says nothing while there is nothing to say', () => {
		sendLiveState();
		expect(sent).toEqual([]);
		liveCaptionConsent.set(true);
		expect(publishLiveState()).toBe(true);
		expect(publishLiveState()).toBe(false);
		expect(sent.at(-1)).toEqual({ type: 'livecap', op: 'state', consent: true, transcribe: false });
		liveCaptionConsent.set(false);
		publishLiveState();
		expect(sent.at(-1)).toEqual({ type: 'livecap', op: 'state', consent: false, transcribe: false });
	});
});

describe('to16k', () => {
	it('resamples 48 kHz to a third of the length and keeps a ramp a ramp', () => {
		const pcm = Float32Array.from({ length: 4800 }, (_, i) => i / 4800);
		const out = to16k(pcm, 48000);
		expect(out.length).toBe(1600);
		expect(out[800]).toBeCloseTo(0.5, 2);
		expect(to16k(pcm, 16000)).toBe(pcm);
	});
});
