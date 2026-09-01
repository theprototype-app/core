// R22 ROUNDS 28-29 — A TAB GROUP'S GEOMETRY: ITS FLOOR, AND WHO PLACES ITS MEMBERS.
//
//   "for grouped window ... I should not be able to make it smaller than smallest of one
//    of them, so when I switch there are no break of header/window"
//   "to reproduce: undock explorer, undock node editor, scale down window to minimum,
//    switch between tabs, header breaks"
//   "undock explorer, undock node editor, merge them into multiwindow, scale down window to
//    minimum, switch to another tab, check if header placement is correct and it is
//    attached to window"
//
// ITS OWN FILE, and that is the point: the sections in `tab-group-stacking` merge, tear and
// re-merge windows, and the state they leave behind cannot stage a node editor. This one
// starts clean and does the user's steps in their order.
//
// THE ORDER OF THE SETUP IS LOAD-BEARING — undock the Explorer BEFORE opening the node
// editor, or the node editor mounts over the Explorer's undock button and the click lands
// on the wrong thing. That cost two runs.
//
// Run: APP_URL='https://localhost:5203/' npm run e2e -- tab-group-geometry
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.windowTabs, null, { timeout: 30000 });

	// ---- the user's steps, in the user's order ------------------------------------------
	// FLOW READS `flowDocked` AT INIT, so setting it on a running page does nothing — the
	// component was created at boot. Set it and reload. (The first version of this appeared
	// to work only because the flag had persisted from an earlier run in the same profile,
	// which is its own lesson: a suite that depends on leftover storage passes on the second
	// run and fails on a clean one.)
	await page.evaluate(() => localStorage.setItem('flowDocked', 'false'));
	await page.reload();
	await page.waitForFunction(() => !!window.__stores?.windowTabs, null, { timeout: 30000 });
	await page.waitForTimeout(800);

	await page.evaluate(() => window.__stores.explorerClose.set(false));
	await page.waitForTimeout(1200);
	if (!(await page.locator('#explorer-window').count())) {
		await page.locator('#explorer-undock').click({ timeout: 20000 });
		await page.waitForTimeout(900);
	}
	await page.evaluate(() => window.__stores.flowGraphClose?.set?.(false));
	await page.waitForTimeout(1400);
	h.check(
		(await page.locator('#explorer-window').count()) === 1 &&
			(await page.locator('#flow-window').count()) === 1,
		'premise: the Explorer and the node editor are both floating'
	);

	const group = await page.evaluate(() => {
		const t = window.__stores.windowTabs;
		t.mergeWindows('explorer', 'flow');
		t.resizeGroup('explorer', 10, 10); // "scale down window to minimum"
		let g;
		t.tabGroups.subscribe((v) => (g = v))();
		const mine = g.find((x) => x.members.includes('flow'));
		return { id: mine?.id, rect: mine?.rect, members: mine?.members ?? [] };
	});
	await page.waitForTimeout(900);
	h.check(
		group.members.length === 2,
		'premise: exactly two members, driven to the floor (' + JSON.stringify(group) + ')'
	);

	// =====================================================================================
	// 1. THE FLOOR IS THE WORST CASE ACROSS THE MEMBERS (round 28)
	// =====================================================================================
	// Round 26 used a flat constant, so a pair could be driven to 260px whatever was in it.
	// At 260 the node editor is visibly wrecked — palette, toolbar and canvas with nowhere
	// to be — which took a SCREENSHOT to see: four metrics (overflow, wrap, last button
	// inside, header under the strip) all came back clean while the window was a mess.
	// A member declares what it needs through `tabbable`; the group takes the maximum.
	const floor = await page.evaluate(() => {
		let g;
		window.__stores.windowTabs.tabGroups.subscribe((v) => (g = v))();
		const mine = g.find((x) => x.members.includes('flow'));
		return { w: Math.round(mine.rect.width), h: Math.round(mine.rect.height), floor: window.__stores.windowTabs.groupFloor(mine) };
	});
	h.check(
		floor.w >= 460 && floor.h >= 320,
		'the group stops at what the NODE EDITOR needs, not at a flat constant (' + JSON.stringify(floor) + ')'
	);
	h.check(
		floor.floor.w >= 460 && floor.floor.h >= 320,
		'...derived from the member’s own declaration (' + JSON.stringify(floor.floor) + ')'
	);

	// =====================================================================================
	// 2. THE STRIP STAYS ON ITS WINDOW ACROSS A TAB SWITCH (round 29)
	// =====================================================================================
	// THE ONE THE USER KEPT SEEING. A grouped window is positioned by its GROUP, but
	// dragWindow re-clamps a window from ITS OWN stored rect on a hidden -> visible
	// transition — and a tab switch is exactly that. So the revealed member jumped back to
	// wherever it last floated while the strip stayed on the group rect: measured group
	// (160,120), Explorer (160,120), node editor (120,90), its own defaultRect, 40px adrift.
	// And the group rect is then re-derived from the ACTIVE member, so switching BACK was
	// wrong too — which is why all three states are checked and not just the switch.
	//
	// Four earlier rounds missed this because they measured the member against ITSELF (does
	// its header overflow, does it wrap) rather than against the strip meant to sit on it.
	const attachment = () =>
		page.evaluate(() => {
			const strip = document.querySelector('.tab-strip');
			if (!strip) return null;
			const sb = strip.getBoundingClientRect();
			for (const sel of ['#explorer-window', '#flow-window']) {
				const win = document.querySelector(sel);
				if (!win || win.style.display === 'none') continue;
				const wb = win.getBoundingClientRect();
				const hb = win.querySelector('.ui-panel-header')?.getBoundingClientRect();
				return {
					who: sel,
					dx: Math.round(sb.left - wb.left),
					dy: Math.round(sb.top - wb.top),
					dw: Math.round(sb.width - wb.width),
					coversHeader: hb ? Math.abs(sb.bottom - hb.bottom) <= 2 : null
				};
			}
			return null;
		});
	const attached = (a) =>
		!!a && Math.abs(a.dx) <= 1 && Math.abs(a.dy) <= 1 && Math.abs(a.dw) <= 1 && a.coversHeader;

	const go = async (key) => {
		await page.evaluate(
			({ id, k }) => window.__stores.windowTabs.activateTab(id, k),
			{ id: group.id, k: key }
		);
		await page.waitForTimeout(700);
		return attachment();
	};

	const first = await go('explorer');
	h.check(
		attached(first),
		'premise: on the first tab the strip sits exactly on its window (' + JSON.stringify(first) + ')'
	);
	const switched = await go('flow');
	h.check(
		attached(switched),
		'switching tabs keeps the strip ON the window — the revealed member takes the GROUP’s position, not its own (' +
			JSON.stringify(switched) +
			')'
	);
	const backAgain = await go('explorer');
	h.check(
		attached(backAgain),
		'...and switching BACK is right too, which it was not: the group rect had been re-derived from a misplaced member (' +
			JSON.stringify(backAgain) +
			')'
	);

	// the flag that carries the ownership, and the fact that it is CLEARED on the way out —
	// a torn-off window places itself again, so dragWindow must have it back
	const owned = await page.evaluate(() => ({
		grouped: !!document.querySelector('#flow-window')?.dataset.tabMember,
		explorer: !!document.querySelector('#explorer-window')?.dataset.tabMember
	}));
	h.check(
		owned.grouped && owned.explorer,
		'both members are marked as placed-by-the-group (' + JSON.stringify(owned) + ')'
	);
	await page.evaluate(() => window.__stores.windowTabs.removeFromGroup('flow'));
	await page.waitForTimeout(700);
	h.check(
		(await page.evaluate(() => !!document.querySelector('#flow-window')?.dataset.tabMember)) === false,
		'...and a window that LEAVES the group is handed back to dragWindow, or it could never be revealed properly again'
	);

	h.check(
		(h.pageErrors(A) || []).length === 0,
		'no page errors (' + (h.pageErrors(A) || []).join(' | ') + ')'
	);
	await h.finish(browser);
});
