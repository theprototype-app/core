// 36 B14 — SETTINGS ON WINDOWSHELL. The sidebar lists every registered section (no list
// written anywhere: each section registers itself), exactly one section is on screen outside a
// search, a click / ↑↓ / a deep link picks it, the choice survives a reopen, the I4 search still
// spans every section (the sidebar narrowing to the sections that match), every section added
// in 1.21-1.23 is reachable, and a phone gets the same list as a chip strip. Dark/light shots.
const fs = require('fs');
const h = require('./helpers.cjs');

const EVIDENCE = process.env.EVIDENCE_DIR || '/home/deck/.code/lanes-30/after-36/36-editor-extras';

/** @param {any} page */
const state = (page) =>
	page.evaluate(() => {
		const nav = document.querySelector('#settings-nav') ?? document.querySelector('#settings-nav-chips');
		const rows = [...(nav?.querySelectorAll('.sn-row') ?? [])].map((b) => ({
			label: (b.textContent || '').trim(),
			current: b.getAttribute('aria-current') === 'page',
			hidden: /** @type {HTMLElement} */ (b).hidden
		}));
		const titles = [...document.querySelectorAll('#settings-sections h2')]
			.filter((t) => /** @type {HTMLElement} */ (t).style.display !== 'none')
			.map((t) => (t.textContent || '').trim());
		return { rows, titles, inShell: !!nav?.closest('.ws-root'), visibleRows: [...document.querySelectorAll('.setting-row')].filter((r) => /** @type {HTMLElement} */ (r).offsetParent !== null).length };
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 860 } } });
	const page = A.page;
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	await page.locator('#settings-nav').waitFor({ timeout: 10000 });
	await page.waitForTimeout(400);

	// ---- 1. The sidebar is the registered list ------------------------------------------------
	let s = await state(page);
	const labels = s.rows.map((r) => r.label);
	h.check(s.inShell, 'Settings is laid out on WindowShell (the nav sits in its sidebar)');
	const expected = ['Interface', 'Controls', 'Input', 'Touch controls', 'Scene', 'Explorer', 'VR', 'AI', 'Export', 'Connection', 'Shortcuts', 'About'];
	h.check(
		expected.every((l) => labels.includes(l)),
		'every section is in the sidebar, the own-file ones included (' + labels.join(', ') + ')'
	);
	h.check(
		expected.every((l, i) => i === 0 || labels.indexOf(expected[i - 1]) < labels.indexOf(l)),
		'in the order Settings.svelte declares them'
	);
	h.check(s.titles.length === 1, 'exactly one section on screen (' + s.titles.join(',') + ')');
	h.check(s.rows.filter((r) => r.current).length === 1 && s.rows.find((r) => r.current)?.label === s.titles[0], 'the sidebar marks the one on screen');

	// ---- 2. Every section reachable, each with its rows (incl. the 1.21-1.23 additions) --------
	/** label -> a row (or element) that proves the section's own content is there */
	const proofs = {
		Interface: '#allow-text-select', // 1.21 U6
		Input: '#flow-mouse-bindings',
		'Touch controls': '#settings-touch-header', // 1.21 U8 (own file)
		Scene: '#checkpoints-open-timeline', // 1.24 B14 + the 1.21 Loading rows below
		Explorer: '#recycle-bin',
		VR: '[data-tour="settings-vr-controls"]', // 1.22 U3
		Export: '#export-settings-section', // 1.21 U4 (own file)
		Shortcuts: '#shortcut-grid',
		About: '#about-copy-diagnostics'
	};
	for (const label of labels) {
		await page.locator('#settings-nav .sn-row', { hasText: label }).first().click();
		await page.waitForTimeout(250);
		s = await state(page);
		const proof = proofs[label];
		const proofOk = proof ? (await page.locator('#settings-main ' + proof).count()) > 0 : s.visibleRows > 0;
		h.check(s.titles.length === 1 && s.titles[0] === label && proofOk, `"${label}" opens on its own with its rows (${s.visibleRows} rows)`);
	}
	await page.locator('#settings-nav .sn-row', { hasText: 'Scene' }).first().click();
	await page.waitForTimeout(250);
	for (const id of ['[data-tour="settings-loading"]', '#modules-on-open']) {
		h.check((await page.locator('#settings-main ' + id).count()) === 1, `Scene holds ${id}`);
	}
	h.check(/Water quality/.test(await page.locator('#settings-main').textContent()), 'Scene holds the 1.22 Water rows');
	await page.locator('#settings-nav .sn-row', { hasText: 'Interface' }).first().click();
	await page.waitForTimeout(250);
	h.check(/Tours|tour/i.test(await page.locator('#settings-main').textContent()), 'Interface holds the 1.22 Tours rows');

	// ---- 3. Keyboard, persistence, deep links -----------------------------------------------
	await page.locator('#settings-nav .sn-row', { hasText: 'Interface' }).first().focus();
	await page.keyboard.press('ArrowDown');
	await page.waitForTimeout(250);
	s = await state(page);
	h.check(s.titles[0] === 'Controls', '↓ in the sidebar shows the next section (' + s.titles[0] + ')');
	await page.locator('#settings-nav .sn-row', { hasText: 'VR' }).first().click();
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(400);
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	await page.locator('#settings-nav').waitFor();
	await page.waitForTimeout(500);
	s = await state(page);
	h.check(s.titles.length === 1 && s.titles[0] === 'VR', 'a reopen comes back to the section last used (' + s.titles.join(',') + ')');
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(400);
	await page.evaluate(() => {
		window.__stores.settingsSection.set('explorer');
		window.__stores.settingsOpen.set(true);
	});
	await page.waitForTimeout(800);
	s = await state(page);
	h.check(s.titles.length === 1 && s.titles[0] === 'Explorer', 'a deep link opens its section (' + s.titles.join(',') + ')');
	await page.evaluate(() => window.__stores.settingsSection.set('touch'));
	await page.waitForTimeout(500);
	s = await state(page);
	h.check(s.titles.length === 1 && s.titles[0] === 'Touch controls', 'a deep link while open switches the section ("touch" names Touch controls)');
	await page.evaluate(() => window.__stores.settingsSection.set('ai'));
	await page.waitForTimeout(500);
	s = await state(page);
	h.check(s.titles.length === 1 && s.titles[0] === 'AI', 'the AI deep link (the HUD AI button) lands on AI');

	// ---- 4. The search still spans everything -----------------------------------------------
	await page.fill('#settings-search', 'dark');
	await page.waitForTimeout(700);
	s = await state(page);
	const shownNav = s.rows.filter((r) => !r.hidden).map((r) => r.label);
	h.check(s.visibleRows > 0 && s.visibleRows <= 4, 'searching "dark" finds the Theme row (' + s.visibleRows + ' rows)');
	h.check(shownNav.includes('Interface') && shownNav.length < labels.length, 'the sidebar narrows to the sections that match (' + shownNav.join(',') + ')');
	h.check(s.rows.every((r) => !r.current), 'no section is marked current while searching');
	await page.fill('#settings-search', 'snap');
	await page.waitForTimeout(700);
	s = await state(page);
	h.check(s.titles.length >= 2, 'a search shows every matching section at once (' + s.titles.join(',') + ')');
	const second = s.rows.filter((r) => !r.hidden)[1]?.label;
	await page.locator('#settings-nav .sn-row', { hasText: second }).first().click();
	await page.waitForTimeout(400);
	const inView = await page.evaluate((label) => {
		const t = [...document.querySelectorAll('#settings-sections h2')].find((x) => (x.textContent || '').trim() === label);
		const main = document.getElementById('settings-main');
		if (!t || !main) return false;
		const a = t.getBoundingClientRect();
		const b = main.getBoundingClientRect();
		return a.top >= b.top - 2 && a.top < b.top + 80;
	}, second);
	h.check(inView, `a sidebar click during a search scrolls to "${second}"`);
	await page.focus('#settings-search');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(500);
	s = await state(page);
	h.check(s.titles.length === 1 && s.titles[0] === 'AI', 'clearing the search goes back to the one section (' + s.titles.join(',') + ')');
	h.check(await page.locator('#settings-search').isVisible(), 'and Settings stays open');

	// ---- 5. Screenshots, dark + light --------------------------------------------------------
	fs.mkdirSync(EVIDENCE, { recursive: true });
	await page.locator('#settings-nav .sn-row', { hasText: 'Interface' }).first().click();
	for (const [theme, file] of [['dark', '03-settings-shell-dark.png'], ['light', '04-settings-shell-light.png']]) {
		await page.evaluate((t) => window.__stores.themes.theme.set(t), theme);
		await page.waitForTimeout(400);
		await page.screenshot({ path: EVIDENCE + '/' + file });
	}
	await page.fill('#settings-search', 'grid');
	await page.waitForTimeout(700);
	await page.screenshot({ path: EVIDENCE + '/05-settings-search-light.png' });
	await page.fill('#settings-search', '');
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));

	// ---- 6. A phone: the same list as a chip strip -----------------------------------------
	const P = await h.setupPage(browser, 'P', {
		context: { viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.75 }
	});
	await P.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await P.page.locator('#settings-nav-chips').waitFor({ timeout: 10000 });
	await P.page.waitForTimeout(400);
	const phone = await P.page.evaluate(() => ({
		sidebar: !!document.querySelector('#settings-nav'),
		chips: document.querySelectorAll('#settings-nav-chips .sn-row').length,
		overflowX: document.documentElement.scrollWidth > window.innerWidth
	}));
	h.check(!phone.sidebar && phone.chips === labels.length, `a phone draws the sections as chips, no sidebar (${phone.chips})`);
	h.check(!phone.overflowX, 'and the page does not scroll sideways');
	await P.page.locator('#settings-nav-chips .sn-row', { hasText: 'Scene' }).first().click();
	await P.page.waitForTimeout(300);
	s = await state(P.page);
	h.check(s.titles.length === 1 && s.titles[0] === 'Scene', 'a chip tap shows that section');
	await P.page.screenshot({ path: EVIDENCE + '/06-settings-phone-dark.png' });

	await h.finish(browser);
});
