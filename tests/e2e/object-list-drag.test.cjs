// Phase 153: the object-list window drags by its title bar (the "☰ Objects"
// text), like the Explorer. Previously the drag only started when the click
// landed exactly on the header div, not its title span. The header search still
// focuses/types without moving the window.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// open the object list
	await A.page.locator('p[title="Object list (O)"]').click();
	await A.page.waitForTimeout(400);

	const before = await A.page.locator('#object-list').boundingBox();
	// grab the TITLE span (not the header padding) and drag
	const title = await A.page.locator('#object-list .move-handle span').first().boundingBox();
	const gx = title.x + title.width / 2;
	const gy = title.y + title.height / 2;
	await A.page.mouse.move(gx, gy);
	await A.page.mouse.down();
	await A.page.mouse.move(gx + 130, gy + 90, { steps: 8 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(150);
	const after = await A.page.locator('#object-list').boundingBox();
	h.check(
		Math.abs(after.x - before.x) > 60 && Math.abs(after.y - before.y) > 40,
		`dragging the title moves the window (${before.x.toFixed(0)},${before.y.toFixed(0)} -> ${after.x.toFixed(0)},${after.y.toFixed(0)})`
	);

	// the header search focuses/types WITHOUT moving the window
	const pos1 = await A.page.locator('#object-list').boundingBox();
	await A.page.locator('#object-search').click();
	await A.page.locator('#object-search').type('box', { delay: 10 });
	await A.page.waitForTimeout(100);
	const pos2 = await A.page.locator('#object-list').boundingBox();
	h.check(
		Math.abs(pos2.x - pos1.x) < 3 && Math.abs(pos2.y - pos1.y) < 3,
		'clicking + typing in the header search does not move the window'
	);
	h.check((await A.page.inputValue('#object-search')) === 'box', 'the header search still accepts text');

	await h.finish(browser);
});
