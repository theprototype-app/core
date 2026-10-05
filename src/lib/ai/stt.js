import { writable, get } from 'svelte/store';
import { safeStorage } from '../safeStorage';
import { AiHttpError, describeAiError } from './client.js';

// Speech to text (36-vr-ai, plan F2): voice typing for the AI assistant. ONE local per-device config,
// the providers.js pattern (plaintext safeStorage, like every AI key here). All three presets speak the
// OpenAI-compatible `POST {base}/audio/transcriptions` multipart shape (file + model -> {text}), so one
// `transcribe` covers OpenAI's whisper-1, Groq's whisper-large-v3 and a self-hosted faster-whisper /
// whisper.cpp server. There are no VR-side settings: this is edited in desktop Settings ▸ AI only.

/**
 * @typedef {Object} SttConfig
 * @property {string} preset   'openai' | 'groq' | 'custom'
 * @property {string} baseUrl  OpenAI-compatible base (no trailing /audio/transcriptions)
 * @property {string} apiKey   bearer token (plaintext; may be empty for a self-hosted server)
 * @property {string} model    model id sent as `model`
 * @property {string} [language] optional ISO-639-1 hint ('en', 'de'…); empty = the server detects it
 */

/** @type {{preset: string, label: string, baseUrl: string, defaultModel: string, needsKey: boolean}[]} */
export const STT_PRESETS = [
	{ preset: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'whisper-1', needsKey: true },
	{ preset: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'whisper-large-v3', needsKey: true },
	{ preset: 'custom', label: 'Self-hosted (OpenAI-compatible)', baseUrl: '', defaultModel: 'whisper-1', needsKey: false }
];

/** @param {string} preset */
export function sttPresetFor(preset) {
	return STT_PRESETS.find((p) => p.preset === preset) ?? STT_PRESETS[0];
}

const STT_KEY = 'aiStt';

/** @returns {SttConfig} the default: OpenAI, no key yet (locked 2026-07-21) */
function defaultConfig() {
	const p = STT_PRESETS[0];
	return { preset: p.preset, baseUrl: p.baseUrl, apiKey: '', model: p.defaultModel, language: '' };
}

/** @param {any} raw @returns {SttConfig} */
export function normalizeSttConfig(raw) {
	const base = defaultConfig();
	if (!raw || typeof raw !== 'object') return base;
	const preset = sttPresetFor(String(raw.preset ?? base.preset));
	return {
		preset: preset.preset,
		baseUrl: String(raw.baseUrl ?? preset.baseUrl).trim().replace(/\/+$/, ''),
		apiKey: String(raw.apiKey ?? '').trim(),
		model: String(raw.model || preset.defaultModel).trim(),
		language: String(raw.language ?? '').trim()
	};
}

function loadConfig() {
	try {
		const raw = safeStorage.getItem(STT_KEY);
		return normalizeSttConfig(raw ? JSON.parse(raw) : null);
	} catch {
		return defaultConfig();
	}
}

/** @type {import('svelte/store').Writable<SttConfig>} */
export const sttConfig = writable(loadConfig());

/** Merge a patch into the config and persist it @param {Partial<SttConfig>} patch */
export function setSttConfig(patch) {
	const next = normalizeSttConfig({ ...get(sttConfig), ...patch });
	sttConfig.set(next);
	try {
		safeStorage.setItem(STT_KEY, JSON.stringify(next));
	} catch {}
	return next;
}

/** Switch preset: base URL and model follow it, the key stays (a person may paste it first) @param {string} preset */
export function applySttPreset(preset) {
	const p = sttPresetFor(preset);
	return setSttConfig({ preset: p.preset, baseUrl: p.baseUrl, model: p.defaultModel });
}

/** Can voice typing run? A hosted preset needs a key; a self-hosted one only a base URL and a model.
 * @param {SttConfig=} config @returns {boolean} */
export function sttReady(config = get(sttConfig)) {
	if (!config?.baseUrl || !config?.model) return false;
	return sttPresetFor(config.preset).needsKey ? !!config.apiKey : true;
}

/** the file name a recording travels under — servers pick the decoder by its extension @param {string} type */
function fileNameFor(type) {
	if (/mp4|m4a|aac/.test(type)) return 'speech.m4a';
	if (/ogg/.test(type)) return 'speech.ogg';
	if (/wav/.test(type)) return 'speech.wav';
	return 'speech.webm';
}

/**
 * Transcribe a recording. Multipart `file` + `model` (+ `language` when set) to {base}/audio/transcriptions,
 * bearer key when there is one; resolves the transcript text. Non-OK -> AiHttpError (describeSttError).
 * @param {Blob} blob @param {{config?: SttConfig, signal?: AbortSignal}=} opts @returns {Promise<string>}
 */
export async function transcribe(blob, opts = {}) {
	const config = opts.config ?? get(sttConfig);
	const form = new FormData();
	form.append('file', blob, fileNameFor(blob.type || ''));
	form.append('model', config.model);
	if (config.language) form.append('language', config.language);
	/** @type {Record<string, string>} */
	const headers = {};
	if (config.apiKey) headers['Authorization'] = 'Bearer ' + config.apiKey;
	const res = await fetch(config.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions', {
		method: 'POST',
		headers,
		body: form,
		signal: opts.signal
	});
	if (!res.ok) throw new AiHttpError(res.status, await res.text().catch(() => ''));
	const kind = res.headers.get('content-type') || '';
	if (kind.includes('application/json')) {
		const data = await res.json();
		return String(data?.text ?? '').trim();
	}
	// response_format=text servers answer with the bare transcript
	return (await res.text()).trim();
}

/** A short human message for a failed transcription @param {unknown} error */
export function describeSttError(error) {
	if (error instanceof Error && error.name === 'TypeError') {
		return 'Network or CORS error — a self-hosted speech server must allow this site as an origin';
	}
	return describeAiError(error);
}
