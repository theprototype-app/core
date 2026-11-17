// 45 N8 — the user's preview-1-35 review:
//   'visual minor UI bug: when dock toolbar opened and no tabs to the left of "+" weird remnant of tabs'
// Cause: DockTabs drew its tab BAR (`.dt-bar`: the inset surface, a 1px border, 1px padding — 4px wide
// with nothing in it) even with no tab, so the empty dock (T, 44 M5) showed a sliver of "tabs" left of
// its "+".
//
//   1  desktop, every built-in theme: T opens the empty dock; nothing tab-like is painted left of the
//      "+" (no visible bar box, and the pixel strip between the dock's left edge and "+" is the
//      viewport, not the strip); shots per theme
//   2  the dock with a tab: the bar is back, holds the tab, and "+" follows it (the control)
//   3  unfolded phone (touch): the empty dock's strip, the same
//
// Counterfactual (origin/feat/44-int): §1/§3 red — a 4×24 px bar at the dock's left edge in every theme.
// Run: APP_URL=https://theprototype.app:5452/ npm run e2e -- dock-strip-empty
const h = require('./helpers.cjs');
const OUT = process.env.OUT || '/tmp';

const DESK = { viewport: { width: 1440, height: 900 } };
const UNFOLD = { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 };
const THEMES = ['dark', 'light', 'green', 'bit8', 'contrast'];
const S = (page, fn, arg) => page.evaluate(fn, arg);

async function pressT(page) {
	await S(page, () => document.activeElement instanceof HTMLElement && document.activeElement.blur());
	await page.mouse.move(700, 300);
	await page.keyboard.press('t');
	await page.waitForTimeout(700);
}
/** what the strip left of the visible "+" looks like */
const strip = (page) =>
	S(page, () => {
		const row = [...document.querySelectorAll('.dt-row')].find((r) => r.getBoundingClientRect().width > 0);
		const plus = row?.querySelector('#dock-add-view');
		if (!row || !plus) return null;
		const p = plus.getBoundingClientRect();
		const bars = [...row.querySelectorAll('.dt-bar')].map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
		// a probe one pixel row through the middle of the strip, from the row's left edge up to the "+" pill
		const y = Math.round(p.top + p.height / 2);
		const left = Math.round(row.getBoundingClientRect().left);
		const hits = [];
		// (up to the "+" pill's own wrapper: a theme may give it a border — bit8's is 2px)
		const wrapLeft = (plus.parentElement ?? plus).getBoundingClientRect().left;
		for (let x = left; x < Math.ceil(wrapLeft); x++) {
			const el = document.elementFromPoint(x, y);
			if (el && el.closest('.dt-row') && !el.contains(plus) && !plus.contains(el)) hits.push(x + ':' + el.className.toString().slice(0, 40));
		}
		return {
			tabs: row.querySelectorAll('[data-dock-tab]').length,
			bars: bars.map((r) => [Math.round(r.left), Math.round(r.width), Math.round(r.height)]),
			stripPx: hits.length,
			hits: hits.slice(0, 3),
			wrapLeft,
			plusLeft: Math.round(p.left),
			rowLeft: left
		};
	});

async function setTheme(page, id) {
	await S(page, (id) => window.__tp.test.v1.themes.theme.set(id), id);
	await page.waitForTimeout(300);
}
async function clipRow(page, name) {
	const r = await S(page, () => {
		const row = [...document.querySelectorAll('.dt-row')].find((x) => x.getBoundingClientRect().width > 0);
		const b = row?.getBoundingClientRect();
		return b ? { x: b.left, y: b.top, w: b.width, h: b.height } : null;
	});
	if (!r) return;
	await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 0, y: Math.max(0, r.y - 40), width: 360, height: r.h + 90 } });
}

h.run(async () => {
	const browser = await h.launch();
	const D = await h.setupPage(browser, 'desk', { context: DESK, storage: { flowDocked: 'false', explorerDocked: 'false', statsDocked: 'false', chatDocked: 'false' } });
	const page = D.page;

	// ---- 1. the empty dock, every theme ----------------------------------------------------------------
	await pressT(page);
	const empty = await S(page, () => document.querySelector('#phone-dock')?.getAttribute('data-dock-empty') === 'true');
	h.check(empty, '1.0 premise: T opened the EMPTY dock');
	for (const t of THEMES) {
		await setTheme(page, t);
		const s = await strip(page);
		h.check(!!s && s.tabs === 0, `1.${t} premise: the strip has its "+" and no tab (${JSON.stringify(s)})`);
		h.check(!!s && s.bars.length === 0 && s.stripPx === 0, `1.${t} nothing tab-like is painted left of the "+" (${JSON.stringify(s)})`);
		await clipRow(page, `n8-desk-${t}`);
	}
	await setTheme(page, 'dark');

	// ---- 2. the control: a docked view brings the bar back -----------------------------------------------
	await S(page, () => {
		window.__tp.test.v1.explorerDocked?.set?.(true);
		window.__tp.test.v1.explorerClose.set(false);
	});
	await page.waitForTimeout(1200);
	let s = await strip(page);
	if (!s || s.tabs === 0) {
		// the Explorer opened floating on this build: dock it through the W5 seam
		await S(page, () => window.__tp.test.v1.bottomDock.dockModeArm.set({ key: 'explorer', docked: true }));
		await page.waitForTimeout(1200);
		s = await strip(page);
	}
	h.check(!!s && s.tabs === 1 && s.bars.length === 1 && s.plusLeft > s.bars[0][0] + s.bars[0][1] - 2, `2.1 with a tab the bar is back, holds it, and "+" follows it (${JSON.stringify(s)})`);
	await clipRow(page, 'n8-desk-with-tab');
	await D.ctx.close();

	// ---- 3. unfolded phone ----------------------------------------------------------------------------------
	const U = await h.setupPage(browser, 'unfold', { context: UNFOLD, storage: { flowDocked: 'false', explorerDocked: 'false' } });
	await pressT(U.page);
	for (const t of ['dark', 'light']) {
		await setTheme(U.page, t);
		s = await strip(U.page);
		h.check(!!s && s.tabs === 0 && s.bars.length === 0 && s.stripPx === 0, `3.${t} unfolded: the empty dock's strip shows only "+" (${JSON.stringify(s)})`);
		await clipRow(U.page, `n8-unfold-${t}`);
	}

	await h.finish(browser);
});
