// Roadmap 56 C7 (lane 56-chat) — SPEAK TO AN AGENT WITH THE HEADSET ON, on IWER (48 G2: the app's own XR
// path, a Quest 3 emulated). A is a person in VR; B is an AGENT page this script drives as a fake agent
// (raw `agentchat`, no bridge). The desktop window's target is the agent, so the VR AI panel follows it:
//
//   1  in a presenting session the panel's header names the agent and its rows are the agent thread
//   2  the panel's input row opens the VR keyboard; its commit SENDS to the agent (not the provider)
//   3  holding the talk binding dictates through Settings ▸ AI ▸ Voice typing (a MOCKED transcription
//      server, Chromium's fake microphone) and the transcript goes to the agent
//   4  the agent streams an answer: the panel shows it (text only — no TTS in roadmap 56), its A8 step
//      as a ⚙ row; the panel is busy while the request runs and Stop sends {cancel}
//   5  the agent goes muted: the panel can no longer send and says why
// A real-Quest row (speak to Claude with the headset on) goes on 56-int's checklist.
//
// Run: APP_URL=https://theprototype.app:5433/ npm run e2e -- agent-chat-vr
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const inPage = (peer, body, arg) =>
	peer.page.evaluate(
		([src, a]) => {
			let pc = null;
			window.__stores.peers.subscribe((v) => (pc = v))();
			const get = (st) => {
				let v;
				st.subscribe((x) => (v = x))();
				return v;
			};
			return Object.getPrototypeOf(async function () {}).constructor('s', 'pc', 'arg', 'get', src)(window.__stores, pc, a, get);
		},
		[body, arg ?? null]
	);
async function until(fn, pred, timeout = 10000) {
	const t0 = Date.now();
	let last;
	while (Date.now() - t0 < timeout) {
		try {
			last = await fn();
			if (pred(last)) return last;
		} catch {}
		await new Promise((r) => setTimeout(r, 300));
	}
	return last;
}
const agentInbox = (B) => inPage(B, 'return Object.values(get(s.agentChat.agentChatState).chats).flatMap((c) => c.messages);');
const agentSays = (B, msg) => inPage(B, "pc.send({ type: 'agentchat', from: pc.peer.id, ...arg }); return true;", msg);

h.run(async () => {
	const browser = await h.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B', { storage: { agentApi: '1' } });
	const origin = new URL(A.page.url()).origin;
	let sttCalls = 0;
	await A.page.route('**/mock-stt/v1/audio/transcriptions', async (route) => {
		sttCalls++;
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'make a red cube' }) });
	});
	await inPage(A, "s.aiStt.setSttConfig({ preset: 'custom', baseUrl: arg + '/mock-stt/v1', apiKey: 'k', model: 'whisper-1' });", origin);
	await h.connect(B, A);
	await until(() => inPage(A, 'return get(s.userdata);'), (rows) => rows?.some((r) => r[0] === B.id && r[6]?.kind === 'agent'), 20000);
	await agentSays(B, { status: 'listening', mode: 'repl', model: 'grok-3-mini' });
	await until(() => inPage(A, 'return get(s.agentChat.agentTargets);'), (t) => t?.length === 1, 10000);
	await inPage(A, "s.agentChat.chatTarget.set({ kind: 'agent', id: arg }); s.agentChat.newChat();", B.id);

	console.log('\n=== 1. in the headset, the panel follows the agent ===');
	await iwer.enter(A.page);
	await inPage(A, 's.vrAiPanelOpen.set(true)');
	await iwer.frames(A.page, 4);
	const head = await inPage(A, 'return { title: get(s.vrAiPanel.vrAiTitle), ready: get(s.vrAiPanel.vrAiReady), open: get(s.vrAiPanelOpen), presenting: !!get(s.globalRenderer)?.xr?.isPresenting };');
	h.check(head.presenting && head.open, `premise: presenting, panel open (${JSON.stringify(head)})`);
	h.check(/AI agent/.test(head.title) && head.ready, `the header names the agent and it can be addressed (${head.title})`);

	console.log('\n=== 2. the VR keyboard sends to the agent ===');
	const typed = await inPage(A, `
		s.vrControls.executeVRMenuAction('ai:input');
		const target = get(s.vrKeyboard.vrKeyboardTarget);
		'add a tree'.split('').forEach((k) => s.vrKeyboard.pressVRKey(k === ' ' ? 'space' : k));
		s.vrKeyboard.pressVRKey('enter');
		return { title: target?.title, providerThread: get(s.aiAssistant.aiMessages).length };
	`);
	const inbox1 = await until(() => agentInbox(B), (l) => l?.some((m) => m.text === 'add a tree'), 10000);
	const req1 = inbox1?.find((m) => m.text === 'add a tree');
	h.check(!!req1 && req1.to === B.id && req1.from === A.id, `the keyboard commit reached the agent, addressed to it (${typed.title})`);
	h.check(typed.providerThread === 0, 'nothing went to the provider thread');

	console.log('\n=== 3. speak to the agent ===');
	await agentSays(B, { id: 'r-a', chatId: req1.chatId, to: A.id, replyTo: req1.id, text: 'Done.' }); // free the turn
	await until(() => inPage(A, 'return get(s.vrAiPanel.vrAiBusy);'), (b) => b === false, 5000);
	const talk = await inPage(A, `
		const claimed = s.vrAiPanel.aiTalkHold(true);
		await new Promise((r) => setTimeout(r, 900));
		const released = s.vrAiPanel.aiTalkHold(false);
		return { claimed, released };
	`);
	const spoken = await until(() => agentInbox(B), (l) => l?.some((m) => m.text === 'make a red cube'), 15000);
	h.check(talk.claimed && talk.released && !!spoken?.some((m) => m.text === 'make a red cube' && m.from === A.id), `holding the talk binding dictates and the transcript goes to the agent (${JSON.stringify(talk)}, ${sttCalls} upload)`);
	const req2 = spoken?.find((m) => m.text === 'make a red cube');

	console.log('\n=== 4. the answer streams into the panel; Stop ===');
	await agentSays(B, { status: 'working', chatId: req2.chatId, mode: 'repl', model: 'grok-3-mini' });
	await agentSays(B, { id: 'r-b', chatId: req2.chatId, to: A.id, replyTo: req2.id, text: 'Making a red', partial: true });
	await inPage(B, "s.agentLog.publishAgentEntry({ id: pc.peer.id + ':v1', peer: pc.peer.id, name: 'grok', tool: 'create_objects', text: 'created 1 object (Cube)', uuids: [], at: Date.now(), ok: true });");
	const rows = await until(() => inPage(A, 'return get(s.vrAiPanel.vrAiMessages);'), (r) => r?.some((x) => x.streaming && /Making a red/.test(x.content)) && r?.some((x) => x.role === 'tool-status'), 8000);
	h.check(!!rows?.some((x) => x.role === 'assistant' && x.streaming && /Making a red/.test(x.content)), 'the streamed answer shows in the panel');
	h.check(!!rows?.some((x) => x.role === 'tool-status' && /Cube/.test(x.content)), 'the agent’s A8 step is a ⚙ row');
	h.check(await inPage(A, 'return get(s.vrAiPanel.vrAiBusy);'), 'the panel is busy while the request runs');
	await B.page.evaluate(() => {
		window.__seen = [];
		let pc;
		window.__stores.peers.subscribe((v) => (pc = v))();
		for (const c of Object.values(pc.connections)) c.on('data', (d) => d?.type === 'agentchat' && d.cancel && window.__seen.push(d));
	});
	await inPage(A, "s.vrControls.executeVRMenuAction('ai:stop')");
	const cancels = await until(() => B.page.evaluate(() => window.__seen), (l) => l?.length > 0, 8000);
	h.check(cancels?.[0]?.cancel === req2.id, 'the panel’s Stop sends {cancel} for the running request');

	console.log('\n=== 5. muted ===');
	await agentSays(B, { status: 'listening', muted: true, mode: 'repl' });
	const mute = await until(() => inPage(A, 'return { ready: get(s.vrAiPanel.vrAiReady), hint: get(s.vrAiPanel.vrAiHint) };'), (m) => m?.ready === false, 8000);
	h.check(mute?.ready === false && /muted/.test(mute?.hint ?? ''), `the panel cannot send to a muted agent and says why (${mute?.hint})`);
	const before = (await agentInbox(B)).length;
	await inPage(A, "s.vrControls.executeVRMenuAction('ai:input'); return !!get(s.vrKeyboard.vrKeyboardTarget);").then((kb) => h.check(!kb, 'its input row stays shut'));
	h.check((await agentInbox(B)).length === before, 'nothing was sent');

	await iwer.exit(A.page);
	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).slice(0, 2).join(' | ')})`);
	await h.finish(browser);
});
