// Phase 84: search menus v2 — scrollable results, right-drag moves the box,
// input context menu with Copy/Clear (Paste is permission-gated).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const ctx = await browser.newContext({
		ignoreHTTPSErrors: true,
		permissions: ['clipboard-read', 'clipboard-write']
	});
	const page = await ctx.newPage();
	// this suite builds its own context (clipboard permissions), so it needs the
	// first-run guards h.setupPage normally applies — a virgin profile opens the
	// welcome overlay, whose backdrop would swallow the menu interactions below
	await page.addInitScript(() => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		localStorage.setItem('hasSeenWelcome', 'true');
	});
	await page.goto(h.URL, { waitUntil: 'load' });
	await page.waitForFunction(() => window.__stores && window.__stores.peers, { timeout: 30000 });
	await page.waitForTimeout(1500);

	// Add search: open via Shift+A (opt-in pref, default off), results list scrolls
	await page.evaluate(() => window.__stores.enableShiftAdd.set(true));
	await page.keyboard.press('Shift+KeyA');
	await page.waitForTimeout(300);
	h.check(await page.locator('#add-search-box').isVisible(), 'add search opens');
	const scrolls = await page.evaluate(() => {
		const list = document.querySelector('#add-search-box .overflow-y-auto');
		return list ? list.scrollHeight > list.clientHeight : false;
	});
	h.check(scrolls, 'add results are scrollable (full catalog)');

	// arrow keys keep the highlight in view
	for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowDown');
	await page.waitForTimeout(200);
	const inView = await page.evaluate(() => {
		const list = document.querySelector('#add-search-box .overflow-y-auto');
		const sel = list?.querySelector('[data-selected="true"]');
		if (!list || !sel) return false;
		const lr = list.getBoundingClientRect();
		const sr = sel.getBoundingClientRect();
		return sr.top >= lr.top - 2 && sr.bottom <= lr.bottom + 2;
	});
	h.check(inView, 'arrow keys scroll the highlight into view');

	// right-drag anywhere on the box (not the field) moves it
	const before = await page.locator('#add-search-box').boundingBox();
	await page.mouse.move(before.x + 100, before.y + 120); // over the results
	await page.mouse.down({ button: 'right' });
	await page.mouse.move(before.x + 220, before.y + 200, { steps: 6 });
	await page.mouse.up({ button: 'right' });
	const after = await page.locator('#add-search-box').boundingBox();
	h.check(
		after.x > before.x + 80 && after.y > before.y + 40,
		`right-drag moves the search box (${before.x} → ${after.x})`
	);

	// input context menu: type, right-click the field, Copy + Clear
	await page.locator('#add-search-input').fill('torus');
	await page.locator('#add-search-input').click({ button: 'right' });
	await page.waitForTimeout(200);
	h.check(await page.locator('#input-context-menu').isVisible(), 'custom input menu shows');
	await page.locator('#input-context-menu button', { hasText: 'Copy' }).click();
	await page.waitForTimeout(200);
	const copied = await page.evaluate(() => navigator.clipboard.readText());
	h.check(copied === 'torus', `Copy wrote the clipboard (${copied})`);
	await page.locator('#add-search-input').click({ button: 'right' });
	await page.waitForTimeout(200);
	await page.locator('#input-context-menu button', { hasText: 'Paste' }).click();
	await page.waitForTimeout(200);
	const pasted = await page.locator('#add-search-input').inputValue();
	h.check(pasted.includes('torustorus') || pasted.includes('torus'), `Paste inserted text (${pasted})`);
	await page.locator('#add-search-input').click({ button: 'right' });
	await page.waitForTimeout(200);
	await page.locator('#input-context-menu button', { hasText: 'Clear' }).click();
	await page.waitForTimeout(200);
	h.check((await page.locator('#add-search-input').inputValue()) === '', 'Clear empties the field');
	await page.keyboard.press('Escape');

	// node search: open flow, right-click pane, type to search, box right-drags
	await page.locator('p[title="Node editor (N)"]').click();
	await page.waitForTimeout(600);
	await page.locator('.svelte-flow__pane').click({ button: 'right', position: { x: 400, y: 120 } });
	await page.waitForTimeout(300);
	await page.keyboard.type('s');
	await page.waitForTimeout(300);
	h.check(await page.locator('#node-search-box').isVisible(), 'node search opens');
	const nb = await page.locator('#node-search-box').boundingBox();
	await page.mouse.move(nb.x + 60, nb.y + 70);
	await page.mouse.down({ button: 'right' });
	await page.mouse.move(nb.x + 180, nb.y + 140, { steps: 5 });
	await page.mouse.up({ button: 'right' });
	const nbAfter = await page.locator('#node-search-box').boundingBox();
	h.check(nbAfter.x > nb.x + 80, `node search box right-drags (${nb.x} → ${nbAfter.x})`);

	await ctx.close();
	await h.finish(browser);
});
