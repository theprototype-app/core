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
const nodeEditor = (page) => page.locator('p[title="Node editor (N)"]').click();

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1920, height: 1080 } } });
	const page = A.page;
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
	await settle(page, 2000);
	st = await state(page);
	h.check(near(st.left, keep.left) && near(st.right, keep.right), `6 a reload keeps both saved spots (${st.left?.top}/${keep.left?.top}, ${st.right?.top}/${keep.right?.top})`);
	await h.finish(browser);
});
