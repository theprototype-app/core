// 31 (K3) — THE GAME SHELL. The user, on a Quest 3: "Fix menu in all games, I should be able
// to enter main menu during game in any game", "I should be able to disable the sound/sfx/
// music on each game … all of them should be able to show FPS", "pick level does not show in
// vr". One pause menu in every game, desktop and VR, per-game settings core obeys, levels.
//
//  1 a fixture game: Escape in Play opens the pause menu (not an exit), the pointer is freed
//  2 Resume closes it and play goes on; Escape toggles
//  3 Settings: SFX off in game A silences playSound there, NOT in game B; music/sfx buses
//  4 Levels (api.game.levels): the picker lists, a locked level refuses, a pick reaches onPick
//  5 Restart: the game resets to its menu, a module's onRestart runs
//  6 Main menu: leaves play cleanly — music stops, the editor camera, the Games tab opens
//  7 a scene that is NOT a game: Escape still leaves play (unchanged)
//  8 VR: the X button opens the menu ON THE GAME PANEL, the laser presses its rows, the
//    levels + settings pages render there, the wrist card carries a Menu button
//  9 VR turning: a game's Smooth turning turns continuously; Off never turns
// 10 haptics off in this game: no pulse
// 11 quality preset pins the governor while playing, Auto releases
// 12 Show FPS: the desktop counter + the VR strip line
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');

const MENU_GAME = {
	active: '',
	screens: [
		{
			id: 'menu',
			name: 'Menu',
			showWhile: 'menu',
			input: 'menu',
			elements: [
				{ id: 'title', kind: 'text', anchor: 'top-center', x: 0, y: 80, w: 600, h: 90, label: 'FIXTURE', style: { size: 64, align: 'center' } },
				{ id: 'start', kind: 'button', anchor: 'center', x: 0, y: 0, w: 320, h: 80, label: 'Start', style: { size: 32 } }
			]
		},
		{
			id: 'hud',
			name: 'HUD',
			showWhile: 'playing',
			elements: [{ id: 'score', kind: 'text', anchor: 'top-left', x: 24, y: 24, w: 240, h: 40, label: 'Score: 0' }]
		}
	]
};

const store = (page, path) =>
	page.evaluate((p) => {
		let obj = window.__stores;
		for (const k of p.split('.')) obj = obj[k];
		let v;
		obj.subscribe((x) => (v = x))();
		return v;
	}, path);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	await page.evaluate(async () => {
		const s = window.__stores;
		await s.moduleSDK.initModules([
			{ id: 'shellfix', name: 'Shell fixture', version: '1.0.0', description: 'the 31 game shell', register(api) { window.__api = api; } }
		]);
		s.gameKit.gameSettings.forceGameId('fixture-a');
	});
	await page.evaluate((doc) => {
		const s = window.__stores;
		s.hudDocs.setHudDocFor('scene', doc);
		s.gameState.setGameState('playing');
	}, MENU_GAME);
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(400);

	console.log('\n=== 1. Escape in Play opens the pause menu ===');
	await page.evaluate(() => window.__stores.playMode.requestPlay());
	await page.waitForTimeout(300);
	h.check((await store(page, 'isLocked')) === true, 'premise: playing');
	h.check(await page.locator('#game-shell-menu-button').isVisible(), '1.1 the corner Menu button shows in a game');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	h.check(await page.locator('#game-shell-menu').isVisible(), '1.2 Escape opened the pause menu');
	h.check((await store(page, 'isLocked')) === true, '1.3 still in Play — Escape paused, it did not exit');
	h.check((await store(page, 'playPointerFree')) === true, '1.4 the pointer is free over the menu');
	const items = await page.locator('#game-shell-menu [data-shell-item]').evaluateAll((els) => els.map((e) => e.getAttribute('data-shell-item')));
	h.check(JSON.stringify(items) === JSON.stringify(['resume', 'restart', 'settings', 'help', 'mainmenu', 'editor']), '1.5 Resume · Restart · Settings · How to play · Main menu (+ Back to editor) (' + items + ')');

	console.log('\n=== 2. Resume, and Escape toggles ===');
	await page.locator('[data-shell-item="resume"]').click();
	await page.waitForTimeout(250);
	h.check(!(await page.locator('#game-shell-menu').isVisible()), '2.1 Resume closed the menu');
	h.check((await store(page, 'isLocked')) === true && (await store(page, 'playPointerFree')) === false, '2.2 play goes on, the pointer is the game\'s again');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
	h.check(await page.locator('#game-shell-menu').isVisible(), '2.3 Escape opens it again');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
	h.check(!(await page.locator('#game-shell-menu').isVisible()) && (await store(page, 'isLocked')) === true, '2.4 and Escape closes it (Resume), still playing');

	console.log('\n=== 3. per-game settings: SFX off in game A, not in game B ===');
	await page.locator('#game-shell-menu-button').click();
	await page.locator('[data-shell-item="settings"]').click();
	await page.waitForTimeout(150);
	const rows = await page.locator('#game-shell-menu [data-shell-setting]').evaluateAll((els) => els.map((e) => e.getAttribute('data-shell-setting')));
	h.check(['music', 'musicVolume', 'sfx', 'sfxVolume', 'showFps', 'quality', 'haptics', 'turning', 'turnAngle', 'vignette'].every((id) => rows.includes(id)), '3.1 the core rows are listed (' + rows + ')');
	await page.locator('[data-shell-setting="sfx"] input[type=checkbox]').click();
	await page.waitForTimeout(100);
	const a = await page.evaluate(() => {
		const k = window.__stores.gameKit;
		const before = k.gameSfx.gameSfxDebug();
		const played = k.gameSfx.playGameSound('coin');
		const after = k.gameSfx.gameSfxDebug();
		return { played, muted: after.muted - before.muted, bus: window.__stores.audioEngine.busLevel('sfx'), stored: localStorage.getItem('tp:game:fixture-a:shell') };
	});
	h.check(a.played === false && a.muted === 1, '3.2 game A with SFX off: playSound starts nothing (' + JSON.stringify(a) + ')');
	h.check(a.bus === 0, '3.3 the sfx bus is at 0 (flow sound nodes and pings obey too)');
	h.check(/"sfx":false/.test(a.stored ?? ''), '3.4 persisted per game (tp:game:fixture-a:shell)');
	const b = await page.evaluate(() => {
		const k = window.__stores.gameKit;
		k.gameSettings.forceGameId('fixture-b');
		const played = k.gameSfx.playGameSound('coin');
		const bus = window.__stores.audioEngine.busLevel('sfx');
		k.gameSettings.forceGameId('fixture-a');
		return { played, bus, backA: window.__stores.audioEngine.busLevel('sfx') };
	});
	h.check(b.played === true && b.bus === 1, '3.5 game B is unaffected: playSound plays, bus at 1 (' + JSON.stringify(b) + ')');
	h.check(b.backA === 0, '3.6 back in game A the setting is still off');
	await page.locator('[data-shell-setting="musicVolume"] input[type=range]').fill('30');
	await page.waitForTimeout(100);
	h.check(Math.abs((await page.evaluate(() => window.__stores.audioEngine.busLevel('music'))) - 0.3) < 1e-6, '3.7 music volume 30 -> the music bus at 0.3');
	await page.evaluate(() => {
		window.__stores.gameKit.gameSettings.setGameSetting('sfx', true);
		window.__stores.gameKit.gameSettings.setGameSetting('musicVolume', 100);
	});
	await page.locator('#game-shell-menu button[aria-label="Back"]').click();

	console.log('\n=== 4. levels ===');
	await page.evaluate(() => {
		window.__picked = [];
		window.__offLevels = window.__api.game.levels({
			list: [
				{ id: 'l1', label: 'Level 1', stars: 3 },
				{ id: 'l2', label: 'Level 2', stars: 1 },
				{ id: 'l3', label: 'Level 3', locked: true }
			],
			current: 'l1',
			onPick: (id) => window.__picked.push(id)
		});
	});
	await page.waitForTimeout(100);
	const items4 = await page.locator('#game-shell-menu [data-shell-item]').evaluateAll((els) => els.map((e) => e.getAttribute('data-shell-item')));
	h.check(items4.includes('levels') && items4.indexOf('levels') === 2, '4.1 Levels appears (third) once the game registers some (' + items4 + ')');
	await page.locator('[data-shell-item="levels"]').click();
	await page.waitForTimeout(100);
	const tiles = await page.locator('[data-shell-level]').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-shell-level'), disabled: e.disabled, stars: e.querySelectorAll('svg').length })));
	h.check(tiles.length === 3 && tiles[2].disabled && tiles[0].stars === 3, '4.2 three tiles, the locked one disabled, stars drawn (' + JSON.stringify(tiles) + ')');
	const locked = await page.evaluate(() => window.__stores.gameKit.gameShell.pickGameLevel('l3'));
	h.check(locked === false, '4.3 a locked level refuses');
	await page.locator('[data-shell-level="l2"]').click();
	await page.waitForTimeout(150);
	h.check(JSON.stringify(await page.evaluate(() => window.__picked)) === '["l2"]', '4.4 the pick reached onPick');
	h.check(!(await page.locator('#game-shell-menu').isVisible()), '4.5 picking a level closes the menu (back into the game)');
	h.check((await page.evaluate(() => window.__stores.gameKit.gameShell.gameShellDebug().levels.current)) === 'l2', '4.6 the current level follows the pick');

	console.log('\n=== 5. Restart ===');
	await page.evaluate(() => {
		window.__restarts = 0;
		window.__api.game.onRestart(() => window.__restarts++);
	});
	await page.locator('#game-shell-menu-button').click();
	await page.locator('[data-shell-item="restart"]').click();
	await page.waitForTimeout(300);
	const r5 = await page.evaluate(() => {
		let st;
		window.__stores.gameState.gameState.subscribe((v) => (st = v.state))();
		return { state: st, restarts: window.__restarts };
	});
	h.check(r5.state === 'menu', '5.1 the game went back to its menu (' + r5.state + ')');
	h.check(r5.restarts === 1, '5.2 the module\'s onRestart ran');
	h.check((await store(page, 'isLocked')) === true && !(await page.locator('#game-shell-menu').isVisible()), '5.3 still playing, the menu closed');

	console.log('\n=== 6. Main menu ===');
	await page.evaluate(() => {
		window.__stores.gameState.setGameState('playing');
		window.__stores.gameKit.gameMusic.playGameMusic('arcade');
	});
	await page.waitForTimeout(150);
	h.check((await store(page, 'gameKit.gameMusic.gameMusicState')) !== null, 'premise: music plays');
	await page.locator('#game-shell-menu-button').click();
	await page.locator('[data-shell-item="mainmenu"]').click();
	await page.waitForTimeout(500);
	const r6 = await page.evaluate(() => {
		const s = window.__stores;
		let music, locked, open, cam, editorCam;
		s.gameKit.gameMusic.gameMusicState.subscribe((v) => (music = v))();
		s.isLocked.subscribe((v) => (locked = v))();
		s.templatesModalOpen.subscribe((v) => (open = v))();
		return { music, locked, open, tab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null };
	});
	h.check(r6.locked !== true, '6.1 play ended (' + r6.locked + ')');
	h.check(r6.music === null, '6.2 the music stopped');
	h.check(r6.open === true, '6.3 the app main menu (Templates / Games) is open');
	h.check(/game/i.test(r6.tab ?? ''), '6.4 on the Games tab (' + r6.tab + ')');
	h.check(!(await page.locator('#game-shell-menu-button').isVisible()), '6.5 no game chrome outside play');
	await page.evaluate(() => window.__stores.templatesModalOpen.set(false));
	await page.waitForTimeout(300);

	console.log('\n=== 7. a scene that is not a game: Escape still leaves play ===');
	await page.evaluate(() => {
		const s = window.__stores;
		window.__offLevels?.();
		s.hudDocs.setHudDocFor('scene', { active: '', screens: [] });
		s.playMode.requestPlay();
	});
	await page.waitForTimeout(300);
	h.check((await store(page, 'isLocked')) === true, 'premise: playing a plain scene');
	h.check(!(await page.evaluate(() => window.__stores.gameKit.gameShell.shellMenuAvailable())), '7.1 no pause menu offered');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	h.check((await store(page, 'isLocked')) !== true, '7.2 Escape left play as before');
	await page.evaluate((doc) => window.__stores.hudDocs.setHudDocFor('scene', doc), MENU_GAME);

	console.log('\n=== 8. VR: the menu on the game panel ===');
	await page.evaluate(() => {
		const s = window.__stores;
		s.gameState.setGameState('playing');
		s.isVRMode.set(true);
		s.objectActions.setEditorMode('interact');
	});
	await xr.install(page);
	await page.waitForTimeout(300);
	const vframe = () =>
		page.evaluate(() => {
			const s = window.__stores;
			const THREE = s.THREE;
			const head = { position: new THREE.Vector3(0, 1.6, 0), quaternion: new THREE.Quaternion() };
			const hand = { position: new THREE.Vector3(-0.1, 1.2, -0.35), quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.9, 0, 0, 'YXZ')) };
			return s.gameKit.vrGamePanel.vrGamePanelFrame({ head, hands: [hand, null] });
		});
	let f8 = await vframe();
	h.check(f8.panel === null && f8.wrist, 'premise: mid-game there is no board, only the wrist card');
	const wristIds = await page.evaluate(() => window.__stores.gameKit.vrGamePanel.vrGamePanelDebug().hits['vr-game-wrist'].map((x) => x.id));
	h.check(wristIds.includes('footer:menu'), '8.1 the wrist card carries a Menu button (' + wristIds + ')');
	// the controller's X (left, button 4) through the REAL per-frame path
	await xr.button(page, 'left', 4, true);
	await page.waitForTimeout(250);
	await xr.button(page, 'left', 4, false);
	await page.waitForTimeout(150);
	h.check((await store(page, 'gameKit.gameShell.shellMenu')).open === true, '8.2 left X opened the pause menu');
	f8 = await vframe();
	const board = await page.evaluate(() => {
		const k = window.__stores.gameKit.vrGamePanel;
		return { visible: k.vrGameSurface('vr-game-panel').mesh.visible, ids: k.vrGamePanelDebug().hits['vr-game-panel'].map((x) => x.id) };
	});
	h.check(board.visible && board.ids.includes('shell:item:resume') && board.ids.includes('shell:item:mainmenu'), '8.3 the board shows the pause menu (' + board.ids + ')');
	h.check(!board.ids.includes('shell:item:editor'), '8.4 the desktop-only Back to editor row is not on the VR board (Edit mode is on its footer)');
	// levels in VR (U5): register, press Levels with the laser, pick
	await page.evaluate(() => {
		window.__picked = [];
		window.__api.game.levels({ list: [{ id: 'g1', label: 'Globe 1' }, { id: 'g2', label: 'Globe 2', stars: 2 }, { id: 'g3', label: 'Globe 3', locked: true }], current: 'g1', onPick: (id) => window.__picked.push(id) });
	});
	await vframe();
	const press = (id) =>
		page.evaluate((id) => {
			const s = window.__stores;
			const k = s.gameKit.vrGamePanel;
			const surf = k.vrGameSurface('vr-game-panel');
			const rect = k.vrGamePanelDebug().hits['vr-game-panel'].find((x) => x.id === id);
			if (!rect) return { ok: false, why: 'no rect ' + id };
			const g = surf.mesh.geometry.parameters;
			const cx = (rect.x + rect.w / 2) / surf.canvas.width;
			const cy = (rect.y + rect.h / 2) / surf.canvas.height;
			const target = surf.mesh.localToWorld(new s.THREE.Vector3((cx - 0.5) * g.width, (0.5 - cy) * g.height, 0));
			const from = new s.THREE.Vector3(0.25, 1.3, -0.2);
			const ray = new s.THREE.Raycaster(from, target.clone().sub(from).normalize());
			const t = k.panelTargetAlong(ray);
			if (!t) return { ok: false, why: 'ray missed' };
			return { ok: k.pressPanelTarget(t), hit: t.hit.id };
		}, id);
	let p = await press('shell:item:levels');
	await vframe();
	let ids = await page.evaluate(() => window.__stores.gameKit.vrGamePanel.vrGamePanelDebug().hits['vr-game-panel'].map((x) => x.id));
	h.check(p.ok && ids.includes('shell:level:g1') && ids.includes('shell:level:g2') && !ids.includes('shell:level:g3'), '8.5 the laser opened Levels in VR: unlocked tiles press, the locked one does not (' + JSON.stringify(p) + ' ' + ids + ')');
	p = await press('shell:level:g2');
	h.check(p.ok && JSON.stringify(await page.evaluate(() => window.__picked)) === '["g2"]', '8.6 a laser pick reached onPick (' + JSON.stringify(p) + ')');
	h.check((await store(page, 'gameKit.gameShell.shellMenu')).open === false, '8.7 and closed the menu');
	// settings page in VR: step SFX off with the laser
	await page.evaluate(() => window.__stores.gameKit.gameShell.openShellMenu('settings'));
	await vframe();
	ids = await page.evaluate(() => window.__stores.gameKit.vrGamePanel.vrGamePanelDebug().hits['vr-game-panel'].map((x) => x.id));
	h.check(ids.includes('shell:set:sfx:next') && ids.includes('shell:set:turning:prev') && ids.includes('shell:back'), '8.8 the settings page in VR carries the VR rows (' + ids.filter((i) => i.startsWith('shell:set')).length + ' controls)');
	p = await press('shell:set:sfx:next');
	h.check(p.ok && (await page.evaluate(() => window.__stores.gameKit.gameSettings.gameSettingValue('sfx'))) === false, '8.9 a laser press flipped SFX off in VR');
	await page.evaluate(() => window.__stores.gameKit.gameSettings.setGameSetting('sfx', true));
	p = await press('shell:back');
	await vframe();
	p = await press('shell:item:resume');
	await vframe();
	h.check((await store(page, 'gameKit.gameShell.shellMenu')).open === false, '8.10 Resume in VR closes the board menu');
	const canvasInk = await page.evaluate(() => {
		const s = window.__stores;
		s.gameKit.gameShell.openShellMenu('main');
		const THREE = s.THREE;
		s.gameKit.vrGamePanel.vrGamePanelFrame({ head: { position: new THREE.Vector3(0, 1.6, 0), quaternion: new THREE.Quaternion() }, hands: [null, null] });
		const surf = s.gameKit.vrGamePanel.vrGameSurface('vr-game-panel');
		const g = surf.canvas.getContext('2d');
		const d = g.getImageData(0, 0, surf.canvas.width, surf.canvas.height).data;
		let ink = 0;
		for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] + d[i + 1] + d[i + 2] > 600) ink++;
		s.gameKit.gameShell.closeShellMenu();
		return ink;
	});
	h.check(canvasInk > 3000, '8.11 the VR board canvas holds the drawn menu (' + canvasInk + ' white px)');
	if (process.env.EVIDENCE_DIR) {
		for (const pg of ['main', 'levels', 'settings', 'help']) {
			const url = await page.evaluate((pg) => {
				const s = window.__stores;
				s.gameKit.gameShell.openShellMenu(pg);
				const THREE = s.THREE;
				s.gameKit.vrGamePanel.vrGamePanelFrame({ head: { position: new THREE.Vector3(0, 1.6, 0), quaternion: new THREE.Quaternion() }, hands: [null, null] });
				const url = s.gameKit.vrGamePanel.vrGameSurface('vr-game-panel').canvas.toDataURL('image/png');
				s.gameKit.gameShell.closeShellMenu();
				return url;
			}, pg);
			require('fs').writeFileSync(require('path').join(process.env.EVIDENCE_DIR, 'menu-vr-board-' + pg + '.png'), Buffer.from(url.split(',')[1], 'base64'));
		}
	}

	console.log('\n=== 9. VR turning: Smooth turns continuously, Off never turns ===');
	await xr.installSpace(page, { head: [0, 1.6, 0], yaw: 0 });
	await page.evaluate(() => window.__stores.gameKit.gameSettings.setGameSetting('turning', 'smooth'));
	let y0 = (await xr.head(page)).yaw;
	await xr.stick(page, 'right', 1, 0);
	await page.waitForTimeout(150);
	const yMid = (await xr.head(page)).yaw;
	await page.waitForTimeout(450);
	const yEnd = (await xr.head(page)).yaw;
	await xr.stick(page, 'right', 0, 0);
	const turned1 = Math.abs(Math.atan2(Math.sin(yMid - y0), Math.cos(yMid - y0)));
	const turned2 = Math.abs(Math.atan2(Math.sin(yEnd - y0), Math.cos(yEnd - y0)));
	h.check(turned1 > 0.01 && turned2 > turned1 + 0.05 && turned2 < 1.2, '9.1 smooth: the yaw keeps growing while the stick is held (' + turned1.toFixed(3) + ' -> ' + turned2.toFixed(3) + ' rad)');
	h.check((await page.evaluate(() => window.__stores.vrControls.turningInForce().mode)) === 'smooth', '9.2 the turning in force is the game\'s');
	await page.evaluate(() => window.__stores.gameKit.gameSettings.setGameSetting('turning', 'off'));
	y0 = (await xr.head(page)).yaw;
	await xr.stick(page, 'right', 1, 0);
	await page.waitForTimeout(400);
	await xr.stick(page, 'right', 0, 0);
	await page.waitForTimeout(150);
	const off = Math.abs((await xr.head(page)).yaw - y0);
	h.check(off < 1e-6, '9.3 off: a full flick turns nothing (' + off + ')');
	await page.evaluate(() => window.__stores.gameKit.gameSettings.setGameSetting('turning', 'snap'));
	await page.evaluate(() => window.__stores.gameKit.gameSettings.setGameSetting('turnAngle', '90'));
	y0 = (await xr.head(page)).yaw;
	await xr.stick(page, 'right', 1, 0);
	await page.waitForTimeout(200);
	await xr.stick(page, 'right', 0, 0);
	await page.waitForTimeout(150);
	const snap = Math.abs(Math.atan2(Math.sin((await xr.head(page)).yaw - y0), Math.cos((await xr.head(page)).yaw - y0)));
	h.check(Math.abs(snap - Math.PI / 2) < 0.02, '9.4 snap at the game\'s 90 degrees (' + ((snap * 180) / Math.PI).toFixed(1) + ' deg)');
	await page.evaluate(() => {
		window.__stores.gameKit.gameSettings.setGameSetting('turning', 'default');
		window.__stores.gameKit.gameSettings.setGameSetting('turnAngle', 'default');
	});

	console.log('\n=== 10. haptics off in this game ===');
	const hp = await page.evaluate(() => {
		const s = window.__stores;
		const before = s.vrControls.hapticDebug().pulses.length;
		s.vrControls.hapticPulse(0.6, 40);
		const on = s.vrControls.hapticDebug().pulses.length - before;
		s.gameKit.gameSettings.setGameSetting('haptics', false);
		const mid = s.vrControls.hapticDebug().pulses.length;
		s.vrControls.hapticPulse(0.6, 40);
		s.vrControls.hapticPattern('success');
		const off = s.vrControls.hapticDebug().pulses.length - mid;
		s.gameKit.gameSettings.setGameSetting('haptics', true);
		return { on, off };
	});
	h.check(hp.on === 1 && hp.off === 0, '10.1 a pulse with haptics on, none with it off (' + JSON.stringify(hp) + ')');

	console.log('\n=== 11. comfort vignette ===');
	const vg = await page.evaluate(() => {
		const s = window.__stores;
		const k = s.gameKit.comfortVignette;
		const T = s.THREE;
		const head = { position: new T.Vector3(0, 1.6, 0), quaternion: new T.Quaternion() };
		k.noteArtificialMotion(1, 0);
		for (let i = 0; i < 30; i++) k.vignetteFrame(head, 1 / 72);
		const offSetting = k.vignetteDebug();
		s.gameKit.gameSettings.setGameSetting('vignette', true);
		for (let i = 0; i < 30; i++) k.vignetteFrame(head, 1 / 72);
		const moving = k.vignetteDebug();
		k.noteArtificialMotion(0, 0);
		for (let i = 0; i < 120; i++) k.vignetteFrame(head, 1 / 72);
		const still = k.vignetteDebug();
		s.gameKit.gameSettings.setGameSetting('vignette', false);
		return { offSetting, moving, still };
	});
	h.check(!vg.offSetting.visible && vg.offSetting.strength === 0, '11.1 setting off: no vignette while moving');
	h.check(vg.moving.visible && vg.moving.strength > 0.6, '11.2 setting on + the stick moving: the ring closes in (' + vg.moving.strength.toFixed(2) + ')');
	h.check(!vg.still.visible && vg.still.strength < 0.05, '11.3 standing still: it opens again (' + vg.still.strength.toFixed(3) + ')');

	console.log('\n=== 12. Show FPS in VR ===');
	const vfps = await page.evaluate(() => {
		const s = window.__stores;
		const k = s.gameKit;
		for (let i = 0; i < 20; i++) k.fpsMeter.noteXrFrame(1000 + i * (1000 / 72));
		k.gameSettings.setGameSetting('showFps', true);
		const T = s.THREE;
		const hand = { position: new T.Vector3(-0.1, 1.2, -0.35), quaternion: new T.Quaternion().setFromEuler(new T.Euler(0.9, 0, 0, 'YXZ')) };
		const f = k.vrGamePanel.vrGamePanelFrame({ head: { position: new T.Vector3(0, 1.6, 0), quaternion: new T.Quaternion() }, hands: [hand, null] });
		k.gameSettings.setGameSetting('showFps', false);
		const f2 = k.vrGamePanel.vrGamePanelFrame({ head: { position: new T.Vector3(0, 1.6, 0), quaternion: new T.Quaternion() }, hands: [hand, null] });
		return { lines: f.lines, strip: f.stripLines, lines2: f2.lines };
	});
	h.check(/^\d+ fps$/.test(vfps.lines[0] ?? '') && vfps.strip[0] === vfps.lines[0], '12.1 the fps counter leads the wrist AND the strip (' + JSON.stringify(vfps.strip) + ')');
	h.check(!vfps.lines2.some((l) => /fps$/.test(l)), '12.2 and goes when Show FPS is off');

	await xr.uninstall(page);
	await page.evaluate(() => {
		window.__stores.isVRMode.set(false);
		window.__stores.objectActions.setEditorMode('edit');
	});

	console.log('\n=== 13. quality preset while playing ===');
	await page.evaluate(() => window.__stores.playMode.requestPlay());
	await page.waitForTimeout(300);
	const q = await page.evaluate(async () => {
		const s = window.__stores;
		const gv = () => { let v; s.qualityGovernor.qualityState.subscribe((x) => (v = x))(); return v; };
		s.gameKit.gameSettings.setGameSetting('quality', 'low');
		await new Promise((r) => setTimeout(r, 50));
		const low = gv().level;
		const decided = s.qualityGovernor.decideNow().reason;
		s.gameKit.gameSettings.setGameSetting('quality', 'high');
		await new Promise((r) => setTimeout(r, 50));
		const high = gv().level;
		s.gameKit.gameSettings.setGameSetting('quality', 'medium');
		await new Promise((r) => setTimeout(r, 50));
		const medium = gv();
		s.gameKit.gameSettings.setGameSetting('quality', 'auto');
		await new Promise((r) => setTimeout(r, 50));
		const auto = gv();
		return { low, decided, high, medium: medium.level, mediumReason: medium.reason, auto: auto.level, autoReason: auto.reason };
	});
	h.check(q.low === 7 && q.decided === 'game preset', '13.1 Low pins level 7 and the governor holds it (' + JSON.stringify(q) + ')');
	h.check(q.high === 0 && q.medium === 3 && /medium/.test(q.mediumReason), '13.2 High = 0, Medium = 3');
	h.check(q.auto === 0 && /auto/.test(q.autoReason), '13.3 Auto releases the pin back to the governor');

	console.log('\n=== 14. Show FPS on the desktop ===');
	h.check(!(await page.locator('#game-fps-counter').isVisible()), '14.1 off by default');
	await page.evaluate(() => window.__stores.gameKit.gameSettings.setGameSetting('showFps', true));
	await page.waitForTimeout(1200);
	const fpsText = (await page.locator('#game-fps-counter').textContent()) ?? '';
	h.check(/\d+ fps/.test(fpsText), '14.2 the corner counter reads a live fps (' + fpsText.replace(/\s+/g, ' ').trim() + ')');
	h.check(/calls/.test(fpsText) && /tris/.test(fpsText), '14.3 with the draw calls and triangles line');
	await page.evaluate(() => window.__stores.gameKit.gameSettings.forceGameId('fixture-b'));
	await page.waitForTimeout(150);
	h.check(!(await page.locator('#game-fps-counter').isVisible()), '14.4 per game: another game keeps it off');
	await page.evaluate(() => window.__stores.gameKit.gameSettings.forceGameId('fixture-a'));
	await page.evaluate(() => window.__stores.playMode.exitPlay());
	await page.waitForTimeout(200);
	h.check(!(await page.locator('#game-fps-counter').isVisible()), '14.5 not shown in the editor');
	await h.finish(browser);
});
