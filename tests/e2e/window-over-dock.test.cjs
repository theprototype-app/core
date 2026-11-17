// 42 I6 (a) — the user's preview-1-32c review (desktop):
//   "Desktop mode resizing 'object list' floating window: should be possible to resize even when it is
//    covering docked window drawer, now it stuck and dissallow to resize height past this docker window
//    (should also be allowed for any other floating window ...)"
//
//   1  the Objects window (its own grip, Controls' dragMe) grows past the open dock's top edge, by mouse
//   2  a dragWindow window with the shared corner grip (Statistics) does the same
//   3  the size survives a reload / a browser resize (the load-time cap no longer counts the dock),
//      and the corner still stops at the screen edge (the 18-B rule: the grip stays reachable)
//
// Counterfactual: on origin/feat/41-int each corner stops ~8px above the dock (windowSize subtracted
// --viewport-inset from every size cap). Real mouse throughout.
// Run: APP_URL=http://localhost:5424/ npm run e2e -- window-over-dock
const h = require('./helpers.cjs');

const DESK = { viewport: { width: 1440, height: 900 } };
const S = (page, fn, arg) => page.evaluate(fn, arg);
const rectOf = (page, sel) =>
	S(page, (sel) => {
		const r = document.querySelector(sel).getBoundingClientRect();
		return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
	}, sel);
const dockTop = (page) =>
	S(page, () => {
		const el = [...document.querySelectorAll('.tp-dock-panel')].find((d) => d.getBoundingClientRect().height > 0 && !d.classList.contains('hidden'));
		return el ? Math.round(el.getBoundingClientRect().top) : null;
	});

/** drag a grip from its centre by (dx, dy) */
async function dragGrip(page, sel, dx, dy) {
	const g = await rectOf(page, sel);
	const x = g.left + g.width / 2;
	const y = g.top + g.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 8 });
	await page.mouse.move(x + dx, y + dy, { steps: 8 });
	await page.mouse.up();
	await page.waitForTimeout(300);
}

h.run(async () => {
	const browser = await h.launch();
	const P = await h.setupPage(browser, 'D', {
		context: DESK,
		storage: {
			flowDocked: 'true',
			flowDockHeight: '360',
			// (no window-rect seeds: setupPage's seed re-runs on every navigation, so it would undo the
			// sizes section 3 reloads to check — Objects' default rect 350,100 300x250 sits above the dock,
			// and Statistics is seeded in the page before it first mounts)
		}
	});
	const page = P.page;
	await S(page, async () => {
		window.__tp.test.v1.flowGraphClose.set(false);
		await new Promise((r) => setTimeout(r, 600));
		window.__tp.test.v1.bottomDock.activateDock('flow');
	});
	await page.waitForTimeout(900);
	const dTop = await dockTop(page);
	const pushes = await S(page, () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--viewport-inset')) || 0);
	h.check(dTop !== null && dTop < 600 && pushes > 0, `premise: the dock is open and pushes the viewport (dock top ${dTop}, --viewport-inset ${pushes})`);

	// ---- 1. the Objects window -------------------------------------------------------------
	await S(page, () => window.__tp.test.v1.objectListClose.set(false));
	await page.waitForTimeout(900);
	let before = await rectOf(page, '#object-list');
	h.check(before.bottom < dTop, `1.0 premise: the Objects window starts above the dock (bottom ${Math.round(before.bottom)} < ${dTop})`);
	await dragGrip(page, '#object-list .resize-handle', 0, 820 - before.bottom);
	let after = await rectOf(page, '#object-list');
	await page.screenshot({ path: (process.env.OUT || '/tmp') + '/i6-objects-over-dock-dark.png' });
	h.check(after.bottom > dTop + 150, `1.1 the Objects window resizes down over the dock (bottom ${Math.round(after.bottom)}, dock top ${dTop})`);
	h.check(after.bottom <= 900 - 6, `1.2 ...and the corner still stops at the screen edge (bottom ${Math.round(after.bottom)} <= 894)`);
	const covering = await S(page, () => {
		const r = document.getElementById('object-list').getBoundingClientRect();
		const el = document.elementFromPoint(r.left + 40, r.bottom - 30);
		return !!el && !!el.closest('#object-list');
	});
	h.check(covering, '1.3 ...drawn OVER the dock (the window owns the point inside its lower part)');

	// ---- 2. a dragWindow window (Statistics: the shared corner grip) ---------------------------
	await S(page, () => {
		localStorage.setItem('win:statsWindow', JSON.stringify({ left: 760, top: 140, w: 380, h: 300 }));
		window.__tp.test.v1.sceneBudget.statsOpen.set(true);
	});
	await page.waitForTimeout(800);
	before = await rectOf(page, '#stats-window');
	h.check(before.bottom < dTop, `2.0 premise: Statistics starts above the dock (bottom ${Math.round(before.bottom)} < ${dTop})`);
	await dragGrip(page, '#stats-window .dw-resize', 0, 860 - before.bottom);
	after = await rectOf(page, '#stats-window');
	h.check(after.bottom > dTop + 150, `2.1 Statistics resizes down over the dock (bottom ${Math.round(after.bottom)}, dock top ${dTop})`);

	// ---- 3. reload / browser resize keep it ----------------------------------------------------
	const keptH = after.height;
	await page.setViewportSize({ width: 1400, height: 900 });
	await page.waitForTimeout(600);
	const resized = await rectOf(page, '#stats-window');
	h.check(Math.abs(resized.height - keptH) <= 2, `3.1 a browser resize does not shrink it back above the dock (${Math.round(keptH)} -> ${Math.round(resized.height)})`);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(4000);
	await page.waitForFunction(() => window.__tp?.test.v1 && !!window.__tp.test.v1.moduleSDK, { timeout: 30000 });
	await S(page, async () => {
		window.__tp.test.v1.flowGraphClose.set(false);
		await new Promise((r) => setTimeout(r, 600));
		window.__tp.test.v1.bottomDock.activateDock('flow');
		window.__tp.test.v1.sceneBudget.statsOpen.set(true);
		window.__tp.test.v1.objectListClose.set(false);
	});
	await page.waitForTimeout(1200);
	const reStats = await rectOf(page, '#stats-window');
	const reObj = await rectOf(page, '#object-list');
	h.check(reStats.bottom > (await dockTop(page)) + 150, `3.2 after a reload Statistics keeps its size over the dock (bottom ${Math.round(reStats.bottom)})`);
	h.check(reObj.bottom > (await dockTop(page)) + 150, `3.3 ...and so does the Objects window (bottom ${Math.round(reObj.bottom)})`);

	await h.finish(browser);
});
