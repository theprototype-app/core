// 92-int (claude:9 ruling 2) — VR PLAY IS NEVER BLOCKED BEHIND AN INVISIBLE TITLE. The title screen is DOM-only
// (a headset draws no DOM; the follow-up card "title + pause as a VR panel" will draw it there), so a headset
// entering Play on a scene WITH a title skips it and starts the game the way the title's Play would: a new game
// in the first empty save slot, nothing paused, no title store open, and the headset's game menu offers no
// "Quit to title". On an EMULATED QUEST (IWER, iwer.cjs): the app's own WebXR path end to end.
//
//  1 premise: a game with a title + saves; the desktop editor Play opens ON the title (the 2D behaviour)
//  2 Enter VR (the Play button on an XR-capable device) -> Interact, and the title is passed, not open
//  3 the game runs: not paused by a menu, slot 1 written (a new game), the runtime said why (vr-skip)
//  4 the headset's game menu: Save / Load are there, Quit to title is not; the title cannot be opened in VR
//  5 the session ends: back on a screen, a desktop Play opens on the title again
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const one = (page, path) =>
	page.evaluate((p) => {
		let obj = window.__tp.test.v1;
		for (const k of p.split('.')) obj = obj[k];
		let v;
		obj.subscribe((x) => (v = x))();
		return v;
	}, path);

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

const state = (page) =>
	page.evaluate(() => {
		const s = window.__tp.test.v1;
		const get = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const k = s.gameMenusKit;
		return {
			vr: get(s.isVRMode),
			mode: get(s.editorMode),
			locked: get(s.isLocked),
			title: get(k.gameMenus.titleScreen),
			passed: k.gameMenus.titleWasPassed(),
			pause: get(k.gameMenus.menuPause),
			game: get(s.gameState.gameState).state,
			items: k.titleActions.titleDebug().items,
			slots: k.saveSlots.saveSlotsDebug()
		};
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript() });
	const P = A.page;
	P.on('pageerror', (e) => console.log('pageerror: ' + String(e?.message ?? e).slice(0, 300)));
	h.check(await iwer.installed(P), 'premise: IWER owns navigator.xr');

	await P.evaluate(() => window.__tp.test.v1.commandsHandler.sceneCommand('/create box'));
	await P.waitForTimeout(400);
	// a game (a spawn makes it one: Play in a headset lands in Interact) with a title screen and save slots
	await P.evaluate(() => {
		const s = window.__tp.test.v1;
		s.gameKit.gameSettings.forceGameId('menus-92-vr');
		for (const n of [1, 2, 3]) localStorage.removeItem('tp:levels-save:menus-92-vr:s' + n);
		localStorage.removeItem('tp:levels-save:menus-92-vr');
		s.scenePhysics.setScenePhysics({ play: { spawn: { position: [0, 0, 4], yaw: 0 } } });
		s.gameMenusKit.gameMenusPlan.setGameMenus({ title: { title: 'VR Title Test' }, saves: true });
	});
	await P.waitForTimeout(500);
	const menus = await P.evaluate(() => { let v; window.__tp.test.v1.scenePhysics.scenePhysicsState_.subscribe((x) => (v = x))(); return v.play; });
	h.check(!!menus?.menus?.title && !!menus?.spawn, 'premise: the scene has a spawn and a title screen (' + JSON.stringify(Object.keys(menus ?? {})) + ')');

	console.log('\n=== 1. on a screen, Play opens on the title ===');
	await P.evaluate(() => window.__tp.test.v1.playMode.requestPlay({ flat: true }));
	const flat = await poll(async () => { const st = await state(P); return st.title.open ? st : null; }, 10000);
	h.check(!!flat?.title.open, '1.1 a flat Play opens on the title screen (premise for the VR rows)');
	await h.leavePlay(A);
	await P.waitForTimeout(600);
	const back = await state(P);
	h.check(!back.title.open && !back.passed, '1.2 leaving Play closes the title and forgets it was passed (' + JSON.stringify({ open: back.title.open, passed: back.passed }) + ')');

	console.log('\n=== 2. Enter VR: the title is passed, never open ===');
	await iwer.enter(P);
	await iwer.pose(P, 'head', [0, 1.6, 4]);
	await iwer.frames(P, 10);
	const vr = await poll(async () => { const st = await state(P); return st.vr && st.mode === 'interact' && st.passed ? st : null; }, 15000) ?? (await state(P));
	h.check(vr.vr === true && vr.mode === 'interact', '2.1 the headset plays in Interact (' + JSON.stringify({ vr: vr.vr, mode: vr.mode, locked: vr.locked }) + ')');
	h.check(vr.title.open === false, '2.2 no title screen is open in the headset (nobody could see it)');
	h.check(vr.passed === true, '2.3 the title counts as passed');
	h.check(vr.items.includes('vr-skip'), '2.4 the game was started past the title (' + JSON.stringify(vr.items) + ')');

	console.log('\n=== 3. the game runs ===');
	h.check(vr.pause === null, '3.1 no menu pause is held (' + vr.pause + ')');
	h.check(vr.game !== 'paused', '3.2 the round is not paused (' + vr.game + ')');
	const slots = await poll(async () => { const st = await state(P); return st.slots.writes.includes(1) ? st.slots : null; }, 10000) ?? (await state(P)).slots;
	h.check(slots.active === 1 && slots.writes.includes(1), '3.3 a new game in slot 1, as the title\'s Play does (' + JSON.stringify({ active: slots.active, writes: slots.writes }) + ')');
	await iwer.frames(P, 30);
	const later = await state(P);
	h.check(!later.title.open && later.pause === null, '3.4 thirty frames later still no title and no pause');

	console.log('\n=== 4. the headset\'s game menu ===');
	const vrItems = await P.evaluate(() => window.__tp.test.v1.gameKit.gameShell.shellMenuItems({ vr: true }).map((i) => i.id));
	h.check(vrItems.includes('save') && vrItems.includes('load'), '4.1 the headset menu offers Save game / Load game (' + vrItems + ')');
	h.check(!vrItems.includes('title'), '4.2 ...and no Quit to title (it would open a title nobody sees)');
	const deskItems = await P.evaluate(() => window.__tp.test.v1.gameKit.gameShell.shellMenuItems({ vr: false }).map((i) => i.id));
	h.check(deskItems.includes('title'), '4.3 the desktop menu keeps Quit to title (' + deskItems + ')');
	const opened = await P.evaluate(() => window.__tp.test.v1.gameMenusKit.gameMenus.openTitleScreen('play'));
	h.check(opened === false && (await state(P)).title.open === false, '4.4 the title cannot be opened while in VR');

	console.log('\n=== 5. the session ends ===');
	await iwer.exit(P);
	await P.waitForTimeout(800);
	await P.evaluate(() => {
		const s = window.__tp.test.v1;
		// IWER's end() normally clears it through the app's sessionend; set it only if it lingers
		let v; s.isVRMode.subscribe((x) => (v = x))();
		if (v) s.isVRMode.set(false);
	});
	await P.waitForTimeout(500);
	const after = await state(P);
	h.check(after.vr === false && after.passed === false, '5.1 back on a screen, the title is no longer passed (' + JSON.stringify({ vr: after.vr, passed: after.passed, mode: after.mode }) + ')');
	await P.evaluate(() => window.__tp.test.v1.playMode.requestPlay({ flat: true }));
	const again = await poll(async () => { const st = await state(P); return st.title.open ? st : null; }, 10000);
	h.check(!!again?.title.open, '5.2 a desktop Play opens on the title again');
	await h.leavePlay(A).catch(() => {});

	await browser.close();
});
