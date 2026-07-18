// Roadmap #9: the Flow tab "+" adds views; "Flow Code" opens an editable JSON view
// of the graph (ex-backlog). Verifies the "+" menu, the window opening, and that it
// seeds from the live graph. (Apply round-trip is exercised manually — CodeMirror
// auto-close makes raw-JSON typing unreliable in a headless test.)
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
	const win = await A.page.evaluate(() => !!document.querySelector('#flow-code-window'));
	h.check(win, 'clicking Flow Code opens the Flow Code window');

	const seeded = await A.page.evaluate(() => (document.querySelector('#flow-code-window .cm-content')?.textContent || ''));
	h.check(seeded.includes('seedNode'), 'Flow Code seeds the current graph as JSON');
	h.check(seeded.includes('"nodes"') && seeded.includes('"edges"'), 'the JSON has nodes + edges keys');

	await h.finish(browser);
});
