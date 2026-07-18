// Roadmap #9 fix: a LEFT-docked window's topbar (dock/close buttons) was covered
// by the app-sidebar (z-hud > z-drawer), worst on narrow screens. When the menu
// is open the left dock now insets past the sidebar so its buttons stay reachable.
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
		const closedLeft = parseFloat(win.style.left) || 0;
		window.__stores.closeMenu.set(false); // menu open -> sidebar shown
		await new Promise((r) => setTimeout(r, 200));
		const openLeft = parseFloat(win.style.left) || 0;
		const sb = document.querySelector('.app-sidebar');
		const sbRight = sb ? sb.getBoundingClientRect().right : 0;
		return { docked: win.dataset.docked, closedLeft, openLeft, sbRight };
	});
	h.check(r.docked === 'left', `object list restored docked-left (${r.docked})`);
	h.check(r.closedLeft < 2, `menu closed: docked flush to the edge (left=${r.closedLeft})`);
	h.check(r.openLeft >= r.sbRight - 1, `menu open: docked window clears the sidebar (left=${Math.round(r.openLeft)} >= sidebar right=${Math.round(r.sbRight)})`);

	await h.finish(browser);
});
