// 33 (L2/L4) — OPENING ANOTHER SCENE ASKS ABOUT THE MODULES THE LAST ONE BROUGHT, AND GAME B
// NEVER INHERITS GAME A. The user (2026-10-01): "opened waves game, then towers — music from
// waves stays and the gun, but only objects from towers load"; "when opening another scene it
// should ask whether to keep all modules … the default is to ask".
//
// The REAL artefacts (sceneSwitchShared.cjs): the games' .tpscene files (preview-1-18) and the
// module zips, installed through the real Modules manager, opened through the Games-tab path
// (`loadRemoteScene`: module prompt, size gate, the keep/unload ask, backup stash, replace).
// Sibling suites: scene-switch-keep (Keep / Remember / the setting / live Enable),
// scene-switch-clear (Clear scene + the Blank card), scene-switch-games (the other two pairs).
//   1 a TOOL module no scene uses is never asked about (six installed, Towers opens silently)
//   2 Waves -> Towers, Ask -> Unload: the modal lists Waves + Health; afterwards Waves' music,
//     root group (the gun), frame tasks and objects are gone and Towers' twelve levels show
const h = require('./helpers.cjs');
const { setup, ev, section } = require('./sceneSwitchShared.cjs');

h.run(async () => {
	const S = await setup(['waves', 'towers'], ['health', 'waves', 'untangle', 'football', 'music-lab', 'music-fx']);
	const { page } = S;

	await section('1 tools', async () => {
		await S.openGame('towers');
		await ev(() => S.hasObject('Towers game'), (v) => v, '1.1 Towers opened with six modules installed and none used');
		await S.opened();
		const d = await S.dbg();
		h.check(d.asks === 0, `1.2 no keep/unload ask — nothing came WITH the blank scene (asks ${d.asks})`);
		h.check((await S.loaded()).filter((id) => S.zips[id]).length === 6, '1.3 all six installed modules still loaded');
		h.check(d.policy === 'ask', `1.4 the default setting is Ask (${d.policy})`);
	});

	await section('2 waves to towers unload', async () => {
		await S.openGame('waves');
		await ev(() => S.hasObject('Enemy 01'), (v) => v, '2.1 Waves opened (its enemies are in the world)');
		await S.opened();
		h.check((await S.dbg()).asks === 0, '2.2 leaving Towers asked nothing — Towers came with no user module');
		const used = (await S.dbg()).used;
		h.check(used.includes('waves') && used.includes('health'), `2.3 the scene USES waves and health (${used})`);
		await S.interact(true);
		await ev(S.music, (m) => m?.owner === 'waves', "2.4 Waves' own music plays in Interact (owner waves)", 20000);
		h.check((await S.rootGroups()).includes('waves-module'), '2.5 the Waves module draws its scene-root content (its gun lives there)');
		const tasksWithWaves = await S.frameTasks();

		await S.openGame('towers');
		await ev(() => page.locator('#confirm-keep-modules').isVisible(), (v) => v, '2.6 opening Towers ASKS: "Keep the loaded modules?"');
		const items = await page.locator('#confirm-dialog-items li').allTextContents();
		h.check(items.length === 2 && items.some((t) => /Waves/.test(t)) && items.some((t) => /Health/i.test(t)), `2.7 it lists exactly the modules Waves brought (${items.join(' | ')})`);
		h.check(!items.some((t) => /untangle|football|music/i.test(t)), '2.8 and none of the tools no scene uses');
		h.check((await page.locator('#confirm-dialog-unload').textContent()).trim() === 'Unload', '2.9 Unload is the first (primary) answer');
		await page.locator('#confirm-dialog-unload').click();
		await ev(() => S.hasObject('Towers game'), (v) => v, '2.10 Towers opened after Unload');
		await S.opened();
		const ids = await S.loaded();
		h.check(!ids.includes('waves') && !ids.includes('health'), `2.11 Waves and Health are unloaded (${ids})`);
		const off = await S.disabled();
		h.check(off.includes('waves') && off.includes('health'), `2.12 and switched off in the Modules manager (${off})`);
		h.check(!(await S.rootGroups()).includes('waves-module'), '2.13 the Waves root (the gun) left the scene');
		const m = await S.music();
		h.check(m?.owner !== 'waves', `2.14 Waves' music stopped (now: ${JSON.stringify(m)})`);
		h.check(!(await S.hasObject('Enemy 01')), '2.15 no Waves object is in the Towers world');
		const after = await S.frameTasks();
		h.check(after < tasksWithWaves, `2.16 Waves' frame tasks went with it (${tasksWithWaves} -> ${after})`);
		const s = await S.shell();
		h.check(s.levelsOwner === 'towers' && s.levels === 12, `2.17 the pause menu shows Towers' twelve levels (${s.levelsOwner}, ${s.levels})`);
		h.check(s.helpOwner === 'towers', `2.18 and Towers' How to play (${s.helpOwner})`);
		h.check(s.isGame === true, '2.19 Towers is a game (its menu screen)');
		h.check((await S.notes()).some((t) => /^Unloaded .*(Waves|Health)/.test(t)), '2.20 a toast says what was unloaded and how to get it back');
		await S.interact(false);
	});

	await h.finish(S.browser);
});
