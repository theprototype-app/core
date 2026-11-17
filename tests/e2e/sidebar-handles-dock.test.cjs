// 1.64 owner ask (78-fix-547): A VIEWPORT SIDEBAR HANDLE NEVER SITS ON THE BOTTOM DOCK. The clamp is a RENDERING:
// the spot the person dragged a handle to stays saved, and only where it is DRAWN is held inside the free band
// between the header floor and the dock's top (minus a gap).
//
//   1. a saved spot low on the screen, the dock closed: the handle is drawn there
//   2. the dock opens: each handle's bottom is at or above the dock's top, and the saved spot is unchanged
//   3. the dock grows: the handle follows it up
//   4. a drag while the dock is open saves the new spot, inside the band
//   5. the dock closes: each handle is back on its saved spot
//   6. a reload keeps the saved spots
//   7. uir-polish A1: a dock tall enough to leave no room above it: the handle goes BEHIND the dock (never on top),
//      and comes back to its saved spot when the dock closes
//   8. uir-polish A2: the window gets shorter / taller: the handle keeps its place in proportion to the free height
//
// Run: APP_URL=https://theprototype.app:5809/ npm run e2e -- sidebar-handles-dock
const h = require('./helpers.cjs');

const SIDES = ['left', 'right'];
const state = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const g = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		const r = (id) => {
			const b = document.getElementById(id)?.getBoundingClientRect();
			return b && b.height ? { top: Math.round(b.top), bottom: Math.round(b.bottom) } : null;
		};
		const inset = g(s.bottomDock.bottomInset);
		return {
			left: r('sidebar-handle-left'),
			right: r('sidebar-handle-right'),
			saved: g(s.sidebarHandles.sidebarHandleY),
			inset,
			dockTop: inset > 0 ? Math.round(innerHeight - inset) : null,
			vh: innerHeight
		};
	});
const settle = (page, ms = 700) => page.waitForTimeout(ms);
const near = (a, b) => a && b && Math.abs(a.top - b.top) <= 1;
// the handles slide on `top` (0.2 s); a transition advances only on painted frames, and a headless cloud build under
// load paints few, so a read 700 ms after a change can land mid-slide (production 1.66.0: 249 still drawn 1.5 s later).
// This suite measures WHERE a handle is drawn, so the slide is switched off.
const noSlide = (page) => page.addStyleTag({ content: '#sidebar-handle-left, #sidebar-handle-right { transition: none !important; }' });
const nodeEditor = (page) => page.locator('p[title="Node editor (N)"]').click();

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1920, height: 1080 } } });
	const page = A.page;
	await noSlide(page);
	await settle(page, 1500);

	// ---- 1. a saved spot low on the screen ----
	let st = await state(page);
	h.check(!!st.left && !!st.right && st.inset === 0, `premise: both handles drawn, no dock (${JSON.stringify(st)})`);
	const base = { left: st.left.top - st.saved.left, right: st.right.top - st.saved.right };
	await page.evaluate(
		([l, r]) => {
			window.__stores.sidebarHandles.setSidebarHandleY('left', l);
			window.__stores.sidebarHandles.setSidebarHandleY('right', r);
		},
		[820 - base.left, 860 - base.right]
	);
	await settle(page);
	const home = await state(page);
	h.check(near(home.left, { top: 820 }) && near(home.right, { top: 860 }), `1 the dock closed: each handle is drawn on its saved spot (${home.left?.top}, ${home.right?.top})`);

	// ---- 2. the dock opens ----
	await nodeEditor(page);
	await settle(page, 1000);
	st = await state(page);
	h.check(st.dockTop !== null && st.dockTop < 860, `premise: the Node editor docked at the bottom, its top above the saved spots (${st.dockTop})`);
	for (const side of SIDES)
		h.check(st[side] && st[side].bottom <= st.dockTop, `2 dock open: the ${side} handle sits above the dock (bottom ${st[side]?.bottom} <= dock top ${st.dockTop})`);
	h.check(st.saved.left === home.saved.left && st.saved.right === home.saved.right, `2 ...and the saved spots are untouched (${JSON.stringify(st.saved)})`);

	// ---- 3. the dock grows: the handle follows ----
	const was = st;
	await page.evaluate((hh) => window.__stores.bottomDock.dockHeight.set(hh), Math.round(was.inset + 120));
	await settle(page, 900);
	st = await state(page);
	h.check(st.dockTop !== null && st.dockTop < was.dockTop - 60, `premise: the dock grew (top ${was.dockTop} -> ${st.dockTop})`);
	for (const side of SIDES)
		h.check(st[side] && st[side].bottom <= st.dockTop && st[side].top < was[side].top - 60, `3 the ${side} handle follows the dock up (top ${was[side]?.top} -> ${st[side]?.top}, bottom ${st[side]?.bottom} <= ${st.dockTop})`);

	// ---- 4. a drag while the dock is open saves the new spot, inside the band ----
	const rb = await page.locator('#sidebar-handle-right').boundingBox();
	await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
	await page.mouse.down();
	await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2 - 30, { steps: 4 });
	await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2 - 80, { steps: 4 });
	await page.mouse.up();
	await settle(page);
	st = await state(page);
	const dragged = st.right;
	h.check(dragged && dragged.top <= rb.y - 70 && dragged.bottom <= st.dockTop, `4 a drag up moves the right handle within the band (${Math.round(rb.y)} -> ${dragged?.top})`);
	h.check(st.saved.right === dragged.top - base.right, `4 ...and saves that spot (${st.saved.right} = ${dragged?.top} - ${base.right})`);
	h.check(st.saved.left === home.saved.left, '4 ...the other side keeps its own');
	await page.evaluate(() => {
		let v;
		window.__stores.sidebars.sidebarVisible.subscribe((x) => (v = x))();
		if (v.right) window.__stores.sidebars.toggleSidebar('right', false);
	});

	// ---- 5. the dock closes ----
	await nodeEditor(page);
	await settle(page, 1000);
	st = await state(page);
	h.check(st.inset === 0, 'premise: the dock closed');
	h.check(near(st.left, home.left), `5 the left handle is back on its saved spot (${st.left?.top} = ${home.left?.top})`);
	h.check(near(st.right, dragged), `5 the right handle stays on the spot the drag saved (${st.right?.top} = ${dragged?.top})`);

	// ---- 6. a reload keeps the saved spots ----
	const keep = st;
	await h.freshReload(A);
	await h.answerRestore?.(A);
	await noSlide(page);
	await settle(page, 2000);
	st = await state(page);
	h.check(near(st.left, keep.left) && near(st.right, keep.right), `6 a reload keeps both saved spots (${st.left?.top}/${keep.left?.top}, ${st.right?.top}/${keep.right?.top})`);

	// ---- 7. A1: no room above the dock -> behind it ----
	const onTop = (side) =>
		page.evaluate((id) => {
			const el = document.getElementById(id);
			const b = el?.getBoundingClientRect();
			if (!b || !b.height) return null;
			const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
			return { mine: !!hit && el.contains(hit), under: el.hasAttribute('data-under') };
		}, 'sidebar-handle-' + side);
	await nodeEditor(page);
	await settle(page, 1000);
	await page.evaluate(() => window.__stores.bottomDock.dockHeight.set(Math.round(innerHeight - 120)));
	await settle(page, 1000);
	st = await state(page);
	h.check(st.dockTop !== null && st.dockTop < 200, `premise: the dock covers nearly the whole viewport (top ${st.dockTop})`);
	for (const side of SIDES) {
		const t = await onTop(side);
		h.check(t && t.under && !t.mine, `7 no room above the dock: the ${side} handle waits BEHIND it, not painted on it (${JSON.stringify(t)})`);
	}
	await page.evaluate(() => window.__stores.bottomDock.dockHeight.set(320));
	await nodeEditor(page);
	await settle(page, 1000);
	st = await state(page);
	h.check(st.inset === 0 && near(st.left, keep.left) && near(st.right, keep.right), `7 ...the dock closed: both back on their saved spots (${st.left?.top}/${keep.left?.top})`);
	for (const side of SIDES) {
		const t = await onTop(side);
		h.check(t && !t.under && t.mine, `7 ...and on top again (${side}: ${JSON.stringify(t)})`);
	}

	// ---- 8. A2: proportional to the window height ----
	const tops = await state(page);
	await page.setViewportSize({ width: 1920, height: 760 });
	await settle(page, 1500);
	const short = await state(page);
	for (const side of SIDES) {
		// the resting place (the floor) does not move with the height; the free height below it does
		const rest = tops[side].top - tops.saved[side];
		const want = Math.round(rest + (tops.saved[side] / (1080 - 44 - 96 - rest)) * (760 - 44 - 96 - rest));
		h.check(short[side] && short[side].top < tops[side].top - 60 && Math.abs(short[side].top - want) <= 3, `8 a shorter window moves the ${side} handle up in proportion (${tops[side]?.top} -> ${short[side]?.top}, want ${want})`);
	}
	await page.setViewportSize({ width: 1920, height: 1080 });
	await settle(page, 1500);
	const back = await state(page);
	for (const side of SIDES)
		h.check(back[side] && Math.abs(back[side].top - tops[side].top) <= 2, `8 ...back to the full height: the same spot as before (${tops[side]?.top} -> ${back[side]?.top})`);
	await h.finish(browser);
});
