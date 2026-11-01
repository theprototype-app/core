// 41b H12/H13 — Settings rows by REAL FIT ($lib/ui/rowFit.js): a compact control stays on its label's row,
// only a control that cannot fit drops under it. The user's preview-1-32b screenshots (feedback-1.32b),
// row by row, on the Oppo N6 folded (390x896) and unfolded (770x850, touch, DPR 2.9) and desktop 1440x900:
//   folded   — Shortcuts' key boxes, Light helper length, Length, Wireframe/Outline colour + Reset, About's
//              Version + Diagnostics Copy, Clear saved session, Reset all settings, Connection ▸ Session size,
//              AI ▸ voice-typing Test, Loading ▸ Grid size / Grid colour sit BESIDE their label; the
//              4-option "Double-click action" stacks in two columns with no option spilling out of its slot
//   unfolded — the two-option toggles (Node editor mouse / opens) and Ping sound (select + preview) beside
//              their label; Shadow quality (4 options) still stacks
//   desktop  — nothing in that list stacks
// "Beside" = the control's box starts above the text block's bottom and right of its right edge.
// Counterfactual (feat/41-int, G19's container queries): every folded row above stacks, the double-click
// options overflow, and the unfolded toggles + ping sound stack.
const h = require('./helpers.cjs');

const SIZES = [
	['folded', { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true }],
	['unfolded', { viewport: { width: 770, height: 850 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true }],
	['desktop', { viewport: { width: 1440, height: 900 } }]
];

// [page, selector of the row (a row id, or a shortcut row by its data attribute)]
const BESIDE = {
	folded: [
		['shortcuts', '[data-shortcut="transform-translate"], #shortcut-grid .setting-row'],
		['scene', '#row-light-helper'],
		['scene', '#row-length'],
		['scene', '#row-wire-color'],
		['scene', '#row-outline-color'],
		['scene', '#row-reset-colors'],
		['scene', '#row-placeholder-grid-size'],
		['scene', '#row-placeholder-grid-color'],
		['about', '#about-version'],
		['about', '.setting-row:has(#about-copy-diagnostics)'],
		['about', '.setting-row:has(#settings-clear-session)'],
		['about', '.setting-row:has(#settings-reset-all)'],
		['connection', '#row-session-size'],
		['ai', '#row-stt-test']
	],
	unfolded: [
		['input', '#row-node-mouse'],
		['input', '#row-node-opens'],
		['scene', '#row-ping-sound'],
		['scene', '#row-light-helper'],
		['about', '.setting-row:has(#about-copy-diagnostics)']
	]
};
BESIDE.desktop = [...BESIDE.folded, ...BESIDE.unfolded, ['scene', '#row-double-click']];

/** @param {any} page @param {string} key */
async function open(page, key) {
	await page.evaluate((k) => {
		const s = /** @type {any} */ (window).__stores;
		s.settingsOpen.set(false);
		s.settingsSection.set(k);
		s.settingsOpen.set(true);
	}, key);
	await page.waitForSelector('dialog.settings-dialog .ss-page', { timeout: 15000 });
	await page.waitForTimeout(300);
}

/** where a row's control sits relative to its text @param {any} page @param {string} sel */
const placement = (page, sel) =>
	page.evaluate((s) => {
		const row = [...document.querySelectorAll(s)].find((el) => /** @type {HTMLElement} */ (el).offsetParent);
		if (!row) return null;
		const t = row.querySelector(':scope > .sr-body > .sr-text')?.getBoundingClientRect();
		const c = row.querySelector(':scope > .sr-body > .sr-control')?.getBoundingClientRect();
		const b = row.querySelector(':scope > .sr-body')?.getBoundingClientRect();
		if (!t || !c || !b) return null;
		return {
			beside: c.top < t.bottom - 1 && c.left >= t.right - 1,
			text: Math.round(t.width),
			ctrl: Math.round(c.width),
			overflow: Math.round(c.right - b.right),
			fit: /** @type {HTMLElement} */ (row).dataset.fit || ''
		};
	}, sel);

h.run(async () => {
	let browser = null;
	for (const [size, context] of SIZES) {
		if (browser) await browser.close().catch(() => {});
		browser = await h.launch();
		const P = await h.setupPage(browser, size, { context });
		const page = P.page;
		await page.addStyleTag({ content: '*{transition:none!important;animation:none!important}' });
		// the About rows only render with a cloud plugin's name; the rest are always there
		let current = '';
		for (const [key, sel] of BESIDE[size]) {
			if (key !== current) {
				await open(page, key);
				current = key;
			}
			// the Test button lives on the "Voice typing server" sub-page (a self-hosted provider)
			if (sel === '#row-stt-test') {
				// 59 T4: the provider picker lives in Tools & connections ▸ Voice typing ▸ Set up
				await page.click('#tool-chat-voice-configure');
				await page.click('#ai-stt-preset-custom');
				await page.waitForSelector('#row-stt-test', { state: 'visible', timeout: 5000 });
				await page.waitForTimeout(200);
				current = '';
			}
			const p = await placement(page, sel);
			h.check(!!p && p.beside && p.overflow <= 2, `${size} ${key}: ${sel} keeps its control on the label's row (${JSON.stringify(p)})`);
		}
		if (size === 'folded') {
			await open(page, 'scene');
			const dc = await page.evaluate(() => {
				const seg = document.querySelector('#row-double-click .seg');
				if (!seg) return null;
				const opts = [...seg.querySelectorAll('.seg-opt')];
				const spill = opts.filter((o) => o.scrollWidth > o.clientWidth + 1).map((o) => o.textContent?.trim());
				const tops = [...new Set(opts.map((o) => Math.round(o.getBoundingClientRect().top)))];
				const s = seg.getBoundingClientRect();
				const row = document.querySelector('#row-double-click .sr-body')?.getBoundingClientRect();
				return { rows: tops.length, spill, inside: !!row && s.right <= row.right + 1, fit: /** @type {HTMLElement} */ (document.querySelector('#row-double-click')).dataset.fit };
			});
			h.check(!!dc && dc.rows === 2 && dc.spill.length === 0 && dc.inside, `folded: "Double-click action" wraps its four options into two rows, none spilling out ("Properties") (${JSON.stringify(dc)})`);
			const sq = await placement(page, '#row-shadow-quality');
			h.check(!!sq && !sq.beside, `folded: Shadow quality (4 options) still goes under its label (${JSON.stringify(sq)})`);
		}
		if (size === 'unfolded') {
			await open(page, 'scene');
			const sq = await placement(page, '#row-shadow-quality');
			h.check(!!sq && !sq.beside, `unfolded: Shadow quality (4 options) still goes under its label (${JSON.stringify(sq)})`);
			// a resize re-decides: the same rows narrowed to a phone column stack again (fold -> unfold -> fold)
			await page.setViewportSize({ width: 390, height: 850 });
			await page.waitForTimeout(600);
			await open(page, 'input');
			const narrow = await placement(page, '#row-node-mouse');
			h.check(!!narrow && !narrow.beside, `unfolded -> 390 px: Node editor mouse moves under its label once the row cannot hold it (${JSON.stringify(narrow)})`);
			await page.setViewportSize({ width: 770, height: 850 });
			await page.waitForTimeout(600);
			await open(page, 'input');
			const back = await placement(page, '#row-node-mouse');
			h.check(!!back && back.beside, `-> 770 px again: it comes back beside the label (${JSON.stringify(back)})`);
		}
		h.check(h.pageErrors(P).length === 0, `${size}: no page errors (${JSON.stringify(h.pageErrors(P)).slice(0, 200)})`);
	}
	await h.finish(browser);
});
