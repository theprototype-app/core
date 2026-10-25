// 77 C3 — THE TRANSCRIBER'S HALF of live subtitles (LAZY: liveCaptions.js loads it only on the
// elected peer while somebody consents). For each consenting speaker it listens to the voice it
// already receives (`remoteStreams`; our own mic through `borrowMicTrack`, and only while we are
// actually transmitting — open mic or push-to-talk held), cuts the speech into utterances with an
// energy gate, turns each into text with the caption engine, and relays it (`relayLiveLine`).
//
// One job at a time across every speaker (a model is one worker); a backlog keeps only the newest
// few, because a caption that arrives ten seconds late is worse than none. A volunteer on 'auto'
// uses an in-browser engine ONLY (no audio leaves this device); 'on' may use the speech server.
import { get, derived } from 'svelte/store';
import { remoteStreams, borrowMicTrack, micActive, pttActive, ensureAudioContext } from './voiceChat';
import { consentingSpeakers, liveTranscribe, relayLiveLine } from './liveCaptions';
import { peers, showToast } from '../stores/appStore';

const BLOCK = 4096;
const HANG_MS = 600; // silence that ends an utterance
const MAX_MS = 7000; // a monologue is cut into pieces this long
const MIN_MS = 400; // shorter = a click, not speech
const BACKLOG = 3;

/** @typedef {{id: string, stream: MediaStream, source: any, node: any, sink: any, track: MediaStreamTrack | null, chunks: Float32Array[], pre: Float32Array[], speaking: boolean, silentMs: number, totalMs: number, floor: number}} Ear */

/** @type {Map<string, Ear>} */
const ears = new Map();
/** @type {{speaker: string, pcm: Float32Array}[]} */
const queue = [];
let busy = false;
/** @type {(() => void) | null} */
let unsub = null;
const stats = { utterances: 0, transcribed: 0, dropped: 0, errors: 0, lastError: '', lastText: '' };
let lastToast = 0;

const myId = () => /** @type {any} */ (get(peers))?.peer?.id ?? '';
const transmitting = () => get(micActive) || get(pttActive);

/** @param {Float32Array[]} parts */
function concat(parts) {
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Float32Array(n);
	let o = 0;
	for (const p of parts) out.set(p, o), (o += p.length);
	return out;
}

/** Linear-interpolated resample to 16 kHz (speech; the engines low-pass anyway). @param {Float32Array} pcm @param {number} rate */
export function to16k(pcm, rate) {
	if (rate === 16000) return pcm;
	const n = Math.floor((pcm.length * 16000) / rate);
	const out = new Float32Array(n);
	const step = rate / 16000;
	for (let i = 0; i < n; i++) {
		const x = i * step;
		const j = Math.floor(x);
		const f = x - j;
		out[i] = (pcm[j] ?? 0) * (1 - f) + (pcm[j + 1] ?? pcm[j] ?? 0) * f;
	}
	return out;
}

/** @param {Ear} ear @param {number} rate */
function flush(ear, rate) {
	const pcm = concat(ear.chunks);
	ear.chunks = [];
	ear.totalMs = 0;
	if ((pcm.length / rate) * 1000 < MIN_MS) return;
	stats.utterances++;
	queue.push({ speaker: ear.id, pcm: to16k(pcm, rate) });
	while (queue.length > BACKLOG) queue.shift(), stats.dropped++;
	void pump();
}

/** @param {Ear} ear @param {AudioProcessingEvent} e */
function hear(ear, e) {
	const rate = e.inputBuffer.sampleRate;
	const block = new Float32Array(e.inputBuffer.getChannelData(0));
	const ms = (block.length / rate) * 1000;
	// our own voice only while it is actually going out to the session
	if (ear.id === myId() && !transmitting()) {
		if (ear.speaking) flush(ear, rate);
		ear.speaking = false;
		ear.pre = [];
		return;
	}
	let sum = 0;
	for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
	const rms = Math.sqrt(sum / block.length);
	ear.floor = ear.floor ? (rms < ear.floor ? ear.floor * 0.9 + rms * 0.1 : ear.floor * 0.998 + rms * 0.002) : rms;
	const loud = rms > Math.max(0.008, ear.floor * 3);
	if (loud) {
		if (!ear.speaking) ear.chunks = [...ear.pre];
		ear.speaking = true;
		ear.silentMs = 0;
	}
	if (ear.speaking) {
		ear.chunks.push(block);
		ear.totalMs += ms;
		if (!loud) ear.silentMs += ms;
		if (ear.silentMs >= HANG_MS) {
			ear.speaking = false;
			flush(ear, rate);
		} else if (ear.totalMs >= MAX_MS) flush(ear, rate);
	} else {
		ear.pre.push(block);
		if (ear.pre.length > 2) ear.pre.shift();
	}
}

async function pump() {
	if (busy) return;
	busy = true;
	try {
		const jobs = await import('./captionJobs');
		while (queue.length) {
			const job = /** @type {{speaker: string, pcm: Float32Array}} */ (queue.shift());
			if (!get(consentingSpeakers).includes(job.speaker)) continue;
			try {
				const out = await jobs.transcribePcm(job.pcm, { needLocal: get(liveTranscribe) !== 'on' });
				const text = (out.segments.map((s) => s.text).join(' ') || out.text || '').trim();
				if (text && relayLiveLine(job.speaker, text)) stats.transcribed++, (stats.lastText = text);
			} catch (error) {
				stats.errors++;
				stats.lastError = jobs.describeCaptionError(error);
				if (Date.now() - lastToast > 30000) {
					lastToast = Date.now();
					showToast('Live captions: ' + stats.lastError);
				}
			}
		}
	} finally {
		busy = false;
	}
}

/** @param {string} id @param {MediaStream} stream @param {MediaStreamTrack | null} track */
function listen(id, stream, track) {
	const ctx = ensureAudioContext();
	// a context still waiting for a gesture runs no processor (the next press in the page resumes it too)
	if (ctx.state === 'suspended') ctx.resume().catch(() => {});
	const source = ctx.createMediaStreamSource(stream);
	const node = ctx.createScriptProcessor(BLOCK, 1, 1);
	// a processor only runs while it reaches the destination — through a silent gain
	const sink = ctx.createGain();
	sink.gain.value = 0;
	source.connect(node);
	node.connect(sink);
	sink.connect(ctx.destination);
	/** @type {Ear} */
	const ear = { id, stream, source, node, sink, track, chunks: [], pre: [], speaking: false, silentMs: 0, totalMs: 0, floor: 0 };
	node.onaudioprocess = (/** @type {AudioProcessingEvent} */ e) => hear(ear, e);
	ears.set(id, ear);
}

/** @param {string} id */
function unlisten(id) {
	const ear = ears.get(id);
	if (!ear) return;
	ears.delete(id);
	ear.node.onaudioprocess = null;
	for (const n of [ear.source, ear.node, ear.sink]) {
		try {
			n.disconnect();
		} catch {}
	}
	ear.track?.stop(); // our borrowed mic copy — never voice chat's own track
}

/** listen to exactly the consenting speakers whose voice we have */
function reconcile() {
	const want = new Set(get(consentingSpeakers));
	const streams = get(remoteStreams);
	const me = myId();
	for (const id of [...ears.keys()]) {
		const ear = /** @type {Ear} */ (ears.get(id));
		const gone = !want.has(id) || (id !== me && streams[id] !== ear.stream) || (id === me && ear.track?.readyState !== 'live');
		if (gone) unlisten(id);
	}
	for (const id of want) {
		if (ears.has(id)) continue;
		if (id === me) {
			const track = borrowMicTrack();
			if (track) listen(id, new MediaStream([track]), track);
		} else if (streams[id]) listen(id, streams[id], null);
	}
}

export function startCapture() {
	if (unsub) return reconcile();
	unsub = derived([consentingSpeakers, remoteStreams, micActive, pttActive], (v) => v).subscribe(() => reconcile());
}

export function stopCapture() {
	unsub?.();
	unsub = null;
	for (const id of [...ears.keys()]) unlisten(id);
	queue.length = 0;
}

/** test/debug view */
export function liveCaptureDebug() {
	return { running: !!unsub, ears: [...ears.keys()], queued: queue.length, busy, ...stats };
}
