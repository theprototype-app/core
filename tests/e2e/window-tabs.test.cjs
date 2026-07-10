// Phase 83: window tabbing — drag a window onto another's header to merge
// into a notebook-tab group; tabs switch, the strip moves the group, tabs
// tear off, ✕ closes the active member through its own path.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// open chat + object list
	await A.page.locator('p[title="Object list (O)"]').click();
	await A.page.locator('p[title="Chat (C)"]').click();
	await A.page.waitForTimeout(500);

	// drag the chat by its header ONTO the object list header -> tab group
	const chat = await A.page.locator('#chat-window').boundingBox();
	const list = await A.page.locator('#object-list').boundingBox();
	await A.page.mouse.move(chat.x + 120, chat.y + 12);
	await A.page.mouse.down();
	await A.page.mouse.move(list.x + 120, list.y + 14, { steps: 10 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(400);

	h.check(await A.page.locator('.tab-strip').isVisible(), 'tab strip appears');
	h.check(
		(await A.page.locator('.tab-strip .tab-note').count()) === 2,
		'two notebook tabs in the strip'
	);
	// dropped window (chat) is active; the list is hidden behind it
	const displays = await A.page.evaluate(() => [
		getComputedStyle(document.querySelector('#chat-window')).display,
		getComputedStyle(document.querySelector('#object-list')).display
	]);
	h.check(displays[0] !== 'none' && displays[1] === 'none', 'chat active, list hidden');

	// clicking the Objects tab switches
	await A.page.locator('.tab-note', { hasText: 'Objects' }).click();
	await A.page.waitForTimeout(300);
	const displays2 = await A.page.evaluate(() => [
		getComputedStyle(document.querySelector('#chat-window')).display,
		getComputedStyle(document.querySelector('#object-list')).display
	]);
	h.check(displays2[0] === 'none' && displays2[1] !== 'none', 'tab switch swaps visibility');

	// dragging the strip background moves the whole group
	const strip = await A.page.locator('.tab-strip').boundingBox();
	await A.page.mouse.move(strip.x + strip.width - 60, strip.y + 16);
	await A.page.mouse.down();
	await A.page.mouse.move(strip.x + strip.width - 60 + 90, strip.y + 76, { steps: 8 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const movedList = await A.page.locator('#object-list').boundingBox();
	h.check(
		Math.abs(movedList.x - (list.x + 90)) < 15 && Math.abs(movedList.y - (list.y + 60)) < 15,
		`strip drag moves the group (${list.x} → ${movedList.x})`
	);

	// tearing the chat tab off re-floats it — two visible windows again
	const chatTab = await A.page.locator('.tab-note', { hasText: 'Chat' }).boundingBox();
	await A.page.mouse.move(chatTab.x + 20, chatTab.y + 10);
	await A.page.mouse.down();
	await A.page.mouse.move(chatTab.x + 40, chatTab.y + 160, { steps: 8 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	h.check(
		!(await A.page.locator('.tab-strip').isVisible().catch(() => false)),
		'tear-off dissolves the two-tab group'
	);
	const displays3 = await A.page.evaluate(() => [
		getComputedStyle(document.querySelector('#chat-window')).display,
		getComputedStyle(document.querySelector('#object-list')).display
	]);
	h.check(displays3[0] !== 'none' && displays3[1] !== 'none', 'both windows visible after tear-off');

	// re-merge, then ✕ closes the active member via its own path (chat hides)
	const chat2 = await A.page.locator('#chat-window').boundingBox();
	const list2 = await A.page.locator('#object-list').boundingBox();
	await A.page.mouse.move(chat2.x + 120, chat2.y + 12);
	await A.page.mouse.down();
	await A.page.mouse.move(list2.x + 120, list2.y + 14, { steps: 10 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	await A.page.locator('.tab-strip button[title="Close the active window"]').click();
	await A.page.waitForTimeout(300);
	const chatHidden = await A.page.evaluate(
		() => new Promise((r) => window.__stores.chatHidden.subscribe((v) => r(v === 'hidden'))())
	);
	h.check(chatHidden, 'strip ✕ closed chat through its own store');
	h.check(
		!(await A.page.locator('.tab-strip').isVisible().catch(() => false)),
		'group dissolved after the close'
	);

	await h.finish(browser);
});
