// When the Node editor is docked but Flow Code / Animation are UNDOCKED (floating),
// the Node editor toolbar button hides only the docked tabs — it must NOT close the
// separate floating Flow Code / Animation windows.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => {
		localStorage.setItem('flowDocked', 'true'); // Node editor docked
		localStorage.setItem('flowCodeDocked', 'false'); // Flow Code floating
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		s.flowCodeClose.set(false);
		s.bottomDock.activateDock('flow');
	});
	await A.page.waitForTimeout(600);
	const setup = await A.page.evaluate(() => {
		const s = window.__stores;
		let vis, occ;
		s.bottomDock.visibleDockKey.subscribe((v) => (vis = v))();
		s.bottomDock.dockOccupants.subscribe((v) => (occ = v))();
		return {
			vis,
			flowDocked: !!occ.flow?.present,
			flowcodeDocked: !!occ.flowcode?.present,
			fcWin: !!document.getElementById('flow-code-window')
		};
	});
	h.check(setup.vis === 'flow' && setup.flowDocked && !setup.flowcodeDocked && setup.fcWin, `setup: Node editor docked+visible, Flow Code floating (vis=${setup.vis})`);

	// click Node editor -> hide the docked Node editor; the floating Flow Code stays open
	await A.page.evaluate(() => document.querySelector('p[title="Node editor (N)"]').click());
	await A.page.waitForTimeout(300);
	const after = await A.page.evaluate(() => {
		const s = window.__stores;
		let fc, cc;
		s.flowGraphClose.subscribe((v) => (fc = v))();
		s.flowCodeClose.subscribe((v) => (cc = v))();
		return { flowClosed: fc, flowCodeClosed: cc, fcWin: !!document.getElementById('flow-code-window') };
	});
	h.check(after.flowClosed === true, 'clicking Node editor hides the docked Node editor');
	h.check(after.flowCodeClosed === false && after.fcWin, 'the undocked (floating) Flow Code window stays open');

	await h.finish(browser);
});
