// Phase 81L: docking lite — drag a window to a screen edge to dock it full-height,
// the docked width resizes and persists, the other edge works, drag-away undocks.
// 42 I3 changed two contracts this suite used to pin: the Inspector no longer pushes a
// right-docked panel inward as a SECOND COLUMN (they are tabs of one right sidebar now), and
// a second window on an edge is a TAB, not an 81.4 split — both are covered in depth by
// sidebar-tabs; here they are asserted once each, from the old suite's own gestures.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.locator('p[title="Object list (O)"]').click();
	await A.page.waitForTimeout(400);

	// drag the list header (its title end — the search field is not a handle) to the right edge -> docks
	const vw = await A.page.evaluate(() => window.innerWidth);
	const vh = await A.page.evaluate(() => window.innerHeight);
	const list = await A.page.locator('#object-list').boundingBox();
	await A.page.mouse.move(list.x + 24, list.y + 14);
	await A.page.mouse.down();
	await A.page.mouse.move(vw - 15, 400, { steps: 10 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	let box = await A.page.locator('#object-list').boundingBox();
	h.check(
		Math.abs(box.x + box.width - vw) < 4 && box.height > vh * 0.75,
		`docked right full-height (x ${box.x}, h ${box.height})`
	);

	// 42 I3: opening the scene inspector makes it the right sidebar's front TAB — the list is not
	// pushed inward as a second column; closing it brings the list back in place
	await A.page.evaluate(() => window.__tp.test.v1.showSidebar('scene'));
	await A.page.waitForTimeout(500);
	const covered = await A.page.evaluate(() => getComputedStyle(document.querySelector('#object-list')).display);
	const ins = await A.page.locator('#inspector').boundingBox();
	h.check(covered === 'none' && Math.abs(ins.x + ins.width - vw) < 4, `the Inspector takes the column as a tab (list display ${covered})`);
	await A.page.evaluate(() => window.__tp.test.v1.showSidebar('scene')); // toggle closed
	await A.page.waitForTimeout(500);
	box = await A.page.locator('#object-list').boundingBox();
	h.check(Math.abs(box.x + box.width - vw) < 4, 'panel returns when the inspector closes');

	// the column width resizes via its inner-edge grip, persisted per side
	const handle = await A.page.locator('#sidebar-grip-right').boundingBox();
	await A.page.mouse.move(handle.x + 3, handle.y + 300);
	await A.page.mouse.down();
	await A.page.mouse.move(handle.x - 117, handle.y + 300, { steps: 8 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(200);
	const wider = await A.page.locator('#object-list').boundingBox();
	h.check(wider.width > box.width + 80, `dock resize widens (${box.width} → ${wider.width})`);
	const savedWidth = await A.page.evaluate(() => localStorage.getItem('sidebarWidth:right'));
	h.check(Math.abs(parseInt(savedWidth) - wider.width) < 4, 'dock width persisted');

	// 42 I3: a second window on the same edge is a TAB of the column (no 81.4 split)
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(500);
	await A.page.locator('#dock-undock:visible').first().click();
	await A.page.waitForTimeout(400);
	const flow = await A.page.locator('#flow-window').boundingBox();
	await A.page.mouse.move(flow.x + 60, flow.y + 14);
	await A.page.mouse.down();
	await A.page.mouse.move(vw - 15, 300, { steps: 10 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const flowBox = await A.page.locator('#flow-window').boundingBox();
	const state = await A.page.evaluate(() => ({
		flow: document.querySelector('#flow-window').dataset.docked,
		listShown: getComputedStyle(document.querySelector('#object-list')).display !== 'none'
	}));
	h.check(state.flow === 'right' && !state.listShown && flowBox.height > vh * 0.75, `an occupied edge takes a second window as a tab (${JSON.stringify(state)})`);

	// 43 J7: a window in a sidebar has no header of its own — its sidebar TAB is the handle
	const tabAt = (side, key) =>
		A.page.evaluate(([side, key]) => {
			const r = document.querySelector(`#sidebar-strip-${side} [data-sidebar-tab="${key}"]`)?.getBoundingClientRect();
			return r ? { x: r.x + Math.min(30, r.width / 2), y: r.y + r.height / 2 } : null;
		}, [side, key]);
	// dragging the tab member's TAB away undocks it (43 J4: dropped in the viewport it floats there); the list is the column again
	const flowTab = await tabAt('right', 'flow');
	await A.page.mouse.move(flowTab.x, flowTab.y);
	await A.page.mouse.down();
	await A.page.mouse.move(flowBox.x - 300, flowBox.y + 200, { steps: 10 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const listAgain = await A.page.locator('#object-list').boundingBox();
	h.check(listAgain.height > vh * 0.75, 'the panel left behind takes the whole column again');

	// ...and the other edge works, on the next gesture
	const flowFree = await A.page.locator('#flow-window').boundingBox();
	await A.page.mouse.move(flowFree.x + 60, flowFree.y + 14);
	await A.page.mouse.down();
	await A.page.mouse.move(10, 300, { steps: 10 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const flowLeft = await A.page.locator('#flow-window').boundingBox();
	h.check(flowLeft.x < 4 && flowLeft.height > vh * 0.75, 'flow docks to the left edge');

	// dragging a docked window's TAB away undocks (43 J7: no header in a sidebar)
	const flowTabL = await tabAt('left', 'flow');
	await A.page.mouse.move(flowTabL.x, flowTabL.y);
	await A.page.mouse.down();
	await A.page.mouse.move(flowLeft.x + 400, flowLeft.y + 200, { steps: 10 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const floated = await A.page.locator('#flow-window').boundingBox();
	const undocked = await A.page.evaluate(
		() => !document.querySelector('#flow-window').dataset.docked
	);
	h.check(undocked && floated.height < vh * 0.8, 'drag-away undocks back to floating');

	await h.finish(browser);
});
