// Docking rework: the bottom dock shows ONE panel. The Node editor (Flow-family) and
// the Explorer are MUTUALLY EXCLUSIVE — clicking Explorer shows it (Flow un-highlights,
// stays open+hidden); clicking the Node editor shows the Flow dock AND closes the
// Explorer (single docked panel). Clicking a shown panel again closes it.
const h = require('./helpers.cjs');

const state = (page) =>
	page.evaluate(() => {
		const flowI = document.querySelector('p[title="Node editor (N)"] svg');
		const explI = document.querySelector('#explorer-slot svg');
		const ON = 'text-primary-500';
		let active, flowClosed, explClosed;
		window.__stores.bottomDock.bottomDockActive.subscribe((v) => (active = v))();
		window.__stores.flowGraphClose.subscribe((v) => (flowClosed = v))();
		window.__stores.explorerClose.subscribe((v) => (explClosed = v))();
		return {
			active,
			flowClosed,
			explClosed,
			flowOn: (flowI.getAttribute('class') ?? '').includes(ON),
			explOn: (explI.getAttribute('class') ?? '').includes(ON)
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

	// click Node editor -> Flow shown again AND the Explorer is CLOSED (single docked panel)
	await A.page.evaluate(() => document.querySelector('p[title="Node editor (N)"]').click());
	await A.page.waitForTimeout(300);
	s = await state(A.page);
	h.check(s.active === 'flow' && s.flowOn && !s.explOn && s.explClosed, `click Node editor: Flow shown, Explorer closed (exclusive)`);

	// click Explorer twice: show it, then close it (highlight removed)
	await A.page.evaluate(() => document.querySelector('#explorer-slot').click());
	await A.page.waitForTimeout(250);
	await A.page.evaluate(() => document.querySelector('#explorer-slot').click());
	await A.page.waitForTimeout(300);
	s = await state(A.page);
	h.check(s.explClosed && !s.explOn, 'click Explorer again (shown) closes it + removes highlight');

	await h.finish(browser);
});
