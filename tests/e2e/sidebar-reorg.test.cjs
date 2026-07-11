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
	await A.page.evaluate(() => window.__stores.modulesOpen.set(false));
	await A.page.locator('#open-sessions-manager').click();
	await A.page.waitForTimeout(300);
	h.check((await read('sessionsOpen')) === true, 'Sessions opens the manager');
	await A.page.evaluate(() => window.__stores.sessionsOpen.set(false));
	await A.page.waitForTimeout(200);

	// --- Explorer gains a Packs entry that opens the pack browser ---
	await A.page.evaluate(() => window.__stores.explorerClose?.set(false));
	await A.page.waitForTimeout(400);
	const packs = await A.page.evaluate(() => {
		const btn = document.querySelector('#packs-folder');
		if (!btn) return { present: false };
		btn.click();
		let libClosed;
		window.__stores.libraryClose.subscribe((v) => (libClosed = v))();
		window.__stores.libraryClose.set(true);
		return { present: true, opened: libClosed === false };
	});
	h.check(packs.present, 'the Explorer has a Packs entry');
	h.check(packs.opened, 'the Packs entry opens the pack browser');

	await h.finish(browser);
});
