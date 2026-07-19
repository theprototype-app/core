// The Node editor toolbar button toggles the WHOLE docked flow group. When Node
// editor, Flow Code and Animation are all docked, clicking it hides all three tabs
// (not just Node editor); clicking again restores them.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// all three flow-family views docked + open
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		s.objectActions.selectObject(g.children[g.children.length - 1].uuid);
		s.flowGraphClose.set(false);
		s.flowCodeClose.set(false);
		s.animationClose.set(false);
		s.bottomDock.activateDock('flow');
	});
	await A.page.waitForTimeout(500);
	const opened = await A.page.evaluate(() => {
		let t;
		window.__stores.bottomDock.flowTabs.subscribe((v) => (t = v))();
		return t.map((x) => x.key);
	});
	h.check(opened.join(',') === 'flow,flowcode,animation', `all three flow tabs are docked (${opened.join(',')})`);

	// click Node editor -> ALL three tabs hide (the whole dock)
	await A.page.evaluate(() => document.querySelector('p[title="Node editor (N)"]').click());
	await A.page.waitForTimeout(250);
	const hidden = await A.page.evaluate(() => {
		const s = window.__stores;
		let fc, cc, ac, vis;
		s.flowGraphClose.subscribe((v) => (fc = v))();
		s.flowCodeClose.subscribe((v) => (cc = v))();
		s.animationClose.subscribe((v) => (ac = v))();
		s.bottomDock.visibleDockKey.subscribe((v) => (vis = v))();
		return { fc, cc, ac, vis };
	});
	h.check(hidden.fc && hidden.cc && hidden.ac, 'clicking Node editor hides ALL three docked flow tabs');
	h.check(hidden.vis === null, `the dock is empty after hiding (visible=${hidden.vis})`);

	// click Node editor again -> all three restored
	await A.page.evaluate(() => document.querySelector('p[title="Node editor (N)"]').click());
	await A.page.waitForTimeout(300);
	const shown = await A.page.evaluate(() => {
		const s = window.__stores;
		let fc, cc, ac, t;
		s.flowGraphClose.subscribe((v) => (fc = v))();
		s.flowCodeClose.subscribe((v) => (cc = v))();
		s.animationClose.subscribe((v) => (ac = v))();
		s.bottomDock.flowTabs.subscribe((v) => (t = v))();
		return { fc, cc, ac, tabs: t.map((x) => x.key) };
	});
	h.check(!shown.fc && !shown.cc && !shown.ac && shown.tabs.length === 3, `clicking Node editor again restores all three tabs (${shown.tabs.join(',')})`);

	await h.finish(browser);
});
