// 27-F (hardening audit H2) — THE SIGNALING LINK NEVER GIVES UP.
//
// It used to stop after five attempts (~20s) and toast "Please reload the page". A
// reload is the worst available answer: it drops every live DataConnection AND the
// invite id, while the thing that failed is usually a lid closing, a phone locking or
// a wifi hop. Worse, a peer whose link CLOSED was a dead end in a second way —
// `reconnect()` cannot revive a spent Peer object, and nothing ever rebuilt one.
//
// What this suite pins:
//   1. the first drop arms the chip and toasts ONCE (a chip is a state you can look at;
//      an unbounded retry that toasts per attempt is spam)
//   2. attempt 7 is still retrying, and nothing ever says "reload"
//   3. `open` clears the chip and says so once — only to somebody who saw it go away
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
	h.check(
		(await page.locator('#connect-retry-chip').count()) === 0,
		'no retry chip while the link is up'
	);

	// ---- 1. the first drop: chip on, ONE toast ---------------------------------------
	await emitOnPeer(page, 'disconnected');
	await page.waitForTimeout(400);
	const first = await readRetry(page);
	h.check(first?.retrying === true && first.attempt === 1, `the chip arms on the first drop (${JSON.stringify(first)})`);
	h.check(
		await page.locator('#connect-retry-chip').isVisible().catch(() => false),
		'the Connect pill shows a Reconnecting chip'
	);
	const afterFirst = await toastTexts(page);
	h.check(
		afterFirst.filter((t) => /Lost the peer server/i.test(t)).length === 1,
		'exactly one toast on the way in'
	);

	// ---- 2. it never gives up ---------------------------------------------------------
	for (let i = 0; i < 6; i++) {
		await emitOnPeer(page, 'disconnected');
		await page.waitForTimeout(120);
	}
	const many = await readRetry(page);
	h.check(many?.retrying === true && many.attempt === 7, `attempt 7 is still retrying (${JSON.stringify(many)})`);
	const afterMany = await toastTexts(page);
	h.check(
		afterMany.filter((t) => /Lost the peer server/i.test(t)).length === 1,
		'…and it still said it only once — the chip carries the live state'
	);
	h.check(
		!afterMany.some((t) => /reload/i.test(t)),
		'nothing tells the user to reload (a reload drops every live peer and the invite id)'
	);

	// ---- 3. recovery says so, once ----------------------------------------------------
	await emitOnPeer(page, 'open');
	await page.waitForTimeout(400);
	const healed = await readRetry(page);
	h.check(healed?.retrying === false && healed.attempt === 0, 'the chip clears when the link comes back');
	h.check(
		(await page.locator('#connect-retry-chip').count()) === 0,
		'…and the chip leaves the pill'
	);
	const afterOpen = await toastTexts(page);
	h.check(
		afterOpen.filter((t) => /Reconnected to the peer server/i.test(t)).length === 1,
		'one "Reconnected" toast, said only to somebody who saw it go away'
	);

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

	await h.finish(browser);
});
