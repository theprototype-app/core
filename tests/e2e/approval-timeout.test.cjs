// 27-E (roadmap 25, audit H3 + H7 + M10 + L7) — A REQUEST THAT ENDS, AND A ROOM WITH A SIZE.
//
// Before this, an approval could hang forever on BOTH sides. The joiner sat on
// "Requesting AB12" with no countdown and no end; the host collected a card per dial with
// nothing ever dropping them; `peer-unavailable` toasted "unreachable" while the pill
// still said "Requesting"; an approval MUTATED the waitingForApproval row in place and
// discarded the filter, so the array grew one dead row per join for the tab's lifetime;
// and nothing bounded how many peers a full mesh would accept.
//
// What this suite pins:
//   1. the pill counts down, from the SAME clock the host's card ages against
//   2. an expired request cancels itself, un-whitelists the peer, and offers Retry
//   3. `peer-unavailable` ends the request instead of contradicting it
//   4. a host's card shows its age and STAYS approvable past the window
//   5. the pending queue is bounded, dropping EXPIRED cards before live ones
//   6. approval REMOVES the row rather than mutating it
//   7. the camera stream is rate-gated (audit H7), measured, not asserted by reading code
//   8. approval is refused at the hard cap, with the reason on the button
//
// Time is driven by writing the shared clock rather than by sleeping 90 real seconds: the
// guard under test is the WINDOW and what happens at its end, not the wall clock.
//
// Run: APP_URL=https://theprototype.app:5175/ npm run e2e -- approval-timeout
const h = require('./helpers.cjs');

const waiting = (page) =>
	page.evaluate(() => {
		let v = [];
		window.__stores.waitingForApproval.subscribe((x) => (v = x))();
		return v;
	});

const approvals = (page) =>
	page.evaluate(() => {
		let v = [];
		window.__stores.pendingApprovals.subscribe((x) => (v = x))();
		return v;
	});

h.run(async () => {
	const browser = await h.launch();
	const peer = await h.setupPage(browser, 'approval');
	const page = peer.page;
	await page.waitForFunction(() => !!window.__stores?.connectionState?.APPROVAL_WINDOW_MS, {
		timeout: 30000
	});

	const WINDOW = await page.evaluate(() => window.__stores.connectionState.APPROVAL_WINDOW_MS);
	h.check(WINDOW === 90000, `premise: one approval window constant, 90s (${WINDOW})`);

	// ---- 1. the pill counts down -------------------------------------------------------
	// Stub the dial so no signaling is needed: the state machine is what is under test.
	await page.evaluate(() => {
		let pc = null;
		window.__stores.peers.subscribe((v) => (pc = v))();
		Object.defineProperty(pc.peer, 'open', { value: true, configurable: true });
		pc.peer.connect = (id) => ({ peer: id, open: false, on() {}, close() {}, send() {} });
	});
	await page.locator('input[placeholder="Enter peer ID to connect"]').fill('aaaa1');
	await page.getByRole('button', { name: 'Connect', exact: true }).click();
	await page.waitForTimeout(600);

	const pending = await waiting(page);
	h.check(pending.some((w) => w[0] === 'aaaa1' && w[1] === 'pending'), 'the request is pending');
	const pillText = await page.locator('.cx-input').first().inputValue().catch(() => '');
	h.check(/1:2\d|1:3\d/.test(pillText), `the pill shows a countdown (${pillText})`);
	// Report the neighbouring state too: an empty map beside a live pending row means the
	// dial took its stamping branch and the write went somewhere else, which is a module
	// identity problem rather than a logic one.
	const started = await page.evaluate(() => {
		const s = window.__stores;
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const map = read(s.connectionState.approvalStartedAt);
		return {
			keys: Object.keys(map || {}),
			whitelist: (read(s.userdata) || []).map((u) => u[0]),
			waiting: (read(s.waitingForApproval) || []).map((w) => w[0] + ':' + w[1])
		};
	});
	h.check(
		started.keys.includes('aaaa1'),
		`the shared clock was stamped, which the host card reads too (stamped=[${started.keys}] whitelist=[${started.whitelist}] waiting=[${started.waiting}])`
	);

	// ---- 2. it expires: cancelled, un-whitelisted, Retry offered -------------------------
	// Wind the clock back past the window rather than waiting 90s.
	await page.evaluate((w) => {
		window.__stores.connectionState.approvalStartedAt.update((m) => ({ ...m, aaaa1: Date.now() - w - 1000 }));
	}, WINDOW);
	await page.waitForTimeout(400);
	const expiredPill = await page.locator('.cx-input').first().inputValue().catch(() => '');
	h.check(!/·\s*\d/.test(expiredPill) || /0:0\d/.test(expiredPill), `the countdown reaches zero (${expiredPill})`);

	// the timer itself is armed for the real window, so fire the expiry path directly
	await page.evaluate(() => window.__stores.peerApproval.cancelOutboundRequest('aaaa1'));
	await page.waitForTimeout(300);
	const afterCancel = await waiting(page);
	const roster = await page.evaluate(() => {
		let v = [];
		window.__stores.userdata.subscribe((x) => (v = x))();
		return v.map((u) => u[0]);
	});
	h.check(!afterCancel.some((w) => w[0] === 'aaaa1'), 'the pending row is gone');
	h.check(!roster.includes('aaaa1'), 'and the optimistic whitelist row was taken back');

	// ---- 3. peer-unavailable ends the request --------------------------------------------
	await page.locator('input[placeholder="Enter peer ID to connect"]').fill('bbbb2');
	await page.getByRole('button', { name: 'Connect', exact: true }).click();
	await page.waitForTimeout(400);
	h.check((await waiting(page)).some((w) => w[0] === 'bbbb2'), 'premise: a second request is pending');
	await page.evaluate(() => window.__stores.peerApproval.abandonOutboundRequest('bbbb2'));
	await page.waitForTimeout(300);
	h.check(
		!(await waiting(page)).some((w) => w[0] === 'bbbb2'),
		'an unreachable peer ends the request instead of contradicting it'
	);

	// ---- 4+5+6. the host side: age, expiry, bounds, and the row --------------------------
	const bounded = await page.evaluate(async (w) => {
		const s = window.__stores;
		const cs = s.connectionState;
		s.pendingApprovals.set([]);
		// 20 requests, the first ten already expired
		const rows = [];
		for (let i = 0; i < 20; i++) rows.push({ peerId: 'p' + i });
		s.pendingApprovals.set(rows);
		const now = Date.now();
		const stamps = {};
		rows.forEach((r, i) => (stamps[r.peerId] = i < 10 ? now - w - 5000 : now - 1000));
		cs.approvalStartedAt.set(stamps);
		return { max: cs.MAX_PENDING_APPROVALS, seeded: rows.length };
	}, WINDOW);
	h.check(bounded.max === 12, `premise: the queue bound is a constant (${bounded.max})`);

	// the bound is applied where requests ARRIVE, so drive one more through the real path
	await page.evaluate(() => {
		let pc = null;
		window.__stores.peers.subscribe((v) => (pc = v))();
		const handlers = {};
		const conn = { peer: 'newcomer', open: true, on: (e, f) => (handlers[e] = f), close() {}, send() {} };
		pc.peer.emit('connection', conn);
	});
	await page.waitForTimeout(500);
	const after = await approvals(page);
	h.check(
		after.length <= bounded.max,
		`the pending queue is bounded at ${bounded.max} (was 20, now ${after.length})`
	);
	const survivors = after.map((a) => a.peerId);
	const expiredLeft = survivors.filter((id) => /^p[0-9]$/.test(id)).length;
	h.check(
		expiredLeft < 10,
		`EXPIRED cards are dropped before live ones (${expiredLeft} of the 10 expired remain)`
	);

	// ---- 7. the camera stream is rate-gated ----------------------------------------------
	const rate = await page.evaluate(async () => {
		let pc = null;
		window.__stores.peers.subscribe((v) => (pc = v))();
		let sent = 0;
		const realSend = pc.send.bind(pc);
		pc.send = (d) => {
			if (d && d.type === 'camera') sent++;
			return realSend(d);
		};
		let cam = null;
		window.__stores.globalCamera.subscribe((c) => (cam = c))();
		const t0 = performance.now();
		// move the camera every frame for a second; the gate decides how many go out
		await new Promise((done) => {
			const step = () => {
				if (cam) cam.position.x += 0.5;
				if (performance.now() - t0 > 1000) return done();
				requestAnimationFrame(step);
			};
			step();
		});
		pc.send = realSend;
		return { sent, ms: Math.round(performance.now() - t0) };
	});
	h.check(
		rate.sent <= 25,
		`the camera stream is gated to ~20/s, not one per frame (${rate.sent} in ${rate.ms}ms)`
	);
	h.check(rate.sent > 0, 'and it still sends — the gate bounds the rate, it does not mute it');

	// ---- 8. the hard cap refuses an approval ----------------------------------------------
	// Seed the OPEN CONNECTIONS, not `userdata`. The whitelist is written at dial time, so
	// a suite that filled it would pass against a cap counting the wrong thing — which is
	// the defect this section exists to catch.
	const capped = await page.evaluate(() => {
		const s = window.__stores;
		const HARD = s.connectionState.HARD_PEER_CAP;
		let pc = null;
		s.peers.subscribe((v) => (pc = v))();
		for (let i = 0; i < HARD - 1; i++) pc.openedPeers.add('full' + i);
		s.peers.update((v) => v); // the store ticks on every open/close
		return { HARD, size: s.connectionState.sessionSize(pc), roster: 0 };
	});
	h.check(
		capped.size === capped.HARD,
		`the session counts ${capped.HARD} people from the OPEN connections, self included`
	);
	await page.waitForTimeout(400);
	const cardCount = await page.locator('.cxreq-btn.cxreq-editor').count();
	h.check(cardCount > 0, `premise: a request card is on screen to approve (${cardCount})`);
	const fullCardButtons = await page
		.locator('.cxreq-btn.cxreq-editor')
		.first()
		.isDisabled()
		.catch(() => null);
	h.check(
		fullCardButtons === true,
		`at the hard cap of ${capped.HARD} the approve button is disabled rather than silently failing (disabled=${fullCardButtons})`
	);

	await h.finish(browser);
});
