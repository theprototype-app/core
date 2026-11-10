// 42 I6 (b) — the user's preview-1-32c review (desktop):
//   "... but I should be able to put 'object list' also to dock (also since I want to move those floating
//    windows around I think docking should be suggested when dragged exactly to tab, this also would allow
//    to choose position where to place this in dock and it might be useful to make floating window semi
//    transparent and highlight tabs to user knows it will be stacked there if he release the window)"
//   Decision: ALL floating windows dock by dropping on the tab strip with 41 G7's caret + 0.6 opacity —
//   G7's code generalised (FLOAT_DOCKABLE / canDockHere), not forked. The windows with no docked layout of
//   their own (Objects, Statistics, Live profiler, Chat — with the AI assistant as its tab) are HOSTED by the dock frame.
//
//   1  the Objects window dragged by its header over the strip: caret between the two tabs, strip outlined,
//      window at 0.6 opacity; released, it docks AT that index and fills the dock body
//   2  another tab in front hides it (mounted, not closed); its tab brings it back with its tree
//   3  its header no longer drags it while docked (a dock tab moves by its tab)
//   4  its tab dragged off the strip floats it again where it was; the tab menu offers Undock too
//   5  Statistics dropped on the 44px bottom edge docks at the end of the strip
//   6  the dock's "+" lists the hosted windows (no Live profiler since showhide-v8); "Chat" docks the open floating chat
//   7  the docked mode is remembered: closed and reopened (the O key), and across a reload, Objects
//      comes back as a dock tab
//
// Counterfactual: on origin/feat/41-int the Objects window has no dock target (no caret, no ghost, nothing
// docks) and the "+" has no Objects/Statistics/Chat rows. Real mouse throughout.
// Run: APP_URL=https://localhost:5424/ npm run e2e -- dock-hosted-windows
const h = require('./helpers.cjs');
// THEME=light re-runs the same paths for the light-theme evidence shots
const THEME = process.env.THEME || 'dark';

const DESK = { viewport: { width: 1440, height: 900 } };
const S = (page, fn, arg) => page.evaluate(fn, arg);
const read = (page, path) =>
	S(page, (path) => {
		const [mod, name] = path.split('.');
		let v;
		(name ? window.__stores[mod][name] : window.__stores[mod]).subscribe((x) => (v = x))();
		return v;
	}, path);
const order = async (page) => (await read(page, 'bottomDock.dockTabs')).map((t) => t.key);

const gapPoint = (page, i) =>
	S(page, (i) => {
		const row = [...document.querySelectorAll('.dt-row')].find((r) => r.getBoundingClientRect().width > 0);
		const slots = [...row.querySelectorAll('[data-dock-tab]')].map((t) => (t.closest('.tp-dtab-group') ?? t).getBoundingClientRect());
		const y = Math.round(row.getBoundingClientRect().top + 12);
		if (i >= slots.length) return { x: Math.round(slots[slots.length - 1].right + 20), y, lo: slots[slots.length - 1].right - 2, hi: 99999 };
		const lo = i === 0 ? slots[0].left - 30 : slots[i - 1].right - 2;
		const hi = slots[i].left + 2;
		return { x: Math.round(i === 0 ? slots[0].left + 4 : (slots[i - 1].right + slots[i].left) / 2), y, lo, hi };
	}, i);
const feedback = (page, sel) =>
	S(page, (sel) => {
		const caret = document.getElementById('dock-strip-caret');
		const c = caret?.getBoundingClientRect();
		const win = sel ? document.querySelector(sel) : null;
		return {
			caret: !!caret,
			caretX: c ? c.left + c.width / 2 : null,
			ghost: win ? win.classList.contains('dock-drag-ghost') : null,
			opacity: win ? parseFloat(getComputedStyle(win).opacity) : null,
			target: !!document.querySelector('.dt-row.dock-drop-target'),
			zone: !!document.getElementById('bottom-dock-zone')
		};
	}, sel);
const headerPoint = (page, sel) =>
	S(page, (sel) => {
		const el = document.querySelector(sel + ' .move-handle');
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + 14), y: Math.round(r.top + r.height / 2) };
	}, sel);
const hostState = (page, sel) =>
	S(page, (sel) => {
		const el = document.querySelector(sel);
		if (!el) return { exists: false };
		const r = el.getBoundingClientRect();
		const frame = document.getElementById('phone-dock');
		const f = frame?.getBoundingClientRect();
		return {
			exists: true,
			host: el.getAttribute('data-pd-host'),
			visible: r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none',
			left: Math.round(r.left),
			width: Math.round(r.width),
			top: Math.round(r.top),
			bottom: Math.round(r.bottom),
			frameTop: f ? Math.round(f.top) : null,
			frameShown: !!frame && !frame.classList.contains('hidden'),
			vw: innerWidth,
			vh: innerHeight
		};
	}, sel);
/** drag from a point to another with the real mouse; `hold` = stop before releasing */
async function drag(page, from, to, { steps = 10, hold = false } = {}) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2 - 60, { steps });
	await page.mouse.move(to.x, to.y, { steps });
	await page.waitForTimeout(150);
	if (!hold) {
		await page.mouse.up();
		await page.waitForTimeout(900);
	}
}

async function openDock(page) {
	await S(page, async () => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		s.explorerClose.set(false);
		await new Promise((r) => setTimeout(r, 600));
		s.bottomDock.activateDock('flow');
	});
	await page.waitForTimeout(900);
}

h.run(async () => {
	const browser = await h.launch();
	const P = await h.setupPage(browser, 'D', {
		context: DESK,
		storage: { flowDocked: 'true', explorerDocked: 'true', dockTabOrder: '["flow","explorer"]', flowDockHeight: '320', theme: THEME }
	});
	const page = P.page;
	const out = process.env.OUT || '/tmp';
	await openDock(page);
	h.check(JSON.stringify(await order(page)) === '["flow","explorer"]', `premise: the dock holds Node editor | Explorer (${JSON.stringify(await order(page))})`);

	// ---- 1. Objects onto the strip, between the two tabs ---------------------------------------
	await S(page, () => window.__stores.objectListClose.set(false));
	await page.waitForTimeout(900);
	const floatRect = await hostState(page, '#object-list');
	h.check(floatRect.visible && !floatRect.host, `1.0 premise: the Objects window is open and floating (${JSON.stringify(floatRect)})`);
	let gap = await gapPoint(page, 1);
	await drag(page, await headerPoint(page, '#object-list'), gap, { hold: true });
	let fb = await feedback(page, '#object-list');
	await page.screenshot({ path: out + '/i6-objects-strip-caret-' + THEME + '.png' });
	h.check(fb.caret && fb.caretX >= gap.lo && fb.caretX <= gap.hi, `1.1 over the strip a caret marks the slot between the two tabs (caret ${fb.caretX}, gap ${gap.lo}..${gap.hi})`);
	h.check(fb.ghost && Math.abs(fb.opacity - 0.6) < 0.05, `1.2 ...the Objects window turns see-through (opacity ${fb.opacity})`);
	h.check(fb.target && !fb.zone, `1.3 ...and the strip is outlined as the target (${JSON.stringify(fb)})`);
	await page.mouse.up();
	await page.waitForTimeout(1200);
	h.check(JSON.stringify(await order(page)) === '["flow","objects","explorer"]', `1.4 released, it docks AT the caret: ${JSON.stringify(await order(page))}`);
	h.check((await read(page, 'bottomDock.visibleDockKey')) === 'objects', '1.5 ...and is the tab in front');
	let st = await hostState(page, '#object-list');
	await page.screenshot({ path: out + '/i6-objects-docked-' + THEME + '.png' });
	h.check(st.host === 'shown' && st.visible && st.left === 0 && st.width === st.vw && st.bottom === st.vh && st.top > st.frameTop, `1.6 the Objects list fills the dock body, full width to the bottom edge (${JSON.stringify(st)})`);
	h.check(!(await S(page, () => !!document.querySelector('.dock-drag-ghost') || !!document.getElementById('dock-strip-caret'))), '1.7 no drag feedback is left behind');
	const rows = await S(page, () => document.querySelectorAll('#object-list [role="treeitem"], #object-list .obj-row, #object-list [data-uuid]').length);
	h.check((await S(page, () => !!document.querySelector('#object-list #object-search, #object-list .obj-filters'))), `1.8 its own chrome (search / filter chips) is there inside the dock (rows ${rows})`);
	// showhide-v8 §5 (owner: "when docked its layout right side glitches a bit as its not full width"): the tree had
	// Tailwind's `container`, which caps max-width per breakpoint (1280 px at xl), so on this 1440 px screen the rows and
	// the selection highlight stopped 160 px short of the dock's right edge
	const treeReach = () =>
		S(page, () => {
			const host = document.getElementById('object-list').getBoundingClientRect();
			const tree = document.getElementById('object-tree')?.getBoundingClientRect();
			const scroller = document.querySelector('#object-list .obj-scroller')?.getBoundingClientRect();
			return { host: Math.round(host.right), tree: tree ? Math.round(tree.right) : null, scroller: scroller ? Math.round(scroller.right) : null };
		});
	const reach = await treeReach();
	const fills = (r) => r.tree !== null && r.scroller !== null && r.tree >= r.scroller - 16 && r.scroller >= r.host - 2;
	h.check(fills(reach), `1.9 the tree runs to the dock's right edge (less a scrollbar) (${JSON.stringify(reach)})`);
	await S(page, () => document.getElementById('object-tree').classList.add('container'));
	h.check(!fills(await treeReach()), '1.9b (counterfactual) the old `container` cap is caught at this width');
	await S(page, () => document.getElementById('object-tree').classList.remove('container'));

	// ---- 2. another tab in front hides it (mounted), its tab brings it back ----------------------
	await page.locator('[data-dock-tab="flow"]:visible').first().click();
	await page.waitForTimeout(500);
	st = await hostState(page, '#object-list');
	h.check(st.exists && st.host === 'hidden' && !st.visible, `2.1 the Node editor in front: the Objects list is hidden, not closed (${JSON.stringify({ host: st.host, visible: st.visible })})`);
	h.check((await read(page, 'objectListClose')) === false, '2.2 ...and still open');
	await page.locator('[data-dock-tab="objects"]:visible').first().click();
	await page.waitForTimeout(500);
	st = await hostState(page, '#object-list');
	h.check(st.host === 'shown' && st.visible, '2.3 its tab brings it back');

	// ---- 3. the header does not drag a docked window ------------------------------------------
	const before = await hostState(page, '#object-list');
	await drag(page, await headerPoint(page, '#object-list'), { x: 700, y: 300 });
	st = await hostState(page, '#object-list');
	h.check(st.host === 'shown' && st.top === before.top && st.left === 0, `3.1 dragging its header leaves it docked where it is (${before.top} -> ${st.top})`);
	h.check(JSON.stringify(await order(page)) === '["flow","objects","explorer"]', '3.2 ...and the strip unchanged');

	// ---- 4. drag the tab off the strip: floats again; the tab menu offers Undock -----------------
	await page.locator('[data-dock-tab="objects"]:visible').first().click({ button: 'right' });
	await page.waitForTimeout(300);
	const menu = await S(page, () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((e) => e.textContent.trim()));
	h.check(menu.some((t) => /Undock/.test(t)), `4.1 the Objects tab's menu offers "Undock into a floating window" (${JSON.stringify(menu)})`);
	await page.keyboard.press('Escape');
	await page.mouse.click(700, 200);
	await page.waitForTimeout(300);
	const tab = await S(page, () => {
		const r = [...document.querySelectorAll('[data-dock-tab="objects"]')].map((e) => e.getBoundingClientRect()).find((b) => b.width > 0);
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	});
	await drag(page, tab, { x: 700, y: 250 });
	st = await hostState(page, '#object-list');
	h.check(!st.host && st.visible && st.width < 600, `4.2 dragged off the strip it floats again as its own window (${JSON.stringify({ host: st.host, w: st.width })})`);
	const stripTop = await S(page, () => Math.round([...document.querySelectorAll('.dt-row')].map((r) => r.getBoundingClientRect()).find((b) => b.width > 0)?.top ?? innerHeight));
	h.check(st.bottom <= stripTop && Math.abs(st.left + 100 - 700) <= 4, `4.2b ...clear of the dock (bottom ${st.bottom} <= strip ${stripTop}), under the pointer it was pulled to (left ${st.left})`);
	h.check(!(await order(page)).includes('objects') && (await S(page, () => localStorage.getItem('objectListDocked'))) === 'false', `4.3 ...out of the strip, remembered floating (${JSON.stringify(await order(page))})`);

	// ---- 5. Statistics on the bottom edge band: docks at the end ---------------------------------
	await S(page, () => window.__stores.sceneBudget.statsOpen.set(true));
	await page.waitForTimeout(900);
	await drag(page, await headerPoint(page, '#stats-window'), { x: 500, y: 892 }, { hold: true });
	fb = await feedback(page, '#stats-window');
	h.check(fb.zone && !fb.caret, `5.1 the bottom screen edge shows the dock zone for Statistics (${JSON.stringify(fb)})`);
	await page.mouse.up();
	await page.waitForTimeout(1200);
	let ord = await order(page);
	st = await hostState(page, '#stats-window');
	h.check(ord[ord.length - 1] === 'stats' && st.host === 'shown' && st.width === st.vw, `5.2 Statistics docks at the end and fills the dock (${JSON.stringify(ord)}, ${JSON.stringify({ host: st.host, w: st.width })})`);
	await page.screenshot({ path: out + '/i6-stats-docked-' + THEME + '.png' });

	// ---- 6. the "+" lists the hosted windows; Chat docks from it -------------------------------
	await S(page, () => window.__stores.chatHidden.set(''));
	await page.waitForTimeout(700);
	// the visible strip's "+" (every docked panel draws a strip; only the one in front is visible)
	await page.locator('#dock-add-view:visible').first().click();
	await page.waitForTimeout(300);
	const rowsPlus = await S(page, () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
	await page.screenshot({ path: out + '/i6-dock-plus-hosted-' + THEME + '.png' });
	// uir-chat: Chat and the AI assistant are one window (Session | Assistant tabs), so the "+" lists Chat once
	h.check(['Objects', 'Statistics', 'Chat'].every((t) => rowsPlus.some((r) => r.startsWith(t))) && !rowsPlus.some((r) => r.startsWith('AI assistant')) && !rowsPlus.some((r) => r.startsWith('Live profiler')), `6.1 the dock's "+" lists Objects, Statistics and Chat (one row; no AI assistant, no Live profiler: showhide-v8 made it a row of the Profiler) (${JSON.stringify(rowsPlus)})`);
	// 44 M5: ONE registry rule — a window open anywhere is FOCUSED where it is by every "+" (the user's
	// '+ ▸ Statistics opened a second copy in the dock'); docking a floating window is its drag / its menu
	h.check(rowsPlus.some((r) => /^Chat.*Floating/.test(r)), '6.2 ...the open floating Chat reads "Floating"');
	await page.click('[role="menu"] [role="menuitem"]:has-text("Chat")');
	await page.waitForTimeout(1200);
	st = await hostState(page, '#chat-window');
	// showhide-v8 (owner 2026-11-09, supersedes 44 M5's focus-where-it-is): "+" MOVES an open window here — one copy, docked
	h.check(
		(await order(page)).includes('chat') && st.host === 'shown' && (await page.locator('#chat-window').count()) === 1,
		`6.3 "Chat" moves the floating chat into the dock (one copy) (${JSON.stringify({ host: st.host, order: await order(page) })})`
	);
	// ...and docked the 41 G7 way instead (the Undock seam's twin: the dock arm), so section 7 reads as before
	await S(page, () => window.__stores.bottomDock.armDockMode('chat', true));
	await page.waitForTimeout(1200);
	st = await hostState(page, '#chat-window');
	h.check((await order(page)).includes('chat') && st.host === 'shown' && st.width === st.vw, `6.4 docked through the dock arm, Chat shows in the dock (${JSON.stringify({ host: st.host, w: st.width })})`);

	// ---- 7. remembered: reopen and reload -------------------------------------------------------
	await S(page, () => window.__stores.dockMenu.setDockViewShown('objects', true));
	await page.waitForTimeout(1200);
	h.check((await read(page, 'bottomDock.visibleDockKey')) === 'objects' && (await hostState(page, '#object-list')).host === 'shown', '7.1 setup: Objects docked again (the "+" row path)');
	await S(page, () => window.__stores.objectListClose.set(true));
	await page.waitForTimeout(600);
	h.check(!(await order(page)).includes('objects'), '7.2 closed, its tab leaves the strip');
	await page.mouse.click(700, 200);
	await page.keyboard.press('o');
	await page.waitForTimeout(1200);
	st = await hostState(page, '#object-list');
	h.check(st.host === 'shown' && (await read(page, 'bottomDock.visibleDockKey')) === 'objects', `7.3 the O key reopens it IN THE DOCK (${JSON.stringify({ host: st.host })})`);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(4000);
	await page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 30000 });
	await openDock(page);
	await S(page, () => window.__stores.objectListClose.set(false));
	await page.waitForTimeout(1500);
	st = await hostState(page, '#object-list');
	h.check(st.host === 'shown' && (await order(page)).includes('objects'), `7.4 after a reload the Objects list opens as a dock tab (${JSON.stringify({ host: st.host, order: await order(page) })})`);

	await h.finish(browser);
});
