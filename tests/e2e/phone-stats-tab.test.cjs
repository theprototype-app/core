// 43 J1 — ON A PHONE, STATISTICS IS A DOCK TAB. The user (preview 1.33): "statistics also as tab in
// mobile view, not its floating window". Like the Objects list (41b H1), the Statistics window is a
// tab of the bottom dock in the phone posture — the dock frame hosts the one window element — and a
// floating window again on a wider screen (or on a phone with Settings ▸ Interface ▸ "Allow undocking
// on touch screens"). Folded OPPO Find N6 (390x844, touch, DPR 2.9), every tap a REAL touch (CDP).
//
// Counterfactual (base = feat/42-int, 1.33.0): More ▸ Statistics opens a floating window over the
// viewport (section 1 red), the dock "+" sheet has no Statistics row, nothing is in the strip.
const h = require('./helpers.cjs');

async function touchApi(page) {
	const cdp = await page.context().newCDPSession(page);
	const tap = async (x, y) => {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
		await new Promise((r) => setTimeout(r, 40));
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	};
	return { tap };
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'folded', {
		context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
		storage: { toursSeen: '{"editor-touch":true,"editor":true}' }
	});
	const P = A.page;
	const touch = await touchApi(P);
	const read = (expr) => P.evaluate(expr);
	const centre = (sel) =>
		P.evaluate((s) => {
			const e = [...document.querySelectorAll(s)].find((x) => x.getClientRects().length > 0);
			if (!e) return null;
			e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			const r = e.getBoundingClientRect();
			return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
		}, sel);
	const tapOn = async (sel, wait = 650) => {
		const c = await centre(sel);
		if (!c) throw new Error('nothing to tap: ' + sel);
		await touch.tap(c.x, c.y);
		await P.waitForTimeout(wait);
	};
	const state = () =>
		read(() => {
			const s = window.__tp?.test.v1;
			const g = (x) => {
				let v;
				x.subscribe((y) => (v = y))();
				return v;
			};
			const r = (q) => {
				const e = document.querySelector(q);
				if (!e) return null;
				const b = e.getBoundingClientRect();
				const cs = getComputedStyle(e);
				return b.width && b.height && cs.display !== 'none' ? { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) } : null;
			};
			return {
				vis: g(s.bottomDock.visibleDockKey),
				min: g(s.bottomDock.dockMinimized),
				tabs: g(s.bottomDock.dockTabs).map((t) => t.key),
				open: g(s.sceneBudget.statsOpen),
				host: document.querySelector('#stats-window')?.getAttribute('data-pd-host') ?? null,
				stats: r('#stats-window'),
				frame: r('#phone-dock'),
				bar: r('#ps-bar'),
				stripTab: !!r('[data-dock-tab="stats"]')
			};
		});
	await read(() => window.__tp.test.v1.toastStore.set([]));

	// ---------- 0. EVERY way in opens it docked, never one floating frame first ----------
	// (the burger menu's "Statistics" and the toolbar's budget badge both just set statsOpen — the
	// orchestrator reconfirmed: on a phone Statistics is a docked window, never a floating one)
	const sampleOpen = async (open) => {
		await P.evaluate(() => {
			window.__floatFrames = 0;
			window.__seenFrames = 0;
			const check = () => {
				const el = document.querySelector('#stats-window');
				if (el && el.getClientRects().length) {
					window.__seenFrames++;
					if (!el.hasAttribute('data-pd-host')) window.__floatFrames++;
				}
			};
			window.__mo = new MutationObserver(check);
			window.__mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-pd-host'] });
			window.__smpOn = true;
			const t = () => {
				if (!window.__smpOn) return;
				check();
				requestAnimationFrame(t);
			};
			requestAnimationFrame(t);
		});
		await open();
		await P.waitForTimeout(900);
		return P.evaluate(() => {
			window.__smpOn = false;
			window.__mo.disconnect();
			return { seen: window.__seenFrames, floating: window.__floatFrames };
		});
	};
	let smp = await sampleOpen(() => read(() => window.__tp.test.v1.sceneBudget.statsOpen.set(true)));
	let d0 = await state();
	h.check(smp.seen > 0 && smp.floating === 0 && d0.host === 'shown' && d0.vis === 'stats', `opened the way the menu / badge do, it is docked from its first frame (${JSON.stringify(smp)}, front ${d0.vis})`);
	await read(() => window.__tp.test.v1.sceneBudget.statsOpen.set(false));
	await P.waitForTimeout(500);
	// the burger menu's own row, where the phone shows it
	const burger = await P.evaluate(() => !!document.querySelector('#logo-menu'));
	if (burger) {
		await tapOn('#logo-menu', 500);
		if (await centre('#open-stats')) {
			smp = await sampleOpen(() => tapOn('#open-stats', 100));
			d0 = await state();
			h.check(smp.seen > 0 && smp.floating === 0 && d0.host === 'shown', `burger menu ▸ Statistics opens it docked too (${JSON.stringify(smp)})`);
			await read(() => window.__tp.test.v1.sceneBudget.statsOpen.set(false));
			await P.waitForTimeout(500);
		} else await read(() => window.__tp.test.v1.closeMenu.set(true));
	}
	h.check((await read(() => localStorage.getItem('mobileUndockAllowed'))) !== 'true', 'premise: "Allow undocking on touch screens" is off by default');

	// ---------- 1. More ▸ Statistics opens a TAB of the dock, not a floating window ----------
	smp = await sampleOpen(async () => {
		await tapOn('#ps-more', 500);
		await tapOn('#ps-tile-stats', 100);
	});
	let d = await state();
	h.check(smp.floating === 0, `More ▸ Statistics never shows a floating frame (${JSON.stringify(smp)})`);
	h.check(d.open && d.vis === 'stats' && d.tabs.includes('stats'), `More ▸ Statistics opens the "Statistics" dock tab, in front (${JSON.stringify({ vis: d.vis, tabs: d.tabs })})`);
	h.check(d.host === 'shown' && !!d.stats && !!d.frame && d.stats.top >= d.frame.top - 1 && Math.abs(d.stats.bottom - d.bar.top) <= 2, `the Statistics window sits in the dock frame, down to the bar (${JSON.stringify({ stats: d.stats, frame: d.frame, bar: d.bar })})`);
	h.check(d.stats && d.stats.left <= 1 && d.stats.right >= 389, `...the full width of the phone (${JSON.stringify(d.stats)})`);
	h.check(d.stripTab, 'the dock strip shows a Statistics tab');
	const rows = await read(() => [...document.querySelectorAll('#stats-budgets [data-budget]')].length);
	h.check(rows > 0, `the tab shows the budget rows (${rows})`);

	// ---------- 2. it shares the strip: another tab in front, Statistics stays open behind ----------
	await tapOn('#ps-objects', 900);
	d = await state();
	h.check(d.vis === 'objects' && d.open && d.host === 'hidden' && d.tabs.includes('stats'), `Objects in front, Statistics a hidden open tab (${JSON.stringify({ vis: d.vis, host: d.host })})`);
	await tapOn('[data-dock-tab="stats"]', 700);
	d = await state();
	h.check(d.vis === 'stats' && d.host === 'shown', `its tab brings it back to the front (${d.vis})`);

	// ---------- 3. H5: the bar item on the tab in front minimizes the dock, again brings it back ----------
	await tapOn('#ps-more', 500);
	await tapOn('#ps-tile-stats', 700);
	d = await state();
	h.check(d.min && d.open, `Statistics in front: its item minimizes the dock, the tab stays open (min ${d.min})`);
	await tapOn('#ps-more', 500);
	await tapOn('#ps-tile-stats', 700);
	d = await state();
	h.check(!d.min && d.vis === 'stats', `and brings it back (min ${d.min}, front ${d.vis})`);

	// ---------- 4. the dock "+" sheet lists it; the tab's ✕ closes it ----------
	await tapOn('#dock-add-view', 900);
	const sheetRows = await read(() => [...document.querySelectorAll('#dock-views-sheet [data-dock-view]')].map((e) => e.dataset.dockView));
	h.check(sheetRows.includes('stats'), `the dock "+" sheet lists Statistics (${sheetRows.join(',')})`);
	await read(() => document.querySelector('#dock-views-sheet')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
	await P.waitForTimeout(400);
	if (await read(() => !!document.querySelector('#dock-views-sheet'))) {
		const scrim = await centre('.sheet-scrim, .tp-sheet-scrim, [data-sheet-scrim]');
		if (scrim) await touch.tap(scrim.x, 20);
		await P.waitForTimeout(400);
	}
	await tapOn('[data-dock-tab-close="stats"]', 700);
	d = await state();
	h.check(!d.open && !d.tabs.includes('stats') && !d.stats, `the tab's ✕ closes Statistics (${JSON.stringify({ open: d.open, tabs: d.tabs })})`);

	// ---------- 5. unfold: a floating window again; fold: a tab again ----------
	await read(() => window.__tp.test.v1.sceneBudget.statsOpen.set(true));
	await P.waitForTimeout(600);
	await P.setViewportSize({ width: 770, height: 850 });
	await P.waitForTimeout(1200);
	d = await state();
	h.check(d.open && d.host === null && !!d.stats && !d.tabs.includes('stats'), `unfolded, Statistics is its floating window (${JSON.stringify({ host: d.host, tabs: d.tabs, stats: d.stats })})`);
	await P.setViewportSize({ width: 390, height: 844 });
	await P.waitForTimeout(1200);
	d = await state();
	h.check(d.open && d.tabs.includes('stats') && d.host !== null, `folded again, it is a dock tab again (${JSON.stringify({ host: d.host, tabs: d.tabs })})`);

	// ---------- 6. "Allow undocking on touch screens": the phone keeps the floating window ----------
	await read(() => window.__tp.test.v1.mobileUndockAllowed.set(true));
	await P.waitForTimeout(800);
	d = await state();
	h.check(d.open && d.host === null && !d.tabs.includes('stats'), `with undocking allowed it floats on the phone too (${JSON.stringify({ host: d.host, tabs: d.tabs })})`);
	await read(() => window.__tp.test.v1.mobileUndockAllowed.set(false));
	await P.waitForTimeout(500);

	await h.finish(browser);
});
