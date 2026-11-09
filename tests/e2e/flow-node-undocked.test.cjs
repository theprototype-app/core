// When the Node editor is UNDOCKED (floating) but Timeline / Animation are docked,
// the Node editor toolbar button only shows/hides its own floating window — it must
// not hide the docked Timeline / Animation group.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => {
		localStorage.setItem('flowDocked', 'false'); // Node editor floating
		localStorage.setItem('timelineDocked', 'true'); // Timeline docked
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		s.timelineClose.set(false);
		s.bottomDock.activateDock('timeline');
	});
	await A.page.waitForTimeout(600);
	const setup = await A.page.evaluate(() => {
		const s = window.__stores;
		let vis, occ;
		s.bottomDock.visibleDockKey.subscribe((v) => (vis = v))();
		s.bottomDock.dockOccupants.subscribe((v) => (occ = v))();
		return { vis, nodeFloat: !!document.getElementById('flow-window'), timelineDocked: !!occ.timeline?.present };
	});
	h.check(setup.vis === 'timeline' && setup.nodeFloat && setup.timelineDocked, `setup: Node editor floating, Timeline docked+visible (vis=${setup.vis})`);

	// click Node editor -> hides ONLY its floating window; the docked Timeline stays
	await A.page.evaluate(() => document.querySelector('p[title="Node editor (N)"]').click());
	await A.page.waitForTimeout(300);
	const after = await A.page.evaluate(() => {
		const s = window.__stores;
		let fc, cc, vis;
		s.flowGraphClose.subscribe((v) => (fc = v))();
		s.timelineClose.subscribe((v) => (cc = v))();
		s.bottomDock.visibleDockKey.subscribe((v) => (vis = v))();
		return { flowClosed: fc, timelineClosed: cc, vis, nodeFloat: !!document.getElementById('flow-window') };
	});
	h.check(after.flowClosed === true && !after.nodeFloat, 'clicking Node editor hides only its floating window');
	h.check(after.timelineClosed === false && after.vis === 'timeline', 'the docked Timeline stays open and visible');

	// click Node editor again -> its floating window comes back; Timeline still docked
	await A.page.evaluate(() => document.querySelector('p[title="Node editor (N)"]').click());
	await A.page.waitForTimeout(300);
	const back = await A.page.evaluate(() => {
		const s = window.__stores;
		let cc, vis;
		s.timelineClose.subscribe((v) => (cc = v))();
		s.bottomDock.visibleDockKey.subscribe((v) => (vis = v))();
		return { nodeFloat: !!document.getElementById('flow-window'), timelineClosed: cc, vis };
	});
	h.check(back.nodeFloat && !back.timelineClosed && back.vis === 'timeline', 'clicking again reopens the floating Node editor, Timeline still docked');

	await h.finish(browser);
});
