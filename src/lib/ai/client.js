// OpenAI-compatible chat client (roadmap #10, A2). Plain fetch, no SDK — keeps the
// bundle light and works against Grok, Gemini's OpenAI-compat layer and any vLLM /
// OpenAI-compatible endpoint. Handles SSE streaming + the tool-call agent loop.
//
// CORS note: this runs in the browser. Gemini's OpenAI-compat endpoint and vLLM
// (started with `--allowed-origins '["*"]'`) accept browser origins; a self-hosted
// server that does NOT set CORS headers will fail with a network/TypeError. There is
// no proxy fallback (static app) — describeAiError() surfaces this clearly.

import { parseTextToolCalls, visiblePrefixLength } from './toolCallText.js';

/**
 * @typedef {import('./providers.js').AiProviderConfig} AiProviderConfig
 * @typedef {{role: string, content?: string|null, tool_calls?: any[], tool_call_id?: string, name?: string}} ChatMessage
 * @typedef {{id: string, name: string, arguments: string, extra?: any}} ToolCall
 */
// ToolCall.extra = provider extras that MUST be echoed back when the assistant turn is
// replayed. Gemini's OpenAI-compat layer attaches `extra_content.google.thought_signature`
// to each tool call and 400s ("missing thought_signature" / "function_response.name")
// if the replayed tool_calls drop it.

/** Raised when the API responds non-OK; carries status for describeAiError. */
export class AiHttpError extends Error {
	/** @param {number} status @param {string} body */
	constructor(status, body) {
		super('AI request failed (' + status + ')');
		this.name = 'AiHttpError';
		this.status = status;
		this.body = body;
	}
}

/** @param {AiProviderConfig} config @param {string} path */
function endpoint(config, path) {
	return config.baseUrl.replace(/\/+$/, '') + path;
}

/** Providers whose STREAMING tool calls proved unusable this session (see
 * runChat) — keyed by id so the next prompt skips straight to non-streaming.
 * @type {Set<string>} */
const brokenStreaming = new Set();

/** @param {AiProviderConfig} config */
function providerKey(config) {
	return config.id || config.baseUrl + '|' + config.model;
}

/** @param {AiProviderConfig} config @returns {boolean} */
export function streamingDisabled(config) {
	return config.stream === false || brokenStreaming.has(providerKey(config));
}

/** @param {AiProviderConfig} config */
function authHeaders(config) {
	/** @type {Record<string,string>} */
	const h = { 'Content-Type': 'application/json' };
	if (config.apiKey) h['Authorization'] = 'Bearer ' + config.apiKey;
	return h;
}

/**
 * One streamed chat-completions call. Accumulates assistant text (via onDelta) and
 * tool_calls (index-keyed — providers stream `function.arguments` in fragments).
 * Also accumulates `reasoning`/`reasoning_content` deltas (thinking models served by
 * vLLM/Ollama with a reasoning parser) — those are NOT chat content and never go back
 * into the transcript; they only drive a "thinking" indicator via onReasoning.
 *
 * When the server returns no tool_calls but the text CONTAINS a tool call (a
 * self-hosted endpoint without `--tool-call-parser`), the call is recovered from the
 * text and `fromText` is set — see toolCallText.js.
 * @param {Object} opts
 * @param {AiProviderConfig} opts.config
 * @param {ChatMessage[]} opts.messages
 * @param {any[]} [opts.tools]
 * @param {(text: string) => void} [opts.onDelta]
 * @param {(text: string) => void} [opts.onReasoning]
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.stream] set false to use a plain (non-SSE) completion — some
 *   self-hosted servers only parse tool calls correctly when NOT streaming
 * @returns {Promise<{content: string, toolCalls: ToolCall[], finishReason: string|null, fromText: boolean}>}
 */
export async function chatOnce({ config, messages, tools, onDelta, onReasoning, signal, stream = true }) {
	/** @type {any} */
	const body = { model: config.model, messages, stream };
	if (typeof config.temperature === 'number') body.temperature = config.temperature;
	if (tools && tools.length) {
		body.tools = tools;
		body.tool_choice = 'auto';
	}

	const res = await fetch(endpoint(config, '/chat/completions'), {
		method: 'POST',
		headers: authHeaders(config),
		body: JSON.stringify(body),
		signal
	});

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new AiHttpError(res.status, text);
	}

	if (!stream) {
		/** @type {any} */
		const json = await res.json();
		const message = (json.choices && json.choices[0] && json.choices[0].message) || {};
		const reasoning = message.reasoning_content ?? message.reasoning;
		if (typeof reasoning === 'string' && reasoning && onReasoning) onReasoning(reasoning);
		const rawCalls = Array.isArray(message.tool_calls)
			? message.tool_calls.map((/** @type {any} */ c) => ({
					id: c.id || '',
					name: (c.function && c.function.name) || '',
					arguments: (c.function && c.function.arguments) || '',
					extra: c.extra_content
				}))
			: [];
		const settled = finalizeTurn(String(message.content || ''), rawCalls, tools);
		// no SSE, so feed the whole visible answer at once
		if (onDelta && settled.content) onDelta(settled.content);
		const finish = (json.choices && json.choices[0] && json.choices[0].finish_reason) || null;
		return { ...settled, finishReason: finish };
	}

	const body_ = res.body;
	if (!body_) throw new AiHttpError(res.status, 'empty response body');
	const reader = body_.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let content = '';
	let finishReason = /** @type {string|null} */ (null);
	/** @type {Map<number, ToolCall>} */
	const toolCalls = new Map();

	// Stream text out only up to the first tool-call marker (and hold back a possible
	// partial marker), so raw `<tool_call>` markup never flashes in the transcript.
	let emitted = 0;
	/** @param {boolean} final */
	const flushVisible = (final) => {
		if (!onDelta) return;
		const upto = visiblePrefixLength(content, final);
		if (upto > emitted) {
			onDelta(content.slice(emitted, upto));
			emitted = upto;
		}
	};

	/** @param {string} payload */
	const handlePayload = (payload) => {
		if (payload === '[DONE]') return;
		/** @type {any} */
		let json;
		try {
			json = JSON.parse(payload);
		} catch {
			return; // skip partial/keepalive lines
		}
		const choice = json.choices && json.choices[0];
		if (!choice) return;
		const delta = choice.delta || {};
		const reasoning = delta.reasoning_content ?? delta.reasoning;
		if (typeof reasoning === 'string' && reasoning && onReasoning) onReasoning(reasoning);
		if (typeof delta.content === 'string' && delta.content) {
			content += delta.content;
			flushVisible(false);
		}
		if (Array.isArray(delta.tool_calls)) {
			for (const tc of delta.tool_calls) {
				const idx = typeof tc.index === 'number' ? tc.index : toolCalls.size;
				const existing = toolCalls.get(idx) || { id: '', name: '', arguments: '' };
				if (tc.id) existing.id = tc.id;
				if (tc.extra_content) existing.extra = tc.extra_content;
				if (tc.function) {
					if (tc.function.name) existing.name = tc.function.name;
					if (typeof tc.function.arguments === 'string') existing.arguments += tc.function.arguments;
				}
				toolCalls.set(idx, existing);
			}
		}
		if (choice.finish_reason) finishReason = choice.finish_reason;
	};

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let nl;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (line.startsWith('data:')) handlePayload(line.slice(5).trim());
			}
		}
		// flush any trailing buffered line
		const tail = buffer.trim();
		if (tail.startsWith('data:')) handlePayload(tail.slice(5).trim());
		flushVisible(true);
	} finally {
		try {
			reader.cancel();
		} catch {}
	}

	const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
	return { ...finalizeTurn(content, calls, tools), finishReason };
}

/** @param {any[]} [tools] @returns {string[]} */
function toolNames(tools) {
	return (tools || []).map((/** @type {any} */ t) => t?.function?.name).filter(Boolean);
}

/**
 * Settle one turn: when the server produced no tool_calls but the TEXT carries one
 * (endpoint without a tool-call parser), recover it and strip the markup.
 * @param {string} content @param {ToolCall[]} calls @param {any[]} [tools]
 * @returns {{content: string, toolCalls: ToolCall[], fromText: boolean}}
 */
function finalizeTurn(content, calls, tools) {
	if (!calls.length && content) {
		const recovered = parseTextToolCalls(content, toolNames(tools));
		if (recovered.calls.length) {
			return { content: recovered.text, toolCalls: recovered.calls, fromText: true };
		}
	}
	return { content, toolCalls: calls, fromText: false };
}

/**
 * Did this turn come back useless? Two shapes seen from self-hosted servers whose
 * STREAMING tool-call parser doesn't match the model's format (vLLM 0.26 + Qwen3.5):
 * the whole turn arrives empty, or a tool call arrives with an invented name and NO
 * arguments (the parser swallowed the real call). Non-streaming is unaffected, so the
 * turn is worth one retry. An unknown name WITH arguments is repairable — not this.
 * @param {string} content @param {ToolCall[]} calls @param {any[]} [tools]
 */
function turnUnusable(content, calls, tools) {
	if (!content.trim() && !calls.length) return true;
	const known = toolNames(tools);
	return calls.some((c) => {
		const args = (c.arguments || '').trim();
		return !known.includes(c.name) && (!args || args === '{}');
	});
}

/**
 * The tool-call agent loop: call the model, run any tool calls, feed results back,
 * repeat until a plain-text turn or the iteration cap.
 * @param {Object} opts
 * @param {AiProviderConfig} opts.config
 * @param {ChatMessage[]} opts.messages   seeded conversation (mutated: turns appended)
 * @param {any[]} opts.tools
 * @param {(name: string, args: any) => Promise<any>} opts.executeTool
 * @param {(text: string) => void} [opts.onDelta]
 * @param {(text: string) => void} [opts.onReasoning]
 * @param {(text: string) => void} [opts.onTurnText] settled text for this turn, with any
 *   text-mode tool-call markup stripped — lets the UI correct what onDelta streamed
 * @param {(name: string, args: any) => void} [opts.onToolStart]
 * @param {(name: string, result: any) => void} [opts.onToolResult]
 * @param {(text: string) => void} [opts.onNotice] non-fatal diagnostics for the UI
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxIterations]
 * @returns {Promise<{content: string, iterations: number, toolRuns: number}>}
 */
export async function runChat({
	config,
	messages,
	tools,
	executeTool,
	onDelta,
	onReasoning,
	onTurnText,
	onToolStart,
	onToolResult,
	onNotice,
	signal,
	maxIterations = 12
}) {
	let toolRuns = 0;
	let finalContent = '';
	let stream = !streamingDisabled(config);
	let i = 0;
	for (; i < maxIterations; i++) {
		let turn = await chatOnce({ config, messages, tools, onDelta, onReasoning, signal, stream });
		// Streamed turn came back unusable? The endpoint's streaming tool-call parser
		// is mismatched — redo this turn unstreamed and stay unstreamed from here.
		if (stream && turnUnusable(turn.content, turn.toolCalls, tools)) {
			stream = false;
			brokenStreaming.add(providerKey(config));
			// drop the dead turn's bubble FIRST — onTurnText only rewrites the LAST
			// message, and a notice pushed ahead of it would shadow the bubble
			if (onTurnText) onTurnText('');
			if (onNotice) onNotice('Streamed tool calls came back empty — retrying without streaming');
			turn = await chatOnce({ config, messages, tools, onDelta, onReasoning, signal, stream });
		}
		const { content, toolCalls, fromText } = turn;
		finalContent = content;
		// a text-mode call means onDelta may have streamed markup we've now stripped
		if (fromText && onTurnText) onTurnText(content);

		// Treat ANY accumulated tool calls as a tool turn even if finish_reason
		// isn't exactly 'tool_calls' (Gemini-compat is inconsistent here).
		if (!toolCalls.length) break;

		messages.push({
			role: 'assistant',
			content: content || null,
			tool_calls: toolCalls.map((c) => ({
				id: c.id || 'call_' + i + '_' + c.name,
				type: 'function',
				function: { name: c.name, arguments: c.arguments || '{}' },
				// echo provider extras verbatim (Gemini thought_signature — see ToolCall.extra)
				...(c.extra ? { extra_content: c.extra } : {})
			}))
		});

		for (const call of toolCalls) {
			/** @type {any} */
			let args = {};
			try {
				args = call.arguments ? JSON.parse(call.arguments) : {};
			} catch {
				const errResult = { error: 'invalid JSON arguments: ' + call.arguments };
				messages.push({
					role: 'tool',
					tool_call_id: call.id || 'call_' + i + '_' + call.name,
					name: call.name,
					content: JSON.stringify(errResult)
				});
				if (onToolResult) onToolResult(call.name, errResult);
				continue;
			}
			if (onToolStart) onToolStart(call.name, args);
			let result;
			try {
				result = await executeTool(call.name, args);
			} catch (err) {
				result = { error: err instanceof Error ? err.message : String(err) };
			}
			toolRuns++;
			messages.push({
				role: 'tool',
				tool_call_id: call.id || 'call_' + i + '_' + call.name,
				name: call.name,
				content: JSON.stringify(result ?? { ok: true })
			});
			if (onToolResult) onToolResult(call.name, result);
		}
	}
	return { content: finalContent, iterations: i, toolRuns };
}

/**
 * List the endpoint's models (GET /models — served by vLLM, Gemini's OpenAI-compat
 * layer, Grok, OpenAI alike). Returns null when the endpoint doesn't support it.
 * @param {AiProviderConfig} config
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]|null>}
 */
export async function listModels(config, signal) {
	try {
		const res = await fetch(endpoint(config, '/models'), { headers: authHeaders(config), signal });
		if (!res.ok) return null;
		/** @type {any} */
		const json = await res.json().catch(() => ({}));
		if (!Array.isArray(json.data)) return null;
		return json.data
			.map((/** @type {any} */ m) => String(m.id || ''))
			// Gemini's compat layer prefixes ids with "models/" — normalize to what
			// the chat endpoint expects (matches providers.normalizeModel)
			.map((/** @type {string} */ id) => id.replace(/^models\//, ''))
			.filter(Boolean)
			.slice(0, 500);
	} catch {
		return null;
	}
}

/** A 1-token completion against the configured model — the definitive "does this
 * model answer" check. @param {AiProviderConfig} config @param {AbortSignal} [signal]
 * @returns {Promise<{ok: boolean, detail: string}>} */
async function probeCompletion(config, signal) {
	try {
		const res = await fetch(endpoint(config, '/chat/completions'), {
			method: 'POST',
			headers: authHeaders(config),
			body: JSON.stringify({
				model: config.model,
				messages: [{ role: 'user', content: 'ping' }],
				max_tokens: 1,
				stream: false
			}),
			signal
		});
		if (res.ok) return { ok: true, detail: 'Connected' };
		return { ok: false, detail: describeAiError(new AiHttpError(res.status, await res.text().catch(() => ''))) };
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') return { ok: false, detail: 'Cancelled' };
		return { ok: false, detail: describeAiError(err) };
	}
}

/**
 * Probe a provider config. Tries GET /models (also feeding the Settings model
 * suggestions), then validates the CONFIGURED model: listed -> good; not listed or
 * no list -> a 1-token completion decides (aliases like gemini-flash-latest may
 * answer without being listed).
 * @param {AiProviderConfig} config
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: boolean, detail: string, models: string[]|null, modelOk: boolean|null}>}
 *   modelOk: true = the configured model is confirmed (listed or answered),
 *   false = it failed the probe, null = no model configured / nothing verifiable
 */
export async function testConnection(config, signal) {
	if (!config.baseUrl) return { ok: false, detail: 'No base URL set', models: null, modelOk: null };
	const models = await listModels(config, signal);
	const model = (config.model || '').trim();

	if (models) {
		if (!model) return { ok: true, detail: 'Connected — ' + models.length + ' models', models, modelOk: null };
		if (models.includes(model)) {
			return { ok: true, detail: 'Connected — ' + models.length + ' models', models, modelOk: true };
		}
		// not listed — an alias may still answer; let the completion decide
		const probe = await probeCompletion(config, signal);
		return {
			ok: true,
			detail: 'Connected — ' + models.length + ' models',
			models,
			modelOk: probe.ok
		};
	}

	// endpoint without /models (or blocked) — the completion probe is the whole test
	if (!model) {
		return {
			ok: false,
			detail: 'This endpoint lists no models — enter a model id, then test again',
			models: null,
			modelOk: null
		};
	}
	const probe = await probeCompletion(config, signal);
	return { ...probe, models: null, modelOk: probe.ok };
}

/**
 * Normalize an error into a short human message.
 * @param {unknown} error
 * @returns {string}
 */
export function describeAiError(error) {
	if (error instanceof AiHttpError) {
		if (error.status === 401 || error.status === 403) return 'Invalid API key or unauthorized';
		if (error.status === 429) return 'Rate limited — slow down or check your quota';
		if (error.status === 404) return 'Endpoint not found — check the base URL';
		if (error.status >= 500) return 'Provider server error (' + error.status + ')';
		const snippet = (error.body || '').slice(0, 200);
		return 'Request failed (' + error.status + ')' + (snippet ? ': ' + snippet : '');
	}
	if (error instanceof Error) {
		if (error.name === 'AbortError') return 'Cancelled';
		if (error.name === 'TypeError') {
			return 'Network or CORS error — a self-hosted vLLM must run with --allowed-origins';
		}
		return error.message;
	}
	return String(error);
}
