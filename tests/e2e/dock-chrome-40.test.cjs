// 40-docks — roadmap 40 F6-F11, the user's 1.31 review of the dock and window chrome.
//
//   F6  docked tab strips: every tab sits on the strip's own paint when scrolled (tabs past
//       the 3rd used to show the scene through — transparent-tab-header), and picking a tab
//       never resets the strip's scroll position (a fresh strip per panel started at 0)
//   F7  a long object name never breaks a window header (B2ack-wall-super): one line, "…",
//       full name on hover/long-press, out of the control row on a phone-narrow editor
//   F8  docked windows carry no ✕ (tabs do); undock sits left of "minimize the dock" and
//       undocks the ACTIVE tab (Settings: all as one tabbed group); a floating group's dock
//       button docks ALL its tabs
//   F9  "+" on a phone (floating windows off) = a sheet of every window with show/hide
//       switches; with floating windows on, a phone behaves like the desktop
//   F10 a docked tab dropped onto a floating window JOINS it as a tab; a group member never
//       jumps off its group (and its tab strip) after grouping or a tab switch
//   F11 the Layouts dialog is the kit modal: opaque, sized, Escape closes
//
// Phone gestures are TOUCH (a hasTouch/isMobile context, locator.tap + touchscreen); desktop
// gestures are a real mouse. Run: APP_URL='https://theprototype.app:5393/' npm run e2e -- dock-chrome-40
const h = require('./helpers.cjs');

const VIEWS = ['flow', 'flowcode', 'animation', 'uv', 'shader', 'hud', 'explorer', 'profiler'];
const CLOSERS = { flow: 'flowGraphClose', flowcode: 'flowCodeClose', animation: 'animationClose', uv: 'uvEditorClose', shader: 'shaderEditorClose', hud: 'hudEditorClose', explorer: 'explorerClose', profiler: 'profilerClose' };
const DOCKED_KEYS = { flowDocked: 'true', flowCodeDocked: 'true', animationDocked: 'true', uvDocked: 'true', shaderDocked: 'true', hudDocked: 'true', explorerDocked: 'true', profilerDocked: 'true', codeDocked: 'true' };
const STRIP = '.dt-scroll';
const LONG = 'B2ack wall super — the long name of an imported wall piece.glb';

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

/** open every dock view, docked, and show `active` */
async function openAll(page, active) {
	await page.evaluate(({ VIEWS, CLOSERS, active }) => {
		const s = window.__stores;
		for (const v of VIEWS) s[CLOSERS[v]].set(false);
		setTimeout(() => s.bottomDock.activateDock(active), 400);
	}, { VIEWS, CLOSERS, active });
	await page.waitForTimeout(1800);
}

/** the strip of the panel on screen: its scroll, sizes, and the paint under each visible tab */
const stripState = (page) =>
	page.evaluate((sel) => {
		const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent);
		if (!el) return null;
		const sr = el.getBoundingClientRect();
		const tabs = [...el.querySelectorAll('[data-dock-tab]')].map((t) => {
			const r = t.getBoundingClientRect();
			// the nearest ancestor that PAINTS (an opaque background) — the tab's own pill is
			// transparent unless active, so this is what shows through around its label
			let a = t.parentElement;
			while (a && a !== document.body) {
				const bg = getComputedStyle(a).backgroundColor;
				if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) break;
				a = a.parentElement;
			}
			const pr = a?.getBoundingClientRect();
			const visible = r.right > sr.left + 1 && r.left < sr.right - 1;
			// only the part of the tab the strip actually shows has to be painted
			const l = Math.max(r.left, sr.left);
			const rt = Math.min(r.right, sr.right);
			const painted = !!pr && pr.left <= l + 1 && pr.right >= rt - 1 && pr.top <= r.top + 1 && pr.bottom >= r.bottom - 1;
			return { key: t.dataset.dockTab, visible, painted, cx: Math.round((l + rt) / 2), cy: Math.round((r.top + r.bottom) / 2), selected: t.getAttribute('aria-selected') === 'true' };
		});
		return { scroll: Math.round(el.scrollLeft), width: el.clientWidth, full: el.scrollWidth, maskOnScroller: getComputedStyle(el).maskImage !== 'none', scrollerBg: getComputedStyle(el).backgroundColor, tabs };
	}, STRIP);

h.run(async () => {
	const browser = await h.launch();

	// =====================================================================================
	// F6 — PHONE: the strip, scrolled, then a tab picked by a TAP
	// =====================================================================================
	{
		const P = await h.setupPage(browser, 'phone', { context: PHONE, storage: DOCKED_KEYS });
		const page = P.page;
		await openAll(page, 'flow');
		const s0 = await stripState(page);
		h.check(!!s0 && s0.full > s0.width + 40, `F6 premise: eight docked views overflow the phone strip (${s0 && s0.width}/${s0 && s0.full})`);
		// scroll to the far end the way a finger does: a touch drag across the strip
		await page.evaluate((sel) => {
			const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent);
			el.scrollLeft = el.scrollWidth;
			el.dispatchEvent(new Event('scroll'));
		}, STRIP);
		await page.waitForTimeout(300);
		const s1 = await stripState(page);
		const shown = s1.tabs.filter((t) => t.visible);
		h.check(s1.scroll > 100, `F6 premise: the strip is scrolled (${s1.scroll}px)`);
		h.check(
			shown.length >= 2 && shown.every((t) => t.painted),
			`F6.1 every tab on screen sits on the strip's own paint when scrolled — none shows the scene through (${shown.map((t) => t.key + ':' + t.painted).join(' ')})`
		);
		h.check(!s1.scrollerBg || /rgba\(0, 0, 0, 0\)|transparent/.test(s1.scrollerBg), `F6.2 the edge fade masks a BARE scroll box, so it fades into the bar, not into the scene (scroller bg ${s1.scrollerBg})`);
		// pick a visible tab past the 3rd with a TAP
		const tgt = shown.filter((t) => !t.selected && VIEWS.indexOf(t.key) >= 3)[0];
		const target = tgt?.key;
		h.check(!!target, `F6 premise: a tab past the 3rd is on screen to tap (${target})`);
		const scrollBefore = s1.scroll;
		// a finger on the part of the tab that shows (locator.tap would scroll it into view first)
		await page.touchscreen.tap(tgt.cx, tgt.cy);
		await page.waitForTimeout(1200);
		const s2 = await stripState(page);
		h.check(s2.tabs.find((t) => t.key === target)?.selected === true, `F6 premise: the tapped tab is now the active one (${target})`);
		h.check(
			Math.abs(s2.scroll - scrollBefore) <= 2,
			`F6.3 picking a tab never resets the strip's scroll (before ${scrollBefore}px, after ${s2.scroll}px — it used to snap to 0 on the new panel's fresh strip)`
		);
		h.check(s2.tabs.filter((t) => t.visible).every((t) => t.painted), 'F6.4 ...and the tabs on the new panel\'s strip are painted too');

		// ---- F9 — PHONE "+": a sheet of every window with show/hide switches ----------------
		await page.evaluate(() => window.__stores.explorerClose.set(true));
		await page.waitForTimeout(700);
		h.check((await page.locator('#dock-undock:visible').count()) === 0, 'F9.0 a phone whose windows cannot float shows no undock button (nothing to undock to)');
		await page.locator('#dock-add-view:visible').first().tap();
		await page.waitForTimeout(900);
		const sheet = await page.evaluate(() => ({
			open: !!document.querySelector('#dock-views-sheet'),
			rows: [...document.querySelectorAll('[data-dock-view]')].map((r) => r.dataset.dockView),
			menu: !!document.querySelector('[role=menu]')
		}));
		h.check(sheet.open && !sheet.menu, `F9.1 "+" on a phone opens a SHEET, not the desktop menu (${JSON.stringify(sheet)})`);
		const bar = await page.evaluate(() => {
			const sh = document.querySelector('#dock-views-sheet')?.getBoundingClientRect();
			const play = document.querySelector('#play-button')?.getBoundingClientRect();
			const tg = document.querySelector('#dock-view-toggle-explorer')?.getBoundingClientRect();
			return { sheetBottom: sh && Math.round(sh.bottom), playTop: play && Math.round(play.top), toggleRight: tg && Math.round(tg.right), vw: window.innerWidth };
		});
		h.check(!bar.playTop || bar.sheetBottom <= bar.playTop + 30, `F9.1b the sheet ends at the phone bar — Play is not covered (${JSON.stringify(bar)})`);
		h.check(!!bar.toggleRight && bar.toggleRight <= bar.vw, `F9.1c every row's switch is on screen (${JSON.stringify(bar)})`);
		h.check(['flow', 'explorer', 'animation', 'uv', 'shader', 'hud', 'profiler', 'code', 'flowcode'].every((k) => sheet.rows.includes(k)), `F9.2 ...listing EVERY window, the Node editor too (${sheet.rows.join(',')})`);
		const exToggle = page.locator('#dock-view-toggle-explorer');
		h.check((await exToggle.getAttribute('aria-pressed')) === 'false', 'F9.3 a closed window reads OFF');
		await exToggle.tap();
		await page.waitForTimeout(1200);
		const afterOn = await page.evaluate(() => {
			const s = window.__stores;
			let occ, vis, ec;
			s.bottomDock.dockOccupants.subscribe((v) => (occ = v))();
			s.bottomDock.visibleDockKey.subscribe((v) => (vis = v))();
			s.explorerClose.subscribe((v) => (ec = v))();
			return { present: !!occ.explorer?.present, visible: vis, closed: ec };
		});
		h.check(afterOn.present && afterOn.visible === 'explorer' && afterOn.closed === false, `F9.4 switching a window ON opens it in the dock as the visible tab (${JSON.stringify(afterOn)})`);
		h.check((await exToggle.getAttribute('aria-pressed')) === 'true', 'F9.5 ...and its switch reads ON');
		await exToggle.tap();
		await page.waitForTimeout(900);
		h.check((await page.evaluate(() => { let v; window.__stores.explorerClose.subscribe((x) => (v = x))(); return v; })) === true, 'F9.6 switching it OFF closes it');
		await page.touchscreen.tap(195, 270); // the modal sheet's scrim, above the sheet and below the top chrome
		await page.waitForTimeout(600);
		h.check(!(await page.locator('#dock-views-sheet').count()), 'F9.6b a tap on the scrim closes the sheet');
		await page.evaluate(() => window.__stores.mobileUndockAllowed.set(true));
		await page.waitForTimeout(700);
		await page.locator('#dock-add-view:visible').first().tap();
		await page.waitForTimeout(700);
		const desktopLike = await page.evaluate(() => ({ sheet: !!document.querySelector('#dock-views-sheet'), menu: !!document.querySelector('[role=menu]'), undock: [...document.querySelectorAll('#dock-undock')].some((b) => b.offsetParent) }));
		h.check(desktopLike.menu && !desktopLike.sheet && desktopLike.undock, `F9.7 with floating windows enabled a phone behaves like the desktop: the add menu and an undock button (${JSON.stringify(desktopLike)})`);
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
		if (await page.locator('[role=menu]').count()) await page.touchscreen.tap(195, 120);
		await page.evaluate(() => window.__stores.mobileUndockAllowed.set(false));
		await page.waitForTimeout(400);

		// ---- F7 — PHONE: a long name in the docked Animation header -------------------------
		await page.evaluate((LONG) => {
			const s = window.__stores;
			s.commandsHandler.sceneCommand('/create box');
			let g;
			s.objectsGroup.subscribe((x) => (g = x))();
			const obj = g.children[g.children.length - 1];
			obj.name = LONG;
			s.objectsGroup.update((v) => v);
			s.objectActions.selectObject(obj.uuid);
			s.animationClose.set(false);
			s.bottomDock.activateDock('animation');
		}, LONG);
		await page.waitForTimeout(1500);
		const head = await page.evaluate(() => {
			const name = document.querySelector('#animation-dock #animation-target-name');
			const pane = document.querySelector('#animation-dock #animation-pane');
			const nr = name?.getBoundingClientRect();
			const pr = pane?.getBoundingClientRect();
			return {
				lineH: nr ? Math.round(nr.height) : 0,
				cut: name ? name.scrollWidth > name.clientWidth : false,
				title: name?.getAttribute('title'),
				nameBottom: nr ? Math.round(nr.bottom) : 0,
				paneTop: pr ? Math.round(pr.top) : 0,
				paneInside: pr ? pr.right <= window.innerWidth + 1 : false
			};
		});
		h.check(head.lineH > 0 && head.lineH <= 26, `F7.1 the object's name is ONE line in the docked header (${head.lineH}px tall — it wrapped to three lines)`);
		h.check(head.cut, 'F7.2 ...ending in "…" because it does not fit');
		h.check(head.title === LONG, `F7.3 ...with the FULL name on hover (title="${head.title}")`);
		h.check(head.paneTop >= head.nameBottom - 1 && head.paneInside, `F7.4 the name moved OUT of the control row: the pane switch sits below it, inside the screen (${JSON.stringify(head)})`);
		// long-press (touch) shows the full name
		const nb = await page.locator('#animation-dock #animation-target-name').boundingBox();
		const cdp = await page.context().newCDPSession(page);
		const pt = { x: Math.round(nb.x + 30), y: Math.round(nb.y + nb.height / 2) };
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
		await page.waitForTimeout(700);
		const tip = await page.evaluate(() => document.querySelector('.tp-fullname-tip')?.textContent ?? null);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		h.check(tip === LONG, `F7.5 a touch long-press on the name shows the full name (${tip})`);
		await page.waitForTimeout(300);

		// ---- F11 — PHONE: the Layouts dialog ------------------------------------------------
		await page.evaluate(() => window.__stores.uiLayouts.layoutsMenuOpen.set(true));
		await page.waitForTimeout(800);
		const lp = await page.evaluate(() => {
			const el = document.querySelector('#layouts-menu');
			if (!el) return null;
			const cs = getComputedStyle(el);
			const r = el.getBoundingClientRect();
			return { tag: el.tagName, kit: el.classList.contains('md'), bg: cs.backgroundColor, w: Math.round(r.width) };
		});
		h.check(!!lp && lp.tag === 'DIALOG' && lp.kit, `F11.1 the Layouts dialog is the kit modal on a phone (${JSON.stringify(lp)})`);
		h.check(!!lp && /^rgb\(/.test(lp.bg), `F11.2 ...painted with an OPAQUE surface — it rendered see-through (${lp && lp.bg})`);
		await page.keyboard.press('Escape');
		await page.waitForTimeout(400);
		h.check(!(await page.locator('#layouts-menu').count()), 'F11.3 Escape closes it');
		h.check((h.pageErrors(P) || []).length === 0, 'phone: no page errors (' + (h.pageErrors(P) || []).join(' | ') + ')');
		await P.ctx.close();
	}

	// =====================================================================================
	// DESKTOP — F6 (mouse), F8, F10, F11
	// =====================================================================================
	{
		const D = await h.setupPage(browser, 'desktop', { context: { viewport: { width: 760, height: 900 } }, storage: DOCKED_KEYS });
		const page = D.page;
		await openAll(page, 'flow');
		// F6 with a mouse on a narrow desktop window
		await page.evaluate((sel) => {
			const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent);
			el.scrollLeft = el.scrollWidth;
			el.dispatchEvent(new Event('scroll'));
		}, STRIP);
		await page.waitForTimeout(300);
		const d1 = await stripState(page);
		const pick = d1.tabs.filter((t) => t.visible && !t.selected && VIEWS.indexOf(t.key) >= 3)[0];
		await page.mouse.click(pick.cx, pick.cy);
		await page.waitForTimeout(1000);
		const d2 = await stripState(page);
		h.check(d1.scroll > 50 && Math.abs(d2.scroll - d1.scroll) <= 2, `F6.5 desktop: clicking a tab keeps the strip where it was (${d1.scroll} -> ${d2.scroll}px)`);
		h.check(d2.tabs.filter((t) => t.visible).every((t) => t.painted), 'F6.6 desktop: every tab on screen is painted');
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.waitForTimeout(800);

		// ---- F8 — the docked chrome ---------------------------------------------------------
		await page.evaluate(() => window.__stores.bottomDock.activateDock('animation'));
		await page.waitForTimeout(700);
		const chrome = await page.evaluate(() => {
			const panel = document.querySelector('#animation-dock');
			const inside = [...panel.querySelectorAll('button')].filter((b) => b.offsetParent && !b.closest('.dt-row') && !b.closest('#dock-undock') && /^(Close|Undock)/i.test(b.getAttribute('aria-label') ?? ''));
			const und = [...document.querySelectorAll('#dock-undock')].find((b) => b.offsetParent);
			const min = [...document.querySelectorAll('#dock-minimize')].find((b) => b.offsetParent);
			const ur = und?.getBoundingClientRect();
			const mr = min?.getBoundingClientRect();
			return { inside: inside.map((b) => b.getAttribute('aria-label')), und: !!ur, leftOfMin: !!ur && !!mr && ur.right <= mr.left + 1 && Math.abs(ur.top - mr.top) < 4, tabX: !!panel.querySelector('[data-dock-tab-close="animation"]') };
		});
		h.check(chrome.inside.length === 0, `F8.1 a docked window carries no ✕ and no undock inside it (${chrome.inside.join(',')})`);
		h.check(chrome.tabX, 'F8.2 ...its TAB carries the ✕');
		h.check(chrome.und && chrome.leftOfMin, `F8.3 undock sits left of "minimize the dock" (${JSON.stringify(chrome)})`);
		// the setting row exists in Settings ▸ Interface
		await page.evaluate(() => {
			window.__stores.settingsSection.set('interface');
			window.__stores.settingsOpen.set(true);
		});
		await page.waitForTimeout(900);
		h.check((await page.locator('#row-undock-button').count()) === 1, 'F8.4 Settings ▸ Interface carries the "Undock button" row');
		await page.evaluate(() => window.__stores.settingsOpen.set(false));
		await page.waitForTimeout(500);
		// default: undock the ACTIVE window only
		await page.locator('#dock-undock:visible').first().click();
		await page.waitForTimeout(1400);
		const one = await page.evaluate(() => {
			let occ;
			window.__stores.bottomDock.dockOccupants.subscribe((v) => (occ = v))();
			return { animWin: !!document.querySelector('#animation-window'), stillDocked: Object.keys(occ).filter((k) => occ[k]?.present).sort() };
		});
		h.check(one.animWin && !one.stillDocked.includes('animation') && one.stillDocked.length >= 6, `F8.5 the default undocks the ACTIVE window only (${JSON.stringify(one)})`);

		// ---- F10 — drop a docked tab INTO that floating window: it joins as a tab ----------
		await page.evaluate(() => window.__stores.bottomDock.activateDock('uv'));
		await page.waitForTimeout(800);
		// the window floats where it last was, over the dock strip — carry it up by its header
		// first, or the press lands on the window instead of the tab
		const hb = await page.locator('#animation-window .move-handle').first().boundingBox();
		await page.mouse.move(hb.x + 60, hb.y + hb.height / 2);
		await page.mouse.down();
		await page.mouse.move(hb.x + 260, 70, { steps: 8 });
		await page.mouse.up();
		await page.waitForTimeout(600);
		const tabBox = await page.locator('[data-dock-tab="uv"]:visible').first().boundingBox();
		const winBox = await page.locator('#animation-window').boundingBox();
		await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
		await page.mouse.down();
		await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y - 40, { steps: 6 });
		await page.mouse.move(winBox.x + winBox.width / 2, winBox.y + winBox.height / 2, { steps: 12 });
		const lit = await page.evaluate(() => document.querySelector('#animation-window')?.classList.contains('merge-target'));
		await page.mouse.up();
		await page.waitForTimeout(1600);
		h.check(lit === true, 'F10.1 dragging a docked tab over a floating window lights it as the drop target');
		const grouped = await page.evaluate(() => {
			let g;
			window.__stores.windowTabs.tabGroups.subscribe((v) => (g = v))();
			return g.map((x) => ({ members: x.members, active: x.active }));
		});
		h.check(grouped.some((x) => x.members.includes('animation') && x.members.includes('uv')), `F10.2 ...and the drop JOINS it as a tab instead of a second floating window (${JSON.stringify(grouped)})`);
		// a member never jumps off its group: switch tabs both ways, then compare the windows to the strip
		const attached = () =>
			page.evaluate(() => {
				let g;
				window.__stores.windowTabs.tabGroups.subscribe((v) => (g = v))();
				const grp = g.find((x) => x.members.includes('uv'));
				if (!grp) return { active: null, strip: null, win: [0, 0] };
				const strip = document.querySelector('.tab-strip')?.getBoundingClientRect();
				const node = document.querySelector(grp.active === 'uv' ? '#uv-window' : '#animation-window').getBoundingClientRect();
				return { active: grp.active, strip: strip && [Math.round(strip.left), Math.round(strip.top)], win: [Math.round(node.left), Math.round(node.top)] };
			});
		const same = (a) => !!a.strip && Math.abs(a.strip[0] - a.win[0]) <= 2 && Math.abs(a.strip[1] - a.win[1]) <= 2;
		const a1 = await attached();
		await page.locator('.tab-strip .ts-tab', { hasText: 'Animation' }).click();
		await page.waitForTimeout(900);
		const a2 = await attached();
		await page.locator('.tab-strip .ts-tab', { hasText: 'UV editor' }).click();
		await page.waitForTimeout(900);
		const a3 = await attached();
		h.check(same(a1), `F10.3 right after grouping, the window sits under its tab strip (${JSON.stringify(a1)})`);
		h.check(same(a2) && same(a3), `F10.4 ...and after switching tabs both ways it still does — no drag needed to recover (${JSON.stringify([a2, a3])})`);

		// ---- F8 — the floating group's dock button docks ALL its tabs ----------------------
		const dockBtn = await page.evaluate(() => {
			const b = document.querySelector('.tab-strip .ts-dock')?.getBoundingClientRect();
			const c = document.querySelector('.tab-strip .ts-close')?.getBoundingClientRect();
			return { has: !!b, leftOfClose: !!b && !!c && b.right <= c.left + 1 };
		});
		h.check(dockBtn.has && dockBtn.leftOfClose, `F8.6 a floating tabbed group has a dock button left of "close all tabs" (${JSON.stringify(dockBtn)})`);
		await page.locator('.tab-strip .ts-dock').click();
		await page.waitForTimeout(1600);
		const back = await page.evaluate(() => {
			let occ, g;
			window.__stores.bottomDock.dockOccupants.subscribe((v) => (occ = v))();
			window.__stores.windowTabs.tabGroups.subscribe((v) => (g = v))();
			return { anim: !!occ.animation?.present, uv: !!occ.uv?.present, groups: g.length, windows: !!document.querySelector('#animation-window, #uv-window') };
		});
		h.check(back.anim && back.uv && back.groups === 0 && !back.windows, `F8.7 ...which docks EVERY tab of it (${JSON.stringify(back)})`);

		// ---- F8 — Settings "all as one tabbed group" ---------------------------------------
		await page.evaluate(() => window.__stores.bottomDock.undockButtonMode.set('group'));
		await page.waitForTimeout(300);
		const nDocked = await page.evaluate(() => { let t; window.__stores.bottomDock.dockTabs.subscribe((v) => (t = v))(); return t.length; });
		await page.locator('#dock-undock:visible').first().click();
		await page.waitForTimeout(nDocked * 700 + 2500);
		const all = await page.evaluate(() => {
			let occ, g;
			window.__stores.bottomDock.dockOccupants.subscribe((v) => (occ = v))();
			window.__stores.windowTabs.tabGroups.subscribe((v) => (g = v))();
			return { docked: Object.keys(occ).filter((k) => occ[k]?.present), groups: g.map((x) => x.members.length) };
		});
		h.check(all.docked.length === 0 && all.groups.length === 1 && all.groups[0] === nDocked, `F8.8 "all as one tabbed group": every docked tab leaves as ONE floating window with a tab each (${nDocked} tabs -> ${JSON.stringify(all)})`);
		await page.evaluate(() => window.__stores.bottomDock.undockButtonMode.set('active'));

		// ---- F11 — DESKTOP: the Layouts dialog ----------------------------------------------
		await page.evaluate(() => window.__stores.uiLayouts.layoutsMenuOpen.set(true));
		await page.waitForTimeout(800);
		const ld = await page.evaluate(() => {
			const el = document.querySelector('#layouts-menu');
			const r = el?.getBoundingClientRect();
			return el ? { tag: el.tagName, bg: getComputedStyle(el).backgroundColor, w: Math.round(r.width) } : null;
		});
		h.check(!!ld && ld.tag === 'DIALOG' && /^rgb\(/.test(ld.bg) && ld.w <= 482 && ld.w >= 300, `F11.4 desktop: the kit modal, opaque, a dialog-sized box (${JSON.stringify(ld)})`);
		await page.keyboard.press('Escape');
		await page.waitForTimeout(400);
		h.check(!(await page.locator('#layouts-menu').count()), 'F11.5 Escape closes it');
		h.check((h.pageErrors(D) || []).length === 0, 'desktop: no page errors (' + (h.pageErrors(D) || []).join(' | ') + ')');
	}
	await h.finish(browser);
});
