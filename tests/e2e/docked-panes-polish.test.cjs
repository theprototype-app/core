// uir-polish B (owner feedback on 1.65.0, 2026-11-11) — THE SIDE PANES OF DOCKED WINDOWS.
//
//   B1 a COLLAPSED pane handle sits flush against the window's edge (no gap, no dark strip beside it): Explorer
//      (WindowShell), Node editor and Code (their own handles)
//   B4 the right handle owns the edge: the main area's scroller ends where the handle's tab starts, so a vertical
//      scrollbar is never under it
//   B5 Ctrl+B / Ctrl+Alt+B toggle the docked window's left / right pane when it has the FOCUS or the MOUSE is over it;
//      anywhere else they keep toggling the app's own sidebars
//   B6 "Switch sidebar side" is in the pane handle's context menu (and the pane header's), not a header button
//
// Run: APP_URL=https://theprototype.app:7010/ node tests/e2e/docked-panes-polish.test.cjs
const h = require('./helpers.cjs');

const read = (page, expr) => page.evaluate(expr);
const mainSidebars = (page) =>
	read(page, () => {
		let v;
		window.__stores.sidebars.sidebarVisible.subscribe((x) => (v = x))();
		return { left: !!v.left, right: !!v.right };
	});
const toggle = (page, key) => page.evaluate((k) => window.__stores.panelToggles.togglePanel(k), key);
/** every visible pane handle in the docked frame #<frameId>: edge, open, the tab's distance to the frame's edge */
const handles = (page, frameSel) =>
	page.evaluate((sel) => {
		const frame = document.querySelector(sel);
		if (!frame) return null;
		const f = frame.getBoundingClientRect();
		return [...frame.querySelectorAll('.tp-pane-handle')]
			.filter((b) => b.getBoundingClientRect().width > 0)
			.map((b) => {
				const t = b.querySelector('.ph-tab').getBoundingClientRect();
				const left = b.classList.contains('ph-left');
				return {
					edge: left ? 'left' : 'right',
					open: b.getAttribute('aria-expanded') === 'true',
					gap: Math.round(left ? t.left - (f.left + frame.clientLeft) : f.left + frame.clientLeft + frame.clientWidth - t.right),
					tabLeft: Math.round(t.left),
					hit: (() => {
						const e = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
						return !!e && b.contains(e);
					})()
				};
			});
	}, frameSel);
const closeAll = async (page, frameSel) => {
	for (let i = 0; i < 3; i++) {
		const n = await page.evaluate((sel) => {
			const o = [...document.querySelectorAll(sel + ' .tp-pane-handle[aria-expanded="true"]')].filter((b) => b.getBoundingClientRect().width > 0);
			o.forEach((b) => b.click());
			return o.length;
		}, frameSel);
		if (!n) return;
		await page.waitForTimeout(500);
	}
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1920, height: 1080 } } });
	const page = A.page;
	await page.waitForTimeout(1500);

	// ---- B1 + B4: Explorer (WindowShell) ----
	await toggle(page, 'explorer');
	await page.waitForSelector('#explorer-list:not(.hidden) .ws-root', { timeout: 20000 });
	await page.waitForTimeout(800);
	await closeAll(page, '#explorer-list');
	let hs = await handles(page, '#explorer-list');
	h.check(hs && hs.length === 2 && hs.every((x) => !x.open), `premise: Explorer docked, both panes collapsed (${JSON.stringify(hs)})`);
	for (const x of hs || []) h.check(x.gap <= 1 && x.hit, `B1 Explorer: the collapsed ${x.edge} handle sits flush against the window edge (gap ${x.gap}px) and is pressable`);
	const room = await page.evaluate(() => {
		const body = document.querySelector('#explorer-list [data-ws-main-body]');
		const tab = [...document.querySelectorAll('#explorer-list .tp-pane-handle.ph-right .ph-tab')].find((t) => t.getBoundingClientRect().width > 0);
		if (!body || !tab) return null;
		const b = body.getBoundingClientRect();
		const cs = getComputedStyle(body);
		return { contentRight: Math.round(b.right - parseFloat(cs.paddingRight)), tabLeft: Math.round(tab.getBoundingClientRect().left) };
	});
	h.check(room && room.contentRight <= room.tabLeft, `B4 Explorer: the scroll area ends where the right handle's tab starts (${room?.contentRight} <= ${room?.tabLeft})`);

	// ---- B6: the switch is in the menus, not in the header ----
	await page.locator('#explorer-list .tp-pane-handle.ph-right').first().click();
	await page.waitForTimeout(500);
	h.check((await page.locator('#explorer-list [data-ws-switch-side]').count()) === 0, 'B6 the Explorer pane header has no "Switch sidebar side" button');
	await page.locator('#explorer-list .tp-pane-handle.ph-right').first().click({ button: 'right' });
	const inMenu = await page.getByRole('menuitem', { name: 'Switch sidebar side', exact: true }).count();
	h.check(inMenu === 1, `B6 the pane handle's context menu offers "Switch sidebar side" (${inMenu})`);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	await page.locator('#explorer-list [data-ws-panel-head]').first().click({ button: 'right' });
	h.check((await page.getByRole('menuitem', { name: 'Switch sidebar side', exact: true }).count()) === 1, 'B6 ...and so does the pane header\'s');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	const before = await read(page, () => localStorage.getItem('ws:explorer:side') || 'left');
	await page.locator('#explorer-list .tp-pane-handle.ph-right').first().click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Switch sidebar side', exact: true }).click();
	await page.waitForTimeout(500);
	const after = await read(page, () => localStorage.getItem('ws:explorer:side') || 'left');
	h.check(before !== after, `B6 the menu item switches the sides (${before} -> ${after})`);
	await page.locator('#explorer-list .tp-pane-handle').first().click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Switch sidebar side', exact: true }).click();
	await page.waitForTimeout(500);

	// ---- B5: the keys follow the mouse / the focus ----
	await closeAll(page, '#explorer-list');
	const leftOpen = () => page.evaluate(() => document.querySelector('#explorer-list .tp-pane-handle.ph-left')?.getAttribute('aria-expanded') === 'true');
	const rightOpen = () => page.evaluate(() => document.querySelector('#explorer-list .tp-pane-handle.ph-right')?.getAttribute('aria-expanded') === 'true');
	const box = await page.locator('#explorer-list [data-ws-main-body]').boundingBox();
	await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
	const main0 = await mainSidebars(page);
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.keyboard.press('Control+b');
	await page.waitForTimeout(400);
	h.check((await leftOpen()) === true, 'B5 mouse over the docked Explorer: Ctrl+B shows ITS left pane');
	h.check(JSON.stringify(await mainSidebars(page)) === JSON.stringify(main0), "B5 ...and leaves the app's sidebars alone");
	await page.keyboard.press('Control+Alt+b');
	await page.waitForTimeout(400);
	h.check((await rightOpen()) === true, 'B5 mouse over it: Ctrl+Alt+B shows its right pane');
	// focus inside the Explorer, mouse over the viewport
	await page.locator('#explorer-list .tp-pane-handle.ph-left').first().focus();
	await page.mouse.move(960, 200);
	await page.keyboard.press('Control+b');
	await page.waitForTimeout(400);
	h.check((await leftOpen()) === false, 'B5 the focus in the Explorer, mouse elsewhere: Ctrl+B hides its left pane');
	h.check(JSON.stringify(await mainSidebars(page)) === JSON.stringify(main0), "B5 ...the app's sidebars still untouched");
	// neither: the app's own sidebar
	await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
	await page.mouse.move(960, 200);
	await page.keyboard.press('Control+b');
	await page.waitForTimeout(500);
	const main1 = await mainSidebars(page);
	h.check(main1.left !== main0.left && (await leftOpen()) === false, `B5 no focus and no mouse on a docked window: Ctrl+B toggles the app's left sidebar (${main0.left} -> ${main1.left})`);
	await page.keyboard.press('Control+b');
	await page.waitForTimeout(400);
	await toggle(page, 'explorer');
	await page.waitForTimeout(600);

	// ---- B1 for windows with their own handles: Node editor, Code ----
	for (const [key, sel] of [
		['flow', '#flow-list'],
		['code', '#code-ws-dock']
	]) {
		await toggle(page, key);
		await page.waitForSelector(sel + ':not(.hidden) .tp-pane-handle', { timeout: 20000 }).catch(() => {});
		await page.waitForTimeout(800);
		const frameSel = sel;
		await closeAll(page, frameSel);
		hs = await handles(page, frameSel);
		h.check(hs && hs.length >= 2, `premise: ${key} docked with its pane handles (${JSON.stringify(hs)})`);
		for (const x of (hs || []).filter((y) => !y.open)) h.check(x.gap <= 1 && x.hit, `B1 ${key}: the collapsed ${x.edge} handle sits flush against the window edge (gap ${x.gap}px)`);
		await toggle(page, key);
		await page.waitForTimeout(600);
	}
	await h.finish(browser);
});
