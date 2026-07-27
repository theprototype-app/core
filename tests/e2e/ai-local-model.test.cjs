// AI assistant against a LOCAL-MODEL style endpoint (roadmap #10 follow-up). Many
// self-hosted servers serve a tool-capable model without a working tool-call parser:
// vLLM 0.26 + Qwen3.5 emits the call as plain TEXT when unstreamed, and — worse — when
// streaming it swallows the call and streams an INVENTED tool name with NO arguments.
// That is why "create a cube" applied 8 actions named `Cube`/`simple_cube` and nothing
// appeared in the viewport. This suite mocks all three shapes and asserts:
//   1. a tool call arriving as Qwen XML *text* still builds the scene,
//   2. no raw <tool_call>/<function=> markup leaks into the transcript,
//   3. a streamed turn that comes back empty/nameless is retried UNSTREAMED (and the
//      rest of the session skips streaming),
//   4. an invented tool name whose args are a plain object spec is repaired to
//      create_objects instead of erroring,
//   5. the undo summary counts OBJECTS actually created, not attempted tool calls.
const h = require('./helpers.cjs');

const BASE = 'https://theprototype.app:5173/mock-local-ai/v1';

const ev = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
const sse = (parts) => parts.join('') + 'data: [DONE]\n\n';
const deltas = (text) => text.split(/(?<=.)/).map((c) => ev({ choices: [{ delta: { content: c } }] }));

// (1) Qwen3.5 XML tool call, arriving as CONTENT (no tool_calls field at all).
const XML_CALL =
	'\n\n<tool_call>\n<function=create_objects>\n<parameter=objects>\n' +
	JSON.stringify([
		{ kind: 'primitive', primitive: 'Cone', params: [0.4, 1.2], position: [0, 0.6, 0], color: '#ff8800', name: 'Flame' },
		{ kind: 'primitive', primitive: 'Sphere', params: [0.25], position: [1, 0.25, 0], color: '#888888', name: 'Rock1' },
		{ kind: 'primitive', primitive: 'Sphere', params: [0.25], position: [-1, 0.25, 0], color: '#888888', name: 'Rock2' }
	]) +
	'\n</parameter>\n</function>\n</tool_call>';

// (3) the broken-streaming shape: reasoning tokens, a nameless/argument-less tool call,
// and empty content. Nothing usable -> the client must retry this turn unstreamed.
const BROKEN_STREAM = sse([
	ev({ choices: [{ delta: { role: 'assistant', content: '' } }] }),
	ev({ choices: [{ delta: { reasoning: 'Let me place the rocks in a ring.' } }] }),
	ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool-x', type: 'function', function: { name: 'CampfireFlame', arguments: '' } }] } }] }),
	ev({ choices: [{ delta: { content: '\n\n' } }] }),
	ev({ choices: [{ delta: {}, finish_reason: 'stop' }] })
]);

// (4) an invented tool name carrying a bare object spec — repairable to create_objects
const INVENTED_CALL = [
	{
		id: 'tool-y',
		type: 'function',
		function: {
			name: 'simple_cube',
			arguments: JSON.stringify({ kind: 'primitive', primitive: 'Box', name: 'RepairedBox', color: '#00aaff' })
		}
	}
];

const count = (peer) =>
	peer.page.evaluate(
		() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g ? g.children.length : 0))())
	);
const named = (peer, name) =>
	peer.page.evaluate(
		(n) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => r(!!(g && g.children.some((c) => c.name === n))))()
			),
		name
	);
const msgs = (peer) =>
	peer.page.evaluate(
		() => new Promise((r) => window.__stores.aiAssistant.aiMessages.subscribe((m) => r(m))())
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// Route the mock endpoint. `mode` picks the scenario; every request is recorded so
	// we can assert the client stopped asking for stream:true after the fallback.
	let mode = 'xml-text';
	const seen = [];

	/** Serve one turn in whichever transport the client asked for. */
	const answer = (route, stream, { content = '', toolCalls = null }) => {
		if (!stream) {
			const message = { role: 'assistant', content: content || null };
			if (toolCalls) message.tool_calls = toolCalls;
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ choices: [{ message, finish_reason: toolCalls ? 'tool_calls' : 'stop' }] })
			});
		}
		const parts = [];
		if (toolCalls) {
			parts.push(ev({ choices: [{ delta: { tool_calls: toolCalls.map((c, index) => ({ index, ...c })) } }] }));
		}
		if (content) parts.push(...deltas(content));
		parts.push(ev({ choices: [{ delta: {}, finish_reason: toolCalls ? 'tool_calls' : 'stop' }] }));
		return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(parts) });
	};

	await A.page.route('**/mock-local-ai/v1/chat/completions', (route) => {
		/** @type {any} */
		let body = {};
		try {
			body = JSON.parse(route.request().postData() || '{}');
		} catch {}
		const stream = body.stream !== false;
		seen.push({ mode, stream });
		if ((body.messages || []).some((m) => m.role === 'tool')) {
			return answer(route, stream, { content: 'Built it.' });
		}
		// (1) tool call as plain TEXT — no tool_calls field in either transport
		if (mode === 'xml-text') return answer(route, stream, { content: XML_CALL });
		// (3) streamed turn is unusable; the unstreamed retry carries the real call
		if (mode === 'broken-stream') {
			if (stream) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: BROKEN_STREAM });
			return answer(route, stream, { content: XML_CALL });
		}
		// (4) an invented tool name carrying a bare object spec
		return answer(route, stream, { toolCalls: INVENTED_CALL });
	});

	await A.page.evaluate((base) => {
		window.__stores.aiProviders.addAiProvider({ preset: 'custom', label: 'LocalMock', baseUrl: base, apiKey: 'k', model: 'qwen-mock' });
		window.__stores.aiProviders.setAiEnabled(true);
	}, BASE);

	// ---- 1+2: a text-mode tool call builds the scene, markup never shows -------------
	const base0 = await count(A);
	await A.page.evaluate(() => window.__stores.aiAssistant.runPrompt('a small campfire'));
	await h.eventually(() => count(A), (n) => n === base0 + 3, 'text-mode (XML) tool call created 3 objects');
	h.check(await named(A, 'Flame'), 'named object from the text-mode call exists');

	let list = await msgs(A);
	h.check(
		!list.some((m) => /<tool_call>|<function=|<parameter=/.test(String(m.content))),
		'no raw tool-call markup in the transcript'
	);
	h.check(
		list.some((m) => m.role === 'summary' && m.content.includes('Applied 3 action')),
		'summary counts the 3 created objects (not 1 tool call)'
	);
	h.check(!list.some((m) => m.role === 'error'), 'no errors for the text-mode path');

	// ---- 3: a broken STREAMED turn is retried unstreamed ------------------------------
	await A.page.evaluate(() => window.__stores.aiAssistant.resetAiConversation());
	mode = 'broken-stream';
	seen.length = 0;
	const base1 = await count(A);
	await A.page.evaluate(() => window.__stores.aiAssistant.runPrompt('another campfire'));
	await h.eventually(() => count(A), (n) => n === base1 + 3, 'unstreamed retry created the objects');
	h.check(
		seen.some((s) => s.stream === true) && seen.some((s) => s.stream === false),
		'client retried the same turn with stream:false (saw ' + seen.map((s) => s.stream).join(',') + ')'
	);
	list = await msgs(A);
	h.check(
		list.some((m) => m.role === 'tool-status' && /without streaming/.test(m.content)),
		'transcript explains the non-streaming fallback'
	);
	h.check(
		!list.some((m) => m.role === 'error' && /unknown tool/.test(m.content)),
		'the invented streamed name did NOT become an unknown-tool error'
	);
	// the follow-up turn must not go back to streaming for this provider
	const after = seen.slice(seen.findIndex((s) => s.stream === false) + 1);
	h.check(after.every((s) => s.stream === false), 'stays unstreamed for the rest of the session');

	// ---- 4: an invented tool name with a bare object spec is repaired -----------------
	await A.page.evaluate(() => window.__stores.aiAssistant.resetAiConversation());
	mode = 'invented';
	const base2 = await count(A);
	await A.page.evaluate(() => window.__stores.aiAssistant.runPrompt('create cube'));
	await h.eventually(() => count(A), (n) => n === base2 + 1, 'invented tool name repaired to create_objects');
	h.check(await named(A, 'RepairedBox'), 'repaired call created the named box');

	// ---- 5: one undo still reverts a whole prompt -------------------------------------
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => count(A), (n) => n === base2, 'one undo reverted the repaired batch');

	await h.finish(browser);
});
