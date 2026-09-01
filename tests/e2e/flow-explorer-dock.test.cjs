// Docking rework, phase 3: the bottom dock shows ONE panel, and every docked+open
// panel is a notebook TAB in it — the Explorer included. Switching tabs closes
// NOTHING: clicking Explorer shows it (the Node editor un-highlights but stays open
// as a hidden tab) and clicking the Node editor shows the flow tab again with the
// Explorer still open behind it. Clicking a panel's own toolbar button while that
// panel is the one on screen hides it. (Before this phase a flow tab becoming
// visible force-CLOSED the Explorer.)
const h = require('./helpers.cjs');

const state = (page) =>
	page.evaluate(() => {
		const flowI = document.querySelector('p[title="Node editor (N)"] svg');
		const explI = document.querySelector('#explorer-slot svg');
		const ON = 'text-primary-500';
		let active, flowClosed, explClosed, occ;
		window.__stores.bottomDock.bottomDockActive.subscribe((v) => (active = v))();
		window.__stores.bottomDock.dockOccupants.subscribe((v) => (occ = v))();
		window.__stores.flowGraphClose.subscribe((v) => (flowClosed = v))();
		window.__stores.explorerClose.subscribe((v) => (explClosed = v))();
		// the strip of the dock panel actually on screen (both containers stay
		// mounted; the covered one carries a `hidden` class)
		const box = [...document.querySelectorAll('#flow-list, #explorer-list')].find(
			(el) => !el.classList.contains('hidden')
		);
		return {
			active,
			flowClosed,
			explClosed,
			present: Object.keys(occ).filter((k) => occ[k]?.present).sort(),
			strip: box ? [...box.querySelectorAll('.tab-note')].map((b) => b.textContent.trim()).filter(Boolean) : [],
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
	h.check(
		s.present.join(',') === 'explorer,flow' && s.strip.includes('Explorer') && s.strip.includes('Node editor'),
		`the strip lists BOTH panels as tabs (${s.strip.join('|')})`
	);

	// click Explorer -> it becomes the shown dock occupant, Flow un-highlights but
	// stays OPEN (a covered tab, not a closed panel)
	await A.page.evaluate(() => document.querySelector('#explorer-slot').click());
	await A.page.waitForTimeout(300);
	s = await state(A.page);
	h.check(s.active === 'explorer' && s.explOn && !s.flowOn, 'click Explorer: Explorer shown+highlighted, Flow un-highlighted');
	h.check(s.flowClosed === false && s.present.includes('flow'), 'the covered Node editor stays open as a dock tab');

	// click Node editor -> Flow shown again and the Explorer is STILL OPEN (this is
	// the exclusivity that phase 3 deleted)
	await A.page.evaluate(() => document.querySelector('p[title="Node editor (N)"]').click());
	await A.page.waitForTimeout(300);
	s = await state(A.page);
	h.check(s.active === 'flow' && s.flowOn && !s.explOn, 'click Node editor: Flow shown, Explorer un-highlighted');
	h.check(
		s.explClosed === false && s.present.join(',') === 'explorer,flow' && s.strip.includes('Explorer'),
		`showing the flow tab does NOT close the Explorer — it stays a tab (${s.strip.join('|')})`
	);

	// the strip's own Explorer tab brings it back
	await A.page.evaluate(() => {
		const box = [...document.querySelectorAll('#flow-list, #explorer-list')].find((el) => !el.classList.contains('hidden'));
		[...box.querySelectorAll('.tab-note')].find((b) => b.textContent.trim() === 'Explorer').click();
	});
	await A.page.waitForTimeout(300);
	s = await state(A.page);
	h.check(s.active === 'explorer' && s.explOn && s.flowClosed === false, 'clicking the Explorer TAB shows it again, Node editor still open');

	// clicking the toolbar button of the panel that IS on screen hides it
	await A.page.evaluate(() => document.querySelector('#explorer-slot').click());
	await A.page.waitForTimeout(300);
	s = await state(A.page);
	h.check(s.explClosed && !s.explOn, 'click Explorer again (shown) closes it + removes highlight');
	h.check(s.active === 'explorer' && s.flowClosed === false, 'and the Node editor is still open, so the dock falls back to it');

	await h.finish(browser);
});
