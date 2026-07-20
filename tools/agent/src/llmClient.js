// Minimal OpenAI-compatible client for the REPL (roadmap #10 B4). Non-streaming
// (simpler in a terminal), tool-call loop. Node 20 has global fetch.

/**
 * @param {Object} cfg @param {string} cfg.apiUrl @param {string} cfg.apiKey @param {string} cfg.model
 * @param {any[]} messages @param {any[]} tools
 * @returns {Promise<{content:string, toolCalls:any[]}>}
 */
async function chatOnce(cfg, messages, tools) {
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
			tool_choice: tools && tools.length ? 'auto' : undefined
		})
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error('API ' + res.status + ': ' + body.slice(0, 300));
	}
	const json = await res.json();
	const msg = json.choices && json.choices[0] && json.choices[0].message;
	return { content: (msg && msg.content) || '', toolCalls: (msg && msg.tool_calls) || [] };
}

/**
 * Tool-call agent loop.
 * @param {Object} opts
 * @param {any} opts.cfg
 * @param {any[]} opts.messages   mutated with the turn
 * @param {any[]} opts.tools
 * @param {(name:string, args:any)=>any} opts.executeTool
 * @param {(name:string, args:any)=>void} [opts.onTool]
 * @param {number} [opts.maxIterations]
 * @returns {Promise<string>}
 */
export async function runChat({ cfg, messages, tools, executeTool, onTool, maxIterations = 12 }) {
	let final = '';
	for (let i = 0; i < maxIterations; i++) {
		const { content, toolCalls } = await chatOnce(cfg, messages, tools);
		final = content;
		if (!toolCalls.length) break;
		messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
		for (const call of toolCalls) {
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
				result = executeTool(call.function.name, args);
			} catch (e) {
				result = { error: e.message };
			}
			messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result ?? { ok: true }) });
		}
	}
	return final;
}
