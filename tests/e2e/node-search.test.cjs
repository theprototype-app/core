// Phase 62: node search — swap-box replaces the pane menu, type-to-search,
// Enter drops the node at the right-click spot, Esc returns to the menu.
const h = require('./helpers.cjs');

const nodeTypes = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.flowNodes.subscribe((n) => r(n.map((x) => x.type)))())
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// open the flow editor and right-click the pane
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(800);
	const pane = A.page.locator('.svelte-flow__pane');
	await pane.click({ button: 'right', position: { x: 400, y: 120 } });
	await A.page.waitForTimeout(300);
	h.check(
		await A.page.getByText('🔍 Search nodes…').isVisible(),
		'menu shows the search entry first'
	);

	// typing while the menu is open jumps into search with the char prefilled
	await A.page.keyboard.type('p');
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('#node-search-box').isVisible(), 'typing swaps the menu for the search box');
	const value = await A.page.locator('#node-search-input').inputValue();
	h.check(value === 'p', `typed character carried into the input (${value})`);

	// narrow to path patrol and Enter-drop it
	await A.page.locator('#node-search-input').fill('path');
	await A.page.waitForTimeout(200);
	h.check(
		await A.page.locator('#node-search-box').getByText('Path patrol').isVisible(),
		'results show Category · Label matches'
	);
	await A.page.keyboard.press('Enter');
	await h.eventually(() => nodeTypes(A.page), (t) => t.includes('pathpatrol'), 'Enter adds the node');
	h.check(!(await A.page.locator('#node-search-box').isVisible()), 'search closes after adding');

	// Esc from search returns to the classic grouped menu (empty spot, away from the new node)
	await pane.click({ button: 'right', position: { x: 660, y: 60 } });
	await A.page.waitForTimeout(300);
	await A.page.keyboard.type('w');
	await A.page.waitForTimeout(200);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);
	h.check(await A.page.getByText('🔍 Search nodes…').isVisible(), 'Esc restores the grouped menu');
	await A.page.mouse.click(900, 400); // backdrop click closes the restored menu
	await A.page.waitForTimeout(200);

	// module + custom entries searchable: wave from the hello module
	await pane.click({ button: 'right', position: { x: 240, y: 220 } });
	await A.page.waitForTimeout(200);
	await A.page.keyboard.type('wave');
	await A.page.waitForTimeout(200);
	await A.page.keyboard.press('Enter');
	await h.eventually(() => nodeTypes(A.page), (t) => t.includes('wave'), 'module nodes searchable');

	// palette filter narrows the drag list
	await A.page.locator('#palette-filter').fill('slider');
	await A.page.waitForTimeout(200);
	const paletteLabels = await A.page.evaluate(() =>
		[...document.querySelectorAll('aside [draggable="true"]')].map((el) => el.textContent?.trim())
	);
	h.check(
		paletteLabels.length === 1 && paletteLabels[0] === 'Slider',
		`palette filter works (${paletteLabels.join(',')})`
	);

	await h.finish(browser);
});
