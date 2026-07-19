// AI scene assistant (roadmap #10, A8). Drives the assistant against a MOCKED
// OpenAI-compatible endpoint (page.route -> canned SSE tool_calls) and asserts:
//   1. a prompt creates the objects locally,
//   2. it BROADCASTS the standard replicated messages (create/color/move) so peers
//      rebuild the same scene — captured via a send stub (the receive path itself is
//      the existing create/color/move/delete handlers, covered by other two-peer
//      suites; the public cloud is too flaky to gate this feature's suite on),
//   3. ONE undo removes the whole batch (the aibatch history kind) and broadcasts
//      the deletes, and redo restores + re-broadcasts.
// Also checks the Settings AI section renders and the backquote pill shows.
const h = require('./helpers.cjs');

const BASE = 'https://theprototype.app:5173/mock-ai/v1';

const ev = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
const ARGS = JSON.stringify({
	objects: [
		{ kind: 'primitive', primitive: 'Box', color: '#ff0000', position: [0, 0.5, 0], name: 'RedBox1' },
		{ kind: 'primitive', primitive: 'Box', color: '#ff0000', position: [2, 0.5, 0], name: 'RedBox2' },
		{ kind: 'primitive', primitive: 'Box', color: '#ff0000', position: [4, 0.5, 0], name: 'RedBox3' }
	]
});
const TOOL_SSE =
	ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'create_objects', arguments: '' } }] } }] }) +
	ev({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ARGS } }] } }] }) +
	ev({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
	'data: [DONE]\n\n';
const DONE_SSE =
	ev({ choices: [{ delta: { content: 'Done — created 3 red boxes.' } }] }) +
	ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
	'data: [DONE]\n\n';

const count = (peer) =>
	peer.page.evaluate(
		() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g ? g.children.length : 0))())
	);

// Capture every message the app tries to broadcast (proves replication without
// depending on the public PeerJS cloud). Wraps the live PeerConnection.send.
const captured = (peer) => peer.page.evaluate(() => window.__captured || []);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.route('**/mock-ai/v1/chat/completions', (route) => {
		const body = route.request().postData() || '';
		const followup = body.includes('"role":"tool"');
		route.fulfill({ status: 200, contentType: 'text/event-stream', body: followup ? DONE_SSE : TOOL_SSE });
	});
	await A.page.route('**/mock-ai/v1/models', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'mock' }] }) })
	);

	// Configure the provider.
	await A.page.evaluate((base) => {
		window.__stores.aiProviders.addAiProvider({ preset: 'custom', label: 'Mock', baseUrl: base, apiKey: 'test', model: 'mock' });
		window.__stores.aiProviders.setAiEnabled(true);
	}, BASE);
	h.check(await A.page.evaluate(() => window.__stores.aiProviders.aiReady()), 'provider configured -> aiReady() true');

	// Settings AI section + backquote pill.
	await A.page.evaluate(() => {
		window.__stores.settingsSection.set('ai');
		window.__stores.settingsOpen.set(true);
	});
	await A.page.waitForTimeout(400);
	h.check(await A.page.getByText('Enable assistant', { exact: false }).first().isVisible(), 'Settings -> AI section renders');
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));
	await A.page.waitForTimeout(200);
	// The pill is rendered by AiAssistant.svelte from its OWN static import of the
	// providers/appStore modules. On a dev server churned by HMR, a dynamic import
	// (the __stores hook) can bind a SECOND module instance, so setting aiEnabled /
	// aiPromptBarOpen via the hook wouldn't reach the component (CLAUDE.md gotcha).
	// aiProviders + aiEnabled persist to localStorage, so a fresh reload gives the
	// component a single, correctly-seeded instance; then toggle the pill.
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 30000 });
	await A.page.evaluate(() => window.__stores.aiPromptBarOpen.set(true));
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('.ai-pill').first().isVisible(), 'backquote prompt pill shows');
	await A.page.evaluate(() => window.__stores.aiPromptBarOpen.set(false));

	// Install a broadcast-capture stub on the live peer instance.
	await A.page.evaluate(() => {
		window.__captured = [];
		let inst;
		window.__stores.peers.subscribe((p) => (inst = p))();
		if (inst && !inst.__wrapped) {
			const orig = inst.send.bind(inst);
			inst.send = (m) => {
				try {
					window.__captured.push(m);
				} catch (e) {}
				return orig(m);
			};
			inst.__wrapped = true;
		}
	});

	const base0 = await count(A);

	// Run the prompt (awaits the whole tool loop).
	await A.page.evaluate(async () => {
		await window.__stores.aiAssistant.runPrompt('make three red boxes in a row');
	});

	await h.eventually(() => count(A), (n) => n === base0 + 3, 'prompt created 3 boxes locally');

	// first box is red (executor set the color)
	const red = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const box = g.children.find((c) => c.material && c.material.color);
					r(box ? box.material.color.getHexString() : null);
				})()
			)
	);
	h.check(red === 'ff0000', 'created box is red');

	// broadcast the standard replicated messages so peers rebuild it
	const msgs = await captured(A);
	const typeCount = (t) => msgs.filter((m) => m && m.type === t).length;
	h.check(typeCount('create') === 3, 'broadcast 3 create messages (replicated)');
	h.check(typeCount('color') === 3, 'broadcast 3 color messages');
	h.check(typeCount('move') >= 3, 'broadcast move messages for placement');

	// One undo reverts the WHOLE batch (aibatch) and broadcasts the deletes.
	const beforeUndo = (await captured(A)).length;
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => count(A), (n) => n === base0, 'one undo removed all 3 (single aibatch step)');
	const undoMsgs = (await captured(A)).slice(beforeUndo);
	h.check(undoMsgs.filter((m) => m && m.type === 'delete').length === 3, 'undo broadcast 3 deletes');

	// Redo restores them and re-broadcasts the objects.
	const beforeRedo = (await captured(A)).length;
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => count(A), (n) => n === base0 + 3, 'redo restored 3 boxes');
	const redoMsgs = (await captured(A)).slice(beforeRedo);
	h.check(redoMsgs.filter((m) => m && (m.type === 'object' || m.type === 'create')).length >= 3, 'redo re-broadcast the objects');

	await h.finish(browser);
});
