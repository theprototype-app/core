// 36 U6 — NO ACCIDENTAL TEXT SELECTION IN THE CHROME. A real-mouse drag across the burger menu,
// across a panel's labels, and from the viewport over the chrome selects NOTHING by default;
// with "Allow text selection everywhere" on, a drag across a panel selects its text again, while
// a viewport drag still never does. Text fields and help text stay selectable either way.
// Run: APP_URL=https://theprototype.app:5321/ npm run e2e -- text-selection
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 860 } } });
	const page = A.page;
	const selected = () => page.evaluate(() => (window.getSelection()?.toString() || '').trim());
	const clearSel = () => page.evaluate(() => window.getSelection()?.removeAllRanges());
	/** a real mouse drag between two points @param {{x:number,y:number}} a @param {{x:number,y:number}} b */
	const drag = async (a, b) => {
		await clearSel();
		await page.mouse.move(a.x, a.y);
		await page.mouse.down();
		for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10);
		await page.mouse.up();
		await page.waitForTimeout(150);
		return selected();
	};
	/** a point inside the text of the first element matching `sel` whose text matches `re` */
	const at = (sel, re, dx = 2) =>
		page.evaluate(
			([sel, re, dx]) => {
				const el = [...document.querySelectorAll(sel)].find((e) => new RegExp(re).test(e.textContent || '') && e.getBoundingClientRect().width > 0);
				if (!el) return null;
				const r = el.getBoundingClientRect();
				return { x: Math.round(r.left + dx), y: Math.round(r.top + r.height / 2) };
			},
			[sel, re, dx]
		);
	const setAllow = (on) => page.evaluate((on) => window.__stores.textSelection.allowTextSelection.set(on), on);

	// ---- the Settings modal: drag across two rows' NAMES (plain text, not buttons)
	await page.evaluate(() => {
		window.__stores.settingsSection.set('interface'); // opens with Interface expanded
		window.__stores.settingsOpen.set(true);
	});
	await page.waitForSelector('#settings-search', { timeout: 10000 });
	await page.waitForTimeout(700);
	const s1 = await at('.setting-row', 'Theme');
	const s2 = await at('.setting-row', 'Custom theme', 60);
	h.check(!!s1 && !!s2, 'premise: two settings rows are on screen');
	let got = await drag(/** @type {any} */ (s1), { x: /** @type {any} */ (s2).x + 120, y: /** @type {any} */ (s2).y });
	h.check(got === '', `a drag across settings rows selects nothing (${JSON.stringify(got.slice(0, 40))})`);

	await setAllow(true);
	await page.waitForTimeout(200);
	got = await drag(/** @type {any} */ (s1), { x: /** @type {any} */ (s2).x + 120, y: /** @type {any} */ (s2).y });
	h.check(got.length > 0, `with "Allow text selection everywhere" on, the same drag selects (${JSON.stringify(got.slice(0, 40))})`);
	h.check(
		await page.evaluate(() => document.documentElement.classList.contains('allow-text-select')),
		'the setting is the html class the CSS reads'
	);
	await setAllow(false);
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(400);

	// ---- the burger menu: a drag from one row to another
	await page.evaluate(() => window.__stores.closeMenu.set(false));
	await page.waitForSelector('#sidebar70', { timeout: 5000 });
	await page.waitForTimeout(300);
	const m1 = await at('#sidebar70 .side-row', 'Templates', 40);
	const m2 = await at('#sidebar70 .side-row', 'Settings', 60);
	got = await drag(/** @type {any} */ (m1), /** @type {any} */ (m2));
	h.check(got === '', `a drag across the burger menu selects nothing (${JSON.stringify(got.slice(0, 40))})`);
	await page.evaluate(() => window.__stores.closeMenu.set(true));
	await page.waitForTimeout(300);

	// ---- the viewport: a press on the canvas dragged over the bottom toolbar, EVEN with the
	// setting on, never selects (and a stray selection is cleared on the press)
	await setAllow(true);
	await page.evaluate(() => {
		// a stray selection left on screen (e.g. from the chat) …
		const p = document.createElement('p');
		p.id = 'zz-stray';
		p.className = 'tp-selectable';
		p.textContent = 'stray selection';
		p.style.cssText = 'position:fixed;left:10px;top:300px;z-index:9999';
		document.body.appendChild(p);
		const r = document.createRange();
		r.selectNodeContents(p);
		window.getSelection()?.addRange(r);
	});
	h.check((await selected()) === 'stray selection', 'premise: a selection is on screen');
	await page.mouse.move(640, 420);
	await page.mouse.down();
	h.check((await selected()) === '', 'a press on the viewport clears a stray selection');
	for (let i = 1; i <= 12; i++) await page.mouse.move(640, 420 + i * 30);
	await page.mouse.up();
	got = await selected();
	h.check(got === '', `a viewport drag over the toolbar selects nothing, setting on (${JSON.stringify(got.slice(0, 40))})`);
	await setAllow(false);

	// ---- content stays selectable by default: a text field and help text
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	await page.waitForSelector('#settings-search');
	await page.fill('#settings-search', 'theme colour');
	await page.focus('#settings-search');
	await page.keyboard.press('Control+A');
	const inField = await page.evaluate(() => {
		const i = /** @type {HTMLInputElement} */ (document.getElementById('settings-search'));
		return i.value.slice(i.selectionStart ?? 0, i.selectionEnd ?? 0);
	});
	h.check(inField === 'theme colour', `a text field still selects (${inField})`);
	const helpUs = await page.evaluate(() => {
		const d = document.querySelector('.sr-desc');
		return d ? getComputedStyle(d).userSelect : 'missing';
	});
	h.check(helpUs === 'text', `help text (a setting's description) stays selectable (${helpUs})`);
	await h.finish(browser);
});
