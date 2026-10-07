// 36 B14 → 37-settings (R21): THE SETTINGS WINDOW. The menu lists every registered section (no list
// written anywhere: each section registers itself), GROUPED (General · Workspace · Devices &
// services) with "About & what's new" pinned last; exactly one page on screen outside a search; a
// click / ↑↓ / a deep link picks it and a reopen comes back to it; a SUB-PAGE opens in the content
// area with a breadcrumb + back (Esc backs out first); the search spans every page and shows each
// match under its path, a click on a row's name JUMPS to it; a phone gets the category LIST first,
// a pushed page with "‹ Settings", and a pushed sub-page with "‹ <Category>".
const fs = require('fs');
const h = require('./helpers.cjs');

const EVIDENCE = process.env.EVIDENCE_DIR || '/home/deck/.code/lanes-30/after-37/37-settings';

/** @param {any} page */
const state = (page) =>
	page.evaluate(() => {
		const nav = document.querySelector('#settings-nav') ?? document.querySelector('#settings-home');
		const rows = [...(nav?.querySelectorAll('.sn-row') ?? [])].map((b) => ({
			label: (b.querySelector('.sn-label')?.textContent || '').trim(),
			current: b.getAttribute('aria-current') === 'page',
			hidden: /** @type {HTMLElement} */ (b).hidden,
			group: b.closest('.sn-group')?.getAttribute('data-group') ?? (b.closest('.sn-about') ? 'about' : '')
		}));
		const pages = [...document.querySelectorAll('#settings-sections .ss-page')].filter((p) => /** @type {HTMLElement} */ (p).style.display !== 'none' && /** @type {HTMLElement} */ (p).offsetParent !== null);
		const titles = pages.map((p) => (p.querySelector('.ss-title')?.textContent || '').replace(/›\s*$/, '').trim());
		const crumb = document.querySelector('#settings-sections .ss-crumb')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
		return {
			rows,
			titles,
			keys: pages.map((p) => p.getAttribute('data-section')),
			crumb,
			chromeTitle: document.querySelector('.settings-shell .wc-title')?.textContent?.trim() ?? '',
			back: document.querySelector('.settings-shell .wc-back')?.textContent?.trim() ?? '',
			visibleRows: [...document.querySelectorAll('#settings-sections .setting-row')].filter((r) => /** @type {HTMLElement} */ (r).offsetParent !== null).length
		};
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 860 } } });
	const page = A.page;
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	await page.locator('#settings-nav').waitFor({ timeout: 10000 });
	await page.waitForTimeout(500);

	// ---- 1. The grouped menu --------------------------------------------------------------------
	let s = await state(page);
	const labels = s.rows.map((r) => r.label);
	const groups = await page.$$eval('#settings-nav .sn-group-label', (els) => els.map((e) => (e.textContent || '').trim()));
	h.check(JSON.stringify(groups) === JSON.stringify(['General', 'Workspace', 'Devices & services']), 'the menu is grouped General · Workspace · Devices & services (' + groups.join(' · ') + ')');
	const byGroup = (g) => s.rows.filter((r) => r.group === g).map((r) => r.label);
	h.check(JSON.stringify(byGroup('general')) === JSON.stringify(['Interface', 'Controls', 'Input', 'Touch controls', 'Shortcuts']), 'General: Interface, Controls, Input, Touch controls, Shortcuts (' + byGroup('general').join(', ') + ')');
	h.check(JSON.stringify(byGroup('workspace')) === JSON.stringify(['Scene', 'Explorer', 'Node types', 'Export']), 'Workspace: Scene, Explorer, Node types, Export');
	h.check(JSON.stringify(byGroup('devices')) === JSON.stringify(['VR', 'AI', 'Connection']), 'Devices & services: VR, AI, Connection');
	h.check(labels[labels.length - 1] === 'About & what’s new' && s.rows[s.rows.length - 1].group === 'about', '"About & what’s new" is pinned last');
	const pinned = await page.evaluate(() => {
		const about = document.querySelector('#settings-nav .sn-about')?.getBoundingClientRect();
		const side = document.querySelector('.settings-side')?.getBoundingClientRect();
		return about && side ? side.bottom - about.bottom : -1;
	});
	h.check(pinned > -2 && pinned < 40, `About sits at the bottom of the menu (${pinned.toFixed(1)}px from it)`);
	h.check(s.titles.length === 1, 'exactly one page on screen (' + s.titles.join(',') + ')');
	h.check(s.rows.filter((r) => r.current).length === 1 && s.rows.find((r) => r.current)?.label === s.titles[0], 'the menu marks the one on screen');

	// ---- 2. Every page reachable, each with its own rows ----------------------------------------
	const proofs = {
		Interface: '#allow-text-select',
		Controls: '#trackpad-mode',
		Input: '#flow-mouse-bindings',
		'Touch controls': '#touch-visibility-never',
		Shortcuts: '#shortcut-grid',
		Scene: '#checkpoints-open-timeline',
		Explorer: '#recycle-bin',
		'Node types': '#node-types-section',
		Export: '#export-settings-section',
		VR: '[data-tour="settings-vr-controls"]',
		AI: '#ai-enabled',
		Connection: '#peer-server-mode',
		'About & what’s new': '#about-copy-diagnostics'
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
	for (const id of ['[data-tour="settings-loading"]', '#modules-on-open', '#water-quality']) {
		h.check((await page.locator('#settings-main ' + id).count()) === 1, `Scene holds ${id}`);
	}
	const sceneCards = await page.$$eval('#settings-main .ss-page [data-section-label]', (els) => els.map((e) => (e.textContent || '').trim()));
	h.check(
		JSON.stringify(sceneCards) === JSON.stringify(['Viewport', 'Performance', 'Collaboration', 'Saving & checkpoints', 'Editing', 'Units', 'Duplicates', 'Colours', 'Loading placeholders']),
		'Scene is split into its nine sections (' + sceneCards.join(', ') + ')'
	);

	// ---- 3. Keyboard, persistence, deep links ---------------------------------------------------
	await page.locator('#settings-nav .sn-row', { hasText: 'Interface' }).first().focus();
	await page.keyboard.press('ArrowDown');
	await page.waitForTimeout(250);
	s = await state(page);
	h.check(s.titles[0] === 'Controls', '↓ in the menu shows the next page (' + s.titles[0] + ')');
	await page.locator('#settings-nav .sn-row', { hasText: 'VR' }).first().click();
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(400);
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	await page.locator('#settings-nav').waitFor();
	await page.waitForTimeout(500);
	s = await state(page);
	h.check(s.titles.length === 1 && s.titles[0] === 'VR', 'a reopen comes back to the page last used (' + s.titles.join(',') + ')');
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(400);
	await page.evaluate(() => {
		window.__stores.settingsSection.set('explorer');
		window.__stores.settingsOpen.set(true);
	});
	await page.waitForTimeout(800);
	s = await state(page);
	h.check(s.titles.length === 1 && s.titles[0] === 'Explorer', 'a deep link opens its page (' + s.titles.join(',') + ')');
	await page.evaluate(() => window.__stores.settingsSection.set('touch'));
	await page.waitForTimeout(500);
	s = await state(page);
	h.check(s.titles.length === 1 && s.titles[0] === 'Touch controls', 'a deep link while open switches the page ("touch" names Touch controls)');
	await page.evaluate(() => window.__stores.settingsSection.set('about'));
	await page.waitForTimeout(500);
	s = await state(page);
	h.check(s.titles[0] === 'About & what’s new', 'the old "about" deep link lands on About & what’s new');
	await page.evaluate(() => window.__stores.settingsSection.set('ai'));
	await page.waitForTimeout(500);
	s = await state(page);
	h.check(s.titles.length === 1 && s.titles[0] === 'AI', 'the AI deep link (the HUD AI button) lands on AI');

	// ---- 4. Sub-pages: in the content area, breadcrumb + back, Esc backs out first ---------------
	await page.locator('#settings-nav .sn-row', { hasText: 'VR' }).first().click();
	await page.waitForTimeout(250);
	await page.locator('#vr-remap-open').click();
	await page.waitForTimeout(300);
	s = await state(page);
	h.check(/VR\s*›\s*Remap buttons/.test(s.crumb), `a submenu opens as a sub-page with a breadcrumb ("${s.crumb}")`);
	h.check((await page.locator('dialog[open]').count()) === 1, 'no second dialog opened (not a modal on a modal)');
	h.check((await page.locator('#vr-bind-move-hand-left').count()) === 1, 'the remap rows are on the sub-page');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	s = await state(page);
	h.check(!s.crumb && s.titles[0] === 'VR' && (await page.locator('dialog.settings-dialog').isVisible()), 'Esc backs out of the sub-page, Settings stays open');
	await page.locator('#settings-nav .sn-row', { hasText: 'Touch controls' }).first().click();
	await page.waitForTimeout(250);
	await page.locator('[data-touch-tile="jump"]').click();
	await page.waitForTimeout(300);
	s = await state(page);
	h.check(/Touch controls\s*›\s*Jump/.test(s.crumb) && (await page.locator('[id^="touch-tex-upload-released"]').count()) === 1, `a Button looks tile opens its own sub-page ("${s.crumb}")`);
	await page.locator('.ss-back').click();
	await page.waitForTimeout(250);
	s = await state(page);
	h.check(!s.crumb && (await page.locator('[data-touch-tile]').count()) >= 9, 'the back button returns to the tile grid');
	await page.locator('#settings-nav .sn-row', { hasText: 'About' }).first().click();
	await page.waitForTimeout(250);
	await page.locator('#about-whats-new').click();
	await page.waitForTimeout(400);
	h.check((await page.locator('#settings-whats-new details').count()) > 0 && (await page.locator('#whats-new-window').count()) === 0, 'What’s new opens inside Settings (About › What’s new), not as a window on top');
	await page.locator('.ss-crumb-parent').click();
	await page.waitForTimeout(250);

	// ---- 5. The search spans everything, shows the path, jumps to the row ----------------------
	await page.fill('#settings-search', 'dark');
	await page.waitForTimeout(700);
	s = await state(page);
	const shownNav = s.rows.filter((r) => !r.hidden).map((r) => r.label);
	h.check(s.visibleRows > 0 && s.visibleRows <= 4, 'searching "dark" finds the Theme row (' + s.visibleRows + ' rows)');
	h.check(shownNav.includes('Interface') && shownNav.length < labels.length, 'the menu narrows to the pages that match (' + shownNav.join(',') + ')');
	h.check(s.rows.every((r) => !r.current), 'no page is marked current while searching');
	const path = await page.evaluate(() => {
		const row = [...document.querySelectorAll('#settings-sections .setting-row')].find((r) => /** @type {HTMLElement} */ (r).offsetParent !== null && /Theme/.test(r.querySelector('.sr-name')?.textContent ?? ''));
		const label = row?.closest('.sec-card-wrap')?.querySelector('[data-section-label]');
		return label ? getComputedStyle(label, '::before').content + ' ' + label.textContent : '';
	});
	h.check(/Interface ›.*Appearance/.test(path), `the match shows its path ("${path.replace(/"/g, '')}")`);
	await page.locator('#settings-sections .setting-row .sr-name', { hasText: 'Theme' }).first().click();
	await page.waitForTimeout(800);
	s = await state(page);
	const jumped = await page.evaluate(() => {
		const row = document.querySelector('#row-theme');
		const main = document.getElementById('settings-main');
		if (!row || !main) return null;
		const a = row.getBoundingClientRect();
		const b = main.getBoundingClientRect();
		return { inView: a.top >= b.top && a.bottom <= b.bottom, query: /** @type {HTMLInputElement} */ (document.getElementById('settings-search'))?.value };
	});
	h.check(s.titles.length === 1 && s.titles[0] === 'Interface' && !!jumped?.inView && jumped.query === '', 'a click on a result jumps to the row on its page, the search cleared');
	await page.fill('#settings-search', 'snap');
	await page.waitForTimeout(700);
	s = await state(page);
	h.check(s.titles.length >= 2, 'a search shows every matching page at once (' + s.titles.join(',') + ')');
	await page.focus('#settings-search');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(500);
	s = await state(page);
	h.check(s.titles.length === 1, 'Esc clears the search and goes back to one page (' + s.titles.join(',') + ')');
	h.check(await page.locator('#settings-search').isVisible(), 'and Settings stays open');

	// ---- 6. The quiet footer ----------------------------------------------------------------------
	await page.locator('#settings-nav .sn-row', { hasText: 'Controls' }).first().click();
	await page.waitForTimeout(250);
	h.check(((await page.locator('#settings-reset-category').textContent()) || '').trim() === 'Reset Controls to defaults', 'the footer offers "Reset Controls to defaults"');
	h.check(/Changes save automatically/.test((await page.locator('.settings-foot').textContent()) || ''), 'the footer says changes save automatically');
	await page.locator('#settings-nav .sn-row', { hasText: 'About' }).first().click();
	await page.waitForTimeout(250);
	h.check((await page.locator('#settings-reset-category').count()) === 0, 'About has no reset (it holds no settings)');
	h.check((await page.locator('#settings-clear-session').count()) === 1 && (await page.locator('#settings-reset-all').count()) === 1, 'Clear saved session + Reset all settings live in About › Danger zone');
	await page.locator('#settings-done').click();
	await page.waitForTimeout(300);
	h.check(!(await page.locator('dialog.settings-dialog').isVisible().catch(() => false)), 'Done closes Settings');

	// ---- 7. A phone: the category list, then pushed pages ----------------------------------------
	const P = await h.setupPage(browser, 'P', {
		context: { viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.75 }
	});
	await P.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await P.page.locator('#settings-home').waitFor({ timeout: 10000 });
	await P.page.waitForTimeout(400);
	const phone = await P.page.evaluate(() => ({
		sidebar: !!document.querySelector('#settings-nav'),
		rows: [...document.querySelectorAll('#settings-home .sn-row')].map((r) => r.getBoundingClientRect().height),
		pageShown: [...document.querySelectorAll('#settings-sections .ss-page')].some((p) => /** @type {HTMLElement} */ (p).offsetParent !== null),
		search: /** @type {HTMLElement | null} */ (document.querySelector('#settings-search'))?.offsetParent !== null,
		searchFont: parseFloat(getComputedStyle(/** @type {Element} */ (document.querySelector('#settings-search'))).fontSize),
		overflowX: document.documentElement.scrollWidth > window.innerWidth
	}));
	h.check(!phone.sidebar && phone.rows.length === labels.length && !phone.pageShown, `a phone opens on the category list, no sidebar, no page (${phone.rows.length} rows)`);
	h.check(phone.rows.every((hgt) => hgt >= 52), 'every category row is at least 52 px tall');
	h.check(phone.search && phone.searchFont >= 16, `a full-width search with 16 px text (${phone.searchFont}px)`);
	h.check(!phone.overflowX, 'and the page does not scroll sideways');
	await P.page.locator('#settings-home .sn-row', { hasText: 'Scene' }).first().click();
	await P.page.waitForTimeout(300);
	s = await state(P.page);
	h.check(s.keys.length === 1 && s.keys[0] === 'scene' && s.chromeTitle === 'Scene' && /Settings/.test(s.back), `a tap pushes the page: "‹ Settings · Scene" (${s.back} · ${s.chromeTitle})`);
	h.check(!(await P.page.locator('#settings-sections .ss-page .ss-head').isVisible()), 'the page does not repeat its title in the content');
	await P.page.locator('.settings-shell .wc-back').click();
	await P.page.waitForTimeout(300);
	h.check(await P.page.locator('#settings-home').isVisible(), '‹ Settings pops back to the list');
	await P.page.locator('#settings-home .sn-row', { hasText: 'VR' }).first().click();
	await P.page.waitForTimeout(300);
	await P.page.locator('#vr-remap-open').click();
	await P.page.waitForTimeout(300);
	s = await state(P.page);
	h.check(s.chromeTitle === 'Remap buttons' && /VR/.test(s.back), `a submenu pushes another level: "‹ VR · Remap buttons" (${s.back} · ${s.chromeTitle})`);
	await P.page.locator('.settings-shell .wc-back').click();
	await P.page.waitForTimeout(300);
	s = await state(P.page);
	h.check(s.chromeTitle === 'VR' && /Settings/.test(s.back), '‹ VR pops back to the VR page');
	fs.mkdirSync(EVIDENCE, { recursive: true });
	await P.page.screenshot({ path: EVIDENCE + '/40-shell-phone-vr.png' });

	await h.finish(browser);
});
