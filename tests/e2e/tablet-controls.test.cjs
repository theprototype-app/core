// phone-polish item 4 — TABLET WIDTH: the Properties column and the Controls bar never share pixels.
//
// HONOR unfolded (718 x 587, coarse pointer): a column that is NOT pinned ends above the Controls band
// (its bottom is --controls-inset); a PINNED column runs to the floor, so the bar moves over and centres
// in the width that is left instead of sitting at the screen's middle under the column.
const h = require('./helpers.cjs');
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

const look = (page) =>
	page.evaluate(() => {
		const col = [...document.querySelectorAll("#inspector, [data-sidebar-side='right'], [data-docked='right']")].find((e) => e.getClientRects().length && e.getBoundingClientRect().width > 0);
		const pill = document.querySelector('#controls-pill');
		const c = col?.getBoundingClientRect();
		const p = pill?.getBoundingClientRect();
		return {
			W: innerWidth,
			col: c ? { l: Math.round(c.left), t: Math.round(c.top), b: Math.round(c.bottom) } : null,
			pill: p ? { l: Math.round(p.left), r: Math.round(p.right), t: Math.round(p.top), b: Math.round(p.bottom) } : null
		};
	});

h.run(async () => {
	const browser = await h.launch();
	for (const vp of [{ width: 718, height: 587 }, { width: 1024, height: 700 }]) {
		const tag = (t) => `[${vp.width}] ${t}`;
		const P = await h.setupPage(browser, `tablet-${vp.width}`, { context: { hasTouch: true, isMobile: true, deviceScaleFactor: 2, viewport: vp } });
		const page = P.page;
		// a box selected → the Properties column on the right
		await page.evaluate(() => window.__stores.inspectorClose.set(false));
		await h.eventually(() => look(page), (s) => !!s.col && !!s.pill, tag('premise: the right column and the Controls bar are up'));
		await nap(800);

		// 1. not pinned: the column stops above the bar's band
		let s = await look(page);
		h.check(!!s.col && !!s.pill && s.col.b <= s.pill.t + 1, tag(`not pinned: the column ends above the Controls bar (${JSON.stringify(s)})`));

		// 2. pinned full height: the bar leaves the column's width and centres in what is left
		await page.evaluate(() => window.__stores.sidebars.toggleSidebarFull('right', true));
		await nap(1200);
		s = await look(page);
		h.check(!!s.col && !!s.pill && s.pill.r <= s.col.l + 1, tag(`pinned: the bar ends left of the column (${JSON.stringify(s)})`));
		const free = s.col ? s.col.l / 2 : 0;
		const mid = s.pill ? (s.pill.l + s.pill.r) / 2 : 0;
		// centred in the free width — unless the left corner buttons on its row push it right (the track's min)
		const tr = await page.evaluate(() => window.__toolbarTrack ?? null);
		h.check(!!s.pill && (Math.abs(mid - free) <= 12 || (tr && Math.abs(mid - tr.min) <= 2)), tag(`pinned: the bar centres in the free width (centre ${mid}, free middle ${free}, track ${JSON.stringify(tr && { min: Math.round(tr.min), max: Math.round(tr.max) })})`));

		// 3. unpinned again: back to the screen's middle
		await page.evaluate(() => window.__stores.sidebars.toggleSidebarFull('right', false));
		await nap(1200);
		s = await look(page);
		const mid2 = s.pill ? (s.pill.l + s.pill.r) / 2 : 0;
		h.check(!!s.pill && Math.abs(mid2 - s.W / 2) <= 12, tag(`unpinned: the bar is back in the middle (${mid2} vs ${s.W / 2})`));
		await h.closePeer(P);
	}
	await h.finish(browser);
});
