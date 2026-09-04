// 23-D1: raw microphone capture and record-to-sample.
//
// A SEPARATE getUserMedia from voice chat, for two independent reasons: voiceChat's stream
// is opened with bare `{audio: true}` (Chrome's echo cancellation, noise suppression and
// auto gain are ON - a chain tuned for speech that mangles anything sung or played), and
// `applyTrackState` sets its track `enabled = micActive || pttHeld`, so a node tapping that
// stream reads SILENCE whenever you are not transmitting. This stream is raw and its track
// stays enabled; recording never fights push-to-talk.
//
// A recording is MediaRecorder -> blob -> the Explorer (addItemFromBytes, content-hashed)
// -> assetShare.sendAsset: late joiners and restores are covered by the existing hash
// push/pull, nothing new travels. The cap is a VISIBLE LENGTH, refused before recording
// starts - a limit the user sees while recording beats a refusal afterwards.
import { writable, get } from 'svelte/store';
import { addItemFromBytes } from './explorer';
import { sendAsset, MAX_SHARED_BYTES } from './assetShare';
import { showToast } from '../stores/appStore';

/** the raw constraints - the whole point of a second stream */
export const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
/** the visible cap on one take */
export const MAX_RECORD_SECONDS = 120;
/** the encoder bitrate we ask for; also what the pre-flight size estimate assumes */
export const RECORD_BITS_PER_SECOND = 96000;
/** the recorded container, first supported wins; null when the browser cannot record */
export const RECORD_MIME = pickMime();

function pickMime() {
	if (typeof MediaRecorder === 'undefined') return null;
	for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'])
		if (MediaRecorder.isTypeSupported?.(mime)) return mime;
	return '';
}

/** @param {string} mime */
function extensionFor(mime) {
	if (mime.startsWith('audio/ogg')) return 'ogg';
	if (mime.startsWith('audio/mp4')) return 'm4a';
	return 'webm';
}

/** @type {MediaStream | null} */
let rawStream = null;
/** @type {Promise<MediaStream> | null} */
let opening = null;

/**
 * The raw microphone stream, opened once and shared by every taker (a Mic device, the
 * recorder). Rejects when the browser refuses; never touches voice chat's stream.
 * @param {MediaTrackConstraints} [constraints] merged over RAW_AUDIO
 * @returns {Promise<MediaStream>}
 */
export function captureMicStream(constraints = {}) {
	if (rawStream && rawStream.getAudioTracks().some((t) => t.readyState === 'live')) return Promise.resolve(rawStream);
	if (opening) return opening;
	opening = navigator.mediaDevices
		.getUserMedia({ audio: { ...RAW_AUDIO, ...constraints } })
		.then((stream) => {
			rawStream = stream;
			for (const track of stream.getAudioTracks()) track.enabled = true; // never gated by PTT
			return stream;
		})
		.finally(() => (opening = null));
	return opening;
}

/** stop the raw stream (a Mic device going away, the recorder done) */
export function releaseMicStream() {
	for (const track of rawStream?.getAudioTracks() ?? []) track.stop();
	rawStream = null;
}

/** the raw stream if it is open, without opening one */
export function currentMicStream() {
	return rawStream;
}

/**
 * The recorder's state for a face or a HUD: `{active, startedAt, maxSeconds, name}`.
 * `seconds` is derived by the reader from `startedAt`.
 * @type {import('svelte/store').Writable<{active: boolean, startedAt: number, maxSeconds: number, name: string}>}
 */
export const recording = writable({ active: false, startedAt: 0, maxSeconds: 0, name: '' });

/** the bytes a take of `seconds` will roughly weigh at the requested bitrate @param {number} seconds */
export function estimateRecordingBytes(seconds) {
	return Math.ceil((seconds * RECORD_BITS_PER_SECOND) / 8);
}

/** @type {{recorder: any, chunks: Blob[], resolve: (item: any) => void, timer: any, name: string} | null} */
let take = null;

/**
 * Record a take from the raw mic into the Explorer, sharing it by hash. Resolves to the
 * Explorer item when the take ends (stopRecording, or the cap) - or to null when it was
 * REFUSED before starting: a length over the cap, a size the share limit would reject, no
 * recorder in this browser, or one already running.
 * @param {{maxSeconds?: number, name?: string}} [opts]
 * @returns {Promise<any>}
 */
export async function startRecording(opts = {}) {
	const maxSeconds = Number(opts.maxSeconds ?? MAX_RECORD_SECONDS);
	const name = String(opts.name || 'take-' + new Date().toISOString().slice(11, 19).replace(/:/g, ''));
	if (take) {
		showToast('Already recording');
		return null;
	}
	if (!RECORD_MIME) {
		showToast('This browser cannot record audio');
		return null;
	}
	if (!(maxSeconds > 0) || maxSeconds > MAX_RECORD_SECONDS) {
		showToast('A take is at most ' + MAX_RECORD_SECONDS + ' s');
		return null;
	}
	if (estimateRecordingBytes(maxSeconds) > MAX_SHARED_BYTES) {
		showToast('A ' + Math.round(maxSeconds) + ' s take would be over the ' + Math.round(MAX_SHARED_BYTES / 1048576) + ' MB sharing limit');
		return null;
	}
	/** @type {MediaStream} */
	let stream;
	try {
		stream = await captureMicStream();
	} catch (error) {
		console.log('mic denied', error);
		showToast('Microphone permission denied');
		return null;
	}
	const recorder = new MediaRecorder(stream, { mimeType: RECORD_MIME, audioBitsPerSecond: RECORD_BITS_PER_SECOND });
	/** @type {Blob[]} */
	const chunks = [];
	recorder.ondataavailable = (event) => {
		if (event.data && event.data.size > 0) chunks.push(event.data);
	};
	const done = new Promise((resolve) => {
		recorder.onstop = async () => {
			const current = take;
			take = null;
			recording.set({ active: false, startedAt: 0, maxSeconds: 0, name: '' });
			try {
				const blob = new Blob(chunks, { type: RECORD_MIME });
				if (!blob.size) {
					showToast('Nothing was recorded');
					return resolve(null);
				}
				const item = await addItemFromBytes(await blob.arrayBuffer(), (current?.name ?? name) + '.' + extensionFor(RECORD_MIME), null, { imported: true });
				sendAsset(item.hash);
				showToast('Recorded ' + item.name);
				resolve(item);
			} catch (error) {
				console.log('recording failed', error);
				showToast('Could not store the recording');
				resolve(null);
			}
		};
	});
	take = { recorder, chunks, resolve: () => {}, timer: null, name };
	recorder.start(250);
	recording.set({ active: true, startedAt: Date.now(), maxSeconds, name });
	take.timer = setTimeout(() => stopRecording(), maxSeconds * 1000);
	return done;
}

/** end the running take (its startRecording promise resolves with the item) */
export function stopRecording() {
	const current = take;
	if (!current) return false;
	clearTimeout(current.timer);
	if (current.recorder.state !== 'inactive') current.recorder.stop();
	return true;
}

export function micCaptureDebug() {
	return {
		mime: RECORD_MIME,
		streamOpen: !!rawStream,
		tracks: (rawStream?.getAudioTracks() ?? []).map((t) => ({ enabled: t.enabled, state: t.readyState, settings: t.getSettings?.() ?? null })),
		recording: get(recording)
	};
}
