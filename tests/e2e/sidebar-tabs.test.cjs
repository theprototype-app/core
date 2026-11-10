// 42 I3 — ONE SIDEBAR PER SIDE, panels as its TABS ($lib/sidebars + SidebarStrips.svelte).
//
// The user: "I am not sure I need stack two sidebar windows to side as it does now (if I open one
// sidebar it should close the other one unless dragged) … I want to be able to drag right sidebar
// (be it configure scene or object properties) to the left and stick it there". Decision: one
// column per side, every panel on a side is a tab of it (opening brings its tab forward, no second
// column), a tab dragged to the other half of the screen docks the panel there with a highlight,
// persisted. This suite drives it with a REAL pointer: the edge dock, the tab strip, the drag to
// the other side, a floating window dropped on a column, the resize grip, a reload.
//
// 43: section 11 drags the TAB (J7 — a docked window has no header in a sidebar; J4 — a tab dropped in
// the viewport floats there).
// Counterfactual (base = 1.32.0): the right-docked list is pushed inward as a SECOND COLUMN when the
// Inspector opens (section 2 goes red: two panels on screen), there is no tab strip, no drag.
const h = require('./helpers.cjs');

const VW = 1440;
const VH = 900;

/** rect + visibility of one element */
function probe(page, sel) {
	return page.evaluate((sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const cs = getComputedStyle(el);
		const r = el.getBoundingClientRect();
		return {
			x: Math.round(r.x),
			y: Math.round(r.y),
			w: Math.round(r.width),
			h: Math.round(r.height),
			right: Math.round(r.right),
			bottom: Math.round(r.bottom),
			shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
			docked: el.dataset?.docked ?? null
		};
	}, sel);
}
/** the tabs of a side's strip, in order, and which one is in front */
// showhide-v8 (fork 1): the Inspector is TWO tabs now, Properties ('inspector') and Configure Scene ('scene'), that
// share a side and move together. This suite is about the column model, so `strip` reads them as ONE Inspector
// (`raw` keeps what the strip really shows; section 2 checks the pair once).
function strip(page, side) {
	return page.evaluate((side) => {
		const ins = (k) => (k === 'scene' ? 'inspector' : k);
		const el = document.querySelector('#sidebar-strip-' + side);
		if (!el) return null;
		const tabs = [...el.querySelectorAll('[data-sidebar-tab]')];
		const r = el.getBoundingClientRect();
		return {
			raw: tabs.map((t) => t.getAttribute('data-sidebar-tab')),
			tabs: tabs.map((t) => ins(t.getAttribute('data-sidebar-tab'))).filter((k, i, a) => a.indexOf(k) === i),
			front: ins(tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.getAttribute('data-sidebar-tab') ?? null),
			x: Math.round(r.x),
			y: Math.round(r.y),
			w: Math.round(r.width),
			right: Math.round(r.right)
		};
	}, side);
}
const store = (page, name) => page.evaluate((n) => new Promise((r) => window.__stores[n].subscribe(r)()), name);

/** real-pointer drag from a to b */
async function drag(page, a, b, steps = 14) {
	await page.mouse.move(a[0], a[1]);
	await page.mouse.down();
	await page.mouse.move(b[0], b[1], { steps });
}
/** centre of a strip's tab */
async function tabCentre(page, side, key) {
	const r = await page.evaluate(
		([side, key]) => {
			const t = document.querySelector(`#sidebar-strip-${side} [data-sidebar-tab="${key}"]`);
			const b = t?.getBoundingClientRect();
			return b ? [b.x + b.width / 2, b.y + b.height / 2] : null;
		},
		[side, key]
	);
	return r;
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: VW, height: VH } } });
	const page = A.page;

	// ---------- 1. a window docked to the right edge is the column's first tab ----------
	await page.locator('p[title="Object list (O)"]').click();
	await page.waitForTimeout(400);
	const list0 = await probe(page, '#object-list');
	// grab the header by its TITLE end (its search field is not a drag handle)
	await drag(page, [list0.x + 24, list0.y + 14], [VW - 15, 400]);
	await page.mouse.up();
	await page.waitForTimeout(400);
	let list = await probe(page, '#object-list');
	let right = await strip(page, 'right');
	h.check(list?.docked === 'right' && Math.abs(list.right - VW) < 3 && list.shown, `the list docks to the right edge (${JSON.stringify(list)})`);
	h.check(right && right.tabs.join() === 'objects' && right.front === 'objects', `the right sidebar has one tab, the list (${JSON.stringify(right)})`);
	h.check(right && Math.abs(right.right - VW) < 3 && Math.abs(right.w - list.w) < 3, 'the tab header spans the column, over the panel');
	h.check(list && right && Math.abs(list.y - (right.y + 30)) < 3, `the panel sits right under its tab header (${list?.y} vs ${right?.y}+30)`);

	// ---------- 2. opening Configure Scene on the occupied side: ONE column, the new tab in front ----------
	await page.locator('#logo-menu').click();
	await page.waitForTimeout(300);
	await page.locator('#sidebar70 .side-row', { hasText: 'Configure Scene' }).click();
	await page.waitForTimeout(700);
	await page.locator('#logo-menu').click(); // close the menu
	await page.waitForTimeout(300);
	right = await strip(page, 'right');
	let ins = await probe(page, '#inspector');
	list = await probe(page, '#object-list');
	h.check(right && right.tabs.join() === 'objects,inspector' && right.front === 'inspector', `Configure Scene joins the right sidebar as a tab, in front (${JSON.stringify(right)})`);
	h.check(ins?.shown && Math.abs(ins.right - VW) < 3, `the Inspector fills the right column (${JSON.stringify(ins)})`);
	h.check(list && !list.shown, `the list is behind its tab — not pushed inward as a second column (${JSON.stringify(list)})`);
	const insLabel = await page.evaluate(() => document.querySelector('#sidebar-strip-right [data-sidebar-tab="scene"]')?.textContent?.trim());
	h.check(insLabel === 'Configure Scene' && right?.raw.includes('scene'), `Configure Scene is its own tab, named for what it shows (${insLabel}; ${JSON.stringify(right?.raw)})`);

	// ---------- 3. a tab press switches, instantly, in the same column ----------
	const sample = async (sel, run) => {
		await page.evaluate((sel) => {
			window.__smp = [];
			window.__smpOn = true;
			const t = () => {
				if (!window.__smpOn) return;
				const el = document.querySelector(sel);
				const r = el?.getBoundingClientRect();
				if (r && r.width > 0) window.__smp.push(Math.round(r.x * 10) / 10);
				requestAnimationFrame(t);
			};
			requestAnimationFrame(t);
		}, sel);
		await run();
		await page.waitForTimeout(500);
		return page.evaluate(() => {
			window.__smpOn = false;
			const s = window.__smp;
			return { n: s.length, spread: s.length ? Math.max(...s) - Math.min(...s) : -1, first: s[0] };
		});
	};
	let c = await tabCentre(page, 'right', 'objects');
	const sw = await sample('#object-list', async () => {
		await page.mouse.click(c[0], c[1]);
	});
	list = await probe(page, '#object-list');
	ins = await probe(page, '#inspector');
	right = await strip(page, 'right');
	h.check(right?.front === 'objects' && list?.shown && !ins?.shown, `pressing the Objects tab brings the list forward (${JSON.stringify(right)})`);
	h.check(sw.n > 5 && sw.spread < 1 && Math.abs(list.right - VW) < 3, `...in place, with no slide (spread ${sw.spread} over ${sw.n} frames)`);
	const insOpen = await store(page, 'inspectorClose');
	h.check(insOpen === false, 'the covered Inspector stays OPEN (a tab, not a close)');

	// ---------- 4. asking for a covered panel brings its tab forward (never closes it) ----------
	await page.evaluate(() => window.__stores.showSidebar('scene')); // Configure Scene TOGGLES when in front
	await page.waitForTimeout(400);
	right = await strip(page, 'right');
	h.check(right?.front === 'inspector' && (await store(page, 'inspectorClose')) === false, `Configure Scene on a covered tab reveals it rather than closing it (${right?.front})`);
	// the O key / toolbar button on a covered docked window brings it forward too
	await page.locator('p[title="Object list (O)"]').click();
	await page.waitForTimeout(400);
	right = await strip(page, 'right');
	h.check(right?.front === 'objects' && (await store(page, 'objectListClose')) === false, `the Object list button on a covered tab brings it forward (${right?.front})`);

	// ---------- 5. a pinned panel following the selection does not steal the list's place ----------
	await page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 400));
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		window.__box = g.children[g.children.length - 1];
		w.objectActions.deselectObject();
		w.inspectorPinned.set(true);
	});
	await page.waitForTimeout(300);
	await page.evaluate(() => window.__stores.objectActions.selectObject(window.__box.uuid)); // a list click
	await page.waitForTimeout(400);
	right = await strip(page, 'right');
	const kind = await store(page, 'inspectorKind');
	h.check(right?.front === 'objects' && kind === 'selection', `pinned: a plain select keeps the list in front, Properties follows behind it (${right?.front}, ${kind})`);
	await page.evaluate(() => window.__stores.objectActions.selectObject(window.__box.uuid, true)); // double-click / menu
	await page.waitForTimeout(400);
	right = await strip(page, 'right');
	h.check(right?.front === 'inspector', `an explicit Properties request brings its tab forward (${right?.front})`);
	await page.evaluate(() => window.__stores.inspectorPinned.set(false));

	// ---------- 6. drag the Inspector's tab to the LEFT half: it docks there, with a highlight ----------
	c = await tabCentre(page, 'right', 'inspector');
	await drag(page, c, [260, 420]);
	const zone = await probe(page, '#sidebar-drop-zone');
	const zoneSide = await page.evaluate(() => document.querySelector('#sidebar-drop-zone')?.getAttribute('data-side'));
	h.check(zone?.shown && zoneSide === 'left' && zone.x < 3 && zone.w > 240, `dragging over the left half lights the left column (${JSON.stringify(zone)} ${zoneSide})`);
	const ghost = await page.evaluate(() => !!document.querySelector('.sb-ghost'));
	h.check(ghost, 'the dragged tab follows the pointer');
	await page.mouse.up();
	await page.waitForTimeout(500);
	ins = await probe(page, '#inspector');
	const left = await strip(page, 'left');
	right = await strip(page, 'right');
	h.check(ins?.shown && ins.x < 3, `the Inspector now docks LEFT (${JSON.stringify(ins)})`);
	h.check(left?.tabs.join() === 'inspector' && left.front === 'inspector', `the left sidebar holds it as its tab (${JSON.stringify(left)})`);
	h.check(right?.tabs.join() === 'objects' && right.front === 'objects', `the right sidebar keeps the list, now in front (${JSON.stringify(right)})`);
	h.check(!(await probe(page, '#sidebar-drop-zone')), 'the highlight goes with the drop');
	const savedSide = await page.evaluate(() => localStorage.getItem('sidebar:inspectorSide'));
	h.check(savedSide === 'left', `the side persisted (${savedSide})`);
	// a drop back on the SAME half does nothing
	c = await tabCentre(page, 'left', 'inspector');
	await drag(page, c, [200, 600]);
	const sameZone = await probe(page, '#sidebar-drop-zone');
	await page.mouse.up();
	await page.waitForTimeout(300);
	h.check(!sameZone, 'dragging within its own half lights nothing');

	// ---------- 7. drag the list's tab left too: two tabs in the LEFT sidebar, no right one ----------
	c = await tabCentre(page, 'right', 'objects');
	await drag(page, c, [300, 300]);
	await page.mouse.up();
	await page.waitForTimeout(500);
	const left2 = await strip(page, 'left');
	list = await probe(page, '#object-list');
	h.check(left2?.tabs.join() === 'inspector,objects' && left2.front === 'objects', `the list joins the left sidebar, in front (${JSON.stringify(left2)})`);
	h.check(list?.docked === 'left' && list.x < 3, `the list is docked left (${JSON.stringify(list)})`);
	// 44 M7: the emptied side STAYS open — its header with "+" and no tabs, the helper line in the column
	const empty1 = await strip(page, 'right');
	h.check(!!empty1 && empty1.tabs.length === 0 && (await page.evaluate(() => !!document.querySelector('#sidebar-empty-right'))), `the right side is empty now: its header has no tabs, and it stays open with "+" (44 M7) (${JSON.stringify(empty1)})`);

	// ---------- 8. a FLOATING window dropped on an occupied column becomes one of its tabs ----------
	await page.locator('p[title="Node editor (N)"]').click();
	await page.waitForTimeout(600);
	const undock = page.locator('#dock-undock:visible');
	if (await undock.count()) {
		await undock.first().click();
		await page.waitForTimeout(500);
	}
	const flow0 = await probe(page, '#flow-window');
	h.check(!!flow0?.shown, `premise: the Node editor floats (${JSON.stringify(flow0)})`);
	await drag(page, [flow0.x + 60, flow0.y + 14], [150, 500]);
	const tabZone = await page.evaluate(() => {
		const z = document.querySelector('#dock-zone');
		// 45 N7: the zone carries a label line and (for a floating window) a hint line under it
		return z ? { tab: z.dataset.tab, side: z.dataset.side, text: z.querySelector('.sb-drop-label')?.textContent ?? z.textContent, hint: z.querySelector('.sb-drop-hint')?.textContent ?? '' } : null;
	});
	h.check(tabZone?.tab === 'true' && tabZone.side === 'left' && tabZone.text === 'Add as tab', `over the left column the drop target says it adds a tab (${JSON.stringify(tabZone)})`);
	h.check(/Ctrl/.test(tabZone?.hint ?? ''), `...with the hint that Ctrl places the window without docking (${JSON.stringify(tabZone?.hint)})`);
	await page.mouse.up();
	await page.waitForTimeout(500);
	const left3 = await strip(page, 'left');
	const flow1 = await probe(page, '#flow-window');
	h.check(left3?.tabs.join() === 'inspector,objects,flow' && left3.front === 'flow', `the Node editor is the left sidebar's third tab, in front (${JSON.stringify(left3)})`);
	h.check(flow1?.docked === 'left' && flow1.shown && flow1.x < 3 && flow1.h > VH * 0.7, `...filling the column, not split under another panel (${JSON.stringify(flow1)})`);

	// ---------- 9. the column grip resizes every tab of the side ----------
	const grip = await probe(page, '#sidebar-grip-left');
	h.check(!!grip?.shown, 'premise: the left column has its resize grip');
	await drag(page, [grip.x + 3, grip.y + 300], [grip.x + 3 + 110, grip.y + 300], 8);
	await page.mouse.up();
	await page.waitForTimeout(300);
	const flowWide = await probe(page, '#flow-window');
	h.check(flowWide.w - flow1.w > 90, `the grip widens the column (${flow1.w} -> ${flowWide.w})`);
	c = await tabCentre(page, 'left', 'inspector');
	await page.mouse.click(c[0], c[1]);
	await page.waitForTimeout(300);
	ins = await probe(page, '#inspector');
	h.check(Math.abs(ins.w - flowWide.w) < 3, `every tab takes the side's width (Inspector ${ins.w} vs ${flowWide.w})`);
	const savedW = await page.evaluate(() => parseInt(localStorage.getItem('sidebarWidth:left') ?? 'NaN'));
	h.check(Math.abs(savedW - flowWide.w) < 3, `the width persisted (${savedW})`);

	// ---------- 10. a reload keeps sides, tabs and the front tab ----------
	await h.freshReload(A);
	await page.locator('#restore-session-dismiss').click({ timeout: 6000 }).catch(() => {});
	await page.waitForTimeout(800);
	await page.evaluate(() => {
		const w = window.__stores;
		w.objectListClose.set(false);
		w.flowGraphClose.set(false);
		w.showSidebar('scene');
	});
	await page.waitForTimeout(1200);
	const back = await strip(page, 'left');
	ins = await probe(page, '#inspector');
	h.check(back?.tabs.join() === 'inspector,objects,flow', `after a reload the left sidebar has the same three tabs (${JSON.stringify(back)})`);
	h.check(ins?.shown && ins.x < 3 && Math.abs(ins.w - flowWide.w) < 3, `...the Inspector still docks left at the dragged width (${JSON.stringify(ins)})`);
	const empty2 = await strip(page, 'right');
	h.check(!empty2 || empty2.tabs.length === 0, `...and no tab came back on the right (44 M7: the emptied column is remembered open) (${JSON.stringify(empty2)})`);

	// ---------- 11. drag-away undocks one tab; the others keep the column ----------
	// 43 J7: in a sidebar the window has no header of its own — its TAB is the handle (43 J4: a tab
	// dropped in the viewport floats the window there)
	c = await tabCentre(page, 'left', 'flow');
	await page.mouse.click(c[0], c[1]);
	await page.waitForTimeout(300);
	// 78-int PL14: the strip also carries the Inspector's pin now, so three tabs can outgrow the column and the
	// strip scrolls its front tab into view — the drag starts where the Flow tab IS after the click
	c = await tabCentre(page, 'left', 'flow');
	const flowD = await probe(page, '#flow-window');
	await drag(page, c, [flowD.x + flowD.w + 300, flowD.y + 220], 12);
	await page.mouse.up();
	await page.waitForTimeout(400);
	const flowF = await probe(page, '#flow-window');
	const left4 = await strip(page, 'left');
	h.check(flowF?.docked === null && flowF.shown && flowF.h < VH * 0.8, `dragging a docked header away floats it (${JSON.stringify(flowF)})`);
	h.check(left4?.tabs.join() === 'inspector,objects' && !!left4.front, `the other tabs keep the column (${JSON.stringify(left4)})`);

	// ---------- 12. a stored 81.4 SPLIT pair comes back as two tabs, not stacked ----------
	await page.evaluate(() => {
		localStorage.setItem('dockedWindows', JSON.stringify({ left: [], right: ['objects', 'flow'] }));
		localStorage.setItem('dockSplit:right', '0.4');
		localStorage.setItem('sidebar:inspectorSide', 'right');
	});
	await h.freshReload(A);
	await page.locator('#restore-session-dismiss').click({ timeout: 6000 }).catch(() => {});
	await page.waitForTimeout(800);
	await page.evaluate(() => {
		window.__stores.objectListClose.set(false);
		window.__stores.flowGraphClose.set(false);
	});
	await page.waitForTimeout(1200);
	const l = await probe(page, '#object-list');
	const f = await probe(page, '#flow-window');
	const r12 = await strip(page, 'right');
	h.check(l?.docked === 'right' && f?.docked === 'right', `both stored windows dock right (${l?.docked}, ${f?.docked})`);
	h.check([l, f].filter((x) => x?.shown).length === 1, `exactly ONE of them is on screen — tabs, not a split (${l?.shown}, ${f?.shown})`);
	const shownOne = l?.shown ? l : f;
	h.check(shownOne && shownOne.h > VH * 0.7, `the one in front has the whole column (${shownOne?.h})`);
	h.check(r12?.tabs.length === 2, `the header lists both (${JSON.stringify(r12)})`);
	h.check(!(await page.locator('.dock-split-divider').count()), 'no split divider anywhere');

	await h.finish(browser);
});
