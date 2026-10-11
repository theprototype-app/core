// 41 G7 + G24 — the user's 1.32 preview review (desktop):
//   G7 "when dragging tab from grouped floating window I should be able to drag it to docker windows
//      tabs section specific location and when release it should dock automatically in between docked
//      tabs where released (show helper where released window will spawn, dragging floating window
//      should be still possible on all areas same as 'object list' floating window, even on top of
//      drawer, but when hovering on docked tabs it should become a bit transparent and show helper)"
//   G24 the Image editor can be a bottom-dock tab too (the 40-image Q2 answer).
//
//   1  a lone floating window dragged over the docked tab strip: caret between the tabs, the strip
//      outlined, the window at 0.6 opacity; released, it docks AT that index (not at the end)
//   2  dragged over the dock's BODY / the right drawer it keeps floating and stays under the cursor
//      the whole way (it used to clamp above the bottom chrome, then lag behind the cursor)
//   3  the bottom screen-edge band still docks (at the end)
//   4  a tab torn out of a floating group, dropped on the strip, docks at the caret
//   5  a whole group dragged by its strip onto the dock strip docks every dockable member there
//   6  G24: "+ Image editor" docks it (empty state); an Explorer image opens in the docked tab;
//      undock / Dock round-trips; the mode survives a reload
//
// Real mouse throughout. Run: APP_URL=http://localhost:5404/ npm run e2e -- dock-strip-drop
const h = require('./helpers.cjs');

const DESK = { viewport: { width: 1440, height: 900 } };

const S = (page, fn, arg) => page.evaluate(fn, arg);
const read = (page, path) =>
	S(page, (path) => {
		const [mod, name] = path.split('.');
		let v;
		window.__stores[mod][name].subscribe((x) => (v = x))();
		return v;
	}, path);
const order = async (page) => (await read(page, 'bottomDock.dockTabs')).map((t) => t.key);

/** the centre of the gap between docked tab slots `i-1` and `i` (i = slots.length → after the last) */
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
		return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) };
	}, sel);

async function openDock(page) {
	await S(page, async () => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		s.explorerClose.set(false);
		await new Promise((r) => setTimeout(r, 600));
		s.bottomDock.activateDock('flow');
	});
	await page.waitForTimeout(800);
}

h.run(async () => {
	const browser = await h.launch();
	const P = await h.setupPage(browser, 'D', {
		context: DESK,
		storage: { flowDocked: 'true', explorerDocked: 'true', flowCodeDocked: 'false', animationDocked: 'false', uvDocked: 'false', dockTabOrder: '["flow","explorer"]' }
	});
	const page = P.page;
	await openDock(page);
	h.check(JSON.stringify(await order(page)) === '["flow","explorer"]', `premise: the dock holds Node editor | Explorer (${JSON.stringify(await order(page))})`);

	// ---- 1. a lone window onto the strip, between the two tabs -----------------------------
	await S(page, () => window.__stores.flowCodeClose.set(false));
	await page.waitForTimeout(800);
	let from = await headerPoint(page, '#flow-code-window');
	let gap = await gapPoint(page, 1);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(gap.x, gap.y - 120, { steps: 8 });
	await page.mouse.move(gap.x, gap.y, { steps: 8 });
	await page.waitForTimeout(150);
	let fb = await feedback(page, '#flow-code-window');
	await page.screenshot({ path: (process.env.OUT || '/tmp') + '/g7-strip-caret-dark.png' });
	h.check(fb.caret && fb.caretX >= gap.lo && fb.caretX <= gap.hi, `1.1 over the strip a caret marks the slot between the two tabs (caret x ${fb.caretX}, gap ${gap.lo}..${gap.hi})`);
	h.check(fb.ghost && Math.abs(fb.opacity - 0.6) < 0.05, `1.2 ...and the dragged window turns see-through (opacity ${fb.opacity})`);
	h.check(fb.target && !fb.zone, `1.3 ...the strip is outlined as the target (and the old whole-dock zone is not shown) (${JSON.stringify(fb)})`);
	await page.mouse.up();
	await page.waitForTimeout(1200);
	let ord = await order(page);
	h.check(JSON.stringify(ord) === '["flow","flowcode","explorer"]', `1.4 released, it docks AT the caret: ${JSON.stringify(ord)}`);
	h.check((await read(page, 'bottomDock.visibleDockKey')) === 'flowcode', '1.5 ...and is the visible tab');
	fb = await feedback(page, null);
	h.check(!fb.caret && !fb.target && !(await S(page, () => !!document.querySelector('.dock-drag-ghost'))), '1.6 no feedback is left behind after the drop');

	// ---- 2. over the dock body and the drawer: floats, follows the cursor ------------------
	await S(page, () => window.__stores.animationClose.set(false));
	await page.waitForTimeout(800);
	from = await headerPoint(page, '#animation-window');
	const start = await S(page, () => {
		const r = document.getElementById('animation-window').getBoundingClientRect();
		return { left: r.left, top: r.top };
	});
	const gx = from.x - start.left;
	const gy = from.y - start.top;
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	const path = [
		[700, 760],
		[300, 860],
		[1300, 300], // the right drawer column
		[600, 300]
	];
	const lag = [];
	for (const [x, y] of path) {
		await page.mouse.move(x, y, { steps: 10 });
		await page.waitForTimeout(80);
		const r = await S(page, () => {
			const b = document.getElementById('animation-window').getBoundingClientRect();
			return { left: b.left, top: b.top };
		});
		lag.push({ at: [x, y], dx: Math.round(r.left - (x - gx)), dy: Math.round(r.top - (y - gy)) });
	}
	const overDock = lag[0];
	await page.mouse.move(700, 780, { steps: 6 });
	await page.waitForTimeout(80);
	fb = await feedback(page, '#animation-window');
	h.check(!fb.caret && !fb.zone && !fb.ghost, `2.1 over the dock's body there is no dock target (${JSON.stringify(fb)})`);
	await page.screenshot({ path: (process.env.OUT || '/tmp') + '/g7-over-dock-body.png' });
	// released over the dock BESIDE the centred Controls pill (right of it): nothing pulls it up
	await page.mouse.move(1200, 780, { steps: 6 });
	await page.mouse.up();
	await page.waitForTimeout(600);
	h.check(Math.abs(overDock.dx) <= 2 && Math.abs(overDock.dy) <= 2, `2.2 a window can be dragged over the dock and stays under the cursor (${JSON.stringify(overDock)})`);
	h.check(lag.every((l) => Math.abs(l.dx) <= 2 && Math.abs(l.dy) <= 2), `2.3 ...and over the drawer, all the way — no drift after a clamp (${JSON.stringify(lag)})`);
	const rest = await S(page, () => {
		const w = document.getElementById('animation-window');
		const b = w.getBoundingClientRect();
		let p;
		window.__stores.bottomDock.dockOccupants.subscribe((v) => (p = v))();
		return { top: b.top, floating: !w.dataset.docked && !p.animation?.present, dockTop: window.innerHeight - parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bottom-inset')) };
	});
	h.check(rest.floating && rest.top > rest.dockTop, `2.4 released over the dock it stays FLOATING, parked over the dock (top ${Math.round(rest.top)} > dock ${Math.round(rest.dockTop)})`);
	// ...but released where it would sit UNDER the Controls pill, its header comes up above it (24-B3)
	from = await headerPoint(page, '#animation-window');
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(720, 800, { steps: 10 });
	await page.mouse.up();
	await page.waitForTimeout(500);
	const pillRule = await S(page, () => {
		const w = document.getElementById('animation-window').getBoundingClientRect();
		const head = document.querySelector('#animation-window .move-handle').getBoundingClientRect();
		const p = document.getElementById('controls-pill')?.getBoundingClientRect();
		const over = !!p && p.height > 0 && w.left < p.right && w.right > p.left;
		return { over, headBottom: Math.round(head.bottom), pillTop: p ? Math.round(p.top) : null };
	});
	h.check(!pillRule.over || pillRule.headBottom <= pillRule.pillTop, `2.5 a release that would leave the header under the Controls pill nudges it above (${JSON.stringify(pillRule)})`);

	// ---- 3. the bottom edge band still docks, at the end -----------------------------------
	from = await headerPoint(page, '#animation-window');
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(500, 892, { steps: 10 });
	await page.waitForTimeout(100);
	fb = await feedback(page, '#animation-window');
	h.check(fb.zone && !fb.caret, `3.1 the bottom screen edge shows the dock zone (${JSON.stringify(fb)})`);
	await page.mouse.up();
	await page.waitForTimeout(1200);
	ord = await order(page);
	h.check(ord[ord.length - 1] === 'animation', `3.2 dropped on the edge band it docks at the end (${JSON.stringify(ord)})`);

	// ---- 4. a tab torn out of a group, onto the strip ---------------------------------------
	await S(page, () => window.__stores.bottomDock.armDockMode('animation', false));
	await page.waitForTimeout(900);
	await S(page, async () => {
		const s = window.__stores;
		s.objectListClose.set(false);
		await new Promise((r) => setTimeout(r, 700));
		s.windowTabs.mergeWindows('objects', 'animation');
		await new Promise((r) => setTimeout(r, 300));
		let g;
		s.windowTabs.tabGroups.subscribe((v) => (g = v))();
		s.windowTabs.moveGroup(g[0].id, 500 - g[0].rect.left, 150 - g[0].rect.top);
	});
	await page.waitForTimeout(400);
	const tab = await S(page, () => {
		const t = [...document.querySelectorAll('.tab-strip .ts-tab')].find((b) => b.textContent.trim() === 'Animation');
		const r = t.getBoundingClientRect();
		return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
	});
	gap = await gapPoint(page, 0);
	await page.mouse.move(tab.x, tab.y);
	await page.mouse.down();
	await page.mouse.move(tab.x, tab.y + 80, { steps: 6 });
	await page.mouse.move(gap.x, gap.y, { steps: 12 });
	await page.waitForTimeout(150);
	fb = await feedback(page, '#animation-window');
	h.check(fb.caret && fb.ghost && fb.caretX <= gap.hi, `4.1 a torn-out tab over the strip shows the caret before the first tab, see-through (${JSON.stringify(fb)})`);
	await page.mouse.up();
	await page.waitForTimeout(1200);
	ord = await order(page);
	h.check(ord[0] === 'animation', `4.2 released, it docks first (${JSON.stringify(ord)})`);
	h.check((await read(page, 'windowTabs.tabGroups')).length === 0, '4.3 the group it left dissolved (Objects floats alone)');

	// ---- 5. a whole group by its strip ---------------------------------------------------------
	await S(page, async () => {
		const s = window.__stores;
		s.bottomDock.armDockMode('flowcode', false);
		await new Promise((r) => setTimeout(r, 400));
		s.uvEditorClose.set(false);
		await new Promise((r) => setTimeout(r, 900));
		s.windowTabs.mergeWindows('flowcode', 'uv');
		await new Promise((r) => setTimeout(r, 300));
		let g;
		s.windowTabs.tabGroups.subscribe((v) => (g = v))();
		const grp = g.find((x) => x.members.includes('uv'));
		s.windowTabs.moveGroup(grp.id, 300 - grp.rect.left, 120 - grp.rect.top);
		s.windowTabs.activateTab(grp.id, 'uv');
	});
	await page.waitForTimeout(500);
	const sp = await S(page, () => {
		const strip = [...document.querySelectorAll('.tab-strip')].find((s) => s.textContent.includes('UV'));
		const r = strip.getBoundingClientRect();
		return { x: Math.round(r.right - 70), y: Math.round(r.top + 20), ok: !document.elementFromPoint(r.right - 70, r.top + 20)?.closest('button') };
	});
	const before = await order(page);
	gap = await gapPoint(page, before.length);
	await page.mouse.move(sp.x, sp.y);
	await page.mouse.down();
	await page.mouse.move(gap.x, gap.y, { steps: 14 });
	await page.waitForTimeout(150);
	fb = await feedback(page, null);
	await page.mouse.up();
	await page.waitForTimeout(1600);
	ord = await order(page);
	h.check(sp.ok && fb.caret, `5.1 a group dragged by its strip shows the caret on the dock strip (${JSON.stringify(fb)})`);
	h.check(
		JSON.stringify(ord.slice(-2)) === '["flowcode","uv"]' && ord.length === before.length + 2,
		`5.2 released, both of its tabs dock there, in tab order (${JSON.stringify(before)} -> ${JSON.stringify(ord)})`
	);
	h.check((await read(page, 'bottomDock.visibleDockKey')) === 'uv', '5.3 ...showing the tab that was active in the group');

	// ---- 6. G24 — the Image editor in the dock ---------------------------------------------------
	await S(page, () => {
		const b = document.getElementById('dock-add-view');
		b.click();
	});
	await page.waitForTimeout(400);
	const rows = await S(page, () => [...document.querySelectorAll('[role="menuitem"]')].map((r) => r.textContent.trim()));
	h.check(rows.some((r) => /Image editor/.test(r)), `6.1 the dock "+" lists the Image editor (${JSON.stringify(rows)})`);
	await S(page, () => [...document.querySelectorAll('[role="menuitem"]')].find((r) => /Image editor/.test(r.textContent))?.click());
	await page.waitForTimeout(1200);
	let ie = await S(page, () => ({
		dock: !!document.querySelector('#image-editor-dock:not(.hidden)'),
		win: !!document.getElementById('image-editor-window'),
		empty: !!document.getElementById('image-editor-empty'),
		tab: !!document.querySelector('[data-dock-tab="imageEditor"]')
	}));
	h.check(ie.dock && !ie.win && ie.tab && ie.empty, `6.2 "+ Image editor" opens it as a dock tab, saying how to pick an image (${JSON.stringify(ie)})`);
	await page.screenshot({ path: (process.env.OUT || '/tmp') + '/g24-image-editor-docked-empty-dark.png' });
	const img = await S(page, async () => {
		const c = document.createElement('canvas');
		c.width = 64;
		c.height = 48;
		const ctx = c.getContext('2d');
		ctx.fillStyle = '#c03030';
		ctx.fillRect(0, 0, 32, 48);
		ctx.fillStyle = '#3030c0';
		ctx.fillRect(32, 0, 32, 48);
		const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
		await window.__stores.explorer.loadExplorer?.();
		const rec = await window.__stores.explorer.addItemFromBytes(await blob.arrayBuffer(), 'g24.png', null, { imported: true });
		window.__stores.bottomDock.activateDock('flow');
		await new Promise((r) => setTimeout(r, 300));
		window.__stores.imageEditor.openImageEditor(rec.id);
		return rec.id;
	});
	await page.waitForTimeout(1500);
	ie = await S(page, () => ({
		visible: (() => {
			let v;
			window.__stores.bottomDock.visibleDockKey.subscribe((x) => (v = x))();
			return v;
		})(),
		size: document.querySelector('#image-editor-dock #image-editor-size')?.textContent ?? ''
	}));
	h.check(!!img && ie.visible === 'imageEditor' && /64 × 48/.test(ie.size), `6.3 opening an Explorer image brings the docked editor forward with it (${JSON.stringify(ie)})`);
	await page.screenshot({ path: (process.env.OUT || '/tmp') + '/g24-image-editor-docked-dark.png' });
	await S(page, () => document.getElementById('dock-undock').click());
	await page.waitForTimeout(1000);
	ie = await S(page, () => ({ dock: !!document.getElementById('image-editor-dock'), win: !!document.getElementById('image-editor-window'), size: document.querySelector('#image-editor-window #image-editor-size')?.textContent ?? '' }));
	h.check(!ie.dock && ie.win && /64 × 48/.test(ie.size), `6.4 undock: it floats again, same image (${JSON.stringify(ie)})`);
	await S(page, () => document.getElementById('image-editor-dock-btn').click());
	await page.waitForTimeout(1000);
	ie = await S(page, () => ({ dock: !!document.querySelector('#image-editor-dock:not(.hidden)'), win: !!document.getElementById('image-editor-window') }));
	h.check(ie.dock && !ie.win, `6.5 its header's Dock button docks it again (${JSON.stringify(ie)})`);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 30000 });
	await page.waitForTimeout(2500);
	await S(page, async (id) => {
		await window.__stores.explorer.loadExplorer?.();
		window.__stores.imageEditor.openImageEditor(id);
	}, img);
	await page.waitForTimeout(1500);
	ie = await S(page, () => ({ dock: !!document.querySelector('#image-editor-dock:not(.hidden)'), win: !!document.getElementById('image-editor-window') }));
	h.check(ie.dock && !ie.win, `6.6 the docked mode survives a reload (${JSON.stringify(ie)})`);
	// light theme shot of the strip feedback for the record
	await S(page, () => { document.documentElement.dataset.theme = 'light'; document.documentElement.classList.remove('dark'); });
	await page.waitForTimeout(300);
	await page.screenshot({ path: (process.env.OUT || '/tmp') + '/g24-image-editor-docked-light.png' });

	h.check((h.pageErrors(P) || []).length === 0, `no page errors (${(h.pageErrors(P) || []).join(' | ')})`);
	await h.finish(browser);
});
