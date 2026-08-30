// W2: the bottom dock's own chrome, which lives in the tab strip beside the "+".
//   ✕  W6 REMOVED it from the strip: pinned at the window's right edge it read as
//      "close the dock" while it only ever closed the one tab on screen. Closing a
//      docked view is the TAB's own right-click menu now (which can also reach a tab
//      that is not showing); a floating panel keeps its header ✕. The BEHAVIOUR that
//      button had is unchanged and still asserted below, only driven through that
//      menu: whatever else is docked survives and `visibleDockKey`'s fallback promotes
//      it, and closing the last tab empties the dock so nothing reserves any inset.
//   –  MINIMIZES the whole dock: every tab stays open and reports itself as an
//      occupant, nothing renders, and the inset goes to 0. It is deliberately not
//      persisted and there is no strip left to restore from, so the restore path is
//      the toolbar / the O-N keys through panelToggles -> activateDock, which clears
//      it. That path is the one thing here that can silently rot, so it gets its own
//      counterfactual (neuter the clear in bottomDock.activateDock and check 5.2 goes
//      red — measured).
// Plus the W2 setting itself, driven through the REAL Settings row: with the toolbar
// floating, the pill anchors on --bottom-inset again.
//
// W6 adds the two things that regressed on device and could not be seen from a store
// read: the strip's BAND HEIGHT (section 8 — W5's icon buttons had no `text-xs`, so
// their 24px line-height stretched every text tab from 22px to 34px) and the dock's
// TOP-EDGE RESIZE (section 9 — that 34px band, hung at `-top-6`, reached 10px INSIDE
// the panel and swallowed the drag hot-zone whole, so the dock could not be resized
// anywhere the strip covered).
const h = require('./helpers.cjs');

/** the visible docked panel — ids repeat across hidden panels, so every read scopes here */
const VISIBLE_PANEL =
	'#flow-list, #explorer-list, #flow-code-dock, #uv-dock, #shader-editor, #hud-dock, #animation-dock';

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

/** W6: close a docked view the way the strip's ✕ used to — the TAB's right-click menu.
 * A REAL right-click, because `contextmenu` is what a long press fires too, and the
 * menu rows are [role=menuitem] DIVs, never buttons. */
async function closeTabViaMenu(page, label) {
	const at = await page.evaluate(
		([sel, lbl]) => {
			const panel = [...document.querySelectorAll(sel)].find((el) => !el.classList.contains('hidden'));
			const tab = [...(panel?.querySelectorAll('.tab-note') ?? [])].find(
				(el) => el.textContent.trim() === lbl
			);
			if (!tab) return null;
			const r = tab.getBoundingClientRect();
			return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
		},
		[VISIBLE_PANEL, label]
	);
	if (!at) return false;
	await page.mouse.click(at.x, at.y, { button: 'right' });
	await page.waitForTimeout(350);
	const hit = await page.evaluate(() => {
		const row = [...document.querySelectorAll('[role=menuitem]')].find((e) =>
			/^close$/i.test(e.textContent.trim())
		);
		if (!row) return false;
		row.click();
		return true;
	});
	await page.waitForTimeout(600);
	return hit;
}

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
	h.check(d.hasMinBtn, '0.3 the strip carries the minimize button');
	// W6: and NOT the ✕ any more — it read as "close the dock" at the window's edge
	h.check(!d.hasCloseBtn, '0.3b ...and the strip-level close-tab ✕ is gone');
	h.check(
		d.minimized === false && d.inset > 0,
		`0.4 the dock starts open and reserves its height (inset=${d.inset})`
	);
	const titles = await A.page.evaluate(() => ({
		min: document.querySelector('#dock-minimize')?.title
	}));
	h.check(titles.min === 'Minimize the dock', `0.5 the button says what it does (${titles.min})`);

	// --- 1. closing the ACTIVE tab (via the tab menu) closes only that tab ---
	h.check(await closeTabViaMenu(A.page, 'Node editor'), '1.0 the tab menu offers Close on the visible tab');
	d = await dockState(A.page);
	h.check(d.flowClosed === true, '1.1 the tab menu closed the ACTIVE tab (the Node editor)');
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
	// W8a reversed the default — the toolbar FLOATS out of the box now — so this
	// section switches it OFF through the row and asserts the covered mode instead
	let p = await pillVsDock(A.page);
	h.check(
		p.floating === true && p.pillBottom <= p.dockTop + 2,
		`4.1 premise: by default the toolbar floats above the dock (${p.pillBottom} <= ${p.dockTop})`
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
	h.check(p.floating === false, '4.4 the row wrote the pref');
	h.check(
		p.pillBottom > p.dockTop,
		`4.5 ...and the pill drops into the dock's band, where the dock covers it (${p.pillBottom} > ${p.dockTop})`
	);
	await A.page.evaluate(() => window.__stores.floatingToolbar.set(true));
	await A.page.waitForTimeout(400);

	// --- 5. closing the LAST tab empties the dock ---
	d = await dockState(A.page);
	h.check(
		d.tabs.length === 2,
		`5.0 premise: two tabs are still open going in (${d.tabs.join(',')})`
	);
	// through the tab menu, on whichever tab is showing at the time
	let showing = (await dockState(A.page)).strip.find((t) => t !== '');
	await closeTabViaMenu(A.page, showing);
	showing = (await dockState(A.page)).strip.find((t) => t !== '');
	await closeTabViaMenu(A.page, showing);
	await A.page.waitForTimeout(500);
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

	// =====================================================================
	// W5. The strip splits in two: TABS + "＋" on the left, the dock's own chrome
	// pinned to the RIGHT edge of the window; the three chrome buttons become lucide
	// icons; the "＋" list drops what is already docked; and a TAB gets its own
	// right-click menu, which is the first way to reach a tab that is not showing.
	// =====================================================================

	/** reopen a known state: flow + Explorer docked, the Node editor showing */
	const openBoth = async () => {
		await A.page.evaluate(() => {
			const s = window.__stores;
			s.flowGraphClose.set(false);
			s.explorerClose.set(false);
			s.bottomDock.activateDock('flow');
		});
		await A.page.waitForTimeout(700);
	};
	await openBoth();

	// --- 6. the right-pinned chrome cluster ---
	const geom = await A.page.evaluate(() => {
		const panel = [...document.querySelectorAll('#flow-list, #explorer-list')].find(
			(el) => !el.classList.contains('hidden')
		);
		// EVERY docked panel renders a strip (they hide with a class, they do not
		// unmount), so these ids repeat across the app — scope every read to the panel
		// that is actually showing, or a display:none copy answers with a zero rect.
		const r = (sel) => {
			const el = panel?.querySelector(sel);
			return el ? el.getBoundingClientRect() : null;
		};
		// the first TAB in the visible panel's strip, to compare bands against
		const tab = panel?.querySelector('.tab-note');
		const min = r('#dock-minimize');
		const add = r('#dock-add-view');
		const svgIn = (sel) => !!panel?.querySelector(sel + ' svg');
		return {
			vw: window.innerWidth,
			panelRight: panel ? Math.round(panel.getBoundingClientRect().right) : -1,
			tabTop: tab ? Math.round(tab.getBoundingClientRect().top) : -1,
			tabLeft: tab ? Math.round(tab.getBoundingClientRect().left) : -1,
			minTop: min ? Math.round(min.top) : -1,
			minLeft: min ? Math.round(min.left) : -1,
			minRight: min ? Math.round(min.right) : -1,
			addRight: add ? Math.round(add.right) : -1,
			icons: { add: svgIn('#dock-add-view'), min: svgIn('#dock-minimize') },
			// the chrome buttons are icon-only now, so they must SAY what they are
			labels: {
				add: panel?.querySelector('#dock-add-view')?.getAttribute('aria-label'),
				min: panel?.querySelector('#dock-minimize')?.getAttribute('aria-label')
			}
		};
	});
	h.check(
		geom.minRight > 0 && geom.vw - geom.minRight <= 20,
		`6.1 the chrome cluster is pinned to the window's right edge (${geom.minRight} vs ${geom.vw})`
	);
	h.check(
		geom.minLeft > geom.addRight,
		`6.2 ...and stands clear of the tab group (chrome starts ${geom.minLeft}, ＋ ends ${geom.addRight})`
	);
	h.check(
		Math.abs(geom.minTop - geom.tabTop) <= 2,
		`6.3 ...on the SAME vertical band as the tabs (tabs ${geom.tabTop}, chrome ${geom.minTop})`
	);
	h.check(
		geom.addRight < geom.minLeft && geom.tabLeft < geom.minLeft,
		`6.4 the tabs and the ＋ stay left of it, so nothing underlaps (＋ ends ${geom.addRight}, chrome starts ${geom.minLeft})`
	);
	h.check(
		geom.icons.add && geom.icons.min,
		`6.5 both chrome buttons render a lucide svg (${JSON.stringify(geom.icons)})`
	);
	h.check(
		!!geom.labels.add && !!geom.labels.min,
		`6.6 ...and being icon-only, each carries an aria-label (${geom.labels.add} / ${geom.labels.min})`
	);

	// --- 7. the ＋ menu offers only views that are NOT already docked ---
	/** a REAL click on the ＋ of the panel that is showing (the id repeats per panel) */
	const clickAdd = async () => {
		const at = await A.page.evaluate(() => {
			const panel = [...document.querySelectorAll('#flow-list, #explorer-list')].find(
				(el) => !el.classList.contains('hidden')
			);
			const b = panel?.querySelector('#dock-add-view');
			if (!b) return null;
			const r = b.getBoundingClientRect();
			return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
		});
		if (!at) throw new Error('no ＋ button in the visible dock panel');
		await A.page.mouse.click(at.x, at.y);
	};

	/** open a menu and read its rows (ContextMenu rows are [role=menuitem] DIVs) */
	const menuRows = () =>
		A.page.evaluate(() =>
			[...document.querySelectorAll('[role="menuitem"]')].map((el) => ({
				label: el.textContent.trim(),
				disabled: el.getAttribute('aria-disabled') === 'true' || el.classList.contains('ctx-disabled')
			}))
		);
	const closeMenu = async () => {
		await A.page.keyboard.press('Escape');
		await A.page.waitForTimeout(250);
	};

	await clickAdd();
	await A.page.waitForTimeout(400);
	let rows = await menuRows();
	h.check(rows.length === 5, `7.1 with flow + Explorer docked the ＋ menu lists 5 views (${rows.length})`);
	h.check(
		!rows.some((r) => /Explorer/.test(r.label)) && !rows.some((r) => /Node editor/.test(r.label)),
		`7.2 ...and neither of the two already in the dock (${rows.map((r) => r.label).join(' | ')})`
	);
	await closeMenu();

	// add one more tab and the list shrinks again — the filter is live, not a fixed list
	await A.page.evaluate(() => {
		window.__stores.flowCodeClose.set(false);
		window.__stores.bottomDock.activateDock('flow');
	});
	await A.page.waitForTimeout(600);
	await clickAdd();
	await A.page.waitForTimeout(400);
	rows = await menuRows();
	h.check(
		rows.length === 4 && !rows.some((r) => /Flow Code/.test(r.label)),
		`7.3 docking Flow Code drops it from the list too (${rows.length}: ${rows.map((r) => r.label).join(' | ')})`
	);
	await closeMenu();
	await A.page.evaluate(() => window.__stores.flowCodeClose.set(true));
	await A.page.waitForTimeout(500);

	// --- 8. a TAB's own context menu ---
	/** right-click the strip tab whose label is `title`, in the VISIBLE panel */
	const rightClickTab = async (title) => {
		const box = await A.page.evaluate((title) => {
			const panel = [...document.querySelectorAll('#flow-list, #explorer-list')].find(
				(el) => !el.classList.contains('hidden')
			);
			const tab = [...panel.querySelectorAll('.tab-note')].find((b) => b.textContent.trim() === title);
			if (!tab) return null;
			const r = tab.getBoundingClientRect();
			return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
		}, title);
		if (!box) return false;
		await A.page.mouse.click(box.x, box.y, { button: 'right' });
		await A.page.waitForTimeout(400);
		return true;
	};

	d = await dockState(A.page);
	h.check(
		d.visible === 'flow' && d.tabs.join(',') === 'explorer,flow',
		`8.0 premise: both tabs open, the Node editor showing (visible=${d.visible} tabs=${d.tabs.join(',')})`
	);

	// the Explorer is a HIDDEN tab right now — since W6 removed the strip's ✕ this menu
	// is the ONLY way to close a docked view, and the only way to reach one that is not
	// showing (the ✕ could never do that half)
	const gotExplorerMenu = await rightClickTab('Explorer');
	h.check(gotExplorerMenu, '8.1 right-clicking a tab opens a menu (the Explorer tab, which is not showing)');
	rows = await menuRows();
	h.check(
		rows.some((r) => /Undock/.test(r.label)) && rows.some((r) => r.label === 'Close'),
		`8.2 ...offering Undock and Close (${rows.map((r) => r.label).join(' | ')})`
	);
	await A.page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim() === 'Close').click()
	);
	await A.page.waitForTimeout(600);
	d = await dockState(A.page);
	h.check(
		d.explClosed === true && d.flowClosed === false,
		`8.3 Close acts on the tab that was CLICKED, not on the visible one (explorer closed=${d.explClosed}, flow closed=${d.flowClosed})`
	);
	h.check(
		d.visible === 'flow' && d.inset > 0,
		`8.4 ...and the dock carries on with the surviving tab (visible=${d.visible})`
	);

	// THE SHADER EDITOR'S EXCEPTION IS GONE, and this check is flipped in the same
	// commit that removes it.
	//
	// It used to be the ONE dock tab with no floating mode — no `docked` flag, no window
	// chrome, nothing to consume `armDockMode` — so `dockTabItems` withheld the Undock
	// row rather than shipping one that could only do nothing, and this assertion pinned
	// that. It has UvEditor's docked/floating split now, so its menu is its siblings'
	// menu exactly, and a withheld row would be the bug. (`shader-window` owns the
	// behaviour end to end; what belongs HERE is that the tab strip treats all seven
	// alike.) Its component IS mounted while hidden, like every other tab: only its
	// MARKUP is {#if}-gated, which is how it reports itself as an occupant.
	await A.page.evaluate(() => {
		window.__stores.shaderEditorClose.set(false);
		window.__stores.bottomDock.activateDock('flow');
	});
	await A.page.waitForTimeout(700);
	const gotShaderMenu = await rightClickTab('Shader editor');
	h.check(gotShaderMenu, '8.4b the Shader editor is a tab and right-clicks like the rest');
	rows = await menuRows();
	h.check(
		rows.some((r) => /undock/i.test(r.label)) && rows.some((r) => r.label === 'Close'),
		`8.4c ...and offers Undock like every other tab, the exception having gone with the missing floating mode (${rows.map((r) => r.label).join(' | ')})`
	);
	await closeMenu();
	await A.page.evaluate(() => window.__stores.shaderEditorClose.set(true));
	await A.page.waitForTimeout(500);

	// Undock the VISIBLE tab: the arm reaches the panel and its own setDocked runs
	const floatingBefore = await A.page.evaluate(() => !!document.querySelector('#flow-window'));
	h.check(!floatingBefore, '8.5 premise: the Node editor has no floating window yet');
	await rightClickTab('Node editor');
	await A.page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')].find((el) => /Undock/.test(el.textContent)).click()
	);
	await A.page.waitForTimeout(800);
	const undocked = await A.page.evaluate(() => {
		let occ;
		window.__stores.bottomDock.dockOccupants.subscribe((v) => (occ = v))();
		let closed;
		window.__stores.flowGraphClose.subscribe((v) => (closed = v))();
		return {
			floating: !!document.querySelector('#flow-window'),
			present: !!occ.flow?.present,
			closed,
			ls: localStorage.getItem('flowDocked')
		};
	});
	h.check(undocked.floating, '8.6 Undock produced the floating Node editor window');
	h.check(
		!undocked.present && undocked.closed === false,
		`8.7 ...it left the dock without closing (docked occupant=${undocked.present}, closed=${undocked.closed})`
	);
	h.check(undocked.ls === 'false', `8.8 ...and the panel persisted its own mode (flowDocked=${undocked.ls})`);
	// leave the lane as we found it
	await A.page.evaluate(() => {
		localStorage.setItem('flowDocked', 'true');
		window.__stores.bottomDock.armDockMode('flow', true);
	});
	await A.page.waitForTimeout(500);

	// =====================================================================
	// W6. The band's HEIGHT, and the dock resize that height had buried.
	// =====================================================================
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		s.explorerClose.set(false);
		s.bottomDock.activateDock('flow');
	});
	await A.page.waitForTimeout(800);

	/** the strip's geometry, read from the panel that is actually showing */
	const band = (page) =>
		page.evaluate((sel) => {
			const panel = [...document.querySelectorAll(sel)].find((el) => !el.classList.contains('hidden'));
			if (!panel) return null;
			const pr = panel.getBoundingClientRect();
			const btns = [...panel.querySelectorAll('.tab-note')].map((el) => ({
				label: el.textContent.trim() || el.id,
				h: Math.round(el.getBoundingClientRect().height * 100) / 100,
				w: Math.round(el.getBoundingClientRect().width * 100) / 100
			}));
			const cueEl = panel.querySelector('.resize-cue');
			const cue = cueEl ? cueEl.getBoundingClientRect() : null;
			// what a pointer aimed at the panel's top edge actually lands on, across its
			// whole width — the tab group, the ＋ and the chrome cluster all live in this
			// band, and before W6 they ate the drag everywhere they sat
			const xs = [6, 60, 200, Math.round(pr.width / 2), Math.round(pr.width) - 130, Math.round(pr.width) - 60, Math.round(pr.width) - 6];
			const onCue = xs.filter((x) => {
				const el = document.elementFromPoint(x, Math.round(pr.top + 1));
				return el && el.classList && el.classList.contains('resize-cue');
			});
			return {
				btns,
				maxH: Math.max(...btns.map((b) => b.h)),
				widest: Math.max(...btns.map((b) => b.w)),
				nodeTabW: btns.find((b) => b.label === 'Node editor')?.w ?? -1,
				cueZ: cueEl ? getComputedStyle(cueEl).zIndex : null,
				xsTried: xs.length,
				onCue: onCue.length
			};
		}, VISIBLE_PANEL);

	let b = await band(A.page);
	// 22px is the metric the tabs shipped with before this branch (measured on
	// 739f9df^) and the one the user asked for back. W5's icon buttons carried no
	// `text-xs`, so a 24px line-height plus pt-1.5/pb-1 made them 34px, and a flex row
	// stretches its items — every text tab inherited it. Pin the NUMBER: a future
	// member that quietly grows the band shows up here rather than on someone's screen.
	h.check(b.maxH === 22, `9.1 every strip button is 22px tall — one slim band (max=${b.maxH})`);
	h.check(
		b.btns.every((x) => x.h === b.maxH),
		`9.2 ...tabs and chrome icons alike (${b.btns.map((x) => `${x.label}:${x.h}`).join(' ')})`
	);
	// the tab WIDTH never changed on this branch; pin it so a padding edit is visible
	h.check(
		b.nodeTabW > 90 && b.nodeTabW <= 100,
		`9.3 a 'Node editor' tab stays ~98px wide (${b.nodeTabW})`
	);
	// the band hangs at -top-6 (24px). At 22px it ends 2px ABOVE the panel; at 34px it
	// reached 10px inside it, which is what buried the hot-zone.
	h.check(b.maxH <= 24, `9.4 ...so the band cannot reach past its own -top-6 slot (${b.maxH} <= 24)`);

	// --- 10. the top-edge resize, at every x across the panel ---
	h.check(b.cueZ === '30', `10.1 the resize hot-zone sits ABOVE the strip's z-20 (z=${b.cueZ})`);
	h.check(
		b.onCue === b.xsTried,
		`10.2 the top edge answers with the hot-zone at every x, chrome cluster included (${b.onCue}/${b.xsTried})`
	);

	/** a REAL mouse drag on the visible panel's top edge, at its horizontal middle —
	 * the exact spot the strip covered */
	const dragTopEdge = async (page, dy) => {
		const at = await page.evaluate((sel) => {
			const panel = [...document.querySelectorAll(sel)].find((el) => !el.classList.contains('hidden'));
			return { top: Math.round(panel.getBoundingClientRect().top), x: Math.round(window.innerWidth / 2) };
		}, VISIBLE_PANEL);
		await page.mouse.move(at.x, at.top);
		await page.mouse.down();
		await page.mouse.move(at.x, at.top + dy, { steps: 12 });
		await page.mouse.up();
		await page.waitForTimeout(400);
	};
	const dockH = (page) =>
		page.evaluate((sel) => {
			let hgt;
			window.__stores.bottomDock.dockHeight.subscribe((v) => (hgt = v))();
			const panel = [...document.querySelectorAll(sel)].find((el) => !el.classList.contains('hidden'));
			return {
				hgt,
				inset: getComputedStyle(document.documentElement).getPropertyValue('--bottom-inset').trim(),
				ls: localStorage.getItem('flowDockHeight'),
				panelH: panel ? Math.round(panel.getBoundingClientRect().height) : -1
			};
		}, VISIBLE_PANEL);

	const h0 = await dockH(A.page);
	await dragTopEdge(A.page, -60);
	const h1 = await dockH(A.page);
	h.check(h1.hgt === h0.hgt + 60, `10.3 dragging the top edge UP grows the dock (${h0.hgt} -> ${h1.hgt})`);
	h.check(
		h1.inset === `${h1.hgt}px` && h1.panelH === h1.hgt,
		`10.4 ...and the panel and --bottom-inset follow it (panel=${h1.panelH}, inset=${h1.inset})`
	);
	await dragTopEdge(A.page, 40);
	const h2 = await dockH(A.page);
	h.check(h2.hgt === h1.hgt - 40, `10.5 ...and dragging DOWN shrinks it again (${h1.hgt} -> ${h2.hgt})`);
	h.check(h2.ls === String(h2.hgt), `10.6 the height persists (flowDockHeight=${h2.ls})`);

	// the shared height is the DOCK's, so every tab resizes it — including the Shader
	// editor, the one panel that never carried a hot-zone at all until W6
	for (const key of ['explorer', 'shader']) {
		await A.page.evaluate((k) => {
			const s = window.__stores;
			if (k === 'shader') s.shaderEditorClose.set(false);
			s.bottomDock.activateDock(k);
		}, key);
		await A.page.waitForTimeout(700);
		const before = await dockH(A.page);
		await dragTopEdge(A.page, -45);
		const after = await dockH(A.page);
		h.check(
			after.hgt === before.hgt + 45,
			`10.7 the ${key} tab resizes the shared dock the same way (${before.hgt} -> ${after.hgt})`
		);
	}
	await A.page.evaluate(() => {
		window.__stores.shaderEditorClose.set(true);
		window.__stores.bottomDock.activateDock('flow');
	});
	await A.page.waitForTimeout(500);

	await h.finish(browser);
});
