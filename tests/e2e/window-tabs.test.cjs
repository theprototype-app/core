// Phase 83: window tabbing — drag a window onto another's header to merge
// into a notebook-tab group; tabs switch, the strip moves the group, tabs
// tear off, ✕ closes the active member through its own path.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// open chat + object list
	await A.page.locator('p[title="Object list (O)"]').click();
	await A.page.locator('#chat-button').click();
	await A.page.waitForTimeout(500);

	// drag the chat by its header ONTO the object list header -> tab group
	const chat = await A.page.locator('#chat-window').boundingBox();
	const list = await A.page.locator('#object-list').boundingBox();
	await A.page.mouse.move(chat.x + 120, chat.y + 12);
	await A.page.mouse.down();
	await A.page.mouse.move(list.x + 120, list.y + 14, { steps: 10 });
	// 104: the target header highlights BEFORE release
	const highlighted = await A.page.evaluate(() =>
		document.querySelector('#object-list')?.classList.contains('merge-target')
	);
	await A.page.mouse.up();
	await A.page.waitForTimeout(400);
	h.check(highlighted === true, 'merge target highlights during the drag (104)');
	const cleared = await A.page.evaluate(() =>
		document.querySelector('#object-list')?.classList.contains('merge-target')
	);
	h.check(cleared === false, 'highlight clears on drop');

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

	// 92: merge chat INTO the list again, close the LIST (the inactive member)
	// through its shortcut store, reopen it — it must come back (the tab group
	// used to leave display:none behind and the window vanished until reload)
	await A.page.locator('#chat-button').click();
	await A.page.waitForTimeout(300);
	const chat3 = await A.page.locator('#chat-window').boundingBox();
	const list3 = await A.page.locator('#object-list').boundingBox();
	await A.page.mouse.move(chat3.x + 120, chat3.y + 12);
	await A.page.mouse.down();
	await A.page.mouse.move(list3.x + 120, list3.y + 14, { steps: 10 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	// list is the INACTIVE member now (chat active) — toggle it closed + open
	await A.page.evaluate(() => window.__stores.objectListClose.set(true));
	await A.page.waitForTimeout(200);
	await A.page.evaluate(() => window.__stores.objectListClose.set(false));
	await A.page.waitForTimeout(300);
	const listBack = await A.page.evaluate(() => {
		const el = document.querySelector('#object-list');
		return getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
	});
	h.check(listBack, 'inactive tab member reopens after close (92 regression)');

	// 92: the corner grip resizes the floating list (chat closed so nothing
	// overlaps the corner)
	await A.page.evaluate(() => window.__stores.chatHidden.set('hidden'));
	await A.page.waitForTimeout(200);
	const before = await A.page.locator('#object-list').boundingBox();
	await A.page.mouse.move(before.x + before.width - 6, before.y + before.height - 6);
	await A.page.mouse.down();
	await A.page.mouse.move(before.x + before.width + 74, before.y + before.height + 54, { steps: 8 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const after = await A.page.locator('#object-list').boundingBox();
	h.check(
		after.width > before.width + 60 && after.height > before.height + 40,
		`corner grip resizes the list (${Math.round(before.width)}x${Math.round(before.height)} → ${Math.round(after.width)}x${Math.round(after.height)})`
	);
	// footer stays glued to the (now taller) bottom edge
	const footerGap = await A.page.evaluate(() => {
		const win = document.querySelector('#object-list').getBoundingClientRect();
		const footer = document.querySelector('#object-count').getBoundingClientRect();
		return Math.abs(win.bottom - footer.bottom);
	});
	h.check(footerGap < 2, `footer fills the resized window (gap ${footerGap.toFixed(1)}px)`);

	await h.finish(browser);
});
