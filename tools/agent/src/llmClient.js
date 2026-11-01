// Minimal OpenAI-compatible client for the REPL (roadmap #10 B4 → 56 C3), tool-call loop. Node 20 has
// global fetch. With `onDelta` it streams (SSE, `stream: true`) so the app's AI assistant window watches the
// reply grow; an endpoint that answers a stream request with plain JSON still works.

/**
 * Read an SSE body into one assistant message, calling onDelta per content chunk.
 * @param {any} res @param {(t: string) => void} onDelta
 * @returns {Promise<{content: string, toolCalls: any[]}>}
 */
async function readStream(res, onDelta) {
	let content = '';
	/** index -> {id, type, function: {name, arguments}} @type {Map<number, any>} */
	const calls = new Map();
	const decoder = new TextDecoder();
	let buf = '';
	/** @param {string} line */
	const take = (line) => {
		const t = line.trim();
		if (!t.startsWith('data:')) return;
		const data = t.slice(5).trim();
		if (!data || data === '[DONE]') return;
		let j;
		try {
			j = JSON.parse(data);
		} catch {
			return;
		}
		const d = j.choices?.[0]?.delta ?? j.choices?.[0]?.message;
		if (!d) return;
		if (typeof d.content === 'string' && d.content) {
			content += d.content;
			onDelta(d.content);
		}
		for (const tc of d.tool_calls ?? []) {
			const i = Number.isInteger(tc.index) ? tc.index : calls.size;
			const c = calls.get(i) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
			if (tc.id) c.id = tc.id;
			if (tc.function?.name) c.function.name += tc.function.name;
			if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
			calls.set(i, c);
		}
	};
	for await (const chunk of res.body) {
		buf += decoder.decode(chunk, { stream: true });
		let nl;
		while ((nl = buf.indexOf('\n')) >= 0) {
			take(buf.slice(0, nl));
			buf = buf.slice(nl + 1);
		}
	}
	if (buf) take(buf);
	const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({ ...c, id: c.id || 'call_' + i }));
	return { content, toolCalls };
}

/**
 * @param {Object} cfg @param {string} cfg.apiUrl @param {string} cfg.apiKey @param {string} cfg.model
 * @param {any[]} messages @param {any[]} tools
 * @param {((t: string) => void) | undefined} [onDelta] stream, calling this per content chunk
 * @returns {Promise<{content:string, toolCalls:any[]}>}
 */
export async function chatOnce(cfg, messages, tools, onDelta) {
	const base = cfg.apiUrl.replace(/\/+$/, '');
	const res = await fetch(base + '/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {})
		},
		body: JSON.stringify({
			model: cfg.model,
			messages,
			tools: tools && tools.length ? tools.map((t) => ({ type: 'function', function: t })) : undefined,
			tool_choice: tools && tools.length ? 'auto' : undefined,
			stream: onDelta ? true : undefined
		})
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error('API ' + res.status + ': ' + body.slice(0, 300));
	}
	if (onDelta && /text\/event-stream/i.test(res.headers.get('content-type') || '')) return readStream(res, onDelta);
	const json = await res.json();
	const msg = json.choices && json.choices[0] && json.choices[0].message;
	const content = (msg && msg.content) || '';
	if (onDelta && content) onDelta(content);
	return { content, toolCalls: (msg && msg.tool_calls) || [] };
}

/**
 * Tool-call agent loop.
 * @param {Object} opts
 * @param {any} opts.cfg
 * @param {any[]} opts.messages   mutated with the turn
 * @param {any[]} opts.tools
 * @param {(name:string, args:any)=>any} opts.executeTool may return a Promise
 * @param {(name:string, args:any)=>void} [opts.onTool]
 * @param {(t: string, round: number) => void} [opts.onDelta] stream the reply (round = which model call)
 * @param {(result: any) => boolean} [opts.stopOn] a tool result that ends the turn (56 C6: Stop → cancelled)
 * @param {number} [opts.maxIterations]
 * @returns {Promise<string>}
 */
export async function runChat({ cfg, messages, tools, executeTool, onTool, onDelta, stopOn, maxIterations = 12 }) {
	let final = '';
	for (let i = 0; i < maxIterations; i++) {
		const { content, toolCalls } = await chatOnce(cfg, messages, tools, onDelta ? (t) => onDelta(t, i) : undefined);
		final = content;
		if (!toolCalls.length) {
			if (content) messages.push({ role: 'assistant', content });
			break;
		}
		messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
		let stopped = false;
		for (const call of toolCalls) {
			if (stopped) {
				messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'cancelled', cancelled: true }) });
				continue;
			}
			let args = {};
			try {
				args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
			} catch {
				messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'invalid JSON arguments' }) });
				continue;
			}
			if (onTool) onTool(call.function.name, args);
			let result;
			try {
				result = await executeTool(call.function.name, args);
			} catch (e) {
				result = { error: /** @type {any} */ (e).message };
			}
			messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result ?? { ok: true }) });
			if (stopOn && stopOn(result)) stopped = true;
		}
		if (stopped) {
			final = '';
			break;
		}
	}
	return final;
}
