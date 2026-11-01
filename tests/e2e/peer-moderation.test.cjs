// Roadmap 55 A9 — THE PEER MENU, AND REMOVING SOMEBODY FROM A MESH. Three real peers over
// signaling (A hosts, B and C joined A, the mesh filled B<->C).
//
//   1  the menu: right-click a row opens the grouped peer menu; a GUEST (B) sees no
//      Moderation group, the HOST (A) does; Shift+F10 on a focused row opens it too
//   2  B (not the host) sends a kick for C: EVERY receiver ignores it — A and C keep C
//      connected, nobody marks C blocked (the receive-side sender check)
//   3  Hide on B: C's avatar leaves B's scene only; A still draws it; Show again restores
//   4  A removes and blocks C from the menu (confirm): A and B both drop C — B by its OWN
//      close, checked with C made NON-cooperating (its leave stubbed), so ignoring the
//      kick does not keep C connected; C (cooperating, in 4b) hears "You were removed"
//   5  C re-dials A: refused with the `removed` join result — C's chip says so, A shows no
//      approval card
//   6  Allow back: A's Blocked row lifts the block on A AND B; C's next dial gets the
//      ordinary approval card and is let in
//   7  "Show their recent changes" lists what C did (moved a box)
//
// Run: APP_URL=https://theprototype.app:5458/ PEER_CONFIG=... npm run e2e -- peer-moderation
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
const opened = (peer) => inPage(peer, 'return [...pc.openedPeers];');
const blocked = (peer) => inPage(peer, 'let v; s.peerModeration.blockedPeers.subscribe((x) => (v = x))(); return v.map((b) => b.peerId);');
const hidden = (peer) => inPage(peer, 'let v; s.peerHide.hiddenPeers.subscribe((x) => (v = x))(); return v;');
const hasAvatar = (peer, id) => inPage(peer, 'let g; s.globalScene.subscribe((x) => (g = x))(); return !!g?.getObjectByName(arg);', id);
const notes = (peer) => inPage(peer, 'let v = []; s.notifications.subscribe((x) => (v = x))(); return v.map((n) => String(n.text));');

/** poll until true (no check of its own — the checks after it say what was expected) */
async function waitUntil(fn, timeout = 10000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		try {
			if (await fn()) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, 400));
	}
	return false;
}
async function openPanel(peer) {
	const open = await read(peer, 'peersPanelOpen');
	if (!open) await peer.page.evaluate(() => document.querySelector('#peers-trigger')?.click());
	await peer.page.locator('#peers-popover').waitFor({ timeout: 8000 });
}
async function closePanel(peer) {
	await inPage(peer, 's.peersPanelOpen.set(false);');
}
/** right-click a peer's row; resolves the menu's row ids (data-testid) */
async function menuOn(peer, id) {
	await openPanel(peer);
	const row = peer.page.locator(`#peers-popover .peers-row[data-peer-id="${id}"]`).first();
	await row.click({ button: 'right', timeout: 8000 });
	await peer.page.locator('[data-testid="peer-menu-profile"], [data-testid="peer-menu-edit-profile"]').first().waitFor({ timeout: 5000 });
	return peer.page.$$eval('[role="menuitem"][data-testid^="peer-menu-"]', (els) => els.map((e) => e.getAttribute('data-testid').replace('peer-menu-', '')));
}
async function closeMenu(peer) {
	// the menu takes the keyboard one frame after it shows (ContextMenu's focusInput): an
	// Escape before that reaches the panel instead and leaves the menu up
	await peer.page.waitForFunction(() => document.activeElement?.classList?.contains('ctx-filter-input'), null, { timeout: 3000 }).catch(() => {});
	await peer.page.keyboard.press('Escape');
	await peer.page.waitForFunction(() => !document.querySelector('[data-testid^="peer-menu-"]'), null, { timeout: 3000 }).catch(() => {});
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A-host');
	const B = await h.setupPage(browser, 'B-guest');
	const C = await h.setupPage(browser, 'C-guest');
	for (const p of [A, B, C]) await p.page.waitForFunction(() => !!window.__stores?.peerModeration?.removePeer, { timeout: 30000 });
	await h.connect(B, A);
	await h.connect(C, A);
	await waitUntil(async () => (await opened(A)).length === 2 && (await opened(B)).includes(C.id) && (await opened(C)).includes(B.id), 30000);
	h.check((await opened(A)).sort().join() === [B.id, C.id].sort().join(), 'premise: A holds B and C');
	h.check((await opened(B)).includes(C.id) && (await opened(C)).includes(B.id), 'premise: the mesh filled (B <-> C)');

	// ---- 1. the menu --------------------------------------------------------------------
	console.log('\n=== 1. the grouped peer menu ===');
	const guestMenu = await menuOn(B, C.id);
	h.check(['profile', 'goto', 'watch', 'character', 'mute', 'hide'].every((k) => guestMenu.includes(k)), `B's menu on C has Profile/Find/Character/Talk/For you only (${guestMenu.join(',')})`);
	h.check(!guestMenu.includes('remove') && !guestMenu.includes('block'), 'a GUEST sees no Moderation group');
	await closeMenu(B);
	const hostMenu = await menuOn(A, C.id);
	h.check(hostMenu.includes('remove') && hostMenu.includes('block') && hostMenu.includes('changes'), `the HOST sees Moderation (${hostMenu.join(',')})`);
	await closeMenu(A);
	const ownMenu = await menuOn(A, A.id);
	h.check(ownMenu.join() === 'edit-profile,change-character,copy-id', `your own row: Edit profile / Change character (${ownMenu.join(',')})`);
	await closeMenu(A);
	// keyboard: focus C's row and press Shift+F10 (Escape on the menu may also have closed the panel)
	await openPanel(A);
	await A.page.locator(`#peers-popover .peers-row[data-peer-id="${C.id}"]`).first().focus();
	await A.page.keyboard.press('Shift+F10');
	h.check(await A.page.locator('[data-testid="peer-menu-profile"]').isVisible({ timeout: 3000 }).catch(() => false), 'Shift+F10 on a focused row opens the menu');
	await closeMenu(A);
	// View profile opens the card
	await menuOn(A, C.id);
	await A.page.locator('[data-testid="peer-menu-profile"]').click();
	const card = A.page.locator(`#peer-profile-card[data-peer-id="${C.id}"]`);
	h.check(await card.isVisible({ timeout: 5000 }).catch(() => false), 'View profile opens the card for C');
	h.check(((await card.textContent().catch(() => '')) || '').includes(C.id), 'the card shows their peer id');
	await A.page.locator('dialog[open]:has(#peer-profile-card) .wc-close').first().click({ timeout: 3000 }).catch(() => A.page.keyboard.press('Escape'));
	await A.page.waitForTimeout(300);
	h.check(!(await card.isVisible().catch(() => false)), 'the card closes');
	await closePanel(A);
	await closePanel(B);

	// ---- 2. a guest's kick is ignored by every receiver ---------------------------------
	console.log('\n=== 2. B (not the host) sends a kick ===');
	await inPage(B, 'pc.broadcast({ type: "kick", peer: arg, block: true });', C.id);
	await A.page.waitForTimeout(2500);
	h.check((await opened(A)).includes(C.id), 'A ignored it: C still connected to A');
	h.check((await opened(C)).includes(A.id) && (await opened(C)).includes(B.id), 'C ignored it: still connected to A and B');
	h.check(!(await blocked(A)).includes(C.id) && !(await blocked(C)).length, 'nobody marked C blocked');
	h.check((await read(C, 'connectionState.joinRefusal')) == null, 'C was not told it was removed');

	// ---- 3. Hide is local -----------------------------------------------------------------
	console.log('\n=== 3. Hide (for you only) ===');
	h.check(await hasAvatar(B, C.id), "premise: B draws C's avatar");
	await menuOn(B, C.id);
	await B.page.locator('[data-testid="peer-menu-hide"]').click();
	await B.page.waitForTimeout(600);
	h.check((await hidden(B)).includes(C.id), 'B hid C');
	h.check(!(await hasAvatar(B, C.id)), "C's avatar is gone from B's scene");
	h.check(await hasAvatar(A, C.id), 'A still draws C (Hide sends nothing)');
	h.check(!(await hidden(A)).length && !(await hidden(C)).length, 'nobody else hid anyone');
	const again = await menuOn(B, C.id);
	h.check(again.includes('hide') && (await B.page.locator('[data-testid="peer-menu-hide"]').textContent()).includes('Show again'), 'the menu offers Show again');
	await B.page.locator('[data-testid="peer-menu-hide"]').click();
	await B.page.waitForTimeout(600);
	h.check(!(await hidden(B)).length && (await hasAvatar(B, C.id)), 'Show again draws C again');
	await closePanel(B);

	// ---- 3b. the same menu in a headset: Tools ▸ People ---------------------------------
	console.log('\n=== 3b. VR: Tools ▸ People ===');
	const ring = (peer, group) => inPage(peer, 'return s.vrRadialMenu.ringEntries(arg).map((e) => e.id);', group);
	h.check((await ring(B, 'tools')).includes('nav:people'), 'Tools has a People sector');
	h.check((await ring(B, 'people')).includes('people:' + C.id) && (await ring(B, 'people')).includes('people:' + A.id), 'People lists every other peer');
	h.check(!(await ring(B, 'peer')).includes('nav:peer-remove'), "a guest's person ring has no Remove");
	h.check((await ring(A, 'peer')).includes('nav:peer-remove'), "the host's has Remove…");
	await inPage(B, 's.vrRadialMenu.findMenuEntry("people:" + arg).action(); s.vrRadialMenu.findMenuEntry("peer:hide").action();', C.id);
	h.check((await hidden(B)).includes(C.id), 'People ▸ C ▸ Hide hides C on B');
	await inPage(B, 's.vrRadialMenu.findMenuEntry("peer:hide").action(); s.vrRadialMenu.resetRings();');
	h.check(!(await hidden(B)).length, 'and Show again');

	// ---- 7 (before C goes). recent changes ----------------------------------------------
	console.log('\n=== 7. Show their recent changes ===');
	const box = await inPage(C, 'const u = crypto.randomUUID(); pc.broadcast({ type: "create", command: "/create box", uuid: u }); return u;').catch(() => '');
	await A.page.waitForTimeout(1500);
	await inPage(C, 'for (let i = 0; i < 4; i++) pc.broadcast({ type: "move", uuid: arg, pos: [i, 1, 0], rot: [0, 0, 0], scale: [1, 1, 1] });', box);
	await A.page.waitForTimeout(1200);
	const log = await inPage(A, 'return s.peerFacts.peerActivity(arg);', C.id);
	h.check(!!box && log.length >= 1, `A recorded C's edits (${JSON.stringify(log)})`);
	h.check(log[0]?.verb === 'moved' && log[0]?.n >= 4, 'a burst of moves folds into one line with a count');
	await menuOn(A, C.id);
	await A.page.locator('[data-testid="peer-menu-changes"]').click();
	const changeRows = await A.page.locator('[data-testid="peer-change"]').count();
	h.check(changeRows >= 1, `the list shows C's changes (${changeRows} rows)`);
	await closeMenu(A);
	await closePanel(A);

	// ---- 4. remove and block --------------------------------------------------------------
	console.log('\n=== 4. A removes and blocks C ===');
	// C does NOT cooperate: its leave is stubbed, so only the others' closing can drop it
	await inPage(C, 'window.__realLeave = pc.leaveSession.bind(pc); pc.leaveSession = () => { window.__kickHeard = true; };');
	await menuOn(A, C.id);
	await A.page.locator('[data-testid="peer-menu-block"]').click();
	await A.page.locator('#confirm-dialog-ok').click({ timeout: 5000 });
	await waitUntil(async () => !(await opened(A)).includes(C.id) && !(await opened(B)).includes(C.id), 15000);
	h.check(!(await opened(A)).includes(C.id), 'A dropped C');
	h.check(!(await opened(B)).includes(C.id), 'B dropped C on its own (C ignored the kick)');
	h.check(!(await read(A, 'userdata')).some((u) => u[0] === C.id) && !(await read(B, 'userdata')).some((u) => u[0] === C.id), 'C is off both whitelists');
	h.check((await blocked(A)).includes(C.id) && (await blocked(B)).includes(C.id), 'A and B both hold the block');
	h.check(await inPage(C, 'return !!window.__kickHeard;'), 'C received the kick (and would have left)');
	h.check((await read(C, 'connectionState.joinRefusal'))?.result === 'removed', "C's refusal chip says removed");
	h.check((await notes(C)).some((t) => /You were removed from this session/.test(t)), 'C was told "You were removed from this session"');
	// now C leaves for real (the cooperating path)
	await inPage(C, 'pc.leaveSession = window.__realLeave; pc.leaveSession(); s.connectionState.clearJoinRefusal();');
	await C.page.waitForTimeout(1500);

	// ---- 5. a blocked re-dial is refused --------------------------------------------------
	console.log('\n=== 5. C re-dials A ===');
	const dialReady = await waitUntil(() => C.page.locator('input[placeholder="Enter peer ID to connect"]').isVisible(), 20000);
	if (!dialReady)
		console.log('  C pill: ' + JSON.stringify(await inPage(C, 'let w, r; s.waitingForApproval.subscribe((x) => (w = x))(); s.connectionState.joinRefusal.subscribe((x) => (r = x))(); return { opened: [...pc.openedPeers], conns: Object.keys(pc.connections), waiting: w, refusal: r, pill: document.querySelector("#connect-pill, .cx-pill, [data-state]")?.getAttribute("data-state"), inputs: [...document.querySelectorAll("input")].map((i) => i.placeholder || i.value).slice(0, 6) };')));
	await C.page.locator('input[placeholder="Enter peer ID to connect"]').fill(A.id);
	await C.page.getByRole('button', { name: 'Connect', exact: true }).click();
	await waitUntil(async () => (await read(C, 'connectionState.joinRefusal'))?.result === 'removed', 20000);
	h.check((await read(C, 'connectionState.joinRefusal'))?.result === 'removed', 'the re-dial is refused with `removed`');
	h.check(/You were removed from this session/.test((await C.page.locator('#connect-refusal-chip').textContent({ timeout: 3000 }).catch(() => '')) || ''), 'the Connect chip says "You were removed from this session"');
	h.check(!(await read(A, 'pendingApprovals')).some((p) => p.peerId === C.id), 'A shows no approval card for C');
	h.check(!(await opened(A)).includes(C.id), 'C is still out');

	// ---- 6. allow back -----------------------------------------------------------------------
	console.log('\n=== 6. Allow back ===');
	await openPanel(A);
	await A.page.locator(`#peers-blocked .peer-allow-back[data-peer-id="${C.id}"]`).click({ timeout: 8000 });
	await A.page.waitForTimeout(1500);
	h.check(!(await blocked(A)).includes(C.id), 'A lifted the block');
	h.check(!(await blocked(B)).includes(C.id), 'B lifted it too (the allow is broadcast)');
	await closePanel(A);
	await inPage(C, 's.connectionState.clearJoinRefusal();');
	await h.connect(C, A);
	await waitUntil(async () => (await opened(A)).includes(C.id), 20000);
	h.check((await opened(A)).includes(C.id), 'C asked again and was let in');

	h.check(!h.pageErrors(A).length && !h.pageErrors(B).length && !h.pageErrors(C).length, `no page errors (${[...h.pageErrors(A), ...h.pageErrors(B), ...h.pageErrors(C)].slice(0, 3).join(' | ')})`);
	await h.finish(browser);
});
