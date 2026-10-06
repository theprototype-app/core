// 37 R15: chat v2 — emoji shortcodes (expanded on send), @mentions in the mentioned peer's
// colour with a highlight for "you", the toolbar unread badge, a late joiner receiving the
// conversation so far (no duplicates, nothing counted as unread), and history kept in a
// saved session (never in an exported file). A peer's string never becomes markup.
const h = require('./helpers.cjs');

h.run(async () => {

	/** evidence screenshots in dark + light (only when EVIDENCE_DIR is set — the lane's runner sets it) */
	async function shots(/** @type {any} */ page, /** @type {string} */ name, /** @type {string} */ sel) {
		const dir = process.env.EVIDENCE_DIR;
		if (!dir) return;
		const before = await page.evaluate(() => {
			let v;
			window.__stores.themes.theme.subscribe((x) => (v = x))();
			return v;
		});
		for (const t of ['dark', 'light']) {
			await page.evaluate((x) => window.__stores.themes.theme.set(x), t);
			await page.waitForTimeout(300);
			await page.locator(sel).first().screenshot({ path: require('path').join(dir, `${name}-${t}.png`) }).catch((e) => console.log('screenshot failed: ' + e.message));
		}
		await page.evaluate((x) => window.__stores.themes.theme.set(x), before);
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const msgs = (/** @type {any} */ page) =>
		page.evaluate(() => {
			let v;
			window.__stores.messages.subscribe((x) => (v = x))();
			return v.filter((m) => m.type === 'sent' || m.type === 'received').map((m) => ({ id: m.id, text: m.text, type: m.type, sender: m.sender }));
		});
	const store = (/** @type {any} */ page, /** @type {string} */ name) =>
		page.evaluate((n) => {
			let v;
			window.__stores[n].subscribe((x) => (v = x))();
			return v;
		}, name);
	const say = (/** @type {any} */ page, /** @type {string} */ text) =>
		page.evaluate((t) => {
			let p;
			window.__stores.peers.subscribe((x) => (p = x))();
			p.sendMessage(t);
		}, text);

	// ---- 1. shortcodes expand on SEND, so every peer sees the emoji ---------------------
	await A.page.evaluate(() => window.__stores.chatHidden.set(''));
	await A.page.locator('#message').fill('hello :tad');
	await h.eventually(() => A.page.locator('#chat-suggestions .chat-suggestion').allTextContents(), (l) => l.some((t) => t.includes('🎉')), '1.1 typing :tad suggests 🎉');
	await A.page.keyboard.press('Tab');
	h.check((await A.page.locator('#message').inputValue()) === 'hello 🎉 ', `1.2 Tab takes the suggestion (${await A.page.locator('#message').inputValue()})`);
	await A.page.locator('#message').fill('nice :+1: and :nope:');
	await A.page.keyboard.press('Enter');
	await h.eventually(() => msgs(B.page), (l) => l.some((m) => m.text === 'nice 👍 and :nope:'), '1.3 B receives the emoji (unknown codes untouched)');

	// ---- 2. the unread badge while B's chat is closed ------------------------------------
	h.check((await store(B.page, 'chatHidden')) === 'hidden', 'premise: B has the chat closed');
	await h.eventually(() => B.page.locator('#chat-unread').textContent(), (t) => t?.trim() === '1', '2.1 B\'s chat button shows 1 unread');
	h.check(!(await B.page.locator('#chat-unread').evaluate((el) => el.classList.contains('mention'))), '2.2 a plain line is not a mention');

	// ---- 3. an @mention: coloured chip, highlight + mention badge for the mentioned -------
	await A.page.evaluate(() => window.__stores.chatHidden.set('hidden'));
	await say(B.page, `@${A.id} look at this`);
	await h.eventually(() => A.page.locator('#chat-unread.mention').count(), (n) => n === 1, '3.1 A\'s badge turns to the mention colour');
	await A.page.evaluate(() => window.__stores.chatHidden.set(''));
	h.check((await A.page.locator('#chat-unread').count()) === 0, '3.2 opening the chat reads it (badge gone)');
	const chip = await A.page.evaluate((id) => {
		const li = [...document.querySelectorAll('#messages li')].find((x) => x.textContent.includes('look at this'));
		const span = li?.querySelector('.chat-mention');
		return { text: span?.textContent, color: span ? getComputedStyle(span).borderBottomColor : null, ring: li?.classList.contains('chat-mentions-me'), want: (() => {
			// the peer colour as the browser computes it
			const probe = document.createElement('span');
			probe.style.color = window.__stores.lockControl.peerColor(id);
			document.body.append(probe);
			const c = getComputedStyle(probe).color;
			probe.remove();
			return c;
		})() };
	}, A.id);
	h.check(chip.text === '@' + A.id, `3.3 the mention is a chip (${chip.text})`);
	h.check(chip.ring === true, '3.4 the line that mentions A is highlighted on A');
	h.check(!!chip.color && chip.color === chip.want, `3.5 the chip is underlined in the peer colour (${chip.color} for ${chip.want})`);

	await shots(A.page, '20-chat-mentions', '#chat-window');
	await shots(B.page, '21-chat-unread-badge', '#chat-button');

	// ---- 4. a peer's string is text, never markup ----------------------------------------
	await say(B.page, '<b id="xss">bold</b><img src=x onerror="window.__xss=1">');
	await h.eventually(() => A.page.evaluate(() => [...document.querySelectorAll('#messages li')].some((x) => x.textContent.includes('<b id="xss">'))), (v) => v, '4.1 the tags arrive as visible text');
	h.check((await A.page.evaluate(() => !document.getElementById('xss') && !window.__xss)), '4.2 and nothing was parsed as HTML');

	// ---- 5. ids are distinct, the same on both sides -------------------------------------
	const aList = await msgs(A.page);
	const bList = await msgs(B.page);
	h.check(new Set(aList.map((m) => m.id)).size === aList.length, `5.1 every line has its own id (${aList.length})`);
	h.check(aList.map((m) => m.id).join() === bList.map((m) => m.id).join(), '5.2 and the same ids on both peers');

	// ---- 6. a late joiner gets the conversation so far -----------------------------------
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	await h.eventually(() => msgs(C.page), (l) => l.length === aList.length, `6.1 C holds the ${aList.length} lines said before it arrived`, 20000);
	const cList = await msgs(C.page);
	h.check(cList.map((m) => m.id).join() === aList.map((m) => m.id).join(), '6.2 in the same order, same ids');
	await C.page.waitForTimeout(1500); // B may answer too (a mesh fill): still no duplicates
	h.check((await msgs(C.page)).length === aList.length, '6.3 no duplicates when more than one peer answers');
	h.check((await C.page.locator('#chat-unread').count()) === 0, '6.4 history is the past, not news: no unread badge');

	// ---- 7. a saved session keeps the chat; an exported file does not --------------------
	const saved = await A.page.evaluate(async () => {
		const s = window.__stores.sessions;
		const payload = await s.saveSession('chat-r15');
		const zip = await s.exportSessionZip(payload);
		const back = await s.readSessionZip(zip);
		return { id: payload.id, chat: (payload.chat ?? []).length, exported: !!back && 'chat' in back };
	});
	h.check(saved.chat === aList.length, `7.1 the saved session carries the chat (${saved.chat})`);
	h.check(saved.exported === false, '7.2 the exported file does not');
	await A.page.evaluate(() => window.__stores.messages.set([]));
	await A.page.evaluate(async (id) => {
		const s = window.__stores.sessions;
		const payload = await s.getSession(id);
		await s.applySession(payload, { backup: false, replicate: false, workspace: false, quiet: true });
	}, saved.id);
	await h.eventually(() => msgs(A.page), (l) => l.length === aList.length, '7.3 loading the session brings the conversation back');

	await h.finish(browser);
});
