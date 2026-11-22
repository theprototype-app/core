// 71 AS3 — THE BLOCK TOAST OFFERS THE REAL FIX. A session block holds a PEER ID; a guest comes back
// with a new one. So blocking a guest says so and offers, in the same toast, what stops it:
// Require approval to join (core, this session: every automatic join — invite links included —
// becomes the approval card), and Signed-in people only where a plugin can do it.
//
//   1 three real peers (OSS build, no plugin): H hosts B and C; H blocks C → the toast names the
//     new-id way back and offers Allow back + Require approval to join, NOT Signed-in people only;
//     B dropped C too (a mesh block)
//   2 H presses Require approval → C's NEW id, opening a working invite link, lands on H's
//     approval card instead of walking in; counterfactual: with it off, the same link admits
//   3 a plugin's room access (scripted dials): the toast offers both fixes; Signed-in people only
//     and Require approval each reach the plugin; with Require approval on, a dial the plugin
//     would admit (guests join automatically) is a card; a signed-in person's toast is the plain one
//   4 feature unused: removing without a block, and blocking with the Settings row off and no
//     plugin, change nothing else (plain remove toast; a plain invite still admits)
//   5 Settings ▸ Connection ▸ Require approval to join mirrors the flag, and leaving the session
//     turns it off
//
// Run: APP_URL=https://theprototype.app:5602/ npm run e2e -- block-guest-fix
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
const EMIT = `
	const fake = { peer: arg.peer, metadata: arg.metadata, open: false, closed: false, handlers: {},
		on(ev, fn) { this.handlers[ev] = fn; }, close() { this.closed = true; }, send() {} };
	pc.peer.emit('connection', fake);
	return { closed: fake.closed };`;
/** the toast whose text matches, with its button labels */
const toastWith = (peer, re) =>
	peer.page.evaluate((r) => {
		const t = [...document.querySelectorAll('.tp-toast')].find((el) => new RegExp(r).test(el.textContent || ''));
		return t ? { text: t.querySelector('.tp-toast-text')?.textContent ?? '', buttons: [...t.querySelectorAll('.tp-toast-action')].map((b) => b.textContent.trim()) } : null;
	}, re);
const pressInToast = (peer, re, label) =>
	peer.page.evaluate(
		([r, l]) => {
			const t = [...document.querySelectorAll('.tp-toast')].find((el) => new RegExp(r).test(el.textContent || ''));
			const b = t && [...t.querySelectorAll('.tp-toast-action')].find((x) => x.textContent.trim() === l);
			b?.click();
			return !!b;
		},
		[re, label]
	);
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

	// ==================================================================== 1
	console.log('\n=== 1. three real peers: block a guest ===');
	const H = await h.setupPage(browser, 'H');
	const B = await h.setupPageQuiet(browser, 'B', [H]);
	const C = await h.setupPageQuiet(browser, 'C', [H, B]);
	await h.connect(B, H, 3000);
	await h.connect(C, H, 3000);
	await until(() => inPage(C, 'return pc.openedPeers.size'), (n) => n >= 2, 'setup: C is linked to H and B', 30000);
	h.check((await toastWith(H, 'new id')) === null, 'no block toast before anything is blocked');

	await inPage(H, 's.peerModeration.removePeer(arg, { block: true })', C.id);
	const t1 = await until(() => toastWith(H, 'removed and blocked'), (t) => !!t, '1.1 the block toast shows');
	h.check(/come back with a new id/.test(t1?.text ?? ''), `1.2 it says a guest can come back with a new id (${t1?.text})`);
	h.check(JSON.stringify(t1?.buttons) === JSON.stringify(['Allow back', 'Require approval to join']), `1.3 OSS: Allow back + Require approval only (${JSON.stringify(t1?.buttons)})`);
	await until(() => inPage(B, 'return !!pc.openedPeers.has(arg)', C.id), (v) => v === false, '1.4 B dropped C as well (a mesh block)');

	// ==================================================================== 2
	console.log('\n=== 2. Require approval → the new id lands on a card ===');
	h.check(await pressInToast(H, 'removed and blocked', 'Require approval to join'), '2.1 Require approval pressed in the toast');
	h.check((await read(H, 'peerModeration.requireApproval')) === true, '2.2 the session flag is on');
	await until(() => toastWith(H, 'needs your approval to join'), (t) => !!t && t.buttons.includes('Undo'), '2.3 the host is told, with Undo');
	const inv = await inPage(H, "const r = s.inviteStore.createInvite({ hostId: pc.peer.id, kind: 'person', maxUses: 5 }); return { link: r.link, id: r.record?.id, refused: r.refused };");
	h.check(!!inv?.link && !inv.refused, 'a working five-use invite link');
	// C and B are done: close them so the fourth page boots on a box with two fewer renderers
	await C.ctx.close();
	await B.ctx.close();
	const C2 = await h.setupPage(browser, 'C2', { hash: new URL(inv.link).hash });
	const card = await until(() => cards(H).then((c) => c.find((x) => x.peerId === C2.id)), (c) => !!c, "2.4 C's new id, with a working invite, is an approval card on H", 30000);
	h.check(/working invite link/.test(card?.label ?? ''), `2.5 the card says why it is not automatic (${card?.label})`);
	h.check(!(await roster(H)).some((u) => u[0] === C2.id), '2.6 and nobody let it in');
	h.check((await read(C2, 'connectionState.sessionHost')) !== H.id, '2.7 C2 is still waiting');
	await inPage(H, 's.peerApproval.denyPeer(arg)', C2.id);
	// counterfactual: the flag is what made the difference
	await inPage(H, 's.peerModeration.setRequireApproval(false, { quiet: true })');
	const tok = core.parseHashParams(new URL(inv.link).hash).invite;
	await inPage(H, EMIT, { peer: 'eeee1', metadata: { jr: 1, invite: core.dialInvite(tok, 'eeee1', H.id) } });
	await until(() => roster(H).then((r) => r.some((u) => u[0] === 'eeee1')), (v) => v === true, '2.8 COUNTERFACTUAL: with it off, the same link admits');
	await C2.ctx.close();

	// ==================================================================== 3
	console.log('\n=== 3. a plugin room access: both fixes ===');
	await inPage(
		H,
		`window.__ra = [];
		s.cloudHooks.setAuthProvider({ decide() { return 'admit'; } });
		s.cloudHooks.setRoomAccess({
			isGuest: (id) => id !== 'ffff9',
			requireApproval: () => { window.__ra.push('gated'); },
			signedInOnly: () => { window.__ra.push('signedIn'); },
			state: () => ({})
		});`
	);
	await inPage(H, EMIT, { peer: 'dddd1', metadata: { jr: 1 } });
	await until(() => roster(H).then((r) => r.some((u) => u[0] === 'dddd1')), (v) => v === true, '3.1 a guest walks in (the plugin admits guests)');
	await inPage(H, "s.peerModeration.removePeer('dddd1', { block: true })");
	const t3 = await until(() => toastWith(H, 'DDDD1 was removed and blocked|dddd1 was removed and blocked'), (t) => !!t, '3.2 the block toast shows');
	h.check(JSON.stringify(t3?.buttons) === JSON.stringify(['Allow back', 'Require approval to join', 'Signed-in people only']), `3.3 a plugin build offers both fixes (${JSON.stringify(t3?.buttons)})`);
	await pressInToast(H, 'DDDD1 was removed and blocked|dddd1 was removed and blocked', 'Signed-in people only');
	await until(() => inPage(H, 'return window.__ra'), (r) => r.includes('signedIn'), '3.4 Signed-in people only reaches the plugin');
	await inPage(H, EMIT, { peer: 'dddd2', metadata: { jr: 1 } });
	await until(() => roster(H).then((r) => r.some((u) => u[0] === 'dddd2')), (v) => v === true, '3.5 another guest');
	await inPage(H, "s.peerModeration.removePeer('dddd2', { block: true })");
	await until(() => toastWith(H, 'DDDD2 was removed and blocked|dddd2 was removed and blocked'), (t) => !!t, '3.6 its toast');
	await pressInToast(H, 'DDDD2 was removed and blocked|dddd2 was removed and blocked', 'Require approval to join');
	await until(() => inPage(H, 'return window.__ra'), (r) => r.includes('gated'), '3.7 Require approval also asks the plugin to make the room ask');
	await inPage(H, EMIT, { peer: 'dddd3', metadata: { jr: 1 } });
	await H.page.waitForTimeout(200);
	h.check((await cards(H)).some((c) => c.peerId === 'dddd3') && !(await roster(H)).some((u) => u[0] === 'dddd3'), '3.8 a dial the plugin would admit is now the card');
	await inPage(H, EMIT, { peer: 'ffff9', metadata: { jr: 1 } });
	await inPage(H, 's.peerApproval.approvePeer("ffff9")');
	await inPage(H, "s.peerModeration.removePeer('ffff9', { block: true })");
	const t3s = await until(() => toastWith(H, 'FFFF9 was removed and blocked|ffff9 was removed and blocked'), (t) => !!t, '3.9 a signed-in person');
	h.check(JSON.stringify(t3s?.buttons) === '["Allow back"]' && !/new id/.test(t3s?.text ?? ''), `3.10 …gets the plain toast: the account list holds (${JSON.stringify(t3s)})`);
	await inPage(H, 's.cloudHooks.setAuthProvider(null); s.cloudHooks.setRoomAccess(null); s.peerModeration.setRequireApproval(false, { quiet: true })');

	// ==================================================================== 4
	console.log('\n=== 4. feature unused: nothing else changes ===');
	await inPage(H, EMIT, { peer: 'gggg1', metadata: { jr: 1, invite: core.dialInvite(tok, 'gggg1', H.id) } });
	await until(() => roster(H).then((r) => r.some((u) => u[0] === 'gggg1')), (v) => v === true, '4.1 a plain invite admits as before');
	await inPage(H, "s.peerModeration.removePeer('gggg1')");
	const t4 = await until(() => toastWith(H, 'was removed from the session'), (t) => !!t, '4.2 a plain remove');
	h.check(t4?.buttons?.length === 0, `4.3 …offers no fix (${JSON.stringify(t4?.buttons)})`);

	// ==================================================================== 5
	console.log('\n=== 5. the Settings row, and leaving ===');
	await inPage(H, 's.peerModeration.setRequireApproval(true, { quiet: true })');
	await inPage(H, "s.cloudPlugin.makeCloudApi().openSettings?.('connection')");
	const row = H.page.locator('#require-approval');
	await row.waitFor({ timeout: 10000 }).catch(() => {});
	h.check((await row.count()) === 1, '5.1 Settings ▸ Connection has the row');
	h.check((await row.getAttribute('aria-checked').catch(() => null)) === 'true' || (await row.isChecked().catch(() => false)), '5.2 …and it shows the flag on');
	await inPage(H, 'pc.leaveSession()');
	await H.page.waitForTimeout(300);
	h.check((await read(H, 'peerModeration.requireApproval')) === false, '5.3 leaving the session turns it off');

	await h.finish(browser);
});
