// 43 J4 — A SIDEBAR TAB GOES WHERE IT IS DROPPED, AND EVERY TARGET SAYS SO ($lib/sidebarDrop +
// SidebarStrips.svelte). The user (preview 1.33): "can dock left/right panel but dragging tab cannot
// undock to floating window if drag to viewport and no highlight for "Move to dock", only highlights
// for "Move to left side" (I believe same suggestion should appear even if sidebar opened, and I drag
// there, now I can silently drop there tab but guess it would be better to highlight area when I drag
// tab there)". And: "right click on left/right sidebar tabs should give option to close/undock and any
// other relevant options, also tabs should be possible to scroll same as for docked view and add 'x'
// button for each tab to be able to close".
//
// One drop-target model for a dragged sidebar tab and a dragged floating window: the other side's
// column ("Move to the left side", or "Add as tab" when that side is open), the bottom dock ("Move to
// dock"), the viewport ("Float here"). Each draws ONE highlight above every panel; the drop does what
// the highlight said. Real pointer throughout.
//
// Counterfactual (base = feat/42-int, 1.33.0): a tab dragged into the viewport's left half MOVES TO
// THE LEFT SIDE (section 1 red), the bottom does nothing (section 2 red), there is no tab menu, no ×,
// and the strip clips instead of scrolling (sections 5-7 red).
const h = require('./helpers.cjs');

const VW = 1440;
const VH = 900;

/** rect + visibility + dock state of one element */
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
			docked: el.dataset?.docked ?? null,
			host: el.getAttribute('data-pd-host')
		};
	}, sel);
}
/** the tabs of a side's strip, in order, and which one is in front */
function strip(page, side) {
	return page.evaluate((side) => {
		const el = document.querySelector('#sidebar-strip-' + side);
		if (!el) return null;
		const tabs = [...el.querySelectorAll('[data-sidebar-tab]')];
		return {
			tabs: tabs.map((t) => t.getAttribute('data-sidebar-tab')),
			front: tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.getAttribute('data-sidebar-tab') ?? null
		};
	}, side);
}
/** every drop highlight on screen: its words, its box and whether it paints above the panels */
function highlights(page) {
	return page.evaluate(() => {
		const out = [];
		for (const el of document.querySelectorAll('.sb-drop-zone, #bottom-dock-zone, #dock-strip-caret, [data-drop-target]')) {
			const r = el.getBoundingClientRect();
			const cs = getComputedStyle(el);
			if (cs.display === 'none' || r.width <= 0 || r.height <= 0) continue;
			out.push({
				id: el.id,
				target: el.getAttribute('data-drop-target') ?? el.getAttribute('data-target') ?? null,
				side: el.getAttribute('data-side'),
				text: (el.textContent ?? '').trim(),
				x: Math.round(r.x),
				y: Math.round(r.y),
				w: Math.round(r.width),
				h: Math.round(r.height),
				z: parseInt(cs.zIndex) || 0
			});
		}
		return out;
	});
}
/** the z-index a fixed element paints at (its own, else the nearest positioned ancestor's) */
function zOf(page, sel) {
	return page.evaluate((sel) => {
		let el = document.querySelector(sel);
		while (el && el !== document.documentElement) {
			const z = parseInt(getComputedStyle(el).zIndex);
			if (Number.isFinite(z)) return z;
			el = el.parentElement;
		}
		return 0;
	}, sel);
}
const store = (page, name, key) =>
	page.evaluate(([n, k]) => new Promise((r) => (k ? window.__stores[n][k] : window.__stores[n]).subscribe(r)()), [name, key]);

async function tabCentre(page, side, key) {
	return page.evaluate(
		([side, key]) => {
			const t = document.querySelector(`#sidebar-strip-${side} [data-sidebar-tab="${key}"]`);
			const b = t?.getBoundingClientRect();
			return b ? [Math.round(b.x + Math.min(30, b.width / 2)), Math.round(b.y + b.height / 2)] : null;
		},
		[side, key]
	);
}
/** press a sidebar tab and move to (x, y) — still holding — so the feedback can be read */
async function holdTabAt(page, side, key, x, y) {
	const c = await tabCentre(page, side, key);
	if (!c) return false;
	await page.mouse.move(c[0], c[1]);
	await page.mouse.down();
	await page.mouse.move(x, y, { steps: 16 });
	await page.waitForTimeout(150);
	return true;
}
/** dock the object list to an edge by dragging its header, the way a person does */
async function dockList(page, edgeX) {
	const open = await probe(page, '#object-list');
	// already a tab of that side (a reopened list keeps its side): nothing to drag
	if (open?.shown && open.docked === (edgeX < VW / 2 ? 'left' : 'right')) return open;
	if (open?.shown && open.docked) {
		await page.evaluate(() => window.__stores.docking.undock('objects', 400, 300));
		await page.waitForTimeout(300);
	}
	if (!(await probe(page, '#object-list'))?.shown) {
		await page.locator('p[title="Object list (O)"]').click();
		await page.waitForTimeout(400);
	}
	const l = await probe(page, '#object-list');
	await page.mouse.move(l.x + 24, l.y + 14);
	await page.mouse.down();
	await page.mouse.move(edgeX, 400, { steps: 14 });
	await page.mouse.up();
	await page.waitForTimeout(400);
	return probe(page, '#object-list');
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: VW, height: VH } } });
	const page = A.page;

	// ---------- 1. a tab dragged into the viewport UNDOCKS to a floating window, with a highlight ----------
	let list = await dockList(page, VW - 15);
	h.check(list?.docked === 'right', `premise: the list is docked right (${JSON.stringify(list)})`);
	// the left half of the viewport, well clear of both edges and the bottom
	await holdTabAt(page, 'right', 'objects', 560, 380);
	let hl = await highlights(page);
	const floatHl = hl.find((x) => x.target === 'float');
	h.check(!!floatHl && /float/i.test(floatHl.text), `over the viewport the highlight says the tab will float (${JSON.stringify(hl)})`);
	h.check(!hl.some((x) => /left side/i.test(x.text)), `the viewport is not "Move to the left side" (${JSON.stringify(hl)})`);
	await page.mouse.up();
	await page.waitForTimeout(500);
	list = await probe(page, '#object-list');
	h.check(list && !list.docked && list.shown, `dropped on the viewport the list floats (${JSON.stringify(list)})`);
	h.check(list && Math.abs(list.x + 120 - 560) < 140 && Math.abs(list.y - 380) < 120, `the floating list lands where it was dropped (${JSON.stringify(list)})`);
	// 44 M7: an emptied sidebar STAYS open with its "+" and the helper line (the user's ask)
	h.check(!!(await strip(page, 'right')) && (await page.evaluate(() => !!document.querySelector('#sidebar-empty-right'))), 'the right sidebar stays open, empty, with its "+" (44 M7)');
	h.check((await highlights(page)).length === 0, 'the highlight ends with the drop');

	// ---------- 2. a tab dragged to the bottom: "Move to dock", and it lands in the dock ----------
	list = await dockList(page, VW - 15);
	h.check(list?.docked === 'right', `premise: the list is docked right again (${JSON.stringify(list)})`);
	await holdTabAt(page, 'right', 'objects', 700, VH - 18);
	hl = await highlights(page);
	const dockHl = hl.find((x) => x.target === 'dock');
	h.check(!!dockHl && /dock/i.test(dockHl.text), `over the bottom the highlight says "Move to dock" (${JSON.stringify(hl)})`);
	await page.mouse.up();
	await page.waitForTimeout(700);
	const hosted = await store(page, 'dockHost', 'hostedDocked');
	list = await probe(page, '#object-list');
	h.check(hosted?.objects === true && list?.host === 'shown' && !list.docked, `dropped there the list is a bottom-dock tab (${JSON.stringify({ hosted, list })})`);
	h.check(!(await page.evaluate(() => !!document.querySelector('#sidebar-strip-right [data-sidebar-tab="objects"]'))), 'and it left the right sidebar');
	// back out of the dock, closed — the next sections start clean
	await page.evaluate(() => window.__stores.dockHost.setHostedDocked('objects', false));
	await page.waitForTimeout(300);

	// ---------- 3. onto the OTHER side's open column: "Add as tab", painted above that column ----------
	// Configure Scene on the right, the list on the left
	await page.evaluate(() => window.__stores.showSidebar?.('scene'));
	await page.waitForTimeout(600);
	let right = await strip(page, 'right');
	if (!right?.tabs.includes('scene')) {
		await page.locator('#logo-menu').click();
		await page.waitForTimeout(300);
		await page.locator('#sidebar70 .side-row', { hasText: 'Configure Scene' }).click();
		await page.waitForTimeout(700);
		await page.locator('#logo-menu').click();
		await page.waitForTimeout(300);
		right = await strip(page, 'right');
	}
	h.check(right?.tabs.includes('scene'), `premise: Configure Scene is the right sidebar (${JSON.stringify(right)})`);
	list = await dockList(page, 12);
	h.check(list?.docked === 'left', `premise: the list is docked left (${JSON.stringify(list)})`);
	const col = await probe(page, '#inspector');
	await holdTabAt(page, 'left', 'objects', col.x + col.w / 2, col.y + 200);
	hl = await highlights(page);
	const tabHl = hl.find((x) => /add as tab/i.test(x.text));
	h.check(!!tabHl && tabHl.side === 'right', `over the open right column the highlight says "Add as tab" (${JSON.stringify(hl)})`);
	const colZ = Math.max(await zOf(page, '#inspector'), await zOf(page, '#sidebar-strip-right'));
	h.check(tabHl && tabHl.z > colZ, `the highlight paints ABOVE the column it targets (zone ${tabHl?.z} > column ${colZ})`);
	h.check(tabHl && Math.abs(tabHl.x - col.x) < 4 && tabHl.w > 200, `and covers that column (${JSON.stringify({ tabHl, col })})`);
	await page.mouse.up();
	await page.waitForTimeout(500);
	right = await strip(page, 'right');
	h.check(right?.tabs.includes('objects') && right.tabs.includes('scene') && right.front === 'objects', `dropped there the list is a tab of the right sidebar, in front (${JSON.stringify(right)})`);

	// ---------- 4. Configure Scene has no floating window: the viewport offers it nothing ----------
	await page.locator('#sidebar-strip-right [data-sidebar-tab="scene"]').click();
	await page.waitForTimeout(300);
	await holdTabAt(page, 'right', 'scene', 600, 420);
	hl = await highlights(page);
	h.check(!hl.some((x) => x.target === 'float' || x.target === 'dock'), `the Inspector is offered no float / dock target (${JSON.stringify(hl)})`);
	await page.mouse.up();
	await page.waitForTimeout(400);
	right = await strip(page, 'right');
	h.check(right?.tabs.includes('scene'), `dropped on the viewport it stays in its sidebar (${JSON.stringify(right)})`);

	// ---------- 5. the tab menu: right-click names every move ----------
	let c = await tabCentre(page, 'right', 'objects');
	await page.mouse.click(c[0], c[1], { button: 'right' });
	await page.waitForTimeout(300);
	const rows = await page.evaluate(() => [...document.querySelectorAll('[role=menu] [role=menuitem]')].map((r) => ({ t: r.textContent.trim(), dis: r.getAttribute('aria-disabled') === 'true' || r.classList.contains('ctx-disabled') })));
	const has = (re) => rows.find((r) => re.test(r.t));
	h.check(has(/^close$/i) && has(/close others/i) && has(/undock/i) && has(/left side/i) && has(/bottom dock/i), `the tab menu offers Close, Close others, Undock, Move to the left side, Move to the bottom dock (${JSON.stringify(rows)})`);
	await page.locator('[role=menu] [role=menuitem]', { hasText: /undock/i }).first().click();
	await page.waitForTimeout(500);
	list = await probe(page, '#object-list');
	right = await strip(page, 'right');
	h.check(list && !list.docked && list.shown && !right?.tabs.includes('objects'), `"Undock" floats the list out of the sidebar (${JSON.stringify({ list, right })})`);
	// the Inspector's own menu: no float, no dock — said, not hidden
	c = await tabCentre(page, 'right', 'scene');
	await page.mouse.click(c[0], c[1], { button: 'right' });
	await page.waitForTimeout(300);
	const insRows = await page.evaluate(() => [...document.querySelectorAll('[role=menu] [role=menuitem]')].map((r) => ({ t: r.textContent.trim(), dis: r.getAttribute('aria-disabled') === 'true' || r.classList.contains('ctx-disabled') })));
	const insUndock = insRows.find((r) => /undock/i.test(r.t));
	h.check(insUndock?.dis === true, `the Inspector's Undock row is there, disabled (${JSON.stringify(insRows)})`);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);

	// ---------- 6. an × on each tab closes that panel ----------
	list = await dockList(page, VW - 15);
	right = await strip(page, 'right');
	h.check(right?.tabs.includes('objects') && right.tabs.includes('scene'), `premise: two tabs on the right (${JSON.stringify(right)})`);
	const xs = await page.evaluate(() => [...document.querySelectorAll('#sidebar-strip-right [data-sidebar-tab-close]')].map((b) => b.getAttribute('data-sidebar-tab-close')));
	h.check(xs.includes('objects') && xs.includes('scene'), `every tab carries its own × (${JSON.stringify(xs)})`);
	await page.locator('#sidebar-strip-right [data-sidebar-tab-close="objects"]').click();
	await page.waitForTimeout(400);
	right = await strip(page, 'right');
	list = await probe(page, '#object-list');
	h.check(!right?.tabs.includes('objects') && right?.tabs.includes('scene') && !list?.shown, `the list's × closes the list, the other tab stays (${JSON.stringify({ right, list })})`);

	// ---------- 7. a strip with more tabs than room SCROLLS, like the dock's ----------
	await page.evaluate(() => window.__stores.sidebars.setSidebarWidth('right', 250));
	await page.locator('p[title="Object list (O)"]').click();
	await page.waitForTimeout(400);
	await page.evaluate(() => window.__stores.statsOpen?.set?.(true) ?? window.__stores.sceneBudget.statsOpen.set(true));
	await page.waitForTimeout(400);
	// both land on the right through the menu / the edge
	list = await dockList(page, VW - 15);
	const st = await probe(page, '#stats-window');
	if (st?.shown && !st.docked) {
		await page.mouse.move(st.x + 30, st.y + 14);
		await page.mouse.down();
		await page.mouse.move(VW - 12, 420, { steps: 14 });
		await page.mouse.up();
		await page.waitForTimeout(400);
	}
	right = await strip(page, 'right');
	const scroll = await page.evaluate(() => {
		const s = document.querySelector('#sidebar-strip-right .sb-tabs');
		if (!s) return null;
		const cs = getComputedStyle(s);
		return { sw: s.scrollWidth, cw: s.clientWidth, ox: cs.overflowX };
	});
	h.check(right && right.tabs.length >= 3, `premise: three tabs on a 250px sidebar (${JSON.stringify(right)})`);
	h.check(scroll && scroll.sw > scroll.cw + 4 && /auto|scroll/.test(scroll.ox), `the tabs overflow into a scrolling strip, not clipped (${JSON.stringify(scroll)})`);
	const sb = await probe(page, '#sidebar-strip-right .sb-tabs');
	await page.mouse.move(sb.x + 40, sb.y + 10);
	await page.mouse.wheel(0, 300);
	await page.waitForTimeout(200);
	const left = await page.evaluate(() => document.querySelector('#sidebar-strip-right .sb-tabs')?.scrollLeft ?? 0);
	h.check(left > 0, `the mouse wheel scrolls the strip sideways (scrollLeft ${left})`);

	await h.finish(browser);
});
