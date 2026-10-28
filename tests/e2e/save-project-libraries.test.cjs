// ROADMAP 56 C13 (addendum 2026-10-28f) — SAVE PROJECT WITH SEVERAL LIBRARIES OPEN.
//
//   1. one library open → Ctrl+S saves it straight away, no dialog (byte-identical to before);
//   2. my Library + a session I joined → Ctrl+S opens ONE dialog, the ACTIVE connection's library
//      (the session) pre-checked and mine not; Cancel saves nothing;
//   3. Save with "Remember my choice" (only the active one ticked) → the setting becomes
//      "Save the active one", and the session's scene is saved ON THE HOST;
//   4. with that setting, Ctrl+S AND the burger's Save (Project) save the active one with no dialog,
//      and nothing is saved into my own Library;
//   5. a viewer → the session row is disabled with the reason, and Save has nothing to save;
//   6. the dialog's link opens Settings ▸ Save options ▸ "When several libraries are open" (Ask).
//
// Run: APP_URL='https://localhost:5482/' npm run e2e -- save-project-libraries
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
	h.check((await setting(G)) === 'ask', 'premise: "When several libraries are open" defaults to Ask');

	// ---- 1. one library: no dialog ------------------------------------------------------------
	await G.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1300));
		s.objectActions.deselectObject();
		await s.levels.saveSceneAsLevel('Solo', null);
	});
	const soloBefore = await ownScenes(G);
	await G.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 1000));
	});
	await ctrlS(G);
	// the Library is the durable proof (a toast can come and go between two polls on a loaded machine)
	await h.eventually(() => ownScenes(G), (now) => now.some((x) => !soloBefore.includes(x)), 'alone with one library, Ctrl+S saves the scene into my own Library (a new version)', 30000);
	h.check(!(await dialogOpen(G)), '…with no dialog');

	// back to an empty unnamed world before joining (the connect decision is not this suite's)
	await G.page.evaluate(async () => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const uuids = (g?.children ?? []).map((c) => c.uuid);
		if (uuids.length) s.objectActions.deleteObjectsByUuid(uuids);
		s.levels.currentLevel.set(null);
	});
	await H.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1300));
		s.objectActions.deselectObject();
		await s.levels.saveSceneAsLevel('Castle', null);
	});
	await G.page.waitForTimeout(800);
	await h.connect(G, H);
	await h.eventually(
		() => G.page.evaluate(() => { let v; window.__stores.sessionVolumes.sessionVolumes.subscribe((x) => (v = x))(); return v.length; }),
		(n) => n === 1,
		"premise: G has joined H's session (two libraries open)",
		30000
	);
	const volId = await G.page.evaluate(() => { let v; window.__stores.sessionVolumes.sessionVolumes.subscribe((x) => (v = x))(); return v[0].id; });

	// ---- 2. several: the dialog, the active one pre-checked -----------------------------------
	const mineBefore = await ownScenes(G);
	await ctrlS(G);
	// 30 s: the first press loads the dialog's lazy chunk, which a cold dev server transforms on demand
	await h.eventually(() => dialogOpen(G), (o) => o === true, 'with two libraries open, Ctrl+S asks which (the dialog)', 30000);
	const rows = await G.page.evaluate(() =>
		[...document.querySelectorAll('[data-save-row]')].map((r) => ({
			id: r.getAttribute('data-save-row'),
			active: r.getAttribute('data-active'),
			checked: !!r.querySelector('input[type=checkbox]')?.checked,
			disabled: !!r.querySelector('input[type=checkbox]')?.disabled,
			text: r.textContent.replace(/\s+/g, ' ').trim()
		}))
	);
	const own = rows.find((r) => r.id === 'library');
	const sess = rows.find((r) => r.id === volId);
	h.check(rows.length === 2 && !!own && !!sess, `…listing My Library and the session (${rows.map((r) => r.id).join(', ')})`);
	h.check(sess?.active === 'true' && sess.checked && !own?.checked, 'the ACTIVE connection (the session) is pre-checked, my Library is not');
	h.check(/Save on host/.test(sess?.text ?? '') && /This device/.test(own?.text ?? ''), `each row says where it saves (${sess?.text} | ${own?.text})`);
	await G.page.locator('#save-many-cancel').click();
	await h.eventually(() => dialogOpen(G), (o) => o === false, 'Cancel closes it', 5000);
	await G.page.waitForTimeout(1500);
	h.check((await hostSaves(H)) === 0 && JSON.stringify(await ownScenes(G)) === JSON.stringify(mineBefore), '…and saves nothing anywhere');

	// ---- 3. Save + Remember my choice ---------------------------------------------------------
	await ctrlS(G);
	await h.eventually(() => dialogOpen(G), (o) => o === true, 'the dialog again', 30000);
	await G.page.locator('#save-many-remember').check();
	await G.page.locator('#save-many-save').click();
	await h.eventually(() => hostSaves(H), (n) => n === 1, 'Save saves the session scene ON THE HOST', 30000);
	h.check((await setting(G)) === 'active', `"Remember my choice" with only the active one ticked sets "Save the active one" (${await setting(G)})`);
	h.check(JSON.stringify(await ownScenes(G)) === JSON.stringify(mineBefore), '…and my own Library was not saved into');

	// ---- 4. "Save the active one": Ctrl+S and the burger, no dialog -----------------------------
	await G.page.waitForTimeout(1500); // the first save's toasts and the dialog's focus hand-back settle
	await ctrlS(G);
	await h.eventually(() => hostSaves(H), (n) => n === 2, 'Ctrl+S now saves the active one straight away', 30000);
	if ((await hostSaves(H)) !== 2) {
		console.log('  G toasts:', JSON.stringify(await toasts(G)));
		console.log('  G log:', JSON.stringify((await debug(G)).log.slice(-8)));
		console.log('  H log:', JSON.stringify((await debug(H)).log.slice(-8)));
		console.log('  G focus:', await G.page.evaluate(() => document.activeElement?.tagName + '#' + document.activeElement?.id));
	}
	h.check(!(await dialogOpen(G)), '…with no dialog');
	await G.page.evaluate(() => window.__stores.saveOptions.setSaveOptions({ format: 'tp' }));
	let downloaded = false;
	G.page.once('download', () => (downloaded = true));
	await G.page.evaluate(() => window.__stores.closeMenu.set(false));
	await G.page.waitForSelector('#sidebar70', { timeout: 5000 });
	await G.page.waitForTimeout(350);
	const burgerSave = G.page.locator('#sidebar70 #project-save, #sidebar70 #save-project').first();
	if ((await burgerSave.count()) === 1) {
		await burgerSave.click();
		await h.eventually(() => hostSaves(H), (n) => n === 3, "the burger's Save (Project) follows the same setting", 30000);
		await G.page.waitForTimeout(1500);
		h.check(!downloaded && !(await dialogOpen(G)), '…no dialog, and no project file of my own was written');
	} else h.check(false, 'premise: the burger shows a Save row (#project-save)');
	await G.page.evaluate(() => window.__stores.closeMenu.set(true));
	h.check(JSON.stringify(await ownScenes(G)) === JSON.stringify(mineBefore), 'through all of it, my own Library was never saved into');

	// ---- 5. a viewer: the session row is disabled with the reason -------------------------------
	await G.page.evaluate(() => window.__stores.saveOptions.setSaveOptions({ saveMany: 'ask' }));
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
