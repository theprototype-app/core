// Phase 62: node search — swap-box replaces the pane menu, type-to-search,
// Enter drops the node at the right-click spot, Esc returns to the menu.
// Phase 91: menus clamp + scroll near the screen edge; node cards show their
// labels and dark-styled inputs.
const h = require('./helpers.cjs');

const nodeTypes = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.flowNodes.subscribe((n) => r(n.map((x) => x.type)))())
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// open the flow editor and right-click the pane
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(800);
	const pane = A.page.locator('.svelte-flow__pane');
	await pane.click({ button: 'right', position: { x: 400, y: 120 } });
	await A.page.waitForTimeout(300);
	h.check(
		await A.page.getByText('🔍 Search nodes…').isVisible(),
		'menu shows the search entry first'
	);

	// typing while the menu is open jumps into search with the char prefilled
	await A.page.keyboard.type('p');
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('#node-search-box').isVisible(), 'typing swaps the menu for the search box');
	const value = await A.page.locator('#node-search-input').inputValue();
	h.check(value === 'p', `typed character carried into the input (${value})`);

	// narrow to path patrol and Enter-drop it
	await A.page.locator('#node-search-input').fill('path');
	await A.page.waitForTimeout(200);
	h.check(
		await A.page.locator('#node-search-box').getByText('Path patrol').isVisible(),
		'results show Category · Label matches'
	);
	await A.page.keyboard.press('Enter');
	await h.eventually(() => nodeTypes(A.page), (t) => t.includes('pathpatrol'), 'Enter adds the node');
	h.check(!(await A.page.locator('#node-search-box').isVisible()), 'search closes after adding');

	// Esc from search returns to the classic grouped menu (empty spot, away from the new node)
	await pane.click({ button: 'right', position: { x: 660, y: 60 } });
	await A.page.waitForTimeout(300);
	await A.page.keyboard.type('w');
	await A.page.waitForTimeout(200);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);
	h.check(await A.page.getByText('🔍 Search nodes…').isVisible(), 'Esc restores the grouped menu');
	await A.page.mouse.click(900, 400); // backdrop click closes the restored menu
	await A.page.waitForTimeout(200);

	// module + custom entries searchable: wave from the hello module
	await pane.click({ button: 'right', position: { x: 240, y: 220 } });
	await A.page.waitForTimeout(200);
	await A.page.keyboard.type('wave');
	await A.page.waitForTimeout(200);
	await A.page.keyboard.press('Enter');
	await h.eventually(() => nodeTypes(A.page), (t) => t.includes('wave'), 'module nodes searchable');

	// palette filter narrows the drag list
	await A.page.locator('#palette-filter').fill('slider');
	await A.page.waitForTimeout(200);
	const paletteLabels = await A.page.evaluate(() =>
		[...document.querySelectorAll('aside [draggable="true"]')].map((el) => el.textContent?.trim())
	);
	h.check(
		paletteLabels.length === 1 && paletteLabels[0] === 'Slider',
		`palette filter works (${paletteLabels.join(',')})`
	);

	// 124: a right-click near the bottom edge FLIPS the menu up (no scrollbar) —
	// context menus never scroll now (node search keeps its own results scroll)
	await pane.click({ button: 'right', position: { x: 150, y: 285 } });
	await A.page.waitForTimeout(300);
	const menuBox = await A.page.evaluate(() => {
		const el = document.querySelector('[role="menu"]');
		const rect = el.getBoundingClientRect();
		return {
			overflowY: getComputedStyle(el).overflowY,
			fits: rect.bottom <= window.innerHeight + 1,
			notCapped: el.style.maxHeight === ''
		};
	});
	h.check(
		menuBox.overflowY === 'visible' && menuBox.fits && menuBox.notCapped,
		`pane menu flips on screen without a scrollbar (${JSON.stringify(menuBox)})`
	);
	// ...and the search box opened from down there is clamped into view
	await A.page.keyboard.type('s');
	await A.page.waitForTimeout(300);
	const searchFits = await A.page.evaluate(() => {
		const rect = document.querySelector('#node-search-box').getBoundingClientRect();
		return rect.bottom <= window.innerHeight + 1 && rect.top >= 0;
	});
	h.check(searchFits, 'search box clamps into the viewport near the bottom');
	await A.page.keyboard.press('Escape'); // back to the grouped menu
	await A.page.mouse.click(900, 60); // backdrop click closes it
	await A.page.waitForTimeout(200);

	// 103: submenus render FIXED (no horizontal scrollbar on the root menu)
	// and the chevron is the small ▸, not the heavy ▶
	await pane.click({ button: 'right', position: { x: 400, y: 100 } });
	await A.page.waitForTimeout(300);
	await A.page.locator('[role="menuitem"]', { hasText: 'Animation' }).first().hover();
	await A.page.waitForTimeout(300);
	const subState = await A.page.evaluate(() => {
		const menu = document.querySelector('[role="menu"]');
		const sub = [...document.querySelectorAll('div')].find(
			(el) => getComputedStyle(el).position === 'fixed' && el.textContent?.includes('Bounce') && !el.getAttribute('role')
		);
		return {
			// 124: no scrollbar can render — the menu doesn't scroll at all
			// (overflow visible), and submenus are fixed-positioned outside it
			noHScroll: menu ? getComputedStyle(menu).overflowX === 'visible' : false,
			subFixed: !!sub,
			subOnScreen: sub
				? sub.getBoundingClientRect().right <= window.innerWidth + 1 && sub.getBoundingClientRect().top >= 0
				: false,
			chevron: (menu?.textContent ?? '').includes('▸') && !(menu?.textContent ?? '').includes('▶')
		};
	});
	h.check(subState.noHScroll, 'no horizontal scrollbar with a submenu open (103)');
	h.check(subState.subFixed && subState.subOnScreen, 'submenu renders fixed and on screen');
	h.check(subState.chevron, 'submenu arrow is the light chevron');
	await A.page.mouse.click(900, 60); // backdrop click closes the menu
	await A.page.waitForTimeout(200);

	// 103: empty flow search browses ALL entries (scrollable, Add-search parity)
	await pane.click({ button: 'right', position: { x: 300, y: 100 } });
	await A.page.waitForTimeout(200);
	await A.page.getByText('🔍 Search nodes…').click();
	await A.page.waitForTimeout(300);
	const browseAll = await A.page.evaluate(() => {
		const list = document.querySelector('#node-search-box .max-h-64');
		return { rows: list?.children.length ?? 0, scrolls: list ? list.scrollHeight > list.clientHeight : false };
	});
	h.check(
		browseAll.rows > 10 && browseAll.scrolls,
		`empty search browses everything with a scrollbar (${browseAll.rows} rows)`
	);
	await A.page.keyboard.press('Escape'); // back to the grouped menu
	await A.page.mouse.click(900, 60); // backdrop click closes it
	await A.page.waitForTimeout(200);

	// 91: node cards show their LABEL (not the raw type) and dark inputs
	await A.page.evaluate(() => {
		// read first, then write — never from inside the subscriber
		let list = [];
		window.__stores.flowNodes.subscribe((n) => (list = n))();
		window.__stores.flowNodes.set([
			...list,
			{
				id: 'sel-91',
				type: 'objectselector',
				position: { x: 40, y: 40 },
				data: { type: 'objectselector', label: 'Object Selector', selected: '-None-' },
				class: 'w-[150px]'
			}
		]);
	});
	await A.page.waitForTimeout(600);
	const look = await A.page.evaluate(() => {
		const cards = [...document.querySelectorAll('.node-card')];
		const selectorCard = cards.find((c) => c.textContent?.includes('Object Selector'));
		const header = selectorCard?.querySelector('div')?.textContent?.trim() ?? '';
		const select = selectorCard?.querySelector('select');
		const bg = select ? getComputedStyle(select).backgroundColor : '';
		return { header, bg };
	});
	h.check(look.header.includes('Object Selector'), `card header shows the label (${look.header})`);
	h.check(
		look.bg.startsWith('rgba(17, 24, 39') || look.bg.startsWith('rgb(17, 24, 39'),
		`node selects are dark-styled (${look.bg})`
	);

	await h.finish(browser);
});
