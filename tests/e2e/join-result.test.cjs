// 25-F (roadmap 25 section 2c) — A REAL "NO", AND A FULL ROOM THAT SAYS SO.
//
// An incoming connection from the host WAS the approval signal, and a refusal had no
// channel at all: the host closes a stranger's conn before it opens. So Reject left the
// joiner on "Requesting" for the whole 90 s window and then told it the host "did not
// answer", and a full session said exactly the same thing.
//
// The answer now rides the METADATA of a short dial from the host (arriving through
// signaling, no ICE needed), gated on the joiner having advertised `jr` — an older joiner
// would read ANY incoming conn from the host as an approval.
//
// What this suite pins:
//   1-5  the JOINER: denied and full end the request and are told apart (toast + chip);
//        an older host's plain dial-back is still an approval; a refusal nobody is
//        waiting for is ignored; the `joinresult` MESSAGE carries the same answer
//   6    `joinresult` is on the capability floor
//   7-10 the HOST: Reject tells a joiner that can hear it and stays silent to one that
//        cannot; at the cap the card offers "Tell them it's full"; an approval dial-back
//        says it is one, in its metadata AND as the first handshake message
//   11   two real peers over signaling: declined, then full
//
// Run: APP_URL=https://theprototype.app:5175/ PEER_CONFIG=... npm run e2e -- join-result
const h = require('./helpers.cjs');

/** run a snippet with `s = window.__stores` and `pc` (the PeerConnection) in scope */
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
const notes = (peer) => inPage(peer, 'let v = []; s.notifications.subscribe((x) => (v = x))(); return v.map((n) => String(n.text));');

/** an incoming conn as peerjs hands it to the `connection` event */
const EMIT = `
	const fake = { peer: arg.peer, metadata: arg.metadata, open: false, closed: false, handlers: {},
		on(ev, fn) { this.handlers[ev] = fn; }, close() { this.closed = true; }, send() {} };
	window.__lastFake = fake;
	pc.peer.emit('connection', fake);
	return { closed: fake.closed, wired: Object.keys(fake.handlers) };`;

/** dial through the real pill, against a stubbed peer.connect that records every call */
const DIAL_STUB = `
	window.__dials = [];
	Object.defineProperty(pc.peer, 'open', { value: true, configurable: true });
	pc.peer.connect = (id, opts) => {
		const conn = { peer: id, open: false, sent: [], handlers: {}, on(ev, fn) { (this.handlers[ev] ??= []).push(fn); }, close() { this.closed = true; }, send(m) { this.sent.push(m); } };
		window.__dials.push({ id, opts: JSON.parse(JSON.stringify(opts ?? null)), conn });
		return conn;
	};`;

/** element reads that answer null instead of throwing, so one missing element is one red
 * check rather than the end of the suite */
const attr = (loc, name) => loc.getAttribute(name, { timeout: 3000 }).catch(() => null);
const text = (loc) => loc.textContent({ timeout: 3000 }).catch(() => '');
const click = (loc, timeout = 5000) => loc.click({ timeout }).then(() => true, () => false);

async function dialVia(peer, id) {
	await peer.page.locator('input[placeholder="Enter peer ID to connect"]').fill(id);
	await peer.page.getByRole('button', { name: 'Connect', exact: true }).click();
	await peer.page.waitForTimeout(400);
}

h.run(async () => {
	const browser = await h.launch();
	const J = await h.setupPage(browser, 'joiner');
	await J.page.waitForFunction(() => !!window.__stores?.connectionState?.isRefusal, { timeout: 30000 });
	await inPage(J, DIAL_STUB);

	// ---- 1. declined -----------------------------------------------------------------
	console.log('\n=== 1. declined ===');
	await dialVia(J, 'aaaa1');
	const dial = await inPage(J, 'return window.__dials.map((d) => ({ id: d.id, opts: d.opts }))');
	h.check(dial.some((d) => d.id === 'aaaa1' && d.opts?.metadata?.jr === 1), `the joiner's dial says it can hear a join result (${JSON.stringify(dial)})`);
	h.check((await read(J, 'waitingForApproval')).some((w) => w[0] === 'aaaa1'), 'premise: the request is pending');
	const refused = await inPage(J, EMIT, { peer: 'aaaa1', metadata: { joinresult: 'denied' } });
	h.check(refused.closed && refused.wired.length === 0, `the refusal dial is closed at once and never wired (${JSON.stringify(refused)})`);
	h.check(!(await read(J, 'waitingForApproval')).some((w) => w[0] === 'aaaa1'), 'the request is over — no pending row');
	h.check(!(await read(J, 'userdata')).some((u) => u[0] === 'aaaa1'), 'the optimistic whitelist row is taken back');
	h.check((await read(J, 'connectionState.sessionHost')) === null, 'a refusal is NOT an approval: no session host');
	const r1 = await read(J, 'connectionState.joinRefusal');
	h.check(r1?.peerId === 'aaaa1' && r1?.result === 'denied', `the refusal is recorded as denied (${JSON.stringify(r1)})`);
	h.check((await notes(J)).some((t) => t.includes('AAAA1 declined your connection request')), 'the joiner is TOLD it was declined');
	h.check(!(await notes(J)).some((t) => /AAAA1 has approved/.test(t)), '…and never told it was approved');
	const chip1 = J.page.locator('#connect-refusal-chip');
	await chip1.waitFor({ timeout: 5000 }).catch(() => {});
	h.check((await chip1.count()) === 1 && /AAAA1 declined/.test(await text(chip1)) && (await attr(chip1, 'data-result')) === 'denied', 'the pill shows "declined" beside the idle input');

	// ---- 2. full ---------------------------------------------------------------------
	console.log('\n=== 2. full ===');
	await dialVia(J, 'bbbb1');
	h.check((await J.page.locator('#connect-refusal-chip').count()) === 0, 'a new dial clears the last answer from the pill');
	await inPage(J, EMIT, { peer: 'bbbb1', metadata: { jr: 1, joinresult: 'full' } });
	const r2 = await read(J, 'connectionState.joinRefusal');
	h.check(r2?.result === 'full', `a full room is recorded as FULL, not denied (${r2?.result})`);
	h.check((await notes(J)).some((t) => /BBBB1's session is full \(16 people\)/.test(t)), 'the toast says the session is full, with its size');
	const chip2 = J.page.locator('#connect-refusal-chip');
	h.check((await attr(chip2, 'data-result')) === 'full' && /session is full \(16\)/.test(await text(chip2)), 'the chip says full, told apart from declined');
	await click(chip2);
	h.check((await J.page.locator('#connect-refusal-chip').count()) === 0 && (await read(J, 'connectionState.joinRefusal')) === null, 'the chip dismisses');

	// ---- 3. an older host ------------------------------------------------------------
	console.log('\n=== 3. an older host (no result on its dial-back) ===');
	await dialVia(J, 'cccc1');
	const plain = await inPage(J, EMIT, { peer: 'cccc1', metadata: undefined });
	h.check(!plain.closed, 'a plain dial-back is not closed');
	h.check((await read(J, 'connectionState.sessionHost')) === 'cccc1', 'a plain dial-back from the host is still the approval');
	h.check((await read(J, 'connectionState.joinRefusal')) === null, '…and records no refusal');
	await inPage(J, 's.connectionState.resetSession(); s.userdata.set([]); s.waitingForApproval.set([]);');

	// ---- 4. nobody is waiting ----------------------------------------------------------
	console.log('\n=== 4. a refusal nobody is waiting for ===');
	const before = (await notes(J)).length;
	const stray = await inPage(J, EMIT, { peer: 'zzzz1', metadata: { joinresult: 'denied' } });
	h.check(stray.closed, 'a stray refusal dial is closed');
	h.check((await notes(J)).length === before && (await read(J, 'connectionState.joinRefusal')) === null, 'and tells nobody anything — there was no request to end');

	// ---- 5. the message --------------------------------------------------------------
	console.log('\n=== 5. the joinresult MESSAGE ===');
	await dialVia(J, 'dddd1');
	await inPage(J, `
		const fake = { peer: 'dddd1', open: true, handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, close() {}, send() {} };
		pc.wireData(fake);
		fake.handlers.data({ type: 'joinresult', result: 'denied' });`);
	const r5 = await read(J, 'connectionState.joinRefusal');
	h.check(r5?.peerId === 'dddd1' && r5?.result === 'denied', `a joinresult message ends the request the same way (${JSON.stringify(r5)})`);

	// ---- 6. the floor ------------------------------------------------------------------
	const floor = await inPage(J, 's.cloudHooks.setCapabilityProvider(() => false); const r = { jr: s.cloudHooks.canApply("x", "joinresult"), other: s.cloudHooks.canApply("x", "environment") }; s.cloudHooks.setCapabilityProvider(null); return r');
	h.check(floor.jr && !floor.other, `joinresult sits on the ALWAYS_ALLOWED floor (${JSON.stringify(floor)})`);
	await J.ctx.close();

	// ---- 7. host: Reject tells them -----------------------------------------------------
	console.log('\n=== 7. host: Reject ===');
	const H = await h.setupPage(browser, 'host');
	await H.page.waitForFunction(() => !!window.__stores?.connectionState?.isRefusal, { timeout: 30000 });
	await inPage(H, DIAL_STUB);
	await inPage(H, EMIT, { peer: 'eeee1', metadata: { jr: 1 } });
	const cards = await read(H, 'pendingApprovals');
	h.check(cards.some((c) => c.peerId === 'eeee1' && c.hearsNo === true), `the card remembers the dial can hear a refusal (${JSON.stringify(cards)})`);
	const card = H.page.locator('.tp-toast--req', { hasText: 'EEEE1' });
	await click(card.locator('.cxreq-reject'));
	await H.page.waitForTimeout(300);
	const dials7 = await inPage(H, 'return window.__dials.map((d) => ({ id: d.id, opts: d.opts }))');
	h.check(dials7.some((d) => d.id === 'eeee1' && d.opts?.metadata?.joinresult === 'denied'), `Reject dials back with joinresult: denied (${JSON.stringify(dials7)})`);
	h.check(!(await read(H, 'pendingApprovals')).some((c) => c.peerId === 'eeee1'), 'the card is gone');
	h.check(!(await inPage(H, 'return Object.keys(pc.connections)')).includes('eeee1'), 'the refusal dial never joins the mesh');

	// ---- 8. host: an older joiner hears nothing ------------------------------------------
	console.log('\n=== 8. host: an older joiner ===');
	await inPage(H, EMIT, { peer: 'ffff1', metadata: undefined });
	h.check((await read(H, 'pendingApprovals')).some((c) => c.peerId === 'ffff1' && c.hearsNo === false), 'a dial without jr makes a card that cannot hear a refusal');
	await click(H.page.locator('.tp-toast--req', { hasText: 'FFFF1' }).locator('.cxreq-reject'));
	await H.page.waitForTimeout(300);
	const dials8 = await inPage(H, 'return window.__dials.filter((d) => d.id === "ffff1").length');
	h.check(dials8 === 0, `an older joiner is NOT dialled — it would read the refusal as an approval (${dials8} dials)`);

	// ---- 9. host: full -------------------------------------------------------------------
	console.log('\n=== 9. host: the cap ===');
	await inPage(H, EMIT, { peer: 'gggg1', metadata: { jr: 1 } });
	await inPage(H, 'window.__realOpened = pc.openedPeers; pc.openedPeers = new Set(Array.from({ length: 15 }, (_, i) => "fake" + i)); s.peers.update((v) => v);');
	const gcard = H.page.locator('.tp-toast--req', { hasText: 'GGGG1' });
	const fullBtn = gcard.locator('.cxreq-full');
	await fullBtn.waitFor({ timeout: 5000 }).catch(() => {});
	h.check((await fullBtn.count()) === 1, 'at the cap the card offers "Tell them it\'s full"');
	h.check(await gcard.locator('button', { hasText: 'Approve' }).isDisabled({ timeout: 3000 }).catch(() => false), 'and Approve stays disabled (27-E)');
	await click(fullBtn);
	await H.page.waitForTimeout(300);
	const dials9 = await inPage(H, 'return window.__dials.filter((d) => d.id === "gggg1").map((d) => d.opts)');
	h.check(dials9.some((o) => o?.metadata?.joinresult === 'full'), `…which dials back with joinresult: full (${JSON.stringify(dials9)})`);
	// the VR panel's yes goes through peerApproval.approvePeer, which used to approve past the cap
	await inPage(H, EMIT, { peer: 'gggg2', metadata: { jr: 1 } });
	await inPage(H, 's.peerApproval.approvePeer("gggg2")');
	const dials9b = await inPage(H, 'return window.__dials.filter((d) => d.id === "gggg2").map((d) => d.opts)');
	h.check(dials9b.length === 1 && dials9b[0]?.metadata?.joinresult === 'full', `the shared approve refuses past the cap and says full (${JSON.stringify(dials9b)})`);
	await inPage(H, 'pc.openedPeers = window.__realOpened; s.peers.update((v) => v);');

	// ---- 10. host: approval says so -------------------------------------------------------
	console.log('\n=== 10. host: an approval says it is one ===');
	await inPage(H, EMIT, { peer: 'hhhh1', metadata: { jr: 1 } });
	await click(H.page.locator('.tp-toast--req', { hasText: 'HHHH1' }).getByRole('button', { name: 'Approve' }));
	await H.page.waitForTimeout(300);
	const first = await inPage(H, `
		const d = window.__dials.find((x) => x.id === 'hhhh1');
		if (!d) return null;
		d.conn.open = true;
		try { for (const fn of d.conn.handlers.open ?? []) fn(); } catch (e) { return { opts: d.opts, error: String(e), sent: d.conn.sent.map((m) => m?.type) }; }
		return { opts: d.opts, sent: d.conn.sent.map((m) => ({ type: m?.type, result: m?.result })) };`);
	console.log('  ' + JSON.stringify(first));
	h.check(first?.opts?.metadata?.joinresult === 'approved', 'the approve dial-back carries joinresult: approved in its metadata');
	h.check(first?.sent?.[0]?.type === 'joinresult' && first?.sent?.[0]?.result === 'approved', 'and its handshake OPENS with the joinresult message');
	await H.ctx.close();

	// ---- 11. two real peers -----------------------------------------------------------------
	console.log('\n=== 11. two real peers ===');
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await dialVia(B, A.id);
	const acard = A.page.locator('.tp-toast--req', { hasText: String(B.id).slice(0, 6).toUpperCase() });
	h.check(await click(acard.locator('.cxreq-reject'), 30000), "premise: A gets B's request card and rejects it");
	await h.eventually(() => read(B, 'connectionState.joinRefusal'), (r) => r?.result === 'denied' && r?.peerId === A.id, 'B hears the real Reject as declined', 20000);
	h.check(!(await read(B, 'waitingForApproval')).some((w) => w[0] === A.id), "B's request is over");
	h.check(!(await notes(A)).some((t) => /unreachable/.test(t)), 'A is not told the refused joiner is unreachable');

	await dialVia(B, A.id);
	await inPage(A, 'window.__realOpened = pc.openedPeers; pc.openedPeers = new Set(Array.from({ length: 15 }, (_, i) => "fake" + i)); s.peers.update((v) => v);');
	h.check(await click(acard.locator('.cxreq-full'), 30000), 'premise: at the cap A tells B it is full');
	await inPage(A, 'pc.openedPeers = window.__realOpened; s.peers.update((v) => v);');
	await h.eventually(() => read(B, 'connectionState.joinRefusal'), (r) => r?.result === 'full', 'B hears the full room as FULL', 20000);
	const chip = B.page.locator('#connect-refusal-chip');
	h.check((await attr(chip, 'data-result')) === 'full', 'and its pill says so');

	await h.finish(browser);
});
