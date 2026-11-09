// showhide-v8 §6 — THE BURGER, DIRECTION A: Windows ▸, and opening the menu fetches nothing.
//
//   1. opening the burger makes no network request (the counterfactual: a request made by the page right after
//      is seen by the same listener)
//   2. Windows ▸ lists the windows with their shortcuts, an open mark on the open ones, then Focus mode / Full
//      screen / Reset positions and sizes / Close all floating windows
//   3. a click on an OPEN window's row reveals it and never closes it; on a closed one it opens it
//   4. Close all floating windows closes the floating ones and leaves a docked one open
//
// Run: APP_URL=https://theprototype.app:6995/ npm run e2e -- burger-windows
const h = require('./helpers.cjs');

const read = (page, path) =>
	page.evaluate((p) => {
		let v;
		const [a, b] = p.split('.');
		(b ? window.__stores[a][b] : window.__stores[a]).subscribe((x) => (v = x))();
		return v;
	}, path);
const menuRows = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemcheckbox"]')].map((e) => ({
			text: (e.textContent ?? '').trim(),
			checked: e.classList.contains('ctx-checked')
		}))
	);
const openBurger = async (page) => {
	await page.evaluate(() => window.__stores.closeMenu.set(false));
	await page.waitForSelector('#sidebar70', { timeout: 5000 });
	await page.waitForTimeout(400);
};

h.run(async () => {
	const browser = await h.launch();
	const P = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = P.page;
	await page.waitForTimeout(2500);

	// --- 1: no fetch on open ---
	const seen = [];
	const onReq = (r) => {
		const u = r.url();
		if (/^data:|^blob:|\/@vite\/|\/node_modules\/|\/src\/|\.svelte|\.js(\?|$)|\.css(\?|$)|\/@fs\//.test(u)) return; // code the dev server lazily serves is not a fetch
		seen.push(r.method() + ' ' + u.slice(0, 120));
	};
	page.on('request', onReq);
	await openBurger(page);
	await page.waitForTimeout(1200);
	const during = seen.splice(0);
	await page.evaluate(() => fetch('/robots.txt').catch(() => null));
	await page.waitForTimeout(400);
	const control = seen.splice(0);
	page.off('request', onReq);
	h.check(control.some((u) => /robots\.txt/.test(u)), `1.1 (counterfactual) the listener sees a request the page makes (${JSON.stringify(control)})`);
	h.check(during.length === 0, `1.2 opening the burger makes no request (${JSON.stringify(during)})`);

	// --- 2: the menu ---
	await page.evaluate(() => window.__stores.explorerClose.set(false));
	await page.waitForTimeout(800);
	await page.locator('#open-windows-menu').click();
	await page.waitForSelector('[role="menu"]', { timeout: 5000 });
	let rows = await menuRows(page);
	const names = rows.map((r) => r.text);
	console.log('windows menu', JSON.stringify(rows));
	h.check(names.some((t) => /^Node editor/.test(t)) && names.some((t) => /^Explorer/.test(t)) && names.some((t) => /^Code/.test(t)), '2.1 the windows are listed');
	h.check(names.some((t) => /Explorer.*Alt\+E/.test(t)), '2.2 ...with their shortcuts');
	h.check(rows.find((r) => /^Explorer/.test(r.text))?.checked === true && rows.find((r) => /^Animation/.test(r.text))?.checked === false, '2.3 an open mark on the open window only');
	const tail = names.slice(-4).map((t) => t.replace(/Ctrl\+Space$/, '').trim());
	h.check(JSON.stringify(tail) === JSON.stringify(['Focus mode', 'Full screen', 'Reset positions and sizes', 'Close all floating windows']), `2.4 then the window commands (${JSON.stringify(tail)})`);

	// --- 3: reveal, never close ---
	await page.locator('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemcheckbox"]').filter({ hasText: /^Explorer/ }).first().click();
	await page.waitForTimeout(600);
	h.check((await read(page, 'explorerClose')) === false, '3.1 a click on the open Explorer keeps it open (reveals)');
	await openBurger(page);
	await page.locator('#open-windows-menu').click();
	await page.waitForSelector('[role="menu"]', { timeout: 5000 });
	await page.locator('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemcheckbox"]').filter({ hasText: /^Animation/ }).first().click();
	await page.waitForTimeout(900);
	h.check((await read(page, 'animationClose')) === false, '3.2 a click on a closed window opens it');

	// --- 4: close all floating ---
	await page.evaluate(() => {
		localStorage.setItem('timelineDocked', 'false');
		window.__stores.bottomDock.dockModeArm.set({ key: 'timeline', docked: false });
		window.__stores.timelineClose.set(false);
	});
	await page.waitForTimeout(900);
	const before = await page.evaluate(() => window.__stores.dockMenu.windowWhere('timeline'));
	await openBurger(page);
	await page.locator('#open-windows-menu').click();
	await page.waitForSelector('[role="menu"]', { timeout: 5000 });
	await page.locator('[role="menu"] [role="menuitem"]').filter({ hasText: 'Close all floating windows' }).click();
	await page.waitForTimeout(700);
	const after = await page.evaluate(() => ['timeline', 'animation', 'explorer'].map((k) => [k, window.__stores.dockMenu.windowWhere(k)]));
	h.check(before === 'floating', `4.0 (premise) the Timeline floats (${before})`);
	h.check(after.find((x) => x[0] === 'timeline')[1] === null, `4.1 Close all floating windows closes it (${JSON.stringify(after)})`);
	h.check(after.filter((x) => x[0] !== 'timeline').every((x) => x[1] !== 'floating'), '4.2 nothing floating is left');
	h.check(after.some((x) => x[1] === 'dock' || x[1] === 'left' || x[1] === 'right'), '4.3 ...and a docked or sidebar window stays open');

	await h.finish(browser);
});
