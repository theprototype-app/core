// When the Node editor is UNDOCKED (floating) but Flow Code / Animation are docked,
// the Node editor toolbar button only shows/hides its own floating window — it must
// not hide the docked Flow Code / Animation group.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => {
		localStorage.setItem('flowDocked', 'false'); // Node editor floating
		localStorage.setItem('flowCodeDocked', 'true'); // Flow Code docked
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		s.flowCodeClose.set(false);
		s.bottomDock.activateDock('flowcode');
	});
	await A.page.waitForTimeout(600);
	const setup = await A.page.evaluate(() => {
		const s = window.__stores;
		let vis, occ;
		s.bottomDock.visibleDockKey.subscribe((v) => (vis = v))();
		s.bottomDock.dockOccupants.subscribe((v) => (occ = v))();
		return { vis, nodeFloat: !!document.getElementById('flow-window'), flowcodeDocked: !!occ.flowcode?.present };
	});
	h.check(setup.vis === 'flowcode' && setup.nodeFloat && setup.flowcodeDocked, `setup: Node editor floating, Flow Code docked+visible (vis=${setup.vis})`);

	// click Node editor -> hides ONLY its floating window; the docked Flow Code stays
	await A.page.evaluate(() => document.querySelector('p[title="Node editor (N)"]').click());
	await A.page.waitForTimeout(300);
	const after = await A.page.evaluate(() => {
		const s = window.__stores;
		let fc, cc, vis;
		s.flowGraphClose.subscribe((v) => (fc = v))();
		s.flowCodeClose.subscribe((v) => (cc = v))();
		s.bottomDock.visibleDockKey.subscribe((v) => (vis = v))();
		return { flowClosed: fc, flowCodeClosed: cc, vis, nodeFloat: !!document.getElementById('flow-window') };
	});
	h.check(after.flowClosed === true && !after.nodeFloat, 'clicking Node editor hides only its floating window');
	h.check(after.flowCodeClosed === false && after.vis === 'flowcode', 'the docked Flow Code stays open and visible');

	// click Node editor again -> its floating window comes back; Flow Code still docked
	await A.page.evaluate(() => document.querySelector('p[title="Node editor (N)"]').click());
	await A.page.waitForTimeout(300);
	const back = await A.page.evaluate(() => {
		const s = window.__stores;
		let cc, vis;
		s.flowCodeClose.subscribe((v) => (cc = v))();
		s.bottomDock.visibleDockKey.subscribe((v) => (vis = v))();
		return { nodeFloat: !!document.getElementById('flow-window'), flowCodeClosed: cc, vis };
	});
	h.check(back.nodeFloat && !back.flowCodeClosed && back.vis === 'flowcode', 'clicking again reopens the floating Node editor, Flow Code still docked');

	await h.finish(browser);
});
