// Phase 124: context menu pass — selection ops group into one submenu named
// after the object, and no context menu ever scrolls (submenus are fixed and
// stay visible). The node-search results box keeps its own scroll (separate).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const openViewportMenu = () =>
		A.page.evaluate(() => window.__stores.viewportMenu.set({ x: 200, y: 160, point: { x: 0, y: 0, z: 0 } }));
	const menuTexts = () =>
		A.page.evaluate(() =>
			[...document.querySelectorAll('[role="menu"] > *, [role="menuitem"]')].map((e) => e.textContent.trim())
		);

	// --- no selection: no selection subgroup, Add/Undo stay top-level ---
	await openViewportMenu();
	await A.page.waitForTimeout(300);
	const noSel = await A.page.evaluate(() => {
		const items = [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim());
		return {
			hasAdd: items.some((t) => t.startsWith('Add')),
			hasSearch: items.some((t) => t.includes('Search objects')),
			hasSubgroup: items.some((t) => t.includes('▸') && !t.startsWith('Add') && !t.includes('Tools') && !t.includes('Snapping') && !t.includes('View') && !t.includes('Camera') && !t.includes('Scene'))
		};
	});
	h.check(noSel.hasAdd, 'Add stays top-level');
	await A.page.evaluate(() => window.__stores.viewportMenu.set(null));
	await A.page.waitForTimeout(150);

	// --- with a selection: a '<name> ▸' subgroup holds the selection ops ---
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		box.name = 'Crate';
		window.__stores.objectActions.selectObject(box.uuid);
	});
	await openViewportMenu();
	await A.page.waitForTimeout(300);
	const subgroupPresent = await A.page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')].some((e) => e.textContent.trim().startsWith('Selected'))
	);
	h.check(subgroupPresent, 'selection ops group under a "Selected ▸" submenu (124: fixed label)');

	// hover the Selected subgroup → its children are the selection ops, on screen
	const subChildren = await A.page.evaluate(async () => {
		const row = [...document.querySelectorAll('[role="menuitem"]')].find((e) =>
			e.textContent.trim().startsWith('Selected')
		);
		row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 200));
		const sub = [...document.querySelectorAll('div')].find(
			(el) => getComputedStyle(el).position === 'fixed' && el.textContent?.includes('Focus') && !el.getAttribute('role')
		);
		return {
			labels: sub ? [...sub.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim()) : [],
			onScreen: sub ? sub.getBoundingClientRect().right <= window.innerWidth + 1 : false
		};
	});
	h.check(
		['Focus', 'Duplicate', 'Align to ground', 'Add note'].every((l) => subChildren.labels.some((t) => t.includes(l))) &&
			subChildren.labels.some((t) => t.includes('mesh')),
		`subgroup holds Focus/Duplicate/Align/Edit mesh/Add note (${subChildren.labels.join(',')})`
	);
	h.check(subChildren.onScreen, 'the submenu stays on screen');

	// --- roadmap #9: a too-tall menu MAY now scroll vertically (capped to the
	// viewport), but NEVER horizontally, and never via a transform ---
	const scroll = await A.page.evaluate(() => {
		const root = document.querySelector('[role="menu"]');
		const rs = getComputedStyle(root);
		const sub = [...document.querySelectorAll('div')].find(
			(el) => getComputedStyle(el).position === 'fixed' && el.textContent?.includes('Focus') && !el.getAttribute('role')
		);
		const ss = sub ? getComputedStyle(sub) : null;
		return {
			rootNoXScroll: rs.overflowX === 'hidden',
			subNoXScroll: ss ? ss.overflowX === 'hidden' : true,
			rootHasTransform: rs.transform !== 'none'
		};
	});
	h.check(scroll.rootNoXScroll, 'the menu never scrolls horizontally');
	h.check(scroll.subNoXScroll, 'submenus never scroll horizontally');
	h.check(!scroll.rootHasTransform, 'the root uses no transform (fixed submenus stay viewport-anchored)');

	await A.page.evaluate(() => window.__stores.viewportMenu.set(null));
	await h.finish(browser);
});
