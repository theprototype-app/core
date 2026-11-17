// 43-int — THE CONNECT PILL KEEPS CLEAR OF THE CORNERS WHEN A SIDEBAR IS PINNED, HOWEVER SLOW THE SLIDE.
// Pinning a full-height sidebar slides that corner's buttons inward (a 0.2 s `left`/`right` transition on
// .burger / .top-right-chrome) and the Connect pill re-measures its walls (43 K4) on a 260 ms timer. On a
// busy box the slide outlasts the timer, the walls were read MID-slide, and nothing measured again (a
// ResizeObserver never fires for a box that only moves) — so the pill stayed centred on the old walls, over
// the notes / bell / profile buttons (43-controls' own j10-menu shot at 1100 px, a 440 px pinned sidebar).
// The slide's own transitionend re-measures now. This suite makes the slide 1.5 s long so the timer always
// loses, then asserts the pill never overlaps the corner chrome, pinned or not, either side, two widths.
//
// Counterfactual: without the transitionend re-measure the pill overlaps #hud-tr / the profile button
// (and __connectDock.right is the pre-slide wall) in sections 1-2.
const h = require('./helpers.cjs');

const SLOW = `.burger, .top-right-chrome { transition: left 1.5s linear, right 1.5s linear !important; }`;

/** open the Inspector as the right (or left) column, optionally pinned at a width (toolbar43.shared's helper) */
async function sidebar(page, { side = 'right', open = true, full = false, w = 440 } = {}) {
	await page.evaluate(({ side, open, full, w }) => {
		const S = window.__tp?.test.v1;
		S.sidebars.inspectorSide.set(side);
		S.inspectorKind.set('scene');
		S.inspectorClose.set(!open);
		S.sidebars.toggleSidebarFull('left', side === 'left' && full);
		S.sidebars.toggleSidebarFull('right', side === 'right' && full);
		S.sidebars.setSidebarWidth(side, w);
	}, { side, open, full, w });
	// the slow slide is 1.5 s; give it, its transitionend and a frame or two time to land — and count the frames
	// the pill spent on its own row meanwhile (a decision taken mid-slide flips it there and back)
	await page.evaluate(() => {
		window.__cpsDocked = 0;
		window.__cpsFrames = 0;
		// every class change of the pill, not samples: a busy headless page runs a 25 ms timer ~5 times in
		// 2.6 s, so a flip to the own row and back falls between samples — an observer sees each one
		window.__cpsObs?.disconnect();
		const pill = document.querySelector('.connect-pill');
		window.__cpsObs = new MutationObserver(() => {
			window.__cpsFrames++;
			if (pill?.classList.contains('docked')) window.__cpsDocked++;
		});
		if (pill) window.__cpsObs.observe(pill, { attributes: true, attributeFilter: ['class'] });
	});
	await page.waitForTimeout(2600);
	return page.evaluate(() => {
		window.__cpsObs?.disconnect();
		return { docked: window.__cpsDocked, frames: window.__cpsFrames };
	});
}

/** where the pill and the corner walls are NOW */
function layout(page) {
	return page.evaluate(() => {
		const box = (el) => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.height > 0 ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
		};
		const pill = box(document.querySelector('.connect-pill'));
		const tr = box(document.getElementById('hud-tr'));
		const avatar = box(document.getElementById('avatar-trigger')) ?? box(document.getElementById('avatar-menu'));
		const logo = box(document.getElementById('logo-menu'));
		const hit = (a, b) => !!a && !!b && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
		const dock = window.__connectDock ?? null;
		return {
			pill,
			tr,
			avatar,
			logo,
			dock,
			docked: !!document.querySelector('.connect-pill.docked'),
			overlaps: { tr: hit(pill, tr), avatar: hit(pill, avatar), logo: hit(pill, logo) },
			// the right wall K4 means: the top-right group when it draws, else the profile button
			wallRight: tr ? tr.left : avatar ? avatar.left : null,
			wallLeft: logo ? logo.right : null
		};
	});
}

const r = (n) => (n == null ? 'null' : Math.round(n));

h.run(async () => {
	const browser = await h.launch();
	for (const vw of [1100, 1440]) {
		const P = await h.setupPage(browser, 'pin' + vw, { context: { viewport: { width: vw, height: 900 } } });
		const page = P.page;
		await page.locator('#restore-session-dismiss').click({ timeout: 3000 }).catch(() => {});
		await page.addStyleTag({ content: SLOW });
		const T = `${vw}px: `;

		// ---- premise: nothing pinned, the pill sits in the middle clear of both corners ----
		let L = await layout(page);
		h.check(!!L.pill && !L.overlaps.tr && !L.overlaps.avatar && !L.overlaps.logo, T + `premise: unpinned, the pill (${r(L.pill?.left)}..${r(L.pill?.right)}) is clear of the corners (${JSON.stringify(L.overlaps)})`);

		// ---- 1. a pinned RIGHT sidebar: the corner slides 440 px left over 1.5 s ----
		let S = await sidebar(page, { side: 'right', full: true, w: 440 });
		L = await layout(page);
		// 1440: the pill fits before the slide and after it, so it never has a reason to take its own row
		if (vw === 1440) h.check(S.docked === 0, T + `1. the pill stays on the top row while the corner slides (${S.docked} of ${S.frames} class changes put it on its own row)`);
		h.check(!L.overlaps.tr && !L.overlaps.avatar, T + `1. right sidebar pinned (440): the pill (${r(L.pill?.left)}..${r(L.pill?.right)}${L.docked ? ', own row' : ''}) does not cover the top-right group (${r(L.tr?.left)}..${r(L.tr?.right)}) or the profile (${r(L.avatar?.left)}..${r(L.avatar?.right)})`);
		if (L.dock && L.dock.right != null)
			h.check(Math.abs(L.dock.right - L.wallRight) <= 2, T + `1. the measured right wall is where the slide ENDED (measured ${r(L.dock.right)}, drawn ${r(L.wallRight)})`);

		// ---- 2. unpinned again: the corner slides back, the pill returns to the middle ----
		S = await sidebar(page, { side: 'right', full: false, open: false, w: 440 });
		L = await layout(page);
		if (vw === 1440) h.check(S.docked === 0, T + `2. …and while it slides back (${S.docked} of ${S.frames} class changes put it on its own row)`);
		h.check(!L.overlaps.tr && !L.overlaps.avatar && !L.docked, T + `2. unpinned: the pill is back on the top row (${r(L.pill?.left)}..${r(L.pill?.right)}), clear of the corner`);
		if (L.dock && L.dock.right != null)
			h.check(Math.abs(L.dock.right - L.wallRight) <= 2, T + `2. …and measured the wall where it ended (${r(L.dock.right)} vs ${r(L.wallRight)})`);

		// ---- 3. a pinned LEFT sidebar: the logo slides 440 px right ----
		S = await sidebar(page, { side: 'left', full: true, w: 440 });
		L = await layout(page);
		if (vw === 1440) h.check(S.docked === 0, T + `3. the pill stays on the top row while the logo slides (${S.docked} of ${S.frames} class changes put it on its own row)`);
		h.check(!L.overlaps.logo, T + `3. left sidebar pinned (440): the pill (${r(L.pill?.left)}..${r(L.pill?.right)}${L.docked ? ', own row' : ''}) does not cover the logo (${r(L.logo?.left)}..${r(L.logo?.right)})`);
		if (L.dock && L.dock.left != null && !L.docked)
			h.check(L.dock.left >= L.wallLeft - 2, T + `3. the measured left wall is at or past the slid logo (measured ${r(L.dock.left)}, logo right ${r(L.wallLeft)})`);
		await sidebar(page, { side: 'left', full: false, open: false, w: 440 });

		await P.ctx.close();
	}
	await h.finish(browser);
});
