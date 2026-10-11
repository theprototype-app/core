// 27-F (hardening audit H2) — THE SIGNALING LINK NEVER GIVES UP.
//
// It used to stop after five attempts (~20s) and toast "Please reload the page". A
// reload is the worst available answer: it drops every live DataConnection AND the
// invite id, while the thing that failed is usually a lid closing, a phone locking or
// a wifi hop. Worse, a peer whose link CLOSED was a dead end in a second way —
// `reconnect()` cannot revive a spent Peer object, and nothing ever rebuilt one.
//
// What this suite pins:
//   1. the first drop turns the Connect dot yellow and says NOTHING out loud (41 G21: a phone tab
//      switch drops the socket, and it used to toast three times — the dot is the state)
//   2. attempt 7 is still retrying, the dot is red, and ONE notification-centre entry (no toast)
//      says the server cannot be reached; nothing ever says "reload"
//   3. `open` turns the dot back, again with no toast
//   4. a CLOSED peer is REBUILT, on the same id, so the invite link still works
//   5. `online` and `visibilitychange` retry NOW and reset the schedule
//
// Events are driven on the peer itself (peerjs extends eventemitter3, so `emit` is
// available) — the alternative is unplugging a network in a headless browser.
//
// Run: APP_URL=https://theprototype.app:5175/ npm run e2e -- signaling-reconnect
const h = require('./helpers.cjs');

const readRetry = (page) =>
	page.evaluate(() => {
		let v = null;
		window.__stores.connectionState.signalingRetry.subscribe((x) => (v = x))();
		return v;
	});

const toastTexts = (page) =>
	page.evaluate(() => {
		let list = [];
		window.__stores.toastStore.subscribe((v) => (list = v))();
		return list.map((t) => (typeof t === 'string' ? t : (t && (t.text || t.message)) || ''));
	});

const dot = (page) =>
	page.evaluate(() => {
		const d = document.querySelector('#connect-status');
		return d ? { tone: d.getAttribute('data-tone'), words: d.getAttribute('aria-label') } : null;
	});
const notes = (page) =>
	page.evaluate(() => {
		let list = [];
		window.__stores.notifications.subscribe((v) => (list = v))();
		return list.map((n) => n.text);
	});

const emitOnPeer = (page, event) =>
	page.evaluate((name) => {
		let pc = null;
		window.__stores.peers.subscribe((v) => (pc = v))();
		pc.peer.emit(name, pc.peer.id);
	}, event);

h.run(async () => {
	const browser = await h.launch();
	const peer = await h.setupPage(browser, 'signaling');
	const page = peer.page;
	await page.waitForFunction(() => !!window.__stores?.connectionState?.signalingRetry, { timeout: 30000 });

	// ---- 0. premise -----------------------------------------------------------------
	const premise = await page.evaluate(() => {
		let pc = null;
		window.__stores.peers.subscribe((v) => (pc = v))();
		return { open: !!pc?.peer?.open, id: pc?.peer?.id ?? '' };
	});
	h.check(premise.open && !!premise.id, `premise: the signaling link is open (${premise.id})`);
	const up = await dot(page);
	h.check(up?.tone === 'idle', `the status dot is grey while the link is up and nobody is connected (${JSON.stringify(up)})`);
	const textless = await page.evaluate(() => {
		const chip = document.querySelector('#ps-connect-chip, .cx-chip');
		return chip ? (chip.textContent || '').trim() : '';
	});
	h.check(textless === '', `the pill carries no text, its words are the tooltip ("${textless}")`);

	// ---- 1. the first drop: chip on, ONE toast ---------------------------------------
	await emitOnPeer(page, 'disconnected');
	await page.waitForTimeout(400);
	const first = await readRetry(page);
	h.check(first?.retrying === true && first.attempt === 1, `the retry state arms on the first drop (${JSON.stringify(first)})`);
	const yellow = await dot(page);
	h.check(yellow?.tone === 'connecting' && /Reconnecting/.test(yellow.words), `the dot turns yellow and its words say so (${JSON.stringify(yellow)})`);
	const afterFirst = await toastTexts(page);
	h.check(
		!afterFirst.some((t) => /peer server|reconnect/i.test(t)),
		`no toast on the way in (${JSON.stringify(afterFirst)})`
	);

	// ---- 2. it never gives up ---------------------------------------------------------
	for (let i = 0; i < 6; i++) {
		await emitOnPeer(page, 'disconnected');
		await page.waitForTimeout(120);
	}
	const many = await readRetry(page);
	h.check(many?.retrying === true && many.attempt === 7, `attempt 7 is still retrying (${JSON.stringify(many)})`);
	const afterMany = await toastTexts(page);
	h.check(!afterMany.some((t) => /peer server|reconnect/i.test(t)), '…and still no toast — the dot carries the live state');
	const red = await dot(page);
	h.check(red?.tone === 'failed', `past the give-up threshold the dot is red (${JSON.stringify(red)})`);
	const failNotes = (await notes(page)).filter((t) => /Can't reach the peer server/.test(t));
	h.check(failNotes.length === 1, `ONE notification-centre entry says it (${failNotes.length})`);
	h.check(
		!afterMany.some((t) => /reload/i.test(t)),
		'nothing tells the user to reload (a reload drops every live peer and the invite id)'
	);

	// ---- 3. recovery says so, once ----------------------------------------------------
	await emitOnPeer(page, 'open');
	await page.waitForTimeout(400);
	const healed = await readRetry(page);
	h.check(healed?.retrying === false && healed.attempt === 0, 'the retry state clears when the link comes back');
	const back = await dot(page);
	h.check(back?.tone === 'idle', `…and the dot turns back (${JSON.stringify(back)})`);
	const afterOpen = await toastTexts(page);
	h.check(!afterOpen.some((t) => /Reconnected/i.test(t)), 'no "Reconnected" toast either');
	h.check((await notes(page)).filter((t) => /Can't reach the peer server/.test(t)).length === 1, 'the outage left exactly one notification');

	// ---- 4. a CLOSED peer is rebuilt, on the same id -----------------------------------
	const beforeClose = await page.evaluate(() => {
		let pc = null;
		window.__stores.peers.subscribe((v) => (pc = v))();
		window.__sigOld = pc.peer;
		// A real `close` leaves the peer NOT open, and the rebuild is guarded on exactly
		// that — so a synthetic event on a live socket must say so, or the guard correctly
		// skips and the two checks below pass against the object they were meant to replace.
		Object.defineProperty(pc.peer, 'open', { get: () => false, configurable: true });
		return pc.peer.id;
	});
	await emitOnPeer(page, 'close');
	// attempt 1 of the signaling schedule is 800ms +/-25%
	await page.waitForTimeout(2500);
	const rebuilt = await page.evaluate(() => {
		let pc = null;
		window.__stores.peers.subscribe((v) => (pc = v))();
		return { fresh: pc.peer !== window.__sigOld, id: pc.peer?.id ?? '', open: !!pc.peer?.open };
	});
	h.check(rebuilt.fresh, 'a closed peer is REBUILT rather than mourned (a new Peer object)');
	h.check(
		rebuilt.id === beforeClose,
		`the rebuilt peer keeps the same id, so the invite link still works (${rebuilt.id})`
	);
	const reopened = await page
		.waitForFunction(
			() => {
				let pc = null;
				window.__stores.peers.subscribe((v) => (pc = v))();
				return !!pc?.peer?.open;
			},
			{ timeout: 20000 }
		)
		.then(() => true)
		.catch(() => false);
	h.check(reopened, 'the rebuilt link opens against the real signaling server');

	// ---- 5. online / visibilitychange retry NOW and reset the schedule ------------------
	// The peer is genuinely open here, and `retryNow` correctly does nothing for an open
	// link — so shadow the three flags it reads to stage a down link, then restore them.
	await page.evaluate(() => {
		let pc = null;
		window.__stores.peers.subscribe((v) => (pc = v))();
		const p = pc.peer;
		window.__sig = { calls: 0, pc };
		Object.defineProperty(p, 'open', { get: () => false, configurable: true });
		Object.defineProperty(p, 'disconnected', { get: () => true, configurable: true });
		Object.defineProperty(p, 'destroyed', { get: () => false, configurable: true });
		p.reconnect = () => window.__sig.calls++;
		pc.reconnectAttempts = 5;
	});
	const onOnline = await page.evaluate(() => {
		const pc = window.__sig.pc;
		const p = pc.peer; // whatever the app holds NOW, not what was stubbed at setup
		Object.defineProperty(p, 'open', { get: () => false, configurable: true });
		Object.defineProperty(p, 'disconnected', { get: () => true, configurable: true });
		Object.defineProperty(p, 'destroyed', { get: () => false, configurable: true });
		let calls = 0;
		p.reconnect = () => calls++;
		pc.reconnectAttempts = 5;
		window.dispatchEvent(new Event('online')); // listeners run synchronously
		return { calls, attempts: pc.reconnectAttempts };
	});
	h.check(onOnline.calls === 1, 'an `online` event retries immediately instead of waiting out the backoff');
	h.check(
		onOnline.attempts === 0,
		'…and RESETS the schedule (the wait is for a server that is down, not a link that just came back)'
	);

	const onVisible = await page.evaluate(() => {
		const pc = window.__sig.pc;
		const p = pc.peer;
		Object.defineProperty(p, 'open', { get: () => false, configurable: true });
		Object.defineProperty(p, 'disconnected', { get: () => true, configurable: true });
		Object.defineProperty(p, 'destroyed', { get: () => false, configurable: true });
		let calls = 0;
		p.reconnect = () => calls++;
		document.dispatchEvent(new Event('visibilitychange'));
		return { calls, hidden: document.hidden };
	});
	h.check(
		onVisible.calls === 1,
		`a tab becoming visible retries too, a lid or a phone lock ends here (${onVisible.calls} retries, document.hidden=${onVisible.hidden})`
	);

	await page.evaluate(() => {
		const p = window.__sig.pc.peer;
		delete p.open;
		delete p.disconnected;
		delete p.destroyed;
	});

	// ---- 6. 41 G21: the PHONE chip (reconnect.jpg / space-connect-svelte.jpg) -----------------
	// Oppo N6 folded: the chip is a dot + chevron and NO text; a tab switch (the socket drops and
	// comes back) raises no toast at all.
	const P = await h.setupPage(browser, 'phone', {
		context: { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true }
	});
	const phone = P.page;
	await phone.waitForSelector('#ps-connect-chip', { timeout: 30000 });
	const chip = await phone.evaluate(() => {
		const c = document.querySelector('#ps-connect-chip');
		const d = c?.querySelector('.cx-status-dot');
		return {
			text: (c?.textContent || '').trim(),
			label: c?.getAttribute('aria-label') ?? '',
			title: c?.getAttribute('title') ?? '',
			tone: d?.getAttribute('data-tone') ?? '',
			width: Math.round(c?.getBoundingClientRect().width ?? 0)
		};
	});
	h.check(chip.text === '', `phone: the Connect chip carries no text ("${chip.text}")`);
	h.check(/Not connected|Connecting/.test(chip.label) && chip.title.length > 0, `phone: its words are the aria-label and tooltip ("${chip.label}")`);
	h.check(chip.width <= 72, `phone: the chip is a dot + chevron wide (${chip.width}px)`);
	await emitOnPeer(phone, 'disconnected');
	await phone.waitForTimeout(300);
	const phoneDrop = await phone.evaluate(() => document.querySelector('#ps-connect-chip .cx-status-dot')?.getAttribute('data-tone'));
	h.check(phoneDrop === 'connecting', `phone: a dropped socket turns the dot yellow (${phoneDrop})`);
	await emitOnPeer(phone, 'open');
	await phone.waitForTimeout(300);
	const phoneToasts = await toastTexts(phone);
	h.check(!phoneToasts.some((t) => /peer server|reconnect/i.test(t)), `phone: the drop and the return raised no toast (${JSON.stringify(phoneToasts)})`);

	await h.finish(browser);
});
