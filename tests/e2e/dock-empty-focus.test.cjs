// 44 M5 + M6 — the user's preview-1-34 review (desktop, and the unfolded phone for the empty dock):
//   '"T" opens a docked window toolbar, when I drag from there "Node Editor", and no toolbars left and
//    then click "T" again it opens "Node Editor" again in docked state, but "T" only should show empty
//    docked window view with "+" in tab'
//   'bug: when "Statistics" moved to sidebar as a tab and then I open "T" and press "+" and press
//    "Statistics" it opens it as a docked tab, but existing sidebar'
//   'When "Statistics"/"Chat"/"Shader Editor"/"Objects"/"Live Profiler"/"AI assistant" docked and
//    sidebar "Full height is on" it does not shrink docked window pane'
// Brief: ONE registry rule — a window open anywhere (sidebar, dock, floating) is FOCUSED there by every
// "+" menu; only a closed one opens.
//
//   1  T with the only docked view dragged out (a real tab drag): an EMPTY dock — its frame, a strip
//      with only "+" and the dock chrome, the helper line, its height reserved; T again closes it
//   2  the empty strip and body take a drop: a floating window dropped on the empty body docks
//   3  "+" on the empty dock: the floating Node editor's row is checked "Floating" and RAISES it (it
//      stays floating); a closed view (Timeline) opens docked and ends the empty state
//   4  Statistics in the RIGHT sidebar behind Configure Scene: "+" ▸ Statistics brings its SIDEBAR tab
//      to the front — no second copy, nothing docked; the Explorer in the LEFT sidebar the same
//   5  a floating Chat: "+" ▸ Chat raises it where it is (not docked)
//   6  M6: right sidebar Full height + Statistics docked in the bottom dock — the hosted window stops at
//      the column's edge like the dock frame (and the Shader editor, an editor tab, as the control)
//   7  unfolded phone (touch): T opens the empty dock, "+" opens its menu
//
// Counterfactual: on origin/feat/43-int T docks the Node editor again (1 red), "+" ▸ Statistics docks a
// second copy into the dock (4 red), "+" ▸ Chat / the Node editor DOCKS the floating window (3/5 red)
// and the hosted Statistics runs under the full-height column (6 red).
// Run: APP_URL=https://theprototype.app:5444/ npm run e2e -- dock-empty-focus
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

/** the dock as the user sees it */
const dockView = (page) =>
	S(page, () => {
		const frame = document.querySelector('#phone-dock');
		const fr = frame?.getBoundingClientRect();
		const row = [...document.querySelectorAll('.dt-row')].find((r) => r.getBoundingClientRect().width > 0);
		const plus = [...document.querySelectorAll('#dock-add-view')].find((b) => b.getBoundingClientRect().width > 0);
		return {
			empty: frame?.getAttribute('data-dock-empty') === 'true' && !frame.classList.contains('hidden'),
			frameH: fr ? Math.round(fr.height) : 0,
			helper: document.querySelector('#dock-empty')?.textContent.trim() ?? '',
			tabs: row ? row.querySelectorAll('[data-dock-tab]').length : -1,
			plus: !!plus,
			undock: [...document.querySelectorAll('#dock-undock')].some((b) => b.getBoundingClientRect().width > 0),
			flowDocked: !!document.querySelector('#flow-list:not(.hidden)'),
			flowFloating: !!document.querySelector('#flow-window'),
			inset: getComputedStyle(document.documentElement).getPropertyValue('--bottom-inset').trim()
		};
	});

async function pressT(page) {
	await S(page, () => document.activeElement instanceof HTMLElement && document.activeElement.blur());
	await page.mouse.move(700, 300);
	await page.keyboard.press('t');
	await page.waitForTimeout(700);
}

/** a REAL click on the visible "+" of the dock, then its rows */
async function plusRows(page, tap = false) {
	const at = await S(page, () => {
		const b = [...document.querySelectorAll('#dock-add-view')].find((x) => x.getBoundingClientRect().width > 0);
		if (!b) return null;
		const r = b.getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	});
	if (!at) return null;
	if (tap) await page.touchscreen.tap(at.x, at.y);
	else await page.mouse.click(at.x, at.y);
	await page.waitForTimeout(450);
	return menuRows(page);
}
const menuRows = (page) =>
	S(page, () =>
		[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => ({
			title: el.querySelector('.flex-1')?.textContent.trim() ?? el.textContent.trim(),
			hint: el.querySelector('.ctx-hint')?.textContent.trim() ?? '',
			checked: el.classList.contains('ctx-checked')
		}))
	);
async function clickRow(page, title, mods = []) {
	const pt = await S(page, (title) => {
		const el = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((r) => (r.querySelector('.flex-1')?.textContent.trim() ?? '') === title);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) };
	}, title);
	if (!pt) return false;
	for (const m of mods) await page.keyboard.down(m);
	await page.mouse.click(pt.x, pt.y);
	for (const m of mods) await page.keyboard.up(m);
	await page.waitForTimeout(900);
	return true;
}
const closeMenu = async (page) => {
	if (await S(page, () => !!document.querySelector('[role="menu"]'))) {
		await page.keyboard.press('Escape');
		await page.waitForTimeout(250);
	}
};
/** the top visible floating window's id */
const topWindow = (page) =>
	S(page, () => {
		const wins = [...document.querySelectorAll('.tp-window')].filter((w) => {
			const r = w.getBoundingClientRect();
			return r.width > 0 && getComputedStyle(w).display !== 'none' && !w.dataset.docked && !w.hasAttribute('data-pd-host');
		});
		wins.sort((a, b) => (parseInt(getComputedStyle(a).zIndex) || 0) - (parseInt(getComputedStyle(b).zIndex) || 0));
		return wins.length ? wins[wins.length - 1].id : null;
	});

h.run(async () => {
	const browser = await h.launch();
	const D = await h.setupPage(browser, 'desk', { context: DESK, storage: { flowDocked: 'true', explorerDocked: 'false', timelineDocked: 'true', statsDocked: 'false', chatDocked: 'false' } });
	const page = D.page;

	// ---- 1. T after the last docked view was dragged out ---------------------------------------
	await S(page, async () => {
		window.__stores.flowGraphClose.set(false);
		await new Promise((r) => setTimeout(r, 600));
		window.__stores.bottomDock.activateDock('flow');
	});
	await page.waitForTimeout(900);
	let v = await dockView(page);
	h.check(v.flowDocked && v.tabs === 1, `1.0 premise: the Node editor is the dock's only tab (${JSON.stringify(v)})`);
	// a REAL drag of its tab out of the strip, up into the viewport
	const tab = await S(page, () => {
		const t = [...document.querySelectorAll('[data-dock-tab="flow"]')].find((x) => x.getBoundingClientRect().width > 0);
		const r = t.getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	});
	await page.mouse.move(tab.x, tab.y);
	await page.mouse.down();
	for (let i = 1; i <= 12; i++) await page.mouse.move(tab.x + i * 20, tab.y - i * 30);
	await page.mouse.up();
	await page.waitForTimeout(1200);
	v = await dockView(page);
	h.check(!v.flowDocked && v.flowFloating && v.inset === '0px', `1.1 premise: dragged out, it floats and the dock is gone (${JSON.stringify(v)})`);
	await pressT(page);
	v = await dockView(page);
	h.check(v.empty && !v.flowDocked && v.flowFloating, `1.2 T opens an EMPTY dock — the Node editor stays where it was dragged (${JSON.stringify(v)})`);
	h.check(v.tabs === 0 && v.plus && !v.undock, `1.3 its strip holds only "+" (no tabs, no undock button) (${JSON.stringify(v)})`);
	h.check(/press \+/i.test(v.helper), `1.4 the body says how to fill it ("${v.helper}")`);
	const dockH = await read(page, 'bottomDock.dockHeight');
	h.check(v.inset === dockH + 'px' && Math.abs(v.frameH - dockH) <= 1, `1.5 the empty dock reserves the dock's height (${v.inset}, frame ${v.frameH}, dock ${dockH})`);
	await page.screenshot({ path: OUT + '/m5-empty-dock-dark.png' });
	await S(page, () => {
		document.documentElement.dataset.theme = 'light';
		document.documentElement.classList.remove('dark');
	});
	await page.waitForTimeout(300);
	await page.screenshot({ path: OUT + '/m5-empty-dock-light.png' });
	await S(page, () => {
		document.documentElement.dataset.theme = 'dark';
		document.documentElement.classList.add('dark');
	});
	await pressT(page);
	v = await dockView(page);
	h.check(!v.empty && v.inset === '0px' && v.flowFloating, `1.6 T again closes the empty dock (${JSON.stringify(v)})`);
	await pressT(page);
	v = await dockView(page);
	h.check(v.empty, `1.7 ...and T opens it again (${JSON.stringify(v)})`);

	// ---- 2. a floating window dropped on the empty dock's body docks there -----------------------
	await S(page, () => window.__stores.explorerClose.set(false));
	await page.waitForTimeout(1200);
	const head = await S(page, () => {
		const el = document.querySelector('#explorer-window .move-handle');
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + 14), y: Math.round(r.top + r.height / 2) };
	});
	// (no #dock-empty on a build without the empty dock: aim at the dock's middle, so the counterfactual runs on)
	const body = await S(page, () => {
		const el = document.querySelector('#dock-empty');
		if (!el) return { x: Math.round(innerWidth / 2), y: innerHeight - 160 };
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	});
	await page.mouse.move(head.x, head.y);
	await page.mouse.down();
	const steps = 14;
	for (let i = 1; i <= steps; i++) await page.mouse.move(head.x + ((body.x - head.x) * i) / steps, head.y + ((body.y - head.y) * i) / steps);
	await page.mouse.up();
	await page.waitForTimeout(1300);
	let docked = (await read(page, 'bottomDock.dockTabs')) ?? [];
	v = await dockView(page);
	h.check(docked.map((t) => t.key).join() === 'explorer' && !v.empty, `2.1 the Explorer dropped on the empty dock's body docks (${docked.map((t) => t.key)})`);
	// back to empty for the next part: float it out through its tab menu's Undock
	await S(page, () => window.__stores.bottomDock.armDockMode('explorer', false));
	await page.waitForTimeout(1000);
	await pressT(page);
	v = await dockView(page);
	h.check(v.empty, `2.2 premise: the empty dock again (${JSON.stringify(v)})`);

	// ---- 3. "+" on the empty dock: an open window is focused where it is, a closed one opens ----
	// a second floating window on top of the Node editor, so "raised" is observable
	await S(page, () => window.__stores.explorerClose.set(false));
	await page.waitForTimeout(1200);
	h.check((await topWindow(page)) === 'explorer-window', `3.0 premise: the floating Explorer is on top (${await topWindow(page)})`);
	let rows = await plusRows(page);
	const flowRow = (rows ?? []).find((r) => r.title === 'Node editor');
	h.check(!!flowRow?.checked && flowRow.hint === 'Floating', `3.1 the floating Node editor's row is checked and says where it is (${JSON.stringify(flowRow)})`);
	await clickRow(page, 'Node editor');
	v = await dockView(page);
	h.check(v.flowFloating && !v.flowDocked && v.empty, `3.2 its row does not dock it — it stays floating and the dock stays empty (${JSON.stringify(v)})`);
	h.check((await topWindow(page)) === 'flow-window', `3.3 ...it is brought to the front (${await topWindow(page)})`);

	rows = await plusRows(page);
	const fc = (rows ?? []).find((r) => r.title === 'Timeline');
	h.check(!!fc && !fc.checked && fc.hint === 'Open', `3.4 a closed window's row says Open (${JSON.stringify(fc)})`);
	await clickRow(page, 'Timeline');
	docked = (await read(page, 'bottomDock.dockTabs')) ?? [];
	v = await dockView(page);
	h.check(docked.map((t) => t.key).join() === 'timeline' && !v.empty && v.tabs === 1, `3.5 ...and opens it docked, which ends the empty state (${docked.map((t) => t.key)} ${JSON.stringify(v)})`);
	h.check(!(await read(page, 'bottomDock.dockEmptyOpen')), '3.6 the empty flag cleared itself when a tab arrived');

	// ---- 4. a window in a SIDEBAR: "+" focuses its sidebar tab --------------------------------------
	await S(page, async () => {
		const s = window.__stores;
		s.sceneBudget.statsOpen.set(true);
		await new Promise((r) => setTimeout(r, 700));
		s.dockMenu.moveToSidebar('stats', 'right');
		await new Promise((r) => setTimeout(r, 400));
		// Configure Scene in front of it on the same side
		s.sidebars.inspectorSide.set('right');
		s.inspectorKind.set('scene');
		s.inspectorClose.set(false);
	});
	await page.waitForTimeout(1200);
	let shown = await read(page, 'sidebars.sidebarShown');
	let tabs = await read(page, 'sidebars.sidebarTabs');
	h.check(tabs.right.includes('stats') && tabs.right.includes('inspector') && shown.right === 'inspector', `4.0 premise: Statistics is a right-sidebar tab behind Configure Scene (${JSON.stringify(tabs)} front ${shown.right})`);
	rows = await plusRows(page);
	const st = (rows ?? []).find((r) => r.title === 'Statistics');
	h.check(!!st?.checked && st.hint === 'Right sidebar', `4.1 the Statistics row is checked and names the right sidebar (${JSON.stringify(st)})`);
	await clickRow(page, 'Statistics');
	shown = await read(page, 'sidebars.sidebarShown');
	const hosted = await read(page, 'dockHost.hostedDocked');
	docked = ((await read(page, 'bottomDock.dockTabs')) ?? []).map((t) => t.key);
	const copies = await S(page, () => document.querySelectorAll('#stats-window').length);
	h.check(shown.right === 'stats', `4.2 "+" ▸ Statistics brings its SIDEBAR tab to the front (${shown.right})`);
	h.check(!hosted.stats && !docked.includes('stats') && copies === 1, `4.3 ...and no second copy: not docked, one window (${JSON.stringify({ hosted: hosted.stats, docked, copies })})`);
	await page.screenshot({ path: OUT + '/m5-plus-focuses-sidebar.png' });

	// the same rule for an editor: the Explorer in the LEFT sidebar, Configure Scene… stays right
	await S(page, async () => {
		const s = window.__stores;
		s.explorerClose.set(false);
		await new Promise((r) => setTimeout(r, 900));
		s.dockMenu.moveToSidebar('explorer', 'left');
		await new Promise((r) => setTimeout(r, 400));
		s.objectListClose.set(false);
		await new Promise((r) => setTimeout(r, 500));
		s.dockMenu.moveToSidebar('objects', 'left');
	});
	await page.waitForTimeout(1200);
	shown = await read(page, 'sidebars.sidebarShown');
	tabs = await read(page, 'sidebars.sidebarTabs');
	h.check(tabs.left.includes('explorer') && shown.left === 'objects', `4.4 premise: the Explorer is a left tab behind Objects (${JSON.stringify(tabs.left)} front ${shown.left})`);
	rows = await plusRows(page);
	const ex = (rows ?? []).find((r) => r.title === 'Explorer');
	h.check(!!ex?.checked && ex.hint === 'Left sidebar', `4.5 the Explorer row names the left sidebar (${JSON.stringify(ex)})`);
	await clickRow(page, 'Explorer');
	shown = await read(page, 'sidebars.sidebarShown');
	docked = ((await read(page, 'bottomDock.dockTabs')) ?? []).map((t) => t.key);
	h.check(shown.left === 'explorer' && !docked.includes('explorer'), `4.6 "+" ▸ Explorer focuses its left tab, it stays out of the dock (${shown.left}; dock ${docked})`);

	// ---- 5. a floating window: raised where it floats -----------------------------------------------
	await S(page, () => window.__stores.chatHidden.set(''));
	await page.waitForTimeout(900);
	await S(page, () => window.__stores.aiAssistantHidden.set(''));
	await page.waitForTimeout(900);
	const topBefore = await topWindow(page);
	rows = await plusRows(page);
	const ch = (rows ?? []).find((r) => r.title === 'Chat');
	h.check(!!ch?.checked && ch.hint === 'Floating', `5.0 the floating Chat's row says Floating (${JSON.stringify(ch)}; top ${topBefore})`);
	await clickRow(page, 'Chat');
	const hosted2 = await read(page, 'dockHost.hostedDocked');
	h.check(!hosted2.chat && (await topWindow(page)) === 'chat-window', `5.1 "+" ▸ Chat raises it where it floats, not into the dock (top ${await topWindow(page)}, docked ${hosted2.chat})`);
	await S(page, () => {
		window.__stores.chatHidden.set('hidden');
		window.__stores.aiAssistantHidden.set('hidden');
	});

	// ---- 6. M6: a hosted window beside a FULL-HEIGHT sidebar ----------------------------------------
	await S(page, async () => {
		const s = window.__stores;
		// Statistics out of the right sidebar into the bottom dock (the sidebar tab menu's own path)
		s.docking.undock('stats');
		await new Promise((r) => setTimeout(r, 300));
		s.dockHost.setHostedDocked('stats', true);
		s.sidebars.toggleSidebarFull('right', true);
	});
	await page.waitForTimeout(1400);
	const m6 = await S(page, () => {
		const st = document.querySelector('#stats-window').getBoundingClientRect();
		const fr = document.querySelector('#phone-dock').getBoundingClientRect();
		const col = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sb-dock-right')) || 0;
		return { statsRight: Math.round(st.right), frameRight: Math.round(fr.right), host: document.querySelector('#stats-window').getAttribute('data-pd-host'), w: innerWidth, col };
	});
	h.check(m6.host === 'shown' && m6.col > 0, `6.0 premise: Statistics is the dock tab in front and the right column is pinned full height (${JSON.stringify(m6)})`);
	h.check(Math.abs(m6.statsRight - (m6.w - m6.col)) <= 1 && Math.abs(m6.statsRight - m6.frameRight) <= 1, `6.1 the docked Statistics stops at the full-height column, like the dock frame (${JSON.stringify(m6)})`);
	await page.screenshot({ path: OUT + '/m6-hosted-beside-full-sidebar.png' });
	// ...and every EDITOR's own docked pane (the Shader editor's scoped rule ran under it too)
	const panes = { flow: '#flow-list', timeline: '#timeline-dock', animation: '#animation-dock', uv: '#uv-dock', shader: '#shader-editor', hud: '#hud-dock', explorer: '#explorer-list', profiler: '#profiler-dock', code: '#code-ws-dock' };
	/** @type {Record<string, number>} */
	const rights = {};
	for (const key of Object.keys(panes)) {
		// one at a time: the dock-mode arm is a write-once slot, so the next view must not arm before this one
		// has consumed it (a slow-mounting editor otherwise opens in its remembered floating mode)
		await S(page, async (key) => {
			const s = window.__stores;
			s.bottomDock.armDockMode(key, true);
			s.dockMenu.closeStoreFor(key)?.set(false);
			for (let t = 0; t < 40; t++) {
				let o;
				s.bottomDock.dockOccupants.subscribe((x) => (o = x))();
				if (o?.[key]?.present) break;
				await new Promise((r) => setTimeout(r, 200));
			}
			s.bottomDock.activateDock(key);
		}, key);
		// a heavy editor (the Profiler, the code workspace) can take a few seconds to mount on a loaded box
		for (let t = 0; t < 20; t++) {
			rights[key] = await S(page, (sel) => {
				const el = [...document.querySelectorAll(sel)].find((x) => x.getBoundingClientRect().width > 0 && !x.classList.contains('hidden'));
				return el ? Math.round(el.getBoundingClientRect().right) : -1;
			}, panes[key]);
			if (rights[key] > 0) break;
			await page.waitForTimeout(400);
		}
	}
	const off = Object.entries(rights).filter(([, r]) => Math.abs(r - (m6.w - m6.col)) > 1);
	h.check(!off.length, `6.2 every editor's docked pane stops at the column too (${JSON.stringify(rights)} vs ${m6.w - m6.col})`);
	await S(page, () => window.__stores.sidebars.toggleSidebarFull('right', false));

	// ---- 7. the unfolded phone: T opens the empty dock, "+" opens its menu ---------------------------
	const U = await h.setupPage(browser, 'unfold', { context: UNFOLD, storage: { flowDocked: 'true' } });
	await pressT(U.page);
	const uv = await dockView(U.page);
	h.check(uv.empty && uv.plus && uv.tabs === 0, `7.1 unfolded: T with nothing docked opens the empty dock (${JSON.stringify(uv)})`);
	const urows = await plusRows(U.page, true);
	h.check((urows ?? []).some((r) => r.title === 'Node editor' && r.hint === 'Open'), `7.2 unfolded: a tap on "+" lists the windows (${(urows ?? []).length} rows)`);
	await U.page.screenshot({ path: OUT + '/m5-empty-dock-unfolded.png' });
	await closeMenu(U.page);

	await h.finish(browser);
});
