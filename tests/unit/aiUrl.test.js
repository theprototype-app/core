import { describe, it, expect } from 'vitest';
import { normalizeEndpointUrl, CHAT_TAILS, STT_TAILS, willCall, serverKind, corsHint } from '../../src/lib/ai/url.js';
import { normalizeBaseUrl, chatEndpointFor } from '../../src/lib/ai/providers.js';
import { meshBaseUrl } from '../../src/lib/ai/meshProviders.js';
import { normalizeSttConfig } from '../../src/lib/ai/stt.js';
import { serverErrorHint, describeAiError, AiHttpError } from '../../src/lib/ai/client.js';

// fix-batch-2 (1.45.1) B1: every URL shape a user pastes into an AI connection field.
// Counterfactual: on 1.45.0 `andar.example.net:8888/v1` stayed scheme-less (the browser
// read `andar.example.net:` as the scheme) and `127.0.0.1:8888/v1` became a relative URL.
describe('B1 normalizeEndpointUrl', () => {
	const chat = (/** @type {string} */ s) => normalizeEndpointUrl(s, { tails: CHAT_TAILS });
	it('adds https:// when no scheme was typed', () => {
		expect(chat('andar.example.net:8888/v1')).toBe('https://andar.example.net:8888/v1');
		expect(chat('vllm.example.org:8888/v1/')).toBe('https://vllm.example.org:8888/v1');
		expect(chat('127.0.0.1:8888/v1')).toBe('https://127.0.0.1:8888/v1');
		expect(chat('localhost:8000/v1')).toBe('https://localhost:8000/v1');
		expect(chat('//host.example/v1')).toBe('https://host.example/v1');
		expect(chat('[::1]:8000/v1')).toBe('https://[::1]:8000/v1');
	});
	it('keeps a typed scheme, http included, and repairs a missing slash', () => {
		expect(chat('http://192.168.1.20:8000/v1')).toBe('http://192.168.1.20:8000/v1');
		expect(chat('HTTPS://Host.example/v1')).toBe('HTTPS://Host.example/v1');
		expect(chat('https:/host.example/v1')).toBe('https://host.example/v1');
		expect(chat('http:host.example/v1')).toBe('http://host.example/v1');
	});
	it('strips a pasted endpoint tail (and trailing slashes, spaces)', () => {
		expect(chat('  https://h.example/v1/chat/completions  ')).toBe('https://h.example/v1');
		expect(chat('https://h.example/v1/chat/completions/')).toBe('https://h.example/v1');
		expect(chat('https://h.example/v1/models')).toBe('https://h.example/v1');
		expect(chat('https://h.example/v1/completions')).toBe('https://h.example/v1');
		expect(chat('h.example:8000/v1/Chat/Completions')).toBe('https://h.example:8000/v1');
		expect(chat('https://h.example/v1///')).toBe('https://h.example/v1');
	});
	it('keeps a query (Azure-style api-version) and an empty field empty', () => {
		expect(chat('https://h.example/openai/deployments/x?api-version=1')).toBe('https://h.example/openai/deployments/x?api-version=1');
		expect(chat('')).toBe('');
		expect(chat('   ')).toBe('');
		expect(normalizeEndpointUrl(/** @type {any} */ (undefined))).toBe('');
	});
	it('takes a default scheme per caller', () => {
		expect(normalizeEndpointUrl('comfy.lan:8188', { scheme: 'http' })).toBe('http://comfy.lan:8188');
	});
	it('STT strips the transcription tail', () => {
		expect(normalizeEndpointUrl('stt.example/v1/audio/transcriptions', { tails: STT_TAILS })).toBe('https://stt.example/v1');
	});
	it('willCall joins base + path', () => {
		expect(willCall('https://h.example/v1', '/chat/completions')).toBe('https://h.example/v1/chat/completions');
		expect(willCall('', '/x')).toBe('');
	});
});

describe('B1 the three connection kinds use it', () => {
	it('chat: normalizeBaseUrl + the Gemini rewrite still apply', () => {
		expect(normalizeBaseUrl('vllm.example.org:8888/v1/chat/completions')).toBe('https://vllm.example.org:8888/v1');
		expect(normalizeBaseUrl('generativelanguage.googleapis.com/v1beta/models/')).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
		expect(normalizeBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai/')).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
		expect(chatEndpointFor('127.0.0.1:8888/v1')).toBe('https://127.0.0.1:8888/v1/chat/completions');
	});
	it('mesh: ComfyUI defaults to http (its LAN default), hosted APIs to https', () => {
		expect(meshBaseUrl('comfy.lan:8188/', 'comfyui')).toBe('http://comfy.lan:8188');
		expect(meshBaseUrl('api.meshy.ai', 'meshy')).toBe('https://api.meshy.ai');
	});
	it('voice: the STT config normalises on load', () => {
		expect(normalizeSttConfig({ preset: 'custom', baseUrl: '10.0.0.5:9000/v1/audio/transcriptions' }).baseUrl).toBe('https://10.0.0.5:9000/v1');
	});
});

describe('B2 server kind — only to word the CORS hint', () => {
	it('names the flag of the server it looks like', () => {
		expect(serverKind('https://vllm.example.org:8888/v1')).toBe('vllm');
		expect(serverKind('https://host.example:8000/v1')).toBe('vllm');
		expect(serverKind('http://127.0.0.1:11434/v1')).toBe('ollama');
		expect(serverKind('http://localhost:1234/v1')).toBe('lmstudio');
		expect(serverKind('https://api.x.ai/v1')).toBe('unknown');
		expect(serverKind('not a url')).toBe('unknown');
		expect(corsHint('vllm')).toMatch(/--allowed-origins/);
		expect(corsHint('unknown')).not.toMatch(/vLLM|allowed-origins/);
	});
});

describe('B3/B4 server error bodies become one-line hints', () => {
	it('Google key errors read as key errors', () => {
		const body = '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}';
		expect(serverErrorHint(400, body)).toMatch(/Key rejected/);
		expect(describeAiError(new AiHttpError(400, body))).toMatch(/Key rejected/);
		const denied = '{"error":{"code":403,"status":"PERMISSION_DENIED","message":"Generative Language API has not been used in project 1 before or it is disabled."}}';
		expect(describeAiError(new AiHttpError(403, denied))).toMatch(/Permission denied/);
	});
	it('vLLM tool flags, context length and unknown model', () => {
		expect(serverErrorHint(400, '{"object":"error","message":"\\"auto\\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set"}')).toMatch(/--enable-auto-tool-choice/);
		expect(serverErrorHint(400, "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens")).toMatch(/max-model-len/);
		expect(serverErrorHint(404, '{"message":"The model `qwen` does not exist."}')).toMatch(/served-model-name/);
		expect(describeAiError(new AiHttpError(404, '{"message":"The model `qwen` does not exist."}'))).toMatch(/Unknown model/);
		expect(describeAiError(new AiHttpError(404, 'Not Found'))).toMatch(/Endpoint not found/);
	});
	it('a network TypeError no longer always blames CORS', () => {
		const err = new TypeError('Failed to fetch');
		expect(describeAiError(err)).toMatch(/network, certificate or CORS/);
		expect(describeAiError(err, /** @type {any} */ ({ baseUrl: 'https://api.x.ai/v1' }))).not.toMatch(/vLLM/);
		expect(describeAiError(err, /** @type {any} */ ({ baseUrl: 'vllm.example.org:8888/v1' }))).toMatch(/--allowed-origins/);
	});
	it('a timeout says so', () => {
		const err = new Error('t');
		err.name = 'TimeoutError';
		expect(describeAiError(err)).toMatch(/No answer within 10 s/);
	});
});
