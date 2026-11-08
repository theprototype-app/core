// Roadmap #9 fix: a LEFT-docked window's topbar (dock/close buttons) was covered
// by the app-sidebar (z-hud > z-drawer), worst on narrow screens; the left dock then
// inset past the open menu. dock-fixes B (owner 2026-11-08) REVERSES the inset: the menu
// OVERLAYS the left column (--z-popover, above every sidebar) and never relayouts it —
// shoving the column sideways pushed a left-docked Configure Scene over the right one.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// restore the object-list docked to the LEFT (skip the drag gesture)
	await A.page.evaluate(() => localStorage.setItem('dockedWindows', JSON.stringify({ left: 'objects', right: null })));
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.objectActions, { timeout: 30000 });
	await A.page.evaluate(() => window.__stores.objectListClose.set(false));
	await A.page.waitForTimeout(500);

	const r = await A.page.evaluate(async () => {
		const win = document.querySelector('#object-list');
		window.__stores.closeMenu.set(true); // menu closed -> no sidebar
		await new Promise((r) => setTimeout(r, 120));
		// 42 I3: the column's x is a CSS var now (--sb-left-x), so read the rendered edge
		const closedLeft = win.getBoundingClientRect().left;
		window.__stores.closeMenu.set(false); // menu open -> sidebar shown
		await new Promise((r) => setTimeout(r, 200));
		const openLeft = win.getBoundingClientRect().left;
		const sb = document.querySelector('.app-sidebar');
		const r = sb ? sb.getBoundingClientRect() : null;
		const top = r ? document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 120)) : null;
		return { docked: win.dataset.docked, closedLeft, openLeft, sbRight: r ? r.right : 0, menuOnTop: !!top?.closest('.app-sidebar') };
	});
	h.check(r.docked === 'left', `object list restored docked-left (${r.docked})`);
	h.check(r.closedLeft < 2, `menu closed: docked flush to the edge (left=${r.closedLeft})`);
	h.check(r.openLeft < 2, `menu open: the docked window keeps its edge — no relayout (left=${Math.round(r.openLeft)})`);
	h.check(r.menuOnTop, `menu open: the menu draws OVER the docked window (sidebar right=${Math.round(r.sbRight)})`);

	await h.finish(browser);
});
