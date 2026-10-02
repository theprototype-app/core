// 33 (L3) — CLEAR SCENE THAT REALLY CLEARS, AND THE BLANK CARD. The user: "after hitting clear
// scene in an opened game example I still see the Menu button and the ability to play … clear
// scene does not really clear". Real artefacts via sceneSwitchShared.cjs.
//   1 the modal on a game: "Clear objects" primary, the box OFF, its hint names the setup + modules
//   2 objects only: the objects go, the game setup stays (as chosen) and a toast says what is left
//   3 with no objects the box starts ON ("Clear everything"): no game chip, no flow, no HUD, the
//     play block and game state reset, the scene's modules unloaded, no pause menu
//   4 the Templates "Blank scene" card: "Start a blank scene?" -> a full reset, and Towers'
//     levels / How to play leave WITH its scene (a core module that used to leave them registered)
const h = require('./helpers.cjs');
const { setup, ev, section } = require('./sceneSwitchShared.cjs');

h.run(async () => {
	const S = await setup(['waves', 'towers'], ['health', 'waves']);
	const { page } = S;
	const openClear = async (label) => {
		if (!(await page.locator('#clear-scene').isVisible())) {
			await page.locator('#logo-menu').click();
			await page.waitForTimeout(400);
		}
		const t0 = Date.now();
		await page.locator('#clear-scene').click();
		await ev(() => page.locator('#confirm-clear-scene').isVisible(), (v) => v, label, 20000);
		const ms = Date.now() - t0;
		// it took ~15 s on a Waves scene when the setup check awaited six dynamic imports
		h.check(ms < 8000, label + `: the modal answers the click promptly (${ms} ms)`);
		h.check(!(await page.locator('#clear-scene').isVisible()), label + ': and the menu closed behind it');
	};

	await section('1 the modal', async () => {
		await S.openGame('waves');
		await ev(() => S.hasObject('Enemy 01'), (v) => v, '1.1 Waves opened');
		await S.opened();
		await openClear('1.2 Clear Scene opens a modal (not a toast)');
		h.check((await page.locator('#confirm-dialog-check').isChecked()) === false, '1.3 the box starts OFF (a Clear is about objects)');
		h.check((await page.locator('#confirm-dialog-clear').textContent()).trim() === 'Clear objects', '1.4 the primary says "Clear objects"');
		const hint = await page.locator('#confirm-clear-scene label').textContent();
		h.check(/game menu/.test(hint) && /Waves/.test(hint) && /flow nodes/.test(hint), `1.5 the box names what else it resets and unloads (${hint.trim().slice(0, 160)})`);
		await page.locator('#confirm-dialog-check').check();
		h.check((await page.locator('#confirm-dialog-clear').textContent()).trim() === 'Clear everything', '1.6 ticking it turns the button into "Clear everything"');
		await page.locator('#confirm-dialog-check').uncheck();
		h.check((await page.locator('#confirm-dialog-clear').textContent()).trim() === 'Clear objects', '1.7 and unticking turns it back');
	});

	await section('2 objects only', async () => {
		await page.locator('#confirm-dialog-clear').click();
		await ev(S.names, (n) => n.length === 0, '2.1 objects-only: the objects are gone', 20000);
		h.check((await S.shell()).isGame === true, '2.2 the game setup stays (the menu is still there — as chosen)');
		h.check((await S.loaded()).includes('waves'), '2.3 and the modules stay loaded');
		h.check((await S.notes()).some((t) => /Still here: .*game menu/.test(t) && /Waves/.test(t)), '2.4 a toast says what is still here');
	});

	await section('3 clear everything', async () => {
		await openClear('3.1 Clear Scene again');
		h.check((await page.locator('#confirm-dialog-check').isChecked()) === true, '3.2 with no objects left the box starts ON');
		h.check((await page.locator('#confirm-dialog-clear').textContent()).trim() === 'Clear everything', '3.3 so the button says "Clear everything"');
		await page.locator('#confirm-dialog-clear').click();
		await ev(S.shell, (s) => s.isGame === false, '3.4 the scene is no longer a game', 20000);
		h.check((await page.locator('#game-chip').count()) === 0, '3.5 no game chip (the leftover Menu/Play the user saw)');
		const after = await page.evaluate(() => ({
			nodes: window.__stores.allNodes().length,
			hud: window.__stores.hudDocs.hudDocsSnapshot(),
			play: window.__stores.scenePhysics.scenePhysicsSnapshot(),
			game: window.__stores.gameState.gameStateSnapshot(),
			env: window.__stores.environment.environmentSnapshot()
		}));
		h.check(after.nodes === 0, `3.6 no flow nodes (${after.nodes})`);
		h.check(after.hud === null && after.game === null, '3.7 no HUD, game state pristine');
		h.check(after.play === null && after.env === null, `3.8 the play block and the sky are back to defaults (${JSON.stringify([after.play, after.env]).slice(0, 120)})`);
		h.check(!(await S.loaded()).includes('waves') && !(await S.loaded()).includes('health'), "3.9 the scene's modules are unloaded");
		h.check(!(await S.rootGroups()).includes('waves-module'), '3.10 their content left the scene');
		h.check((await page.evaluate(() => window.__stores.gameKit.gameShell.shellMenuAvailable())) === false, '3.11 no pause menu for the cleared scene');
		h.check(!(await S.notes()).some((t) => /^Session loaded: Untitled/.test(t)), '3.12 and no misleading "Session loaded" toast');
	});

	await section('4 blank card', async () => {
		await S.openGame('towers');
		await ev(() => S.hasObject('Towers game'), (v) => v, '4.1 Towers');
		await S.opened();
		await ev(S.shell, (s) => s.levelsOwner === 'towers' && s.helpOwner === 'towers', '4.2 premise: Towers registered its levels and help', 20000);
		await page.locator('#logo-menu').click();
		await page.waitForTimeout(300);
		await page.locator('#open-templates').click();
		await page.waitForTimeout(600);
		await page.locator('#template-blank').click();
		await ev(() => page.locator('#confirm-blank-scene').isVisible(), (v) => v, '4.3 "Start a blank scene?"', 10000);
		await page.locator('#confirm-dialog-blank').click();
		await ev(S.names, (n) => n.length === 0, '4.4 a blank scene', 20000);
		// 33 integrate: since 33-scene-load the apply is SLICED — the objects empty before the HUD and
		// play block are replaced, so wait for the state instead of reading the first instant
		await ev(S.shell, (v) => v.isGame === false, '4.5 not a game any more', 15000);
		const s = await S.shell();
		h.check(s.levelsOwner === null && s.helpOwner === null, `4.6 Towers' levels and help left with its scene (${s.levelsOwner}, ${s.helpOwner})`);
	});

	await h.finish(S.browser);
});
