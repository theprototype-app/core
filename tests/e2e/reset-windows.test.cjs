// Phase 169: Settings "Reset window positions" clears every persisted floating-
// window rect + re-lays live windows, rescuing any that drifted off-screen.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// stash some off-screen window positions
	await A.page.evaluate(() => {
		localStorage.setItem('win:chat-window', JSON.stringify({ left: 9999, top: 9999 }));
		localStorage.setItem('objectListRect', JSON.stringify({ left: 9999, top: 9999, width: 300, height: 250 }));
		localStorage.setItem('explorerWinW', '640');
	});

	// open Settings + expand the Scene accordion (collapsed items don't render)
	await A.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await A.page.waitForTimeout(500);
	await A.page.getByText('Scene', { exact: true }).first().click();
	await A.page.waitForTimeout(300);
	const present = await A.page.evaluate(() => !!document.querySelector('#reset-windows'));
	h.check(present, 'Settings has a Reset window positions button');
	await A.page.evaluate(() => document.querySelector('#reset-windows').click());
	await A.page.waitForTimeout(300);

	const cleared = await A.page.evaluate(() => ({
		chat: localStorage.getItem('win:chat-window'),
		objectList: localStorage.getItem('objectListRect'),
		explorer: localStorage.getItem('explorerWinW')
	}));
	h.check(cleared.chat === null, 'a floating window rect (win:*) is cleared');
	h.check(cleared.objectList === null, 'the object-list rect is cleared');
	h.check(cleared.explorer === null, 'the Explorer window size is cleared');

	await h.finish(browser);
});
