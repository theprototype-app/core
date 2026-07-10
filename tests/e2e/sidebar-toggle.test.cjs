// Phase 72: Configure Scene / Library sidebar items toggle; selection-driven
// panels keep open-only semantics.
const h = require('./helpers.cjs');

const isOpen = (page, store) =>
	page.evaluate(
		(store) => new Promise((r) => window.__stores[store].subscribe((v) => r(v === false))()),
		store
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => window.__stores.closeMenu.set(false));
	await A.page.waitForTimeout(400);

	// Configure Scene: click opens, click again closes
	await A.page.getByText('Configure Scene', { exact: true }).click();
	await A.page.waitForTimeout(300);
	h.check(await isOpen(A.page, 'scenePropertiesClose'), 'Configure Scene opens');
	h.check(await A.page.getByText('● Configure Scene', { exact: true }).isVisible(), 'active dot shown');
	await A.page.getByText('● Configure Scene', { exact: true }).click();
	await A.page.waitForTimeout(300);
	h.check(!(await isOpen(A.page, 'scenePropertiesClose')), 'second click closes it');

	// Library: same toggle
	await A.page.getByText('Library', { exact: true }).click();
	await A.page.waitForTimeout(300);
	h.check(await isOpen(A.page, 'libraryClose'), 'Library opens');
	await A.page.getByText('● Library', { exact: true }).click();
	await A.page.waitForTimeout(300);
	h.check(!(await isOpen(A.page, 'libraryClose')), 'second click closes Library');

	// properties stays open-only: repeated showSidebar('properties') never closes
	await A.page.evaluate(() => {
		window.__stores.showSidebar('properties');
		window.__stores.showSidebar('properties');
	});
	await A.page.waitForTimeout(300);
	h.check(await isOpen(A.page, 'propertiesClose'), 'properties keeps open-only semantics');

	await h.finish(browser);
});
