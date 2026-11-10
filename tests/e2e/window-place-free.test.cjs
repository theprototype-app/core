// 45 N7 — the user's preview-1-35 review:
//   'now I cannot drag somewhere floating window if I hover on sidebar or dock, allow to do this (pick per
//    best practice what is the best approach, maybe I can hold Ctrl when move window to allow to place on
//    top of sidebar/dock without merging it there), and I like that by default it merges'
// Decision (Visual Studio / JetBrains): a floating window dragged over a sidebar or the dock still DOCKS by
// default (the target lights up); holding Ctrl (Cmd on a Mac) suppresses every dock target — sidebar
// column, dock tab strip, bottom band, another window's header — so the window is placed floating where
// it is dropped; pressing / releasing the key mid-drag flips the target live; the target says "Hold Ctrl
// to place without docking". Touch: no modifier — the window menu's "Float" (documented).
//
//   1  the Explorer's header over the open right column: "Add as tab" + the hint line; Ctrl down with the
//      pointer STILL → the target goes, the chip says it is placing without docking; Ctrl up → back; Ctrl
//      down + release → it floats OVER the column (not a sidebar tab)
//   2  Ctrl held from the first move, over the docked tab strip: no caret, no target; dropped → floating
//      over the dock (not a dock tab)
//   3  Cmd (Meta) over the bottom band: the same
//   4  the default is unchanged: no key, over the column → it joins the sidebar (the control)
//   5  header merge: Ctrl held over another window's header → no merge highlight, no group; no key → they
//      merge (the control)
//   6  a dragged GROUP (its strip) over the column lights it; Ctrl pressed mid-drag → no target, the
//      group stays floating
//
// Counterfactual (origin/feat/44-int): §1-§3, §5, §6 red (Ctrl changes nothing: the window docks / merges).
// Run: APP_URL=https://theprototype.app:5452/ npm run e2e -- window-place-free
const h = require('./helpers.cjs');
const OUT = process.env.OUT || '/tmp';

const DESK = { viewport: { width: 1440, height: 900 } };
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

/** the drag feedback on screen right now */
const feedback = (page) =>
	S(page, () => {
		const z = document.getElementById('dock-zone') ?? document.getElementById('bottom-dock-zone');
		return {
			zone: z ? (z.querySelector('.sb-drop-label') ?? z).textContent : null,
			hint: z?.querySelector('.sb-drop-hint')?.textContent ?? null,
			caret: !!document.getElementById('dock-strip-caret'),
			chip: document.getElementById('place-free-hint')?.textContent ?? null,
			merge: !!document.querySelector('.merge-target')
		};
	});
const headOf = (page, sel) =>
	S(page, (sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + 14), y: Math.round(r.top + r.height / 2) };
	}, sel);
const rectOf = (page, sel) =>
	S(page, (sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), docked: el.getAttribute('data-docked'), host: el.getAttribute('data-pd-host') };
	}, sel);
/** press at `from`, travel to `to` in steps, and stay there (the button still down) */
async function dragTo(page, from, to, steps = 14) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
	await page.waitForTimeout(200);
}
const rightTabs = async (page) => ((await read(page, 'sidebars.sidebarTabs')) ?? { right: [] }).right;
const dockKeys = async (page) => ((await read(page, 'bottomDock.dockTabs')) ?? []).map((t) => t.key);

h.run(async () => {
	const browser = await h.launch();
	const D = await h.setupPage(browser, 'desk', {
		context: DESK,
		storage: { flowDocked: 'true', explorerDocked: 'false', statsDocked: 'false', chatDocked: 'false', 'sidebar:inspectorSide': 'right' }
	});
	const page = D.page;
	await S(page, () => {
		const s = window.__stores;
		s.inspectorKind.set('scene');
		s.inspectorClose.set(false);
		s.flowGraphClose.set(false);
		s.explorerClose.set(false);
	});
	await page.waitForTimeout(1500);
	h.check((await rightTabs(page)).join() === 'scene' && (await dockKeys(page)).includes('flow'), `0 premise: Configure Scene in the right sidebar, the Node editor docked (${await rightTabs(page)} / ${await dockKeys(page)})`);
	h.check(!!(await rectOf(page, '#explorer-window')), '0 premise: the Explorer floats');

	// ---- 1. over the right column: the hint, the live toggle, the free drop -------------------------------
	let head = await headOf(page, '#explorer-window .move-handle');
	const col = { x: 1440 - 160, y: 420 };
	await dragTo(page, head, col);
	let f = await feedback(page);
	h.check(f.zone === 'Add as tab' && /Hold (Ctrl|Cmd) to place without docking/.test(f.hint ?? ''), `1.1 over the column: "Add as tab" and the hint line (${JSON.stringify(f)})`);
	await page.screenshot({ path: OUT + '/n7-over-column-hint.png' });
	await page.keyboard.down('Control');
	await page.waitForTimeout(250);
	f = await feedback(page);
	h.check(f.zone === null && !f.caret && /without docking/i.test(f.chip ?? ''), `1.2 Ctrl pressed with the pointer still: the target goes, the chip says so (${JSON.stringify(f)})`);
	await page.screenshot({ path: OUT + '/n7-ctrl-held-column.png' });
	await page.keyboard.up('Control');
	await page.waitForTimeout(250);
	f = await feedback(page);
	h.check(f.zone === 'Add as tab' && f.chip === null, `1.3 Ctrl released: the target is back (${JSON.stringify(f)})`);
	await page.keyboard.down('Control');
	await page.waitForTimeout(150);
	await page.mouse.up();
	await page.keyboard.up('Control');
	await page.waitForTimeout(1000);
	let r = await rectOf(page, '#explorer-window');
	f = await feedback(page);
	h.check(!(await rightTabs(page)).includes('explorer') && !!r && !r.docked, `1.4 dropped with Ctrl: the Explorer is NOT a sidebar tab, it floats (${await rightTabs(page)}, ${JSON.stringify(r)})`);
	h.check(!!r && r.right > 1440 - 320 + 40, `1.5 ...over the column, where it was dropped (${JSON.stringify(r)})`);
	h.check(f.zone === null && f.chip === null && !f.caret, `1.6 no feedback is left behind (${JSON.stringify(f)})`);

	// ---- 2. Ctrl from the first move, over the docked tab strip ----------------------------------------
	const tab = await S(page, () => {
		const t = [...document.querySelectorAll('[data-dock-tab]')].find((x) => x.getBoundingClientRect().width > 0);
		const b = t.getBoundingClientRect();
		return { x: Math.round(b.right + 30), y: Math.round(b.top + b.height / 2) };
	});
	head = await headOf(page, '#explorer-window .move-handle');
	await page.keyboard.down('Control');
	await dragTo(page, head, tab);
	f = await feedback(page);
	h.check(!f.caret && f.zone === null && /without docking/i.test(f.chip ?? ''), `2.1 Ctrl held over the dock's tab strip: no caret, no target (${JSON.stringify(f)})`);
	await page.screenshot({ path: OUT + '/n7-ctrl-held-strip.png' });
	await page.mouse.up();
	await page.keyboard.up('Control');
	await page.waitForTimeout(1000);
	r = await rectOf(page, '#explorer-window');
	const dockTop = await S(page, () => {
		const el = [...document.querySelectorAll('.tp-dock-panel')].find((d) => d.getBoundingClientRect().height > 0 && !d.classList.contains('hidden'));
		return el ? Math.round(el.getBoundingClientRect().top) : 900;
	});
	h.check(!(await dockKeys(page)).includes('explorer') && !!r && !r.docked, `2.2 dropped: not a dock tab, still a floating window (${await dockKeys(page)})`);
	h.check(!!r && r.bottom > dockTop + 20, `2.3 ...lying over the dock (window bottom ${r?.bottom}, dock top ${dockTop})`);

	// ---- 3. Cmd (Meta) over the bottom band ------------------------------------------------------------
	head = await headOf(page, '#explorer-window .move-handle');
	await page.keyboard.down('Meta');
	await dragTo(page, head, { x: 700, y: 895 });
	f = await feedback(page);
	h.check(f.zone === null && !f.caret, `3.1 Cmd held at the bottom edge band: no "Move to dock" (${JSON.stringify(f)})`);
	await page.mouse.up();
	await page.keyboard.up('Meta');
	await page.waitForTimeout(1000);
	h.check(!(await dockKeys(page)).includes('explorer') && !!(await rectOf(page, '#explorer-window')), `3.2 dropped: still floating (${await dockKeys(page)})`);

	// ---- 4. the default is unchanged: no key, over the column → a sidebar tab -----------------------------
	await S(page, () => window.__stores.objectActions?.deselectObject?.());
	head = await headOf(page, '#explorer-window .move-handle');
	// park it mid-screen first (it may sit at the bottom edge)
	await dragTo(page, head, { x: 500, y: 200 });
	await page.mouse.up();
	await page.waitForTimeout(500);
	head = await headOf(page, '#explorer-window .move-handle');
	await dragTo(page, head, col);
	f = await feedback(page);
	h.check(f.zone === 'Add as tab' && f.chip === null, `4.1 no key: the column lights up (${JSON.stringify(f)})`);
	await page.mouse.up();
	await page.waitForTimeout(1200);
	h.check((await rightTabs(page)).includes('explorer'), `4.2 ...and the drop docks it as a sidebar tab (the default is kept) (${await rightTabs(page)})`);

	// ---- 5. header merge -------------------------------------------------------------------------------
	await S(page, () => {
		const s = window.__stores;
		s.aiAssistantHidden.set('');
		s.chatHidden.set('');
	});
	await page.waitForTimeout(1200);
	// the AI assistant out of the way, mid-left; Chat dragged onto its header (both tabbable windows)
	head = await headOf(page, '#ai-assistant-window .move-handle');
	h.check(!!head, '5.0 premise: the AI assistant floats');
	await dragTo(page, head, { x: 300, y: 160 });
	await page.mouse.up();
	await page.waitForTimeout(500);
	const statsHead = await headOf(page, '#ai-assistant-window .move-handle');
	const chatHead = await headOf(page, '#chat-window .move-handle');
	h.check(!!chatHead, '5.0 premise: Chat floats');
	await page.keyboard.down('Control');
	await dragTo(page, chatHead, { x: statsHead.x + 60, y: statsHead.y });
	f = await feedback(page);
	h.check(!f.merge, `5.1 Ctrl held over the AI assistant's header: no merge highlight (${JSON.stringify(f)})`);
	await page.mouse.up();
	await page.keyboard.up('Control');
	await page.waitForTimeout(800);
	h.check(((await read(page, 'windowTabs.tabGroups')) ?? []).length === 0, `5.2 dropped with Ctrl: no tab group (${JSON.stringify(await read(page, 'windowTabs.tabGroups'))})`);
	// (Chat now lies over the AI assistant's header: move it aside, then aim again)
	await dragTo(page, await headOf(page, '#chat-window .move-handle'), { x: 760, y: 320 });
	await page.mouse.up();
	await page.waitForTimeout(500);
	const chatHead2 = await headOf(page, '#chat-window .move-handle');
	await dragTo(page, chatHead2, { x: statsHead.x + 60, y: statsHead.y });
	f = await feedback(page);
	h.check(f.merge, `5.3 no key: the AI assistant's header lights up (${JSON.stringify(f)})`);
	await page.mouse.up();
	await page.waitForTimeout(800);
	const groups = (await read(page, 'windowTabs.tabGroups')) ?? [];
	h.check(groups.length === 1, `5.4 ...and the two merge into a group (the default is kept) (${groups.length})`);

	// ---- 6. a dragged GROUP over the column, Ctrl held ---------------------------------------------------
	const strip = await S(page, () => {
		const s = document.querySelector('.tab-strip');
		if (!s) return null;
		const r = s.getBoundingClientRect();
		const y = Math.round(r.top + r.height / 2);
		// the strip's own background (a press on a tab or a button is not the group's grip)
		for (let x = Math.round(r.right) - 4; x > r.left; x -= 4) if (document.elementFromPoint(x, y) === s) return { x, y };
		return null;
	});
	h.check(!!strip, '6.0 premise: the group has its strip, with a free spot to grab');
	const before = (await rightTabs(page)).join();
	await dragTo(page, strip, { x: 1440 - 100, y: 520 });
	f = await feedback(page);
	h.check(f.zone === 'Add as tab' && /without docking/.test(f.hint ?? ''), `6.1 premise: the group's strip over the column lights it, with the hint (${JSON.stringify(f)})`);
	await page.keyboard.down('Control');
	await page.waitForTimeout(250);
	f = await feedback(page);
	h.check(f.zone === null && /without docking/i.test(f.chip ?? ''), `6.2 Ctrl pressed mid-drag: no target, the chip (${JSON.stringify(f)})`);
	await page.mouse.up();
	await page.keyboard.up('Control');
	await page.waitForTimeout(1000);
	h.check((await rightTabs(page)).join() === before && ((await read(page, 'windowTabs.tabGroups')) ?? []).length === 1, `6.3 dropped: the group still floats, the column unchanged (${await rightTabs(page)})`);

	await h.finish(browser);
});
