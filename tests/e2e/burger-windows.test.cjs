// showhide-v8 §6 — THE BURGER, DIRECTION A: Windows ▸, and opening the menu fetches nothing.
//
//   0. the regroup: search on top, then File · Scene · Versions · Window · Help, "Clear scene…" last in Scene, and
//      Settings + the version as a footer that stays in view when the menu scrolls (premise: on a short window the
//      menu DOES scroll and the last Help row is below its bottom edge)
//   1. opening the burger makes no network request (the counterfactual: a request made by the page right after
//      is seen by the same listener)
//   2. Windows ▸ lists the windows with their shortcuts, an open mark on the open ones, then Focus mode / Full
//      screen / Reset positions and sizes / Close all floating windows
//   3. a click on an OPEN window's row reveals it and never closes it; on a closed one it opens it
//   4. Close all floating windows closes the floating ones and leaves a docked one open
//   5. the switches: Lock layout stops a header drag (the counterfactual: unlocked, the same drag moves it); Snap to
//      edges lands a window dragged near the left edge flush on it (off: it stays where it was dropped); Remember
//      layout per scene puts a scene's windows back when it opens again (off: nothing comes back)
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

	// --- 0: the direction A order + the footer ---
	const order = await page.evaluate(() => {
		const nav = document.querySelector('#sidebar70');
		const kids = [...nav.querySelectorAll('.side-label, #open-command-palette, #clear-scene, #open-sessions-manager, #open-windows-menu, #open-settings, #open-version, #report-problem')];
		return kids.map((e) => (e.classList.contains('side-label') ? 'L:' + e.textContent.trim() : '#' + e.id));
	});
	const want = ['#open-command-palette', 'L:File', 'L:Scene', '#clear-scene', 'L:Versions', '#open-sessions-manager', 'L:Window', '#open-windows-menu', 'L:Help', '#report-problem', '#open-settings', '#open-version'];
	h.check(JSON.stringify(order) === JSON.stringify(want), `0.1 search, File, Scene (Clear scene… last), Versions, Window, Help, footer (${JSON.stringify(order)})`);
	const lastScene = await page.evaluate(() => {
		const rows = [...document.querySelectorAll('#sidebar70 > *')];
		const i = rows.findIndex((e) => e.id === 'clear-scene');
		return { prev: rows[i - 1]?.className ?? '', next: rows[i + 1]?.className ?? '', text: rows[i]?.textContent.trim() };
	});
	h.check(/side-div/.test(lastScene.prev) && /side-div/.test(lastScene.next) && lastScene.text === 'Clear scene…', `0.2 "Clear scene…" sits alone behind a divider (${JSON.stringify(lastScene)})`);
	h.check((await page.locator('#open-version').innerText()).trim().match(/^\d+\.\d+\.\d+/), '0.3 the footer shows the version');
	h.check((await page.locator('#sidebar70 .side-row', { hasText: 'Undo' }).count()) === 0, '0.4 no Undo / Redo row (owner)');
	await page.evaluate(() => window.__stores.closeMenu.set(true));
	await page.setViewportSize({ width: 1440, height: 560 });
	await openBurger(page);
	const foot = await page.evaluate(() => {
		const nav = document.querySelector('#sidebar70');
		nav.scrollTop = 0;
		const n = nav.getBoundingClientRect();
		const f = document.querySelector('#sidebar70 .side-foot').getBoundingClientRect();
		const last = document.querySelector('#report-moment').getBoundingClientRect();
		return { scrolls: nav.scrollHeight > nav.clientHeight + 8, navBottom: Math.round(n.bottom), footBottom: Math.round(f.bottom), footTop: Math.round(f.top), lastTop: Math.round(last.top) };
	});
	h.check(foot.scrolls && foot.lastTop > foot.footTop, `0.5 (premise) on a short window the menu scrolls and the last Help row is hidden below (${JSON.stringify(foot)})`);
	h.check(Math.abs(foot.footBottom - foot.navBottom) <= 12 && foot.footTop < foot.navBottom, `0.6 ...while the Settings footer stays at the menu's bottom, in view (${JSON.stringify(foot)})`);
	await page.evaluate(() => window.__stores.closeMenu.set(true));
	await page.setViewportSize({ width: 1440, height: 900 });
	await openBurger(page);

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
	// the brief's order after the panels: | Focus mode · Full screen | Reset · Close all floating | the three switches
	// (a separator row has no text)
	const tail = names.slice(-10).map((t) => t.replace(/Ctrl\+Space$/, '').trim() || '|');
	const wantTail = ['|', 'Focus mode', 'Full screen', '|', 'Reset positions and sizes', 'Close all floating windows', '|', 'Snap to edges', 'Lock layout', 'Remember layout per scene'];
	h.check(JSON.stringify(tail) === JSON.stringify(wantTail), `2.4 then the window commands in two groups, then the switches (${JSON.stringify(tail)})`);
	const switches = rows.slice(-3);
	h.check(JSON.stringify(switches.map((r) => r.text)) === JSON.stringify(['Snap to edges', 'Lock layout', 'Remember layout per scene']) && switches.every((r) => !r.checked), `2.5 then the three switches, all off by default (${JSON.stringify(switches)})`);

	// --- 3: reveal, never close ---
	await page.locator('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemcheckbox"]').filter({ hasText: /^\s*Explorer/ }).first().click();
	await page.waitForTimeout(600);
	h.check((await read(page, 'explorerClose')) === false, '3.1 a click on the open Explorer keeps it open (reveals)');
	await openBurger(page);
	await page.locator('#open-windows-menu').click();
	await page.waitForSelector('[role="menu"]', { timeout: 5000 });
	await page.locator('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemcheckbox"]').filter({ hasText: /^\s*Animation/ }).first().click();
	await page.waitForTimeout(900);
	h.check((await read(page, 'animationClose')) === false, '3.2 a click on a closed window opens it');

	// --- 4: close all floating ---
	await page.evaluate(() => {
		localStorage.setItem('timelineDocked', 'false');
		window.__stores.bottomDock.dockModeArm.set({ key: 'timeline', docked: false });
		window.__stores.timelineClose.set(false);
	});
	await page.waitForTimeout(900);

	// --- 5a/5b: Lock layout and Snap to edges, on the floating Timeline ---
	const win = page.locator('#timeline-window');
	const box = async () => {
		const b = await win.boundingBox();
		return b && { x: Math.round(b.x), y: Math.round(b.y) };
	};
	/** drag the window by its header so its left edge lands at `toX` (and 40 px lower) */
	const dragTo = async (toX) => {
		const handle = win.locator('.move-handle').first();
		const hb = await handle.boundingBox();
		const wb = await win.boundingBox();
		// grab well inside the header: a pointer within 44 px of a screen edge reaches for that side's column
		// (sidebarDrop EDGE) and the window would DOCK there instead of landing near the edge
		const sx = hb.x + Math.min(140, hb.width / 2);
		const sy = hb.y + hb.height / 2;
		await page.mouse.move(sx, sy);
		await page.mouse.down();
		await page.mouse.move(sx + (toX - wb.x) / 2, sy + 20, { steps: 4 });
		await page.mouse.move(sx + (toX - wb.x), sy + 40, { steps: 4 });
		await page.mouse.up();
		await page.waitForTimeout(300);
	};
	const toggle = async (label) => {
		await openBurger(page);
		await page.locator('#open-windows-menu').click();
		await page.waitForSelector('[role="menu"]', { timeout: 5000 });
		await page.locator('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemcheckbox"]').filter({ hasText: label }).first().click();
		await page.waitForTimeout(400);
		await page.evaluate(() => window.__stores.closeMenu.set(true));
		await page.waitForTimeout(300);
	};
	await dragTo(400);
	const free = await box();
	h.check(!!free && Math.abs(free.x - 400) <= 3, `5.1 (counterfactual) unlocked, a header drag moves the window (${JSON.stringify(free)})`);
	await toggle('Lock layout');
	h.check((await read(page, 'windowPrefs.layoutLocked')) === true, '5.2 the menu switch turns Lock layout on');
	await dragTo(700);
	const locked = await box();
	h.check(!!locked && locked.x === free.x && locked.y === free.y, `5.3 locked, the same drag leaves it where it was (${JSON.stringify(locked)})`);
	await toggle('Lock layout');
	await dragTo(10);
	const unsnapped = await box();
	const prefs54 = { snap: await read(page, 'windowPrefs.snapToEdges'), locked: await read(page, 'windowPrefs.layoutLocked'), where: await page.evaluate(() => window.__stores.dockMenu.windowWhere('timeline')) };
	h.check(prefs54.where === 'floating', `5.4a (premise) the drop near the edge leaves it floating, not docked (${prefs54.where})`);
	h.check(!!unsnapped && unsnapped.x >= 8, `5.4 (counterfactual) Snap off: dropped 10 px from the edge it stays there (${JSON.stringify(unsnapped)}; ${JSON.stringify(prefs54)})`);
	await toggle('Snap to edges');
	await dragTo(300);
	await dragTo(10);
	const snapped = await box();
	const where55 = await page.evaluate(() => window.__stores.dockMenu.windowWhere('timeline'));
	h.check(where55 === 'floating', `5.5a (premise) still floating, so the x is the snap and not a dock (${where55})`);
	h.check(!!snapped && snapped.x === 0, `5.5 Snap on: the same drop lands flush on the left edge (${JSON.stringify(snapped)})`);
	await page.evaluate(() => window.__stores.windowPrefs.snapToEdges.set(false));
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

	// --- 5c: Remember layout per scene ---
	const setScene = (name) => page.evaluate((n) => window.__stores.levels.currentLevel.set(n ? { hash: '', name: n, unsaved: true } : null), name);
	const explorerOpen = () => read(page, 'explorerClose').then((v) => v === false);
	const roundTrip = async () => {
		await setScene('Layout A');
		await page.evaluate(() => window.__stores.explorerClose.set(false));
		await page.waitForTimeout(500);
		await setScene('Layout B');
		await page.waitForTimeout(400);
		await page.evaluate(() => window.__stores.explorerClose.set(true));
		await page.waitForTimeout(400);
		await setScene('Layout A');
		await page.waitForTimeout(1500);
		return explorerOpen();
	};
	h.check((await roundTrip()) === false, '5.6 (counterfactual) switch off: going back to scene A brings nothing back');
	await toggle('Remember layout per scene');
	await setScene(null);
	await page.waitForTimeout(300);
	h.check((await roundTrip()) === true, '5.7 switch on: scene A opens with the window layout it was left with (Explorer open again)');
	await page.evaluate(() => window.__stores.windowPrefs.layoutPerScene.set(false));

	await h.finish(browser);
});
