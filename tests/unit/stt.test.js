import { describe, it, expect, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
	STT_PRESETS,
	sttPresetFor,
	normalizeSttConfig,
	sttConfig,
	setSttConfig,
	applySttPreset,
	sttReady,
	transcribe,
	describeSttError
} from '../../src/lib/ai/stt.js';
import { AiHttpError } from '../../src/lib/ai/client.js';

// 36-vr-ai (plan F2): the speech-to-text config + the OpenAI-compatible transcription call. The three
// presets are locked by plan F (OpenAI default, Groq, self-hosted); the request shape is what every one
// of them must accept, so it is asserted field by field.

afterEach(() => vi.unstubAllGlobals());

describe('presets', () => {
	it('ships the three locked presets, OpenAI first (the default)', () => {
		expect(STT_PRESETS.map((p) => p.preset)).toEqual(['openai', 'groq', 'custom']);
		expect(sttPresetFor('openai')).toMatchObject({ baseUrl: 'https://api.openai.com/v1', defaultModel: 'whisper-1' });
		expect(sttPresetFor('groq')).toMatchObject({ baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'whisper-large-v3' });
		expect(sttPresetFor('custom')).toMatchObject({ baseUrl: '', defaultModel: 'whisper-1', needsKey: false });
		expect(normalizeSttConfig(null)).toMatchObject({ preset: 'openai', model: 'whisper-1', apiKey: '' });
	});
	it('an unknown preset falls back to OpenAI; a trailing slash is trimmed', () => {
		expect(normalizeSttConfig({ preset: 'nope' }).preset).toBe('openai');
		expect(normalizeSttConfig({ preset: 'custom', baseUrl: 'http://box:8000/v1///' }).baseUrl).toBe('http://box:8000/v1');
	});
	it('switching preset moves the URL and model but keeps the key', () => {
		setSttConfig({ preset: 'openai', apiKey: 'sk-1' });
		applySttPreset('groq');
		expect(get(sttConfig)).toMatchObject({ preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3', apiKey: 'sk-1' });
	});
});

describe('sttReady', () => {
	it('a hosted preset needs a key, a self-hosted one only a URL and a model', () => {
		expect(sttReady(normalizeSttConfig({ preset: 'openai' }))).toBe(false);
		expect(sttReady(normalizeSttConfig({ preset: 'openai', apiKey: 'k' }))).toBe(true);
		expect(sttReady(normalizeSttConfig({ preset: 'custom' }))).toBe(false);
		expect(sttReady(normalizeSttConfig({ preset: 'custom', baseUrl: 'http://box/v1' }))).toBe(true);
	});
});

describe('transcribe', () => {
	it('POSTs multipart file + model (+ language) to {base}/audio/transcriptions with the bearer key', async () => {
		/** @type {any} */ let seen = null;
		vi.stubGlobal('fetch', async (/** @type {string} */ url, /** @type {any} */ init) => {
			seen = { url, init };
			return new Response(JSON.stringify({ text: ' make a red cube ' }), { status: 200, headers: { 'content-type': 'application/json' } });
		});
		const blob = new Blob([new Uint8Array(64)], { type: 'audio/webm;codecs=opus' });
		const text = await transcribe(blob, { config: normalizeSttConfig({ preset: 'groq', apiKey: 'gk', language: 'en' }) });
		expect(text).toBe('make a red cube');
		expect(seen.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
		expect(seen.init.method).toBe('POST');
		expect(seen.init.headers.Authorization).toBe('Bearer gk');
		const form = /** @type {FormData} */ (seen.init.body);
		expect(form.get('model')).toBe('whisper-large-v3');
		expect(form.get('language')).toBe('en');
		const file = /** @type {File} */ (form.get('file'));
		expect(file.name).toBe('speech.webm');
		expect(file.size).toBe(64);
	});
	it('no key = no Authorization header (a self-hosted server); a text answer is accepted', async () => {
		/** @type {any} */ let headers = null;
		vi.stubGlobal('fetch', async (/** @type {string} */ _url, /** @type {any} */ init) => {
			headers = init.headers;
			return new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } });
		});
		const text = await transcribe(new Blob([new Uint8Array(8)], { type: 'audio/mp4' }), {
			config: normalizeSttConfig({ preset: 'custom', baseUrl: 'http://box/v1' })
		});
		expect(text).toBe('hello');
		expect(headers.Authorization).toBeUndefined();
	});
	it('a refusal raises the AI error, described like the assistant describes one', async () => {
		vi.stubGlobal('fetch', async () => new Response('bad key', { status: 401 }));
		const failed = await transcribe(new Blob([new Uint8Array(8)]), { config: normalizeSttConfig({ preset: 'openai', apiKey: 'x' }) }).catch((e) => e);
		expect(failed).toBeInstanceOf(AiHttpError);
		expect(describeSttError(failed)).toBe('Invalid API key or unauthorized');
		const network = new TypeError('Failed to fetch');
		expect(describeSttError(network)).toMatch(/CORS/);
	});
});
