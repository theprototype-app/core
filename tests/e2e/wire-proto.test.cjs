// 101 F1 — A SESSION THAT CAN SAY NO: the protocol number in the handshake, and the refusal path.
//
// Production stays on protocol 1, so nothing is refused there yet. The path is proven by making ONE
// page speak protocol 2 (`debugWireProto`, honoured only beside debugStores, or the runtime hook
// `__stores.wireProto.setProto`, which applies to links made from then on):
//   1  same protocol: dial metadata + `modules` carry proto/caps, both sides agree, nothing refused
//   2  older joins newer: the host refuses before any card; the joiner is told to reload; 0 applied
//   3  reconnect after refusal: the refused joiner (now on the host's protocol) joins normally
//   4  newer joins older: the older host is told to reload; the joiner sees "needs to reload"; 0 applied
//   5  a late joiner through mesh fill: the peer on another protocol refuses the mesh dial; the
//      joiner keeps its host; no redial storm; 0 applied from the refusing peer
//   6  the gate itself on a link with no dial metadata (an adopted outgoing conn): a newer page holds
//      until `modules`, then drops everything (older) or lets everything through (same)
//
// Run: APP_URL=https://theprototype.app:7020/ node tests/e2e/wire-proto.test.cjs
const h = require('./helpers.cjs');

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
const applied = (peer, from) => inPage(peer, 'return s.wireProto.applied(arg)', from);
const STALE = 'This session uses a newer version. Reload to update.';

async function dialVia(peer, id) {
	await (await h.openDial(peer.page)).fill(id);
	await peer.page.getByRole('button', { name: 'Connect', exact: true }).click();
}

/** record every dial a page makes (pass-through) */
const SPY_DIALS = `
	window.__dials = [];
	const orig = pc.peer.connect.bind(pc.peer);
	pc.peer.connect = (id, opts) => { window.__dials.push({ id, at: Date.now(), meta: JSON.parse(JSON.stringify(opts?.metadata ?? null)) }); return orig(id, opts); };`;

h.run(async () => {
	const browser = await h.launch();

	// ---- 1. same protocol -------------------------------------------------------------------
	console.log('\n=== 1. same protocol ===');
	{
		const A = await h.setupPage(browser, 'A');
		const B = await h.setupPage(browser, 'B');
		await inPage(B, SPY_DIALS);
		await h.connect(B, A);
		const dial = await inPage(B, 'return window.__dials.find((d) => d.id === arg)', A.id);
		h.check(dial?.meta?.proto === 1 && dial?.meta?.jr === 1 && dial?.meta?.caps?.wb === 1, `the dial says proto 1 + caps (${JSON.stringify(dial?.meta)})`);
		await h.eventually(() => inPage(A, 'return s.wireProto.peerProto()'), (m) => m?.[B.id] === 1, 'A agreed protocol 1 with B', 15000);
		await h.eventually(() => inPage(B, 'return s.wireProto.peerProto()'), (m) => m?.[A.id] === 1, 'B agreed protocol 1 with A', 15000);
		await h.eventually(() => inPage(B, 'return s.wireProto.peerCaps()'), (m) => m?.[A.id]?.wb === 1 && m?.[A.id]?.dev === 1, "B holds A's caps", 15000);
		h.check(Object.keys(await inPage(A, 'return s.wireProto.refused()')).length === 0, 'nothing refused on A');
		h.check(!(await notes(B)).some((t) => t.includes(STALE)), 'no reload notice');
		h.check((await applied(A, B.id)) > 5 && (await applied(B, A.id)) > 5, 'messages flow both ways');
		await A.ctx.close();
		await B.ctx.close();
	}

	// ---- 2. older joins newer ---------------------------------------------------------------
	console.log('\n=== 2. older joins newer ===');
	const N = await h.setupPage(browser, 'N', { storage: { debugWireProto: '2' } });
	const O = await h.setupPage(browser, 'O');
	h.check((await inPage(N, 'return s.wireProto.proto()')) === 2 && (await inPage(O, 'return s.wireProto.proto()')) === 1, 'premise: N speaks 2, O speaks 1');
	await inPage(N, 'window.__mk = () => s.commandsHandler.sceneCommand("/create Box 1 1 1"); window.__mk();');
	await dialVia(O, N.id);
	await h.eventually(() => notes(O), (t) => t.some((x) => x.includes(STALE)), 'O (older) is told: ' + STALE, 20000);
	h.check(!!(await read(O, 'wireProto.staleNotice')), 'the notice is recorded once for this page');
	h.check((await O.page.locator('.tp-toast', { hasText: 'newer version' }).getByRole('button', { name: 'Reload' }).count()) >= 1, 'the notice has a Reload button');
	h.check(!(await read(O, 'waitingForApproval')).some((w) => w[0] === N.id), "O's request is over (no Requesting pill)");
	h.check(!(await read(N, 'pendingApprovals')).some((c) => c.peerId === O.id), 'N never put up an approval card');
	const older = await read(N, 'wireProto.olderPeers');
	h.check(older.some((r) => r.peerId === O.id && r.theirs === 1), `N lists O as needing to reload (${JSON.stringify(older)})`);
	await N.page.locator('#peers-trigger').click({ timeout: 5000 }).catch(() => {});
	const line = N.page.locator('#peers-older .peers-older-row');
	await line.first().waitFor({ timeout: 5000 }).catch(() => {});
	h.check(/needs to reload \(older version\)/.test((await line.first().textContent({ timeout: 2000 }).catch(() => '')) ?? ''), 'People shows "<name> needs to reload (older version)"');
	await N.page.keyboard.press('Escape').catch(() => {});
	await O.page.waitForTimeout(3000);
	h.check((await applied(O, N.id)) === 0, `0 messages from N applied on O (${await applied(O, N.id)})`);
	h.check((await applied(N, O.id)) === 0, `0 messages from O applied on N (${await applied(N, O.id)})`);
	h.check((await inPage(O, 'return pc.openedPeers.size')) === 0, 'O holds no open link');

	// ---- 3. reconnect after refusal -----------------------------------------------------------
	console.log('\n=== 3. reconnect after refusal ===');
	// O "updates": its next links speak protocol 2 (the runtime hook — a reload would re-read storage)
	await inPage(O, 's.wireProto.setProto(2)');
	await dialVia(O, N.id);
	const card = N.page.locator('.tp-toast--req', { hasText: String(O.id).slice(0, 6).toUpperCase() });
	h.check(await h.approveButton(card).click({ timeout: 30000 }).then(() => true, () => false), 'N gets a normal approval card now and approves it');
	await h.eventually(() => inPage(O, 'return pc.openedPeers.size'), (n) => n >= 1, 'O is connected to N', 30000);
	await h.eventually(() => read(N, 'wireProto.olderPeers'), (r) => !r.some((x) => x.peerId === O.id), 'the People line for O is gone', 15000);
	await inPage(N, 'window.__mk()');
	await h.eventually(() => applied(O, N.id), (n) => n > 5, 'scene data flows from N to O now', 20000);
	await N.ctx.close();
	await O.ctx.close();

	// ---- 4. newer joins older ---------------------------------------------------------------
	console.log('\n=== 4. newer joins older ===');
	const O2 = await h.setupPage(browser, 'O2');
	const N2 = await h.setupPage(browser, 'N2', { storage: { debugWireProto: '2' } });
	await dialVia(N2, O2.id);
	await h.eventually(() => notes(O2), (t) => t.some((x) => x.includes(STALE)), 'the OLDER host is the one told to reload', 20000);
	await h.eventually(() => notes(N2), (t) => t.some((x) => /needs to reload \(older version\)/.test(x)), 'the newer joiner is told the host needs to reload', 20000);
	h.check((await read(N2, 'wireProto.olderPeers')).some((r) => r.peerId === O2.id), 'and lists it');
	h.check(!(await read(N2, 'waitingForApproval')).some((w) => w[0] === O2.id), "N2's request is over");
	h.check(!(await read(O2, 'pendingApprovals')).some((c) => c.peerId === N2.id), 'O2 never put up a card');
	await N2.page.waitForTimeout(3000);
	h.check((await applied(O2, N2.id)) === 0 && (await applied(N2, O2.id)) === 0, '0 messages applied either way');
	await O2.ctx.close();
	await N2.ctx.close();

	// ---- 5. late joiner through mesh fill ---------------------------------------------------------
	console.log('\n=== 5. late joiner through mesh fill ===');
	const H = await h.setupPage(browser, 'H');
	const A5 = await h.setupPage(browser, 'A5');
	await h.connect(A5, H);
	// A5's links from now on speak 2 (its link to H stays agreed on 1)
	await inPage(A5, 's.wireProto.setProto(2)');
	const L = await h.setupPageQuiet(browser, 'L', [H, A5]);
	await inPage(L, SPY_DIALS);
	await h.connect(L, H);
	await h.eventually(() => inPage(L, 'return window.__dials.some((d) => d.id === arg)', A5.id), Boolean, 'L mesh-fills towards A5 (H told it)', 30000);
	await h.eventually(() => notes(L), (t) => t.some((x) => x.includes(STALE)), 'L is told to reload (A5 is newer)', 30000);
	await h.eventually(() => read(A5, 'wireProto.olderPeers'), (r) => r.some((x) => x.peerId === L.id), 'A5 lists L as needing to reload', 20000);
	h.check(await inPage(L, 'return pc.openedPeers.has(arg)', H.id), 'L keeps its host');
	const dialsBefore = await inPage(L, 'return window.__dials.filter((d) => d.id === arg).length', A5.id);
	// a `hosts` message re-entering the mesh fill must not redial the refused peer
	await inPage(H, 'pc.broadcast({ type: "hosts", hosts: [arg] })', A5.id);
	await L.page.waitForTimeout(12000);
	const dialsAfter = await inPage(L, 'return window.__dials.filter((d) => d.id === arg).length', A5.id);
	h.check(dialsAfter === dialsBefore, `no redial of the refused peer (${dialsBefore} -> ${dialsAfter})`);
	h.check((await applied(L, A5.id)) === 0, `0 messages from A5 applied on L (${await applied(L, A5.id)})`);
	h.check((await applied(A5, L.id)) === 0, `0 messages from L applied on A5 (${await applied(A5, L.id)})`);
	await L.ctx.close();
	await A5.ctx.close();

	// ---- 6. the gate on a link with no dial metadata -----------------------------------------------
	console.log('\n=== 6. the gate on an outgoing link ===');
	const G = H; // one page, fake conns
	await inPage(G, 's.wireProto.setProto(2)');
	const FAKE = `
		const fake = { peer: arg.peer, open: true, sent: [], closed: false, handlers: {},
			on(ev, fn) { (this.handlers[ev] ??= []).push(fn); }, send(m) { this.sent.push(m); }, close() { this.closed = true; this.open = false; } };
		window['__fake_' + arg.peer] = fake;
		pc.wireData(fake);
		const feed = (m) => { for (const fn of fake.handlers.data ?? []) fn(m); };
		for (const m of arg.msgs) feed(m);
		await new Promise((r) => setTimeout(r, 800));
		return { sent: fake.sent.map((m) => m.type + ':' + (m.need ?? '')), closed: fake.closed, applied: s.wireProto.applied(arg.peer), refused: s.wireProto.refused()[arg.peer] ?? null };`;
	const early = [{ type: 'atscene', peerId: 'zold1', scene: '', hash: '', at: 1 }, { type: 'locked', lockeditems: [] }, { type: 'info', message: 'x', sender: 'zold1' }];
	const old = await inPage(G, FAKE, { peer: 'zold1', msgs: [...early, { type: 'modules', versions: [], appVersion: '1.65.0' }] });
	h.check(old.applied === 0 && old.refused === 1, `an older peer's link: everything held, then dropped; refused as protocol 1 (${JSON.stringify(old)})`);
	h.check(old.sent.includes('refuse:2') && old.closed, 'it was sent `refuse {need: 2}` and closed');
	const same = await inPage(G, FAKE, { peer: 'zsame1', msgs: [...early.map((m) => ({ ...m, peerId: 'zsame1', sender: 'zsame1' })), { type: 'modules', versions: [], appVersion: '1.66.0', proto: 2, caps: {} }] });
	h.check(same.applied === 4 && same.refused === null && !same.closed, `a same-protocol link: the held messages went on in order (${JSON.stringify(same)})`);
	// a `refuse` on a link agreed on our protocol contradicts its own dial: ignored
	const contra = await inPage(G, 'const f = window.__fake_zsame1; for (const fn of f.handlers.data) fn({ type: "refuse", reason: "proto", need: 3 }); return { closed: f.closed, refused: s.wireProto.refused().zsame1 ?? null };');
	h.check(!contra.closed && contra.refused === null, `a refuse that contradicts an agreed link is ignored (${JSON.stringify(contra)})`);
	await inPage(G, 's.wireProto.setProto(1)');

	await h.finish(browser);
});
