// When BOTH the Node editor and the Explorer are floating windows (neither docked),
// toggling the Node editor from Controls must only show/hide itself — it must never
// close the floating Explorer (they don't compete for the dock).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => {
		localStorage.setItem('flowDocked', 'false');
		localStorage.setItem('explorerDocked', 'false');
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.evaluate(() => {
		window.__stores.flowGraphClose.set(false);
		window.__stores.explorerClose.set(false);
	});
	await A.page.waitForTimeout(700);
	const setup = await A.page.evaluate(() => ({
		flowWin: !!document.getElementById('flow-window'),
		explWin: !!document.getElementById('explorer-window')
	}));
	h.check(setup.flowWin && setup.explWin, 'both the Node editor and the Explorer are floating windows');

	// click Node editor (shown) -> it hides; the floating Explorer stays open
	await A.page.evaluate(() => document.querySelector('p[title="Node editor (N)"]').click());
	await A.page.waitForTimeout(250);
	const afterHide = await A.page.evaluate(() => {
		const s = window.__stores;
		let fc, ec;
		s.flowGraphClose.subscribe((v) => (fc = v))();
		s.explorerClose.subscribe((v) => (ec = v))();
		return { fc, ec };
	});
	h.check(afterHide.fc === true && afterHide.ec === false, 'hiding the floating Node editor leaves the floating Explorer open');

	// click Node editor again (show) -> Explorer STILL open
	await A.page.evaluate(() => document.querySelector('p[title="Node editor (N)"]').click());
	await A.page.waitForTimeout(250);
	const afterShow = await A.page.evaluate(() => {
		const s = window.__stores;
		let fc, ec;
		s.flowGraphClose.subscribe((v) => (fc = v))();
		s.explorerClose.subscribe((v) => (ec = v))();
		return { fc, ec };
	});
	h.check(afterShow.fc === false && afterShow.ec === false, 'showing the floating Node editor again leaves the floating Explorer open');

	await h.finish(browser);
});
