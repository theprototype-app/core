// 80a-fix4-ui O1 (owner 2026-11-20, N6 unfolded on 1.69): "the sidebar button disappeared and the sidebar handles
// started to show" in one tab while the next tab had the button. The flip was the UA: Chrome for Android sends the
// DESKTOP-site UA to a tab opened on a large screen (or with "Desktop site" on), which says neither mobile nor
// Android, so $lib/deviceClass called the unfolded phone a TABLET (handles on, button hidden). The class now reads the
// screen too (a foldable's inner screen is near-square), and the button stays on the unfolded phone in Auto.
//
//   1. a fresh tab, the N6's mobile UA, unfolded (691 x 634): deviceClass phone, the panels button, no handles
//   2. a fresh tab, Chrome's desktop-site UA on the same screen: the same (was: tablet, handles, no button)
//   3. a tab with saved state from before (handles turned ON by hand, the button's mode Auto, a sidebar layout):
//      the button is there (was: hidden whenever the handles were on), both UAs
//   4. a real tablet screen (800 x 1280, desktop-site UA) stays a tablet: handles, no button (the table unchanged)
//   5. the button works: a press opens a side (aria-pressed), a second press moves on / closes
const h = require('./helpers.cjs');

const SCREEN = { width: 692, height: 763 }; // N6 inner screen, CSS px (2248 x 2480 @ 3.25)
const DESK_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const unfolded = (ua, screen = SCREEN, viewport = { width: 691, height: 634 }) => ({
	viewport,
	screen,
	deviceScaleFactor: 3.25,
	isMobile: ua === h.N6_UA,
	hasTouch: true,
	userAgent: ua
});

/** @param {any} page */
const state = (page) =>
	page.evaluate(() => {
		const dc = /** @type {any} */ (window).__tp?.test.v1?.deviceClass;
		const vis = (/** @type {string} */ id) => {
			const el = document.getElementById(id);
			const r = el?.getBoundingClientRect();
			return !!(el && r && r.width > 0 && getComputedStyle(el).visibility !== 'hidden');
		};
		let cls = null;
		dc?.deviceClass?.subscribe?.((/** @type {any} */ v) => (cls = v))?.();
		return { cls, button: vis('panels-toggle'), left: vis('sidebar-handle-left'), right: vis('sidebar-handle-right') };
	});

/** wait for the chrome to settle (the handles mount after the first measure) @param {any} page */
async function settled(page) {
	await page.waitForFunction(() => !!document.getElementById('avatar-trigger'), null, { timeout: 60000 });
	await page.waitForFunction(() => !!(/** @type {any} */ (window).__tp?.test.v1?.deviceClass), null, { timeout: 30000 }).catch(() => {});
	await page.waitForTimeout(1500);
	return state(page);
}

h.run(async () => {
	const browser = await h.launch();
	// 1 + 2: fresh tabs
	for (const [label, ua] of [
		['mobile UA', h.N6_UA],
		['desktop-site UA', DESK_UA]
	]) {
		const P = await h.setupPage(browser, 'fresh-' + label, { context: unfolded(ua) });
		const s = await settled(P.page);
		console.log(`  ${label}: ${JSON.stringify(s)}`);
		h.check(s.cls === 'phone', `fresh tab, ${label}: the unfolded N6 is a phone (${s.cls})`);
		h.check(s.button, `fresh tab, ${label}: the panels button is there`);
		h.check(!s.left && !s.right, `fresh tab, ${label}: no edge handles (the button is the way there)`);
		await P.ctx.close();
	}

	// 3: saved state from before — the handles turned ON by hand, the button on Auto, a right-hand sidebar layout
	const OLD = { sidebarHandles: 'on', panelsButton: 'auto', 'sidebar:handleY:right': '40', 'sidebar:handleY:left': '0' };
	for (const [label, ua] of [
		['mobile UA', h.N6_UA],
		['desktop-site UA', DESK_UA]
	]) {
		const P = await h.setupPage(browser, 'old-' + label, { context: unfolded(ua), storage: OLD });
		const s = await settled(P.page);
		console.log(`  old state, ${label}: ${JSON.stringify(s)}`);
		h.check(s.button, `a tab with saved layout state (handles on), ${label}: the panels button is still there`);
		if (label === 'mobile UA') {
			// 5: the button works
			const before = await P.page.locator('#panels-toggle').getAttribute('aria-pressed');
			await P.page.locator('#panels-toggle').click();
			await P.page.waitForFunction(() => document.getElementById('panels-toggle')?.getAttribute('aria-pressed') === 'true', null, { timeout: 5000 }).catch(() => {});
			const after = await P.page.locator('#panels-toggle').getAttribute('aria-pressed');
			h.check(before === 'false' && after === 'true', `the panels button opens a side (aria-pressed ${before} -> ${after})`);
		}
		await P.ctx.close();
	}

	// 4: a tablet stays a tablet
	{
		const P = await h.setupPage(browser, 'tablet', { context: unfolded(DESK_UA, { width: 800, height: 1280 }, { width: 800, height: 1180 }) });
		const s = await settled(P.page);
		console.log(`  tablet: ${JSON.stringify(s)}`);
		h.check(s.cls === 'tablet', `an 800 x 1280 touch screen is still a tablet (${s.cls})`);
		h.check(!s.button && (s.left || s.right), 'the tablet keeps its handles and no panels button (the device table unchanged)');
		await P.ctx.close();
	}

	await h.finish(browser);
});
