// Text-mode tool-call parsing (roadmap #10 follow-up). MANY self-hosted endpoints
// serve a tool-capable model WITHOUT a tool-call parser enabled (vLLM needs
// `--enable-auto-tool-choice --tool-call-parser ...`). The chat template still
// renders our tool schemas into the prompt, so the model happily "calls" a tool —
// but the call arrives as plain assistant TEXT and `tool_calls` stays empty. The
// agent loop then sees a text-only turn, stops, and nothing touches the scene.
//
// This module recovers those calls client-side. Formats handled:
//   1. Qwen3 / Qwen3.5 XML   <tool_call><function=NAME><parameter=KEY>VAL</parameter></function></tool_call>
//   2. Hermes / Qwen2.5 JSON <tool_call>{"name": "NAME", "arguments": {...}}</tool_call>
//   3. bare/fenced JSON      {"name": "NAME", "arguments": {...}}   (only when NAME is a real tool)
// It is a FALLBACK only — when the server does parse tool_calls we never look at
// the text (see client.js).

/**
 * @typedef {{id: string, name: string, arguments: string}} ToolCall
 */

/** Markers that mean "tool-call markup follows" — also used to hold back streamed
 * text so the user never watches raw markup scroll past. */
export const TOOL_TEXT_MARKERS = ['<tool_call>', '<function=', '<tool_calls>'];

/**
 * How much of `text` is safe to show the user. Stops at the first tool marker and,
 * while still streaming, holds back a tail that could be a partial marker.
 * @param {string} text
 * @param {boolean} final true once the stream ended (nothing more can arrive)
 * @returns {number} length of the visible prefix
 */
export function visiblePrefixLength(text, final) {
	let cut = text.length;
	for (const marker of TOOL_TEXT_MARKERS) {
		const at = text.indexOf(marker);
		if (at >= 0 && at < cut) cut = at;
	}
	if (final || cut < text.length) return cut;
	const longest = TOOL_TEXT_MARKERS.reduce((n, m) => Math.max(n, m.length), 0);
	for (let k = Math.min(longest - 1, text.length); k > 0; k--) {
		const tail = text.slice(text.length - k);
		if (TOOL_TEXT_MARKERS.some((m) => m.startsWith(tail))) return text.length - k;
	}
	return cut;
}

/** Coerce one XML `<parameter=…>` body into a JS value (JSON when it parses).
 * @param {string} raw @returns {any} */
function coerceParam(raw) {
	const value = raw.trim();
	if (!value) return '';
	const first = value[0];
	if (first === '{' || first === '[' || first === '"') {
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}
	if (value === 'true') return true;
	if (value === 'false') return false;
	if (value === 'null') return null;
	if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value)) return Number(value);
	return value;
}

/** Parse a `<function=NAME> <parameter=K>V</parameter>… ` body.
 * @param {string} block @returns {ToolCall|null} */
function parseXmlCall(block) {
	const head = block.match(/<function\s*=\s*([^>\s]+)\s*>/);
	if (!head) return null;
	/** @type {Record<string, any>} */
	const args = {};
	const paramRe = /<parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/parameter\s*>/g;
	/** @type {RegExpExecArray|null} */
	let m;
	while ((m = paramRe.exec(block))) args[m[1]] = coerceParam(m[2]);
	return { id: '', name: head[1].trim(), arguments: JSON.stringify(args) };
}

/** Parse a `{"name": …, "arguments": …}` blob.
 * @param {string} block @returns {ToolCall|null} */
function parseJsonCall(block) {
	const start = block.indexOf('{');
	if (start < 0) return null;
	// walk to the matching brace so trailing prose can't break JSON.parse
	let depth = 0;
	let inString = false;
	let escaped = false;
	let end = -1;
	for (let i = start; i < block.length; i++) {
		const ch = block[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === '{') depth++;
		else if (ch === '}' && --depth === 0) {
			end = i + 1;
			break;
		}
	}
	if (end < 0) return null;
	/** @type {any} */
	let json;
	try {
		json = JSON.parse(block.slice(start, end));
	} catch {
		return null;
	}
	const name = json && (json.name || json.function || json.tool || json.tool_name);
	if (!name || typeof name !== 'string') return null;
	const rawArgs = json.arguments ?? json.parameters ?? json.args ?? json.input ?? {};
	return {
		id: '',
		name: name.trim(),
		arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {})
	};
}

/**
 * Recover tool calls emitted as plain text and strip them out of the prose.
 * @param {string} text raw assistant content
 * @param {string[]} [knownTools] gate for the bare-JSON last resort (a model quoting
 *   `{"name": …}` in prose must not fire a tool)
 * @returns {{calls: ToolCall[], text: string}} calls + the content with markup removed
 */
export function parseTextToolCalls(text, knownTools = []) {
	const source = text || '';
	/** @type {ToolCall[]} */
	const calls = [];
	let cleaned = source;

	/** @param {string} chunk @param {ToolCall|null} call */
	const take = (chunk, call) => {
		if (!call || !call.name) return;
		calls.push(call);
		cleaned = cleaned.replace(chunk, '');
	};

	// 1+2: <tool_call> … </tool_call> blocks (tolerate a missing close at the end)
	const blockRe = /<tool_call\s*>([\s\S]*?)(?:<\/tool_call\s*>|$)/g;
	/** @type {RegExpExecArray|null} */
	let m;
	while ((m = blockRe.exec(source))) {
		const body = m[1];
		take(m[0], body.includes('<function') ? parseXmlCall(body) : parseJsonCall(body));
	}

	// bare <function=…></function> blocks (some models skip the wrapper)
	if (!calls.length) {
		const fnRe = /<function\s*=\s*[^>\s]+\s*>[\s\S]*?(?:<\/function\s*>|$)/g;
		while ((m = fnRe.exec(source))) take(m[0], parseXmlCall(m[0]));
	}

	// 3: last resort — a fenced or bare JSON call whose name is a REAL tool
	if (!calls.length && knownTools.length && source.includes('"name"')) {
		const fenceRe = /```(?:json|tool_code)?\s*([\s\S]*?)```/g;
		/** @type {string[]} */
		const candidates = [];
		while ((m = fenceRe.exec(source))) candidates.push(m[1]);
		if (!candidates.length) candidates.push(source);
		for (const candidate of candidates) {
			const call = parseJsonCall(candidate);
			if (call && knownTools.includes(call.name)) {
				calls.push(call);
				cleaned = cleaned.replace(candidate, '');
			}
		}
	}

	return { calls, text: cleaned.trim() };
}
