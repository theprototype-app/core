// 41-modals G19 — Settings rows reflow by THEIR OWN width (a container query on the row), never by the
// viewport: under ~560 px a wide control (segmented, slider, two pieces) drops under its label at full
// width, under ~420 px every control but a lone switch does. No row may leave its label/description a
// one-word-per-line column (the user's reduced-width.jpg: "Voice typing provider" / "Speech / to / text").
//
// Every page of the window at Settings widths 360 / 540 / 700 / 900 px (desktop browser windows of that
// width) plus the Oppo N6 folded (390x896) and unfolded (770x850) with touch, and desktop 1440x900.
// For each visible row: the text block is at least 180 px wide, OR it spans the whole row (the control is
// on its own line below); the control never overflows the row. SHOTS=<dir> also writes one screenshot per
// page and width (the evidence for every section).
// Counterfactual (feat/40-int): at 700/770 the AI "Voice typing provider" row keeps its segmented control
// beside a ~100 px text column, and more rows at 540.
const h = require('./helpers.cjs');
const path = require('path');

const PAGES = ['interface', 'controls', 'input', 'touch', 'shortcuts', 'scene', 'explorer', 'nodetypes', 'export', 'vr', 'ai', 'connection', 'about'];
const SIZES = [
	['w360', { viewport: { width: 360, height: 900 } }],
	['w540', { viewport: { width: 540, height: 900 } }],
	['w700', { viewport: { width: 700, height: 900 } }],
	['w900', { viewport: { width: 900, height: 900 } }],
	['folded', { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true }],
	['unfolded', { viewport: { width: 770, height: 850 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true }],
	['desktop', { viewport: { width: 1440, height: 900 } }]
];
const MIN_TEXT = 180;
const SHOTS = process.env.SHOTS || '';
// THEME=light (etc.) runs the whole pass in that theme — the screenshots then cover it too
const THEME = process.env.THEME || '';

/** @param {any} page @param {string} key */
async function open(page, key) {
	await page.evaluate((k) => {
		const s = /** @type {any} */ (window).__stores;
		s.settingsOpen.set(false);
		s.settingsSection.set(k);
		s.settingsOpen.set(true);
	}, key);
	await page.waitForSelector('dialog.settings-dialog .ss-page', { timeout: 15000 });
	await page.waitForTimeout(250);
}

const measure = (page) =>
	page.evaluate((MIN) => {
		const bad = [];
		let n = 0;
		for (const row of document.querySelectorAll('#settings-sections .setting-row')) {
			const el = /** @type {HTMLElement} */ (row);
			if (!el.offsetParent) continue;
			const body = el.querySelector(':scope > .sr-body') ?? el;
			const text = el.querySelector('.sr-text, .lsr-text');
			const ctrl = el.querySelector('.sr-control');
			if (!text) continue;
			n++;
			const b = body.getBoundingClientRect();
			const t = text.getBoundingClientRect();
			const c = ctrl?.getBoundingClientRect();
			const spans = t.width >= b.width - 2;
			const label = (el.querySelector('.sr-name')?.textContent || '').trim().slice(0, 40);
			if (!spans && t.width < MIN) bad.push(`${label}: text ${Math.round(t.width)}px beside a ${Math.round(c?.width ?? 0)}px control`);
			if (c && c.width > 0 && c.right > b.right + 2) bad.push(`${label}: control overflows the row (${Math.round(c.right - b.right)}px)`);
		}
		return { n, bad };
	}, MIN_TEXT);

h.run(async () => {
	let browser = null;
	for (const [size, context] of SIZES) {
		// a fresh browser per size: seven contexts (two at DPR 2.9) and 13 pages each in ONE browser
		// ran it out of memory on the shared box
		if (browser) await browser.close().catch(() => {});
		browser = await h.launch();
		const P = await h.setupPage(browser, size, { context });
		const page = P.page;
		await page.addStyleTag({ content: '*{transition:none!important;animation:none!important}' });
		if (THEME) await page.evaluate((th) => /** @type {any} */ (window).__stores.themes.theme.set(th), THEME);
		let rows = 0;
		const bad = [];
		for (const key of PAGES) {
			await open(page, key);
			const m = await measure(page);
			rows += m.n;
			for (const b of m.bad) bad.push(`${key} › ${b}`);
			if (SHOTS) {
				// the page's whole scroller, so every row of the section is in the picture
				await page.evaluate(() => document.querySelector('#settings-main')?.scrollTo(0, 0));
				const main = page.locator('dialog.settings-dialog');
				await main.screenshot({ path: path.join(SHOTS, `settings-${key}-${size}${THEME ? '-' + THEME : ''}.png`) }).catch(() => {});
			}
		}
		const width = await page.evaluate(() => Math.round(document.querySelector('dialog.settings-dialog')?.getBoundingClientRect().width ?? 0));
		h.check(rows >= 120, `${size}: walked ${rows} rows on ${PAGES.length} pages (Settings ${width} px wide)`);
		h.check(bad.length === 0, `${size}: no row leaves its text under ${MIN_TEXT} px beside a control, none overflows (${bad.length}: ${JSON.stringify(bad.slice(0, 6))})`);
		// the screenshot's row, named: on an unfolded phone the provider row stacks
		if (size === 'unfolded' || size === 'w700') {
			await open(page, 'ai');
			const stt = await page.evaluate(() => {
				const row = document.querySelector('#row-stt-preset');
				if (!row) return null;
				const t = row.querySelector('.sr-text')?.getBoundingClientRect();
				const c = row.querySelector('.sr-control')?.getBoundingClientRect();
				return t && c ? { below: c.top >= t.bottom - 1, text: Math.round(t.width), ctrl: Math.round(c.width) } : null;
			});
			h.check(!!stt && stt.below, `${size}: "Voice typing provider" puts its control under the label (${JSON.stringify(stt)})`);
		}
		h.check(h.pageErrors(P).length === 0, `${size}: no page errors (${JSON.stringify(h.pageErrors(P)).slice(0, 200)})`);
	}
	await h.finish(browser);
});
