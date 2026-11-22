// 71 AS4 — AGENT INVITE AND JOIN LIMITS. Three real peers (H hosts; R asks to join the ordinary
// way; J holds a real invite link) and a scripted flood of invite dials on H.
//
//   0 feature unused: no failed-invite row, a plain dial is a card, an invite admits (as before)
//   1 minting: the 21st LIVE invite is refused with a clear message (in the sheet too); with a
//     slot free again, the 11th mint inside 10 minutes is refused and says when to try again
//   2 THE FLOOD: R's request is a card; 30 bad invite dials in a few seconds → ONE collapsed
//     "30 failed invite joins" row, the pause toast exactly once, R's card STILL there and the
//     only card (the 12-card cap never sees the flood); the paused dials are told why
//   3 J opens a real invite link during the pause → J is told invite joins are paused (not
//     "declined"); H presses Resume now on the row; J presses Try again and is IN
//   4 Review on the row lets one of the failed dials in by hand (an expired link's old path)
//   5 one invite re-joining the same peer again and again: two quick re-joins pass, the next is
//     refused as too fast (the joiner is told), and nobody is admitted by it
//
// Run: APP_URL=https://theprototype.app:5602/ npm run e2e -- invite-limits
const h = require('./helpers.cjs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const inPage = (peer, body, arg) =>
	peer.page.evaluate(
		([src, a]) => {
			let pc = null;
			window.__tp.test.v1.peers.subscribe((v) => (pc = v))();
			return Object.getPrototypeOf(async function () {}).constructor('s', 'pc', 'arg', src)(window.__tp?.test.v1, pc, a);
		},
		[body, arg ?? null]
	);
const read = (peer, store) => inPage(peer, `let v; s.${store}.subscribe((x) => (v = x))(); return v;`);
const roster = (peer) => read(peer, 'userdata');
const cards = (peer) => read(peer, 'pendingApprovals');
const failed = (peer) => read(peer, 'inviteStore.failedInviteJoins');
const EMIT = `
	const fake = { peer: arg.peer, metadata: arg.metadata, open: false, closed: false, handlers: {},
		on(ev, fn) { this.handlers[ev] = fn; }, close() { this.closed = true; }, send() {} };
	pc.peer.emit('connection', fake);
	return { closed: fake.closed };`;
// record every dial H makes (refusal dials carry their answer in the metadata) and pass it on
const RECORD = `
	window.__dials = [];
	const real = pc.peer.connect.bind(pc.peer);
	pc.peer.connect = (id, opts) => { window.__dials.push({ id, md: JSON.parse(JSON.stringify(opts?.metadata ?? null)) }); return real(id, opts); };`;
const dialsTo = (peer, id) => inPage(peer, 'return window.__dials.filter((d) => d.id === arg)', id);
const toastCount = (peer, re) => peer.page.evaluate((r) => [...document.querySelectorAll('.tp-toast')].filter((t) => new RegExp(r).test(t.textContent || '')).length, re);
async function until(fn, predicate, label, timeout = 15000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (predicate(last)) {
			h.check(true, label);
			return last;
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	console.log('  last: ' + JSON.stringify(last));
	h.check(false, label);
	return null;
}

h.run(async () => {
	const core = await import(pathToFileURL(path.join(__dirname, '../../src/lib/inviteCore.js')).href);
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H');
	await H.page.waitForFunction(() => !!window.__tp?.test.v1?.inviteStore?.createInvite, null, { timeout: 30000 });
	await until(() => inPage(H, 'return !!pc.peer.open'), (v) => v === true, 'setup: H is on the signaling server');
	await inPage(H, RECORD);
	const mint = (opts) => inPage(H, 'const r = s.inviteStore.createInvite({ hostId: pc.peer.id, ...arg }); return { id: r.record?.id ?? null, link: r.link, refused: r.refused };', opts);
	const tokOf = (link) => core.parseHashParams(new URL(link).hash).invite;
	const dial = (peer, metadata) => inPage(H, EMIT, { peer, metadata: { jr: 1, ...metadata } });

	// ==================================================================== 0
	console.log('\n=== 0. feature unused ===');
	h.check((await H.page.locator('#failed-invite-joins').count()) === 0, '0.1 no failed-invite row');
	// invites made 11 minutes ago (their mints are outside the 10-minute window; 24 h links stay live)
	const longAgo = Date.now() - 11 * 60_000;
	const old = [];
	for (let i = 0; i < 11; i++) old.push(await mint({ kind: 'person', expiry: '24h', maxUses: i === 0 ? 25 : 1, now: longAgo }));
	h.check(old.every((m) => m.id && !m.refused), '0.2 eleven older invites minted');
	await dial('aaaa0', { invite: core.dialInvite(tokOf(old[1].link), 'aaaa0', H.id) });
	await until(() => roster(H).then((r) => r.some((u) => u[0] === 'aaaa0')), (v) => v === true, '0.3 a working invite admits as before');

	// ==================================================================== 1
	console.log('\n=== 1. minting limits ===');
	const jInv = await mint({ kind: 'person', maxUses: 5 });
	h.check(!!jInv.id, "1.1 J's invite");
	const now10 = [];
	for (let i = 0; i < 9; i++) now10.push(await mint({ kind: 'agent' }));
	// live: 10 older (one was used by aaaa0) + J's + 9 = 20
	h.check(now10.every((m) => m.id), '1.2 nine more now (ten minted in this window)');
	const live = () => inPage(H, "return s.inviteStore.listInvites().filter((r) => r.state === 'active').length");
	h.check((await live()) === 20, `1.3 twenty live invites (${await live()})`);
	const no21 = await mint({ kind: 'person' });
	h.check(!no21.id && no21.refused?.reason === 'live', `1.4 the 21st live invite is refused (${JSON.stringify(no21.refused)})`);
	h.check(/20 invite links that still work/.test(no21.refused?.message ?? ''), '1.5 …saying what to do');
	// the sheet says it too
	await H.page.locator('#connect-invite').click({ timeout: 30000, noWaitAfter: true });
	await H.page.locator('#invite-create').click({ timeout: 10000 });
	const sheetMsg = await H.page.locator('#invite-refused').textContent({ timeout: 5000 }).catch(() => '');
	h.check(/20 invite links that still work/.test(sheetMsg ?? ''), `1.6 the Invite sheet shows the reason (${sheetMsg})`);
	await inPage(H, 's.inviteStore.inviteSheet.set(null)');
	await inPage(H, 's.inviteStore.revokeInvite(arg)', now10[8].id);
	const rate = await mint({ kind: 'person' });
	h.check(!rate.id && rate.refused?.reason === 'rate' && /Try again in \d+ minute/.test(rate.refused.message), `1.7 a free slot, but the 11th mint in 10 minutes is refused (${rate.refused?.message})`);

	// ==================================================================== 2
	console.log('\n=== 2. the flood ===');
	const R = await h.setupPageQuiet(browser, 'R', [H]);
	// J boots NOW (a third page boots slowly on a loaded box, and the pause lasts 60 s); it opens its link later
	const J = await h.setupPageQuiet(browser, 'J', [H, R]);
	await (await h.openDial(R.page)).fill(H.id);
	await R.page.getByRole('button', { name: 'Connect', exact: true }).click();
	await until(() => cards(H).then((c) => c.some((x) => x.peerId === R.id)), (v) => v === true, "2.1 R's request is a card", 30000);
	for (let i = 0; i < 30; i++) {
		const id = 'f' + String(i).padStart(4, '0');
		await dial(id, { kind: i % 3 ? 'agent' : undefined, invite: core.dialInvite(core.newToken(), id, H.id) });
	}
	const sum = await until(() => failed(H), (f) => f.count === 30, '2.2 thirty failed invite dials counted');
	h.check(sum?.pausedUntil > Date.now(), '2.3 invite joins are paused');
	const c2 = await cards(H);
	h.check(c2.length === 1 && c2[0].peerId === R.id, `2.4 R's card is still there and the ONLY card (${c2.map((c) => c.peerId).join(',')})`);
	const rowText = await H.page.locator('#failed-invite-joins .fij-count').textContent({ timeout: 5000 }).catch(() => '');
	h.check(rowText === '30 failed invite joins', `2.5 ONE collapsed row reads "30 failed invite joins" (${rowText})`);
	h.check((await H.page.locator('#failed-invite-joins').count()) === 1, '2.6 exactly one row');
	h.check((await H.page.locator('.tp-toast--req', { hasText: R.id.slice(0, 6).toUpperCase() }).count()) === 1, "2.7 R's card is on screen");
	const pauseNotes = await inPage(H, 'let n; s.notifications.subscribe((v) => (n = v.map((x) => x.text)))(); return n.filter((t) => /Invite joins are paused/.test(t)).length;');
	h.check(pauseNotes === 1, `2.8 the pause toast, once (${pauseNotes} in the notification history, ${await toastCount(H, 'Invite joins are paused')} on screen)`);
	const told = await inPage(H, "return window.__dials.filter((d) => d.md && d.md.why === 'invite-paused').length");
	h.check(told >= 1, `2.9 paused dials are told why (${told} refusal dials carry invite-paused)`);
	h.check((await H.page.locator('#failed-invite-joins[data-paused="yes"]').count()) === 1, '2.10 the row says invite joins are paused');

	// ==================================================================== 3
	console.log('\n=== 3. a real invite during the pause ===');
	// what opening the link does in a tab that is already up: the hash is read, then the dial
	await inPage(J, 's.inviteStore.captureInviteHash(arg.hash); s.peerApproval.requestConnect(arg.host);', { hash: new URL(jInv.link).hash, host: H.id });
	await until(() => toastCount(J, 'paused invite joins'), (n) => n >= 1, '3.1 J is told invite joins are paused', 30000);
	h.check((await toastCount(J, 'declined your connection request')) === 0, '3.2 …not "declined"');
	h.check(!(await roster(H)).some((u) => u[0] === J.id), '3.3 J is not in');
	// the Invite sheet in section 1 left the Connect drawer open, which routes the floating cards into it:
	// the row is there too (its own id), then the drawer closes and the floating row takes the clicks
	h.check((await H.page.locator('#failed-invite-joins-drawer').count()) <= 1, '3.4a the drawer carries the row while it is open');
	await inPage(H, 's.connectDrawerOpen?.set?.(false)');
	await H.page.locator('#failed-invite-joins .fij-resume').click({ timeout: 10000 });
	h.check((await failed(H)).pausedUntil === 0, '3.4 Resume now lifts the pause');
	await J.page.evaluate(() => {
		const t = [...document.querySelectorAll('.tp-toast')].find((el) => /paused invite joins/.test(el.textContent || ''));
		[...(t?.querySelectorAll('.tp-toast-action') ?? [])].find((b) => b.textContent.trim() === 'Try again')?.click();
	});
	await until(() => read(J, 'connectionState.sessionHost'), (v) => v === H.id, '3.5 J tries again and is IN', 45000);
	h.check(!(await cards(H)).some((c) => c.peerId === J.id), '3.6 with no card');

	// ==================================================================== 4
	console.log('\n=== 4. Review lets one in by hand ===');
	await H.page.locator('#failed-invite-joins .fij-review').click({ timeout: 5000 });
	const firstRow = H.page.locator('#failed-invite-joins .fij-row').first();
	const pid = await firstRow.getAttribute('data-peer', { timeout: 5000 }).catch(() => null);
	await firstRow.locator('.fij-letin').click({ timeout: 5000 }).catch(() => {});
	await until(() => roster(H).then((r) => r.some((u) => u[0] === pid)), (v) => v === true, `4.1 Let in admits ${pid}`);
	h.check(!(await failed(H)).rows.some((r) => r.peerId === pid), '4.2 …and its row goes');
	await H.page.locator('#failed-invite-joins .fij-dismiss').click({ timeout: 5000 });
	await until(() => H.page.locator('#failed-invite-joins').count(), (n) => n === 0, '4.3 Dismiss clears the row');

	// ==================================================================== 5
	console.log('\n=== 5. re-joining too fast ===');
	const t25 = tokOf(old[0].link);
	const proof = core.dialInvite(t25, 'cccc1', H.id);
	const drop = () => inPage(H, "let u; s.userdata.subscribe((x) => (u = x))(); s.userdata.set(u.filter((r) => r[0] !== 'cccc1'));");
	await dial('cccc1', { invite: proof });
	await until(() => roster(H).then((r) => r.some((u) => u[0] === 'cccc1')), (v) => v === true, '5.1 first join');
	for (const n of [1, 2]) {
		await drop();
		await dial('cccc1', { invite: proof });
		await until(() => roster(H).then((r) => r.some((u) => u[0] === 'cccc1')), (v) => v === true, `5.${n + 1} quick re-join ${n} passes`);
		await H.page.waitForTimeout(1100); // one refusal dial per peer per second
	}
	await drop();
	await dial('cccc1', { invite: proof });
	await H.page.waitForTimeout(400);
	h.check(!(await roster(H)).some((u) => u[0] === 'cccc1'), '5.4 the third quick re-join is refused');
	const slow = (await dialsTo(H, 'cccc1')).filter((d) => d.md?.why === 'invite-slow');
	h.check(slow.length === 1, `5.5 …and told it re-joined too fast (${slow.length})`);
	h.check(!(await cards(H)).some((c) => c.peerId === 'cccc1') && (await failed(H)).count === 0, '5.6 it is neither a card nor a failed proof');

	await h.finish(browser);
});
