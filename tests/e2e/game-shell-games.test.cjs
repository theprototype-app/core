// 31 (K3) G4 ACCEPTANCE — "Fix menu in all games, I should be able to enter main menu during
// game in any game." The SEVEN Games-tab games, loaded from their REAL .tpscene files with
// their REAL module zips, each: enter Play mid-game, open the pause menu, Resume, open it
// again, Main menu — then the same in VR (emulated: the left X button through the real
// per-frame path, the rows pressed on the game panel).
//
// Scenes: SHELL_SCENES_DIR=<dir with <slug>/scene.tpscene> (a lane's staged set), else the
// sibling scenes checkout's games/<slug>/scene.tpscene. Modules: the sibling modules
// checkout's zips. A game whose scene or zip is missing is SKIPPED (named), never failed.
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_REPO = [path.resolve(__dirname, '../../../theprototype.app-scenes'), path.resolve(__dirname, '../../../scenes')].find((p) => fs.existsSync(p));
const sceneOf = (slug) => {
	const dir = process.env.SHELL_SCENES_DIR;
	const p = dir ? path.join(dir, slug, 'scene.tpscene') : SCENES_REPO && path.join(SCENES_REPO, 'games', slug, 'scene.tpscene');
	return p && fs.existsSync(p) ? p : null;
};
const GAMES = [
	{ slug: 'towers', modules: ['collectible'] },
	{ slug: 'stars-room', modules: [] },
	{ slug: 'football', modules: ['football'] },
	{ slug: 'jam-room', modules: ['music-lab', 'music-fx'] },
	{ slug: 'dungeon-realms', modules: ['dungeon', 'dungeon-realms'] },
	{ slug: 'untangle', modules: ['untangle'] },
	{ slug: 'waves', modules: ['health', 'waves'] }
];
const EVIDENCE = process.env.EVIDENCE_DIR || '';

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	const installed = new Set();
	for (const id of [...new Set(GAMES.flatMap((g) => g.modules))]) if (await h.installModule(A, id)) installed.add(id);
	await page.evaluate(() => window.__stores.modulesOpen.set(false));
	await page.waitForTimeout(300);
	const g = (p) =>
		page.evaluate((p) => {
			let o = window.__stores;
			for (const k of p.split('.')) o = o[k];
			let v;
			o.subscribe((x) => (v = x))();
			return v;
		}, p);

	for (const game of GAMES) {
		const file = sceneOf(game.slug);
		const missing = game.modules.filter((m) => !installed.has(m));
		if (!file || missing.length) {
			console.log('SKIP ' + game.slug + ': ' + (file ? 'no ' + missing.join(', ') + '.zip' : 'no scene.tpscene'));
			continue;
		}
		console.log('\n=== ' + game.slug + ' ===');
		const bytes = Array.from(fs.readFileSync(file));
		await page.evaluate(async (arr) => {
			const s = window.__stores;
			s.templatesModalOpen.set(false);
			const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
			await s.sessions.applySession(payload, { backup: false });
		}, bytes);
		await page.waitForTimeout(3000);
		const id = await page.evaluate(() => window.__stores.gameKit.gameSettings.currentGameId());
		h.check(id === game.slug, game.slug + ': the game id is its slug (' + id + ')');
		h.check(await page.evaluate(() => window.__stores.gameKit.gameShell.shellSceneIsGame()), game.slug + ': the shell sees a game');

		// ---- desktop
		await page.evaluate(() => window.__stores.playMode.requestPlay());
		await page.waitForTimeout(800);
		h.check((await g('isLocked')) === true, game.slug + ': premise: in Play');
		await page.keyboard.press('Escape');
		await page.waitForTimeout(400);
		h.check(await page.locator('#game-shell-menu').isVisible(), game.slug + ': Escape mid-game opens the pause menu');
		if (EVIDENCE) await page.screenshot({ path: path.join(EVIDENCE, 'menu-desktop-' + game.slug + '.png') });
		await page.locator('[data-shell-item="resume"]').click();
		await page.waitForTimeout(300);
		h.check(!(await page.locator('#game-shell-menu').isVisible()) && (await g('isLocked')) === true, game.slug + ': Resume goes back into the game');
		await page.locator('#game-shell-menu-button').click();
		await page.waitForTimeout(200);
		await page.locator('[data-shell-item="mainmenu"]').click();
		await page.waitForTimeout(700);
		const after = await page.evaluate(() => {
			const s = window.__stores;
			const r = {};
			s.isLocked.subscribe((v) => (r.locked = v))();
			s.templatesModalOpen.subscribe((v) => (r.open = v))();
			s.gameKit.gameMusic.gameMusicState.subscribe((v) => (r.music = v))();
			return r;
		});
		h.check(after.locked !== true && after.open === true && after.music === null, game.slug + ': Main menu leaves Play to the Games tab, music off (' + JSON.stringify(after) + ')');
		await page.evaluate(() => window.__stores.templatesModalOpen.set(false));
		await page.waitForTimeout(500);

		// ---- VR (emulated)
		await page.evaluate(() => {
			window.__stores.isVRMode.set(true);
			window.__stores.objectActions.setEditorMode('interact');
		});
		await xr.install(page);
		await xr.setOn(page, true);
		await page.waitForTimeout(300);
		await xr.button(page, 'left', 4, true);
		await page.waitForTimeout(250);
		await xr.button(page, 'left', 4, false);
		await page.waitForTimeout(200);
		h.check((await g('gameKit.gameShell.shellMenu')).open === true, game.slug + ' VR: the left X opens the pause menu');
		const vr = await page.evaluate(() => {
			const s = window.__stores;
			const T = s.THREE;
			const k = s.gameKit.vrGamePanel;
			const head = { position: new T.Vector3(0, 1.6, 0), quaternion: new T.Quaternion() };
			k.vrGamePanelFrame({ head, hands: [null, null] });
			const ids = k.vrGamePanelDebug().hits['vr-game-panel'].map((x) => x.id);
			const rect = k.vrGamePanelDebug().hits['vr-game-panel'].find((x) => x.id === 'shell:item:resume');
			const ok = rect ? k.pressPanelTarget({ surface: 'vr-game-panel', hit: rect, point: head.position.clone(), distance: 1 }) : false;
			let open;
			s.gameKit.gameShell.shellMenu.subscribe((v) => (open = v.open))();
			return { ids, ok, open };
		});
		h.check(vr.ids.includes('shell:item:mainmenu') && vr.ok && vr.open === false, game.slug + ' VR: the board shows the menu and Resume closes it (' + JSON.stringify(vr) + ')');
		await xr.button(page, 'left', 4, true);
		await page.waitForTimeout(250);
		await xr.button(page, 'left', 4, false);
		await page.waitForTimeout(200);
		const vr2 = await page.evaluate(() => {
			const s = window.__stores;
			const T = s.THREE;
			const k = s.gameKit.vrGamePanel;
			const head = { position: new T.Vector3(0, 1.6, 0), quaternion: new T.Quaternion() };
			k.vrGamePanelFrame({ head, hands: [null, null] });
			const rect = k.vrGamePanelDebug().hits['vr-game-panel'].find((x) => x.id === 'shell:item:mainmenu');
			const ok = rect ? k.pressPanelTarget({ surface: 'vr-game-panel', hit: rect, point: head.position.clone(), distance: 1 }) : false;
			const r = { ok };
			s.editorMode.subscribe((v) => (r.mode = v))();
			s.templatesModalOpen.subscribe((v) => (r.open = v))();
			return r;
		});
		h.check(vr2.ok && vr2.mode === 'edit' && vr2.open === true, game.slug + ' VR: Main menu leaves the game (' + JSON.stringify(vr2) + ')');
		await xr.uninstall(page);
		await page.evaluate(() => {
			window.__stores.isVRMode.set(false);
			window.__stores.templatesModalOpen.set(false);
		});
		await page.waitForTimeout(400);
	}
	await h.finish(browser);
});
