// 42 I13 — "bug on Mobile, burger menu: when clicked on save settings cog button, modal opens, but it is
// not showing on fullscreen, and have a gap on right of the screen" (the user's preview-1-32c review).
// The H14 Save options modal carried an INLINE `max-width: min(520px, 94vw) !important` (its desktop
// width); an inline !important outranks the kit frame's layered phone rule (`max-width: 100vw`), so on
// the folded phone the left-anchored sheet stopped at 94 % of the screen. Now the desktop width is a
// desktop-only rule and the phone gets the kit full-screen sheet like every other framed modal.
// Devices: the Oppo N6 folded (390x896) and unfolded (770x850), touch at DPR 2.9; desktop 1440x900.
// Counterfactual (feat/41-int): folded, the sheet's right edge sits at ~367 px (a 23 px gap).
// OUT=<dir> writes the screenshots (dark + light, folded + unfolded + desktop).
const h = require('./helpers.cjs');
const path = require('path');

const OUT = process.env.OUT || '';
const FOLDED = { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true };

/** open the burger's List ⚙ (or Compact's ▾) and wait for the modal @param {any} page */
async function openSaveOptions(page) {
	await page.evaluate(() => window.__stores.closeMenu.set(false));
	await page.waitForSelector('#sidebar70', { timeout: 5000 });
	await page.waitForTimeout(350);
	// List shows the cog; Compact reaches it through Save as… ▾ (showhide-v8 §6: its last item is Save options…)
	const cog = page.locator('#export-settings-cog');
	if (await cog.isVisible()) await cog.tap().catch(() => cog.click());
	else {
		await page.locator('#project-save-as').click();
		await page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Save options…' }).click();
	}
	await page.waitForSelector('#save-options-modal', { state: 'visible', timeout: 5000 });
	await page.waitForTimeout(300);
}

/** the modal's box against the viewport @param {any} page */
const box = (page) =>
	page.evaluate(() => {
		const d = document.querySelector('#save-options-modal');
		const r = d?.getBoundingClientRect();
		return r ? { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), vw: innerWidth, vh: innerHeight } : null;
	});

/** @param {any} page @param {string} name */
async function shots(page, name) {
	if (!OUT) return;
	for (const t of ['dark', 'light']) {
		await page.evaluate((th) => window.__stores.themes.theme.set(th), t);
		await page.waitForTimeout(350);
		await page.screenshot({ path: path.join(OUT, `${name}-${t}.png`) });
	}
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));
}

h.run(async () => {
	const browser = await h.launch();
	const F = await h.setupPage(browser, 'folded', { context: FOLDED });
	const page = F.page;
	await openSaveOptions(page);
	let b = await box(page);
	console.log('folded', JSON.stringify(b));
	h.check(!!b && b.left <= 0 && b.right >= b.vw, `folded N6: Save options spans the full width, no gap on the right (${b?.left}..${b?.right} of ${b?.vw})`);
	h.check(!!b && b.bottom >= b.vh - 1, `folded N6: …and reaches the bottom edge (${b?.bottom} of ${b?.vh})`);
	await shots(page, 'i13-folded-save-options');
	await page.locator('#save-options-cancel').click();
	await page.waitForTimeout(300);

	// unfolded: a centred dialog with even margins (not the phone sheet, not stuck to one side)
	await page.setViewportSize({ width: 770, height: 850 });
	await page.waitForTimeout(800);
	await openSaveOptions(page);
	b = await box(page);
	console.log('unfolded', JSON.stringify(b));
	const even = !!b && Math.abs(b.left - (b.vw - b.right)) <= 2;
	h.check(even && b.left >= 0 && b.right <= b.vw, `unfolded N6: a centred dialog inside the screen (${b?.left}..${b?.right} of ${b?.vw})`);
	await shots(page, 'i13-unfolded-save-options');
	await page.locator('#save-options-cancel').click();
	await page.waitForTimeout(300);

	// desktop keeps its narrow dialog (the 41b H14 width, ~520 px, centred)
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.waitForTimeout(800);
	await openSaveOptions(page);
	b = await box(page);
	console.log('desktop', JSON.stringify(b));
	h.check(!!b && b.w <= 522 && b.w >= 400 && Math.abs(b.left - (b.vw - b.right)) <= 2, `desktop: the narrow centred dialog stays (${b?.w} px wide)`);
	await shots(page, 'i13-desktop-save-options');
	h.check(h.pageErrors(F).length === 0, `no page errors (${JSON.stringify(h.pageErrors(F)).slice(0, 200)})`);
	await h.finish(browser);
});
