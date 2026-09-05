// W1: the viewport menu's Tools submenu gains "Node editor".
//
// The node editor had exactly two doors — the N key and the toolbar button — and the
// toolbar is customizable now, so a user can hide the only one they can see. Tools is
// where an editor belongs, and the row calls `togglePanel('flow')`: the SAME decision
// tree the key and the button already run, so the three cannot disagree about what
// "open the node editor" means in the dock mode you are actually in.
//
// Driven the way a user drives it: the documented viewport-menu opener (the store the
// canvas right-tap writes, grid-snapping's recipe), a real hover to open the submenu
// and a real click on its row. ContextMenu rows are DIVs with role=menuitem.
const h = require('./helpers.cjs');

const dockState = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let visible, occupants, fc;
		s.bottomDock.visibleDockKey.subscribe((v) => (visible = v))();
		s.bottomDock.dockOccupants.subscribe((v) => (occupants = v))();
		s.flowGraphClose.subscribe((v) => (fc = v))();
		return { visible, flowDocked: !!occupants.flow?.present, flowClosed: fc };
	});

/** open the viewport menu and hover its Tools row */
async function toolsSubmenu(page) {
	await page.evaluate(() => window.__stores.viewportMenu.set({ x: 260, y: 160, point: [0, 0, 0] }));
	await page.waitForTimeout(350);
	await page.locator('[role="menuitem"]').filter({ hasText: 'Tools' }).first().hover();
	await page.waitForTimeout(350);
	return page.evaluate(() => {
		// submenus render as fixed divs with NO role (the menu suites' own convention)
		const sub = [...document.querySelectorAll('div')].find(
			(d) =>
				getComputedStyle(d).position === 'fixed' &&
				!d.getAttribute('role') &&
				d.textContent?.includes('Draw mode')
		);
		return {
			found: !!sub,
			rows: [...(sub?.querySelectorAll('[role="menuitem"]') ?? [])].map((r) => r.textContent?.trim())
		};
	});
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// premise: the node editor is closed, so opening it is a visible change
	let state = await dockState(A.page);
	h.check(state.flowClosed === true, `premise: the node editor starts closed (${state.flowClosed})`);

	const sub = await toolsSubmenu(A.page);
	h.check(sub.found, `the Tools submenu opens (${sub.rows.join(' | ')})`);
	h.check(
		sub.rows.some((r) => r.startsWith('Node editor')),
		`Tools lists Node editor beside the other tools (${sub.rows.join(' | ')})`
	);
	h.check(
		sub.rows.some((r) => r.includes('Draw mode')) &&
			sub.rows.some((r) => r.includes('Measure')) &&
			sub.rows.some((r) => r.includes('Simulate physics')),
		'and the tools that were already there are untouched'
	);

	// the row carries the N hint, so the menu teaches the shortcut it shares
	h.check(
		await A.page.evaluate(
			() =>
				[...document.querySelectorAll('[role="menuitem"]')]
					.find((r) => r.textContent?.trim().startsWith('Node editor'))
					?.querySelector('.ctx-hint')
					?.textContent?.trim() === 'N'
		),
		'the row shows its keyboard hint (N)'
	);

	// a REAL click on the submenu row. The parent "Tools" row CONTAINS the submenu, so
	// both match — the descendant is the later one in document order.
	await A.page.locator('[role="menuitem"]').filter({ hasText: 'Node editor' }).last().click();
	await A.page.waitForTimeout(600);

	h.check(
		await A.page.evaluate(() => !document.querySelector('[role="menu"]')),
		'picking it closes the menu (an ordinary command row, not a checklist)'
	);
	state = await dockState(A.page);
	h.check(
		state.flowClosed === false,
		`the node editor opened (flowClosed=${state.flowClosed})`
	);
	h.check(
		state.flowDocked ? state.visible === 'flow' : true,
		`and in its DOCKED mode it is the visible dock tab (docked=${state.flowDocked} visible=${state.visible})`
	);
	h.check(
		await A.page.evaluate(() => {
			// docked it is #flow-list (hidden when another dock tab is showing),
			// floating it is #flow-window — either way a real, visible element
			const el = document.querySelector('#flow-list:not(.hidden)') || document.querySelector('#flow-window');
			return !!el && el.getBoundingClientRect().height > 0;
		}),
		'the editor really is on screen, not just a flag nobody read'
	);

	// and it TOGGLES, like the key and the button — same decision tree, same row
	await toolsSubmenu(A.page);
	await A.page.locator('[role="menuitem"]').filter({ hasText: 'Node editor' }).last().click();
	await A.page.waitForTimeout(600);
	state = await dockState(A.page);
	h.check(state.flowClosed === true, `a second pick closes it again (${state.flowClosed})`);

	h.check(h.pageErrors(A).length === 0, `the page threw nothing (${h.pageErrors(A).join(' / ')})`);
	await h.finish(browser);
});
