// 77 C1 — CAPTION JOBS: audio in, timed caption cues out. LAZY (the Timeline editor and Settings
// import it on demand), so nothing here sits in the boot bundle.
//
// · the BUILT-IN engine 'whisper' — the Settings ▸ AI ▸ Voice typing server (stt.js presets: OpenAI
//   whisper-1, Groq whisper-large-v3, a self-hosted whisper.cpp / faster-whisper). It asks for
//   `verbose_json` with segment timestamps; a server that only answers text gets ONE cue over the
//   clip (still a subtitle, just not timed inside it). Audio travels as a 16 kHz mono WAV.
// · `autoCaption(seqId)` — the selected audio items (or every audio item on an unmuted track) are
//   decoded, resampled, transcribed by the chosen engine (captionEngines.pickCaptionEngine), and
//   their cues land on ONE new caption track in ONE edit (one undo step, one broadcast).
// · `.srt` / `.vtt` import into a caption track and export of a sequence's cues (subtitleFormat.js).
// Everything authored here is ordinary sequence data: it saves, replicates and undoes with the scene.
import { get } from 'svelte/store';
import { sttConfig, sttReady, describeSttError } from './ai/stt.js';
import { AiHttpError } from './ai/client.js';
import { captionEngines, registerCaptionEngine, pickCaptionEngine, captionLanguage } from './captionEngines';
import { sequenceOf, addCues, sequenceSelection, findItem } from './sequences';
import { cuesFromSegments, cuesOfSequence, formatSrt, formatVtt, parseSubtitles } from './subtitleFormat';
import { showToast, showToastById } from '../stores/appStore.js';

export const CAPTION_RATE = 16000;

// ---- audio --------------------------------------------------------------------

/**
 * Any AudioBuffer -> 16 kHz mono Float32 PCM (an OfflineAudioContext does the mixdown + resample).
 * @param {AudioBuffer} buffer @returns {Promise<Float32Array>}
 */
export async function toCaptionPcm(buffer) {
	if (buffer.sampleRate === CAPTION_RATE && buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
	const frames = Math.max(1, Math.ceil(buffer.duration * CAPTION_RATE));
	const ctx = new OfflineAudioContext(1, frames, CAPTION_RATE);
	const src = ctx.createBufferSource();
	src.buffer = buffer;
	src.connect(ctx.destination);
	src.start();
	const out = await ctx.startRendering();
	return out.getChannelData(0);
}

/** Float32 PCM -> a 16-bit PCM WAV blob @param {Float32Array} pcm @param {number} rate */
export function pcmToWav(pcm, rate = CAPTION_RATE) {
	const buffer = new ArrayBuffer(44 + pcm.length * 2);
	const view = new DataView(buffer);
	const text = (/** @type {number} */ at, /** @type {string} */ s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
	text(0, 'RIFF');
	view.setUint32(4, 36 + pcm.length * 2, true);
	text(8, 'WAVE');
	text(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, rate, true);
	view.setUint32(28, rate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	text(36, 'data');
	view.setUint32(40, pcm.length * 2, true);
	for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
	return new Blob([buffer], { type: 'audio/wav' });
}

// ---- the built-in server engine ------------------------------------------------------

/**
 * The server answer -> segments. `verbose_json` carries `segments[{start, end, text}]`; a bare
 * `{text}` or plain text becomes one segment over the clip.
 * @param {any} data @param {number} clipSeconds @returns {{segments: import('./captionEngines').Segment[], text: string, language?: string}}
 */
export function segmentsFromServer(data, clipSeconds) {
	const text = String(typeof data === 'string' ? data : (data?.text ?? '')).trim();
	const raw = Array.isArray(data?.segments) ? data.segments : [];
	const segments = raw
		.map((/** @type {any} */ s) => ({ start: Number(s?.start), end: Number(s?.end), text: String(s?.text ?? '').trim() }))
		.filter((/** @type {any} */ s) => s.text && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
	if (!segments.length && text) segments.push({ start: 0, end: Math.max(0.5, clipSeconds), text });
	return { segments, text, language: typeof data?.language === 'string' ? data.language : undefined };
}

/** @type {import('./captionEngines').CaptionEngine} */
const whisperEngine = {
	id: 'whisper',
	label: 'Speech-to-text server',
	local: false,
	languages: ['*'],
	status: () => (sttReady() ? `${get(sttConfig).model} at ${get(sttConfig).baseUrl}` : 'not set up (Settings ▸ AI ▸ Voice typing)'),
	async transcribe(job) {
		const config = get(sttConfig);
		if (!sttReady(config)) throw new Error('Set up a speech-to-text server first (Settings ▸ AI ▸ Voice typing)');
		const form = new FormData();
		form.append('file', pcmToWav(job.audio, job.sampleRate), 'speech.wav');
		form.append('model', config.model);
		form.append('response_format', 'verbose_json');
		form.append('timestamp_granularities[]', 'segment');
		const language = job.language || config.language;
		if (language) form.append('language', language);
		/** @type {Record<string, string>} */
		const headers = {};
		if (config.apiKey) headers['Authorization'] = 'Bearer ' + config.apiKey;
		const res = await fetch(config.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions', { method: 'POST', headers, body: form, signal: job.signal });
		if (!res.ok) throw new AiHttpError(res.status, await res.text().catch(() => ''));
		const kind = res.headers.get('content-type') || '';
		const data = kind.includes('application/json') ? await res.json() : await res.text();
		return segmentsFromServer(data, job.audio.length / job.sampleRate);
	}
};

/** Install the built-in engine once (idempotent). */
export function ensureServerEngine() {
	if (!get(captionEngines).some((e) => e.id === 'whisper')) registerCaptionEngine(whisperEngine);
}
ensureServerEngine();

/**
 * Transcribe PCM with the chosen engine. Throws a readable Error when nothing can run.
 * @param {Float32Array} pcm @param {{language?: string, signal?: AbortSignal, engine?: string, needLocal?: boolean}} [opts]
 */
export async function transcribePcm(pcm, opts = {}) {
	ensureServerEngine();
	const language = opts.language ?? get(captionLanguage);
	const engine = pickCaptionEngine({ pref: opts.engine, language, serverReady: sttReady(), needLocal: opts.needLocal });
	if (!engine) throw new Error(opts.needLocal ? 'Install the Captions module (Modules ▸ Captions) to caption on this device' : 'Install the Captions module or set up a speech-to-text server (Settings ▸ AI ▸ Voice typing)');
	const out = await engine.transcribe({ audio: pcm, sampleRate: CAPTION_RATE, language: language || undefined, signal: opts.signal });
	return { engine: engine.id, segments: out?.segments ?? [], text: out?.text ?? '' };
}

/** A readable reason for a failed job @param {unknown} error */
export function describeCaptionError(error) {
	if (error instanceof AiHttpError || (error instanceof Error && error.name === 'TypeError')) return describeSttError(error);
	return error instanceof Error ? error.message : String(error);
}

// ---- auto-caption a sequence ------------------------------------------------------

/** the audio items a job covers: the selected ones, else every one on an unmuted audio track @param {any} seq */
function audioItemsOf(seq) {
	const picked = new Set(get(sequenceSelection));
	/** @type {any[]} */
	const all = [];
	for (const track of seq?.tracks ?? []) if (track.kind === 'audio' && !track.muted) for (const it of track.items) if (it.sound) all.push(it);
	const selected = all.filter((it) => picked.has(it.id));
	return selected.length ? selected : all;
}

/** @type {Set<string>} the sequences with a job running (a second press waits for the first) */
const running = new Set();

/**
 * Caption a sequence's speech: every covered audio item -> cues on ONE new caption track.
 * @param {string} seqId @param {{engine?: string, itemIds?: string[]}} [opts]
 * @returns {Promise<{added: number, trackId: string | null, engine: string | null, failed: number}>}
 */
export async function autoCaption(seqId, opts = {}) {
	const seq = sequenceOf(seqId);
	if (!seq) return { added: 0, trackId: null, engine: null, failed: 0 };
	const items = opts.itemIds ? opts.itemIds.map((id) => findItem(seq, id)?.item).filter((it) => it?.sound) : audioItemsOf(seq);
	if (!items.length) {
		showToast('Add an audio clip to the timeline first — captions are made from its speech');
		return { added: 0, trackId: null, engine: null, failed: 0 };
	}
	if (running.has(seqId)) return { added: 0, trackId: null, engine: null, failed: 0 };
	running.add(seqId);
	const toast = 'captions-job-' + seqId;
	/** @type {import('./subtitleFormat').Cue[]} */
	const cues = [];
	let engine = null;
	let failed = 0;
	try {
		const { sampleBuffer } = await import('./soundRuntime');
		for (const [i, item] of items.entries()) {
			showToastById(toast, `Captioning ${items.length > 1 ? `clip ${i + 1} of ${items.length}` : item.name || 'the clip'}…`);
			try {
				const buffer = await sampleBuffer(item.sound, { timeoutMs: 20000 });
				if (!buffer) throw new Error('the sound has not arrived on this device yet');
				const pcm = await toCaptionPcm(buffer);
				const out = await transcribePcm(pcm, { engine: opts.engine });
				engine = out.engine;
				cues.push(...cuesFromSegments(out.segments, { offset: item.t, window: item.dur }));
			} catch (error) {
				failed++;
				showToast(`Could not caption ${item.name || 'a clip'}: ${describeCaptionError(error)}`);
				if (/Install the Captions module|set up a speech-to-text/.test(String(/** @type {any} */ (error)?.message))) break;
			}
		}
		const done = cues.length ? addCues(seqId, null, cues, 'Auto captions') : null;
		showToastById(toast, cues.length ? `Added ${cues.length} caption${cues.length === 1 ? '' : 's'} on a new track` : 'No speech found to caption');
		return { added: cues.length, trackId: done?.trackId ?? null, engine, failed };
	} finally {
		running.delete(seqId);
	}
}

// ---- files ------------------------------------------------------------------

/** Hand a text file to the browser's download @param {string} name @param {string} text @param {string} type */
export function downloadText(name, text, type) {
	const url = URL.createObjectURL(new Blob([text], { type }));
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** a file-system-safe base name @param {string} name */
function baseName(name) {
	return String(name || 'captions').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'captions';
}

/**
 * The sequence's caption cues as a file's text.
 * @param {string} seqId @param {'vtt' | 'srt'} format @returns {{name: string, text: string, count: number} | null}
 */
export function subtitleFileOf(seqId, format) {
	const seq = sequenceOf(seqId);
	if (!seq) return null;
	const cues = cuesOfSequence(seq);
	return { name: `${baseName(seq.name)}.${format}`, text: format === 'srt' ? formatSrt(cues) : formatVtt(cues), count: cues.length };
}

/** Export: download the .vtt / .srt of a sequence @param {string} seqId @param {'vtt' | 'srt'} format */
export function exportSubtitles(seqId, format) {
	const file = subtitleFileOf(seqId, format);
	if (!file) return false;
	if (!file.count) {
		showToast('This sequence has no captions to export yet');
		return false;
	}
	downloadText(file.name, file.text, format === 'srt' ? 'application/x-subrip' : 'text/vtt');
	return true;
}

/**
 * Import cues from .srt/.vtt TEXT into a caption track (null = a new track named after the file).
 * @param {string} seqId @param {string | null} trackId @param {string} text @param {string} [fileName]
 */
export function importSubtitleText(seqId, trackId, text, fileName = '') {
	const { cues, skipped, format } = parseSubtitles(text);
	if (!cues.length) {
		showToast(`No captions found in ${fileName || 'that file'} (an .srt or .vtt file is expected)`);
		return { added: 0, skipped, format, trackId: null };
	}
	const done = addCues(seqId, trackId, cues, fileName.replace(/\.(srt|vtt)$/i, '') || 'Captions');
	showToast(`Imported ${cues.length} caption${cues.length === 1 ? '' : 's'}${skipped ? ` (${skipped} block${skipped === 1 ? '' : 's'} could not be read)` : ''}`);
	return { added: cues.length, skipped, format, trackId: done?.trackId ?? null };
}

/**
 * A chosen subtitle file → its cues (the Timeline's Import .srt / .vtt; the picker itself lives in
 * the menu press so it keeps the click's user activation).
 * @param {string} seqId @param {string|null} trackId @param {File} file
 */
export async function importSubtitleFile(seqId, trackId, file) {
	if (file.size > 2_000_000) return showToast('That subtitle file is over 2 MB — is it really an .srt or .vtt?');
	return importSubtitleText(seqId, trackId, await file.text(), file.name);
}
