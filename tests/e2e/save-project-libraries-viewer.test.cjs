// ROADMAP 56 C13 (addendum 2026-10-28f) — SAVE PROJECT WITH SEVERAL LIBRARIES OPEN, part 2 of 2
// (part 1: save-project-libraries — one library, the dialog, Remember, Ctrl+S and the burger).
//
//   5. a viewer → the session row is disabled with the reason, and Save has nothing to save;
//   6. the dialog's link opens Settings ▸ Save options ▸ "When several libraries are open" (Ask),
//      and the row writes the setting.
//
// Run: APP_URL='https://localhost:5482/' npm run e2e -- save-project-libraries-viewer
const h = require('./helpers.cjs');

const debug = (p) => p.page.evaluate(() => window.__stores.sessionVolumes.volumeDebug());
const hostSaves = async (H) => (await debug(H)).log.filter((l) => /^volsave from .+: saved /.test(l)).length;
const dialogOpen = (p) => p.page.locator('#save-many-dialog').isVisible().catch(() => false);
const toasts = (p) => p.page.evaluate(() => [...document.querySelectorAll('.tp-toast')].map((t) => t.innerText.trim()));
const setting = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.saveOptions.saveOptions.subscribe((x) => (v = x))();
		return v.saveMany;
	});
const ownScenes = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return (v ?? []).filter((i) => i.kind === 'scene').map((i) => i.hash);
	});
const ctrlS = async (p) => {
	await p.page.evaluate(() => /** @type {any} */ (document.activeElement)?.blur?.());
	await p.page.keyboard.press('Control+s');
};

h.run(async () => {
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H');
	const G = await h.setupPage(browser, 'G');
	for (const peer of [H, G]) {
		await peer.page.waitForFunction(() => !!window.__stores?.sessionVolumes && !!window.__stores?.saveOptions && !!window.__stores?.levels, null, {
			timeout: 60000
		});
		await peer.page.evaluate(async () => {
			const s = window.__stores;
			await s.explorer.loadExplorer();
			await s.explorer.clearLibrary();
			s.levels.currentLevel.set(null);
		});
	}
	await H.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1300));
		s.objectActions.deselectObject();
		await s.levels.saveSceneAsLevel('Castle', null);
	});
	await h.connect(G, H);
	await h.eventually(
		() => G.page.evaluate(() => { let v; window.__stores.sessionVolumes.sessionVolumes.subscribe((x) => (v = x))(); return v.length; }),
		(n) => n === 1,
		"premise: G has joined H's session (two libraries open)",
		60000
	);
	const volId = await G.page.evaluate(() => { let v; window.__stores.sessionVolumes.sessionVolumes.subscribe((x) => (v = x))(); return v[0].id; });
	h.check((await setting(G)) === 'ask', 'premise: the setting is Ask');

	// ---- 5. a viewer: the session row is disabled with the reason -------------------------------
	await H.page.evaluate((gid) => {
		window.__stores.cloudHooks.rolesInfo.set({ myId: 'host', myRole: 'admin', amAdmin: true, order: [], roleOf: (id) => (id === gid ? 'viewer' : 'editor'), setRole() {} });
	}, G.id);
	await h.eventually(
		() => G.page.evaluate(() => { let v; window.__stores.sessionVolumes.sessionVolumes.subscribe((x) => (v = x))(); return v[0]?.role; }),
		(r) => r === 'viewer',
		'premise: H made G a viewer',
		15000
	);
	await ctrlS(G);
	await h.eventually(() => dialogOpen(G), (o) => o === true, 'the dialog for the viewer', 30000);
	const vrow = await G.page.evaluate((id) => {
		const r = document.querySelector('[data-save-row="' + id + '"]');
		return { disabled: !!r?.querySelector('input')?.disabled, text: r?.textContent.replace(/\s+/g, ' ').trim() ?? '' };
	}, volId);
	h.check(vrow.disabled && /view-only/.test(vrow.text), `the session row is disabled with the reason (${vrow.text})`);
	h.check(await G.page.locator('#save-many-save').isDisabled(), '…and with nothing ticked, Save is disabled');

	// ---- 6. the link to the setting -------------------------------------------------------------
	await G.page.locator('#save-many-setting').click();
	await h.eventually(() => dialogOpen(G), (o) => o === false, 'the link closes the dialog', 5000);
	await h.eventually(() => G.page.locator('#row-save-many').isVisible().catch(() => false), (v) => v === true, '…and opens Settings ▸ Save options ▸ "When several libraries are open"', 10000);
	h.check((await G.page.locator('#save-many-setting-seg-ask').getAttribute('aria-checked')) === 'true', '…showing Ask');
	await G.page.locator('#save-many-setting-seg-all').click();
	h.check((await setting(G)) === 'all', 'the row writes the setting ("Save all I can")');
	await H.page.evaluate(() => window.__stores.cloudHooks.rolesInfo.set(null));

	await h.finish(browser);
});
