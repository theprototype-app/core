// Phase 126: sidebar reorg — Library leaves the sidebar (its packs open from
// the Explorer), and the Scene group order is Configure Scene, Clear Scene,
// Modules, Sessions.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => window.__stores.closeMenu.set(false));
	await A.page.waitForTimeout(400);

	// --- Library gone; the four scene actions in order ---
	const sidebar = await A.page.evaluate(() => {
		const labels = [...document.querySelectorAll('#sidebar70 [role="listitem"], #sidebar70 li, #sidebar70 a, #sidebar70 button')]
			.map((e) => e.textContent.trim())
			.filter(Boolean);
		const has = (t) => labels.some((l) => l.includes(t));
		const idx = (t) => labels.findIndex((l) => l.includes(t));
		return {
			hasLibrary: has('Library'),
			hasModules: has('Modules'),
			hasSessions: has('Sessions'),
			order:
				idx('Configure Scene') < idx('Clear Scene') &&
				idx('Clear Scene') < idx('Modules') &&
				idx('Modules') < idx('Sessions')
		};
	});
	h.check(!sidebar.hasLibrary, 'the sidebar has no Library item');
	h.check(sidebar.hasModules && sidebar.hasSessions, 'Modules + Sessions are in the sidebar');
	h.check(sidebar.order, 'order is Configure Scene, Clear Scene, Modules, Sessions');

	// --- Modules + Sessions still open their managers ---
	const read = (s) => A.page.evaluate((name) => {
		let v;
		window.__stores[name].subscribe((x) => (v = x))();
		return v;
	}, s);
	await A.page.locator('#open-modules-manager').click();
	await A.page.waitForTimeout(300);
	h.check((await read('modulesOpen')) === true, 'Modules opens the manager');
	// opening a modal from the menu closes the menu (the menu is the top-most layer,
	// so it must not cover the modal)
	h.check((await read('closeMenu')) === true, 'opening a modal from the menu closes the menu');
	// reset fully (close the modal + its backdrop) before the next menu interaction
	await A.page.evaluate(() => window.__stores.modulesOpen.set(false));
	await A.page.waitForTimeout(400);
	await A.page.evaluate(() => window.__stores.closeMenu.set(false));
	await A.page.waitForTimeout(300);
	await A.page.locator('#open-sessions-manager').click();
	await A.page.waitForTimeout(300);
	h.check((await read('sessionsOpen')) === true, 'Sessions opens the manager');
	await A.page.evaluate(() => window.__stores.sessionsOpen.set(false));
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => window.__stores.closeMenu.set(false));
	await A.page.waitForTimeout(200);

	// --- Explorer gains a Packs entry; single-click opens the packs GRID view
	// (roadmap-8 P4 replaced the old 126 library-drawer stopgap) ---
	await A.page.evaluate(() => window.__stores.explorerClose?.set(false));
	await A.page.waitForTimeout(400);
	const packs = await A.page.evaluate(() => {
		const btn = document.querySelector('#packs-folder');
		if (!btn) return { present: false };
		btn.click();
		let folder;
		window.__stores.explorer.activeFolder.subscribe((v) => (folder = v))();
		return { present: true, opened: folder === 'packs' };
	});
	h.check(packs.present, 'the Explorer has a Packs entry');
	h.check(packs.opened, 'the Packs entry opens the packs grid view');

	await h.finish(browser);
});
