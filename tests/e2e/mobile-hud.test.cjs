// Roadmap #9 fixes: the mobile "+" opener (viewportMenuOpener opens the same
// create/context menu as a right-click), the object-menu parity (direct menu ==
// the ViewportMenu "Selected" submenu, both from buildObjectMenuItems), and the
// object-list window drag using pointer events (touch-capable).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// the "+" button is visible on ALL widths now — including a wide desktop viewport
	await A.page.setViewportSize({ width: 1200, height: 800 });
	h.check((await A.page.locator('#mobile-add-button').count()) === 1, 'the mobile + button is in the DOM');
	h.check(await A.page.locator('#mobile-add-button').isVisible(), 'the + button is visible on a wide desktop (not gated to <=820px)');

	// viewportMenuOpener opens the create menu (forceEmpty) even over an object
	const opened = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let opener;
		s.viewportMenuOpener.subscribe((v) => (opener = v))();
		if (!opener) return { ran: false };
		opener(200, 200, true);
		let vm;
		s.viewportMenu.subscribe((v) => (vm = v))();
		return { ran: true, hasMenu: !!vm, point: vm?.point?.length === 3 };
	});
	h.check(opened.ran, 'Scene registered viewportMenuOpener');
	h.check(opened.hasMenu && opened.point, 'the opener opens the viewport create menu with a ground point');
	await A.page.evaluate(() => window.__stores.viewportMenu.set(null));

	// the menu position can be DECOUPLED from the ray: the "+" button rays from
	// screen-centre but anchors the menu to its own rect (menuX/menuY args)
	const anchored = await A.page.evaluate(() => {
		const s = window.__stores;
		let opener;
		s.viewportMenuOpener.subscribe((v) => (opener = v))();
		opener(600, 400, true, 16, 720); // ray centre-ish, menu bottom-left (button)
		let vm;
		s.viewportMenu.subscribe((v) => (vm = v))();
		return { x: vm?.x, y: vm?.y, hasPoint: vm?.point?.length === 3 };
	});
	h.check(anchored.x === 16 && anchored.y === 720, `menu opens at the button anchor, not the ray point (x=${anchored.x}, y=${anchored.y})`);
	h.check(anchored.hasPoint, 'the ground point is still computed from the ray coords');
	await A.page.evaluate(() => window.__stores.viewportMenu.set(null));

	// object-menu parity: the shared builder has the full set (the indirect
	// "Selected" submenu used to lack these)
	const items = await A.page.evaluate(() => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const uuid = g.children[g.children.length - 1].uuid;
		return s.objectMenu.buildObjectMenuItems(uuid).map((i) => i.label);
	});
	for (const label of ['Save as prefab', 'Rename', 'Align to ground', 'Delete', 'Ping this object']) {
		h.check(items.includes(label), `object menu includes "${label}" (parity)`);
	}

	// object-list window drags via POINTER events (touch-capable) — move the header
	await A.page.evaluate(() => window.__stores.objectListClose.set(false));
	await A.page.waitForTimeout(400);
	const moved = await A.page.evaluate(async () => {
		const win = document.querySelector('#object-list');
		const handle = win.querySelector('.move-handle') || win;
		const before = win.getBoundingClientRect().left;
		const opts = (x, y) => ({ clientX: x, clientY: y, bubbles: true, pointerId: 1 });
		handle.dispatchEvent(new PointerEvent('pointerdown', opts(400, 120)));
		window.dispatchEvent(new PointerEvent('pointermove', { ...opts(340, 160), movementX: -60, movementY: 40 }));
		window.dispatchEvent(new PointerEvent('pointerup', opts(340, 160)));
		await new Promise((r) => setTimeout(r, 100));
		return { before, after: win.getBoundingClientRect().left };
	});
	h.check(moved.after < moved.before, `object-list window moves on pointer drag (${Math.round(moved.before)}->${Math.round(moved.after)})`);

	await h.finish(browser);
});
