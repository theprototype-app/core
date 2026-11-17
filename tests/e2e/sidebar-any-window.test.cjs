// 43 J4 + J7 — ANY DOCKABLE WINDOW CAN BE A SIDEBAR TAB, AND IN A SIDEBAR IT HAS NO HEADER OF ITS OWN.
// The user (preview 1.33): "allow to place to left/right sidebar any floating/docked window (where
// relevant, for example Explorer already can be placed to the side)" and "Docked windows which moved
// to sidebar do not need additional header where it just replicates name and x button … for example
// "Node editor" on sidebar does not need header as "+" button on it also would only confuse users …
// but keep same functionality as is on docked windows".
//
// What it drives (real pointer, 1440x900, THEME=light re-runs it for the light shots):
//   1. a FLOATING window (Statistics) dragged to the left edge becomes a left sidebar tab;
//   2. a BOTTOM-DOCK tab (the Node editor) moves into a sidebar through its dock tab menu, and back
//      out through the sidebar tab menu ("Move to the bottom dock");
//   3. J7: in the sidebar the Node editor shows NO header (no name, no ✕, no Dock, no "+"); the
//      Explorer / Objects / Statistics keep their TOOLS (search, chips, budget dot) without the chrome;
//   4. the column's grip sizes a docked editor too (its own width binding cannot pull it out).
// Counterfactual (base = feat/42-int, 1.33.0): Statistics does not dock to an edge, the dock tab menu
// has no "Move to the left sidebar", and a side-docked Node editor shows its full header.
const h = require('./helpers.cjs');

const VW = 1440;
const VH = 900;
const THEME = process.env.THEME || 'dark';
const OUT = process.env.OUT || '/tmp';

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
			shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
			docked: el.dataset?.docked ?? null
		};
	}, sel);
}
/** is an element rendered (some box on screen)? */
const visible = (page, sel) =>
	page.evaluate((sel) => [...document.querySelectorAll(sel)].some((e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'), sel);
function strip(page, side) {
	return page.evaluate((side) => {
		const el = document.querySelector('#sidebar-strip-' + side);
		if (!el) return null;
		const tabs = [...el.querySelectorAll('[data-sidebar-tab]')];
		return {
			tabs: tabs.map((t) => t.getAttribute('data-sidebar-tab')),
			labels: tabs.map((t) => t.textContent.trim()),
			front: tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.getAttribute('data-sidebar-tab') ?? null
		};
	}, side);
}
/** right-click an element and pick the menu row matching `re` */
async function menuPick(page, sel, re) {
	const c = await page.evaluate((sel) => {
		const e = [...document.querySelectorAll(sel)].find((x) => x.getClientRects().length > 0);
		const r = e?.getBoundingClientRect();
		return r ? [r.x + Math.min(30, r.width / 2), r.y + r.height / 2] : null;
	}, sel);
	if (!c) return { ok: false, rows: [] };
	await page.mouse.click(c[0], c[1], { button: 'right' });
	await page.waitForTimeout(300);
	const rows = await page.evaluate(() => [...document.querySelectorAll('[role=menu] [role=menuitem]')].map((r) => r.textContent.trim()));
	const row = page.locator('[role=menu] [role=menuitem]', { hasText: re }).first();
	if (!(await row.count())) {
		await page.keyboard.press('Escape');
		return { ok: false, rows };
	}
	await row.click();
	await page.waitForTimeout(700);
	return { ok: true, rows };
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', {
		context: { viewport: { width: VW, height: VH } },
		storage: { flowDocked: 'true', explorerDocked: 'true', flowDockHeight: '300', theme: THEME }
	});
	const page = A.page;

	// ---------- 1. a floating window docks to a side by its header ----------
	await page.evaluate(() => window.__tp.test.v1.sceneBudget.statsOpen.set(true));
	await page.waitForTimeout(500);
	let st = await probe(page, '#stats-window');
	h.check(st?.shown && !st.docked, `premise: Statistics floats (${JSON.stringify(st)})`);
	await page.mouse.move(st.x + 40, st.y + 14);
	await page.mouse.down();
	await page.mouse.move(14, 420, { steps: 16 });
	const zone = await page.evaluate(() => {
		const z = document.querySelector('#dock-zone');
		return z ? { side: z.dataset.side, z: parseInt(getComputedStyle(z).zIndex) } : null;
	});
	const ghost = await page.evaluate(() => document.querySelector('#stats-window')?.classList.contains('dock-drag-ghost'));
	h.check(zone?.side === 'left', `dragged to the left edge the left column lights up (${JSON.stringify(zone)})`);
	h.check(ghost === true, 'the dragged window goes see-through over the target, so the highlight reads');
	await page.mouse.up();
	await page.waitForTimeout(500);
	st = await probe(page, '#stats-window');
	let left = await strip(page, 'left');
	h.check(st?.docked === 'left' && st.x < 3 && st.shown, `Statistics is docked left (${JSON.stringify(st)})`);
	h.check(left?.tabs.includes('stats') && left.labels.includes('Statistics'), `...as a left sidebar tab named "Statistics" (${JSON.stringify(left)})`);
	// J7: its name and ✕ live in the tab; its tools stay
	h.check(!(await visible(page, '#stats-close')), 'its own ✕ is gone (the tab has one)');
	h.check(await visible(page, '#stats-overall'), 'its budget dot (a tool) stays');
	const statsTitle = await page.evaluate(() => [...document.querySelectorAll('#stats-window .ui-panel-header span')].filter((s) => s.textContent.trim() === 'Statistics' && s.getClientRects().length).length);
	h.check(statsTitle === 0, `its "Statistics" title is not repeated under the tab (${statsTitle})`);

	// ---------- 2. a bottom-dock tab moves into a sidebar through its tab menu ----------
	await page.locator('p[title="Node editor (N)"]').click();
	await page.waitForTimeout(900);
	h.check(await visible(page, '#flow-list'), 'premise: the Node editor is a bottom-dock tab');
	let pick = await menuPick(page, '[data-dock-tab="flow"]', /left sidebar/i);
	h.check(pick.ok, `the dock tab menu offers "Move to the left sidebar" (${JSON.stringify(pick.rows)})`);
	await page.waitForTimeout(500);
	const flow = await probe(page, '#flow-window');
	left = await strip(page, 'left');
	h.check(flow?.docked === 'left' && flow.shown && flow.x < 3, `the Node editor is docked in the left sidebar (${JSON.stringify(flow)})`);
	h.check(!(await visible(page, '#flow-list')), 'and left the bottom dock');
	h.check(left?.front === 'flow' && left.labels.includes('Node editor'), `its tab is in front, named "Node editor" (${JSON.stringify(left)})`);

	// ---------- 3. J7: no window header under the tab ----------
	const head = await page.evaluate(() => {
		const el = document.querySelector('#flow-window .wc-head');
		return el ? getComputedStyle(el).display : 'missing';
	});
	h.check(head === 'none', `the Node editor's header row is gone in the sidebar (${head})`);
	h.check(!(await visible(page, '#flow-add-view')) && !(await visible(page, '#flow-dock')), 'no "+" and no Dock button in the sidebar');
	const flowTitle = await page.evaluate(() => [...document.querySelectorAll('#flow-window .wc-title')].some((t) => t.getClientRects().length > 0));
	h.check(!flowTitle, 'no repeated "Node editor" title');
	const strp = await probe(page, '#sidebar-strip-left');
	const flowNow = await probe(page, '#flow-window');
	h.check(Math.abs(flowNow.y - (strp.y + 30)) < 3, `the editor starts right under its tab, nothing in between (${flowNow.y} vs ${strp.y}+30)`);
	await page.screenshot({ path: `${OUT}/j7-node-editor-sidebar-${THEME}.png` });

	// the Explorer, a TOOLS header: its search stays, its name / Dock / ✕ go
	await page.locator('p[title*="Explorer"]').first().click();
	await page.waitForTimeout(900);
	pick = await menuPick(page, '[data-dock-tab="explorer"]', /right sidebar/i);
	h.check(pick.ok, 'the Explorer moves to the right sidebar from its dock tab');
	await page.waitForTimeout(500);
	const ex = await probe(page, '#explorer-window');
	h.check(ex?.docked === 'right' && ex.shown, `the Explorer is docked right (${JSON.stringify(ex)})`);
	// (its header sheds the search below a measured width — R22's ranking — so give the column room)
	await page.evaluate(() => window.__tp.test.v1.sidebars.setSidebarWidth('right', 600));
	await page.waitForTimeout(500);
	const exHead = await page.evaluate(() => {
		const el = document.querySelector('#explorer-window .wc-head');
		return el ? getComputedStyle(el).display : 'missing';
	});
	h.check(exHead !== 'none' && exHead !== 'missing', `its tools row stays in the sidebar (${exHead})`);
	h.check(await visible(page, '#explorer-search'), 'its search field stays in the sidebar');
	h.check(!(await visible(page, '#explorer-close')) && !(await visible(page, '#explorer-dock')), 'its ✕ and Dock are gone (the tab has both)');
	await page.screenshot({ path: `${OUT}/j7-explorer-sidebar-${THEME}.png` });

	// ---------- 4. the column grip sizes a docked editor too ----------
	const grip = await probe(page, '#sidebar-grip-left');
	await page.mouse.move(grip.x + 3, grip.y + 200);
	await page.mouse.down();
	await page.mouse.move(grip.x + 3 + 120, grip.y + 200, { steps: 8 });
	await page.mouse.up();
	await page.waitForTimeout(300);
	const wide = await probe(page, '#flow-window');
	h.check(Math.abs(wide.w - (flowNow.w + 120)) < 6, `dragging the left grip widens the docked Node editor (${flowNow.w} -> ${wide.w})`);
	// a window resize re-runs the editor's own size clamp: it must stay in its column
	await page.setViewportSize({ width: VW - 100, height: VH });
	await page.waitForTimeout(500);
	await page.setViewportSize({ width: VW, height: VH });
	await page.waitForTimeout(500);
	const after = await probe(page, '#flow-window');
	const colW = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sb-left-w')));
	h.check(after.docked === 'left' && Math.abs(after.w - colW) < 3 && after.x < 3, `after a window resize the editor still fills its column (${after.w} vs ${colW})`);

	// ---------- 5. back to the bottom dock from the sidebar tab ----------
	pick = await menuPick(page, '#sidebar-strip-left [data-sidebar-tab="flow"]', /bottom dock/i);
	h.check(pick.ok, `the sidebar tab menu offers "Move to the bottom dock" (${JSON.stringify(pick.rows)})`);
	await page.waitForTimeout(600);
	left = await strip(page, 'left');
	h.check((await visible(page, '#flow-list')) && !(await visible(page, '#flow-window')), 'the Node editor is a bottom-dock tab again');
	h.check(!left?.tabs.includes('flow'), `and no longer a left tab (${JSON.stringify(left)})`);
	const dockHead = await page.evaluate(() => !!document.querySelector('#flow-list [data-dock-tab]'));
	h.check(dockHead, 'with the dock strip as its header, as before');

	// ---------- 5b. a bottom-dock TAB dragged onto a side's column joins that sidebar ----------
	const ft = await page.evaluate(() => {
		const t = [...document.querySelectorAll('[data-dock-tab="flow"]')].find((x) => x.getClientRects().length);
		const r = t?.getBoundingClientRect();
		return r ? [r.x + r.width / 2, r.y + r.height / 2] : null;
	});
	await page.mouse.move(ft[0], ft[1]);
	await page.mouse.down();
	await page.mouse.move(120, 300, { steps: 16 });
	await page.waitForTimeout(150);
	const sideHl = await page.evaluate(() => {
		const z = document.querySelector('#dock-tab-side-zone');
		return z ? { side: z.dataset.side, target: z.dataset.dropTarget, text: z.textContent.trim() } : null;
	});
	h.check(sideHl?.side === 'left' && sideHl.target === 'side', `a dock tab over the left column lights it (${JSON.stringify(sideHl)})`);
	await page.mouse.up();
	await page.waitForTimeout(800);
	const fl2 = await probe(page, '#flow-window');
	left = await strip(page, 'left');
	h.check(fl2?.docked === 'left' && left?.tabs.includes('flow'), `dropped there the Node editor is a left sidebar tab (${JSON.stringify({ fl2, left })})`);
	h.check(!(await page.evaluate(() => !!document.querySelector('#dock-tab-side-zone'))), 'the highlight ends with the drop');

	// ---------- 6. the Animation editor joins a side by its floating header too ----------
	await page.evaluate(() => window.__tp.test.v1.animationClose.set(false));
	await page.waitForTimeout(800);
	const undock = page.locator('#dock-undock:visible');
	if (await visible(page, '[data-dock-tab="animation"]')) {
		await page.locator('[data-dock-tab="animation"]').first().click();
		await page.waitForTimeout(300);
		if (await undock.count()) await undock.first().click();
		await page.waitForTimeout(700);
	}
	const an = await probe(page, '#animation-window');
	h.check(an?.shown && !an.docked, `premise: the Animation editor floats (${JSON.stringify(an)})`);
	await page.mouse.move(an.x + 60, an.y + 14);
	await page.mouse.down();
	await page.mouse.move(VW - 14, 400, { steps: 16 });
	await page.mouse.up();
	await page.waitForTimeout(600);
	const an2 = await probe(page, '#animation-window');
	const right = await strip(page, 'right');
	h.check(an2?.docked === 'right' && right?.tabs.includes('animation'), `the Animation editor is a right sidebar tab (${JSON.stringify({ an2, right })})`);
	const anHead = await page.evaluate(() => {
		const el = document.querySelector('#animation-window .wc-head');
		return el ? getComputedStyle(el).display : 'missing';
	});
	h.check(anHead === 'none', `...with no header of its own (${anHead})`);
	await page.screenshot({ path: `${OUT}/j4-any-window-${THEME}.png` });

	await h.finish(browser);
});
