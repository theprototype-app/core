// Phase 3: the Explorer is an ordinary bottom-dock TAB. One dock, seven possible
// tabs, no exclusivity — the strip lists everything docked+open, switching tabs
// closes nothing, and there is ONE height for the whole dock (the Explorer's private
// 'explorerHeight' pref migrates into it on first load and the key is dropped).
const h = require('./helpers.cjs');

const snap = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let tabs, occ, visible, fc, ec, dh;
		s.bottomDock.dockTabs.subscribe((v) => (tabs = v))();
		s.bottomDock.dockOccupants.subscribe((v) => (occ = v))();
		s.bottomDock.visibleDockKey.subscribe((v) => (visible = v))();
		s.bottomDock.dockHeight.subscribe((v) => (dh = v))();
		s.flowGraphClose.subscribe((v) => (fc = v))();
		s.explorerClose.subscribe((v) => (ec = v))();
		const box = [...document.querySelectorAll('#flow-list, #explorer-list')].find(
			(el) => !el.classList.contains('hidden')
		);
		return {
			tabs: tabs.map((t) => t.key),
			strip: box ? [...box.querySelectorAll('.tab-note')].map((b) => b.textContent.trim()).filter(Boolean) : [],
			shown: box ? box.id : null,
			shownH: box ? Math.round(box.getBoundingClientRect().height) : 0,
			present: Object.keys(occ).filter((k) => occ[k]?.present).sort(),
			visible,
			flowClosed: fc,
			explClosed: ec,
			dockHeight: dh,
			inset: getComputedStyle(document.documentElement).getPropertyValue('--bottom-inset').trim()
		};
	});

const clickTab = (page, title) =>
	page.evaluate((t) => {
		const box = [...document.querySelectorAll('#flow-list, #explorer-list')].find((el) => !el.classList.contains('hidden'));
		const btn = [...box.querySelectorAll('.tab-note')].find((b) => b.textContent.trim() === t);
		btn.click();
	}, title);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => {
		localStorage.setItem('flowDocked', 'true');
		localStorage.setItem('explorerDocked', 'true');
		localStorage.removeItem('explorerHeight');
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		s.explorerClose.set(false);
		s.bottomDock.activateDock('flow');
	});
	await A.page.waitForTimeout(600);

	// --- 1. one strip, both tabs ---
	let s = await snap(A.page);
	h.check(s.tabs.join(',') === 'flow,explorer', `1.1 dockTabs lists the Node editor AND the Explorer (${s.tabs.join(',')})`);
	h.check(s.strip.includes('Node editor') && s.strip.includes('Explorer'), `1.2 the rendered strip shows both (${s.strip.join('|')})`);
	h.check(s.shown === 'flow-list' && s.visible === 'flow', `1.3 the Node editor is the one on screen (shown=${s.shown})`);
	// flowTabs stays flow-family-only: it is what the Node editor BUTTON owns
	const ft = await A.page.evaluate(() => {
		let t;
		window.__stores.bottomDock.flowTabs.subscribe((v) => (t = v))();
		return t.map((x) => x.key);
	});
	h.check(ft.join(',') === 'flow', `1.4 flowTabs stays the flow FAMILY only (${ft.join(',') || 'none'})`);

	// --- 2. switching tabs closes neither ---
	await clickTab(A.page, 'Explorer');
	await A.page.waitForTimeout(350);
	s = await snap(A.page);
	h.check(s.visible === 'explorer' && s.shown === 'explorer-list', `2.1 the Explorer tab shows the Explorer (shown=${s.shown})`);
	h.check(s.flowClosed === false && s.explClosed === false, '2.2 neither panel was closed by the switch');
	h.check(s.present.join(',') === 'explorer,flow', `2.3 both are still dock occupants (${s.present.join(',')})`);

	await clickTab(A.page, 'Node editor');
	await A.page.waitForTimeout(350);
	s = await snap(A.page);
	h.check(s.visible === 'flow' && s.flowClosed === false && s.explClosed === false, '2.4 switching back is just as harmless');

	// --- 3. ONE height for the whole dock ---
	await clickTab(A.page, 'Explorer');
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => window.__stores.bottomDock.dockHeight.set(430));
	await A.page.waitForTimeout(350);
	s = await snap(A.page);
	h.check(s.shown === 'explorer-list' && Math.abs(s.shownH - 430) < 3, `3.1 the docked Explorer takes the shared height (${s.shownH}px)`);
	h.check(s.inset === '430px', `3.2 --bottom-inset follows it (${s.inset})`);

	await clickTab(A.page, 'Node editor');
	await A.page.waitForTimeout(350);
	s = await snap(A.page);
	h.check(s.shown === 'flow-list' && Math.abs(s.shownH - 430) < 3, `3.3 the height survives the tab switch — one dock, one height (${s.shownH}px)`);
	h.check(s.inset === '430px' && s.dockHeight === 430, `3.4 and so does the inset (${s.inset})`);

	// --- 4. the explorerHeight -> dockHeight migration ---
	await A.page.evaluate(() => localStorage.setItem('explorerHeight', '365'));
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.waitForTimeout(600);
	const migrated = await A.page.evaluate(() => {
		let dh;
		window.__stores.bottomDock.dockHeight.subscribe((v) => (dh = v))();
		return { dh, legacy: localStorage.getItem('explorerHeight'), shared: localStorage.getItem('flowDockHeight') };
	});
	h.check(migrated.dh === 365, `4.1 the old explorerHeight is adopted as the shared dock height (${migrated.dh}, was 430)`);
	h.check(migrated.legacy === null, `4.2 and the private key is dropped (explorerHeight=${migrated.legacy})`);
	h.check(migrated.shared === '365', `4.3 it persists as the dock's own key (flowDockHeight=${migrated.shared})`);

	await h.finish(browser);
});
