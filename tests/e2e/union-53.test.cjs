// 53-int — THE UNION of the five roadmap-53 lanes, checked where they meet (none of them could alone):
//   U1 contrast x scale: Settings ▸ Accessibility gains the "High contrast" switch (53-contrast Q1) — it writes the
//      same $theme as Interface ▸ Theme, Off goes back to the theme that was on before, and the page's reset turns
//      it off.
//   U2 contrast x keyboard x scale: the High contrast focus ring is drawn from 53-keyboard's focus TOKENS (it was a
//      hard-coded 2px rule beside them) — so a token change reaches it, and at 150 % UI scale it is 1.5x as thick.
//   U3 keyboard x reader: the roving groups 53-keyboard made carry the toolbar role + names 53-reader's Q1 asked
//      for, and the whole editor shell at 150 % in High contrast has no serious/critical axe violation.
// Counterfactual (any single lane, or the plain union before 53-int's commit): no #row-high-contrast (U1 red), the
// HC ring stays 2px whatever the token (U2 red), #hud-tr has no role (U3 red).
const h = require('./helpers.cjs');
const { AxeBuilder } = require('@axe-core/playwright');

/** @param {any} page @param {string} key */
async function openSettings(page, key) {
	await page.evaluate((k) => {
		const s = /** @type {any} */ (window).__tp?.test.v1;
		s.settingsOpen.set(false);
		s.settingsSection.set(k);
		s.settingsOpen.set(true);
	}, key);
	await page.waitForSelector('dialog.settings-dialog .ss-page', { timeout: 15000 });
	await page.waitForTimeout(300);
}
/** @param {any} page */
const closeSettings = (page) => page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.settingsOpen.set(false));
/** @param {any} page */
const themeNow = (page) => page.evaluate(() => document.documentElement.dataset.theme || '');
/** @param {any} page */
const pressed = (page) => page.evaluate(() => document.querySelector('#high-contrast')?.getAttribute('aria-pressed'));
/** the keyboard-focused element's ring @param {any} page */
const ring = (page) =>
	page.evaluate(() => {
		const a = /** @type {HTMLElement} */ (document.activeElement);
		const cs = getComputedStyle(a);
		return { tag: a.tagName, id: a.id, style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), color: cs.outlineColor, fv: a.matches(':focus-visible') };
	});

h.run(async () => {
	const browser = await h.launch();
	const P = await h.setupPage(browser, 'desktop', { context: { viewport: { width: 1280, height: 720 } } });
	const page = P.page;
	await h.answerRestore(P).catch(() => {});

	// ---- U1: the High contrast switch in Settings ▸ Accessibility ------------------------------------------------
	await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.themes.theme.set('light'));
	await page.waitForTimeout(200);
	h.check((await themeNow(page)) === 'light', `premise: the page starts in Light (${await themeNow(page)})`);
	await openSettings(page, 'accessibility');
	const hasRow = (await page.locator('#row-high-contrast').count()) === 1;
	h.check(hasRow, 'U1: Settings ▸ Accessibility has a "High contrast" row (COUNTERFACTUAL: no lane added it)');
	if (hasRow) {
		h.check((await pressed(page)) === 'false', `U1: the switch reads off in Light (${await pressed(page)})`);
		await page.click('#high-contrast');
		await page.waitForTimeout(300);
		h.check((await themeNow(page)) === 'contrast' && (await pressed(page)) === 'true', `U1: on = the High contrast theme (${await themeNow(page)}, ${await pressed(page)})`);
		h.check((await page.evaluate(() => localStorage.getItem('theme'))) === 'contrast', 'U1: stored under the existing theme key (no new state)');
		await openSettings(page, 'interface');
		const sel = await page.evaluate(() => document.querySelector('#theme-select')?.textContent?.trim() ?? '');
		h.check(/High contrast/.test(sel), `U1: Interface ▸ Theme shows the same choice (${sel})`);
		await openSettings(page, 'accessibility');
		await page.click('#high-contrast');
		await page.waitForTimeout(300);
		h.check((await themeNow(page)) === 'light', `U1: off goes back to the theme that was on before (${await themeNow(page)})`);
		await page.click('#high-contrast');
		await page.waitForTimeout(200);
		await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.settingsReset.resetCategory('accessibility'));
		await page.waitForTimeout(200);
		h.check((await themeNow(page)) === 'dark', `U1: resetting Accessibility turns High contrast off (${await themeNow(page)})`);
	}
	await closeSettings(page);

	// ---- U2: the HC ring is the focus TOKENS -------------------------------------------------------------------
	await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.themes.theme.set('contrast'));
	await page.waitForTimeout(300);
	await page.mouse.click(5, 360); // the 3D view, then the keyboard: a real focus-visible ring
	await page.keyboard.press('Escape');
	let r0 = null;
	for (let i = 0; i < 12; i++) {
		await page.keyboard.press('Tab');
		await page.waitForTimeout(80);
		r0 = await ring(page);
		if (r0.tag === 'BUTTON' && r0.fv) break;
	}
	h.check(!!r0 && r0.tag === 'BUTTON' && r0.fv, `premise: Tab lands on a button with keyboard focus (${JSON.stringify(r0)})`);
	h.check(!!r0 && r0.style === 'solid' && Math.abs(r0.width - 2) < 0.1 && /255, 212, 0/.test(r0.color), `U2: HC ring = 2px solid yellow, unchanged look (${JSON.stringify(r0)})`);
	await page.evaluate(() => document.documentElement.style.setProperty('--focus-ring-width', '5px'));
	await page.waitForTimeout(100);
	const r1 = await ring(page);
	h.check(Math.abs(r1.width - 5) < 0.1, `U2: the HC ring follows --focus-ring-width (5px -> ${r1.width}; COUNTERFACTUAL: a hard-coded 2px)`);
	await page.evaluate(() => document.documentElement.style.removeProperty('--focus-ring-width'));
	await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.uiScale.uiScale.set(150));
	await page.waitForTimeout(400);
	const r2 = await ring(page);
	h.check(Math.abs(r2.width - 3) < 0.15, `U2: at 150 % UI scale the HC ring is 1.5x (${r2.width}px)`);

	// ---- U3: toolbar roles + names, and axe at 150 % in High contrast ----------------------------------------
	const roles = await page.evaluate(() =>
		['#hud-tr', '#hud-stack-left', '#hud-stack-right', '#touch-tools', '#controls-pill'].map((s) => {
			const el = document.querySelector(s);
			return { s, role: el?.getAttribute('role') ?? (el ? el.tagName.toLowerCase() : null), name: el?.getAttribute('aria-label') ?? null };
		})
	);
	const want = { '#hud-tr': 'toolbar', '#hud-stack-left': 'toolbar', '#hud-stack-right': 'toolbar', '#touch-tools': 'toolbar', '#controls-pill': 'nav' };
	for (const r of roles) {
		if (r.role === null) continue; // not mounted in this layout
		h.check(r.role === want[/** @type {keyof typeof want} */ (r.s)] && !!r.name, `U3: ${r.s} is a named ${want[/** @type {keyof typeof want} */ (r.s)]} (${r.role}, "${r.name}")`);
	}
	h.check(roles.filter((r) => r.role !== null).length >= 3, `premise: the roving groups are on screen (${roles.filter((r) => r.role !== null).map((r) => r.s).join(' ')})`);
	const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
	const bad = res.violations.filter((/** @type {any} */ v) => v.impact === 'serious' || v.impact === 'critical');
	h.check(bad.length === 0, `U3: the editor shell at 150 % in High contrast has no serious/critical axe violation (${bad.map((/** @type {any} */ v) => `${v.id}x${v.nodes.length}`).join(', ') || 'none'})`);
	await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.uiScale.uiScale.set(100));

	await h.finish(browser);
});
