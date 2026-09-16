// Phase 81L: docking lite — drag a window to a screen edge to dock it
// full-height, right-docked panels give way to the Inspector as a second
// column, docked width resizes and persists, one window per edge, drag-away
// undocks.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.locator('p[title="Object list (O)"]').click();
	await A.page.waitForTimeout(400);

	// drag the list header to the right edge -> docks
	const list = await A.page.locator('#object-list').boundingBox();
	await A.page.mouse.move(list.x + 100, list.y + 10);
	await A.page.mouse.down();
	await A.page.mouse.move(1265, 400, { steps: 10 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	let box = await A.page.locator('#object-list').boundingBox();
	const vw = await A.page.evaluate(() => window.innerWidth);
	const vh = await A.page.evaluate(() => window.innerHeight);
	h.check(
		Math.abs(box.x + box.width - vw) < 4 && box.height > vh * 0.8,
		`docked right full-height (x ${box.x}, h ${box.height})`
	);

	// opening the scene inspector pushes the docked panel inward (second level)
	await A.page.evaluate(() => window.__stores.showSidebar('scene'));
	await A.page.waitForTimeout(500);
	box = await A.page.locator('#object-list').boundingBox();
	h.check(vw - (box.x + box.width) > 250, `panel offsets for the inspector (right gap ${Math.round(vw - box.x - box.width)})`);
	await A.page.evaluate(() => window.__stores.showSidebar('scene')); // toggle closed
	await A.page.waitForTimeout(500);
	box = await A.page.locator('#object-list').boundingBox();
	h.check(Math.abs(box.x + box.width - vw) < 4, 'panel returns when the inspector closes');

	// docked width resize via the inner-edge handle, persisted
	const handle = await A.page.locator('#object-list .dock-resize').boundingBox();
	await A.page.mouse.move(handle.x + 3, handle.y + 300);
	await A.page.mouse.down();
	await A.page.mouse.move(handle.x - 117, handle.y + 300, { steps: 8 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(200);
	const wider = await A.page.locator('#object-list').boundingBox();
	h.check(wider.width > box.width + 80, `dock resize widens (${box.width} → ${wider.width})`);
	const savedWidth = await A.page.evaluate(() => localStorage.getItem('dockWidth:objects'));
	h.check(Math.abs(parseInt(savedWidth) - wider.width) < 4, 'dock width persisted');

	// 81.4: a second window on the same edge SPLITS it (two stacked panels) — the
	// refusal is for a THIRD; the split's own coverage is dock-splits
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(500);
	await A.page.locator('#flow-undock').click();
	await A.page.waitForTimeout(400);
	const flow = await A.page.locator('#flow-window').boundingBox();
	await A.page.mouse.move(flow.x + 120, flow.y + 12);
	await A.page.mouse.down();
	await A.page.mouse.move(1265, 300, { steps: 10 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const flowBox = await A.page.locator('#flow-window').boundingBox();
	const split = await A.page.evaluate(() => ({
		flow: document.querySelector('#flow-window').dataset.docked,
		slot: document.querySelector('#flow-window').dataset.dockSlot,
		list: document.querySelector('#object-list').dataset.dockSlot
	}));
	h.check(split.flow === 'right' && flowBox.height < vh * 0.8, `occupied edge splits for a second window (${JSON.stringify(split)})`);
	// the drop landed on the UPPER half of the occupant (y 300 of a 64..720 panel), and
	// the half you release over is the slot you take — so the newcomer is on top here
	h.check(split.slot === 'top' && split.list === 'bottom', `the half you drop on is the slot you get (${JSON.stringify(split)})`);

	// dragging the split member's header away undocks it (the split collapses)...
	await A.page.mouse.move(flowBox.x + 120, flowBox.y + 12);
	await A.page.mouse.down();
	await A.page.mouse.move(flowBox.x - 300, flowBox.y + 200, { steps: 10 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const listAgain = await A.page.locator('#object-list').boundingBox();
	h.check(listAgain.height > vh * 0.8, 'the panel left behind takes the whole column again');

	// ...and the other edge works, on the next gesture
	const flowFree = await A.page.locator('#flow-window').boundingBox();
	await A.page.mouse.move(flowFree.x + 120, flowFree.y + 12);
	await A.page.mouse.down();
	await A.page.mouse.move(10, 300, { steps: 10 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const flowLeft = await A.page.locator('#flow-window').boundingBox();
	h.check(flowLeft.x < 4 && flowLeft.height > vh * 0.8, 'flow docks to the left edge');

	// dragging a docked header away undocks
	await A.page.mouse.move(flowLeft.x + 120, flowLeft.y + 8);
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
