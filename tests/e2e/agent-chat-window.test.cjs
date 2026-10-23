// Roadmap 56 (lane 56-chat) — TALK TO YOUR AGENT, the window side of the release proof. Three real
// peers over signaling: A hosts (a person), B is an AGENT page (safeStorage `agentApi`, so its roster
// row says kind:'agent') driven by this script as a FAKE agent — no MCP host, no bridge: it reads what
// arrived in its own store and answers with raw `agentchat` messages, exactly the wire 56-bridge's
// agentInbox speaks. C joins LATE, as a viewer.
//
//   1  the target picker lists the agent next to the providers, labelled from its status (MCP)
//   2  A asks "add three trees around the fire": B receives it addressed to B; B streams a reply
//      (partials grow ONE bubble with a caret, the final one settles it) and its A8 action line
//      shows INTERLEAVED in the thread
//   3  a turn typed in the agent's terminal shows "via terminal"; an ask's options are buttons and
//      the press goes back as a request that `answers` it
//   4  Stop mid-request: B receives `{cancel: <the running request>}`, the bubble says Stopped
//   5  C joins late: the thread is there (the backlog); C is a viewer — the composer says what the
//      agent will not do, C's question still REACHES the agent through a plugin gate that drops
//      everything else from a viewer (the ALWAYS_ALLOWED floor), and A shows it with a viewer chip
//   6  Mute: the host's peer menu sends `{mute:true}` to the agent; once the agent says muted, the
//      composer stops; a viewer is not offered Mute
//   7  history: New chat → empty; the history icon lists both chats (newest first); picking the
//      first reopens it; the Explorer's double-click seam (tpchatStore.openChat) does too; the
//      host is the one writer that saved both through the store
//   8  axe serious-only gate on the window (agent thread + history)
//
// Run: APP_URL=https://theprototype.app:5433/ npm run e2e -- agent-chat-window
// (56-union: 56-chat shipped this as agent-chat.test.cjs, the same name as 56-bridge's MCP suite — renamed)
const h = require('./helpers.cjs');
const { AxeBuilder } = require('@axe-core/playwright');

const inPage = (peer, body, arg) =>
	peer.page.evaluate(
		([src, a]) => {
			let pc = null;
			window.__stores.peers.subscribe((v) => (pc = v))();
			return Object.getPrototypeOf(async function () {}).constructor('s', 'pc', 'arg', src)(window.__stores, pc, a);
		},
		[body, arg ?? null]
	);
const read = (peer, store) => inPage(peer, `let v; s.${store}.subscribe((x) => (v = x))(); return v;`);
/** poll until `pred(value)`; returns the last value */
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
/** every chat message B (the agent page) holds, across chats */
const agentInbox = (B) => inPage(B, 'let v; s.agentChat.agentChatState.subscribe((x) => (v = x))(); return Object.values(v.chats).flatMap((c) => c.messages);');
/** the agent speaks: one raw agentchat from B */
const agentSays = (B, msg) => inPage(B, "pc.send({ type: 'agentchat', from: pc.peer.id, ...arg }); return true;", msg);
const bubbles = (peer) =>
	peer.page.$$eval('#ai-assistant-window .ath li', (els) =>
		els.map((e) => ({ kind: e.getAttribute('data-kind') || (e.classList.contains('ath-log') ? 'log' : ''), text: e.textContent.replace(/\s+/g, ' ').trim(), caret: !!e.querySelector('.ai-caret') }))
	);

h.run(async () => {
	const browser = await h.launch();
	// the window parked under the header: at its default spot three peers' avatar stack covers its title-bar icons
	const parked = { 'win:aiAssistant': JSON.stringify({ left: 380, top: 140 }) };
	const A = await h.setupPage(browser, 'A', { storage: parked });
	const B = await h.setupPage(browser, 'B', { storage: { agentApi: '1' } });
	await inPage(B, "s.username?.set?.('Claude')");
	await h.connect(B, A);
	await until(() => read(A, 'userdata'), (rows) => rows?.some((r) => r[0] === B.id && r[6]?.kind === 'agent'), 20000);

	console.log('\n=== 1. the agent is a target ===');
	await agentSays(B, { status: 'listening', mode: 'mcp' });
	await inPage(A, "s.aiAssistantHidden.set('')");
	await A.page.locator('#ai-assistant-window').waitFor({ timeout: 8000 });
	const opt = A.page.locator(`#ai-target option[value="a:${B.id}"]`);
	await until(() => opt.count(), (n) => n === 1, 10000);
	const label = (await opt.textContent().catch(() => '')) ?? '';
	h.check(/agent via MCP/.test(label), `the picker lists the agent, labelled from its status (${label.trim()})`);
	h.check((await A.page.locator('#ai-target optgroup[label="AI agents in this session"]').count()) === 1, 'in its own group beside the assistant');
	await A.page.selectOption('#ai-target', `a:${B.id}`);
	await A.page.locator('#ai-assistant-window .ath').waitFor({ timeout: 5000 });
	h.check(/is listening/.test(await A.page.locator('.ath-status').textContent()), 'the status line says the agent is listening');
	h.check((await A.page.locator('#agent-log').count()) === 0, 'the separate Agent activity list gives way to the thread');

	console.log('\n=== 2. a request, a streamed reply, the A8 line between ===');
	await A.page.locator('#ai-assistant-window input[aria-label^="Message"]').fill('add three trees around the fire');
	await A.page.locator('#ai-send').click();
	const got = await until(() => agentInbox(B), (l) => l?.some((m) => m.kind === 'request' && /three trees/.test(m.text)), 10000);
	const req1 = got?.find((m) => /three trees/.test(m.text));
	h.check(!!req1 && req1.to === B.id && req1.from === A.id && !!req1.chatId, `the agent page received it, addressed to it, from A (${JSON.stringify(req1 && { to: req1.to, from: req1.from })})`);
	h.check(!('role' in (req1 ?? {})), 'no role rides the wire (the agent page reads it from rolesInfo)');
	const chatId = req1?.chatId;
	await agentSays(B, { status: 'working', chatId, mode: 'mcp' });
	for (const text of ['Planting', 'Planting three']) await agentSays(B, { id: 'rep1', chatId, to: A.id, replyTo: req1.id, text, partial: true });
	const streaming = await until(() => bubbles(A), (b) => b.some((x) => x.kind === 'reply' && x.caret && /Planting three/.test(x.text)), 8000);
	h.check(streaming?.filter((x) => x.kind === 'reply').length === 1, `partials grow ONE bubble with a caret (${JSON.stringify(streaming?.filter((x) => x.kind === 'reply'))})`);
	h.check((await A.page.locator('#ai-agent-stop').count()) === 1, 'while it runs, the composer offers Stop');
	await inPage(B, "s.agentLog.publishAgentEntry({ id: pc.peer.id + ':t1', peer: pc.peer.id, name: 'Claude', tool: 'create_objects', text: 'created 3 objects (Tree +2)', uuids: [], at: Date.now(), ok: true });");
	await new Promise((r) => setTimeout(r, 300));
	await agentSays(B, { id: 'rep1', chatId, to: A.id, replyTo: req1.id, text: 'Planted three trees around the fire.' });
	await agentSays(B, { status: 'listening', chatId, mode: 'mcp' });
	const settled = await until(() => bubbles(A), (b) => b.some((x) => x.kind === 'reply' && !x.caret && /Planted three/.test(x.text)), 8000);
	const order = (settled ?? []).map((x) => x.kind).join(',');
	h.check(order === 'request,log,reply', `the thread reads request → the agent's step → its answer (${order})`);
	h.check((await A.page.locator('#ai-agent-stop').count()) === 0, 'the final reply ends the running state (Send is back)');

	console.log('\n=== 3. via terminal, and an ask ===');
	await agentSays(B, { id: 'cli1', chatId, role: 'user', via: 'cli', text: 'also put a bench by the fire' });
	const cli = A.page.locator('#ai-assistant-window li[data-kind="cli"]');
	await cli.waitFor({ timeout: 8000 }).catch(() => {});
	h.check(/via terminal/.test((await cli.textContent().catch(() => '')) ?? ''), 'a turn typed in the agent’s terminal shows "via terminal"');
	await agentSays(B, { id: 'ask1', chatId, to: A.id, ask: { question: 'Pine or oak for the bench?', options: ['Pine', 'Oak'] } });
	const oak = A.page.locator('#ai-assistant-window li[data-kind="ask"] .ath-option', { hasText: 'Oak' });
	await oak.waitFor({ timeout: 8000 }).catch(() => {});
	await oak.click();
	const answered = await until(() => agentInbox(B), (l) => l?.some((m) => m.answers === 'ask1'), 8000);
	h.check(answered?.find((m) => m.answers === 'ask1')?.text === 'Oak', 'the press goes back to the agent as a request that answers the ask');
	h.check((await A.page.locator('li[data-kind="ask"] .ath-option').count()) === 0, 'the buttons go once answered');
	await agentSays(B, { id: 'rep2', chatId, to: A.id, replyTo: answered.find((m) => m.answers === 'ask1').id, text: 'Oak it is.' });

	console.log('\n=== 4. Stop ===');
	await A.page.locator('#ai-assistant-window input[aria-label^="Message"]').fill('now build a cabin');
	await A.page.locator('#ai-send').click();
	const req2 = (await until(() => agentInbox(B), (l) => l?.some((m) => /cabin/.test(m.text)), 8000))?.find((m) => /cabin/.test(m.text));
	await agentSays(B, { id: 'rep3', chatId, to: A.id, replyTo: req2?.id, text: 'Laying the floor', partial: true });
	await A.page.locator('#ai-agent-stop').waitFor({ timeout: 8000 });
	await B.page.evaluate(() => {
		window.__cancelSeen = [];
		let pc;
		window.__stores.peers.subscribe((v) => (pc = v))();
		for (const conn of Object.values(pc.connections)) conn.on('data', (d) => d?.type === 'agentchat' && (d.cancel || d.mute !== undefined) && window.__cancelSeen.push(d));
	});
	await A.page.locator('#ai-agent-stop').click();
	const cancels = await until(() => B.page.evaluate(() => window.__cancelSeen), (l) => l?.some((d) => d.cancel), 8000);
	h.check(cancels?.find((d) => d.cancel)?.cancel === req2?.id, `the agent receives {cancel: <the running request>} (${JSON.stringify(cancels?.[0])})`);
	h.check(/Stopped/.test((await A.page.locator(`li[data-msg="${req2?.id}"]`).textContent().catch(() => '')) ?? ''), 'the request says Stopped');
	h.check((await A.page.locator('#ai-agent-stop').count()) === 0, 'and the composer is back to Send');

	console.log('\n=== 5. a late joiner, a viewer ===');
	const C = await h.setupPageQuiet(browser, 'C', [A, B], { storage: parked });
	await h.connect(C, A);
	const cChat = await until(() => read(C, 'agentChat.agentChatState'), (st) => (st?.chats?.[chatId]?.messages?.length ?? 0) >= 6, 20000);
	h.check((cChat?.chats?.[chatId]?.messages?.length ?? 0) >= 6, `the late joiner has the thread from the backlog (${cChat?.chats?.[chatId]?.messages?.length ?? 0} messages)`);
	// roles: C is a viewer on every page; B (the agent) runs a plugin gate that drops everything else from C
	await inPage(C, "s.cloudHooks.rolesInfo.set({ myId: pc.peer.id, myRole: 'viewer', amAdmin: false, order: [], roleOf: (id) => (id === pc.peer.id ? 'viewer' : 'editor'), setRole() {} })");
	await inPage(A, "s.cloudHooks.rolesInfo.set({ myId: pc.peer.id, myRole: 'admin', amAdmin: true, order: [], roleOf: (id) => (id === arg ? 'viewer' : 'admin'), setRole() {} })", C.id);
	await inPage(B, "s.cloudHooks.rolesInfo.set({ myId: pc.peer.id, myRole: 'editor', amAdmin: false, order: [], roleOf: (id) => (id === arg ? 'viewer' : 'admin'), setRole() {} }); s.cloudHooks.setCapabilityProvider((peerId) => peerId !== arg);", C.id);
	await inPage(C, "s.aiAssistantHidden.set('')");
	await C.page.locator(`#ai-target option[value="a:${B.id}"]`).waitFor({ state: 'attached', timeout: 10000 });
	await C.page.selectOption('#ai-target', `a:${B.id}`);
	const cBubbles = await until(() => bubbles(C), (b) => b.some((x) => /Planted three/.test(x.text)), 8000);
	h.check(cBubbles?.some((x) => /Planted three/.test(x.text)) && cBubbles?.some((x) => x.kind === 'cli'), 'C reads the same conversation, terminal turn included');
	h.check((await C.page.locator('#ai-viewer-hint').count()) === 1, 'a viewer is told the agent will not change the scene for them');
	await C.page.locator('#ai-assistant-window input[aria-label^="Message"]').fill('what is the fire made of?');
	await C.page.locator('#ai-send').click();
	const fromViewer = await until(() => agentInbox(B), (l) => l?.some((m) => m.from === C.id && /fire made of/.test(m.text)), 10000);
	h.check(!!fromViewer?.some((m) => m.from === C.id), "the viewer's question REACHES the agent through a gate that drops a viewer's other messages");
	const gatedOther = await inPage(B, "return s.cloudHooks.canApply(arg, 'agentlog');", C.id);
	h.check(gatedOther === false, 'premise: that gate does drop a viewer’s other types');
	const chip = await until(() => A.page.locator(`li[data-kind="request"] .ath-role[data-role="viewer"]`).count(), (n) => n >= 1, 8000);
	h.check(chip >= 1, 'A shows the sender with a viewer chip');

	console.log('\n=== 6. Mute ===');
	await A.page.evaluate(() => document.querySelector('#peers-trigger')?.click());
	await A.page.locator('#peers-popover').waitFor({ timeout: 8000 });
	await A.page.locator(`#peers-popover .peers-row[data-peer-id="${B.id}"]`).first().click({ button: 'right' });
	const muteRow = A.page.locator('[data-testid="peer-menu-agent-mute"]');
	await muteRow.waitFor({ timeout: 5000 }).catch(async (err) => {
		const seen = await A.page.$$eval('[data-testid^="peer-menu-"]', (els) => els.map((e) => e.getAttribute('data-testid') + (e.getBoundingClientRect().height ? '' : '(0h)')));
		const rowB = await inPage(A, 'return get(s.userdata).find((r) => r[0] === arg);', B.id);
		const rows = await A.page.$$eval('#peers-popover .peers-row[data-peer-id]', (els) => els.map((e) => e.getAttribute('data-peer-id') + (e.getBoundingClientRect().height ? '' : '(0h)')));
		await A.page.screenshot({ path: require('path').join(process.env.E2E_SHOTS || require('os').tmpdir(), 'agent-chat-mute.png') }).catch(() => {});
		console.log('mute row missing — menu:', JSON.stringify(seen), 'B row:', JSON.stringify(rowB), 'popover rows:', JSON.stringify(rows));
		throw err;
	});
	h.check((await muteRow.getAttribute('aria-disabled')) !== 'true', 'the host is offered Mute agent');
	await muteRow.click();
	const mutes = await until(() => B.page.evaluate(() => window.__cancelSeen), (l) => l?.some((d) => d.mute === true), 8000);
	h.check(mutes?.find((d) => d.mute === true)?.to === B.id, 'the agent receives {mute: true}');
	await inPage(A, 's.peersPanelOpen.set(false)');
	await agentSays(B, { status: 'listening', muted: true, mode: 'mcp' });
	const muted = await until(() => A.page.locator('#ai-assistant-window input[aria-label^="Message"]').isDisabled(), (v) => v, 8000);
	h.check(muted, 'once the agent says muted, the composer stops');
	h.check(/muted/.test(await A.page.locator('.ath-status').textContent()), 'and the status line says so');
	await C.page.evaluate(() => document.querySelector('#peers-trigger')?.click());
	await C.page.locator('#peers-popover').waitFor({ timeout: 8000 }).catch(() => {});
	await C.page.locator(`#peers-popover .peers-row[data-peer-id="${B.id}"]`).first().click({ button: 'right' }).catch(() => {});
	const cMute = C.page.locator('[data-testid="peer-menu-agent-mute"]');
	await cMute.waitFor({ timeout: 5000 }).catch(() => {});
	h.check((await cMute.getAttribute('aria-disabled').catch(() => null)) === 'true' || (await cMute.isDisabled().catch(() => false)), 'a viewer is not offered Mute (disabled with the reason)');
	await C.page.keyboard.press('Escape');
	await inPage(C, 's.peersPanelOpen.set(false)');
	await agentSays(B, { status: 'listening', muted: false, mode: 'mcp' });

	console.log('\n=== 7. history: New chat, reopen ===');
	await A.page.locator('#ai-new-chat').click();
	const fresh = await read(A, 'agentChat.activeChatId');
	h.check(!!fresh && fresh !== chatId, 'New chat starts another chat');
	h.check((await bubbles(A)).length === 0, 'with an empty thread');
	await until(() => A.page.locator('#ai-assistant-window input[aria-label^="Message"]').isEnabled(), (v) => v, 5000);
	await A.page.locator('#ai-assistant-window input[aria-label^="Message"]').fill('a second idea: a pond');
	await A.page.locator('#ai-send').click();
	await A.page.locator('#ai-history-btn').click();
	await A.page.locator('#ai-chat-history').waitFor({ timeout: 5000 });
	const rows = await A.page.$$eval('#ai-chat-history .chist-row', (els) => els.map((e) => e.getAttribute('data-chat')));
	h.check(rows.length === 2 && rows[0] === fresh && rows[1] === chatId, `the history lists both chats, newest first (${rows.length})`);
	await A.page.fill('#ai-chat-search', 'trees');
	h.check((await A.page.locator('#ai-chat-history .chist-row').count()) === 1, 'search narrows it');
	await A.page.locator(`#ai-chat-history .chist-row[data-chat="${chatId}"]`).click();
	h.check((await read(A, 'agentChat.activeChatId')) === chatId && (await bubbles(A)).some((x) => /Planted three/.test(x.text)), 'picking a row reopens that chat, its thread intact');
	await A.page.locator('#ai-new-chat').click();
	await inPage(A, 's.tpchatStore.openChat(arg)', chatId);
	h.check((await read(A, 'agentChat.activeChatId')) === chatId, 'the Explorer’s open seam (tpchatStore.openChat) opens it too');
	const saved = await until(() => read(A, 'tpchatStore.chatList'), (l) => l?.length >= 2, 8000);
	h.check(saved?.length >= 2 && saved.some((c) => c.id === chatId && c.target?.kind === 'agent'), `the host (the one writer) saved both chats through the store (${saved?.length})`);
	const cSaved = await read(C, 'tpchatStore.chatList');
	h.check((cSaved?.length ?? 0) === 0, 'a viewer writes no chat file');

	console.log('\n=== 8. axe on the window ===');
	await A.page.locator('#ai-history-btn').click();
	await A.page.locator('#ai-chat-history').waitFor({ timeout: 5000 });
	const res = await new AxeBuilder({ page: A.page }).include('#ai-assistant-window').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
	await A.page.locator('#ai-chat-history .chist-close').click();
	const res2 = await new AxeBuilder({ page: A.page }).include('#ai-assistant-window').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
	const gated = [...res.violations, ...res2.violations].filter((v) => v.impact === 'serious' || v.impact === 'critical');
	for (const v of [...res.violations, ...res2.violations]) console.log(`  [axe] ${v.impact} ${v.id} (${v.nodes.length}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
	h.check(gated.length === 0, `no serious/critical axe violations in the window (${gated.map((v) => v.id).join(', ') || 'none'})`);

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(C).length === 0, `no page errors (${[...h.pageErrors(A), ...h.pageErrors(C)].slice(0, 2).join(' | ')})`);
	await h.finish(browser, [A, B, C]);
});
