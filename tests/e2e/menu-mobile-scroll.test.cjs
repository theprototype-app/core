// 36 U5 + U7 — THE BURGER MENU FITS AND SCROLLS BY TOUCH ON A PHONE, IN BOTH POSTURES OF A FOLDABLE.
//
// The user's device is an OPPO Find N6 (2026-10-04): the menu "does not scroll by touch-swipe when
// unfolded". Every viewport below is a touch + mobile-UA emulation (hasTouch + isMobile — the
// only way Chromium applies a phone's viewport handling headlessly), and every swipe is a REAL
// touch drag through the compositor (
// raw touch points, CDP Input.dispatchTouchEvent), so touch-action, overscroll and any listener
// that eats a touch all take part.
//
// Per viewport, with the menu open:
//   - it FITS: its bottom edge is inside the visible viewport (a menu taller than the screen whose
//     last rows hang below it is the bug — nothing can scroll them into view)
//   - its last row (What's new) is reachable: already visible, or brought fully into view by a
//     touch swipe on the menu
//   - no visible scrollbar (offsetWidth == clientWidth + borders) and overscroll is contained
//   - the 36 U5 audit: no "Live profiler" row (it lives in the Profiler tab now)
// And the posture change: folded -> unfolded -> folded in ONE session (a breakpoint or a
// measurement read once at boot goes stale exactly here), plus a boot in each posture.
//
// The Find N6 sizes are DERIVED (no published CSS-viewport figures exist): panels 1140x2616
// (cover) and 2248x2480 (inner) at Android's 480 dpi density = DPR 3 -> 380x872 and 749x827 CSS
// px, minus ~80 px of status bar + Chrome toolbar -> 380x792 and 749x747. Unverified on the
// device; see the lane handover.
//
// Run: APP_URL=https://theprototype.app:5321/ npm run e2e -- menu-mobile-scroll
const h = require('./helpers.cjs');
const path = require('node:path');
const fs = require('node:fs');

const SHOTS = process.env.EVIDENCE_DIR || '/home/deck/.code/lanes-30/after-36/36-ui-polish';
const PHASE = process.env.BEFORE ? 'before' : 'after';
const UA =
	'Mozilla/5.0 (Linux; Android 16; CPH2765) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';
const N6_FOLDED = { width: 380, height: 792 };
const N6_UNFOLDED = { width: 749, height: 747 };
const N6_UNFOLDED_LAND = { width: 827, height: 669 };

/** @param {any} browser @param {{width:number,height:number}} vp @param {number} dpr */
async function mobilePage(browser, name, vp, dpr) {
	return h.setupPage(browser, name, {
		context: { viewport: vp, deviceScaleFactor: dpr, isMobile: true, hasTouch: true, userAgent: UA }
	});
}

/** open the menu and read its geometry @param {any} page */
async function readMenu(page) {
	await page.evaluate(() => {
		window.__stores.settingsOpen.set(false);
		window.__stores.closeMenu.set(false);
	});
	await page.waitForSelector('#sidebar70', { timeout: 5000 });
	await page.waitForTimeout(350); // the fade-in
	return page.evaluate(() => {
		const nav = /** @type {HTMLElement} */ (document.getElementById('sidebar70'));
		nav.scrollTop = 0;
		const r = nav.getBoundingClientRect();
		const cs = getComputedStyle(nav);
		const borders = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
		const rows = [...nav.querySelectorAll('.side-row')];
		const last = /** @type {HTMLElement} */ (nav.querySelector('#open-whats-new'));
		return {
			vh: window.innerHeight,
			vw: window.innerWidth,
			top: Math.round(r.top),
			bottom: Math.round(r.bottom),
			scrollH: nav.scrollHeight,
			clientH: nav.clientHeight,
			barW: nav.offsetWidth - nav.clientWidth - borders,
			overscroll: cs.overscrollBehaviorY,
			rows: rows.length,
			liveRow: !!document.getElementById('open-profiler-live'),
			lastBottom: Math.round(last.getBoundingClientRect().bottom),
			docked: document.documentElement.classList.contains('connect-docked')
		};
	});
}

/** a real touch swipe UP on the menu (content scrolls down): raw touch points through CDP
 *  (Input.dispatchTouchEvent goes through the compositor's touch-action + scroll path;
 *  Input.synthesizeScrollGesture was measured to scroll NOTHING in this headless build, a plain
 *  overflow div included) @param {any} page */
async function swipeMenu(page, m) {
	const cdp = await page.context().newCDPSession(page);
	const x = 60;
	const y0 = Math.round(Math.min(m.bottom, m.vh) - 12);
	const dist = Math.round((Math.min(m.bottom, m.vh) - Math.max(m.top, 0)) * 0.8);
	for (let pass = 0; pass < 3; pass++) {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
		for (let i = 1; i <= 12; i++) {
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 - (dist * i) / 12 }] });
			await page.waitForTimeout(16);
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await page.waitForTimeout(150);
	}
	await page.waitForTimeout(500);
	return page.evaluate(() => {
		const nav = /** @type {HTMLElement} */ (document.getElementById('sidebar70'));
		const last = /** @type {HTMLElement} */ (nav.querySelector('#open-whats-new'));
		const nr = nav.getBoundingClientRect();
		const lr = last.getBoundingClientRect();
		return {
			scrollTop: Math.round(nav.scrollTop),
			lastTop: Math.round(lr.top),
			lastBottom: Math.round(lr.bottom),
			visBottom: Math.round(Math.min(nr.bottom, window.innerHeight)),
			pageScrolled: Math.round(window.scrollY + document.documentElement.scrollTop)
		};
	});
}

/** every check for one viewport @param {any} page @param {string} label */
async function checkPosture(page, label) {
	const m = await readMenu(page);
	console.log(`  ${label}: ${JSON.stringify(m)}`);
	await page.screenshot({ path: path.join(SHOTS, `menu-${PHASE}-${label}.png`) }).catch(() => {});
	h.check(!m.liveRow, `${label}: the menu has no "Live profiler" row (36 U5 — it lives in the Profiler tab)`);
	h.check(m.bottom <= m.vh, `${label}: the menu FITS the visible viewport (bottom ${m.bottom} <= ${m.vh})`);
	h.check(m.barW <= 0, `${label}: no visible scrollbar (${m.barW}px)`);
	h.check(m.overscroll === 'contain', `${label}: overscroll is contained (${m.overscroll})`);
	if (m.lastBottom <= Math.min(m.bottom, m.vh)) {
		h.check(true, `${label}: every row is visible without scrolling (last row bottom ${m.lastBottom})`);
	} else {
		h.check(m.scrollH > m.clientH, `${label}: rows below the fold make the menu SCROLLABLE (${m.scrollH} > ${m.clientH})`);
		const s = await swipeMenu(page, m);
		console.log(`    after swipe: ${JSON.stringify(s)}`);
		h.check(s.scrollTop > 0, `${label}: a touch swipe scrolls the menu (scrollTop ${s.scrollTop})`);
		h.check(
			s.lastBottom <= s.visBottom + 1 && s.lastTop >= 0,
			`${label}: ...and brings the last row fully into view (${s.lastTop}..${s.lastBottom} within ..${s.visBottom})`
		);
		await page.screenshot({ path: path.join(SHOTS, `menu-${PHASE}-${label}-swiped.png`) }).catch(() => {});
	}
	await page.evaluate(() => window.__stores.closeMenu.set(true));
	await page.waitForTimeout(250);
}

h.run(async () => {
	fs.mkdirSync(SHOTS, { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });

	// ---- 1. a plain phone, portrait then landscape (U5's two named sizes)
	const P = await mobilePage(browser, 'phone', { width: 360, height: 640 }, 3);
	await checkPosture(P.page, 'phone-360x640');
	await P.page.setViewportSize({ width: 740, height: 360 });
	await P.page.waitForTimeout(800);
	await checkPosture(P.page, 'phone-740x360-landscape');
	await P.ctx.close();

	// ---- 2. Find N6: boot FOLDED, unfold, fold again — one session
	const F = await mobilePage(browser, 'n6-folded-boot', N6_FOLDED, 3);
	await checkPosture(F.page, 'n6-folded');
	await F.page.setViewportSize(N6_UNFOLDED);
	await F.page.waitForTimeout(900);
	await checkPosture(F.page, 'n6-folded-then-unfolded');
	await F.page.setViewportSize(N6_UNFOLDED_LAND);
	await F.page.waitForTimeout(900);
	await checkPosture(F.page, 'n6-unfolded-landscape');
	await F.page.setViewportSize(N6_FOLDED);
	await F.page.waitForTimeout(900);
	// a phone browser ZOOMS OUT to show content wider than the screen: after fold -> unfold ->
	// fold, anything sized while unfolded and never re-measured shows up as a layout viewport
	// wider than the folded screen
	const wide = await F.page.evaluate((w) => {
		const out = [];
		for (const el of document.querySelectorAll('body *')) {
			const r = el.getBoundingClientRect();
			if (r.right > w + 1 && r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden')
				out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).split(' ')[0]} right=${Math.round(r.right)} w=${Math.round(r.width)}`);
		}
		return { vw: window.innerWidth, out: out.slice(0, 12) };
	}, N6_FOLDED.width);
	console.log('  refold: ' + JSON.stringify(wide));
	h.check(wide.vw <= N6_FOLDED.width + 1, `refolded: the page is back to the folded width, not zoomed out (${wide.vw}px)`);
	await checkPosture(F.page, 'n6-refolded');
	await F.ctx.close();

	// ---- 3. Find N6: boot UNFOLDED
	const U = await mobilePage(browser, 'n6-unfolded-boot', N6_UNFOLDED, 3);
	await checkPosture(U.page, 'n6-unfolded-boot');
	await U.ctx.close();

	// ---- 4. the Live view's new home: the Profiler tab header opens it (desktop)
	const D = await h.setupPage(browser, 'desk', { context: { viewport: { width: 1440, height: 900 } } });
	await D.page.evaluate(() => window.__stores.profilerView.openProfiler());
	await D.page.click('#profiler-open-live', { timeout: 15000 });
	await D.page.waitForSelector('#profiler-live', { timeout: 5000 });
	h.check(true, 'the Profiler tab header opens the Live profiler (#profiler-open-live)');
	await h.finish(browser);
});
