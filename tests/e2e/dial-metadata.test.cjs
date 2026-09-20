// 29 (roadmap 29, rooms access control) — THE JOIN DIAL CARRIES THE PLUGIN'S DATA, AND
// THE HOST'S AUTH HOOK DECIDES ON IT.
//
// A cloud room can be gated (a code, a knock with a name). The plugin cannot say any of
// that over the data channel, because an unapproved conn is closed before it opens — the
// only thing that reaches the host FIRST is the dial's PeerJS metadata. So
// `cloudApi.connectToPeer(peerId, cloudMeta)` → `requestConnect(peerId, cloudMeta)` puts
// `cloud: <plain JSON ≤ 1 KB>` on the join dial (and on that peer's restore re-dials),
// and `authProvider.decide(peerId, cloudMeta)` — when the provider has one — replaces
// `authorize`: 'admit' / 'deny' (refused with NO card, told to a joiner that can hear
// it) / {label} (the normal card, carrying the label). `cloudApi.dialMeta === true` is
// the probe an older engine lacks.
//
// What this suite pins:
//   1   the JOINER: no metadata → the dial is byte-identical to before the seam
//   2   metadata rides the dial AND its restore re-dial; a later plain dial forgets it;
//       oversized / unserialisable data is dropped rather than sent
//   3   the HOST, against a stubbed peer: deny (closed, no card, refusal dial only when
//       the joiner can hear it) · label (the card carries it, capped, refreshed on a
//       re-dial) · admit (whitelisted + dialled back, no card) · no verdict → the old
//       `authorize` path · a provider with ONLY authorize is byte-identical · a
//       throwing decide falls back to the manual card
//   4   two real peers over signaling: the label, then deny, then admit
//
// Run: APP_URL=https://theprototype.app:5219/ PEER_CONFIG=... npm run e2e -- dial-metadata
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
const dials = (peer) => inPage(peer, 'return window.__dials.map((d) => ({ id: d.id, opts: d.opts }))');
const lastDial = async (peer, id) => (await dials(peer)).filter((d) => d.id === id).pop() ?? null;

/** an incoming conn as peerjs hands it to the `connection` event */
const EMIT = `
	const fake = { peer: arg.peer, metadata: arg.metadata, open: false, closed: false, handlers: {},
		on(ev, fn) { this.handlers[ev] = fn; }, close() { this.closed = true; }, send() {} };
	pc.peer.emit('connection', fake);
	return { closed: fake.closed, wired: Object.keys(fake.handlers) };`;

/** dial against a stubbed peer.connect that records every call */
const DIAL_STUB = `
	window.__dials = [];
	Object.defineProperty(pc.peer, 'open', { value: true, configurable: true });
	pc.peer.connect = (id, opts) => {
		const conn = { peer: id, open: false, sent: [], handlers: {}, on(ev, fn) { (this.handlers[ev] ??= []).push(fn); }, close() { this.closed = true; }, send(m) { this.sent.push(m); } };
		window.__dials.push({ id, opts: JSON.parse(JSON.stringify(opts ?? null)), conn });
		return conn;
	};`;

/** the host's auth provider: `decide` records what it was asked and answers
 *  `window.__verdict` (a thrower when it is the string 'throw') */
const DECIDER = `
	window.__decided = [];
	window.__verdict = arg;
	s.cloudHooks.setAuthProvider({
		decide(peerId, meta) {
			window.__decided.push({ peerId, meta: meta === undefined ? 'undefined' : meta });
			if (window.__verdict === 'throw') throw new Error('decide blew up');
			return window.__verdict;
		}
	});`;

const text = (loc) => loc.textContent({ timeout: 3000 }).catch(() => '');
const click = (loc, timeout = 5000) => loc.click({ timeout }).then(() => true, () => false);

async function dialVia(peer, id) {
	await peer.page.locator('input[placeholder="Enter peer ID to connect"]').fill(id);
	await peer.page.getByRole('button', { name: 'Connect', exact: true }).click();
	await peer.page.waitForTimeout(300);
}

h.run(async () => {
	const browser = await h.launch();

	// ==================================================================== the joiner
	const J = await h.setupPage(browser, 'joiner');
	await J.page.waitForFunction(() => !!window.__stores?.peerApproval?.requestConnect, { timeout: 30000 });
	await inPage(J, DIAL_STUB);

	console.log('\n=== 1. no metadata: the dial is byte-identical ===');
	h.check((await inPage(J, 'return s.cloudPlugin.makeCloudApi().dialMeta')) === true, 'cloudApi.dialMeta === true is the probe for this engine');
	await dialVia(J, 'aaaa1');
	const plain = await lastDial(J, 'aaaa1');
	h.check(JSON.stringify(plain?.opts) === '{"metadata":{"jr":1}}', `a pill dial carries exactly {jr:1} and nothing else (${JSON.stringify(plain?.opts)})`);

	console.log('\n=== 2. metadata rides the dial ===');
	const META = { v: 1, room: 'amber-mesa', name: 'Ada', proof: 'abc123' };
	await inPage(J, 's.peerApproval.requestConnect("bbbb1", arg)', META);
	await J.page.waitForTimeout(200);
	const withMeta = await lastDial(J, 'bbbb1');
	h.check(JSON.stringify(withMeta?.opts?.metadata?.cloud) === JSON.stringify(META), `connectToPeer's 2nd arg rides the join dial as metadata.cloud (${JSON.stringify(withMeta?.opts)})`);
	h.check(withMeta?.opts?.metadata?.jr === 1, 'and the dial still says it can hear a join result');
	// the restore re-dial carries it too — a joiner that loses the negotiation mid-way
	// must not knock a second time with an EMPTY hand
	await inPage(J, 'pc.restoreConnection("bbbb1")');
	const restored = await lastDial(J, 'bbbb1');
	h.check((await dials(J)).filter((d) => d.id === 'bbbb1').length === 2, 'premise: the restore re-dialled');
	h.check(JSON.stringify(restored?.opts?.metadata?.cloud) === JSON.stringify(META), 'the restore re-dial carries the same metadata');
	// a plain dial to the same peer forgets it
	await inPage(J, 's.waitingForApproval.set([]); s.userdata.set([]);');
	await dialVia(J, 'bbbb1');
	const forgot = await lastDial(J, 'bbbb1');
	h.check(forgot && !('cloud' in (forgot.opts?.metadata ?? {})), `a later plain dial to the same peer carries no cloud data (${JSON.stringify(forgot?.opts)})`);
	// bounded: over 1 KB is dropped, not truncated; unserialisable is dropped
	await inPage(J, 's.peerApproval.requestConnect("cccc1", { pad: "x".repeat(1100) })');
	const big = await lastDial(J, 'cccc1');
	h.check(big && !('cloud' in big.opts.metadata), 'metadata over 1 KB is dropped (the dial goes out without it)');
	await inPage(J, 'const cyc = { a: 1 }; cyc.self = cyc; s.peerApproval.requestConnect("cccc2", cyc)');
	const cyc = await lastDial(J, 'cccc2');
	h.check(cyc && !('cloud' in cyc.opts.metadata), 'unserialisable metadata is dropped');
	await inPage(J, 's.peerApproval.requestConnect("cccc3", { n: 1 }); s.waitingForApproval.set([]); s.userdata.set([]); delete pc.connections["cccc3"]; s.peerApproval.requestConnect("cccc3", null)');
	const nulled = await lastDial(J, 'cccc3');
	h.check(nulled && !('cloud' in nulled.opts.metadata), 'null metadata forgets a remembered one');
	await J.ctx.close();

	// ==================================================================== the host
	const H = await h.setupPage(browser, 'host');
	await H.page.waitForFunction(() => !!window.__stores?.cloudHooks?.setAuthProvider, { timeout: 30000 });
	await inPage(H, DIAL_STUB);
	const cards = () => read(H, 'pendingApprovals');
	const decided = () => inPage(H, 'return window.__decided');

	console.log('\n=== 3a. decide → deny ===');
	await inPage(H, DECIDER, 'deny');
	const denied = await inPage(H, EMIT, { peer: 'dddd1', metadata: { jr: 1, cloud: { v: 1, name: 'Mallory', proof: 'wrong' } } });
	h.check(denied.closed && denied.wired.length === 0, `a denied dial is closed at once and never wired (${JSON.stringify(denied)})`);
	const d1 = await decided();
	h.check(d1.length === 1 && d1[0].peerId === 'dddd1' && d1[0].meta?.name === 'Mallory' && d1[0].meta?.proof === 'wrong', `decide saw the peer id and the dial's cloud data (${JSON.stringify(d1)})`);
	h.check(!(await cards()).some((c) => c.peerId === 'dddd1'), 'NO approval card for a denied dial');
	h.check(!(await read(H, 'userdata')).some((u) => u[0] === 'dddd1'), '…and it is not whitelisted');
	const refusal = await lastDial(H, 'dddd1');
	h.check(refusal?.opts?.metadata?.joinresult === 'denied', `a joiner that can hear it is told "denied" (${JSON.stringify(refusal?.opts)})`);
	// an older joiner (no jr) cannot hear a refusal — it would read the dial as approval
	await inPage(H, EMIT, { peer: 'dddd2', metadata: { cloud: { name: 'Old' } } });
	h.check((await dials(H)).filter((d) => d.id === 'dddd2').length === 0, 'an older joiner is denied silently — no refusal dial it would misread as an approval');
	h.check(!(await cards()).some((c) => c.peerId === 'dddd2'), '…and still gets no card');
	// a dial with no cloud data at all reaches decide as null
	await inPage(H, EMIT, { peer: 'dddd3', metadata: { jr: 1 } });
	const d3 = (await decided()).find((d) => d.peerId === 'dddd3');
	h.check(d3 && d3.meta === null, `a dial without cloud data reaches decide as null, not undefined (${JSON.stringify(d3)})`);

	console.log('\n=== 3b. decide → {label} ===');
	const LABEL = 'Ada wants to join Amber Mesa';
	await inPage(H, DECIDER, { label: LABEL });
	// (the unapproved conn itself is closed at once, as every pending request's is — the
	// CARD is the state, and it is what carries the label)
	await inPage(H, EMIT, { peer: 'eeee1', metadata: { jr: 1, cloud: { v: 1, name: 'Ada' } } });
	const c1 = (await cards()).find((c) => c.peerId === 'eeee1');
	h.check(c1 && c1.label === LABEL && c1.hearsNo === true, `the approval card carries the label (${JSON.stringify(c1)})`);
	const card = H.page.locator('.tp-toast--req', { hasText: 'EEEE1' });
	await card.waitFor({ timeout: 5000 }).catch(() => {});
	h.check((await text(card.locator('.cxreq-label'))).trim() === LABEL, 'the toast card renders the label under the request line');
	// a re-dial with a label refreshes a card that had none
	await inPage(H, DECIDER, {});
	await inPage(H, EMIT, { peer: 'eeee2', metadata: { jr: 1 } });
	h.check((await cards()).some((c) => c.peerId === 'eeee2' && !c.label), 'an object verdict without a label is the plain card');
	await inPage(H, DECIDER, { label: 'Bo wants to join' });
	await inPage(H, EMIT, { peer: 'eeee2', metadata: { jr: 1, cloud: { name: 'Bo' } } });
	h.check((await cards()).some((c) => c.peerId === 'eeee2' && c.label === 'Bo wants to join'), 'a re-dial with a label refreshes the existing card');
	h.check((await cards()).filter((c) => c.peerId === 'eeee2').length === 1, '…without adding a second card');
	// the label is bounded
	await inPage(H, DECIDER, { label: 'L'.repeat(300) });
	await inPage(H, EMIT, { peer: 'eeee3', metadata: { jr: 1 } });
	const c3 = (await cards()).find((c) => c.peerId === 'eeee3');
	h.check(c3 && c3.label.length === 120, `the label is capped at 120 characters (${c3?.label?.length})`);
	// the drawer's Toasts tab shows it too
	await click(H.page.locator('[data-testid="connect-info-button"]'));
	await H.page.waitForTimeout(350);
	await click(H.page.locator('.cxd-tab', { hasText: 'Toasts' }));
	await H.page.waitForTimeout(250);
	const drawerKnock = H.page.locator('.cxd-knock', { hasText: LABEL });
	h.check((await drawerKnock.count()) >= 1, 'the Connect drawer renders the label beside the request');
	await H.page.mouse.click(10, 500);
	await H.page.waitForTimeout(300);
	for (const id of ['eeee1', 'eeee2', 'eeee3']) await click(H.page.locator('.tp-toast--req', { hasText: id.toUpperCase() }).locator('.cxreq-reject'));
	await H.page.waitForTimeout(300);
	h.check(!(await cards()).some((c) => /^eeee/.test(c.peerId)), 'premise: the knock cards are cleared');

	console.log('\n=== 3c. decide → admit ===');
	await inPage(H, DECIDER, 'admit');
	await inPage(H, EMIT, { peer: 'ffff1', metadata: { jr: 1, cloud: { v: 1, proof: 'right' } } });
	await H.page.waitForTimeout(200);
	h.check((await read(H, 'userdata')).some((u) => u[0] === 'ffff1'), 'an admitted peer is whitelisted');
	h.check(!(await cards()).some((c) => c.peerId === 'ffff1'), '…with no card');
	const back = await lastDial(H, 'ffff1');
	h.check(back?.opts?.metadata?.joinresult === 'approved', `…and dialled back as an approval (${JSON.stringify(back?.opts)})`);

	console.log('\n=== 3d. no verdict → the old authorize path ===');
	await inPage(H, 'window.__decided = []; s.cloudHooks.setAuthProvider({ decide() { window.__decided.push(1); return undefined; }, authorize(id) { return id === "gggg1"; } })');
	await inPage(H, EMIT, { peer: 'gggg1', metadata: { jr: 1 } });
	await inPage(H, EMIT, { peer: 'gggg2', metadata: { jr: 1 } });
	h.check((await read(H, 'userdata')).some((u) => u[0] === 'gggg1'), 'decide returning undefined defers to authorize (gggg1 admitted)');
	h.check((await cards()).some((c) => c.peerId === 'gggg2' && !c.label), '…which sends the rest to the plain card');
	// a provider with ONLY authorize: byte-identical to before the seam
	await inPage(H, 's.cloudHooks.setAuthProvider({ authorize(id) { return id === "hhhh1"; } })');
	await inPage(H, EMIT, { peer: 'hhhh1', metadata: { jr: 1, cloud: { name: 'ignored' } } });
	await inPage(H, EMIT, { peer: 'hhhh2', metadata: { jr: 1 } });
	h.check((await read(H, 'userdata')).some((u) => u[0] === 'hhhh1') && (await cards()).some((c) => c.peerId === 'hhhh2'), 'a provider with only authorize behaves exactly as before');
	// a throwing decide fails SAFE: the manual card, never a silent admit
	await inPage(H, DECIDER, 'throw');
	await inPage(H, EMIT, { peer: 'iiii1', metadata: { jr: 1 } });
	h.check((await cards()).some((c) => c.peerId === 'iiii1') && !(await read(H, 'userdata')).some((u) => u[0] === 'iiii1'), 'a decide that throws falls back to the manual card and admits nobody');
	await inPage(H, 's.cloudHooks.setAuthProvider(null)');
	await H.ctx.close();

	// ==================================================================== two real peers
	console.log('\n=== 4. two real peers ===');
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await A.page.waitForFunction(() => !!window.__stores?.cloudHooks?.setAuthProvider, { timeout: 30000 });
	await inPage(A, DECIDER, { label: LABEL });
	await inPage(B, 's.peerApproval.requestConnect(arg.id, arg.meta)', { id: A.id, meta: { v: 1, room: 'amber-mesa', name: 'Ada' } });
	const acard = A.page.locator('.tp-toast--req', { hasText: String(B.id).slice(0, 6).toUpperCase() });
	await acard.waitFor({ timeout: 30000 }).catch(() => {});
	h.check((await acard.count()) === 1, "premise: A gets B's request card over signaling");
	h.check((await text(acard.locator('.cxreq-label'))).trim() === LABEL, 'the real card carries the plugin label');
	const real = await inPage(A, 'return window.__decided');
	h.check(real.some((d) => d.peerId === B.id && d.meta?.name === 'Ada' && d.meta?.room === 'amber-mesa'), `A's decide received B's dial data over the wire (${JSON.stringify(real)})`);
	h.check(await click(acard.locator('.cxreq-reject'), 10000), 'premise: A rejects the knock');
	await h.eventually(() => read(B, 'connectionState.joinRefusal'), (r) => r?.result === 'denied' && r?.peerId === A.id, 'B hears the rejected knock as declined', 20000);

	await inPage(A, 'window.__decided = []; window.__verdict = "deny"');
	await inPage(B, 's.peerApproval.requestConnect(arg.id, arg.meta)', { id: A.id, meta: { v: 1, room: 'amber-mesa', proof: 'wrong' } });
	await h.eventually(() => read(B, 'connectionState.joinRefusal'), (r) => r?.result === 'denied' && r?.peerId === A.id, 'B hears a decide-deny as declined', 20000);
	h.check((await inPage(A, 'return window.__decided')).some((d) => d.meta?.proof === 'wrong'), 'premise: A decided on the wrong proof');
	h.check(!(await read(A, 'pendingApprovals')).some((c) => c.peerId === B.id), 'A saw no card for the denied dial');

	await inPage(A, 'window.__decided = []; window.__verdict = "admit"');
	await inPage(B, 's.peerApproval.requestConnect(arg.id, arg.meta)', { id: A.id, meta: { v: 1, room: 'amber-mesa', proof: 'right' } });
	await h.eventually(() => read(B, 'connectionState.sessionHost'), (v) => v === A.id, 'B is admitted with nobody pressing Approve', 30000);
	h.check(!(await read(A, 'pendingApprovals')).some((c) => c.peerId === B.id), 'A saw no card for the admitted dial');
	h.check((await read(A, 'userdata')).some((u) => u[0] === B.id), 'B is on A\'s roster');

	await h.finish(browser);
});
