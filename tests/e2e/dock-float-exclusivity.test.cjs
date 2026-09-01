// Docked vs floating, phase 3: the dock has ONE slot but no exclusivity — panels
// coexist as tabs. A FLOATING Node editor does not compete for the dock at all, so
// clicking it leaves a docked Explorer alone; and DOCKING it does not close the
// Explorer either any more (it just becomes the visible tab, with the Explorer one
// tab over). This suite pins both halves, since the second one used to be the
// force-close.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// Node editor floating, Explorer docked
	await A.page.evaluate(() => {
		localStorage.setItem('flowDocked', 'false');
		localStorage.setItem('explorerDocked', 'true');
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		s.explorerClose.set(false);
		s.bottomDock.bottomDockActive.set('explorer');
	});
	await A.page.waitForTimeout(700);

	const before = await A.page.evaluate(() => {
		const s = window.__stores;
		let ec, k;
		s.explorerClose.subscribe((v) => (ec = v))();
		s.bottomDock.visibleDockKey.subscribe((v) => (k = v))();
		const ON = 'text-primary-500';
		const flowI = document.querySelector('p[title="Node editor (N)"] svg');
		const explI = document.querySelector('#explorer-slot svg');
		return {
			explorerClosed: ec,
			visible: k,
			floatWin: !!document.getElementById('flow-window'),
			flowOn: (flowI.getAttribute('class') ?? '').includes(ON),
			explOn: (explI.getAttribute('class') ?? '').includes(ON)
		};
	});
	h.check(before.explorerClosed === false && before.visible === 'explorer' && before.floatWin, `setup: Explorer docked+visible, Node editor floating (visible=${before.visible})`);
	// the icon stays highlighted for a FLOATING panel (both are on screen -> both lit)
	h.check(before.flowOn && before.explOn, 'the floating Node editor AND the docked Explorer icons are both highlighted');

	// click Node editor -> the floating flow HIDES (show/hide), the docked Explorer is
	// left alone (a floating flow never touches the dock)
	await A.page.evaluate(() => document.querySelector('p[title="Node editor (N)"]').click());
	await A.page.waitForTimeout(300);
	const afterClick = await A.page.evaluate(() => {
		const s = window.__stores;
		let ec, fc;
		s.explorerClose.subscribe((v) => (ec = v))();
		s.flowGraphClose.subscribe((v) => (fc = v))();
		return { explorerClosed: ec, flowClosed: fc };
	});
	h.check(afterClick.explorerClosed === false, 'clicking Node editor with a FLOATING flow does NOT close the docked Explorer');
	h.check(afterClick.flowClosed === true, 'clicking a shown floating Node editor hides it (show/hide)');

	// re-open the Node editor and DOCK it -> both are docked now, and they COEXIST as
	// tabs: the flow tab shows, the Explorer stays open one tab over
	await A.page.evaluate(() => window.__stores.flowGraphClose.set(false));
	await A.page.waitForTimeout(250);
	await A.page.evaluate(() => document.getElementById('flow-dock')?.click());
	await A.page.waitForTimeout(500);
	const afterDock = await A.page.evaluate(() => {
		const s = window.__stores;
		let ec, k, occ;
		s.explorerClose.subscribe((v) => (ec = v))();
		s.bottomDock.visibleDockKey.subscribe((v) => (k = v))();
		s.bottomDock.dockOccupants.subscribe((v) => (occ = v))();
		const box = [...document.querySelectorAll('#flow-list, #explorer-list')].find((el) => !el.classList.contains('hidden'));
		return {
			explorerClosed: ec,
			visible: k,
			present: Object.keys(occ).filter((x) => occ[x]?.present).sort(),
			strip: box ? [...box.querySelectorAll('.tab-note')].map((b) => b.textContent.trim()).filter(Boolean) : []
		};
	});
	h.check(afterDock.visible === 'flow', `docking the Node editor makes it the visible dock tab (visible=${afterDock.visible})`);
	h.check(afterDock.explorerClosed === false, 'docking the Node editor does NOT close the Explorer any more');
	h.check(
		afterDock.present.join(',') === 'explorer,flow' && afterDock.strip.includes('Explorer'),
		`both are dock tabs and the strip says so (${afterDock.strip.join('|')})`
	);

	// and the Explorer tab brings it straight back, with the flow still open
	await A.page.evaluate(() => {
		const box = [...document.querySelectorAll('#flow-list, #explorer-list')].find((el) => !el.classList.contains('hidden'));
		[...box.querySelectorAll('.tab-note')].find((b) => b.textContent.trim() === 'Explorer').click();
	});
	await A.page.waitForTimeout(300);
	const back = await A.page.evaluate(() => {
		const s = window.__stores;
		let k, fc;
		s.bottomDock.visibleDockKey.subscribe((v) => (k = v))();
		s.flowGraphClose.subscribe((v) => (fc = v))();
		return { visible: k, flowClosed: fc };
	});
	h.check(back.visible === 'explorer' && back.flowClosed === false, `the Explorer tab shows it again, Node editor still open (visible=${back.visible})`);

	await h.finish(browser);
});
