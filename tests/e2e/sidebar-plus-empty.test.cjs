// 44 M7 + M8 — the user's preview-1-34 review:
//   'add "+" to left and right sidebars on tabs and when all tabs are dragged to somewhere else or closed
//    it should keep panel opened empty only with "+" in tab and a helper text … "Press +" to choose window
//    (also add shortcuts to open left and right sidebars, pick most approriate ones according to DCC
//    standards)'
//   'on desktop I want to be able to open multiple windows when press "+" on docked pane or left/right
//    sidebars and click options while holding Ctrl or Shift'
// Decisions: an emptied sidebar stays open with "+" and "Press + or drag a tab here"; Ctrl+B left,
// Ctrl+Alt+B right (VS Code) unless the keymap registry shows a conflict — rebindable in Settings ▸
// Shortcuts; Ctrl-click (Cmd) or Shift-click in a "+" menu adds the window and keeps the menu open.
//
//   1  the right sidebar's only tab (Configure Scene) closed by its ×: the column STAYS, empty, with its
//      "+" and the helper line; its width is still taken by a Full-height pin
//   2  "+" on that empty sidebar: a closed window (the Explorer) opens IN THIS COLUMN
//   3  M8 on the sidebar "+": Ctrl-click Statistics and Shift-click Chat keep the menu up (rows rebuilt:
//      Statistics checked "Right sidebar"); a plain click picks one and closes
//   4  shortcuts: Ctrl+Alt+B hides the right sidebar with its tabs still open (no strip, members hidden),
//      again shows it; Ctrl+B opens the EMPTY left sidebar and hides it again; the registry reports no
//      conflict for either; Settings ▸ Shortcuts lists both rows; rebinding the left one to Ctrl+[ moves
//      the key (and resetting puts Ctrl+B back)
//   5  a floating window dragged over the EMPTY left column (not its edge) joins it as its tab
//   6  M8 on the dock "+": on the empty dock, Ctrl-click Timeline and Shift-click Animation dock both
//      with the menu still up; a plain click on the UV editor docks it and closes the menu
//   7  unfolded phone (touch): the right sidebar emptied by its × stays open with "+", and a tap on "+"
//      opens the window list
//
// Counterfactual (origin/feat/43-int): no "+" on a sidebar strip (1/2/3 red), the closed last tab takes the
// column away (1 red), Ctrl+B / Ctrl+Alt+B do nothing (4 red), Ctrl/Shift-click closes the menu (3/6 red).
// Run: APP_URL=https://theprototype.app:5444/ npm run e2e -- sidebar-plus-empty
const h = require('./helpers.cjs');
const OUT = process.env.OUT || '/tmp';

const DESK = { viewport: { width: 1440, height: 900 } };
const UNFOLD = { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 };
const S = (page, fn, arg) => page.evaluate(fn, arg);
const read = (page, path) =>
	S(page, (path) => {
		const [mod, name] = path.split('.');
		// tolerant: a store a build does not have reads null (the counterfactual runs on past it)
		const st = name ? window.__stores[mod]?.[name] : window.__stores[mod];
		if (!st?.subscribe) return null;
		let v;
		st.subscribe((x) => (v = x))();
		return v;
	}, path);

const side = (page, s) =>
	S(page, (s) => {
		const strip = document.querySelector('#sidebar-strip-' + s);
		const r = strip?.getBoundingClientRect();
		return {
			strip: !!strip && r.width > 0,
			plus: !!document.querySelector('#sidebar-add-' + s),
			tabs: strip ? [...strip.querySelectorAll('[data-sidebar-tab]')].map((t) => t.getAttribute('data-sidebar-tab')) : [],
			empty: document.querySelector('#sidebar-empty-' + s)?.textContent.trim() ?? '',
			emptyW: Math.round(document.querySelector('#sidebar-empty-' + s)?.getBoundingClientRect().width ?? 0)
		};
	}, s);

async function clickAt(page, sel) {
	const pt = await S(page, (sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	}, sel);
	if (!pt) return false;
	await page.mouse.click(pt.x, pt.y);
	await page.waitForTimeout(500);
	return true;
}
const menuRows = (page) =>
	S(page, () =>
		[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => ({
			title: el.querySelector('.flex-1')?.textContent.trim() ?? el.textContent.trim(),
			hint: el.querySelector('.ctx-hint')?.textContent.trim() ?? '',
			checked: el.classList.contains('ctx-checked')
		}))
	);
const menuOpen = (page) => S(page, () => !!document.querySelector('[role="menu"]'));
async function clickRow(page, title, mod) {
	const pt = await S(page, (title) => {
		const el = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((r) => (r.querySelector('.flex-1')?.textContent.trim() ?? '') === title);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + 24), y: Math.round(r.top + r.height / 2) };
	}, title);
	if (!pt) return false;
	if (mod) await page.keyboard.down(mod);
	await page.mouse.click(pt.x, pt.y);
	if (mod) await page.keyboard.up(mod);
	await page.waitForTimeout(1100);
	return true;
}
async function press(page, key) {
	await S(page, () => document.activeElement instanceof HTMLElement && document.activeElement.blur());
	await page.mouse.move(700, 300);
	await page.keyboard.press(key);
	await page.waitForTimeout(600);
}

h.run(async () => {
	const browser = await h.launch();
	const D = await h.setupPage(browser, 'desk', { context: DESK, storage: { explorerDocked: 'false', statsDocked: 'false', chatDocked: 'false', flowDocked: 'false', 'sidebar:inspectorSide': 'right' } });
	const page = D.page;

	// ---- 1. the last tab closed by its ×: the column stays open, empty -----------------------------
	await S(page, () => {
		const s = window.__stores;
		s.inspectorKind.set('scene');
		s.inspectorClose.set(false);
	});
	await page.waitForTimeout(1200);
	let r = await side(page, 'right');
	h.check(r.strip && r.tabs.join() === 'inspector' && r.plus, `1.0 premise: Configure Scene is the right sidebar's only tab, and the strip has a "+" (${JSON.stringify(r)})`);
	await clickAt(page, '[data-sidebar-tab-close="inspector"]');
	await page.waitForTimeout(500);
	r = await side(page, 'right');
	h.check((await read(page, 'inspectorClose')) === true, '1.1 premise: its × closed Configure Scene');
	h.check(r.strip && r.tabs.length === 0 && r.plus, `1.2 the emptied right sidebar STAYS open with its "+" (${JSON.stringify(r)})`);
	h.check(r.empty === 'Press + or drag a tab here' && r.emptyW >= 240, `1.3 ...and the helper line fills the column ("${r.empty}", ${r.emptyW}px)`);
	await S(page, () => window.__stores.sidebars.toggleSidebarFull('right', true));
	await page.waitForTimeout(500);
	const dockRight = await S(page, () => getComputedStyle(document.documentElement).getPropertyValue('--sb-dock-right').trim());
	h.check(dockRight !== '0px' && dockRight !== '', `1.4 a Full-height EMPTY column still takes its room (--sb-dock-right ${dockRight})`);
	await page.screenshot({ path: OUT + '/m7-empty-sidebar-dark.png' });
	await S(page, () => {
		document.documentElement.dataset.theme = 'light';
		document.documentElement.classList.remove('dark');
	});
	await page.waitForTimeout(300);
	await page.screenshot({ path: OUT + '/m7-empty-sidebar-light.png' });
	await S(page, () => {
		document.documentElement.dataset.theme = 'dark';
		document.documentElement.classList.add('dark');
		window.__stores.sidebars.toggleSidebarFull('right', false);
	});

	// ---- 2. "+" on the empty sidebar opens a closed window IN THIS COLUMN ---------------------------
	await clickAt(page, '#sidebar-add-right');
	let rows = await menuRows(page);
	const exRow = rows.find((x) => x.title === 'Explorer');
	h.check(rows.some((x) => x.title === 'Configure Scene') && !!exRow && exRow.hint === 'Open', `2.1 the sidebar "+" lists the windows (Configure Scene too); the Explorer says Open (${rows.map((x) => x.title + ':' + x.hint).join(' | ')})`);
	await page.screenshot({ path: OUT + '/m7-sidebar-plus-menu.png' });
	await clickRow(page, 'Explorer');
	r = await side(page, 'right');
	h.check(r.tabs.join() === 'explorer' && !r.empty && !(await menuOpen(page)), `2.2 a plain click opens the Explorer as the right sidebar's tab and closes the menu (${JSON.stringify(r)})`);

	// ---- 3. M8 on the sidebar "+": Ctrl / Shift keep the menu up ------------------------------------
	await clickAt(page, '#sidebar-add-right');
	await clickRow(page, 'Statistics', 'Control');
	h.check(await menuOpen(page), '3.1 Ctrl-click on Statistics keeps the menu open');
	rows = await menuRows(page);
	const st = rows.find((x) => x.title === 'Statistics');
	h.check(!!st?.checked && st.hint === 'Right sidebar', `3.2 ...its row rebuilt: Statistics is now checked "Right sidebar" (${JSON.stringify(st)})`);
	await clickRow(page, 'Chat', 'Shift');
	h.check(await menuOpen(page), '3.3 Shift-click on Chat keeps it open too');
	r = await side(page, 'right');
	h.check(['explorer', 'stats', 'chat'].every((k) => r.tabs.includes(k)), `3.4 both landed in the right sidebar (${r.tabs.join(',')})`);
	// showhide-v8 §5: the Live profiler is a row of the Profiler now, so the plain-click case uses Objects
	await clickRow(page, 'Objects');
	h.check(!(await menuOpen(page)), '3.5 a plain click picks Objects and closes the menu');
	r = await side(page, 'right');
	h.check(r.tabs.includes('objects'), `3.6 ...and it opened in the right sidebar too (${r.tabs.join(',')})`);

	// ---- 4. the shortcuts -----------------------------------------------------------------------------
	const reg = await S(page, () => {
		const s = window.__stores.shortcutsRegistry;
		const row = (id) => s.shortcuts.find((x) => x.id === id);
		return {
			left: row('panels.sidebar-left')?.keys,
			right: row('panels.sidebar-right')?.keys,
			cl: s.conflictOf('Ctrl+B', 'panels.sidebar-left').shortcut?.id ?? null,
			cr: s.conflictOf('Ctrl+Alt+B', 'panels.sidebar-right').shortcut?.id ?? null
		};
	});
	h.check(reg.left === 'Ctrl+B' && reg.right === 'Ctrl+Alt+B' && !reg.cl && !reg.cr, `4.0 registry rows Ctrl+B / Ctrl+Alt+B, no conflict for either (${JSON.stringify(reg)})`);
	await press(page, 'Control+Alt+KeyB');
	r = await side(page, 'right');
	const hiddenState = await S(page, () => ({ stats: document.querySelector('#stats-window')?.hasAttribute('data-sidebar-hidden'), open: (() => { let v; window.__stores.sceneBudget.statsOpen.subscribe((x) => (v = x))(); return v; })() }));
	h.check(!r.strip && hiddenState.stats && hiddenState.open, `4.1 Ctrl+Alt+B hides the right sidebar — no strip, its windows hidden but still open (${JSON.stringify({ strip: r.strip, ...hiddenState })})`);
	await press(page, 'Control+Alt+KeyB');
	r = await side(page, 'right');
	h.check(r.strip && r.tabs.length >= 4, `4.2 ...again brings it back with its tabs (${r.tabs.join(',')})`);
	let l = await side(page, 'left');
	h.check(!l.strip, `4.3 premise: no left sidebar (${JSON.stringify(l)})`);
	await press(page, 'Control+KeyB');
	l = await side(page, 'left');
	h.check(l.strip && l.plus && l.tabs.length === 0 && l.empty === 'Press + or drag a tab here', `4.4 Ctrl+B opens the EMPTY left sidebar with its "+" (${JSON.stringify(l)})`);
	await page.screenshot({ path: OUT + '/m7-ctrl-b-left.png' });
	await press(page, 'Control+KeyB');
	l = await side(page, 'left');
	h.check(!l.strip, `4.5 Ctrl+B again hides it (${JSON.stringify(l)})`);
	// Settings ▸ Shortcuts: both rows; rebind left to Ctrl+[ through the real capture
	await S(page, () => {
		window.__stores.settingsSection.set('shortcuts');
		window.__stores.settingsOpen.set(true);
	});
	await page.waitForSelector('#shortcut-grid', { timeout: 15000 });
	await page.waitForTimeout(300);
	const rowsSet = await S(page, () => ['panels.sidebar-left', 'panels.sidebar-right'].map((id) => document.querySelector(`[data-shortcut="${id}"] .shortcut-keys`)?.textContent.trim() ?? null));
	h.check(rowsSet[0] === 'Ctrl+B' && rowsSet[1] === 'Ctrl+Alt+B', `4.6 Settings ▸ Shortcuts lists both, as bound (${JSON.stringify(rowsSet)})`);
	if (rowsSet[0]) {
		await page.click('[data-shortcut="panels.sidebar-left"] .shortcut-keys');
		await page.waitForTimeout(250);
		await page.keyboard.press('Control+BracketLeft');
		await page.waitForTimeout(400);
	}
	const rebound = await S(page, () => window.__stores.shortcutsRegistry.shortcuts.find((x) => x.id === 'panels.sidebar-left')?.keys);
	await S(page, () => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(500);
	h.check(rebound === 'Ctrl+[', `4.7 rebound to Ctrl+[ through the Settings capture (${rebound})`);
	await press(page, 'Control+BracketLeft');
	l = await side(page, 'left');
	const viaOld = l.strip;
	await press(page, 'Control+BracketLeft');
	await press(page, 'Control+KeyB');
	l = await side(page, 'left');
	h.check(viaOld && !l.strip, `4.8 ...Ctrl+[ now toggles the left sidebar and Ctrl+B no longer does (${viaOld} / ${l.strip})`);
	await S(page, () => window.__stores.shortcutsRegistry.resetShortcut('panels.sidebar-left'));

	// ---- 5. a floating window dragged over the EMPTY left column joins it ----------------------------
	await press(page, 'Control+KeyB');
	await S(page, () => window.__stores.flowGraphClose.set(false));
	await page.waitForTimeout(1300);
	const head = await S(page, () => {
		const el = document.querySelector('#flow-window .move-handle');
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + 14), y: Math.round(r.top + r.height / 2) };
	});
	const target = await S(page, () => {
		const r = document.querySelector('#sidebar-empty-left').getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 120) };
	});
	h.check(target.x > 60, `5.0 premise: the drop point is inside the column, clear of the 44px edge band (x=${target.x})`);
	await page.mouse.move(head.x, head.y);
	await page.mouse.down();
	for (let i = 1; i <= 14; i++) await page.mouse.move(head.x + ((target.x - head.x) * i) / 14, head.y + ((target.y - head.y) * i) / 14);
	// (45 N7: a window's target carries a hint line under its label)
	const zone = await S(page, () => {
		const z = document.getElementById('dock-zone');
		return (z?.querySelector('.sb-drop-label') ?? z)?.textContent ?? '';
	});
	await page.mouse.up();
	await page.waitForTimeout(1200);
	l = await side(page, 'left');
	h.check(l.tabs.join() === 'flow' && zone === 'Add as tab', `5.1 the Node editor dropped on the empty column joins it as its tab (highlight "${zone}", tabs ${l.tabs.join(',')})`);

	// ---- 6. M8 on the dock "+" ------------------------------------------------------------------------
	await S(page, () => {
		window.__stores.chatHidden.set('hidden');
	});
	await press(page, 't');
	const empty = await read(page, 'bottomDock.dockEmptyShown');
	h.check(empty === true, '6.0 premise: the empty dock');
	await clickAt(page, '#phone-dock #dock-add-view');
	await clickRow(page, 'Timeline', 'Control');
	h.check(await menuOpen(page), '6.1 Ctrl-click on Timeline keeps the dock menu open — even though the empty dock it was opened from has gone');
	await clickRow(page, 'Animation', 'Shift');
	h.check(await menuOpen(page), '6.2 Shift-click on Animation keeps it open');
	await clickRow(page, 'UV editor');
	h.check(!(await menuOpen(page)), '6.3 a plain click on the UV editor closes it');
	const docked = ((await read(page, 'bottomDock.dockTabs')) ?? []).map((t) => t.key);
	h.check(['timeline', 'animation', 'uv'].every((k) => docked.includes(k)), `6.4 all three are docked (${docked.join(',')})`);
	// the keyboard: Ctrl+Enter picks and keeps the menu up
	await S(page, () => document.querySelector('#dock-add-view:not([style*="display: none"])'));
	const plus = await S(page, () => {
		const b = [...document.querySelectorAll('#dock-add-view')].find((x) => x.getBoundingClientRect().width > 0);
		const r = b.getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	});
	await page.mouse.click(plus.x, plus.y);
	await page.waitForTimeout(400);
	await page.keyboard.type('shader');
	await page.waitForTimeout(250);
	await page.keyboard.press('Control+Enter');
	await page.waitForTimeout(900);
	const kb = { open: await menuOpen(page), docked: ((await read(page, 'bottomDock.dockTabs')) ?? []).map((t) => t.key) };
	h.check(kb.open && kb.docked.includes('shader'), `6.5 Ctrl+Enter picks the Shader editor and keeps the menu up (${JSON.stringify(kb)})`);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(250);
	if (await menuOpen(page)) await page.keyboard.press('Escape');

	// ---- 7. unfolded phone ------------------------------------------------------------------------------
	const U = await h.setupPage(browser, 'unfold', { context: UNFOLD, storage: { 'sidebar:inspectorSide': 'right' } });
	await S(U.page, () => {
		const s = window.__stores;
		s.inspectorKind.set('scene');
		s.inspectorClose.set(false);
	});
	await U.page.waitForTimeout(1300);
	const x = await S(U.page, () => {
		const r = document.querySelector('[data-sidebar-tab-close="inspector"]').getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	});
	await U.page.touchscreen.tap(x.x, x.y);
	await U.page.waitForTimeout(700);
	const ur = await side(U.page, 'right');
	h.check(ur.strip && ur.plus && ur.tabs.length === 0 && !!ur.empty, `7.1 unfolded: the emptied right sidebar stays open with its "+" (${JSON.stringify(ur)})`);
	const p = await S(U.page, () => {
		const r = document.querySelector('#sidebar-add-right').getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	});
	await U.page.touchscreen.tap(p.x, p.y);
	await U.page.waitForTimeout(600);
	const urows = await menuRows(U.page);
	h.check(urows.length >= 10, `7.2 unfolded: a tap on "+" lists the windows (${urows.length})`);
	await U.page.screenshot({ path: OUT + '/m7-empty-sidebar-unfolded.png' });

	await h.finish(browser);
});
