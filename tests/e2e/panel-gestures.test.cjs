// panel-gestures item 7 — TOUCH ON TAB STRIPS (owner, N6 unfolded: "dragging across many sidebar tabs
// tears a tab off as a floating window instead of scrolling; on docked panels a vertical drag moves
// the tabs up/down like a menu"). The model ($lib/ui/tabTouch + $lib/ui/stripScroll):
//   - a sideways swipe on the tabs SCROLLS the strip and moves / tears nothing;
//   - a vertical drag on a strip does nothing (no window move, the tab row never scrolls vertically);
//   - a still long-press (350 ms) lifts the tab; travel past 48 px out of the strip tears it off;
//     a lifted tab let go inside that margin stays where it was;
//   - a floating group moves by its touch grip;
//   - a mouse is unchanged (a drag of a group tab still tears it out).
// Gestures are REAL touch (CDP Input.dispatchTouchEvent) on the N6 unfolded (770x850), folded (390x896)
// and folded landscape (896x390); the mouse half on a 1440x900 desktop.
//   APP_URL=https://theprototype.app:<port>/ npm run e2e -- panel-gestures
const h = require('./helpers.cjs');

const touch = (w, hgt) => ({ viewport: { width: w, height: hgt }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 });
const VIEWS = [
	['unfolded', touch(770, 850)],
	['folded', touch(390, 896)],
	['landscape', touch(896, 390)]
];
const STORAGE = { mobileUndockAllowed: 'true', flowCodeDocked: 'false', animationDocked: 'false' };
const OUT = process.env.OUT || 'test-results/panel-gestures';

const groups = (page) =>
	page.evaluate(() => {
		let g;
		window.__stores.windowTabs.tabGroups.subscribe((v) => (g = v))();
		return g;
	});

/** Objects + Flow Code + Animation as one floating group, parked at `at`, narrowed so its tabs overflow */
async function makeGroup(page, at) {
	await page.evaluate(async (at) => {
		const s = window.__stores;
		s.objectListClose.set(false);
		s.flowCodeClose.set(false);
		s.animationClose.set(false);
		await new Promise((r) => setTimeout(r, 900));
		const wt = s.windowTabs;
		wt.mergeWindows('objects', 'flowcode');
		wt.mergeWindows('objects', 'animation');
		await new Promise((r) => setTimeout(r, 300));
		let g;
		wt.tabGroups.subscribe((v) => (g = v))();
		const grp = g[0];
		wt.moveGroup(grp.id, at.x - grp.rect.left, at.y - grp.rect.top);
		wt.activateTab(grp.id, 'objects');
	}, at);
	await page.waitForTimeout(500);
}

const strip = (page) =>
	page.evaluate(() => {
		const st = document.querySelector('.tab-strip');
		const sc = st?.querySelector('.ts-scroll');
		if (!st || !sc) return null;
		const r = st.getBoundingClientRect();
		return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), sl: Math.round(sc.scrollLeft), st: Math.round(sc.scrollTop), over: sc.scrollWidth - sc.clientWidth };
	});

const centreOf = (page, sel, label) =>
	page.evaluate(
		({ sel, label }) => {
			const t = [...document.querySelectorAll(sel)].find((b) => !label || b.textContent.trim() === label);
			if (!t) return null;
			const r = t.getBoundingClientRect();
			if (!r.width || !r.height) return null; // not drawn (display: none)
			return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
		},
		{ sel, label }
	);

/** the first tab whose centre is inside the scroller's visible box AND is what a finger there would hit */
const visibleTab = (page) =>
	page.evaluate(() => {
		const sc = document.querySelector('.tab-strip .ts-scroll')?.getBoundingClientRect();
		for (const t of document.querySelectorAll('.tab-strip .ts-tab')) {
			const r = t.getBoundingClientRect();
			const x = Math.round(r.x + r.width / 2);
			const y = Math.round(r.y + r.height / 2);
			if (!sc || x < sc.left + 4 || x > sc.right - 4) continue;
			if (document.elementFromPoint(x, y)?.closest('.ts-tab') !== t) continue;
			return { x, y, label: t.textContent.trim() };
		}
		return null;
	});
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** a real touch gesture: optional still hold first, then `steps` moves by `d`, then release */
async function gesture(page, cdp, from, d, { hold = 0, steps = 14 } = {}) {
	if (!from) return;
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
	await page.waitForTimeout(hold || 40);
	for (let i = 1; i <= steps; i++) {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (d.x * i) / steps, y: from.y + (d.y * i) / steps }] });
		await page.waitForTimeout(20);
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await page.waitForTimeout(400);
}

const menuLabels = (page) =>
	page.evaluate(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((b) => b.textContent.replace(/\s*▸\s*$/, '').replace(/\s+/g, ' ').trim()));
/** the menu row whose text starts with `label` */
const rowBox = (page, label) =>
	page.evaluate((label) => {
		const b = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].reverse().find((x) => x.textContent.replace(/\s+/g, ' ').trim().startsWith(label));
		if (!b) return null;
		const r = b.getBoundingClientRect();
		return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
	}, label);
/** close whatever menu is open: Escape, then what a finger does — a tap outside it (a touch long-press menu
 * leaves the keyboard focus where it was, so Escape alone does not reach it) */
async function closeMenus(page) {
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
	if (!(await menuOpen(page))) return;
	// a point outside the menu (a phone's menu is a bottom sheet, so mid-height can be the sheet itself)
	const pt = await page.evaluate(() => {
		for (const [x, y] of [[3, 3], [innerWidth - 3, 3], [3, Math.round(innerHeight / 2)]]) {
			if (!document.elementFromPoint(x, y)?.closest('[role="menu"]')) return { x, y };
		}
		return { x: 3, y: 3 };
	});
	await page.touchscreen.tap(pt.x, pt.y).catch(() => page.mouse.click(pt.x, pt.y));
	await page.waitForTimeout(300);
}

async function clickRow(page, label) {
	const p = await rowBox(page, label);
	if (p) await page.mouse.click(p.x, p.y);
	await page.waitForTimeout(400);
	return !!p;
}
async function hoverRow(page, label) {
	const p = await rowBox(page, label);
	if (p) await page.mouse.move(p.x, p.y, { steps: 3 });
	await page.waitForTimeout(500);
	return !!p;
}
async function tapRow(page, cdp, label) {
	const p = await rowBox(page, label);
	if (!p) return false;
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
	await page.waitForTimeout(60);
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await page.waitForTimeout(500);
	return true;
}
const menuOpen = (page) => page.evaluate(() => !!document.querySelector('[role="menu"]'));

h.run(async () => {
	require('fs').mkdirSync(OUT, { recursive: true });
	const browser = await h.launch();

	for (const [name, context] of VIEWS) {
		const P = await h.setupPage(browser, 'N6-' + name, { context, storage: STORAGE });
		const page = P.page;
		const cdp = await page.context().newCDPSession(page);
		const park = name === 'landscape' ? { x: 200, y: 120 } : { x: 10, y: 260 };

		// ---- G: the floating group strip ----
		await makeGroup(page, park);
		// narrow the group so its three tabs overflow on every posture
		await page.evaluate(() => {
			const n = document.querySelector('#object-list');
			if (n) n.style.width = '230px';
		});
		await page.waitForTimeout(500);
		let s0 = await strip(page);
		h.check(!!s0 && (await groups(page)).length === 1 && s0.over > 20, `${name} G0 premise: one group, its tabs overflow the strip (${JSON.stringify(s0)})`);

		// G1 — a sideways swipe on a tab scrolls the tabs; the group neither moves nor tears
		const first = await visibleTab(page);
		await gesture(page, cdp, first, { x: -140, y: 0 }, { steps: 8 });
		const NONE = { x: NaN, y: NaN, w: 0, sl: NaN, st: NaN, over: 0 };
		let s1 = (await strip(page)) ?? NONE;
		let g1 = await groups(page);
		h.check(s1.sl > s0.sl + 20, `${name} G1.1 a sideways swipe scrolls the tabs (scrollLeft ${s0.sl} -> ${s1.sl})`);
		h.check(s1.x === s0.x && s1.y === s0.y && g1.length === 1 && g1[0].members.length === 3, `${name} G1.2 ...and moves / tears nothing (${JSON.stringify({ s0, s1, members: g1.map((g) => g.members) })})`);
		await page.screenshot({ path: `${OUT}/g1-${name}-swipe.png` });

		// G2 — a vertical drag on a tab does nothing
		const tab2 = await visibleTab(page);
		await gesture(page, cdp, tab2, { x: 0, y: 120 }, { steps: 6 });
		const s2 = (await strip(page)) ?? NONE;
		const g2 = await groups(page);
		h.check(s2.x === s1.x && s2.y === s1.y && s2.st === 0, `${name} G2.1 a vertical drag on a tab neither moves the window nor scrolls the tabs vertically (${JSON.stringify(s2)})`);
		h.check(g2.length === 1 && g2[0].members.length === 3 && !(await menuOpen(page)), `${name} G2.2 ...tears nothing, opens no menu`);

		// G3 — long-press then a short drag (inside 48 px) and release: nothing moves
		const tab3 = await visibleTab(page);
		await gesture(page, cdp, tab3, { x: 0, y: 30 }, { hold: 420, steps: 3 });
		const g3 = await groups(page);
		h.check(g3.length === 1 && g3[0].members.length === 3 && !(await menuOpen(page)), `${name} G3 a long-press + a drag that stays within 48 px of the strip tears nothing (${JSON.stringify(g3.map((g) => g.members))})`);

		// G4 — long-press then a drag well out of the strip tears the tab off where the finger lets go
		const tab4 = await visibleTab(page);
		const label = tab4?.label;
		const down = name === 'landscape' ? 150 : 260;
		await page.evaluate(() => {
			window.__pg = [];
			const log = (e) => window.__pg.push(e.type + (e.pointerType ? ':' + e.pointerType : '') + (e.defaultPrevented ? '!' : '') + '@' + (e.target?.dataset?.tabPhase ?? e.target?.className?.toString?.().slice(0, 12) ?? ''));
			for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'contextmenu', 'lostpointercapture']) window.addEventListener(t, log, true);
			let moves = 0;
			window.addEventListener('pointermove', (e) => moves++ < 3 && log(e), true);
			window.addEventListener('touchmove', (e) => queueMicrotask(() => moves < 40 && window.__pg.push('tm' + (e.defaultPrevented ? '!' : '') + (e.cancelable ? 'c' : ''))), true);
		});
		await gesture(page, cdp, tab4, { x: 10, y: down }, { hold: 420, steps: 8 });
		const g4 = await groups(page);
		const ev4 = await page.evaluate(() => window.__pg.slice(0, 30).join(' '));
		h.check(g4.length === 1 && g4[0].members.length === 2, `${name} G4 a long-press + a drag ${down} px out of the strip tears "${label}" off (${JSON.stringify(g4.map((g) => g.members))}; events ${ev4})`);
		await page.screenshot({ path: `${OUT}/g4-${name}-torn.png` });
		// put the torn window back (a folded phone draws it over the strip) and the group where it was
		await page.evaluate(async (at) => {
			const wt = window.__stores.windowTabs;
			let g;
			wt.tabGroups.subscribe((v) => (g = v))();
			for (const k of ['objects', 'flowcode', 'animation']) if (g[0] && !g[0].members.includes(k)) wt.mergeWindows('objects', k);
			await new Promise((r) => setTimeout(r, 300));
			wt.tabGroups.subscribe((v) => (g = v))();
			if (g[0]) wt.moveGroup(g[0].id, at.x - g[0].rect.left, at.y - g[0].rect.top);
		}, park);
		await page.waitForTimeout(500);

		// G5 — the group's touch grip moves it with the finger
		const grip = await centreOf(page, '.tab-strip .ts-grip');
		const s5a = (await strip(page)) ?? NONE;
		const gripHit = grip && (await page.evaluate((p) => !!document.elementFromPoint(p.x, p.y)?.closest('.ts-grip'), grip));
		h.check(!!grip && gripHit, `${name} G5.0 premise: the touch grip is drawn on a coarse pointer, and a finger there hits it`);
		if (grip) {
			await gesture(page, cdp, grip, { x: 40, y: 50 }, { steps: 8 });
			const s5b = (await strip(page)) ?? NONE;
			h.check(Math.abs(s5b.x - s5a.x - 40) <= 3 && Math.abs(s5b.y - s5a.y - 50) <= 3, `${name} G5.1 dragging the grip moves the group with the finger (${JSON.stringify({ s5a, s5b })})`);
		}

		// G6 — long-press held still opens the tab's menu (the window menu)
		const tab6 = await visibleTab(page);
		await gesture(page, cdp, tab6, { x: 0, y: 0 }, { hold: 800, steps: 1 });
		h.check(await menuOpen(page), `${name} G6 a still long-press on a group tab opens its menu`);
		await closeMenus(page);

		// ---- D: the dock strip — one row, a vertical drag never scrolls it ----
		const dk = await page.evaluate(() => {
			const sc = document.querySelector('.dt-scroll');
			return sc ? { oy: getComputedStyle(sc).overflowY, ta: getComputedStyle(sc).touchAction } : null;
		});
		if (dk) h.check(dk.oy === 'hidden' && dk.ta === 'pan-x', `${name} D1 the dock tab row is one row: overflow-y hidden, touch-action pan-x (${JSON.stringify(dk)})`);

		// ---- S: the sidebar strip (wider screens only — a folded phone has no sidebars) ----
		await page.evaluate(async () => {
			const s = window.__stores;
			let g;
			s.windowTabs.tabGroups.subscribe((v) => (g = v))();
			for (const grp of g) for (const k of [...grp.members]) s.windowTabs.ungroupTab(k);
			await new Promise((r) => setTimeout(r, 300));
			s.explorerClose.set(false);
			s.sceneBudget.statsOpen.set(true);
			await new Promise((r) => setTimeout(r, 900));
			// objects comes back to the dock in section E
			for (const k of ['objects', 'explorer', 'stats']) s.dockMenu.moveToSidebar(k, 'right');
			await new Promise((r) => setTimeout(r, 900));
			s.sidebars.setSidebarWidth('right', 250);
		});
		await page.waitForTimeout(800);
		const side = () =>
			page.evaluate(() => {
				const st = document.querySelector('#sidebar-strip-right');
				const sc = st?.querySelector('.sb-tabs');
				if (!st || !sc || !st.getClientRects().length) return null;
				return { tabs: [...st.querySelectorAll('[data-sidebar-tab]')].map((t) => t.dataset.sidebarTab), sl: Math.round(sc.scrollLeft), over: sc.scrollWidth - sc.clientWidth };
			});
		const sideTab = () =>
			page.evaluate(() => {
				const sc = document.querySelector('#sidebar-strip-right .sb-tabs')?.getBoundingClientRect();
				for (const t of document.querySelectorAll('#sidebar-strip-right .sb-tab')) {
					const r = t.getBoundingClientRect();
					const x = Math.round(r.x + Math.min(r.width / 2, 40));
					const y = Math.round(r.y + r.height / 2);
					if (!sc || x < sc.left + 4 || x > sc.right - 4) continue;
					if (document.elementFromPoint(x, y)?.closest('.sb-tab') !== t) continue;
					return { x, y, key: t.dataset.sidebarTab };
				}
				return null;
			});
		const sb0 = await side();
		if (!sb0) {
			h.check(name === 'folded', `${name} S0 the right sidebar strip is drawn on a wider screen (folded = phone shell, none)`);
		} else {
			h.check(sb0.tabs.length >= 3 && sb0.over > 20, `${name} S0 premise: the right column holds several tabs that overflow its strip (${JSON.stringify(sb0)})`);
			// S1 — a sideways swipe scrolls the tabs; nothing tears off (the owner's report)
			let t = await sideTab();
			h.check(!!t && !(await menuOpen(page)), `${name} S0.1 premise: a sidebar tab is under the finger, no menu open (${JSON.stringify(t)})`);
			const dir = sb0.sl > sb0.over / 2 ? 1 : -1; // the finger drags the content back from whichever end it is at
			await gesture(page, cdp, t, { x: 150 * dir, y: 0 }, { steps: 8 });
			const s1 = (await side()) ?? { tabs: [], sl: NaN };
			h.check(Math.abs(s1.sl - sb0.sl) > 20 && JSON.stringify(s1.tabs) === JSON.stringify(sb0.tabs), `${name} S1 a sideways swipe over the sidebar tabs scrolls them and tears nothing off (${JSON.stringify({ sb0, s1 })})`);
			await page.screenshot({ path: `${OUT}/s1-${name}-sidebar-swipe.png` });
			// S2 — a vertical drag on a tab does nothing
			t = await sideTab();
			await gesture(page, cdp, t, { x: 0, y: 160 }, { steps: 6 });
			const s2 = (await side()) ?? { tabs: [] };
			const s2menu = (await menuOpen(page)) ? await menuLabels(page) : null;
			h.check(JSON.stringify(s2.tabs) === JSON.stringify(sb0.tabs) && !s2menu, `${name} S2 a vertical drag on a sidebar tab moves nothing (${JSON.stringify({ tabs: s2.tabs, menu: s2menu })})`);
			if (s2menu) await closeMenus(page);
			// S3 — long-press + a short drag (inside 48 px) and release: it stays
			t = await sideTab();
			await gesture(page, cdp, t, { x: -20, y: 30 }, { hold: 420, steps: 3 });
			const s3 = (await side()) ?? { tabs: [] };
			h.check(JSON.stringify(s3.tabs) === JSON.stringify(sb0.tabs), `${name} S3 a long-press + a drag within 48 px of the strip leaves the tab where it was (${JSON.stringify(s3.tabs)})`);
			// S4 — long-press + a drag out into the viewport: it floats there
			t = await sideTab();
			const vw = await page.evaluate(() => innerWidth);
			const toX = Math.round(vw * 0.3);
			await gesture(page, cdp, t, { x: toX - (t?.x ?? 0), y: 140 }, { hold: 420, steps: 10 });
			const s4 = (await side()) ?? { tabs: [] };
			h.check(!s4.tabs.includes(t.key) && s4.tabs.length === sb0.tabs.length - 1, `${name} S4 a long-press + a drag out into the viewport takes "${t?.key}" out of the sidebar (${JSON.stringify(s4.tabs)})`);
			await page.screenshot({ path: `${OUT}/s4-${name}-sidebar-torn.png` });

			// S5 (item 5) — long-press Full height ▸ Hide this button; the tab menu then lists Show buttons
			const full = await centreOf(page, '#sidebar-full-right');
			await gesture(page, cdp, full, { x: 0, y: 0 }, { hold: 700, steps: 1 });
			let rows = await menuLabels(page);
			h.check(rows[0] === 'Hide this button', `${name} S5.1 a long-press on Full height opens its menu (${JSON.stringify(rows)})`);
			await tapRow(page, cdp, 'Hide this button');
			const fullShown = await page.evaluate(() => getComputedStyle(document.querySelector('#sidebar-full-right')).display);
			h.check(fullShown === 'none', `${name} S5.2 ...Hide this button hides it (${fullShown})`);
			t = await sideTab();
			await gesture(page, cdp, t, { x: 0, y: 0 }, { hold: 800, steps: 1 });
			rows = await menuLabels(page);
			h.check(rows.includes('Show buttons'), `${name} S5.3 the sidebar tab's long-press menu lists Show buttons (${JSON.stringify(rows)})`);
			await page.screenshot({ path: `${OUT}/s5-${name}-sidebar-show-buttons.png` });
			await closeMenus(page);
			await page.evaluate(() => window.__stores.chromeButtons.showAllChromeButtons());
			await page.waitForTimeout(300);
		}

		// ---- E (item 5) — the dock's own buttons: long-press Minimize ▸ Hide; a dock tab's menu brings it back ----
		const docked = await page.evaluate(async () => {
			const s = window.__stores;
			// close what E does not use, so nothing floats over the dock row (on a folded phone S's windows float;
			// the Flow Code text window would catch the E4 drop)
			s.sceneBudget.statsOpen.set(false);
			s.flowCodeClose.set(true);
			s.explorerClose.set(true);
			s.toastStore.set([]); // an auto-quality card sits over the dock row on a loaded headless page
			await new Promise((r) => setTimeout(r, 300));
			const res = ['objects', 'animation'].map((k) => `${k}:${s.dockMenu.dockTab?.(k)}`);
			if (res[0].endsWith('false')) {
				// a phone keeps the Objects list floating: the Explorer is the second dock tab there
				s.explorerClose.set(false);
				await new Promise((r) => setTimeout(r, 600));
				res.push(`explorer:${s.dockMenu.dockTab?.('explorer')}`);
			}
			await new Promise((r) => setTimeout(r, 1500)); // the flow family's tabs settle late
			return res;
		});
		await page.waitForTimeout(600);
		await page.screenshot({ path: `${OUT}/e0-${name}-dock.png` });
		const floating = await page.evaluate(() => [...document.querySelectorAll('[data-window-key], .tab-strip[data-group-id]')].filter((e) => e.getClientRects().length).map((e) => e.getAttribute('data-window-key') ?? 'group'));
		console.log(`${name} E setup: ${JSON.stringify({ docked, floating })}`);
		const mini = await centreOf(page, '#dock-minimize');
		if (!mini) h.check(name === 'folded', `${name} E0 the dock's own buttons are drawn (phone shell: hidden with the tab row)`);
		else {
			const hit = await page.evaluate(({ x, y }) => {
				const el = document.elementFromPoint(x, y);
				return el?.closest('#dock-minimize') ? 'ok' : `${el?.tagName}#${el?.id}.${el?.className?.toString?.().slice(0, 40)}`;
			}, mini);
			h.check(hit === 'ok', `${name} E0.1 premise: the finger lands on Minimize (${hit})`);
			await gesture(page, cdp, mini, { x: 0, y: 0 }, { hold: 700, steps: 1 });
			const rows = await menuLabels(page);
			h.check(rows[0] === 'Hide this button', `${name} E1 a long-press on the dock's Minimize opens its menu (${JSON.stringify(rows)})`);
			await tapRow(page, cdp, 'Hide this button');
			const disp = await page.evaluate(() => getComputedStyle(document.querySelector('#dock-minimize')).display);
			h.check(disp === 'none', `${name} E2 ...and hides it (${disp})`);
			const dt = await page.evaluate(() => {
				for (const t of document.querySelectorAll('[data-dock-tab]')) {
					const r = t.getBoundingClientRect();
					if (!r.width) continue;
					const x = Math.round(r.x + Math.min(r.width / 2, 30));
					const y = Math.round(r.y + r.height / 2);
					if (document.elementFromPoint(x, y)?.closest('[data-dock-tab]') === t) return { x, y };
				}
				return null;
			});
			h.check(!!dt, `${name} E3.0 premise: a dock tab is under the finger`);
			if (dt) {
				await gesture(page, cdp, dt, { x: 0, y: 0 }, { hold: 800, steps: 1 });
				const r2 = await menuLabels(page);
				h.check(r2.includes('Show buttons'), `${name} E3 a dock tab's long-press menu lists Show buttons (${JSON.stringify(r2)})`);
				await closeMenus(page);
			}
			await page.evaluate(() => window.__stores.chromeButtons.showAllChromeButtons());
			await page.waitForTimeout(300);
			// E4 (item 7) — a long-press + a drag along the dock strip reorders its tabs (touch had no drag at all)
			const order = () => page.evaluate(() => [...document.querySelectorAll('[data-dock-tab]')].filter((t) => t.getClientRects().length).map((t) => t.dataset.dockTab));
			const o0 = await order();
			if (o0.length >= 2) {
				const a = await centreOf(page, `[data-dock-tab="${o0[0]}"]`);
				const b = await page.evaluate((k) => {
					const r = document.querySelector(`[data-dock-tab="${k}"]`).getBoundingClientRect();
					return { x: Math.round(r.right - 4), y: Math.round(r.y + r.height / 2) };
				}, o0[1]);
				await gesture(page, cdp, a, { x: b.x - a.x + 6, y: 0 }, { hold: 420, steps: 8 });
				const o1 = await order();
				h.check(o1.indexOf(o0[0]) > o1.indexOf(o0[1]) && o1.indexOf(o0[1]) >= 0, `${name} E4 a long-press + a drag along the dock strip reorders its tabs (${JSON.stringify({ o0, o1 })})`);
			} else h.check(false, `${name} E4 premise: two dock tabs (${JSON.stringify({ o0, docked })})`);
		}

		h.check((h.pageErrors(P) || []).length === 0, `${name}: no page errors (${(h.pageErrors(P) || []).join(' | ')})`);
		await P.ctx.close();
	}

	// ---- M: desktop mouse, unchanged ----
	{
		const P = await h.setupPage(browser, 'desk', { context: { viewport: { width: 1440, height: 900 } }, storage: STORAGE });
		const page = P.page;
		await makeGroup(page, { x: 300, y: 300 });
		const g0 = await groups(page);
		h.check(g0.length === 1 && !(await centreOf(page, '.tab-strip .ts-grip')), `M0 desktop: one group, no touch grip drawn`);
		const ol = await centreOf(page, '.tab-strip .ts-tab', 'Objects');
		await page.mouse.move(ol.x, ol.y);
		await page.mouse.down();
		await page.mouse.move(ol.x + 40, ol.y + 200, { steps: 10 });
		await page.mouse.up();
		await page.waitForTimeout(300);
		const g = await groups(page);
		h.check(g.length === 1 && g[0].members.length === 2, `M1 desktop: a mouse drag of a group tab still tears it out at once (${JSON.stringify(g.map((x) => x.members))})`);

		// ---- B (item 5): hide a strip button by right-click, get it back from the strip's menu + Settings ----
		const close = await centreOf(page, '.tab-strip .ts-close');
		await page.mouse.click(close.x, close.y, { button: 'right' });
		await page.waitForTimeout(300);
		let rows = await menuLabels(page);
		h.check(rows[0] === 'Hide this button' && rows.includes('Customize buttons…'), `B1 right-click on a strip button opens its menu (${JSON.stringify(rows)})`);
		await page.screenshot({ path: `${OUT}/b1-desk-button-menu.png` });
		await clickRow(page, 'Hide this button');
		const hid = await page.evaluate(() => {
			let v;
			window.__stores.chromeButtons?.hiddenChromeButtons.subscribe((x) => (v = x))();
			const b = document.querySelector('.tab-strip .ts-close');
			return { list: v ?? null, display: b ? getComputedStyle(b).display : 'gone', kept: !!b };
		});
		h.check(hid.display === 'none' && hid.kept && JSON.stringify(hid.list) === '["group.close"]', `B2 Hide this button hides it (kept in the DOM) and records it (${JSON.stringify(hid)})`);
		const add = await page.evaluate(() => [...document.querySelectorAll('.tab-strip button')].filter((b) => getComputedStyle(b).display !== 'none').length);
		h.check(add >= 3, `B3 the strip keeps its tabs and other buttons (${add} visible)`);
		const tabAt = await centreOf(page, '.tab-strip .ts-tab');
		await page.mouse.click(tabAt.x, tabAt.y, { button: 'right' });
		await page.waitForTimeout(300);
		rows = await menuLabels(page);
		h.check(rows.includes('Show buttons'), `B4 the group's menu lists "Show buttons" while one is hidden (${JSON.stringify(rows)})`);
		await hoverRow(page, 'Show buttons');
		if (!(await menuLabels(page)).includes('Close all tabs')) await clickRow(page, 'Show buttons');
		const sub = await menuLabels(page);
		await clickRow(page, 'Close all tabs');
		const back = await page.evaluate(() => getComputedStyle(document.querySelector('.tab-strip .ts-close')).display);
		h.check(back !== 'none', `B5 Show buttons ▸ Close all tabs brings it back (${back}; rows ${JSON.stringify(sub)})`);
		// Settings ▸ Customize buttons switches it off and on
		await page.evaluate(() => {
			const s = window.__stores;
			s.settingsSection?.set?.('interface');
			s.settingsSearchSeed?.set?.('Customize buttons');
			s.settingsOpen?.set?.(true);
		});
		await page.waitForTimeout(900);
		const row = await page.evaluate(() => !!document.querySelector('#row-chrome-buttons #cb-toggle-group-close'));
		h.check(row, `B6 Settings ▸ Customize buttons lists the strip buttons`);
		const flip = async () => {
			await page.evaluate(() => {
				const t = /** @type {HTMLElement|null} */ (document.querySelector('#cb-toggle-group-close'));
				t?.scrollIntoView({ block: 'center' });
				t?.click();
			});
		};
		if (row) {
			await flip();
			await page.waitForTimeout(300);
			const off = await page.evaluate(() => getComputedStyle(document.querySelector('.tab-strip .ts-close')).display + ' ' + document.querySelector('#cb-toggle-group-close')?.getAttribute('aria-pressed'));
			await page.screenshot({ path: `${OUT}/b6-desk-settings.png` });
			await flip();
			await page.waitForTimeout(300);
			const on = await page.evaluate(() => getComputedStyle(document.querySelector('.tab-strip .ts-close')).display + ' ' + document.querySelector('#cb-toggle-group-close')?.getAttribute('aria-pressed'));
			h.check(off.startsWith('none') && !on.startsWith('none'), `B7 the Settings switch hides and shows it (${off} -> ${on})`);
			// the same two surfaces in the LIGHT theme (the shots above are dark)
			await page.evaluate(() => window.__stores.themes?.theme.set('light'));
			await flip();
			await page.waitForTimeout(500);
			await page.screenshot({ path: `${OUT}/b8-desk-settings-light.png` });
			await flip();
			await page.evaluate(() => window.__stores.settingsOpen?.set?.(false));
			await page.waitForTimeout(500);
			const c2 = await centreOf(page, '.tab-strip .ts-close');
			await page.mouse.click(c2.x, c2.y, { button: 'right' });
			await page.waitForTimeout(400);
			const lightRows = await menuLabels(page);
			const light = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
			await page.screenshot({ path: `${OUT}/b8-desk-button-menu-light.png` });
			h.check(light === 'light' && lightRows[0] === 'Hide this button', `B8 the button menu in the light theme (${light}, ${JSON.stringify(lightRows)})`);
			await closeMenus(page);
			await page.evaluate(() => window.__stores.themes?.theme.set('dark'));
		}
		await P.ctx.close();
	}

	await h.finish(browser);
});
