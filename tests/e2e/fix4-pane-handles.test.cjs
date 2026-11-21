// 80a-fix4-ui O2 (owner 2026-11-20): a sidebar's edge handle is HIDDEN while that sidebar is open, on phones (folded
// and unfolded) and on desktop; a closed sidebar keeps its handle. The handle's menu ("Switch sidebar side", Hide,
// Lock) moves to a right-click / long press on the open pane's header / tab strip (its top band).
//
//   1. desktop, Explorer (WindowShell): its folders pane open = no handle drawn; the pane's top band opens the menu
//      with "Switch sidebar side", which moves the pane to the other edge; "Hide" from the same menu closes the pane
//      and the handle is back; pressing it opens the pane and the handle goes again
//   2. desktop, Node editor: the palette open = #palette-toggle not drawn; its top band menu has "Move the palette
//      to the other side" and it works
//   3. the window keys still reach a hidden handle: Ctrl+B over a docked Explorer toggles its pane
//   4. viewport columns: a tablet (touch) and the unfolded phone with the handles on: an open column has no handle,
//      a closed one has it; desktop unchanged (gone while open)
const h = require('./helpers.cjs');

const DESK_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** is the element drawn (laid out and visible) @param {any} page @param {string} sel */
const drawn = (page, sel) =>
	page.evaluate((s) => {
		const el = document.querySelector(s);
		if (!el) return false;
		const r = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		return r.width > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
	}, sel);
/** @param {any} page @param {string} sel */
const box = (page, sel) => page.evaluate((s) => document.querySelector(s)?.getBoundingClientRect().toJSON() ?? null, sel);
/** right-click the top band of a pane @param {any} page @param {string} sel */
async function bandMenu(page, sel) {
	const r = await box(page, sel);
	if (!r) return false;
	await page.mouse.click(r.x + r.width / 2, r.y + 10, { button: 'right' });
	await page.waitForTimeout(300);
	return true;
}
/** @param {any} page @param {string} text */
const menuItem = (page, text) => page.locator('[role=menu] [role=menuitem]', { hasText: text }).first();

h.run(async () => {
	const browser = await h.launch();

	// ---------- 1 + 3: desktop Explorer ----------
	{
		const A = await h.setupPage(browser, 'desk', { context: { viewport: { width: 1440, height: 900 } } });
		const page = A.page;
		await page.locator('#explorer-slot').click();
		await page.waitForSelector('[data-ws-primary-pane]', { timeout: 20000 }).catch(() => {});
		if (!(await drawn(page, '[data-ws-primary-pane]'))) await page.evaluate(() => /** @type {any} */ (document.querySelector('.tp-pane-handle[data-ws-primary-toggle]'))?.click());
		await page.waitForTimeout(500);
		h.check(await drawn(page, '[data-ws-primary-pane]'), '1.0 the Explorer folders pane is open');
		h.check(!(await drawn(page, '.tp-pane-handle[data-ws-primary-toggle]')), '1.1 its handle is not drawn while it is open');
		const x0 = (await box(page, '[data-ws-primary-pane]'))?.x;
		h.check(await bandMenu(page, '[data-ws-primary-pane]'), '1.2 right-click on the pane top band');
		h.check(await menuItem(page, 'Switch sidebar side').isVisible().catch(() => false), '1.3 the band menu offers "Switch sidebar side"');
		await menuItem(page, 'Switch sidebar side').click().catch(() => {});
		await page.waitForTimeout(400);
		const x1 = (await box(page, '[data-ws-primary-pane]'))?.x;
		h.check(x0 != null && x1 != null && x1 > x0 + 100, `1.4 the pane moved to the other edge (${x0} -> ${x1})`);
		await bandMenu(page, '[data-ws-primary-pane]');
		await menuItem(page, 'Hide').click().catch(() => {});
		await page.waitForTimeout(400);
		h.check(!(await drawn(page, '[data-ws-primary-pane]')), '1.5 "Hide" from the band menu closes the pane');
		h.check(await drawn(page, '.tp-pane-handle[data-ws-primary-toggle]'), '1.6 the closed pane has its handle again');
		await page.locator('.tp-pane-handle[data-ws-primary-toggle]').click();
		await page.waitForTimeout(400);
		h.check((await drawn(page, '[data-ws-primary-pane]')) && !(await drawn(page, '.tp-pane-handle[data-ws-primary-toggle]')), '1.7 the handle opens it, then is gone');
		// put the side back for the next steps
		await bandMenu(page, '[data-ws-primary-pane]');
		await menuItem(page, 'Switch sidebar side').click().catch(() => {});
		await page.waitForTimeout(300);

		// 3: the keys still reach a hidden handle (a docked Explorer, the mouse over it)
		const docked = await page.evaluate(() => !!document.querySelector('[data-ws-primary-pane]')?.closest('.tp-dock-panel, [data-pd-host]'));
		if (docked) {
			const r = await box(page, '[data-ws-primary-pane]');
			await page.mouse.move(r.x + r.width + 120, r.y + 60);
			await page.keyboard.press('Control+b');
			await page.waitForTimeout(400);
			h.check(!(await drawn(page, '[data-ws-primary-pane]')), '3.1 Ctrl+B over the docked Explorer hides its pane (the hidden handle still answers the keys)');
			await page.keyboard.press('Control+b');
			await page.waitForTimeout(400);
			h.check(await drawn(page, '[data-ws-primary-pane]'), '3.2 ...and shows it again');
		} else console.log('  (3 skipped: the Explorer opened floating, the keys act on docked windows)');

		// ---------- 2: the Node editor palette ----------
		await page.locator('p[title="Node editor (N)"]').click();
		await page.waitForTimeout(800);
		h.check(await drawn(page, '#palette-filter'), '2.0 the palette is open');
		h.check(!(await drawn(page, '#palette-toggle')), '2.1 its handle is not drawn while it is open');
		const px0 = (await box(page, '#palette-filter'))?.x;
		const palette = await page.evaluate(() => {
			const el = document.getElementById('palette-filter')?.closest('.flex.h-full.w-40');
			if (el) el.setAttribute('data-test-palette', '');
			return !!el;
		});
		h.check(palette && (await bandMenu(page, '[data-test-palette]')), '2.2 right-click on the palette top band');
		h.check(await menuItem(page, 'Move the palette to the other side').isVisible().catch(() => false), '2.3 the band menu offers "Move the palette to the other side"');
		await menuItem(page, 'Move the palette to the other side').click().catch(() => {});
		await page.waitForTimeout(400);
		const px1 = (await box(page, '#palette-filter'))?.x;
		h.check(px0 != null && px1 != null && px1 > px0 + 300, `2.4 the palette moved sides (${px0} -> ${px1})`);
		await bandMenu(page, '[data-test-palette]');
		await menuItem(page, 'Move the palette to the other side').click().catch(() => {});
		await page.waitForTimeout(300);
		await page.screenshot({ path: require('path').join(__dirname, '..', '..', 'test-results', 'fix4-pane-handles-desktop.png') }).catch(() => {});
		await A.ctx.close();
	}

	// ---------- 4: viewport columns on touch ----------
	for (const [label, ctx, storage] of [
		['tablet', { viewport: { width: 800, height: 1180 }, screen: { width: 800, height: 1280 }, hasTouch: true, isMobile: false, userAgent: DESK_UA }, {}],
		['unfolded, handles on', { viewport: { width: 691, height: 634 }, screen: { width: 692, height: 763 }, deviceScaleFactor: 3.25, hasTouch: true, isMobile: true, userAgent: h.N6_UA }, { sidebarHandles: 'on' }]
	]) {
		const P = await h.setupPage(browser, label, { context: ctx, storage });
		const page = P.page;
		await page.waitForTimeout(1500);
		h.check(await drawn(page, '#sidebar-handle-right'), `4.1 ${label}: a closed right column has its handle`);
		await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.sidebars.toggleSidebar('right', true));
		await page.waitForTimeout(800);
		h.check(!(await drawn(page, '#sidebar-handle-right')), `4.2 ${label}: the open right column has no handle`);
		h.check(await drawn(page, '#sidebar-hide-right'), `4.3 ${label}: its strip's hide button is there to close it`);
		await page.locator('#sidebar-hide-right').click();
		await page.waitForTimeout(800);
		h.check(await drawn(page, '#sidebar-handle-right'), `4.4 ${label}: closed again, the handle is back`);
		await P.ctx.close();
	}

	await h.finish(browser);
});
