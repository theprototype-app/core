// Phase 68: layout tiers — chat floats above the flow drawer, flow drag-resize
// persists, undock/dock round-trip keeps the graph interactive.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// open flow + chat together
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.locator('p[title="Chat (C)"]').click();
	await A.page.waitForTimeout(600);
	h.check(await A.page.locator('#flow-list').isVisible(), 'flow drawer open');
	h.check(await A.page.locator('#chat-window').isVisible(), 'chat window open');

	const [zChat, zFlow] = await A.page.evaluate(() => [
		+getComputedStyle(document.querySelector('#chat-window')).zIndex,
		+getComputedStyle(document.querySelector('#flow-list')).zIndex
	]);
	h.check(zChat > zFlow, `chat (${zChat}) floats above the flow drawer (${zFlow})`);

	// the toolbar (hud tier) stays clickable even under the floating chat —
	// close the chat through it before working the flow corner
	await A.page.locator('p[title="Chat (C)"]').click();
	await A.page.waitForTimeout(300);
	h.check(!(await A.page.locator('#chat-window').isVisible()), 'toolbar pill closes chat above it');

	// drag-resize the flow drawer 80px taller via the top hot zone
	const before = (await A.page.locator('#flow-list').boundingBox()).height;
	const hot = await A.page.locator('#flow-list > div').first().boundingBox();
	await A.page.mouse.move(hot.x + 400, hot.y + hot.height / 2);
	await A.page.mouse.down();
	await A.page.mouse.move(hot.x + 400, hot.y + hot.height / 2 - 80, { steps: 8 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(200);
	const after = (await A.page.locator('#flow-list').boundingBox()).height;
	h.check(Math.abs(after - before - 80) < 12, `flow resized by drag (${before} → ${after})`);
	const persisted = await A.page.evaluate(() => localStorage.getItem('flowHeight'));
	h.check(Math.abs(parseInt(persisted) - after) < 12, `new height persisted (${persisted})`);

	// undock into a floating window
	await A.page.locator('#flow-undock').click();
	await A.page.waitForTimeout(500);
	h.check(
		await A.page.locator('#flow-window .svelte-flow').isVisible(),
		'undocked window shows the graph'
	);

	// window drags by its header
	const win = await A.page.locator('#flow-window').boundingBox();
	await A.page.mouse.move(win.x + 200, win.y + 12);
	await A.page.mouse.down();
	await A.page.mouse.move(win.x + 320, win.y + 80, { steps: 6 });
	await A.page.mouse.up();
	const moved = await A.page.locator('#flow-window').boundingBox();
	h.check(
		Math.abs(moved.x - win.x - 120) < 10 && Math.abs(moved.y - win.y - 68) < 10,
		'window drags by its header'
	);

	// graph stays interactive: pane right-click opens the menu with node search
	await A.page
		.locator('#flow-window .svelte-flow__pane')
		.click({ button: 'right', position: { x: 200, y: 150 } });
	await A.page.waitForTimeout(300);
	h.check(
		await A.page.getByText('Search nodes', { exact: false }).first().isVisible(),
		'pane menu works while undocked'
	);
	await A.page.mouse.click(900, 60); // close the menu (backdrop)
	await A.page.waitForTimeout(200);

	// dock restores the drawer
	await A.page.locator('#flow-dock').click();
	await A.page.waitForTimeout(500);
	h.check(await A.page.locator('#flow-list .svelte-flow').isVisible(), 'dock restores the drawer');

	await h.finish(browser);
});
