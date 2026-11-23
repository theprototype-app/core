// 92 (GC8) — AUTO-ADMIT WHILE PLAYING, two pages (game-menus-92 runs the menu-answered join with three; a fourth page
// on a loaded Deck took the whole browser down, so this half has its own suite).
//
//  1 the host authors a game with "Auto-admit while playing" and plays it
//  2 a dial while the host plays is let in with NO card, the admission is announced (a toast), the host never left Play
//  3 the joiner has the game state and the menus
//  4 the joiner reloads: back in the session, the game state intact
//  5 with the switch OFF the next dial gets a card (the switch decides, nothing else)
const h = require('./helpers.cjs');

const val = (page, path) =>
	page.evaluate((p) => {
		let obj = window.__tp?.test.v1;
		for (const k of p.split('.')) obj = obj[k];
		let v;
		obj.subscribe((x) => (v = x))();
		return v;
	}, path);
const gameStateOf = (page) => page.evaluate(() => { let v; window.__tp.test.v1.gameState.gameState.subscribe((x) => (v = x))(); return { state: v.state, vars: v.vars }; });
const openTo = (peer, id) => peer.page.evaluate((x) => new Promise((r) => window.__tp.test.v1.peers.subscribe((p) => r(!!p?.connections?.[x]?.open))()), id);

async function poll(fn, ms) {
	const until = Date.now() + ms;
	let last = null;
	while (Date.now() < until) {
		last = await fn().catch(() => null);
		if (last) return last;
		await new Promise((r) => setTimeout(r, 400));
	}
	return last;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	console.log('\n=== 1. a game with Auto-admit while playing, played ===');
	await page.evaluate(async () => {
		const s = window.__tp.test.v1;
		s.gameKit.gameSettings.forceGameId('menus-92-join');
		await s.commandsHandler.sceneCommand('/create box');
		s.gameMenusKit.gameMenusPlan.setGameMenus({ autoAdmit: true, saves: true });
		s.gameState.setGameState('playing');
		s.gameState.setGameVar('coins', 7);
	});
	await page.waitForTimeout(800);
	await page.evaluate(() => window.__tp.test.v1.playMode.requestPlay());
	await poll(async () => (await val(page, 'isLocked')) === true, 6000);
	h.check((await val(page, 'isLocked')) === true, '1.1 the host plays');
	const watching = await poll(() => page.evaluate(() => window.__tp.test.v1.gameMenusKit.playJoins.playJoinsDebug().watching), 8000);
	h.check(!!watching, '1.2 the menus runtime watches for joiners (loaded with the menus block)');

	console.log('\n=== 2. a dial while the host plays: let in with no card ===');
	const B = await h.setupPage(browser, 'B');
	await (await h.openDial(B.page)).fill(A.id);
	await B.page.getByRole('button', { name: 'Connect', exact: true }).click();
	const bOpen = await poll(() => openTo(B, A.id), 45000);
	h.check(!!bOpen, '2.1 let in with no card while the host plays');
	const j = await page.evaluate(() => window.__tp.test.v1.gameMenusKit.playJoins.playJoinsDebug());
	h.check(j.admitted.includes(B.id), '2.2 counted as an automatic admission (' + JSON.stringify(j.admitted) + ')');
	const toasts = await page.evaluate(() => { let v; window.__tp.test.v1.toastStore.subscribe((x) => (v = x))(); return (v ?? []).map((t) => t.text); });
	h.check(toasts.some((t) => /joined the game — Auto-admit while playing is on/.test(t)), '2.3 the admission is announced (' + JSON.stringify(toasts.slice(-3)) + ')');
	h.check((await val(page, 'isLocked')) === true, '2.4 the host never left Play');

	console.log('\n=== 3. the joiner has the game ===');
	const coins = await poll(async () => ((await gameStateOf(B.page)).vars.coins === 7 ? 7 : null), 20000);
	h.check(coins === 7, '3.1 the joiner has the game state (coins 7)');
	const menusB = await B.page.evaluate(() => { let v; window.__tp.test.v1.scenePhysics.scenePhysicsState_.subscribe((x) => (v = x))(); return v.play?.menus ?? null; });
	h.check(menusB?.autoAdmit === true, '3.2 and the menus');

	console.log('\n=== 4. the joiner reloads ===');
	await page.evaluate(() => window.__tp.test.v1.gameState.setGameVar('coins', 11));
	await h.freshReload(B);
	await h.answerRestore(B).catch(() => {});
	const back = await poll(() => openTo(B, A.id), 60000);
	h.check(!!back, '4.1 back in the session after a reload');
	const coins4 = await poll(async () => ((await gameStateOf(B.page)).vars.coins === 11 ? 11 : null), 20000);
	h.check(coins4 === 11, '4.2 the game state is intact (coins 11)');

	console.log('\n=== 5. the switch off: the next dial asks ===');
	await page.evaluate(() => window.__tp.test.v1.gameMenusKit.gameMenusPlan.setGameMenus({ autoAdmit: false }));
	await h.closePeer(B);
	await page.waitForTimeout(1500);
	const C = await h.setupPage(browser, 'C');
	await (await h.openDial(C.page)).fill(A.id);
	await C.page.getByRole('button', { name: 'Connect', exact: true }).click();
	const card = await poll(() => page.evaluate((id) => { let v; window.__tp.test.v1.pendingApprovals.subscribe((x) => (v = x))(); return (v ?? []).some((c) => c.peerId === id); }, C.id), 30000);
	h.check(!!card, '5.1 with the switch off a join card waits for the host');
	h.check(!(await page.evaluate(() => window.__tp.test.v1.gameMenusKit.playJoins.playJoinsDebug().admitted)).includes(C.id), '5.2 and nobody let them in');

	await h.finish(browser);
});
