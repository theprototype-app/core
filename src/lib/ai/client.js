// OpenAI-compatible chat client (roadmap #10, A2). Plain fetch, no SDK — keeps the
// bundle light and works against Grok, Gemini's OpenAI-compat layer and any vLLM /
// OpenAI-compatible endpoint. Handles SSE streaming + the tool-call agent loop.
//
// CORS note: this runs in the browser. Gemini's OpenAI-compat endpoint and vLLM
// (started with `--allowed-origins '["*"]'`) accept browser origins; a self-hosted
// server that does NOT set CORS headers will fail with a network/TypeError. There is
// no proxy fallback (static app) — describeAiError() surfaces this clearly.

/**
 * @typedef {import('./providers.js').AiProviderConfig} AiProviderConfig
 * @typedef {{role: string, content?: string|null, tool_calls?: any[], tool_call_id?: string, name?: string}} ChatMessage
 * @typedef {{id: string, name: string, arguments: string}} ToolCall
 */

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
 * @param {Object} opts
 * @param {AiProviderConfig} opts.config
 * @param {ChatMessage[]} opts.messages
 * @param {any[]} [opts.tools]
 * @param {(text: string) => void} [opts.onDelta]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{content: string, toolCalls: ToolCall[], finishReason: string|null}>}
 */
export async function chatOnce({ config, messages, tools, onDelta, signal }) {
	/** @type {any} */
	const body = { model: config.model, messages, stream: true };
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

	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => '');
		throw new AiHttpError(res.status, text);
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let content = '';
	let finishReason = /** @type {string|null} */ (null);
	/** @type {Map<number, ToolCall>} */
	const toolCalls = new Map();

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
		if (typeof delta.content === 'string' && delta.content) {
			content += delta.content;
			if (onDelta) onDelta(delta.content);
		}
		if (Array.isArray(delta.tool_calls)) {
			for (const tc of delta.tool_calls) {
				const idx = typeof tc.index === 'number' ? tc.index : toolCalls.size;
				const existing = toolCalls.get(idx) || { id: '', name: '', arguments: '' };
				if (tc.id) existing.id = tc.id;
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
	} finally {
		try {
			reader.cancel();
		} catch {}
	}

	const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
	return { content, toolCalls: calls, finishReason };
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
 * @param {(name: string, args: any) => void} [opts.onToolStart]
 * @param {(name: string, result: any) => void} [opts.onToolResult]
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
	onToolStart,
	onToolResult,
	signal,
	maxIterations = 12
}) {
	let toolRuns = 0;
	let finalContent = '';
	let i = 0;
	for (; i < maxIterations; i++) {
		const { content, toolCalls } = await chatOnce({ config, messages, tools, onDelta, signal });
		finalContent = content;

		// Treat ANY accumulated tool calls as a tool turn even if finish_reason
		// isn't exactly 'tool_calls' (Gemini-compat is inconsistent here).
		if (!toolCalls.length) break;

		messages.push({
			role: 'assistant',
			content: content || null,
			tool_calls: toolCalls.map((c) => ({
				id: c.id || 'call_' + i + '_' + c.name,
				type: 'function',
				function: { name: c.name, arguments: c.arguments || '{}' }
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
				content: JSON.stringify(result ?? { ok: true })
			});
			if (onToolResult) onToolResult(call.name, result);
		}
	}
	return { content: finalContent, iterations: i, toolRuns };
}

/**
 * Probe a provider config. Tries GET /models, falls back to a 1-token completion.
 * @param {AiProviderConfig} config
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function testConnection(config, signal) {
	if (!config.baseUrl) return { ok: false, detail: 'No base URL set' };
	try {
		const res = await fetch(endpoint(config, '/models'), {
			headers: authHeaders(config),
			signal
		});
		if (res.ok) {
			/** @type {any} */
			const json = await res.json().catch(() => ({}));
			const n = Array.isArray(json.data) ? json.data.length : 0;
			return { ok: true, detail: n ? 'Connected — ' + n + ' models' : 'Connected' };
		}
		// some endpoints 404 /models — fall through to a tiny completion probe
		if (res.status !== 404) {
			return { ok: false, detail: describeAiError(new AiHttpError(res.status, '')) };
		}
	} catch (err) {
		// network/CORS — but /models may just be unsupported; try a completion
		if (!(err instanceof Error) || err.name === 'AbortError') {
			return { ok: false, detail: 'Cancelled' };
		}
	}
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
		return { ok: false, detail: describeAiError(err) };
	}
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
