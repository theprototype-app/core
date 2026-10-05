import { writable, get } from 'svelte/store';
import { transcribe, describeSttError } from './stt.js';
import { borrowMicTrack } from '../voiceChat';

// Voice typing capture (36-vr-ai, plan F2): record while held, transcribe on release. ONE dictation at a
// time, shared by the VR AI panel (hold the mic button or the talk binding — the transcript is sent) and the
// desktop AI window (click the mic — the transcript lands in the input, editable).
//
// THE MICROPHONE: when voice chat already holds a stream, we record a CLONE of its track (borrowMicTrack) —
// no second capture, nothing sent to peers, voice chat unaffected; otherwise we open our own and release it
// the moment the recording ends (the 27-H rule: no indicator outliving its use).

/** @typedef {{state: 'idle' | 'recording' | 'transcribing', source: string | null, error: string}} Dictation */

/** @type {import('svelte/store').Writable<Dictation>} */
export const dictation = writable({ state: 'idle', source: null, error: '' });

/** a recording ends itself after this long (a stuck button must not record forever) */
export const MAX_DICTATION_MS = 60000;
/** shorter than this is a tap, not speech — nothing is sent */
export const MIN_DICTATION_MS = 250;

/** @type {MediaRecorder | null} */ let recorder = null;
/** @type {MediaStream | null} */ let stream = null;
/** @type {Blob[]} */ let chunks = [];
/** when the person PRESSED (the hold is theirs, not the recorder's) */
let pressedAt = 0;
/** @type {any} */ let capTimer = null;
/** @type {Promise<boolean> | null} */ let starting = null;
let cancelled = false;
/** the last few start/stop calls with their hold lengths (the voice suite reads it when a dictation misbehaves) */
/** @type {string[]} */
export const dictationTrace = [];
/** @param {string} what */
function trace(what) {
	dictationTrace.push(Math.round(performance.now()) + ' ' + what);
	if (dictationTrace.length > 20) dictationTrace.shift();
}

/** the best container this browser records (Quest/Chrome: webm/opus; Safari: mp4) */
function pickMime() {
	if (typeof MediaRecorder === 'undefined') return '';
	for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
		try {
			if (MediaRecorder.isTypeSupported(type)) return type;
		} catch {}
	}
	return '';
}

function releaseStream() {
	clearTimeout(capTimer);
	capTimer = null;
	try {
		stream?.getTracks().forEach((track) => track.stop());
	} catch {}
	stream = null;
}

/** @param {string} source */
async function begin(source) {
	cancelled = false;
	dictation.set({ state: 'recording', source, error: '' });
	try {
		if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
			throw new Error('This browser cannot record audio');
		}
		const borrowed = borrowMicTrack();
		stream = borrowed ? new MediaStream([borrowed]) : await navigator.mediaDevices.getUserMedia({ audio: true });
		if (cancelled) {
			releaseStream();
			return false;
		}
		const mimeType = pickMime();
		recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
		chunks = [];
		recorder.ondataavailable = (event) => {
			if (event.data?.size) chunks.push(event.data);
		};
		recorder.start();
		// the cap stops the RECORDER only; the release that comes later still transcribes what was heard
		capTimer = setTimeout(() => {
			if (recorder?.state === 'recording') recorder.stop();
		}, MAX_DICTATION_MS);
		return true;
	} catch (error) {
		releaseStream();
		recorder = null;
		const denied = error instanceof Error && /NotAllowed|Permission/i.test(error.name + error.message);
		dictation.set({
			state: 'idle',
			source,
			error: denied ? 'Microphone permission denied' : error instanceof Error ? error.message : 'Microphone unavailable'
		});
		return false;
	}
}

/** Start recording. Resolves false when a dictation is already running or the mic is unavailable.
 * @param {string} source who asked ('vr', 'vr-ptt', 'desktop') @returns {Promise<boolean>} */
export function startDictation(source) {
	if (get(dictation).state !== 'idle') return Promise.resolve(false);
	pressedAt = performance.now();
	trace('start ' + source);
	starting = begin(source);
	return starting;
}

/** Stop recording and transcribe. Resolves the transcript, or '' (a tap, a cancel, or an error — the error
 * is on the store). @returns {Promise<string>} */
export async function stopDictation() {
	// the hold is the PERSON'S: press to release, read before anything is awaited. Opening the mic and the
	// recorder's stop event can each take hundreds of ms; timing from either misreads a tap as speech (the
	// stop event) or a real sentence as a tap (a slow getUserMedia)
	const heldMs = performance.now() - pressedAt;
	trace('stop held ' + Math.round(heldMs));
	if (starting) await starting;
	starting = null;
	const rec = recorder;
	recorder = null;
	const source = get(dictation).source;
	if (!rec) {
		if (get(dictation).state === 'recording') dictation.set({ state: 'idle', source, error: '' });
		return '';
	}
	await new Promise((resolve) => {
		if (rec.state === 'inactive') resolve(null);
		else {
			rec.addEventListener('stop', () => resolve(null), { once: true });
			rec.stop();
		}
	});
	releaseStream();
	const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
	chunks = [];
	if (heldMs < MIN_DICTATION_MS || !blob.size) {
		dictation.set({ state: 'idle', source, error: '' });
		return '';
	}
	dictation.set({ state: 'transcribing', source, error: '' });
	try {
		const text = await transcribe(blob);
		dictation.set({ state: 'idle', source, error: text ? '' : 'Nothing was heard' });
		return text;
	} catch (error) {
		dictation.set({ state: 'idle', source, error: describeSttError(error) });
		return '';
	}
}

/** Drop a recording without transcribing (the panel closed, VR ended). */
export function cancelDictation() {
	cancelled = true;
	const rec = recorder;
	recorder = null;
	starting = null;
	try {
		if (rec && rec.state !== 'inactive') rec.stop();
	} catch {}
	releaseStream();
	chunks = [];
	const now = get(dictation);
	if (now.state === 'recording') dictation.set({ state: 'idle', source: now.source, error: '' });
}
