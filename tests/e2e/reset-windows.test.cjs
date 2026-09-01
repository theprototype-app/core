// Phase 169: Settings "Reset window positions" clears every persisted floating-
// window rect + re-lays live windows, rescuing any that drifted off-screen.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// stash some off-screen window positions + a customized toolbar (W1 folded the
	// Controls roster in: every other way back out of one is a right-click, and iOS
	// Safari fires no `contextmenu` at all)
	await A.page.evaluate(() => {
		localStorage.setItem('win:chat-window', JSON.stringify({ left: 9999, top: 9999 }));
		localStorage.setItem('objectListRect', JSON.stringify({ left: 9999, top: 9999, width: 300, height: 250 }));
		localStorage.setItem('explorerWinW', '640');
		localStorage.setItem(
			'controlsLayout',
			JSON.stringify({ order: ['move'], hidden: [], spacerIndex: 0, collapsed: true })
		);
	});

	// open Settings + expand the INTERFACE accordion (a collapsed AccordionItem renders
	// no body at all in flowbite 1.x). This used to say 'Scene', which is why the suite
	// was red: the row lives under Interface ▸ Windows & chrome, so the button was never
	// in the DOM and the click threw on null.
	await A.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await A.page.waitForTimeout(500);
	await A.page.getByText('Interface', { exact: true }).first().click();
	await A.page.waitForTimeout(300);
	const present = await A.page.evaluate(() => !!document.querySelector('#reset-windows'));
	h.check(present, 'Settings has a Reset window positions button');
	await A.page.evaluate(() => document.querySelector('#reset-windows').click());
	await A.page.waitForTimeout(300);

	const cleared = await A.page.evaluate(() => ({
		chat: localStorage.getItem('win:chat-window'),
		objectList: localStorage.getItem('objectListRect'),
		explorer: localStorage.getItem('explorerWinW'),
		controls: localStorage.getItem('controlsLayout')
	}));
	h.check(cleared.chat === null, 'a floating window rect (win:*) is cleared');
	h.check(cleared.objectList === null, 'the object-list rect is cleared');
	h.check(cleared.explorer === null, 'the Explorer window size is cleared');
	h.check(cleared.controls === null, 'W1: the Controls toolbar layout is cleared with them');

	await h.finish(browser);
});
