// Dock exclusivity refinement: the Explorer and the Flow-family share ONE dock slot,
// so activating a DOCKED Node editor closes the Explorer. But when the Node editor is
// FLOATING (undocked) it does not compete for the dock, so clicking it must NOT close
// a docked Explorer. Closing only happens when BOTH are docked.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// Node editor floating, Explorer docked
	await A.page.evaluate(() => {
		localStorage.setItem('flowDocked', 'false');
		localStorage.setItem('explorerDocked', 'true');
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		s.explorerClose.set(false);
		s.bottomDock.bottomDockActive.set('explorer');
	});
	await A.page.waitForTimeout(700);

	const before = await A.page.evaluate(() => {
		const s = window.__stores;
		let ec, k;
		s.explorerClose.subscribe((v) => (ec = v))();
		s.bottomDock.visibleDockKey.subscribe((v) => (k = v))();
		return { explorerClosed: ec, visible: k, floatWin: !!document.getElementById('flow-window') };
	});
	h.check(before.explorerClosed === false && before.visible === 'explorer' && before.floatWin, `setup: Explorer docked+visible, Node editor floating (visible=${before.visible})`);

	// click Node editor -> Explorer stays open (floating flow doesn't take the dock)
	await A.page.evaluate(() => document.querySelector('p[title="Node editor (N)"]').click());
	await A.page.waitForTimeout(300);
	const afterClick = await A.page.evaluate(() => {
		let ec;
		window.__stores.explorerClose.subscribe((v) => (ec = v))();
		return { explorerClosed: ec };
	});
	h.check(afterClick.explorerClosed === false, 'clicking Node editor with a FLOATING flow does NOT close the docked Explorer');

	// contrast: DOCK the Node editor -> now both compete for the slot, Explorer closes
	await A.page.evaluate(() => document.getElementById('flow-dock')?.click());
	await A.page.waitForTimeout(500);
	const afterDock = await A.page.evaluate(() => {
		const s = window.__stores;
		let ec, k;
		s.explorerClose.subscribe((v) => (ec = v))();
		s.bottomDock.visibleDockKey.subscribe((v) => (k = v))();
		return { explorerClosed: ec, visible: k };
	});
	h.check(afterDock.explorerClosed === true && afterDock.visible === 'flow', `docking the Node editor (both docked) closes the Explorer (visible=${afterDock.visible})`);

	await h.finish(browser);
});
