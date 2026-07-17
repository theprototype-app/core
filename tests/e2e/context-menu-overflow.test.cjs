// Roadmap #9 fix: context menus (viewport "+", object, Flow) must stay on-screen —
// a too-tall menu caps to the viewport and scrolls (visible bar), and submenus
// re-flip per-level so a deep chain doesn't run off the right/bottom edge.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- a tall menu on a short viewport caps + scrolls, staying on-screen ---
	await A.page.setViewportSize({ width: 760, height: 320 });
	const uuid = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		return g.children[g.children.length - 1].uuid;
	});
	await A.page.evaluate((u) => window.__stores.objectContextMenu.set({ x: 30, y: 70, uuid: u, point: [0, 0, 0], locked: false }), uuid);
	await A.page.waitForTimeout(200);
	const root = await A.page.evaluate(() => {
		const m = document.querySelector('[role="menu"]');
		const r = m.getBoundingClientRect();
		return { bottom: r.bottom, top: r.top, vh: window.innerHeight, maxH: getComputedStyle(m).maxHeight, scrolls: m.scrollHeight > m.clientHeight + 1 };
	});
	h.check(root.bottom <= root.vh + 1 && root.top >= -1, `tall object menu stays on-screen (top=${Math.round(root.top)}, bottom=${Math.round(root.bottom)}, vh=${root.vh})`);
	h.check(root.maxH !== 'none', `menu height is capped (${root.maxH})`);
	h.check(root.scrolls, 'the capped menu scrolls its overflow');
	await A.page.evaluate(() => window.__stores.objectContextMenu.set(null));

	// --- a submenu opened near the right edge flips left, staying on-screen ---
	await A.page.setViewportSize({ width: 720, height: 700 });
	await A.page.evaluate(() => window.__stores.viewportMenu.set({ x: 650, y: 80, point: [0, 0, 0] }));
	await A.page.waitForTimeout(200);
	const sub = await A.page.evaluate(async () => {
		const row = [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.trim().startsWith('Snapping'));
		if (!row) return { found: false };
		row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 150));
		// the submenu is the fixed box containing "Snap to surface"
		const boxes = [...document.querySelectorAll('div')].filter((el) => getComputedStyle(el).position === 'fixed' && el.textContent?.includes('Snap to surface') && !el.getAttribute('role'));
		const box = boxes[boxes.length - 1];
		const r = box.getBoundingClientRect();
		return { found: true, left: r.left, right: r.right, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight };
	});
	h.check(sub.found, 'the Snapping submenu opened');
	h.check(sub.left >= -1 && sub.right <= sub.vw + 1, `submenu flipped to stay on-screen (left=${Math.round(sub.left)}, right=${Math.round(sub.right)}, vw=${sub.vw})`);

	await h.finish(browser);
});
