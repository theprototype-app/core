// N (and the Node editor toolbar button) answers for the NODE EDITOR TAB ALONE.
//
// It used to own the whole docked flow GROUP: one press closed Flow Code, Animation,
// the UV / Shader / HUD editors and the Node editor together, snapshotting them so the
// next press could bring them back. That was written when the dock showed ONE panel at
// a time; since #183 the dock is a tab strip and T is the gesture for the strip as a
// whole. Reported by the user as "N should not close other tabs — for some reason only
// the Explorer stays", which is exactly the shape of a flow-family sweep: the Explorer
// is the one dock view that is not in that family.
//
// This file is the counterfactual for that fix: with the group hide back in place,
// sections 1 and 3 go red on the tabs that must survive.
const h = require('./helpers.cjs');

const dock = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let tabs, visible, fc, cc, ac, ec;
		s.bottomDock.dockTabs.subscribe((v) => (tabs = v))();
		s.bottomDock.visibleDockKey.subscribe((v) => (visible = v))();
		s.flowGraphClose.subscribe((v) => (fc = v))();
		s.flowCodeClose.subscribe((v) => (cc = v))();
		s.animationClose.subscribe((v) => (ac = v))();
		s.explorerClose.subscribe((v) => (ec = v))();
		return { tabs: tabs.map((t) => t.key), visible, fc, cc, ac, ec };
	});

/** the toolbar button, by its title (the same run() the key calls) */
const clickButton = async (page, title) => {
	const hit = await page.evaluate((t) => {
		const el = document.querySelector(`p[title="${t}"]`);
		if (!el) return false;
		el.click();
		return true;
	}, title);
	await page.waitForTimeout(400);
	return hit;
};

/** a REAL key press with focus off any field */
const press = async (page, key) => {
	await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
	await page.keyboard.press(key);
	await page.waitForTimeout(400);
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// Animation needs a selected object to render anything, and the premise is about
	// what is DOCKED, so give it one.
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		s.objectActions.selectObject(g.children[g.children.length - 1].uuid);
		localStorage.setItem('flowDocked', 'true');
		localStorage.setItem('flowCodeDocked', 'true');
		localStorage.setItem('animationDocked', 'true');
		localStorage.setItem('explorerDocked', 'true');
	});
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		s.flowCodeClose.set(false);
		s.animationClose.set(false);
		s.explorerClose.set(false);
		s.bottomDock.activateDock('flow');
	});
	await A.page.waitForTimeout(800);

	let d = await dock(A.page);
	h.check(
		d.tabs.length === 4 && d.visible === 'flow',
		`0.1 premise: four views are docked and the Node editor is showing (${d.tabs.join(',')} visible=${d.visible})`
	);

	// --- 1. the BUTTON closes the Node editor tab and NOTHING else -------------------
	h.check(await clickButton(A.page, 'Node editor (N)'), '1.0 the Node editor button is on the toolbar');
	d = await dock(A.page);
	h.check(d.fc === true, '1.1 clicking it closes the Node editor');
	h.check(
		d.cc === false && d.ac === false,
		`1.2 ...and Flow Code and Animation STAY OPEN (flowCodeClosed=${d.cc} animationClosed=${d.ac})`
	);
	h.check(d.ec === false, '1.3 ...and so does the Explorer (it always did — it is not in the flow family)');
	h.check(
		d.tabs.length === 3 && !d.tabs.includes('flow'),
		`1.4 ...so the strip loses exactly one tab (${d.tabs.join(',')})`
	);
	h.check(
		d.visible !== null && d.visible !== 'flow',
		`1.5 ...and the dock stays up, showing whichever tab the fallback promoted (${d.visible})`
	);

	// --- 2. a second press brings back the SAME one tab ------------------------------
	await clickButton(A.page, 'Node editor (N)');
	d = await dock(A.page);
	h.check(
		d.fc === false && d.visible === 'flow',
		`2.1 pressing it again reopens the Node editor as the visible tab (${d.visible})`
	);
	h.check(
		d.tabs.length === 4 && d.cc === false && d.ac === false,
		`2.2 ...with the tabs it never touched still there (${d.tabs.join(',')})`
	);

	// --- 3. the KEY is the same tree (this is what the user pressed) -----------------
	await press(A.page, 'n');
	d = await dock(A.page);
	h.check(d.fc === true, '3.1 N closes the Node editor');
	h.check(
		d.cc === false && d.ac === false && d.ec === false,
		`3.2 ...and leaves every other tab alone (flowcode=${!d.cc} animation=${!d.ac} explorer=${!d.ec} open)`
	);
	await press(A.page, 'n');
	d = await dock(A.page);
	h.check(
		d.fc === false && d.visible === 'flow' && d.tabs.length === 4,
		`3.3 N brings it back (${d.tabs.join(',')})`
	);

	// --- 4. the tree reads the same for a NON-flow panel -----------------------------
	// The fix removed the only per-panel branch left in panelToggles, so the Explorer's
	// own button must behave identically: close its tab, touch nothing else.
	await A.page.evaluate(() => window.__stores.bottomDock.activateDock('explorer'));
	await A.page.waitForTimeout(400);
	d = await dock(A.page);
	h.check(d.visible === 'explorer', `4.0 premise: the Explorer is the visible tab (${d.visible})`);
	h.check(await clickButton(A.page, 'Explorer'), '4.1 the Explorer button is on the toolbar');
	d = await dock(A.page);
	h.check(d.ec === true, '4.2 it closes the Explorer tab');
	h.check(
		d.fc === false && d.cc === false && d.ac === false && d.tabs.length === 3,
		`4.3 ...and the three flow tabs are untouched (${d.tabs.join(',')})`
	);

	// --- 5. a COVERED tab is called back, never dismissed ----------------------------
	// (step 4's other half, unchanged by this fix but the reason a press cannot simply
	// close whatever it names)
	await A.page.evaluate(() => window.__stores.bottomDock.activateDock('animation'));
	await A.page.waitForTimeout(400);
	d = await dock(A.page);
	h.check(
		d.visible === 'animation' && d.fc === false,
		`5.0 premise: the Node editor is docked but Animation is showing (${d.visible})`
	);
	await press(A.page, 'n');
	d = await dock(A.page);
	h.check(
		d.visible === 'flow' && d.fc === false,
		`5.1 N brings the covered Node editor tab back instead of closing it (${d.visible})`
	);
	h.check(d.ac === false, '5.2 ...and Animation stays open behind it');

	await h.finish(browser);
});
