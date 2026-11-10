// 41 G6 — floating window GROUPS by touch (the user's 1.32 preview review, unfolded OPPO N6):
// "grouped floating windows cannot be dragged using header ... it drags a bit and then sticks
// ... can not drag holding on tab names. Also when I hold grouped window tab I want context menu
// to open to allow me to ungroup selected item or dock specifically this tab".
//
//   1  a touch drag on the group's strip follows the finger at EVERY step (no pointercancel —
//      the strip had touch-action:auto, so the browser took the gesture as a pan)
//   2  a touch drag on a TAB NAME moves the whole group the same way (QUESTIONS Q1) — REVERSED by
//      panel-gestures item 7: a touch on a tab scrolls the tabs / does nothing / lifts on a long-press
//      ($lib/ui/tabTouch, suite panel-gestures); the group moves by its touch GRIP (.ts-grip) instead
//   3  a long-press on a tab opens the kit menu (44 M3: the floating-window menu — Float (undock) is the old
//      Ungroup this tab, Dock to bottom the old Dock this tab),
//      and each row does what it says
//   4  desktop: right-click on a tab opens the same menu; a mouse drag of a tab still tears it out
//
// Gestures are REAL touch (CDP Input.dispatchTouchEvent) in N6 unfolded (770x850) and folded
// (390x896) contexts with floating windows allowed. Run:
//   APP_URL=http://localhost:5404/ npm run e2e -- window-groups-touch
const h = require('./helpers.cjs');

const UNFOLDED = { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 };
const FOLDED = { viewport: { width: 390, height: 896 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 };
const STORAGE = { mobileUndockAllowed: 'true', timelineDocked: 'false', animationDocked: 'false' };

const groups = (page) =>
	page.evaluate(() => {
		let g;
		window.__stores.windowTabs.tabGroups.subscribe((v) => (g = v))();
		return g;
	});

/** group Objects + Timeline (+ Animation) and park the group in clear space (toasts live at the top) */
async function makeGroup(page, at, extra = []) {
	await page.evaluate(
		async ({ at, extra }) => {
			const s = window.__stores;
			s.objectListClose.set(false);
			s.timelineClose.set(false);
			for (const k of extra) s[k].set(false);
			await new Promise((r) => setTimeout(r, 900));
			const wt = s.windowTabs;
			wt.mergeWindows('objects', 'timeline');
			if (extra.includes('animationClose')) wt.mergeWindows('objects', 'animation');
			await new Promise((r) => setTimeout(r, 300));
			let g;
			wt.tabGroups.subscribe((v) => (g = v))();
			const grp = g[0];
			wt.moveGroup(grp.id, at.x - grp.rect.left, at.y - grp.rect.top);
			wt.activateTab(grp.id, 'objects');
		},
		{ at, extra }
	);
	await page.waitForTimeout(400);
}

const stripPos = (page) =>
	page.evaluate(() => {
		const r = document.querySelector('.tab-strip')?.getBoundingClientRect();
		return r ? { x: Math.round(r.x), y: Math.round(r.y) } : null;
	});

async function watchCancels(page) {
	await page.evaluate(() => {
		window.__cancels = 0;
		if (window.__cancelHooked) return;
		window.__cancelHooked = true;
		window.addEventListener('pointercancel', () => window.__cancels++, true);
	});
}

/** a real touch drag; returns the strip's offset from its start after EVERY step */
async function touchDrag(page, cdp, from, d, steps = 16) {
	const start = await stripPos(page);
	const trail = [];
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
	await page.waitForTimeout(30);
	for (let i = 1; i <= steps; i++) {
		const fx = (d.x * i) / steps;
		const fy = (d.y * i) / steps;
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + fx, y: from.y + fy }] });
		// touch moves are delivered aligned to frames: read after two of them
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
		const p = await stripPos(page);
		trail.push({ fx: Math.round(fx), fy: Math.round(fy), sx: p ? p.x - start.x : NaN, sy: p ? p.y - start.y : NaN });
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await page.waitForTimeout(250);
	const end = await stripPos(page);
	trail.push({ fx: d.x, fy: d.y, sx: end ? end.x - start.x : NaN, sy: end ? end.y - start.y : NaN, end: true });
	return trail;
}

/** after the slop, every step's strip offset equals the finger's offset (±2px) */
function follows(trail) {
	const late = trail.filter((t) => Math.hypot(t.fx, t.fy) > 10);
	return late.length > 0 && late.every((t) => Math.abs(t.sx - t.fx) <= 2 && Math.abs(t.sy - t.fy) <= 2);
}

async function longPress(page, cdp, pt, ms = 750) {
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
	await page.waitForTimeout(ms);
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await page.waitForTimeout(300);
}

const tabCentre = (page, label) =>
	page.evaluate((label) => {
		const t = [...document.querySelectorAll('.tab-strip .ts-tab')].find((b) => b.textContent.trim() === label);
		if (!t) return null;
		t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // the tabs scroll sideways (a person swipes to it)
		const r = t.getBoundingClientRect();
		return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
	}, label);

// 44 M3: the group tab's menu is the floating-window menu ($lib/windowMenu)
const ROWS = ['Dock to bottom', 'Move to left sidebar', 'Move to right sidebar', 'Float (undock)', 'Group with…', 'Bring to front', 'Reset size', 'Size', 'Close'];
const menuRows = (page) =>
	page.evaluate(
		(rows) =>
			[...document.querySelectorAll('.ctx-menu button, [role="menu"] button, [role="menuitem"]')]
				.map((b) => b.textContent.replace(/\s*▸\s*$/, '').trim()) // a submenu row ends in its arrow
				.filter((t) => rows.includes(t)),
		ROWS
	);

async function tapRow(page, cdp, label) {
	const pt = await page.evaluate((label) => {
		const b = [...document.querySelectorAll('[role="menuitem"], .ctx-menu button, [role="menu"] button')].find((x) => x.textContent.trim() === label);
		if (!b) return null;
		const r = b.getBoundingClientRect();
		return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
	}, label);
	if (!pt) return false;
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
	await page.waitForTimeout(60);
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await page.waitForTimeout(600);
	return true;
}

h.run(async () => {
	const browser = await h.launch();

	for (const [name, context] of [['unfolded', UNFOLDED], ['folded', FOLDED]]) {
		const P = await h.setupPage(browser, 'N6-' + name, { context, storage: STORAGE });
		const page = P.page;
		const cdp = await page.context().newCDPSession(page);
		await makeGroup(page, { x: 20, y: 300 });
		await watchCancels(page);
		h.check((await groups(page)).length === 1, `${name}: premise — Objects + Timeline form one group`);

		// 1 — the strip's empty part (the spacer before the dock/close buttons)
		const bg = await page.evaluate(() => {
			// the spacer before the dock/close buttons, or (tabs filling the strip) its left padding
			const sp = document.querySelector('.tab-strip > span.flex-1');
			const st = document.querySelector('.tab-strip').getBoundingClientRect();
			const r = sp.getBoundingClientRect();
			const pt = r.width > 8 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : { x: Math.round(st.x + 3), y: Math.round(st.y + st.height / 2) };
			const hit = document.elementFromPoint(pt.x, pt.y);
			return { ...pt, w: Math.round(r.width > 8 ? r.width : 3), hitsStrip: !!hit?.closest('.tab-strip') && !hit.closest('button') };
		});
		h.check(bg.hitsStrip && bg.w >= 3, `${name} 1.0 premise: the pressed pixel is the strip itself (${JSON.stringify(bg)})`);
		let trail = await touchDrag(page, cdp, bg, { x: 120, y: 160 });
		let cancels = await page.evaluate(() => window.__cancels);
		h.check(cancels === 0, `${name} 1.1 a touch drag on the strip is never cancelled by the browser (pointercancel x${cancels})`);
		h.check(follows(trail), `${name} 1.2 the group follows the finger at every step (${JSON.stringify(trail.slice(-3))})`);
		await page.screenshot({ path: (process.env.OUT || '/tmp') + `/g6-${name}-strip-drag.png` });

		// 2 — panel-gestures item 7: the GRIP moves the group on touch (a tab no longer does)
		await page.evaluate(() => (window.__cancels = 0));
		const grip = await page.evaluate(() => {
			const r = document.querySelector('.tab-strip .ts-grip')?.getBoundingClientRect();
			return r && r.width ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
		});
		h.check(!!grip, `${name} 2.0 premise: the touch grip is drawn`);
		trail = grip ? await touchDrag(page, cdp, grip, { x: 100, y: -120 }) : [];
		cancels = await page.evaluate(() => window.__cancels);
		const g2 = await groups(page);
		h.check(cancels === 0 && follows(trail), `${name} 2.1 a touch drag on the grip moves the whole group with the finger (cancels=${cancels}, ${JSON.stringify(trail.slice(-2))})`);
		h.check(g2.length === 1 && g2[0].members.length === 2, `${name} 2.2 ...and the group stays whole (${JSON.stringify(g2.map((g) => g.members))})`);
		const tab = await tabCentre(page, 'Objects');
		const before = await stripPos(page);
		// quick steps: a finger crosses the 8 px lock long before the 350 ms long-press lift (headless frames are slow)
		if (tab && before) await touchDrag(page, cdp, tab, { x: 0, y: 120 }, 4);
		const after = await stripPos(page);
		h.check(!!tab && !!before && !!after && before.x === after.x && before.y === after.y && (await groups(page)).length === 1, `${name} 2.3 a plain vertical touch drag on a tab name moves nothing (${JSON.stringify({ tab, before, after })})`);

		// the grip drag above moved the group right: park it back so its tabs are on a folded screen
		await page.evaluate(() => {
			let g;
			window.__stores.windowTabs.tabGroups.subscribe((v) => (g = v))();
			if (g[0]) window.__stores.windowTabs.moveGroup(g[0].id, 20 - g[0].rect.left, 300 - g[0].rect.top);
		});
		await page.waitForTimeout(300);

		// 3 — long-press a tab → the kit menu
		const fc = await tabCentre(page, 'Timeline');
		await longPress(page, cdp, fc);
		const rows = await menuRows(page);
		h.check(
			JSON.stringify(rows) === JSON.stringify(ROWS),
			`${name} 3.1 a long-press on a group tab opens the window menu (${JSON.stringify(rows)})`
		);
		await page.screenshot({ path: (process.env.OUT || '/tmp') + `/g6-${name}-longpress-menu.png` });
		h.check(await tapRow(page, cdp, 'Float (undock)'), `${name} 3.2 the Float (undock) row is tappable`);
		const un = await page.evaluate(() => {
			const vis = (s) => {
				const n = document.querySelector(s);
				return !!n && getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().width > 0;
			};
			return { strip: !!document.querySelector('.tab-strip'), fc: vis('#timeline-window'), ol: vis('#object-list'), tm: document.querySelector('#timeline-window')?.dataset.tabMember ?? null };
		});
		h.check(!un.strip && un.fc && un.ol && un.tm === null, `${name} 3.3 Ungroup: both windows float on their own, both visible (${JSON.stringify(un)})`);

		// Dock this tab
		await makeGroup(page, { x: 20, y: 300 });
		await longPress(page, cdp, await tabCentre(page, 'Timeline'));
		await tapRow(page, cdp, 'Dock to bottom');
		await page.waitForTimeout(600);
		const dk = await page.evaluate(() => {
			let o, a;
			window.__stores.bottomDock.dockOccupants.subscribe((v) => (o = v))();
			window.__stores.bottomDock.visibleDockKey.subscribe((v) => (a = v))();
			const ol = document.querySelector('#object-list');
			return { present: !!o.timeline?.present, visible: a, strip: !!document.querySelector('.tab-strip'), ol: !!ol && getComputedStyle(ol).display !== 'none' };
		});
		h.check(dk.present && dk.visible === 'timeline' && !dk.strip && dk.ol, `${name} 3.4 Dock to bottom: Timeline is the visible dock tab, Objects floats alone (${JSON.stringify(dk)})`);

		// Close (on a window that has no docked mode, Dock is offered but disabled)
		await page.evaluate(() => localStorage.setItem('timelineDocked', 'false'));
		await page.evaluate(() => window.__stores.bottomDock.armDockMode('timeline', false));
		await page.waitForTimeout(700);
		await makeGroup(page, { x: 20, y: 300 });
		await longPress(page, cdp, await tabCentre(page, 'Objects'));
		const dis = await page.evaluate(() => {
			const b = [...document.querySelectorAll('[role="menuitem"], .ctx-menu button, [role="menu"] button')].find((x) => x.textContent.trim() === 'Dock to bottom');
			return b ? b.classList.contains('ctx-disabled') : null;
		});
		// 42 I6: on a wider screen (unfolded) the Objects list docks as a hosted tab, so its row is
		// enabled; in the phone posture (folded) the dock hosts only phone content tabs, so it stays off
		const phonePosture = await page.evaluate(() => document.documentElement.classList.contains('phone-shell'));
		h.check(dis === phonePosture, `${name} 3.5 Objects' "Dock to bottom" is ${phonePosture ? 'disabled in the phone posture' : 'enabled on a wider screen (42 I6)'} (${dis})`);
		await tapRow(page, cdp, 'Close');
		const cl = await page.evaluate(() => {
			let c;
			window.__stores.objectListClose.subscribe((v) => (c = v))();
			return { closed: c, strip: !!document.querySelector('.tab-strip') };
		});
		h.check(cl.closed === true && !cl.strip, `${name} 3.6 Close closes that tab's window (and a group of one dissolves) (${JSON.stringify(cl)})`);
		h.check((h.pageErrors(P) || []).length === 0, `${name}: no page errors (${(h.pageErrors(P) || []).join(' | ')})`);
		await P.ctx.close();
	}

	// 4 — desktop mouse
	{
		const P = await h.setupPage(browser, 'desk', { context: { viewport: { width: 1440, height: 900 } }, storage: STORAGE });
		const page = P.page;
		await makeGroup(page, { x: 300, y: 300 });
		const fc = await tabCentre(page, 'Timeline');
		await page.mouse.click(fc.x, fc.y, { button: 'right' });
		await page.waitForTimeout(300);
		const rows = await menuRows(page);
		h.check(JSON.stringify(rows) === JSON.stringify(ROWS), `4.1 desktop: right-click on a group tab opens the same menu (${JSON.stringify(rows)})`);
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
		const ol = await tabCentre(page, 'Objects');
		await page.mouse.move(ol.x, ol.y);
		await page.mouse.down();
		await page.mouse.move(ol.x + 40, ol.y + 200, { steps: 10 });
		await page.mouse.up();
		await page.waitForTimeout(300);
		const g = await groups(page);
		h.check(g.length === 0, `4.2 desktop: a mouse drag of a tab still tears it out of the group (${JSON.stringify(g.map((x) => x.members))})`);
		await P.ctx.close();
	}

	await h.finish(browser);
});
