// Roadmap #9 + dock rework: the Flow tab "+" adds views; "Flow Code" opens an editable
// view of the graph as a DOCKED tab (starts docked) — compact text by default since 34 D4. Verifies the "+" menu, the
// docked view opening, and that it seeds from the live graph. (Apply round-trip is
// exercised manually — CodeMirror auto-close makes raw-JSON typing unreliable headless.)
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => {
		window.__stores.flowNodes.set([{ id: 'seedNode', type: 'number', position: { x: 10, y: 10 }, data: { type: 'number', value: 5 } }]);
		window.__stores.flowGraphClose.set(false);
	});
	await A.page.waitForTimeout(900);

	// click the Flow tab "+" (docked strip is visible by default)
	await A.page.evaluate(() => {
		const b = [...document.querySelectorAll('button')].find((x) => x.title && x.title.startsWith('Add a view'));
		b?.click();
	});
	await A.page.waitForTimeout(250);
	const hasFlowCode = await A.page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')].some((e) => e.textContent.includes('Flow Code'))
	);
	h.check(hasFlowCode, 'the Flow "+" opens an add-menu with Flow Code');

	await A.page.evaluate(() => {
		const i = [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.includes('Flow Code'));
		i?.click();
	});
	await A.page.waitForTimeout(600);
	const win = await A.page.evaluate(() => {
		const d = document.querySelector('#flow-code-dock');
		return !!d && !d.classList.contains('hidden');
	});
	h.check(win, 'clicking Flow Code opens the Flow Code docked tab');

	// 34 D4: the view opens in the compact TEXT format by default; JSON is one click away
	const seeded = await A.page.evaluate(() => (document.querySelector('#flow-code-dock .cm-content')?.textContent || ''));
	h.check(seeded.includes('seedNode = number+ {value: 5} @10,10 noclass'), 'Flow Code seeds the current graph as compact text: ' + JSON.stringify(seeded.slice(0, 80)));
	await A.page.locator('#flow-code-dock #flow-code-format-json').click();
	await A.page.waitForTimeout(400);
	const json = await A.page.evaluate(() => (document.querySelector('#flow-code-dock .cm-content')?.textContent || ''));
	h.check(json.includes('seedNode') && json.includes('"nodes"') && json.includes('"edges"'), 'the JSON format still has nodes + edges keys');
	await A.page.locator('#flow-code-dock #flow-code-format-text').click();

	await h.finish(browser);
});
