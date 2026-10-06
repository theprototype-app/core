// 37-settings (R21): THE SETTINGS LAYOUT, measured. (Phase 131's multi-column shortcut grid is gone:
// the redesign asked for one calm list.) On every page of the window:
//   - no 3-column row is left: a row is label + description LEFT, the control RIGHT, vertically
//     centred (a wide control on its own line under the label) — never name | control | description
//   - the content column is ~660 px wide at most, the native scrollbar is hidden (the app's minimal one)
//   - a description reads at >= 4.5:1 against its card in every built-in theme
//   - the whole window works from the keyboard (menu, rows, a toggle, a segmented control, Esc)
//   - a phone gets >= 44 px touch targets and 16 px inputs
// Run: APP_URL=https://theprototype.app:5364/ npm run e2e -- settings-layout
const h = require('./helpers.cjs');

const PAGES = ['interface', 'controls', 'input', 'touch', 'shortcuts', 'scene', 'explorer', 'nodetypes', 'export', 'vr', 'ai', 'connection', 'about'];
const THEMES = ['dark', 'light', 'green', 'bit8', 'contrast'];

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

/** every visible row of the page: its shape, measured */
const measureRows = (page) =>
	page.evaluate(() => {
		const out = [];
		for (const row of document.querySelectorAll('#settings-sections .setting-row')) {
			const el = /** @type {HTMLElement} */ (row);
			if (!el.offsetParent) continue;
			const r = el.getBoundingClientRect();
			const name = el.querySelector('.sr-name')?.getBoundingClientRect();
			const desc = el.querySelector('.sr-desc')?.getBoundingClientRect();
			const ctrl = el.querySelector('.sr-control')?.getBoundingClientRect();
			const tracks = getComputedStyle(el).gridTemplateColumns.split(' ').filter((t) => /px$/.test(t)).length;
			out.push({
				label: (el.querySelector('.sr-name')?.textContent || '').trim(),
				tracks,
				// the description sits UNDER the label (same left edge), not in a third column
				descUnder: !desc || !name || desc.width === 0 || (Math.abs(desc.left - name.left) < 2 && desc.top >= name.bottom - 2),
				// the control is right-aligned (or on its own line under the label)
				ctrlRight: !ctrl || ctrl.width === 0 || ctrl.right >= r.right - 40 || ctrl.top >= (name?.bottom ?? 0) - 2,
				// …and vertically centred when it shares the line
				ctrlCentred: !ctrl || ctrl.width === 0 || ctrl.top >= (name?.bottom ?? 0) - 2 || Math.abs(ctrl.top + ctrl.height / 2 - (r.top + r.height / 2)) < 12 || ctrl.height > r.height - 30
			});
		}
		return out;
	});

/** WCAG contrast of every visible description against its (opaque) background */
const contrasts = (page) =>
	page.evaluate(() => {
		const parse = (c) => (c.match(/[\d.]+/g) || []).map(Number);
		const lum = ([r, g, b]) => {
			const f = (v) => {
				v /= 255;
				return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
			};
			return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
		};
		const bgOf = (el) => {
			for (let e = el; e; e = e.parentElement) {
				const c = parse(getComputedStyle(e).backgroundColor);
				if (c.length >= 3 && (c.length < 4 || c[3] > 0.95)) return c;
			}
			return [255, 255, 255];
		};
		let worst = { ratio: 99, text: '' };
		for (const d of document.querySelectorAll('#settings-sections .sr-desc, #settings-sections .nr-desc')) {
			const el = /** @type {HTMLElement} */ (d);
			if (!el.offsetParent || !(el.textContent || '').trim()) continue;
			const fg = parse(getComputedStyle(el).color);
			const bg = bgOf(el);
			const a = lum(fg);
			const b = lum(bg);
			const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
			if (ratio < worst.ratio) worst = { ratio, text: (el.textContent || '').trim().slice(0, 40) };
		}
		return worst;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;

	// ---- 1. no 3-column row left, on any page ------------------------------------------------
	let total = 0;
	for (const key of PAGES) {
		await open(page, key);
		const rows = await measureRows(page);
		total += rows.length;
		const bad = rows.filter((r) => r.tracks > 2 || !r.descUnder || !r.ctrlRight || !r.ctrlCentred);
		h.check(rows.length > 0 || key === 'nodetypes', `${key}: ${rows.length} rows`);
		h.check(bad.length === 0, `${key}: every row is label + description left, control right (bad: ${JSON.stringify(bad.slice(0, 3))})`);
	}
	h.check(total >= 150, `the layout check walked ${total} rows`);
	// the legacy SettingRow (a section another lane adds) draws the same row
	await open(page, 'interface');
	const legacy = await page.evaluate(() => {
		const host = document.querySelector('#settings-sections .ss-page .ss-body');
		const probe = document.createElement('div');
		probe.innerHTML = '<div class="tp-ui lsr setting-row"><div class="lsr-text"><div class="sr-name">x</div><div class="sr-desc">y</div></div><div class="sr-control"><button>z</button></div></div>';
		host?.appendChild(probe);
		const cols = getComputedStyle(/** @type {Element} */ (probe.firstElementChild)).gridTemplateColumns.split(' ').length;
		probe.remove();
		return cols;
	});
	h.check(legacy <= 2, `a legacy <SettingRow> renders two columns at most (${legacy})`);

	// ---- 2. the column, the scrollbar ---------------------------------------------------------
	const col = await page.evaluate(() => {
		const p = document.querySelector('#settings-sections .ss-page')?.getBoundingClientRect();
		const main = document.getElementById('settings-main');
		return { width: p?.width ?? 0, scroll: main?.classList.contains('tp-scroll') ?? false, sw: main ? getComputedStyle(main).scrollbarWidth : '' };
	});
	h.check(col.width > 500 && col.width <= 664, `the content column is ~660 px at most (${Math.round(col.width)})`);
	h.check(col.scroll && col.sw === 'none', `the native scrollbar is hidden for the app's minimal one (${col.sw})`);

	// ---- 3. description contrast in every built-in theme --------------------------------------
	for (const theme of THEMES) {
		await page.evaluate((t) => /** @type {any} */ (window).__stores.themes.theme.set(t), theme);
		await page.waitForTimeout(250);
		let worst = { ratio: 99, text: '' };
		for (const key of ['interface', 'scene', 'vr', 'about']) {
			await open(page, key);
			const w = await contrasts(page);
			if (w.ratio < worst.ratio) worst = w;
		}
		h.check(worst.ratio >= 4.5, `${theme}: descriptions read at >= 4.5:1 (worst ${worst.ratio.toFixed(2)} on "${worst.text}")`);
	}
	await page.evaluate(() => /** @type {any} */ (window).__stores.themes.theme.set('dark'));

	// ---- 4. keyboard only ----------------------------------------------------------------------
	await open(page, 'interface');
	// header (search, close) → the menu → the page: a few Tabs from the search reach the menu
	await page.locator('#settings-search').focus();
	let onNav = false;
	for (let i = 0; i < 3 && !onNav; i++) {
		await page.keyboard.press('Tab');
		onNav = await page.evaluate(() => document.activeElement?.classList.contains('sn-row') ?? false);
	}
	h.check(onNav, 'Tab from the search reaches the menu (after the close button)');
	await page.locator('#settings-nav .sn-row', { hasText: 'Interface' }).first().focus();
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	await page.waitForTimeout(250);
	const title = await page.evaluate(() => document.querySelector('#settings-sections .ss-page .ss-title')?.textContent?.trim());
	h.check(title === 'Input', `↓↓ walks the menu to Input (${title})`);
	// into the page: Tab reaches the first control; Space flips a toggle; arrows move a segmented control
	await page.locator('#gamepad-enabled').focus();
	const before = await page.locator('#gamepad-enabled').getAttribute('aria-pressed');
	await page.keyboard.press('Space');
	await page.waitForTimeout(150);
	const after = await page.locator('#gamepad-enabled').getAttribute('aria-pressed');
	h.check(before !== after, `Space flips a toggle (${before} → ${after})`);
	await page.keyboard.press('Space');
	await page.locator('#flow-mouse-bindings [aria-checked="true"]').focus();
	await page.keyboard.press('ArrowRight');
	await page.waitForTimeout(150);
	const seg = await page.evaluate(() => localStorage.getItem('flow:mouseBindings'));
	h.check(seg === 'select', `→ moves a segmented control and selects (${seg})`);
	await page.keyboard.press('ArrowLeft');
	const roles = await page.evaluate(() => ({
		toggles: [...document.querySelectorAll('#settings-sections button.tg')].every((b) => b.hasAttribute('aria-pressed')),
		segs: [...document.querySelectorAll('#settings-sections .seg')].every((s) => s.getAttribute('role') === 'radiogroup')
	}));
	h.check(roles.toggles && roles.segs, 'toggles carry aria-pressed, segmented controls are radiogroups');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	h.check(!(await page.locator('dialog.settings-dialog').isVisible().catch(() => false)), 'Esc closes Settings');

	// ---- 5. a phone: touch targets and inputs ---------------------------------------------------
	const P = await h.setupPage(browser, 'P', { context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } });
	for (const key of ['interface', 'scene', 'connection']) {
		await open(P.page, key);
		const t = await P.page.evaluate(() => {
			const small = [];
			for (const el of document.querySelectorAll('#settings-sections .seg-opt, #settings-sections .tp-ui.nr, #settings-sections button.btn, #settings-sections .settings-num, #settings-sections .settings-text')) {
				const e = /** @type {HTMLElement} */ (el);
				if (!e.offsetParent) continue;
				const r = e.getBoundingClientRect();
				if (r.height < 43.5) small.push(e.id || e.textContent?.trim().slice(0, 20) || e.className);
			}
			const inputs = [...document.querySelectorAll('#settings-sections input[type="text"], #settings-sections input[type="number"], #settings-sections input:not([type])')]
				.filter((e) => /** @type {HTMLElement} */ (e).offsetParent)
				.map((e) => parseFloat(getComputedStyle(e).fontSize));
			return { small, inputs, overflowX: document.documentElement.scrollWidth > window.innerWidth };
		});
		h.check(t.small.length === 0, `${key} (phone): touch targets >= 44 px (${JSON.stringify(t.small.slice(0, 4))})`);
		h.check(t.inputs.every((f) => f >= 16), `${key} (phone): inputs use 16 px text (${JSON.stringify(t.inputs)})`);
		h.check(!t.overflowX, `${key} (phone): nothing scrolls sideways`);
	}

	await h.finish(browser);
});
