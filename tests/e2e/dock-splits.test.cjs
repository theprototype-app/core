// 81.4 (v1.13): DOCKED EDGE SPLITS — dropping a second floating window onto a docked
// panel splits that edge into two stacked panels with a draggable divider (max two per
// edge, persisted); undocking either member collapses the split. Tabbing (83) stays a
// floating-window affair: the two never compete because `headerTargetAt` excludes
// docked windows. Counterfactual (proven at commit time): with the split branch removed
// the drop wiggles the occupant and one panel remains → the two-panel check goes red.
const h = require('./helpers.cjs');

const box = (page, sel) => page.locator(sel).boundingBox();
const attrs = (page, sel) =>
	page.evaluate((sel) => {
		const el = document.querySelector(sel);
		return el ? { docked: el.dataset.docked ?? null, slot: el.dataset.dockSlot ?? null } : null;
	}, sel);
const dragHeader = async (page, sel, dx, dy, to) => {
	const b = await box(page, sel);
	await page.mouse.move(b.x + 100, b.y + 10);
	await page.mouse.down();
	await page.mouse.move(to ? to[0] : b.x + 100 + dx, to ? to[1] : b.y + 10 + dy, { steps: 12 });
	await page.mouse.up();
	await page.waitForTimeout(300);
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const vw = await A.page.evaluate(() => window.innerWidth);
	const vh = await A.page.evaluate(() => window.innerHeight);

	// dock the object list on the right (81L)
	await A.page.locator('p[title="Object list (O)"]').click();
	await A.page.waitForTimeout(400);
	await dragHeader(A.page, '#object-list', 0, 0, [vw - 15, 400]);
	let list = await box(A.page, '#object-list');
	h.check(Math.abs(list.x + list.width - vw) < 4 && list.height > vh * 0.8, `object list docked right, full height (${Math.round(list.height)})`);
	const column = list.height;

	// a second window dropped ONTO it splits the edge
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(500);
	await A.page.locator('#flow-undock').click();
	await A.page.waitForTimeout(400);
	const flow0 = await box(A.page, '#flow-window');
	await A.page.mouse.move(flow0.x + 120, flow0.y + 12);
	await A.page.mouse.down();
	await A.page.mouse.move(list.x + list.width / 2, list.y + list.height * 0.75, { steps: 12 });
	const zone = await A.page.evaluate(() => {
		const z = document.querySelector('#dock-zone');
		return z ? { split: z.dataset.split ?? null, text: z.textContent } : null;
	});
	h.check(zone?.split === 'bottom', `hovering the lower half shows the SPLIT affordance for the bottom slot (${JSON.stringify(zone)})`);
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	list = await box(A.page, '#object-list');
	let flow = await box(A.page, '#flow-window');
	const a1 = await attrs(A.page, '#object-list');
	const a2 = await attrs(A.page, '#flow-window');
	h.check(a1?.docked === 'right' && a2?.docked === 'right', `both windows are docked right (${JSON.stringify([a1, a2])})`);
	h.check(a1?.slot === 'top' && a2?.slot === 'bottom', 'the occupant kept the top slot, the dropped window took the bottom');
	h.check(Math.abs(flow.y - (list.y + list.height + 6)) < 3, `they stack with the divider between them (gap ${Math.round(flow.y - list.y - list.height)})`);
	h.check(Math.abs(list.height + flow.height + 6 - column) < 4, `the two heights fill the column (${Math.round(list.height)} + ${Math.round(flow.height)} vs ${Math.round(column)})`);
	h.check(Math.abs(list.width - flow.width) < 2 && Math.abs(flow.x + flow.width - vw) < 4, 'both share the column width on the edge');

	// the divider drags and the share persists
	const divider = await box(A.page, '#object-list .dock-split-divider');
	h.check(!!divider, 'the top panel carries the split divider (premise)');
	await A.page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
	await A.page.mouse.down();
	await A.page.mouse.move(divider.x + divider.width / 2, divider.y - 150, { steps: 10 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(200);
	const listUp = await box(A.page, '#object-list');
	const flowUp = await box(A.page, '#flow-window');
	h.check(list.height - listUp.height > 120, `dragging the divider up shrinks the top panel (${Math.round(list.height)} → ${Math.round(listUp.height)})`);
	h.check(flowUp.height - flow.height > 120, `...and grows the bottom one (${Math.round(flow.height)} → ${Math.round(flowUp.height)})`);
	const ratio = await A.page.evaluate(() => parseFloat(localStorage.getItem('dockSplit:right') ?? 'NaN'));
	h.check(ratio > 0.15 && ratio < 0.5, `the share persisted (${ratio})`);
	const savedDock = await A.page.evaluate(() => JSON.parse(localStorage.getItem('dockedWindows') ?? 'null'));
	h.check(Array.isArray(savedDock?.right) && savedDock.right.join() === 'objects,flow', `the stack persisted in order (${JSON.stringify(savedDock)})`);

	// a THIRD window is refused (max two per edge): the Explorer, undocked
	// (the wiggle is an animation; the assertion is that nothing docked)
	const third = await A.page.evaluate(() => {
		const s = window.__stores;
		return typeof s.explorerClose?.set === 'function';
	});
	if (third) {
		await A.page.evaluate(() => window.__stores.explorerClose.set(false));
		await A.page.waitForTimeout(600);
		const undockBtn = A.page.locator('#explorer-undock');
		if (await undockBtn.count()) {
			await undockBtn.first().click();
			await A.page.waitForTimeout(400);
			const ex = await box(A.page, '#explorer-window');
			if (ex) {
				await A.page.mouse.move(ex.x + 100, ex.y + 10);
				await A.page.mouse.down();
				await A.page.mouse.move(vw - 15, 300, { steps: 10 });
				await A.page.mouse.up();
				await A.page.waitForTimeout(300);
				const exAttrs = await attrs(A.page, '#explorer-window');
				h.check(exAttrs?.docked !== 'right', 'a third window on a full edge is refused');
				await A.page.evaluate(() => window.__stores.explorerClose.set(true));
			}
		}
	}

	// reload: both come back split at the same share. Each window's side-dock is
	// restored as its NODE mounts, so both have to be open again first — driven
	// through the stores rather than the toggles, which would close whatever the
	// reload happened to restore as open.
	await h.freshReload(A);
	await A.page.waitForTimeout(1200);
	await A.page.evaluate(() => {
		window.__stores.objectListClose.set(false);
		window.__stores.flowGraphClose.set(false);
	});
	await A.page.waitForTimeout(1200);
	const listBack = await box(A.page, '#object-list');
	const flowBack = await box(A.page, '#flow-window');
	const back1 = await attrs(A.page, '#object-list');
	const back2 = await attrs(A.page, '#flow-window');
	h.check(back1?.slot === 'top' && back2?.slot === 'bottom', `the split survives a reload (${JSON.stringify([back1, back2])})`);
	h.check(listBack && Math.abs(listBack.height - listUp.height) < 6, `...at the dragged share (${Math.round(listUp.height)} → ${Math.round(listBack?.height)})`);

	// undocking one member collapses the split
	await dragHeader(A.page, '#flow-window', 400, 200);
  const flowFloat = await attrs(A.page, '#flow-window');
	const listFull = await box(A.page, '#object-list');
	const listAttrs = await attrs(A.page, '#object-list');
	h.check(flowFloat?.docked === null, 'drag-away undocks the bottom member');
	h.check(listAttrs?.docked === 'right' && listAttrs?.slot === null && listFull.height > vh * 0.8, `the remaining panel takes the whole column again (${Math.round(listFull.height)})`);
	h.check(!(await A.page.locator('#object-list .dock-split-divider').count()), 'the divider is gone with the split');

	await h.finish(browser);
});
