// Phase 105: dock-aware layout — the visible bottom dock publishes
// --bottom-inset; drawers and edge-docked windows end ABOVE it, tracking
// resizes; palette tabs mirror when the palette sits right.
const h = require('./helpers.cjs');

const inset = (page) =>
	page.evaluate(() =>
		parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottom-inset') || '0')
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	h.check((await inset(A.page)) === 0, 'inset is 0 with the dock closed');

	// open the flow drawer -> inset = its height; sidebar ends above it
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(700);
	const flowH = (await A.page.locator('#flow-list').boundingBox()).height;
	h.check(Math.abs((await inset(A.page)) - flowH) < 2, `inset follows the dock height (${flowH})`);

	// 203: the sidebar now FLOATS ON TOP of the dock (z-hud) instead of ending
	// above it — it's a compact panel that is never covered by the dock
	await A.page.locator('#logo-menu').click();
	await A.page.waitForTimeout(600);
	const layout = await A.page.evaluate(() => {
		const sb = document.querySelector('#sidebar70');
		const dock = document.querySelector('#flow-list');
		return {
			present: !!sb,
			sbZ: sb ? parseInt(getComputedStyle(sb).zIndex || '0') : 0,
			dockZ: dock ? parseInt(getComputedStyle(dock).zIndex || '0') : 0
		};
	});
	h.check(layout.present, 'the sidebar renders');
	h.check(layout.sbZ >= 40 && layout.sbZ > layout.dockZ, `sidebar floats on top of the dock (z ${layout.sbZ} > ${layout.dockZ})`);

	// resizing the dock updates the inset live
	const hot = await A.page.locator('#flow-list .resize-cue').first().boundingBox();
	await A.page.mouse.move(hot.x + 400, hot.y + 1);
	await A.page.mouse.down();
	await A.page.mouse.move(hot.x + 400, hot.y - 60, { steps: 6 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const grown = await inset(A.page);
	h.check(Math.abs(grown - (flowH + 60)) < 12, `inset tracks the resize (${grown})`);

	// an edge-docked object list also ends above the dock
	await A.page.locator('p[title="Object list (O)"]').click();
	await A.page.waitForTimeout(400);
	await A.page.evaluate(() => {
		const node = document.querySelector('#object-list');
		window.__stores; // hook warm
		// drag it to the left edge via the docking API is UI-driven; emulate the
		// drop by calling the action's path: pointer drag to x=2
	});
	const list = await A.page.locator('#object-list').boundingBox();
	await A.page.mouse.move(list.x + 100, list.y + 8);
	await A.page.mouse.down();
	await A.page.mouse.move(2, 300, { steps: 12 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(500);
	const dockedBox = await A.page.evaluate(() => {
		const node = document.querySelector('#object-list');
		const dock = document.querySelector('#flow-list')?.getBoundingClientRect();
		return {
			docked: node?.dataset.docked ?? null,
			bottom: node?.getBoundingClientRect().bottom ?? 0,
			dockTop: dock?.top ?? 0
		};
	});
	h.check(dockedBox.docked === 'left', 'object list edge-docked');
	h.check(
		dockedBox.bottom <= dockedBox.dockTop + 2,
		`edge-docked window ends above the dock (${Math.round(dockedBox.bottom)} <= ${Math.round(dockedBox.dockTop)})`
	);

	// closing the dock releases the inset
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(500);
	h.check((await inset(A.page)) === 0, 'inset returns to 0 when the dock closes');

	// palette tabs mirror when the palette moves right
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(600);
	const before = await A.page.evaluate(() =>
		document.querySelector('#palette-toggle')?.classList.contains('palette-tab-mirrored')
	);
	await A.page.locator('#palette-side').click();
	await A.page.waitForTimeout(300);
	const after = await A.page.evaluate(() =>
		document.querySelector('#palette-toggle')?.classList.contains('palette-tab-mirrored')
	);
	h.check(before === false && after === true, 'palette tabs mirror on the right side');
	await A.page.locator('#palette-side').click();

	await h.finish(browser);
});
