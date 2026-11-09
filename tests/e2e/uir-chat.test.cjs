// uir-chat — CHAT AND THE AI ASSISTANT IN ONE WINDOW (q-chat-save option c, review item 3 variant B):
//   1. each button lands on its tab: the Chat button -> Session, the AI button -> Assistant, the C key ->
//      Session; the other tab's button SWITCHES (the window stays), the showing tab's button CLOSES it
//   2. Session between two peers: A sends, B gets it; B (on Assistant) sees the Session tab's unread dot
//   3. Assistant: ask the mocked provider, the answer streams in; the provider chat stays on A
//   4. reload A: the session lines come back (marked as saved, once each), the provider chat comes back with
//      its turns, and ONE History lists both kinds with an All | People | AI filter; a People row -> Session,
//      an AI row -> Assistant. A second reload changes nothing (counterfactual for the "a line from a save is
//      never filed again" guard: the log's line count stays put)
//   5. images in the AI chat are ATTACHMENTS: the saved chat holds a key, the bytes sit in their own record
//      (counterfactual: the in-memory message did carry the data: URL)
//   6. another scene's log opens read-only (no composer), Back to live chat returns
//   7. old saved state naming the assistant's own window opens the one window on its Assistant tab
//      (counterfactual: state naming only Chat opens on Session)
//   8. the phone (N6 folded): one sheet, the AI button opens it on Assistant, the tab row switches
//   9. axe on the window, both tabs
// Run: APP_URL=https://theprototype.app:7006/ npm run e2e -- uir-chat
const path = require('node:path');
const fs = require('node:fs');
const h = require('./helpers.cjs');

const OUT = process.env.EVIDENCE_DIR || path.join(__dirname, '..', '..', 'test-results', 'uir-chat');
fs.mkdirSync(OUT, { recursive: true });
const ev = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
const SAY = (text) => ev({ choices: [{ delta: { content: text } }] }) + ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** a store's current value by dotted path ('chatTab', 'aiAssistant.aiMessages') */
const read = (peer, name) =>
	peer.page.evaluate((n) => {
		const s = n.split('.').reduce((o, k) => o?.[k], window.__stores);
		if (!s?.subscribe) return undefined;
		let v;
		s.subscribe((x) => (v = x))();
		return v;
	}, name);
const state = async (peer) => ({ open: (await read(peer, 'chatHidden')) === '', tab: await read(peer, 'chatTab') });
const idb = (peer, key) => peer.page.evaluate((k) => window.__stores.idb.idbGet(k), key);
/** press a toolbar button when the layout shows it, else run the same toggle the button runs */
async function press(peer, sel, tab) {
	const btn = peer.page.locator(sel).first();
	if (await btn.isVisible().catch(() => false)) await btn.click();
	else await peer.page.evaluate((t) => window.__stores.chatWindow.toggleChatTab(t), tab);
	await peer.page.waitForTimeout(400);
}
async function axe(page, label) {
	const { default: AxeBuilder } = require('@axe-core/playwright');
	const res = await new AxeBuilder({ page }).include('#chat-window').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
	for (const v of res.violations) console.log(`  [axe ${label}] ${v.impact} ${v.id} (${v.nodes.length}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
	const gated = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
	h.check(gated.length === 0, `9 axe ${label}: no serious/critical violations (${gated.map((v) => v.id).join(', ') || 'none'})`);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => {
		const p = window.__stores.aiProviders;
		const id = p.addAiProvider({ preset: 'custom', label: 'MockChat', baseUrl: location.origin + '/mock-ai/v1', model: 'chat-1', apiKey: 'k' });
		p.setAiActiveProvider(id);
		p.setAiEnabled(true);
	});
	await h.freshReload(A);
	await h.answerRestore(A).catch(() => {});
	/** @type {any[]} */
	const requests = [];
	await A.page.context().route('**/mock-ai/v1/chat/completions', (route) => {
		requests.push(route.request().postDataJSON());
		route.fulfill({ status: 200, contentType: 'text/event-stream', body: SAY('Three red boxes, coming up.') });
	});
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---- 1. each button lands on its tab ---------------------------------------------------------------
	console.log('\n=== 1. the buttons ===');
	h.check(!(await state(A)).open, '1.0 premise: the window starts closed');
	await press(A, '#chat-button', 'session');
	let s = await state(A);
	h.check(s.open && s.tab === 'session' && (await A.page.locator('#chat-session').isVisible()), `1.1 the Chat button opens the window on Session (${JSON.stringify(s)})`);
	h.check((await A.page.locator('#chat-tab-session').getAttribute('aria-selected')) === 'true', '1.2 the Session tab is the selected tab');
	await press(A, '#ai-hud-button', 'assistant');
	s = await state(A);
	h.check(s.open && s.tab === 'assistant' && (await A.page.locator('#ai-assistant-window').isVisible()) && !(await A.page.locator('#chat-session').isVisible()), `1.3 the AI button, the window open on Session: it SWITCHES to Assistant, the window stays (${JSON.stringify(s)})`);
	h.check((await read(A, 'aiAssistantHidden')) === '' && (await A.page.locator('#chat-window').count()) === 1, '1.4 one window: the assistant store reads open, one #chat-window');
	await press(A, '#ai-hud-button', 'assistant');
	h.check(!(await state(A)).open, '1.5 the AI button again (Assistant showing) closes the window');
	await A.page.evaluate(() => /** @type {any} */ (document.activeElement)?.blur?.());
	await A.page.keyboard.press('c');
	await A.page.waitForTimeout(400);
	s = await state(A);
	h.check(s.open && s.tab === 'session', `1.6 the C key opens it on Session (${JSON.stringify(s)})`);
	await A.page.locator('#chat-tab-assistant').click();
	await A.page.keyboard.press('ArrowLeft');
	h.check((await read(A, 'chatTab')) === 'session' && (await A.page.evaluate(() => document.activeElement?.id)) === 'chat-tab-session', '1.7 the tab row: a click picks a tab, the arrow keys walk it');
	await A.page.screenshot({ path: path.join(OUT, 'uir-chat-01-session-tab.png') }).catch(() => {});

	// ---- 2. Session between two peers ------------------------------------------------------------------
	console.log('\n=== 2. Session ===');
	await B.page.evaluate(() => window.__stores.chatWindow.openChatTab('assistant'));
	await B.page.waitForTimeout(300);
	for (const text of ['hello from A', 'the fence goes here']) {
		await A.page.locator('#message').fill(text);
		await A.page.keyboard.press('Enter');
	}
	await h.eventually(
		() => read(B, 'messages'),
		(l) => ['hello from A', 'the fence goes here'].every((t) => l?.some((m) => m.type === 'received' && m.text === t)),
		'2.1 B receives both lines'
	);
	await h.eventually(() => B.page.locator('#chat-tab-session .chat-tab-dot[data-unread="session"]').count(), (n) => n === 1, '2.2 B, on Assistant, sees the Session tab\'s unread dot');
	await B.page.locator('#chat-tab-session').click();
	await h.eventually(() => B.page.locator('#chat-tab-session .chat-tab-dot').count(), (n) => n === 0, '2.3 showing Session reads it (the dot goes)');
	h.check((await B.page.locator('#messages li', { hasText: 'the fence goes here' }).count()) === 1, '2.4 the line is in B\'s Session tab');
	await B.page.locator('#message').fill('sounds good');
	await B.page.keyboard.press('Enter');
	await h.eventually(() => read(A, 'messages'), (l) => l?.some((m) => m.type === 'received' && m.text === 'sounds good'), '2.5 A gets B\'s answer');

	// ---- 3. Assistant: the mocked provider ---------------------------------------------------------------
	console.log('\n=== 3. Assistant ===');
	await A.page.locator('#chat-tab-assistant').click();
	await A.page.locator('#ai-assistant-window input[type="text"]').fill('make three red boxes');
	await A.page.locator('#ai-send').click();
	await h.eventually(() => requests.length, (n) => n >= 1, '3.1 the prompt reached the provider', 15000);
	await h.eventually(() => read(A, 'aiAssistant.aiBusy'), (b) => b === false, '3.2 the run ended', 20000);
	await h.eventually(() => A.page.locator('#ai-assistant-window').getByText('Three red boxes, coming up.').count(), (n) => n >= 1, '3.3 the answer shows in the Assistant tab');
	h.check(((await read(B, 'aiAssistant.aiMessages')) ?? []).length === 0, '3.4 the provider chat stays on A (B has no turn)');
	await A.page.screenshot({ path: path.join(OUT, 'uir-chat-02-assistant-tab.png') }).catch(() => {});
	const savesOf = (peer) => peer.page.evaluate(() => {
		const t = window.__stores.chatSaves.chatSavesForTest();
		return { ai: t.ai, active: t.active, room: t.room };
	});
	await h.eventually(() => savesOf(A), (t) => t.ai.length === 1 && !!t.active, '3.5 the provider chat is saved on this device (one row, the active one)');
	const aiId = (await savesOf(A)).active;

	// ---- 5. images stay attachments ------------------------------------------------------------------------
	console.log('\n=== 5. pictures in the AI chat ===');
	await A.page.evaluate((png) => {
		const m = window.__stores.aiAssistant.aiMessages;
		m.update((list) => [...list, { role: 'user', content: 'like this one', images: [{ url: png, name: 'swatch.png' }] }]);
	}, PNG);
	h.check(JSON.stringify(await read(A, 'aiAssistant.aiMessages')).includes('base64'), '5.0 premise (counterfactual): the live message carries the picture as a data: URL');
	await h.eventually(() => idb(A, 'aichat:' + aiId), (r) => r?.messages?.some((m) => m.images?.length), '5.1 the saved chat has the picture turn');
	const rec = await idb(A, 'aichat:' + aiId);
	const stored = JSON.stringify(rec ?? {});
	const key = rec?.messages?.find((m) => m.images?.length)?.images?.[0]?.key;
	h.check(!stored.includes('base64') && !stored.includes('data:image'), `5.2 the saved chat holds no inline picture bytes (${stored.length} chars)`);
	const bytes = key ? await idb(A, 'aichat:img:' + key) : null;
	h.check(!!key && bytes?.mimeType === 'image/png' && typeof bytes?.data === 'string' && bytes.data.length > 20, `5.3 the bytes are their own record, by key (${key})`);

	// ---- 4. reload: both histories come back -----------------------------------------------------------------
	console.log('\n=== 4. reload ===');
	await A.page.evaluate(() => window.__stores.chatSaves.flush());
	const logBefore = await idb(A, 'chatlog:untitled');
	h.check(logBefore?.lines?.length === 3, `4.0 premise: the session log holds the three lines (${logBefore?.lines?.length})`);
	await h.freshReload(A);
	await h.answerRestore(A).catch(() => {});
	await A.page.waitForTimeout(1500);
	await press(A, '#chat-button', 'session');
	for (const t of ['hello from A', 'the fence goes here', 'sounds good'])
		await h.eventually(() => A.page.locator('#messages li', { hasText: t }).count(), (n) => n === 1, `4.1 after the reload "${t}" is back in Session, once`);
	h.check((await A.page.locator('#messages li.chat-past').count()) >= 3, '4.2 the lines from the save are marked as saved');
	const mine = await A.page.evaluate(() => {
		let v;
		window.__stores.messages.subscribe((x) => (v = x))();
		return v.filter((m) => m.saved).map((m) => [m.text, m.type]);
	});
	h.check(mine.some(([t, ty]) => t === 'hello from A' && ty === 'sent') && mine.some(([t, ty]) => t === 'sounds good' && ty === 'received'), `4.3 mine stays mine, B's stays B's (${JSON.stringify(mine)})`);
	await A.page.locator('#chat-tab-assistant').click();
	await h.eventually(() => A.page.locator('#ai-assistant-window').getByText('Three red boxes, coming up.').count(), (n) => n >= 1, '4.4 the provider chat is back in Assistant');
	h.check((await A.page.locator('#ai-assistant-window .ai-pic').count()) >= 1, '4.5 …with its picture, joined back from its own record');
	await A.page.locator('#ai-history-btn').click();
	await A.page.locator('#ai-chat-history').waitFor({ timeout: 5000 });
	const kinds = await A.page.$$eval('#ai-chat-history .chist-row', (els) => els.map((e) => e.getAttribute('data-kind')));
	h.check(kinds[0] === 'people' && kinds.includes('ai'), `4.6 ONE History lists both kinds, this scene's session first (${kinds.join(',')})`);
	await A.page.screenshot({ path: path.join(OUT, 'uir-chat-03-history.png') }).catch(() => {});
	await A.page.locator('#chat-history-filter button', { hasText: 'People' }).click();
	const ppl = await A.page.$$eval('#ai-chat-history .chist-row', (els) => els.map((e) => e.getAttribute('data-kind')));
	await A.page.locator('#chat-history-filter button', { hasText: 'AI' }).click();
	const ais = await A.page.$$eval('#ai-chat-history .chist-row', (els) => els.map((e) => e.getAttribute('data-kind')));
	h.check(ppl.length >= 1 && ppl.every((k) => k === 'people') && ais.length >= 1 && ais.every((k) => k !== 'people'), `4.7 the filter: People (${ppl.join(',')}) | AI (${ais.join(',')})`);
	await A.page.locator('#chat-history-filter button', { hasText: 'All' }).click();
	await A.page.locator('#ai-chat-history .chist-row[data-kind="people"]').first().click();
	h.check((await read(A, 'chatTab')) === 'session' && (await A.page.locator('#ai-chat-history').count()) === 0, '4.8 a People row opens the Session tab');
	await A.page.locator('#ai-history-btn').click();
	await A.page.locator(`#ai-chat-history .chist-row[data-chat="${aiId}"]`).click();
	h.check((await read(A, 'chatTab')) === 'assistant' && (await read(A, 'chatSaves.activeAiChatId')) === aiId, '4.9 an AI row opens the Assistant tab on that chat');
	// counterfactual for the filing guard: a second reload files nothing again
	await h.freshReload(A);
	await h.answerRestore(A).catch(() => {});
	await A.page.waitForTimeout(2500);
	await A.page.evaluate(() => window.__stores.chatSaves.flush());
	const logAfter = await idb(A, 'chatlog:untitled');
	h.check(logAfter?.lines?.length === 3, `4.10 a second reload re-files nothing (log ${logBefore?.lines?.length} -> ${logAfter?.lines?.length})`);
	const count = await A.page.evaluate(() => {
		let v;
		window.__stores.messages.subscribe((x) => (v = x))();
		return v.filter((m) => m.text === 'hello from A').length;
	});
	h.check(count === 1, `4.11 …and shows each line once (${count})`);

	// ---- 6. another scene's log, read only ------------------------------------------------------------------
	console.log('\n=== 6. another scene ===');
	await A.page.evaluate(async () => {
		const { idbPut } = window.__stores.idb;
		const lines = [{ id: 'old-1', text: 'we met in the castle', sender: 'p-old', at: Date.now() - 86400000, name: 'Sam' }];
		await idbPut('chatlog:scene:Castle', { key: 'scene:Castle', title: 'Castle', lines });
		window.__stores.chatSaves.sessionLogs.update((l) => [...l, { key: 'scene:Castle', title: 'Castle', updatedAt: Date.now() - 86400000, count: 1, people: ['Sam'] }]);
	});
	await press(A, '#chat-button', 'session');
	await A.page.locator('#ai-history-btn').click();
	await A.page.locator('#ai-chat-history .chist-row[data-chat="scene:Castle"]').click();
	await A.page.locator('#chat-archive-bar').waitFor({ timeout: 5000 });
	h.check((await A.page.locator('#messages li', { hasText: 'we met in the castle' }).count()) === 1 && (await A.page.locator('#message').count()) === 0, '6.1 another scene\'s log opens read only (its lines, no composer)');
	await A.page.screenshot({ path: path.join(OUT, 'uir-chat-04-archive.png') }).catch(() => {});
	await A.page.locator('#chat-archive-back').click();
	h.check((await A.page.locator('#chat-archive-bar').count()) === 0 && (await A.page.locator('#message').count()) === 1, '6.2 Back to live chat brings the composer back');

	// ---- 9. axe, both tabs ------------------------------------------------------------------------------------
	await axe(A.page, 'Session');
	await A.page.locator('#chat-tab-assistant').click();
	await axe(A.page, 'Assistant');
	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, `no page errors (${[...h.pageErrors(A), ...h.pageErrors(B)].slice(0, 2).join(' | ')})`);
	await h.closePeer(B);
	await h.closePeer(A);

	// ---- 7. old saved state naming the assistant's own window ------------------------------------------------
	console.log('\n=== 7. old layouts ===');
	for (const [label, storage, want] of [
		['old state names the assistant', { aiAssistantDocked: 'true', 'win:aiAssistant': JSON.stringify({ left: 300, top: 200 }) }, 'assistant'],
		['counterfactual: state names only Chat', { chatDocked: 'true' }, 'session']
	]) {
		const P = await h.setupPage(browser, 'old-' + want, { storage });
		const st = await P.page.evaluate(() => ({ docked: localStorage.getItem('chatDocked'), old: localStorage.getItem('aiAssistantDocked'), tab: localStorage.getItem('chat:tab') }));
		await P.page.evaluate(() => window.__stores.chatHidden.set(''));
		await P.page.waitForTimeout(600);
		h.check((await read(P, 'chatTab')) === want && (await P.page.locator('#chat-window').getAttribute('data-tab')) === want, `7 ${label}: the window opens on ${want} (${JSON.stringify(st)})`);
		if (want === 'assistant') h.check(st.docked === 'true' && st.old === null, '7 …the old docked flag became the one window\'s');
		await h.closePeer(P);
	}

	// ---- 8. the phone: one sheet ----------------------------------------------------------------------------
	console.log('\n=== 8. phone ===');
	const N = await h.setupPage(browser, 'folded', { context: { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, isMobile: true, hasTouch: true } });
	await N.page.evaluate(() => window.__stores.chatWindow.toggleChatTab('assistant'));
	await N.page.waitForTimeout(900);
	h.check((await N.page.locator('#chat-window').isVisible()) && (await read(N, 'chatTab')) === 'assistant' && (await N.page.locator('#ai-assistant-window').isVisible()), '8.1 folded: the AI button opens the one sheet on Assistant');
	await N.page.screenshot({ path: path.join(OUT, 'uir-chat-05-folded-assistant.png') }).catch(() => {});
	await N.page.locator('#chat-tab-session').tap();
	await N.page.waitForTimeout(400);
	h.check((await N.page.locator('#chat-session').isVisible()) && (await N.page.locator('#chat-window').count()) === 1, '8.2 the tab row switches to Session in the same sheet');
	const tabBox = await N.page.locator('#chat-tab-session').boundingBox();
	h.check(!!tabBox && tabBox.height >= 32 && tabBox.x >= 0 && tabBox.x + tabBox.width <= 390, `8.3 the tabs fit and are pressable (${JSON.stringify(tabBox)})`);
	await N.page.screenshot({ path: path.join(OUT, 'uir-chat-06-folded-session.png') }).catch(() => {});
	await h.closePeer(N);

	await h.finish(browser);
});
