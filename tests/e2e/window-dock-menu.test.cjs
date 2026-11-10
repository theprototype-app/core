// 44 M2 + M3 — EVERY FLOATING WINDOW DOCKS BY DRAG (ungrouped too, on touch too) AND HAS A HEADER MENU.
// The user (preview-1-34): "right click or holding header of window or tab should give an option to
// dock/undock or put to left or right sidevar … Object list and any other floating window should be possible
// to drag to dock, currently impossible (obnly if grouped), but i do not want to change its header" and
// "floating window should be possible to add to a sidebar and move to dock for unfolded phone".
// Decision: the menu = Dock to bottom, Move to left sidebar, Move to right sidebar, Float (undock),
// Group with…, Bring to front, Reset size, Close; the header keeps its look (no new buttons).
//
//   1  desktop: Objects dragged by its BODY onto the dock's tab strip shows the caret and docks there
//   2  desktop: Statistics dragged by its body to the left edge lights the left column (the one drop model,
//      `#dock-zone`) and becomes a left sidebar tab
//   3  desktop: right-click on Objects' header opens the menu with the nine rows in order (78 PL39: + Size); Dock to bottom,
//      Move to right sidebar, Group with… ▸ Chat, (the group tab) Float (undock), Bring to front,
//      Reset size and Close each do what they say; a right-click on the header SEARCH keeps its own menu
//   4  the header looks as it did: the same children, no new button
//   5  N6 unfolded, REAL touch: Objects touch-dragged by its body onto the dock strip docks; Statistics
//      touch-dragged to the right edge becomes a right sidebar tab; a long press on a header opens the menu
// Counterfactual (base = origin/feat/43-int, 1.34.0): no menu on a header right-click / long press, a body
// drag moves nothing, and on touch nothing docks to a side or the dock.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const SHOTS = process.env.SHOTS || '';
const THEME = process.env.THEME || 'dark';
const DESK = { viewport: { width: 1440, height: 900 } };
const UNFOLDED = { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 };
const STORAGE = {
	theme: THEME,
	mobileUndockAllowed: 'true',
	flowDocked: 'true',
	dockTabOrder: '["flow"]',
	flowDockHeight: '300',
	objectListRect: JSON.stringify({ left: 420, top: 150, width: 300, height: 300 })
};
const ROWS = ['Dock to bottom', 'Move to left sidebar', 'Move to right sidebar', 'Float (undock)', 'Group with…', 'Bring to front', 'Reset size', 'Size', 'Close'];

const S = (page, fn, arg) => page.evaluate(fn, arg);
async function shot(page, name) {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(SHOTS, `m3-${name}-${THEME}.png`) }).catch(() => {});
}
const read = (page, p) =>
	S(page, (p) => {
		const [m, n] = p.split('.');
		let v;
		(n ? window.__stores[m][n] : window.__stores[m]).subscribe((x) => (v = x))();
		return v;
	}, p);
const order = async (page) => (await read(page, 'bottomDock.dockTabs')).map((t) => t.key);
const sideTabs = (page, side) => S(page, (side) => [...document.querySelectorAll(`#sidebar-strip-${side} [data-sidebar-tab]`)].map((t) => t.getAttribute('data-sidebar-tab')), side);
const win = (page, sel) =>
	S(page, (sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), shown: r.width > 0 && getComputedStyle(el).display !== 'none' && !el.classList.contains('hidden'), docked: el.dataset.docked ?? null, host: el.getAttribute('data-pd-host') };
	}, sel);
/** a body point the M1 predicate accepts (base: the same rule written out) */
const bodyPoint = (page, sel, fy = 0.25, clear = 0) =>
	S(page, ({ sel, fy, clear }) => {
		const node = document.querySelector(sel);
		const r = node.getBoundingClientRect();
		const head = node.querySelector('.move-handle')?.getBoundingClientRect();
		const pred =
			window.__stores.windowBodyDrag?.isBodyDragStart ??
			((el, n) => n.contains(el) && !el.closest('button, input, select, textarea, label, a[href], .move-handle, canvas, [draggable="true"]') && !(el.closest('[role]') !== n && n.contains(el.closest('[role]'))));
		const ty = r.top + r.height * fy;
		const cands = [];
		for (let y = (head?.bottom ?? r.top) + 2; y < r.bottom - 4; y += 3) for (let x = r.left + 3; x < r.right - 4; x += 3) cands.push([x, y]);
		cands.sort((a, b) => Math.hypot(a[0] - (r.left + r.width / 2), a[1] - ty) - Math.hypot(b[0] - (r.left + r.width / 2), b[1] - ty));
		for (const [x, y] of cands) {
			const el = document.elementFromPoint(x, y);
			// `clear` (touch): touch adjustment snaps a finger to a control within a fingertip
			const ring = clear ? [0, 90, 180, 270, 45, 135, 225, 315].map((a) => document.elementFromPoint(x + clear * Math.cos((a * Math.PI) / 180), y + clear * Math.sin((a * Math.PI) / 180))) : [];
			if (el && pred(el, node) && ring.every((e) => e && pred(e, node))) return { x: Math.round(x), y: Math.round(y) };
		}
		return null;
	}, { sel, fy, clear });
/** the header's grab point: its title, which is chrome, not a control */
const headerPoint = (page, sel) =>
	S(page, (sel) => {
		const t = document.querySelector(sel + ' .move-handle .wc-label, ' + sel + ' .move-handle .wc-title') ?? document.querySelector(sel + ' .move-handle');
		const r = t.getBoundingClientRect();
		return { x: Math.round(r.left + Math.min(16, r.width / 2)), y: Math.round(r.top + r.height / 2) };
	}, sel);
const stripPoint = (page) =>
	S(page, () => {
		const row = [...document.querySelectorAll('.dt-row')].find((r) => r.getBoundingClientRect().width > 0);
		const tabs = [...row.querySelectorAll('[data-dock-tab]')].map((t) => (t.closest('.tp-dtab-group') ?? t).getBoundingClientRect());
		const r = row.getBoundingClientRect();
		return { x: Math.round(tabs[tabs.length - 1].right + 30), y: Math.round(r.top + r.height / 2) };
	});
// the open context menu: the first VISIBLE [role=menu] with rows (a submenu follows its root in the DOM;
// other surfaces keep hidden menus of their own)
const menuRows = (page) => S(page, () => [...document.querySelectorAll('[role=menu]')].filter((m) => m.getClientRects().length && m.querySelector('[role=menuitem]')).slice(0, 1).flatMap((m) => [...m.querySelectorAll(':scope [role=menuitem]')].map((r) => r.textContent.replace(/\s*▸\s*$/, '').trim())));
const rowState = (page, label) =>
	S(page, (label) => {
		const r = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((x) => x.textContent.trim().startsWith(label));
		return r ? { disabled: r.classList.contains('ctx-disabled'), title: r.getAttribute('title') } : null;
	}, label);
async function pick(page, label) {
	const row = page.locator('[role=menu] [role=menuitem]', { hasText: label }).first();
	if (!(await row.count())) return false;
	await row.click();
	await page.waitForTimeout(800);
	return true;
}
async function rightClick(page, pt) {
	await page.mouse.click(pt.x, pt.y, { button: 'right' });
	await page.waitForTimeout(350);
}
async function mouseDrag(page, from, to, { hold = false } = {}) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2 - 40, { steps: 10 });
	await page.mouse.move(to.x, to.y, { steps: 10 });
	await page.waitForTimeout(150);
	if (!hold) {
		await page.mouse.up();
		await page.waitForTimeout(900);
	}
}
// an undocked window returns where it was last dropped (here: on the strip, at the screen's left edge,
// under the toolbar) — park it in open space so a header point is the header's
const parkObjects = (page, left = 420, top = 150) =>
	S(page, async ({ left, top }) => {
		const n = document.querySelector('#object-list');
		n.style.left = left + 'px';
		n.style.top = top + 'px';
		await new Promise((r) => setTimeout(r, 200));
	}, { left, top });
const undockObjects = async (page, left, top) => {
	await S(page, async () => {
		window.__stores.bottomDock.armDockMode('objects', false);
		await new Promise((r) => setTimeout(r, 900));
	});
	await parkObjects(page, left, top);
};
/** does a press at pt land on the window's header chrome? */
const onHeader = (page, sel, pt) => S(page, ({ sel, pt }) => window.__stores.windowGrip.isHeaderDrag(document.elementFromPoint(pt.x, pt.y)) && !!document.elementFromPoint(pt.x, pt.y)?.closest(sel), { sel, pt });

async function openDock(page) {
	await S(page, async () => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		await new Promise((r) => setTimeout(r, 600));
		s.bottomDock.activateDock('flow');
		for (let i = 0; i < 3; i++) s.addObjects.spawnAtPoint('/create Box 1 1 1', [i * 2 - 2, 0.5, -4]);
		s.objectListClose.set(false);
	});
	await page.waitForTimeout(1200);
}

h.run(async () => {
	const browser = await h.launch();

	// ======================= desktop =======================
	const D = await h.setupPage(browser, 'D', { context: DESK, storage: STORAGE });
	const page = D.page;
	await openDock(page);
	h.check(JSON.stringify(await order(page)) === '["flow"]', `premise: the dock holds the Node editor (${JSON.stringify(await order(page))})`);
	let ob = await win(page, '#object-list');
	h.check(ob?.shown && !ob.host, `premise: Objects floats (${JSON.stringify(ob)})`);
	const headHtml0 = await S(page, () => [...document.querySelectorAll('#object-list .move-handle *')].map((e) => e.tagName + '.' + (typeof e.className === 'string' ? e.className : '')).join('|'));
	await shot(page, '01-desktop-start');

	// ---- 1. body drag onto the strip ----
	const from = await bodyPoint(page, '#object-list');
	const to = await stripPoint(page);
	await mouseDrag(page, from, to, { hold: true });
	const fb = await S(page, () => ({ caret: !!document.getElementById('dock-strip-caret'), ghost: document.querySelector('#object-list')?.classList.contains('dock-drag-ghost') }));
	h.check(fb.caret && fb.ghost, `1.1 Objects dragged by its BODY over the strip: caret + see-through window (${JSON.stringify(fb)})`);
	await shot(page, '02-body-drag-over-strip');
	await page.mouse.up();
	await page.waitForTimeout(1000);
	h.check((await order(page)).includes('objects') && (await win(page, '#object-list')).host === 'shown', `1.2 released, it is a dock tab (${JSON.stringify(await order(page))})`);
	await undockObjects(page);

	// ---- 2. Statistics by its body to the left edge ----
	await S(page, () => window.__stores.sceneBudget.statsOpen.set(true));
	await page.waitForTimeout(700);
	const sFrom = await bodyPoint(page, '#stats-window', 0.7);
	await mouseDrag(page, sFrom, { x: 14, y: 380 }, { hold: true });
	const zone = await S(page, () => {
		const z = document.getElementById('dock-zone');
		return z ? { side: z.dataset.side, kind: z.dataset.dropTarget, text: z.textContent } : null;
	});
	h.check(zone?.side === 'left' && zone.kind === 'side', `2.1 the left column lights up under a body drag (${JSON.stringify(zone)})`);
	await page.mouse.up();
	await page.waitForTimeout(800);
	let st = await win(page, '#stats-window');
	h.check(st?.docked === 'left' && (await sideTabs(page, 'left')).includes('stats'), `2.2 Statistics is a left sidebar tab (${JSON.stringify(st)})`);
	await S(page, () => window.__stores.docking.undock('stats', 900, 300));
	await page.waitForTimeout(600);

	// ---- 3. the header menu ----
	ob = await win(page, '#object-list');
	h.check(ob?.shown && !ob.docked && !ob.host, `premise: Objects floats again (${JSON.stringify(ob)})`);
	const hp0 = await headerPoint(page, '#object-list');
	h.check(await onHeader(page, '#object-list', hp0), `premise: the header point is Objects' header (${JSON.stringify(hp0)})`);
	await rightClick(page, hp0);
	const rows = await menuRows(page);
	h.check(JSON.stringify(rows) === JSON.stringify(ROWS), `3.1 right-click on the header: the nine rows in order (78 PL39: + Size) (${JSON.stringify({ rows, open: await S(page, () => window.__stores.windowMenu?.windowMenuOpen?.() ?? 'no menu module') })})`);
	const fl = await rowState(page, 'Float (undock)');
	h.check(fl?.disabled, `3.2 Float (undock) is disabled for a window already floating, saying why (${JSON.stringify(fl)})`);
	await shot(page, '03-header-menu');
	h.check(await pick(page, 'Dock to bottom'), '3.3 Dock to bottom picked');
	h.check((await order(page)).includes('objects') && (await read(page, 'bottomDock.visibleDockKey')) === 'objects', `3.4 ...Objects is the dock's front tab (${JSON.stringify(await order(page))})`);
	await undockObjects(page);

	await rightClick(page, await headerPoint(page, '#object-list'));
	await pick(page, 'Move to right sidebar');
	ob = await win(page, '#object-list');
	h.check(ob?.docked === 'right' && (await sideTabs(page, 'right')).includes('objects'), `3.5 Move to right sidebar: Objects is a right sidebar tab (${JSON.stringify(ob)})`);
	await S(page, () => window.__stores.docking.undock('objects', 560, 220));
	await page.waitForTimeout(700);

	// Group with… ▸ Chat (a floating tab-able window; Statistics is not one, the flow family opens IN the
	// dock here, and a closed one — the AI assistant — is not offered)
	await S(page, () => window.__stores.chatHidden.set(''));
	await page.waitForTimeout(900);
	await rightClick(page, await headerPoint(page, '#object-list'));
	await page.locator('[role=menu] [role=menuitem]', { hasText: 'Group with' }).first().hover();
	await page.waitForTimeout(400);
	// a submenu renders INSIDE its row (ContextMenuItems), not as a menu of its own
	const sub = await S(page, () => {
		const row = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((r) => r.textContent.trim().startsWith('Group with'));
		return row ? [...row.querySelectorAll('[role=menuitem]')].map((r) => r.textContent.trim()) : [];
	});
	const cands = await S(page, () => window.__stores.windowTabs.groupCandidates?.('objects')?.map((c) => c.title));
	h.check(sub.includes('Chat') && !sub.includes('AI assistant') && !sub.includes('Objects'), `3.6 Group with… lists the other OPEN tab-able windows (${JSON.stringify({ sub, cands })})`);
	const hit = await S(page, () => {
		const row = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((r) => r.textContent.trim().startsWith('Group with'));
		const leaf = [...(row?.querySelectorAll('[role=menuitem]') ?? [])].find((r) => r.textContent.trim() === 'Chat');
		const r = leaf?.getBoundingClientRect();
		if (!r) return null;
		const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
		return { box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], top: !!at && leaf.contains(at) };
	});
	h.check(hit?.top, `3.6b ...its Chat row is on top where it is drawn, a mouse can press it (${JSON.stringify(hit)})`);
	// the submenu sits inside its row, which Playwright's actionability wait never settles on: press the
	// leaf itself (its own click handler runs the row, as a real click does)
	await S(page, () => {
		const row = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((r) => r.textContent.trim().startsWith('Group with'));
		[...(row?.querySelectorAll('[role=menuitem]') ?? [])].find((r) => r.textContent.trim() === 'Chat')?.click();
	});
	await page.waitForTimeout(800);
	const groups = await read(page, 'windowTabs.tabGroups');
	h.check(groups.length === 1 && groups[0].members.includes('objects') && groups[0].members.includes('chat'), `3.7 ...Objects joined Chat as a tab (${JSON.stringify(groups.map((g) => g.members))})`);

	// the group TAB has the same menu; Float (undock) ungroups it
	const tab = await S(page, () => {
		const t = [...document.querySelectorAll('.tab-strip .ts-tab')].find((b) => b.textContent.trim() === 'Objects');
		const r = t.getBoundingClientRect();
		return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
	});
	await rightClick(page, tab);
	const tabRows = await menuRows(page);
	h.check(JSON.stringify(tabRows) === JSON.stringify(ROWS), `3.8 a group tab's right-click opens the same menu (${JSON.stringify(tabRows)})`);
	h.check(!(await rowState(page, 'Float (undock)'))?.disabled, '3.9 ...where Float (undock) is live');
	await pick(page, 'Float (undock)');
	h.check((await read(page, 'windowTabs.tabGroups')).length === 0, '3.10 Float (undock) takes Objects out of the group (a group of one dissolves)');
	await S(page, () => window.__stores.chatHidden.set('hidden'));
	await page.waitForTimeout(500);
	await parkObjects(page);
	ob = await win(page, '#object-list');
	h.check(ob?.shown && (await onHeader(page, '#object-list', await headerPoint(page, '#object-list'))), `premise: Objects floats on its own again, its header free (${JSON.stringify(ob)})`);

	// Bring to front
	await S(page, () => window.__stores.windowFocus?.raiseWindowNode?.(document.querySelector('#stats-window')));
	await page.waitForTimeout(200);
	await rightClick(page, await headerPoint(page, '#object-list'));
	await pick(page, 'Bring to front');
	const z = await S(page, () => [parseInt(getComputedStyle(document.querySelector('#object-list')).zIndex), parseInt(getComputedStyle(document.querySelector('#stats-window')).zIndex)]);
	h.check(z[0] > z[1], `3.11 Bring to front raises Objects above Statistics (${JSON.stringify(z)})`);

	// Reset size
	await S(page, () => {
		const n = document.querySelector('#object-list');
		n.style.width = '520px';
		n.style.height = '480px';
	});
	await rightClick(page, await headerPoint(page, '#object-list'));
	await pick(page, 'Reset size');
	ob = await win(page, '#object-list');
	h.check(ob.w < 400 && ob.h < 400, `3.12 Reset size puts Objects back to its default size (${ob.w}x${ob.h})`);
	await rightClick(page, await headerPoint(page, '#stats-window'));
	h.check(!(await rowState(page, 'Reset size'))?.disabled, '3.13 ...Statistics (a resizable dragWindow) offers it too');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);

	// a header CONTROL keeps its own menu
	const search = await S(page, () => {
		const r = document.querySelector('#object-search')?.getBoundingClientRect();
		return r && r.width ? { x: Math.round(r.x + 20), y: Math.round(r.y + r.height / 2) } : null;
	});
	if (search) {
		await rightClick(page, search);
		const r2 = await menuRows(page);
		h.check(!r2.includes('Dock to bottom'), `3.14 a right-click on the header's search field is the field's, not the window's (${JSON.stringify(r2)})`);
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
	}

	// Close
	await rightClick(page, await headerPoint(page, '#object-list'));
	await pick(page, 'Close');
	h.check((await read(page, 'objectListClose')) === true, '3.15 Close closes Objects through its own path');

	// ---- 4. the header looks as it did ----
	await S(page, () => window.__stores.objectListClose.set(false));
	await page.waitForTimeout(600);
	const headHtml1 = await S(page, () => [...document.querySelectorAll('#object-list .move-handle *')].map((e) => e.tagName + '.' + (typeof e.className === 'string' ? e.className : '')).join('|'));
	h.check(headHtml1 === headHtml0, '4.1 the Objects header has exactly the children it had (no new button)');
	await D.ctx.close();

	// ======================= N6 unfolded, real touch =======================
	const T = await h.setupPage(browser, 'T', { context: UNFOLDED, storage: STORAGE });
	const tp = T.page;
	await openDock(tp);
	const cdp = await tp.context().newCDPSession(tp);
	const tdrag = async (from, to, steps = 18) => {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
		await tp.waitForTimeout(40);
		for (let i = 1; i <= steps; i++) {
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }] });
			await tp.waitForTimeout(25);
		}
		await tp.waitForTimeout(150);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await tp.waitForTimeout(1000);
	};
	const tob = await win(tp, '#object-list');
	h.check(tob?.shown && !tob.host, `premise (unfolded): Objects floats and the dock is open (${JSON.stringify({ tob, order: await order(tp) })})`);
	await tdrag(await bodyPoint(tp, '#object-list', 0.25, 16), await stripPoint(tp));
	h.check((await order(tp)).includes('objects'), `5.1 touch: Objects dragged by its body onto the strip docks (${JSON.stringify(await order(tp))})`);
	await shot(tp, '04-unfolded-objects-docked');
	await undockObjects(tp);

	await S(tp, () => window.__stores.sceneBudget.statsOpen.set(true));
	await tp.waitForTimeout(700);
	const ts = await win(tp, '#stats-window');
	await tdrag(await headerPoint(tp, '#stats-window'), { x: 762, y: 360 });
	st = await win(tp, '#stats-window');
	h.check(st?.docked === 'right' && (await sideTabs(tp, 'right')).includes('stats'), `5.2 touch: Statistics dragged by its header to the right edge is a right sidebar tab (${JSON.stringify({ ts, st })})`);
	await shot(tp, '05-unfolded-stats-sidebar');

	// 5.1 left Objects a dock tab, whose header is the dock's (no floating-window menu): float it again
	await undockObjects(tp, 300, 150);
	const hp = await headerPoint(tp, '#object-list');
	h.check(await onHeader(tp, '#object-list', hp), `premise: Objects floats again, its header free (${JSON.stringify({ hp, ob: await win(tp, '#object-list') })})`);
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [hp] });
	await tp.waitForTimeout(750);
	const longRows = await menuRows(tp);
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await tp.waitForTimeout(400);
	h.check(JSON.stringify(longRows) === JSON.stringify(ROWS), `5.3 touch: a long press on the header opens the menu (${JSON.stringify(longRows)})`);
	h.check((await menuRows(tp)).length === ROWS.length, '5.4 ...and it stays open after the finger lifts');
	await shot(tp, '06-unfolded-long-press-menu');
	await tp.locator('[role=menu] [role=menuitem]', { hasText: 'Move to left sidebar' }).first().tap();
	await tp.waitForTimeout(800);
	h.check((await win(tp, '#object-list'))?.docked === 'left', '5.5 touch: Move to left sidebar from the menu docks it left');

	await h.finish(browser);
});
