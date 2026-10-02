// 33 (L4) — GAME B NEVER INHERITS GAME A, the other two ordered pairs the brief names
// (scene-switch.test.cjs owns Waves -> Towers and the dialogs):
//   1 Untangle -> Stars Room with the setting on "Unload modules" (no ask, a toast says it):
//     Untangle's board, music, levels and its "Board" settings row leave; Stars Room plays
//   2 Football -> Jam Room through the ask: Football is listed and unloaded, the Jam Room's own
//     modules (music-lab, music-fx — needed by B) are NOT listed and stay; its world loads
//   3 an Explorer Open (travelToLevel askModules + freshGame) starts the scene's OWN game state —
//     the Jam round and its variable do not carry into Towers; a travel-NODE hop still carries
// The same real artefacts as scene-switch (staged scenes + module zips). Skip-never-fail.
const h = require('./helpers.cjs');
const { setup, ev } = require('./sceneSwitchShared.cjs');

h.run(async () => {
	const S = await setup(['untangle', 'stars-room', 'football', 'jam-room', 'towers'], ['untangle', 'football', 'music-lab', 'music-fx']);
	const { page, scenes, openGame, opened, loaded, dbg, names, rootGroups, music, shell, notes, interact } = S;
	const count = async () => (await names()).length;

	// ---- 1: Untangle -> Stars Room, setting "Unload modules" ------------------------------
	try {
		await openGame('untangle');
		await ev(() => page.evaluate(() => window.__stores.sceneSwitch.sceneSwitchDebug().used), (u) => u.includes('untangle'), '1.1 Untangle opened and uses the untangle module');
		await opened();
		await interact(true);
		await ev(rootGroups, (g) => g.includes('untangle-module'), '1.2 Untangle draws its board (a scene-root group)', 15000);
		await ev(shell, (s) => s.rows.some((r) => r === 'untangle:board'), '1.3 its "Board" row is in the game Settings', 15000);
		const m0 = await music();
		console.log('  (info) untangle music: ' + JSON.stringify(m0));
		await page.evaluate(() => window.__stores.sceneSwitch.modulesOnOpen.set('unload'));
		const asks = (await dbg()).asks;
		await openGame('stars-room');
		await ev(names, (n) => n.filter((x) => /^Star \d+$/.test(x)).length === 24, '1.4 Stars Room opened (24 stars)');
		await opened();
		h.check((await dbg()).asks === asks, '1.5 the setting decided — no ask');
		h.check(!(await loaded()).includes('untangle'), '1.6 untangle is unloaded');
		h.check(!(await rootGroups()).includes('untangle-module'), '1.7 its board left the scene');
		const m = await music();
		h.check(m?.owner !== 'untangle', `1.8 no Untangle music (${JSON.stringify(m)})`);
		const s = await shell();
		h.check(!s.rows.some((r) => r.startsWith('untangle:')) && s.levelsOwner !== 'untangle', `1.9 no Untangle levels or settings rows (${s.levelsOwner}, ${s.rows})`);
		h.check((await notes()).some((t) => /Unloaded \(your setting\) .*[Uu]ntangle/.test(t)), '1.10 a toast says the setting unloaded it');
		h.check(s.isGame === true, '1.11 Stars Room is a game (its start screen)');
		await interact(false);
		await page.evaluate(() => window.__stores.sceneSwitch.modulesOnOpen.set('ask'));
	} catch (error) {
		h.check(false, '1 threw: ' + error.message);
	}

	// ---- 2: Football -> Jam Room through the ask ------------------------------------------
	try {
		await openGame('football');
		await ev(() => page.evaluate(() => window.__stores.sceneSwitch.sceneSwitchDebug().used), (u) => u.includes('football'), '2.1 Football opened and uses the football module');
		await opened();
		await interact(true);
		await page.waitForTimeout(1500);
		await openGame('jam-room');
		await ev(() => page.locator('#confirm-keep-modules').isVisible(), (v) => v, '2.2 opening the Jam Room asks');
		const items = await page.locator('#confirm-dialog-items li').allTextContents();
		h.check(items.length === 1 && /Football/i.test(items[0]), `2.3 it lists Football only — not the Jam Room's own music-lab / music-fx (${items.join(' | ')})`);
		await page.locator('#confirm-dialog-unload').click();
		await ev(() => page.evaluate(() => window.__stores.sceneSwitch.sceneSwitchDebug().used), (u) => u.includes('music-lab') || u.includes('music-fx'), '2.4 the Jam Room opened and uses its modules');
		await opened();
		const ids = await loaded();
		h.check(!ids.includes('football'), `2.5 football is unloaded (${ids})`);
		h.check(ids.includes('music-lab') && ids.includes('music-fx'), '2.6 the Jam Room\'s own modules stay loaded');
		const n = await names();
		h.check(!n.some((x) => /^(Ball|Goal (Home|Away))$/i.test(x)), `2.7 no Football object in the Jam Room (${n.slice(0, 12).join(', ')}…)`);
		const m = await music();
		h.check(m?.owner !== 'football', `2.8 no Football music (${JSON.stringify(m)})`);
		h.check((await count()) > 0, `2.9 the Jam Room's world loaded (${await count()} objects)`);
		await interact(false);
	} catch (error) {
		h.check(false, '2 threw: ' + error.message);
	}

	// ---- 3: an Explorer Open starts the scene's OWN game; the travel node still carries ----
	try {
		const towersArr = [...scenes['towers']];
		const hash = await page.evaluate(async (arr) => {
			const item = await window.__stores.levels.addSceneFromBytes(new Uint8Array(arr).buffer, 'Towers switch copy', null);
			return item?.hash ?? null;
		}, towersArr);
		h.check(!!hash, '3.1 a Towers scene in the Library to open');
		const plantVars = () =>
			page.evaluate(() => {
				window.__stores.gameState.setGameState('playing');
				window.__stores.gameState.setGameVar('jamScore', 42);
			});
		const game = () => page.evaluate(() => window.__stores.gameState.gameStateSnapshot());
		// the Explorer's Open (what openSceneItem passes): ask + fresh game
		await plantVars();
		const p = page.evaluate((hash) => window.__stores.levels.travelToLevel(hash, '', { askModules: true, freshGame: true }), hash);
		await ev(() => page.locator('#confirm-keep-modules').isVisible(), (v) => v, '3.2 the Explorer Open asks about the Jam Room modules');
		await page.locator('#confirm-dialog-unload').click();
		h.check((await p) === true, '3.3 the open happened');
		const g = await game();
		h.check(!g || (!('jamScore' in (g.vars ?? {})) && g.state !== 'playing'), `3.4 Towers starts with ITS OWN game state — no Jam round, no jamScore (${JSON.stringify(g)})`);
		h.check(!(await loaded()).includes('music-lab'), '3.5 the Jam Room modules were unloaded');
		// the travel NODE path (no opts): fork 3's campaign carry is unchanged
		await plantVars();
		await page.evaluate((hash) => window.__stores.levels.travelToLevel(hash, ''), hash);
		const g2 = await game();
		h.check(g2?.vars?.jamScore === 42 && g2.state === 'playing', `3.6 a travel-node hop still CARRIES the round (${JSON.stringify(g2)})`);
	} catch (error) {
		h.check(false, '3 threw: ' + error.message);
	}

	await h.finish(S.browser);
});
