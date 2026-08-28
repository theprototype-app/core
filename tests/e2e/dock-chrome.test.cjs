// W2: the bottom dock's own chrome, which lives in the tab strip beside the "+".
//   ✕  closes the ACTIVE tab only — the one the strip is drawn on. Whatever else is
//      docked survives and `visibleDockKey`'s fallback promotes it; closing the last
//      tab empties the dock, so nothing reserves any inset.
//   –  MINIMIZES the whole dock: every tab stays open and reports itself as an
//      occupant, nothing renders, and the inset goes to 0. It is deliberately not
//      persisted and there is no strip left to restore from, so the restore path is
//      the toolbar / the O-N keys through panelToggles -> activateDock, which clears
//      it. That path is the one thing here that can silently rot, so it gets its own
//      counterfactual (neuter the clear in bottomDock.activateDock and check 5.2 goes
//      red — measured).
// Plus the W2 setting itself, driven through the REAL Settings row: with the toolbar
// floating, the pill anchors on --bottom-inset again.
const h = require('./helpers.cjs');

const dockState = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let tabs, occ, visible, min, inset, fc, ec;
		s.bottomDock.dockTabs.subscribe((v) => (tabs = v))();
		s.bottomDock.dockOccupants.subscribe((v) => (occ = v))();
		s.bottomDock.visibleDockKey.subscribe((v) => (visible = v))();
		s.bottomDock.dockMinimized.subscribe((v) => (min = v))();
		s.bottomDock.bottomInset.subscribe((v) => (inset = v))();
		s.flowGraphClose.subscribe((v) => (fc = v))();
		s.explorerClose.subscribe((v) => (ec = v))();
		// a docked panel renders as #flow-list / #explorer-list etc. and hides itself
		// with a `hidden` class rather than unmounting (the ShaderEditor is the one
		// {#if}); "rendered" therefore means present AND not hidden
		const boxes = ['#flow-list', '#explorer-list', '#flow-code-dock', '#uv-dock'];
		const shown = boxes
			.map((sel) => document.querySelector(sel))
			.filter((el) => el && !el.classList.contains('hidden'));
		const rendered = shown.map((el) => el.id);
		// the strip is read from the VISIBLE panel only: a hidden dock tab keeps its DOM
		// (it hides with a class, it does not unmount), so a document-wide query counts
		// every tab strip in the app at once
		const strip = shown.length
			? [...shown[0].querySelectorAll('.tab-note')].map((b) => b.textContent.trim()).filter(Boolean)
			: [];
		return {
			tabs: tabs.map((t) => t.key).sort(),
			present: Object.keys(occ).filter((k) => occ[k]?.present).sort(),
			visible,
			minimized: min,
			inset,
			cssInset: getComputedStyle(document.documentElement).getPropertyValue('--bottom-inset').trim(),
			rendered,
			strip,
			hasMinBtn: !!document.querySelector('#dock-minimize'),
			hasCloseBtn: !!document.querySelector('#dock-close-tab'),
			flowClosed: fc,
			explClosed: ec
		};
	});

/** where the Controls pill sits, against the dock's top edge */
const pillVsDock = (page) =>
	page.evaluate(() => {
		const pill = document.querySelector('#controls-pill')?.getBoundingClientRect();
		const dock = [...document.querySelectorAll('#flow-list, #explorer-list')].find(
			(el) => !el.classList.contains('hidden')
		);
		let floating;
		window.__stores.floatingToolbar.subscribe((v) => (floating = v))();
		return {
			pillBottom: pill ? Math.round(pill.bottom) : 0,
			dockTop: dock ? Math.round(dock.getBoundingClientRect().top) : 0,
			floating,
			vh: window.innerHeight
		};
	});

/** click one of the strip's own buttons (the strip renders inside the visible panel) */
const clickStrip = (page, id) => page.evaluate((s) => document.querySelector(s).click(), id);

// a REAL key press with focus on the body, never a text field (panel-toggle-keys' idiom)
const press = async (page, key) => {
	await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
	await page.keyboard.press(key);
	await page.waitForTimeout(400);
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- 0. premise: flow + Explorer docked, the strip carries both tabs and the two
	// new buttons ---
	await A.page.evaluate(() => {
		localStorage.setItem('flowDocked', 'true');
		localStorage.setItem('explorerDocked', 'true');
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.bottomDock, { timeout: 30000 });
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		s.explorerClose.set(false);
		s.bottomDock.activateDock('flow');
	});
	await A.page.waitForTimeout(700);

	let d = await dockState(A.page);
	h.check(
		d.tabs.join(',') === 'explorer,flow' && d.visible === 'flow',
		`0.1 premise: both are dock tabs and the Node editor is showing (tabs=${d.tabs.join(',')} visible=${d.visible})`
	);
	h.check(
		d.strip.includes('Node editor') && d.strip.includes('Explorer'),
		`0.2 the strip names both tabs (${d.strip.join('|')})`
	);
	h.check(d.hasMinBtn && d.hasCloseBtn, '0.3 the strip carries the minimize and close-tab buttons');
	h.check(
		d.minimized === false && d.inset > 0,
		`0.4 the dock starts open and reserves its height (inset=${d.inset})`
	);
	const titles = await A.page.evaluate(() => ({
		min: document.querySelector('#dock-minimize')?.title,
		close: document.querySelector('#dock-close-tab')?.title
	}));
	h.check(
		titles.min === 'Minimize the dock' && titles.close === 'Close this tab',
		`0.5 both buttons say what they do (${titles.min} / ${titles.close})`
	);

	// --- 1. ✕ closes the ACTIVE tab only ---
	await clickStrip(A.page, '#dock-close-tab');
	await A.page.waitForTimeout(600);
	d = await dockState(A.page);
	h.check(d.flowClosed === true, '1.1 the close button closed the ACTIVE tab (the Node editor)');
	h.check(d.explClosed === false, '1.2 ...and left the Explorer open');
	h.check(
		d.visible === 'explorer' && d.rendered.includes('explorer-list'),
		`1.3 the fallback promoted the surviving tab (visible=${d.visible} rendered=${d.rendered.join(',')})`
	);
	h.check(d.inset > 0, `1.4 the dock still reserves its height (inset=${d.inset})`);

	// reopen the Node editor with the N key (the toolbar button is under the dock by
	// default now, which is exactly what W2's other half is about)
	await press(A.page, 'n');
	await A.page.waitForTimeout(400);
	d = await dockState(A.page);
	h.check(
		d.flowClosed === false && d.visible === 'flow',
		`1.5 N reopens it as the visible tab (visible=${d.visible})`
	);

	// --- 2. – minimizes the dock ---
	const insetBefore = d.inset;
	await clickStrip(A.page, '#dock-minimize');
	await A.page.waitForTimeout(500);
	d = await dockState(A.page);
	h.check(d.minimized === true, '2.1 the minimize button sets dockMinimized');
	h.check(d.inset === 0, `2.2 a minimized dock reserves NO space (${insetBefore} -> ${d.inset})`);
	h.check(d.cssInset === '0px', `2.3 ...and --bottom-inset says so (${d.cssInset})`);
	h.check(
		d.rendered.length === 0,
		`2.4 no docked panel renders while minimized (${d.rendered.join(',') || 'none'})`
	);
	h.check(
		d.present.join(',') === 'explorer,flow' && d.flowClosed === false && d.explClosed === false,
		`2.5 ...but every tab is still OPEN and reporting itself (${d.present.join(',')})`
	);

	// --- 3. the toolbar/keys restore it (there is no strip left to click) ---
	h.check(d.strip.length === 0, '3.1 a minimized dock shows no tab strip at all');
	await press(A.page, 'n');
	d = await dockState(A.page);
	h.check(d.minimized === false, '3.2 the N key restores the dock (activateDock clears minimized)');
	h.check(
		d.visible === 'flow' && d.rendered.includes('flow-list') && d.inset > 0,
		`3.3 ...and the panel is back with its inset (visible=${d.visible} inset=${d.inset})`
	);
	h.check(
		d.flowClosed === false,
		'3.4 restoring did NOT close the tab it was asked to show (the step-4 trap)'
	);

	// The TOOLBAR reaches it too — and this is the half that makes the affordance real
	// with the default (non-floating) toolbar: a minimized dock renders nothing, so the
	// buttons the open dock was covering are exposed again. A REAL click, no store poke.
	await clickStrip(A.page, '#dock-minimize');
	await A.page.waitForTimeout(500);
	await A.page.locator('p[title="Explorer"]').click({ timeout: 5000 });
	await A.page.waitForTimeout(500);
	d = await dockState(A.page);
	h.check(
		d.minimized === false && d.visible === 'explorer',
		`3.5 the Explorer toolbar button restores the dock on its own tab (visible=${d.visible})`
	);

	// --- 4. the Floating toolbar setting, through the REAL Settings row ---
	await A.page.evaluate(() => window.__stores.bottomDock.activateDock('flow'));
	await A.page.waitForTimeout(400);
	let p = await pillVsDock(A.page);
	h.check(
		p.floating === false && p.pillBottom > p.dockTop,
		`4.1 premise: the toolbar is NOT floating and sits inside the dock's band (${p.pillBottom} > ${p.dockTop})`
	);
	await A.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await A.page.waitForTimeout(500);
	await A.page.getByText('Interface', { exact: true }).first().click();
	await A.page.waitForTimeout(400);
	const row = A.page.locator('.setting-row').filter({ hasText: 'Floating toolbar' }).first();
	h.check((await row.count()) === 1, '4.2 Settings ▸ Interface has a "Floating toolbar" row');
	const toggle = row.locator('input[type="checkbox"]');
	h.check((await toggle.count()) === 1, '4.3 ...with a real toggle');
	// flowbite's Toggle keeps its real input `sr-only` under a painted track, so a
	// POSITIONAL click lands on whatever overlays that spot (here the Controls pill —
	// the row sits low in a 720px viewport). Click the control itself, which fires the
	// native click+change svelte's bind is listening for — reset-windows' idiom.
	await toggle.evaluate((el) => el.click());
	await A.page.waitForTimeout(500);
	await A.page.evaluate(() => window.__stores.settingsOpen.set(false));
	await A.page.waitForTimeout(600);
	p = await pillVsDock(A.page);
	h.check(p.floating === true, '4.4 the row wrote the pref');
	h.check(
		p.pillBottom <= p.dockTop + 2,
		`4.5 ...and the pill now rides above the dock (${p.pillBottom} <= ${p.dockTop})`
	);
	await A.page.evaluate(() => window.__stores.floatingToolbar.set(false));
	await A.page.waitForTimeout(400);

	// --- 5. closing the LAST tab empties the dock ---
	d = await dockState(A.page);
	h.check(
		d.tabs.length === 2,
		`5.0 premise: two tabs are still open going in (${d.tabs.join(',')})`
	);
	await clickStrip(A.page, '#dock-close-tab');
	await A.page.waitForTimeout(600);
	await clickStrip(A.page, '#dock-close-tab');
	await A.page.waitForTimeout(700);
	d = await dockState(A.page);
	h.check(d.tabs.length === 0, `5.1 every tab is closed (${d.tabs.join(',') || 'none'})`);
	h.check(d.rendered.length === 0, '5.2 nothing renders in the dock');
	h.check(
		d.inset === 0 && d.cssInset === '0px',
		`5.3 an empty dock reserves nothing (${d.cssInset})`
	);
	const pillHome = await A.page.evaluate(() => {
		const r = document.querySelector('#controls-pill')?.getBoundingClientRect();
		return r ? window.innerHeight - Math.round(r.bottom) : -1;
	});
	h.check(pillHome >= 0 && pillHome <= 18, `5.4 the pill is on the viewport floor (${pillHome}px clear)`);

	await h.finish(browser);
});
