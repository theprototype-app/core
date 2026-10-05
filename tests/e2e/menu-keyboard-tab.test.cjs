// 36 L4 (36-int-122) — TAB MOVES THROUGH A MENU. Tab is a global shortcut (Enter Edit Mesh), which
// preventDefault'ed every press — so inside the profile menu (a flowbite popover) focus never moved
// and "Community" / "Support" / every row were unreachable by keyboard. Inside an open popover / menu /
// dialog Tab is the browser's focus navigation; on the canvas Tab still enters Edit Mesh.
// Run: APP_URL=https://localhost:5339/ node tests/e2e/menu-keyboard-tab.test.cjs
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	const page = A.page;

	// ---- 1. the profile menu: Tab walks its focusable rows
	await page.click('#avatar-trigger');
	await page.waitForSelector('#avatar-dropdown', { state: 'visible' });
	const rows = await page.evaluate(() => {
		const dd = document.querySelector('#avatar-dropdown');
		const f = [...dd.querySelectorAll('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])')].filter((e) => /** @type {HTMLElement} */ (e).offsetParent !== null);
		/** @type {HTMLElement} */ (f[0]).focus();
		return { n: f.length, first: document.activeElement === f[0] };
	});
	h.check(rows.n >= 2 && rows.first, `the profile menu has focusable rows and the first takes focus (${rows.n})`);
	const before = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80));
	await page.keyboard.press('Tab');
	const after = await page.evaluate(() => ({ html: document.activeElement?.outerHTML.slice(0, 80), inside: !!document.activeElement?.closest('#avatar-dropdown') }));
	h.check(after.html !== before && after.inside, `Tab moves focus to the next row inside the menu (${JSON.stringify(after.html)})`);
	await page.keyboard.press('Shift+Tab');
	const back = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80));
	h.check(back === before, 'Shift+Tab moves back');
	await page.keyboard.press('Escape');

	// ---- 2. counterfactual: on the canvas Tab is still the Edit Mesh shortcut
	await page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 600));
		/** @type {HTMLElement} */ (document.activeElement)?.blur?.();
	});
	await page.keyboard.press('Tab');
	await page.waitForTimeout(600);
	const editing = await page.evaluate(() => {
		let v;
		window.__stores.meshEdit.editingObject.subscribe((x) => (v = x))();
		let f;
		window.__stores.faceEdit.faceEditObject?.subscribe?.((x) => (f = x))();
		return !!(v || f);
	});
	h.check(editing, 'outside a menu Tab still enters Edit Mesh on the selection');
	await browser.close();
});
