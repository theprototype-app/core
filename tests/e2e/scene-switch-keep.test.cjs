// 33 (L2/L4) — KEEP, REMEMBER, THE SETTING, AND THE LIVE ENABLE (scene-switch.test.cjs owns
// the plain Ask -> Unload). Real artefacts via sceneSwitchShared.cjs.
//   1 Waves -> Towers, Ask -> Keep + "Remember my choice": Waves stays loaded but LEFT BEHIND —
//     no Waves music, levels, help, settings row or spawn in Towers; the setting reads Keep
//   2 back to Waves: no ask (the setting), Waves back in scope in its own scene, its music plays
//   3 Settings ▸ Scene shows the row with the remembered value
//   4 the setting on Unload: Towers opens with no ask, Waves unloads, a toast says the setting did it
//   5 Waves again: the "switched off" prompt's Enable brings it back LIVE (no reload)
const h = require('./helpers.cjs');
const { setup, ev, section } = require('./sceneSwitchShared.cjs');

h.run(async () => {
	const S = await setup(['waves', 'towers'], ['health', 'waves']);
	const { page } = S;

	await section('1 keep + remember', async () => {
		await S.openGame('waves');
		await ev(() => S.hasObject('Enemy 01'), (v) => v, '1.1 Waves opened');
		await S.opened();
		await S.interact(true);
		await ev(S.music, (m) => m?.owner === 'waves', '1.2 Waves plays its music', 20000);
		await S.openGame('towers');
		await ev(() => page.locator('#confirm-keep-modules').isVisible(), (v) => v, '1.3 opening Towers asks');
		h.check(/Remember my choice/.test(await page.locator('#confirm-keep-modules label').textContent()), '1.4 "Remember my choice" is offered');
		await page.locator('#confirm-dialog-check').check();
		await page.locator('#confirm-dialog-keep').click();
		await ev(() => S.hasObject('Towers game'), (v) => v, '1.5 Towers opened after Keep');
		await S.opened();
		const d = await S.dbg();
		h.check((await S.loaded()).includes('waves'), '1.6 Waves is still loaded (kept)');
		h.check(d.leftBehind.includes('waves') && d.leftBehind.includes('health'), `1.7 but LEFT BEHIND — Towers does not use it (${d.leftBehind})`);
		h.check(d.policy === 'keep', `1.8 Remember wrote the setting: keep (${d.policy})`);
		await page.waitForTimeout(1500); // a kept module's frame tasks keep running — give them time to try
		const m = await S.music();
		h.check(m?.owner !== 'waves', `1.9 no Waves music in Towers although Waves is kept (${JSON.stringify(m)})`);
		const s = await S.shell();
		h.check(s.levelsOwner === 'towers' && s.helpOwner === 'towers', `1.10 the menu is Towers' — levels ${s.levelsOwner}, help ${s.helpOwner}`);
		h.check(!s.rows.some((r) => r.startsWith('waves:') || r.startsWith('health:')), `1.11 no Waves row in Settings (${s.rows})`);
		const raw = await page.evaluate(() => { let v; window.__stores.playSettings.runtimeSpawn.subscribe((x) => (v = x))(); return v; });
		const spawn = await page.evaluate(() => {
			let sc;
			window.__stores.globalScene.subscribe((v) => (sc = v))();
			return window.__stores.playSettings.resolvePlaySettings(sc).spawn ?? null;
		});
		h.check(raw?.owner === 'waves', `1.12 premise: Waves set a runtime spawn (${JSON.stringify(raw)})`);
		h.check(JSON.stringify(spawn?.position) !== JSON.stringify(raw?.position), `1.13 Waves' spawn does not place the Towers player (${JSON.stringify(spawn)})`);
	});

	await section('2 back to waves, no ask', async () => {
		const asks = (await S.dbg()).asks;
		await S.openGame('waves');
		await ev(() => S.hasObject('Enemy 01'), (v) => v, '2.1 back to Waves');
		await S.opened();
		const d = await S.dbg();
		h.check(d.asks === asks, '2.2 opening a scene that NEEDS the kept modules asks nothing');
		h.check(!d.leftBehind.includes('waves'), `2.3 Waves is back in scope in its own scene (${d.leftBehind})`);
		await ev(S.music, (m) => m?.owner === 'waves', '2.4 and its music plays again', 20000);
	});

	await section('3 settings row', async () => {
		await page.evaluate(() => {
			window.__stores.settingsSection.set('scene');
			window.__stores.settingsOpen.set(true);
		});
		await ev(() => page.locator('#modules-on-open').isVisible(), (v) => v, '3.1 Settings ▸ Scene has the row', 10000);
		const text = (await page.locator('#modules-on-open').textContent()).trim();
		h.check(/Keep modules/.test(text), `3.2 "When opening another scene" reads Keep modules (${text})`);
		await page.evaluate(() => window.__stores.settingsOpen.set(false));
		await page.waitForTimeout(400);
	});

	await section('4 setting unload', async () => {
		await page.evaluate(() => window.__stores.sceneSwitch.modulesOnOpen.set('unload'));
		const asks = (await S.dbg()).asks;
		await S.openGame('towers');
		await ev(() => S.hasObject('Towers game'), (v) => v, '4.1 Towers opened');
		await S.opened();
		h.check((await S.dbg()).asks === asks, '4.2 the setting decided — no ask');
		h.check(!(await S.loaded()).includes('waves'), '4.3 Waves unloaded by the setting');
		h.check((await S.notes()).some((t) => /^Unloaded \(your setting\)/.test(t)), '4.4 a toast says the setting unloaded it');
		await page.evaluate(() => window.__stores.sceneSwitch.modulesOnOpen.set('ask'));
	});

	await section('5 enable live', async () => {
		await S.openGame('waves');
		await ev(() => page.locator('#confirm-dialog-enable').isVisible(), (v) => v, '5.1 Waves asks to switch its modules back on');
		await page.locator('#confirm-dialog-enable').click();
		await ev(S.loaded, (ids) => ids.includes('waves') && ids.includes('health'), '5.2 Enable loads them LIVE, no reload', 30000);
		await ev(() => S.hasObject('Enemy 01'), (v) => v, '5.3 and Waves opens');
		await S.opened();
		await ev(S.music, (m) => m?.owner === 'waves', '5.4 the re-enabled Waves plays', 20000);
		await S.interact(false);
	});

	await h.finish(S.browser);
});
