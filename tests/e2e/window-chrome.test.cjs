// Phase 128: window chrome — the object-list window/header is opaque (not
// transparent over the scene), and a tabbed window's ✕ closes ALL its tabs.
const h = require('./helpers.cjs');

function opaque(rgb) {
	// not fully transparent: alpha > 0 and some color
	const m = rgb.match(/rgba?\(([^)]+)\)/);
	if (!m) return false;
	const parts = m[1].split(',').map((s) => parseFloat(s));
	const a = parts.length === 4 ? parts[3] : 1;
	return a > 0.5;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- object list window has a solid background (header not transparent) ---
	await A.page.locator('p[title="Object list (O)"]').click();
	await A.page.waitForTimeout(400);
	const bg = await A.page.evaluate(() => {
		const el = document.querySelector('#object-list');
		return getComputedStyle(el).backgroundColor;
	});
	h.check(opaque(bg), `object list window is opaque (${bg})`);

	// --- a tabbed window's close closes every tab ---
	await A.page.locator('#chat-button').click();
	await A.page.waitForTimeout(400);
	const chat = await A.page.locator('#chat-window').boundingBox();
	const list = await A.page.locator('#object-list').boundingBox();
	await A.page.mouse.move(chat.x + 120, chat.y + 12);
	await A.page.mouse.down();
	await A.page.mouse.move(list.x + 120, list.y + 14, { steps: 10 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(400);
	h.check(await A.page.locator('.tab-strip').isVisible(), 'tab group formed');

	await A.page.locator('.tab-strip button[title="Close all tabs in this window"]').click();
	await A.page.waitForTimeout(400);
	const closed = await A.page.evaluate(
		() =>
			new Promise((r) => {
				let chatV, listV;
				window.__stores.chatHidden.subscribe((v) => (chatV = v))();
				window.__stores.objectListClose.subscribe((v) => (listV = v))();
				r({ chat: chatV === 'hidden', list: listV === true });
			})
	);
	h.check(closed.chat && closed.list, 'the ✕ closed both tabs (chat + object list)');
	h.check(
		!(await A.page.locator('.tab-strip').isVisible().catch(() => false)),
		'the tab group is gone after close-all'
	);

	await h.finish(browser);
});
