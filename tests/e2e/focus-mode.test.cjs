// 42 I14 — the user's preview-1-32c review: "add focus mode? which hides all windows/tabs temporarily showing
// fullscreen viewport? maybe it can also work for docker window to open it on full screen. Probably this can be
// achieved using a shortcut (suggest which one to use, what is best practice for DCC)".
// Decision: Ctrl+Space (Blender's "maximize area") toggles a maximize of the HOVERED area — the viewport =
// all chrome hidden; a docked window = it fills the window; Esc or Ctrl+Space restores; View ▸ Focus mode on
// desktop, More ▸ Focus mode on a phone; a keymap-registry row (rebindable) + the shortcut docs row.
//
//   1  viewport: Ctrl+Space over the 3D view hides every panel, window and dock, the canvas fills the window,
//      nothing CLOSES; Esc restores all of it
//   2  Ctrl+Space again restores too
//   3  a docked window: Ctrl+Space over the docked Explorer makes it fill the window (chrome hidden);
//      Ctrl+Space restores it to its dock height
//   4  a HOSTED docked window (Objects) maximizes from its tab menu ("Maximize"); the Exit-focus pill restores
//   5  View ▸ Focus mode in the viewport menu enters it; the same row (checked) leaves
//   6  opening a modal (Settings) leaves focus mode
//   7  the keymap registry: one row, Ctrl+Space, rebindable — and a rebound key drives it
//   8  phone (N6 folded, real touch): More ▸ Focus mode hides the phone chrome; the pill brings it back
//
// Counterfactual: on origin/feat/41-int Ctrl+Space does nothing (no data-focus, every panel stays).
// Run: APP_URL=https://localhost:5424/ npm run e2e -- focus-mode
const h = require('./helpers.cjs');
// THEME=light re-runs the same paths for the light-theme evidence shots
const THEME = process.env.THEME || 'dark';

const DESK = { viewport: { width: 1440, height: 900 } };
const FOLDED = { viewport: { width: 390, height: 896 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 };
const S = (page, fn, arg) => page.evaluate(fn, arg);
const read = (page, path) =>
	S(page, (path) => {
		const [mod, name] = path.split('.');
		let v;
		(name ? window.__tp.test.v1[mod][name] : window.__tp.test.v1[mod]).subscribe((x) => (v = x))();
		return v;
	}, path);

/** what is on screen: the focus attribute and the boxes of the chrome that must hide / come back */
const scene = (page) =>
	S(page, () => {
		const vis = (sel) => {
			const el = document.querySelector(sel);
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
		};
		const box = (el) => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
		};
		const canvas = window.__tp?.test.v1?.globalRenderer ? null : null;
		const cv = document.querySelector('.viewport canvas');
		const dock = [...document.querySelectorAll('.tp-dock-panel')].find((d) => !d.classList.contains('hidden') && d.getBoundingClientRect().height > 0);
		return {
			focus: document.documentElement.getAttribute('data-focus'),
			connect: vis('.connect-pill'),
			controls: vis('#controls-pill') ?? vis('.controls-pill'),
			objects: vis('#object-list'),
			dock: !!dock,
			dockId: dock?.id ?? null,
			dockBox: box(dock),
			canvas: box(cv),
			pill: vis('#focus-exit'),
			vw: innerWidth,
			vh: innerHeight,
			_c: canvas
		};
	});

/** an empty spot of the 3D view: the canvas owns the point */
const viewportPoint = (page) =>
	S(page, () => {
		for (const [x, y] of [
			[720, 300],
			[600, 250],
			[900, 280],
			[500, 350]
		]) {
			const el = document.elementFromPoint(x, y);
			if (el && el.tagName === 'CANVAS') return { x, y };
		}
		return null;
	});

async function openDock(page) {
	await S(page, async () => {
		const s = window.__tp?.test.v1;
		s.flowGraphClose.set(false);
		s.explorerClose.set(false);
		await new Promise((r) => setTimeout(r, 600));
		s.bottomDock.activateDock('explorer');
	});
	await page.waitForTimeout(900);
}

h.run(async () => {
	const browser = await h.launch();
	const out = process.env.OUT || '/tmp';
	const P = await h.setupPage(browser, 'D', { context: DESK, storage: { flowDocked: 'true', explorerDocked: 'true', flowDockHeight: '300', theme: THEME } });
	const page = P.page;
	await openDock(page);
	await S(page, () => window.__tp.test.v1.objectListClose.set(false));
	await page.waitForTimeout(900);
	let st = await scene(page);
	h.check(st.connect && st.objects && st.dock && !st.focus, `premise: Connect, the Objects window and the dock are on screen (${JSON.stringify(st)})`);
	const dockedH = st.dockBox.height;

	// ---- 1. viewport --------------------------------------------------------------------------
	let vp = await viewportPoint(page);
	h.check(!!vp, `1.0 premise: an empty viewport point (${JSON.stringify(vp)})`);
	await page.mouse.move(vp.x, vp.y);
	await page.mouse.click(vp.x, vp.y);
	await page.keyboard.press('Control+Space');
	await page.waitForTimeout(500);
	st = await scene(page);
	await page.screenshot({ path: out + '/i14-viewport-focus-' + THEME + '.png' });
	h.check(st.focus === 'viewport', `1.1 Ctrl+Space over the 3D view enters VIEWPORT focus (${st.focus})`);
	h.check(!st.connect && !st.objects && !st.dock && !st.controls, `1.2 ...the Connect bar, the Controls, the Objects window and the dock are hidden (${JSON.stringify(st)})`);
	h.check(st.canvas && st.canvas.height >= st.vh - 1 && st.canvas.width >= st.vw - 1, `1.3 ...the canvas fills the window (${JSON.stringify(st.canvas)})`);
	h.check(st.pill, '1.4 ...an "Exit focus" pill is shown');
	h.check((await read(page, 'objectListClose')) === false && (await read(page, 'explorerClose')) === false, '1.5 ...and nothing was CLOSED (the panels are only hidden)');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(500);
	st = await scene(page);
	h.check(!st.focus && st.connect && st.objects && st.dock && !st.pill, `1.6 Esc restores every panel (${JSON.stringify(st)})`);

	// ---- 2. Ctrl+Space toggles back -------------------------------------------------------------
	await page.mouse.move(vp.x, vp.y);
	await page.keyboard.press('Control+Space');
	await page.waitForTimeout(400);
	const on = (await scene(page)).focus;
	await page.keyboard.press('Control+Space');
	await page.waitForTimeout(400);
	st = await scene(page);
	h.check(on === 'viewport' && !st.focus && st.connect && st.dock, `2.1 Ctrl+Space again restores (${on} -> ${st.focus})`);

	// ---- 3. a docked window ---------------------------------------------------------------------
	const dockPt = await S(page, () => {
		const d = document.getElementById('explorer-dock') ?? [...document.querySelectorAll('.tp-dock-panel')].find((x) => !x.classList.contains('hidden') && x.getBoundingClientRect().height > 0);
		const r = d.getBoundingClientRect();
		return { x: Math.round(r.left + r.width * 0.6), y: Math.round(r.top + r.height * 0.6), id: d.id };
	});
	await page.mouse.move(dockPt.x, dockPt.y);
	await page.keyboard.press('Control+Space');
	await page.waitForTimeout(600);
	st = await scene(page);
	await page.screenshot({ path: out + '/i14-dock-focus-' + THEME + '.png' });
	h.check(st.focus === 'dock', `3.1 Ctrl+Space over the docked Explorer enters DOCK focus (${st.focus}, aimed at ${dockPt.id})`);
	h.check(st.dock && st.dockBox.width === st.vw && st.dockBox.bottom === st.vh && st.dockBox.top < 100 && st.dockBox.height > st.vh - 100, `3.2 ...the docked window fills the window (${JSON.stringify(st.dockBox)}, was ${dockedH} tall)`);
	h.check(!st.connect && !st.objects, '3.3 ...every other piece of chrome is hidden');
	// the editor's INSIDE follows too (the Explorer sizes its shell from the dock height)
	const inner = await S(page, () => {
		const d = document.getElementById('explorer-list');
		const kids = [...d.querySelectorAll(':scope > div')].map((k) => k.getBoundingClientRect()).filter((r) => r.height > 0);
		return Math.round(Math.max(...kids.map((r) => r.bottom)));
	});
	h.check(inner >= 900 - 24, `3.3b ...and its content reaches the bottom of the window, not just its box (content bottom ${inner})`);
	const stripOnScreen = await S(page, () => {
		const row = [...document.querySelectorAll('.dt-row')].find((r) => r.getBoundingClientRect().width > 0);
		const r = row?.getBoundingClientRect();
		const pill = document.getElementById('focus-exit')?.getBoundingClientRect();
		return { strip: !!r && r.top >= 0, overlap: !!r && !!pill && pill.bottom > r.top && pill.top < r.bottom && pill.right > r.left && pill.left < r.right };
	});
	h.check(stripOnScreen.strip && !stripOnScreen.overlap, `3.4 ...its tab strip stays on screen, clear of the exit pill (${JSON.stringify(stripOnScreen)})`);
	await page.mouse.move(dockPt.x, dockPt.y);
	await page.keyboard.press('Control+Space');
	await page.waitForTimeout(500);
	st = await scene(page);
	h.check(!st.focus && st.dock && Math.abs(st.dockBox.height - dockedH) <= 2 && st.connect, `3.5 Ctrl+Space restores it to its dock height (${st.dockBox?.height} vs ${dockedH})`);

	// ---- 4. a hosted docked window from its tab menu; the pill restores --------------------------
	await S(page, () => window.__tp.test.v1.dockHost.setHostedDocked('objects', true));
	await page.waitForTimeout(1000);
	await page.locator('[data-dock-tab="objects"]:visible').first().click({ button: 'right' });
	await page.waitForTimeout(300);
	await page.click('[role="menu"] [role="menuitem"]:has-text("Maximize")');
	await page.waitForTimeout(600);
	const ol = await S(page, () => {
		const r = document.getElementById('object-list').getBoundingClientRect();
		return { host: document.getElementById('object-list').getAttribute('data-pd-host'), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), focus: document.documentElement.getAttribute('data-focus') };
	});
	await page.screenshot({ path: out + '/i14-hosted-objects-focus-' + THEME + '.png' });
	h.check(ol.focus === 'dock' && ol.host === 'shown' && ol.width === 1440 && ol.bottom === 900 && ol.top < 140, `4.1 the tab menu's "Maximize" fills the window with the docked Objects list (${JSON.stringify(ol)})`);
	await page.click('#focus-exit button:not(#focus-pip-toggle)'); // 44 M15: the Viewport toggle sits left of it
	await page.waitForTimeout(500);
	st = await scene(page);
	h.check(!st.focus && st.connect, '4.2 the "Exit focus" pill restores');
	await S(page, () => window.__tp.test.v1.dockHost.setHostedDocked('objects', false));
	await page.waitForTimeout(800);

	// ---- 5. View ▸ Focus mode -------------------------------------------------------------------
	vp = await viewportPoint(page);
	await S(page, (vp) => window.__tp.test.v1.viewportMenu.set({ x: vp.x, y: vp.y, point: [0, 0, 0] }), vp);
	await page.waitForTimeout(400);
	await page.locator('[role="menu"] [role="menuitem"]').filter({ hasText: /^\s*View/ }).first().hover();
	await page.waitForTimeout(400);
	await page.locator('[role="menu"] [role="menuitem"]').filter({ hasText: /^\s*Focus mode/ }).first().click();
	await page.waitForTimeout(500);
	st = await scene(page);
	h.check(st.focus === 'viewport' && !st.connect, `5.1 View ▸ Focus mode enters viewport focus (${st.focus})`);
	await S(page, (vp) => window.__tp.test.v1.viewportMenu.set({ x: vp.x, y: vp.y, point: [0, 0, 0] }), vp);
	await page.waitForTimeout(400);
	const menuOk = await S(page, () => !!document.querySelector('[role="menu"]'));
	h.check(menuOk, '5.2 the viewport menu still opens in focus mode (menus are not hidden)');
	await page.locator('[role="menu"] [role="menuitem"]').filter({ hasText: /^\s*View/ }).first().hover();
	await page.waitForTimeout(400);
	await page.locator('[role="menu"] [role="menuitem"]').filter({ hasText: /^\s*Focus mode/ }).first().click();
	await page.waitForTimeout(500);
	st = await scene(page);
	h.check(!st.focus && st.connect, '5.3 ...and its Focus mode row leaves again');

	// ---- 6. a modal leaves focus mode ------------------------------------------------------------
	await page.mouse.move(vp.x, vp.y);
	await page.keyboard.press('Control+Space');
	await page.waitForTimeout(300);
	await S(page, () => window.__tp.test.v1.settingsOpen.set(true));
	await page.waitForTimeout(500);
	st = await scene(page);
	h.check(!st.focus, `6.1 opening Settings leaves focus mode (${st.focus})`);
	await S(page, () => window.__tp.test.v1.settingsOpen.set(false));
	await page.waitForTimeout(500);

	// ---- 7. the keymap registry -------------------------------------------------------------------
	const reg = await S(page, () => {
		const r = window.__tp.test.v1.shortcutsRegistry;
		const row = r.shortcuts.find((s) => s.id === 'view.focus');
		const esc = r.shortcuts.find((s) => s.id === 'view.focus-exit');
		return { keys: row?.keys, group: row?.group, rebindable: r.isRebindable?.(row), esc: esc?.keys };
	});
	h.check(reg.keys === 'Ctrl+Space' && reg.group === 'View' && reg.rebindable === true && reg.esc === 'Escape', `7.1 the registry row: Ctrl+Space, View, rebindable (+ the Esc row) (${JSON.stringify(reg)})`);
	const rb = await S(page, () => window.__tp.test.v1.shortcutsRegistry.rebindShortcut('view.focus', 'Ctrl+Shift+F'));
	await page.mouse.move(vp.x, vp.y);
	await page.mouse.click(vp.x, vp.y);
	await page.keyboard.press('Control+Shift+F');
	await page.waitForTimeout(400);
	const rebound = (await scene(page)).focus;
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	await S(page, () => window.__tp.test.v1.shortcutsRegistry.resetShortcut?.('view.focus') ?? window.__tp.test.v1.shortcutsRegistry.rebindShortcut('view.focus', 'Ctrl+Space'));
	h.check(rb?.ok !== false && rebound === 'viewport', `7.2 rebound to Ctrl+Shift+F, the new key drives it (${JSON.stringify(rb)}, ${rebound})`);
	await P.ctx.close();

	// ---- 8. phone: More ▸ Focus mode, real touch ---------------------------------------------------
	const Ph = await h.setupPage(browser, 'phone', { context: FOLDED, storage: { theme: THEME } });
	const pp = Ph.page;
	await S(pp, () => window.__tp.test.v1.phoneShell.phoneSheet.set('more'));
	await pp.waitForTimeout(800);
	h.check(!!(await pp.locator('#ps-focus-mode').count()), '8.0 premise: More lists "Focus mode"');
	await pp.locator('#ps-focus-mode').tap();
	await pp.waitForTimeout(700);
	const ph = await S(pp, () => {
		const vis = (sel) => {
			const el = document.querySelector(sel);
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
		};
		return { focus: document.documentElement.getAttribute('data-focus'), bar: vis('#ps-bar'), pill: vis('#focus-exit'), sheet: vis('#ps-more-sheet') };
	});
	await pp.screenshot({ path: out + '/i14-phone-focus-folded-' + THEME + '.png' });
	h.check(ph.focus === 'viewport' && !ph.bar && !ph.sheet && ph.pill, `8.1 More ▸ Focus mode on a folded N6: the phone bar and sheet are hidden, the pill shows (${JSON.stringify(ph)})`);
	await pp.locator('#focus-exit button:not(#focus-pip-toggle)').tap();
	await pp.waitForTimeout(600);
	const back = await S(pp, () => ({ focus: document.documentElement.getAttribute('data-focus'), bar: !!document.querySelector('#ps-bar') && document.querySelector('#ps-bar').getBoundingClientRect().height > 0 }));
	h.check(!back.focus && back.bar, `8.2 tapping "Exit focus" brings the phone chrome back (${JSON.stringify(back)})`);

	await h.finish(browser);
});
