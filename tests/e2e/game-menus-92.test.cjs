// 92 (GC1 / GC2 / GC5 / GC8) — A GAME'S MENUS: the title screen, the pause menu that pauses (alone), the
// player settings, three save slots, and join cards answered without leaving Play.
//
//  1 feature unused: a game with no menus block keeps the 1.74 pause menu exactly (rows, no pause)
//  2 the title screen: entering Play opens ON it (pointer free), Play starts a new game in slot 1
//  3 the pause menu pauses (alone): the round is 'paused' while it is open, Resume plays on
//  4 player settings: Look speed / Invert look / Subtitles / Reduced motion on the Settings page
//  5 save slots: Save game to slot 2 (a picture), overwrite asks first, a newer-version slot is not loadable,
//    Load game restores the saved variable
//  6 the old single save (before slots) shows as slot 1 "Saved progress" and Continue loads it
//  7 Quit to title from the menu; Quit to editor from the title
//  8 two peers + a third: a dial while the host plays shows the in-game card; the host admits from the
//    menu WITHOUT leaving Play; the joiner gets the game state; with another player in Play the menu does
//    NOT pause ("Others are playing")
//  9 Auto-admit while playing: a dial is let in with no card, and announced
// 10 reload: the joiner reloads and rejoins, the game state still intact
const h = require('./helpers.cjs');

const GAME_HUD = {
	active: '',
	screens: [{ id: 'hud', name: 'HUD', showWhile: 'playing', elements: [{ id: 'score', kind: 'text', anchor: 'top-left', x: 24, y: 24, w: 240, h: 40, label: 'Score' }] }]
};

const val = (page, path) =>
	page.evaluate((p) => {
		let obj = window.__tp?.test.v1;
		for (const k of p.split('.')) obj = obj[k];
		let v;
		obj.subscribe((x) => (v = x))();
		return v;
	}, path);
const gameStateOf = (page) => page.evaluate(() => { let v; window.__tp.test.v1.gameState.gameState.subscribe((x) => (v = x))(); return { state: v.state, vars: v.vars }; });

/** poll until fn() answers something truthy (or the time is up); returns the last answer */
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
const openTo = (peer, id) => peer.page.evaluate((x) => new Promise((r) => window.__tp.test.v1.peers.subscribe((p) => r(!!p?.connections?.[x]?.open))()), id);

/** what the menus think, for a red's line */
const diag = (page) =>
	page.evaluate(() => {
		const s = window.__tp.test.v1;
		const one = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const k = s.gameMenusKit;
		return {
			isLocked: one(s.isLocked),
			pointerFree: one(s.playPointerFree),
			title: one(k.gameMenus.titleScreen),
			shell: one(s.gameKit.gameShell.shellMenu),
			pending: (one(s.pendingApprovals) ?? []).length,
			host: one(s.connectionState.sessionHost),
			editorMode: one(s.editorMode),
			toasts: (one(s.toastStore) ?? []).slice(-3).map((t) => t.text),
			dom: { items: document.querySelectorAll('[data-title-item]').length, joins: !!document.querySelector('#game-join-requests'), dialogs: document.querySelectorAll('dialog[open]').length, title: !!document.querySelector('#game-title-screen'), card: !!document.querySelector('#play-join-card'), menu: !!document.querySelector('#game-shell-menu') }
		};
	});

async function enterPlay(page) {
	await page.evaluate(() => window.__tp.test.v1.playMode.requestPlay());
	for (let i = 0; i < 30 && (await val(page, 'isLocked')) !== true; i++) await page.waitForTimeout(100);
	await page.waitForTimeout(250);
}

/** page errors and console errors, shown beside a red */
const pageErrors = [];
function watchErrors(page, who) {
	page.on('pageerror', (e) => pageErrors.push(who + ' pageerror: ' + String(e?.message ?? e).slice(0, 300)));
	page.on('console', (m) => {
		if (m.type() === 'error' || /save slots|keep:|levels:/.test(m.text())) pageErrors.push(who + ' ' + m.type() + ': ' + m.text().slice(0, 300));
	});
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	watchErrors(page, 'A');
	await page.evaluate(async (doc) => {
		const s = window.__tp.test.v1;
		s.gameKit.gameSettings.forceGameId('menus-92');
		s.hudDocs.setHudDocFor('scene', doc);
		s.gameState.setGameState('playing');
		localStorage.removeItem('tp:levels-save:menus-92');
		for (const n of [1, 2, 3]) localStorage.removeItem('tp:levels-save:menus-92:s' + n);
	}, GAME_HUD);
	await page.evaluate(() => window.__tp.test.v1.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(400);

	console.log('\n=== 1. feature unused = the 1.74 pause menu ===');
	await enterPlay(page);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	const items1 = await page.locator('#game-shell-menu [data-shell-item]').evaluateAll((els) => els.map((e) => e.getAttribute('data-shell-item')));
	h.check(JSON.stringify(items1) === JSON.stringify(['resume', 'restart', 'settings', 'access', 'help', 'mainmenu', 'editor']), '1.1 the rows of 1.74 (' + items1 + ')');
	h.check((await gameStateOf(page)).state === 'playing', '1.2 the menu did not pause a game with no menus block');
	h.check(!(await page.locator('#game-title-screen').isVisible()), '1.3 no title screen');
	await page.locator('[data-shell-item="resume"]').click();
	await h.leavePlay(A);

	console.log('\n=== 2. the title screen ===');
	await page.evaluate(() => {
		const s = window.__tp.test.v1;
		s.gameMenusKit.gameMenusPlan.setGameMenus({ title: { title: 'Menu Test', subtitle: 'A 92 fixture' }, saves: true });
		s.gameState.setGameVar('coins', 7);
	});
	await enterPlay(page);
	await page.locator('#game-title-screen').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
	h.check(await page.locator('#game-title-screen').isVisible(), '2.1 entering Play opens on the title screen');
	h.check((await page.locator('#game-title-screen .ts-title').textContent())?.trim() === 'Menu Test', '2.2 the authored title');
	const t2 = await page.locator('#game-title-screen [data-title-item]').evaluateAll((els) => els.map((e) => e.getAttribute('data-title-item')));
	h.check(JSON.stringify(t2) === JSON.stringify(['play', 'settings', 'quit']), '2.3 Play · Settings · Quit to editor with no save yet (' + t2 + ')');
	h.check((await val(page, 'playPointerFree')) === true, '2.4 the pointer is free over the title');
	const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-title-item'));
	h.check(focused === 'play', '2.5 keyboard focus starts on Play (' + focused + ')');
	await page.locator('[data-title-item="play"]').click();
	await page.waitForTimeout(800);
	h.check(!(await page.locator('#game-title-screen').isVisible()), '2.6 Play closed the title');
	const d2 = await poll(() => page.evaluate(() => { const d = window.__tp.test.v1.gameMenusKit.saveSlots.saveSlotsDebug(); return d.writes.includes(1) ? d : null; }), 10000) ?? (await page.evaluate(() => window.__tp.test.v1.gameMenusKit.saveSlots.saveSlotsDebug()));
	h.check(d2.active === 1 && d2.writes.includes(1) && !d2.slots[0].empty, '2.7 a new game in slot 1, written at the start (' + JSON.stringify({ active: d2.active, writes: d2.writes }) + ')');

	console.log('\n=== 3. the pause menu pauses (alone) ===');
	// the round may have been reset by the abandon watch while nobody was in Play (section 1's exit): start it
	await page.evaluate(() => window.__tp.test.v1.gameState.setGameState('playing'));
	await page.waitForTimeout(200);
	h.check((await gameStateOf(page)).state === 'playing', '3.0 premise: the round is playing');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);
	h.check(await page.locator('#game-shell-menu').isVisible(), '3.1 Escape opened the pause menu');
	h.check((await gameStateOf(page)).state === 'paused', '3.2 the round is paused while the menu is open');
	h.check(await page.locator('#game-shell-paused').isVisible(), '3.3 the menu says so');
	const duck = await page.evaluate(() => window.__tp.test.v1.audioEngine.menuDuckLevel());
	h.check(duck < 1, '3.4 the audio dips (' + duck + ')');
	const items3 = await page.locator('#game-shell-menu [data-shell-item]').evaluateAll((els) => els.map((e) => e.getAttribute('data-shell-item')));
	h.check(['save', 'load', 'title'].every((id) => items3.includes(id)), '3.5 Save game · Load game · Quit to title (' + items3 + ')');
	await page.locator('[data-shell-item="resume"]').click();
	await page.waitForTimeout(400);
	h.check((await gameStateOf(page)).state === 'playing', '3.6 Resume: the round plays on');
	h.check((await page.evaluate(() => window.__tp.test.v1.audioEngine.menuDuckLevel())) === 1, '3.7 the audio is back');

	console.log('\n=== 4. player settings ===');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	await page.locator('[data-shell-item="settings"]').click();
	await page.waitForTimeout(200);
	const rows4 = await page.locator('#game-shell-menu [data-shell-setting], #game-shell-menu [data-access-setting]').evaluateAll((els) => els.map((e) => e.getAttribute('data-shell-setting') ?? e.getAttribute('data-access-setting')));
	h.check(['lookSpeed', 'invertLook', 'captions', 'motion', 'quality', 'music', 'sfx'].every((id) => rows4.includes(id)), '4.1 Look speed, Invert look, Subtitles, Reduced motion, Quality, volumes (' + rows4 + ')');
	await page.locator('[data-shell-setting="invertLook"] button[aria-label="Next Invert look"]').click();
	await page.waitForTimeout(100);
	const stored = await page.evaluate(() => localStorage.getItem('tp:game:menus-92:shell'));
	h.check(/"invertLook":"off"/.test(stored ?? ''), '4.2 saved per game on this device (' + (stored ?? '').slice(0, 120) + ')');
	await page.locator('#game-shell-menu button[aria-label="Back"]').click();
	await page.waitForTimeout(150);

	console.log('\n=== 5. save slots ===');
	await page.evaluate(() => window.__tp.test.v1.gameState.setGameVar('coins', 42));
	await page.locator('[data-shell-item="save"]').click();
	await page.locator('[data-slot-mode="save"]').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
	await page.locator('[data-slot="2"] .ss-main').click();
	const s5 = (await poll(() => page.evaluate(() => { const l = window.__tp.test.v1.gameMenusKit.saveSlots.listSlots(); return l[1].empty ? null : l; }), 10000)) ?? (await page.evaluate(() => window.__tp.test.v1.gameMenusKit.saveSlots.listSlots()));
	h.check(!s5[1].empty && s5[1].thumb.startsWith('data:image/'), '5.1 slot 2 saved, with a picture');
	await page.locator('[data-slot="2"] .ss-main').click();
	await page.waitForTimeout(200);
	h.check(await page.locator('[data-slot-confirm]').isVisible(), '5.2 a full slot asks before it is overwritten');
	await page.getByRole('button', { name: 'Cancel' }).click();
	await page.evaluate(() => localStorage.setItem('tp:levels-save:menus-92:s3', JSON.stringify({ v: 99, at: Date.now(), slot: { name: 'Future' } })));
	await page.locator('#game-shell-menu button[aria-label="Back"]').click();
	await page.waitForTimeout(150);
	await page.evaluate(() => window.__tp.test.v1.gameState.setGameVar('coins', 1));
	await page.locator('[data-shell-item="load"]').click();
	await page.locator('[data-slot-mode="load"]').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
	h.check(await page.locator('[data-slot="3"][data-slot-newer] .ss-main').isDisabled(), '5.3 a slot made with a newer version is shown, not loadable');
	h.check(((await page.locator('[data-slot="3"]').textContent()) ?? '').includes('newer version'), '5.4 …and it says so');
	let loadClick = '';
	await page.locator('[data-slot="2"] .ss-main').click({ timeout: 8000 }).catch((e) => (loadClick = String(e?.message ?? e).split('\n').slice(0, 12).join(' | ')));
	await poll(async () => (await gameStateOf(page)).vars.coins === 42, 6000);
	const c5 = (await gameStateOf(page)).vars.coins;
	if (c5 !== 42) console.log('  5.5 state: ' + loadClick + ' || ' + JSON.stringify(await diag(page)) + ' || list: ' + (await page.locator('[data-slot-mode]').innerHTML().catch(() => '?')).slice(0, 500));
	h.check(c5 === 42, '5.5 Load game put the saved variable back (coins ' + c5 + ')');
	h.check(!(await page.locator('#game-shell-menu').isVisible()), '5.6 loading closed the menu');

	console.log('\n=== 6. the old single save shows as slot 1 and Continue loads it ===');
	await page.evaluate(() => {
		for (const n of [1, 2, 3]) localStorage.removeItem('tp:levels-save:menus-92:s' + n);
		// exactly what 1.62-1.74 wrote (gameLevels/save.js v1)
		localStorage.setItem('tp:levels-save:menus-92', JSON.stringify({ v: 1, game: 'menus-92', level: '', scene: '', point: null, kept: { vars: {} }, at: Date.now() - 1000 }));
	});
	const s6 = await page.evaluate(() => window.__tp.test.v1.gameMenusKit.saveSlots.listSlots());
	h.check(s6[0].legacy === true && s6[0].name === 'Saved progress', '6.1 slot 1 = "Saved progress" (the save from before slots)');
	await h.leavePlay(A);
	await enterPlay(page);
	await page.locator('#game-title-screen').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
	const t6 = await page.locator('#game-title-screen [data-title-item]').evaluateAll((els) => els.map((e) => e.getAttribute('data-title-item')));
	h.check(t6[0] === 'continue' && t6.includes('load'), '6.2 the title offers Continue first (' + t6 + ')');
	await page.locator('[data-title-item="continue"]').click();
	await page.waitForTimeout(800);
	const d6 = (await poll(() => page.evaluate(() => { const d = window.__tp.test.v1.gameMenusKit.saveSlots.saveSlotsDebug(); return d.loads.includes(1) ? d : null; }), 10000)) ?? (await page.evaluate(() => window.__tp.test.v1.gameMenusKit.saveSlots.saveSlotsDebug()));
	h.check(d6.loads.includes(1) && d6.active === 1, '6.3 Continue loaded slot 1 (' + JSON.stringify(d6.loads) + ')');
	h.check(!!(await page.evaluate(() => localStorage.getItem('tp:levels-save:menus-92'))), '6.4 the old save is kept until slot 1 is written');

	console.log('\n=== 7. Quit to title, Quit to editor ===');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	await page.locator('[data-shell-item="title"]').click();
	await page.waitForTimeout(300);
	const vis7 = await page.locator('#game-title-screen').waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
	if (!vis7) console.log('  7.1 state: ' + JSON.stringify(await diag(page)) + ' errors: ' + JSON.stringify(pageErrors.slice(-5)));
	h.check(vis7, '7.1 Quit to title opened the title screen');
	await page.locator('[data-title-item="quit"]').click();
	await page.waitForTimeout(500);
	h.check((await val(page, 'isLocked')) !== true, '7.2 Quit to editor left Play');

	console.log('\n=== 8. a third peer joins mid-Play; the host admits without leaving Play ===');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await page.evaluate(() => window.__tp.test.v1.gameState.setGameVar('coins', 99));
	await enterPlay(page);
	// the title opens on entering Play (a lazy chunk): wait for it, then play
	await page.locator('[data-title-item="play"]').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
	if (await page.locator('[data-title-item="play"]').isVisible().catch(() => false)) await page.locator('[data-title-item="play"]').click();
	await page.waitForTimeout(400);
	// section 7 left Play, so the abandon watch may have reset the round: start it again
	await page.evaluate(() => window.__tp.test.v1.gameState.setGameState('playing'));
	await B.page.evaluate(() => window.__tp.test.v1.playMode.requestPlay());
	await page.waitForTimeout(1200);
	const C = await h.setupPage(browser, 'C');
	await (await h.openDial(C.page)).fill(A.id);
	await C.page.getByRole('button', { name: 'Connect', exact: true }).click();
	await page.locator('#play-join-card').waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
	const vis8 = await page.locator('#play-join-card').isVisible();
	if (!vis8) console.log('  8.1 state: ' + JSON.stringify(await diag(page)));
	h.check(vis8, '8.1 the in-game join card shows over the game');
	h.check((await val(page, 'isLocked')) === true, '8.2 the host is still playing');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);
	h.check((await gameStateOf(page)).state === 'playing', '8.3 another player is in Play: the menu did NOT pause the game');
	h.check(await page.locator('#game-shell-running').isVisible(), '8.4 …and says so');
	await page.locator('[data-shell-item="joins"]').click();
	let clickError = '';
	await page.locator('[data-join-admit]').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
	// on this busy four-page run Playwright's stability probe never answers (it stalls in "waiting for … stable" with
	// no reason); the hit test below proves Admit is the TOP element at its centre, so a real mouse click there is
	// exactly what a person does — force skips only the probe
	const top = await page.evaluate(() => {
		const b = document.querySelector('[data-join-admit]');
		if (!b) return false;
		const r = b.getBoundingClientRect();
		return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b;
	});
	h.check(top, '8.4a the Admit button is the top element under the pointer (nothing covers it)');
	const admitted = await page.locator('[data-join-admit]').first().click({ timeout: 8000, force: true }).then(() => true, (e) => ((clickError = String(e?.message ?? e).split('\n').filter((l) => !/waiting \d+ms|retrying click/.test(l)).slice(0, 40).join(' | ')), false));
	const under = await page.evaluate(() => {
		const b = document.querySelector('[data-join-admit]');
		if (!b) return null;
		const r = b.getBoundingClientRect();
		return { rect: [r.x, r.y, r.width, r.height], stack: document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2).slice(0, 5).map((e) => e.tagName + (e.id ? '#' + e.id : '') + '.' + String(e.className).slice(0, 40)) };
	});
	if (!admitted) console.log('  8.x under Admit: ' + JSON.stringify(under));
	if (!admitted) console.log('  8.x the Admit button: ' + clickError + ' || ' + JSON.stringify(await diag(page)) + ' || list: ' + (await page.locator('#game-join-requests').innerHTML().catch(() => '?')).slice(0, 600));
	h.check(admitted, '8.4b the Join requests page lists the card with Admit');
	const cOpen = await poll(() => openTo(C, A.id), 45000);
	h.check(!!cOpen, '8.5 the third peer is in');
	h.check((await val(page, 'isLocked')) === true, '8.6 the host never left Play');
	const cVars = await poll(async () => ((await gameStateOf(C.page)).vars.coins === 99 ? 99 : null), 20000);
	h.check(cVars === 99, '8.7 the joiner has the game state (coins 99)');
	await page.locator('[data-shell-item="resume"]').click().catch(() => {});

	console.log('\n=== 9. Auto-admit while playing ===');
	await page.evaluate(() => window.__tp.test.v1.gameMenusKit.gameMenusPlan.setGameMenus({ autoAdmit: true }));
	// a fourth page on the loaded Deck took the whole browser down: C leaves entirely (its context too) first
	await h.closePeer(C);
	await page.waitForTimeout(1500);
	const D = await h.setupPage(browser, 'D');
	await (await h.openDial(D.page)).fill(A.id);
	await D.page.getByRole('button', { name: 'Connect', exact: true }).click();
	const dOpen = await poll(() => openTo(D, A.id), 45000);
	h.check(!!dOpen, '9.1 let in with no card while the host plays');
	const j9 = await page.evaluate(() => window.__tp.test.v1.gameMenusKit.playJoins.playJoinsDebug());
	h.check(j9.admitted.includes(D.id), '9.2 counted as an automatic admission (' + JSON.stringify(j9.admitted) + ')');
	h.check((await val(page, 'isLocked')) === true, '9.3 the host is still playing');

	console.log('\n=== 10. the joiner reloads: the game state is intact ===');
	await h.freshReload(B);
	await h.answerRestore(B).catch(() => {});
	const bBack = await poll(() => openTo(B, A.id), 60000);
	h.check(!!bBack, '10.1 the reloaded peer is back in the session');
	const bVars = await poll(async () => ((await gameStateOf(B.page)).vars.coins === 99 ? 99 : null), 20000);
	h.check(bVars === 99, '10.2 and holds the game state (coins 99)');
	const menusB = await B.page.evaluate(() => { let v; window.__tp.test.v1.scenePhysics.scenePhysicsState_.subscribe((x) => (v = x))(); return v.play?.menus ?? null; });
	h.check(menusB?.title?.title === 'Menu Test' && menusB?.autoAdmit === true, '10.3 the authored menus replicated to the joiner');

	if (pageErrors.length) console.log('page errors:\n  ' + pageErrors.slice(-20).join('\n  '));
	await h.finish(browser);
});
