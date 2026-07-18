// Roadmap #9: Flow + Explorer share the bottom dock when both docked. The Controls
// icons highlight only the VISIBLE panel; clicking Explorer makes it the shown dock
// occupant (Flow un-highlights); clicking a shown panel again closes it.
const h = require('./helpers.cjs');

const state = (page) =>
	page.evaluate(() => {
		const flowI = document.querySelector('p[title="Node editor (N)"] i');
		const explI = document.querySelector('#explorer-slot i');
		const ON = 'text-primary-500';
		let active, flowClosed, explClosed;
		window.__stores.bottomDock.bottomDockActive.subscribe((v) => (active = v))();
		window.__stores.flowGraphClose.subscribe((v) => (flowClosed = v))();
		window.__stores.explorerClose.subscribe((v) => (explClosed = v))();
		return {
			active,
			flowClosed,
			explClosed,
			flowOn: flowI.className.includes(ON),
			explOn: explI.className.includes(ON)
		};
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// both docked (defaults) + open -> shared dock, Flow active by default
	await A.page.evaluate(() => {
		localStorage.setItem('flowDocked', 'true');
		localStorage.setItem('explorerDocked', 'true');
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.evaluate(() => {
		window.__stores.flowGraphClose.set(false);
		window.__stores.explorerClose.set(false);
		window.__stores.bottomDock.bottomDockActive.set('flow');
	});
	await A.page.waitForTimeout(500);
	let s = await state(A.page);
	h.check(s.flowOn && !s.explOn, `both docked: Flow highlighted, Explorer not (active=${s.active})`);

	// click Explorer -> it becomes the shown dock occupant, Flow un-highlights
	await A.page.evaluate(() => document.querySelector('#explorer-slot').click());
	await A.page.waitForTimeout(300);
	s = await state(A.page);
	h.check(s.active === 'explorer' && s.explOn && !s.flowOn, `click Explorer: Explorer shown+highlighted, Flow un-highlighted`);

	// click Node editor -> Flow shown again, Explorer un-highlighted (still open, hidden)
	await A.page.evaluate(() => document.querySelector('p[title="Node editor (N)"]').click());
	await A.page.waitForTimeout(300);
	s = await state(A.page);
	h.check(s.active === 'flow' && s.flowOn && !s.explOn && !s.explClosed, `click Node editor: Flow shown, Explorer hidden but still open`);

	// click Explorer twice: show it, then close it (highlight removed)
	await A.page.evaluate(() => document.querySelector('#explorer-slot').click());
	await A.page.waitForTimeout(250);
	await A.page.evaluate(() => document.querySelector('#explorer-slot').click());
	await A.page.waitForTimeout(300);
	s = await state(A.page);
	h.check(s.explClosed && !s.explOn, 'click Explorer again (shown) closes it + removes highlight');

	await h.finish(browser);
});
