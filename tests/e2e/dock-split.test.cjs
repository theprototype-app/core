// 44 M9 — the dock split (the user's preview-1-34 review):
//   'allow to split the dock vertically in two (add a third button which does it on the left of
//    "Minimize"/"Undock" buttons and also for each tab context menu on dock pane add split/unsplit
//    options if makes sense), split bar should be possible to drag to adjust position and I want to
//    be able to drag items, and tab name should show "/" to indicate which windows are splitted'
// Decision: two panes SIDE BY SIDE with a draggable vertical divider; the pair is ONE dock tab
// "Node editor / Explorer"; drag a tab onto a pane to swap it in; tab menu Split right / Unsplit /
// Swap sides; the split button left of Minimize/Undock splits the active tab with the next one (or
// an empty pane with "+"). Remembered.
//
//   1  the split button (a real click): one "A / B" strip tab, both views on screen side by side,
//      the divider between them, one strip for the pair (dark + light shots)
//   2  the divider: a real mouse drag moves it (and both panes' edges), arrow keys nudge it,
//      double-click centres it
//   3  a press in the right pane fronts that half (the strip's half reads full-strength)
//   4  remembered: the pair + its divider survive a reload
//   5  the tab menu: Swap sides, then Unsplit (two tabs again); Split right from a plain tab
//   6  an empty pane: the last tab splits with an empty right pane, its "+" fills it
//   7  drag a tab out of the strip onto a pane: it is swapped in, the replaced view stays a tab
//   8  a hosted window (Statistics) as a half: it sits in its pane like an editor does
//   9  the unfolded phone (touch): a tapped split button and a TOUCH drag of the divider
//
// Counterfactual: on origin/feat/44-docks there is no #dock-split, no pair tab and no divider —
// sections 1-9 are red (the store probes read null and the suite runs on past them).
// Run: APP_URL=https://theprototype.app:5447/ npm run e2e -- dock-split
const h = require('./helpers.cjs');
const OUT = process.env.OUT || '/tmp';

const DESK = { viewport: { width: 1440, height: 900 } };
const UNFOLD = { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 };
const DOCKED = { flowDocked: 'true', explorerDocked: 'true', animationDocked: 'true', timelineDocked: 'true', statsDocked: 'true' };
const S = (page, fn, arg) => page.evaluate(fn, arg);
const read = (page, path) =>
	S(page, (path) => {
		const [mod, name] = path.split('.');
		const st = name ? window.__stores[mod]?.[name] : window.__stores[mod];
		if (!st?.subscribe) return null;
		let v;
		st.subscribe((x) => (v = x))();
		return v;
	}, path);
const call = (page, name, ...args) => S(page, ([name, args]) => window.__stores.bottomDock[name]?.(...args), [name, args]);

/** what is on screen in the dock */
const view = (page) =>
	S(page, () => {
		const vis = (el) => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			if (!r.width || el.classList.contains('hidden') || getComputedStyle(el).display === 'none') return null;
			return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), pane: el.getAttribute('data-dock-pane') ?? el.getAttribute('data-pd-host-pane') };
		};
		const row = [...document.querySelectorAll('.dt-row')].find((r) => r.getBoundingClientRect().width > 0 && getComputedStyle(r).display !== 'none');
		const rows = [...document.querySelectorAll('.dt-row')].filter((r) => r.getBoundingClientRect().width > 0 && getComputedStyle(r).display !== 'none').length;
		const div = document.querySelector('#dock-split-divider');
		const dr = div?.getBoundingClientRect();
		return {
			tabs: row ? [...row.querySelectorAll('[data-dock-tab]')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()) : [],
			rows,
			flow: vis(document.querySelector('#flow-list')),
			explorer: vis(document.querySelector('#explorer-list')),
			animation: vis(document.querySelector('.tp-dock-panel[aria-label="Animation (docked)"]')),
			stats: vis(document.querySelector('#stats-window[data-pd-host="shown"]')),
			empty: vis(document.querySelector('#dock-split-empty')),
			divider: dr ? Math.round(dr.left + dr.width / 2) : null,
			splitBtn: [...document.querySelectorAll('#dock-split')].find((b) => b.getBoundingClientRect().width > 0)?.getAttribute('aria-pressed') ?? null,
			halfOn: row ? [...row.querySelectorAll('.dt-half-on')].map((x) => x.textContent.trim()) : []
		};
	});

const center = (page, sel) =>
	S(page, (sel) => {
		const el = [...document.querySelectorAll(sel)].find((x) => x.getBoundingClientRect().width > 0 && getComputedStyle(x).display !== 'none');
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	}, sel);
async function click(page, sel) {
	const at = await center(page, sel);
	if (!at) return false;
	await page.mouse.click(at.x, at.y);
	await page.waitForTimeout(600);
	return true;
}
const menuItems = (page) => S(page, () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => (el.querySelector('.flex-1')?.textContent ?? el.textContent).trim()));
async function clickRow(page, title) {
	const pt = await S(page, (title) => {
		const el = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((r) => (r.querySelector('.flex-1')?.textContent ?? r.textContent).trim() === title);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) };
	}, title);
	if (!pt) return false;
	await page.mouse.click(pt.x, pt.y);
	await page.waitForTimeout(800);
	return true;
}
async function closeMenu(page) {
	if (await S(page, () => !!document.querySelector('[role="menu"]'))) {
		await page.keyboard.press('Escape');
		await page.waitForTimeout(250);
	}
}
async function answerRestore(page) {
	for (let i = 0; i < 10; i++) {
		const b = await page.$('#restore-session-dismiss');
		if (b) {
			await b.click().catch(() => {});
			return;
		}
		await page.waitForTimeout(300);
	}
}
async function openDocked(page, keys) {
	await S(page, async (keys) => {
		const s = window.__stores;
		const close = { flow: s.flowGraphClose, explorer: s.explorerClose, animation: s.animationClose, timeline: s.timelineClose };
		for (const k of keys) {
			if (k === 'stats') s.sceneBudget.statsOpen.set(true);
			else close[k]?.set(false);
			await new Promise((r) => setTimeout(r, 500));
		}
		s.bottomDock.activateDock(keys[0]);
	}, keys);
	await page.waitForTimeout(1200);
}
async function shots(page, name) {
	await page.screenshot({ path: `${OUT}/${name}-dark.png` });
	await S(page, () => {
		document.documentElement.dataset.theme = 'light';
		document.documentElement.classList.remove('dark');
	});
	await page.waitForTimeout(300);
	await page.screenshot({ path: `${OUT}/${name}-light.png` });
	await S(page, () => {
		document.documentElement.dataset.theme = 'dark';
		document.documentElement.classList.add('dark');
	});
	await page.waitForTimeout(200);
}

h.run(async () => {
	const browser = await h.launch();
	const D = await h.setupPage(browser, 'desk', { context: DESK, storage: DOCKED });
	const page = D.page;
	await answerRestore(page);
	await openDocked(page, ['flow', 'explorer', 'animation']);
	let v = await view(page);
	h.check(v.tabs.length === 3 && !!v.flow && !v.explorer, `1.0 premise: three docked tabs, the Node editor in front (${JSON.stringify(v)})`);

	// ---- 1. the split button ------------------------------------------------------------------------
	h.check(v.splitBtn === 'false', `1.1 a split button sits in the dock chrome, not pressed (${v.splitBtn})`);
	const order = await S(page, () => [...document.querySelectorAll('.dt-chrome')].filter((c) => c.getBoundingClientRect().width > 0)[0]?.querySelectorAll('button') ?? []).then(() =>
		S(page, () => {
			const c = [...document.querySelectorAll('.dt-chrome')].find((x) => x.getBoundingClientRect().width > 0);
			return c ? [...c.querySelectorAll('button')].map((b) => b.id) : [];
		})
	);
	h.check(order.join() === 'dock-split,dock-undock,dock-minimize', `1.2 ...LEFT of Undock and Minimize (${order})`);
	await click(page, '#dock-split');
	v = await view(page);
	h.check(v.tabs.length === 2 && /Node editor\s*\/\s*Explorer/.test(v.tabs[0]), `1.3 one "A / B" strip tab for the pair (${JSON.stringify(v.tabs)})`);
	h.check(!!v.flow && !!v.explorer && v.flow.pane === 'a' && v.explorer.pane === 'b', `1.4 both views render, left and right (${JSON.stringify([v.flow, v.explorer])})`);
	h.check(!!v.flow && !!v.explorer && Math.abs(v.flow.r - v.explorer.l) <= 1 && Math.abs(v.flow.t - v.explorer.t) <= 1 && v.flow.l === 0 && v.explorer.r === 1440, `1.5 side by side, edge to edge across the dock (${JSON.stringify([v.flow, v.explorer])})`);
	h.check(v.divider !== null && v.flow && Math.abs(v.divider - v.flow.r) <= 1 && Math.abs(v.divider - 720) <= 2, `1.6 the divider sits between them, in the middle (${v.divider})`);
	h.check(v.rows === 1 && v.splitBtn === 'true', `1.7 one strip for the pair, the split button pressed (rows ${v.rows}, ${v.splitBtn})`);
	const chromeR = await S(page, () => Math.round([...document.querySelectorAll('.dt-chrome')].find((x) => x.getBoundingClientRect().width > 0)?.getBoundingClientRect().right ?? 0));
	h.check(chromeR >= 1420, `1.8 the dock chrome stays on the dock's right edge (${chromeR})`);
	await shots(page, 'm9-split');

	// ---- 2. the divider ----------------------------------------------------------------------------
	const dv = await center(page, '#dock-split-divider');
	await page.mouse.move(dv.x, dv.y);
	await page.mouse.down();
	for (let i = 1; i <= 10; i++) await page.mouse.move(dv.x - i * 25, dv.y);
	await page.mouse.up();
	await page.waitForTimeout(400);
	v = await view(page);
	let split = (await read(page, 'bottomDock.dockSplits'))?.[0];
	h.check(split && Math.abs(split.r - 470 / 1440) < 0.01 && Math.abs(v.divider - 470) <= 2, `2.1 a real drag moves the divider (r ${split?.r?.toFixed(3)}, at ${v.divider})`);
	h.check(v.flow && v.explorer && Math.abs(v.flow.r - 470) <= 2 && Math.abs(v.explorer.l - 470) <= 2, `2.2 ...and both panes' edges with it (${v.flow?.r} | ${v.explorer?.l})`);
	await page.mouse.move(dv.x - 250, dv.y);
	await page.mouse.down();
	await page.mouse.move(5, dv.y, { steps: 6 });
	await page.mouse.up();
	split = (await read(page, 'bottomDock.dockSplits'))?.[0];
	h.check(split && Math.abs(split.r - 0.15) < 1e-6, `2.3 a pane cannot be dragged shut (clamped at 15 %: ${split?.r})`);
	await S(page, () => document.querySelector('#dock-split-divider')?.focus());
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Shift+ArrowRight');
	split = (await read(page, 'bottomDock.dockSplits'))?.[0];
	h.check(split && Math.abs(split.r - 0.27) < 1e-6, `2.4 the arrow keys nudge it (2 %, Shift 10 %: ${split?.r})`);
	const dv2 = await center(page, '#dock-split-divider');
	await page.mouse.dblclick(dv2.x, dv2.y);
	await page.waitForTimeout(300);
	split = (await read(page, 'bottomDock.dockSplits'))?.[0];
	h.check(split && split.r === 0.5, `2.5 a double-click centres it (${split?.r})`);
	const cursor = await S(page, () => getComputedStyle(document.querySelector('#dock-split-divider')).cursor);
	h.check(cursor === 'col-resize', `2.6 it says it resizes (${cursor})`);

	// ---- 3. a press in a pane fronts that half -------------------------------------------------------
	h.check((await read(page, 'bottomDock.bottomDockActive')) === 'flow', '3.0 premise: the left half is in front');
	v = await view(page);
	await page.mouse.click(Math.round((v.explorer.l + v.explorer.r) / 2), v.explorer.b - 40);
	await page.waitForTimeout(500);
	v = await view(page);
	h.check((await read(page, 'bottomDock.bottomDockActive')) === 'explorer' && !!v.flow && !!v.explorer, `3.1 a press in the right pane fronts the Explorer, the split stays (${JSON.stringify(v.halfOn)})`);
	h.check(v.halfOn.join() === 'Explorer', `3.2 the strip's half for it reads full-strength (${v.halfOn})`);
	await page.mouse.click(Math.round((v.flow.l + v.flow.r) / 2), v.flow.b - 40);
	await page.waitForTimeout(500);
	h.check((await read(page, 'bottomDock.bottomDockActive')) === 'flow', '3.3 ...and a press in the left one fronts the Node editor');
	await closeMenu(page);

	// ---- 4. remembered ------------------------------------------------------------------------------
	await call(page, 'setSplitRatio', 'flow', 0.4);
	await h.freshReload(D);
	await answerRestore(page);
	split = (await read(page, 'bottomDock.dockSplits'))?.[0];
	h.check(split && split.a === 'flow' && split.b === 'explorer' && Math.abs(split.r - 0.4) < 1e-6, `4.1 the pair and its divider survive a reload (${JSON.stringify(split)})`);
	await openDocked(page, ['flow', 'explorer', 'animation']);
	v = await view(page);
	h.check(!!v.flow && !!v.explorer && Math.abs(v.divider - 576) <= 2 && /Node editor\s*\/\s*Explorer/.test(v.tabs[0] ?? ''), `4.2 ...and the split is back on screen once its views are (${JSON.stringify(v.tabs)}, ${v.divider})`);

	// ---- 5. the tab menu ----------------------------------------------------------------------------
	let at = await center(page, '[data-dock-tab="flow"]');
	await page.mouse.click(at.x, at.y, { button: 'right' });
	await page.waitForTimeout(400);
	let items = await menuItems(page);
	h.check(items.includes('Swap sides') && items.includes('Unsplit') && !items.includes('Split right'), `5.1 a pair's menu offers Swap sides and Unsplit (${items.join(' | ')})`);
	await clickRow(page, 'Swap sides');
	v = await view(page);
	split = (await read(page, 'bottomDock.dockSplits'))?.[0];
	h.check(split?.a === 'explorer' && split?.b === 'flow' && v.explorer?.pane === 'a' && v.flow?.pane === 'b' && v.explorer.l === 0, `5.2 Swap sides: the Explorer left, the Node editor right (${JSON.stringify(split)})`);
	h.check(/Explorer\s*\/\s*Node editor/.test(v.tabs[0] ?? ''), `5.3 ...and the tab says so (${v.tabs[0]})`);
	at = await center(page, '[data-dock-pair]');
	await page.mouse.click(at.x, at.y, { button: 'right' });
	await page.waitForTimeout(400);
	await clickRow(page, 'Unsplit');
	v = await view(page);
	h.check(v.tabs.length === 3 && !v.tabs.some((t) => t.includes('/')) && v.divider === null && !(v.flow && v.explorer), `5.4 Unsplit: three plain tabs, one view on screen, no divider (${JSON.stringify(v.tabs)})`);
	await call(page, 'activateDock', 'explorer');
	await page.waitForTimeout(300);
	at = await center(page, '[data-dock-tab="explorer"]');
	await page.mouse.click(at.x, at.y, { button: 'right' });
	await page.waitForTimeout(400);
	items = await menuItems(page);
	h.check(items.includes('Split right') && items.includes('Split with') && !items.includes('Unsplit'), `5.5 a plain tab's menu offers Split right / Split with (${items.join(' | ')})`);
	await clickRow(page, 'Split right');
	split = (await read(page, 'bottomDock.dockSplits'))?.[0];
	v = await view(page);
	h.check(split?.a === 'explorer' && split?.b === 'animation' && !!v.explorer && !!v.animation, `5.6 Split right pairs it with the next tab (${JSON.stringify(split)})`);
	await call(page, 'unsplitDock', 'explorer');
	await page.waitForTimeout(300);

	// ---- 6. an empty pane ---------------------------------------------------------------------------
	await call(page, 'activateDock', 'animation');
	await page.waitForTimeout(300);
	// the last tab in the strip: the split button gives it an EMPTY right pane
	const lastKey = (await read(page, 'bottomDock.dockStripTabs')).map((t) => t.key).pop();
	await call(page, 'activateDock', lastKey);
	await page.waitForTimeout(300);
	await click(page, '#dock-split');
	v = await view(page);
	split = (await read(page, 'bottomDock.dockSplits'))?.[0];
	h.check(split?.a === lastKey && split?.b === null && !!v.empty && v.empty.pane === 'b', `6.1 the last tab splits with an EMPTY right pane (${JSON.stringify(split)} ${JSON.stringify(v.empty)})`);
	const hint = await S(page, () => document.querySelector('#dock-split-empty')?.textContent.trim());
	h.check(/press \+/i.test(hint ?? ''), `6.2 the empty pane says how to fill it ("${hint}")`);
	h.check(v.tabs.some((t) => /\/\s*Empty/.test(t)), `6.3 its tab reads "… / Empty" (${JSON.stringify(v.tabs)})`);
	await shots(page, 'm9-empty-pane');
	await click(page, '#dock-split-empty-add');
	items = await menuItems(page);
	h.check(items.includes('Timeline'), `6.4 its "+" opens the window menu (${items.length} rows)`);
	await clickRow(page, 'Timeline');
	await page.waitForTimeout(800);
	split = (await read(page, 'bottomDock.dockSplits'))?.[0];
	v = await view(page);
	h.check(split?.b === 'timeline' && !v.empty, `6.5 picking Timeline fills the empty pane (${JSON.stringify(split)})`);
	const fcPane = await S(page, () => document.querySelector('.tp-dock-panel[aria-label="Timeline (docked)"]')?.getAttribute('data-dock-pane'));
	h.check(fcPane === 'b', `6.6 ...in the right pane (${fcPane})`);
	await call(page, 'unsplitDock', lastKey);
	await page.waitForTimeout(300);

	// ---- 7. drag a tab onto a pane ------------------------------------------------------------------
	await call(page, 'splitDock', 'flow', 'explorer');
	await page.waitForTimeout(600);
	v = await view(page);
	const from = await center(page, '[data-dock-tab="animation"]');
	const to = { x: Math.round((v.explorer.l + v.explorer.r) / 2), y: Math.round((v.explorer.t + v.explorer.b) / 2) };
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	for (let i = 1; i <= 16; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 16, from.y + ((to.y - from.y) * i) / 16);
	const zone = await S(page, () => !!document.querySelector('#dock-tab-pane-zone, [data-drop-target]'));
	await page.mouse.up();
	await page.waitForTimeout(900);
	split = (await read(page, 'bottomDock.dockSplits'))?.[0];
	v = await view(page);
	h.check(zone, '7.1 dragging a tab over a pane shows where it lands');
	h.check(split?.a === 'flow' && split?.b === 'animation' && !!v.animation && v.animation.pane === 'b', `7.2 dropped on the right pane, the Animation editor is swapped in (${JSON.stringify(split)})`);
	h.check(v.tabs.some((t) => /^Explorer/.test(t)) && v.tabs.some((t) => /Node editor\s*\/\s*Animation/.test(t)), `7.3 the Explorer it replaced stays a tab (${JSON.stringify(v.tabs)})`);
	h.check((await read(page, 'bottomDock.dockOccupants'))?.explorer?.present === true, '7.4 ...still docked and open');
	await call(page, 'unsplitDock', 'flow');
	await page.waitForTimeout(300);

	// ---- 8. a hosted window as a half ---------------------------------------------------------------
	await openDocked(page, ['stats']);
	await call(page, 'splitDock', 'flow', 'stats');
	await page.waitForTimeout(1200);
	v = await view(page);
	h.check(!!v.flow && !!v.stats && v.stats.pane === 'b' && Math.abs(v.stats.l - v.flow.r) <= 1 && v.stats.r === 1440, `8.1 Statistics (a hosted window) sits in the right pane (${JSON.stringify([v.flow, v.stats])})`);
	await call(page, 'swapSplitSides', 'flow');
	await page.waitForTimeout(800);
	v = await view(page);
	h.check(!!v.stats && v.stats.pane === 'a' && v.stats.l === 0 && !!v.flow && v.flow.pane === 'b', `8.2 ...and the left one when swapped (${JSON.stringify([v.stats, v.flow])})`);
	h.check(v.rows === 1 && /Statistics\s*\/\s*Node editor/.test(v.tabs.find((t) => t.includes('/')) ?? ''), `8.3 one strip, its tab "Statistics / Node editor" (rows ${v.rows}, ${JSON.stringify(v.tabs)})`);
	await shots(page, 'm9-hosted');
	await call(page, 'unsplitDock', 'flow');

	// ---- 9. the unfolded phone (touch) --------------------------------------------------------------
	const U = await h.setupPage(browser, 'unfold', { context: UNFOLD, storage: { ...DOCKED, bottomDockSplits: '[]' } });
	const up = U.page;
	await answerRestore(up);
	await openDocked(up, ['flow', 'explorer']);
	const btn = await center(up, '#dock-split');
	h.check(!!btn, '9.0 premise: the unfolded phone has the split button');
	if (btn) await up.touchscreen.tap(btn.x, btn.y);
	await up.waitForTimeout(700);
	v = await view(up);
	h.check(!!v.flow && !!v.explorer && Math.abs(v.divider - 385) <= 2, `9.1 a tap splits the dock (${v.divider})`);
	const cdp = await up.context().newCDPSession(up);
	const d9 = await center(up, '#dock-split-divider');
	if (d9) {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: d9.x, y: d9.y, id: 1 }] });
		for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: d9.x + i * 15, y: d9.y, id: 1 }] });
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	}
	await up.waitForTimeout(400);
	v = await view(up);
	split = (await read(up, 'bottomDock.dockSplits'))?.[0];
	h.check(split && Math.abs(v.divider - 505) <= 3 && Math.abs(split.r - 505 / 770) < 0.01, `9.2 a TOUCH drag moves the divider (${v.divider}, r ${split?.r?.toFixed(3)})`);
	await shots(up, 'm9-unfolded');

	await h.finish(browser);
});
