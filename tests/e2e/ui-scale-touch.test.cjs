// phone-polish (owner ruling 2026-11-05): BIGGER UI = the EXISTING interface scale (Settings ▸ Accessibility,
// 90-150 %), not a second setting. On the unfolded phone at 130 % the dock strip, the sidebar tab strip, a menu row,
// a window's ✕ and the Controls bar grow by the scale, and nothing collides: the sidebar tab fits its strip, the
// dock strip's controls stay clear of the Controls bar, menus stay on screen.
const h = require('./helpers.cjs');
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

const measure = (page) =>
	page.evaluate(() => {
		const R = (sel) => {
			const e = [...document.querySelectorAll(sel)].find((x) => x.getClientRects().length && x.getBoundingClientRect().height > 0);
			const r = e?.getBoundingClientRect();
			return r ? { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) } : null;
		};
		const pill = R('#controls-pill');
		const stripHits = [...document.querySelectorAll('.dt-row button, .dt-chrome button')].filter((b) => {
			const r = b.getBoundingClientRect();
			return pill && r.width && r.right > pill.l && r.left < pill.r && r.bottom > pill.t && r.top < pill.b;
		}).length;
		return {
			dockStrip: R('.dt-bar.tp-dtabs-slim'),
			dockTab: R('.dt-row .tp-dtab'),
			pill,
			stripHits,
			objClose: R('#object-list .wc-close, #object-list [aria-label^="Close"]'),
			sbStripH: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sb-strip-h')) || 0,
			sbTab: R('[data-sidebar-tab], .sb-tab, .sidebar-strip [role=tab]'),
			logo: R('#logo-menu')
		};
	});

h.run(async () => {
	const browser = await h.launch();
	const P = await h.setupPage(browser, 'scale', { context: { hasTouch: true, isMobile: true, deviceScaleFactor: 2.6, viewport: { width: 718, height: 587 } } });
	const page = P.page;
	const open = async () => {
		await page.evaluate(() => {
			window.__stores.explorerClose.set(false);
			window.__stores.bottomDock.dockMinimized.set(false);
			window.__stores.objectListClose.set(false);
			window.__stores.inspectorClose.set(false);
		});
		await nap(1500);
	};
	await open();
	const a = await measure(page);
	await page.evaluate(() => window.__stores.uiScale.uiScale.set(130));
	await nap(2000);
	await open();
	const b = await measure(page);
	console.log(JSON.stringify({ at100: a, at130: b }));
	const grew = (k) => a[k] && b[k] && b[k].h >= a[k].h * 1.2;
	h.check(grew('dockStrip'), `130 %: the dock strip grows (${a.dockStrip?.h} → ${b.dockStrip?.h})`);
	h.check(grew('pill'), `130 %: the Controls bar grows (${a.pill?.h} → ${b.pill?.h})`);
	h.check(grew('objClose'), `130 %: a window's ✕ grows (${a.objClose?.h} → ${b.objClose?.h})`);
	h.check(b.sbStripH >= a.sbStripH * 1.2, `130 %: the sidebar tab strip grows (${a.sbStripH} → ${b.sbStripH})`);
	h.check(b.stripHits === 0, `130 %: no dock-strip control sits under the Controls bar (${b.stripHits})`);
	h.check(!b.dockTab || !b.dockStrip || b.dockTab.h <= b.dockStrip.h + 1, `130 %: a dock tab fits its strip (${b.dockTab?.h} in ${b.dockStrip?.h})`);
	// HONOR 718 x 587 at 130 %: the default dock (320 px scaled) pushed the bar into the logo / undo row
	h.check(!!b.logo && !!b.pill && b.pill.t >= b.logo.b, `130 %: the Controls bar stays below the top row (bar top ${b.pill?.t}, logo bottom ${b.logo?.b})`);

	// a menu at 130 %: the Add menu stays on the screen
	await page.evaluate(() => { window.__stores.explorerClose.set(true); window.__stores.objectListClose.set(true); window.__stores.inspectorClose.set(true); });
	await nap(600);
	await page.locator('#mobile-add-button').first().tap();
	await nap(900);
	const m = await page.evaluate(() => {
		const e = document.querySelector('[role=menu]');
		const r = e?.getBoundingClientRect();
		const row = e?.querySelector('[role=menuitem]')?.getBoundingClientRect();
		return r ? { t: Math.round(r.top), b: Math.round(r.bottom), vh: innerHeight, row: row ? Math.round(row.height) : 0 } : null;
	});
	h.check(!!m && m.t >= -1 && m.b <= m.vh + 1, `130 %: the Add menu stays on screen (${JSON.stringify(m)})`);
	await page.screenshot({ path: `${process.env.SHOT_DIR || 'test-results'}/ui-scale-130-add.png` }).catch(() => {});
	await page.evaluate(() => window.__stores.uiScale.uiScale.set(100));
	await h.closePeer(P);
	await h.finish(browser);
});
