// Phase 62: node search — type-to-search from the pane menu, Enter drops the
// node at the right-click spot, Esc returns to the menu.
// Phase 91: menus clamp + scroll near the screen edge; node cards show their
// labels and dark-styled inputs.
// 16-P2: the private #node-search-box is GONE — search now runs inside the
// context menu through the shared filter (.ctx-filter-input / .ctx-match), so
// ranking, arrow keys and shortcut interception are the same as everywhere else.
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
		await A.page.getByText('Search nodes…').isVisible(),
		'menu shows the search entry first'
	);

	// typing while the menu is open reveals the shared filter with the char in it
	await A.page.keyboard.type('p');
	await A.page.waitForTimeout(300);
	const revealed = await A.page.evaluate(() => {
		const row = document.querySelector('.ctx-filter');
		return {
			height: row?.getBoundingClientRect().height ?? -1,
			value: document.querySelector('.ctx-filter-input')?.value ?? null,
			noOldBox: !document.querySelector('#node-search-box')
		};
	});
	h.check(revealed.height > 0, 'typing reveals the filter row inside the menu');
	h.check(revealed.value === 'p', `the typed character lands in it (${revealed.value})`);
	h.check(revealed.noOldBox, 'the separate search popup is gone');

	// narrow to path patrol and Enter-drop it — matches carry their group path
	await A.page.locator('.ctx-filter-input').fill('path');
	await A.page.waitForTimeout(250);
	const matches = await A.page.evaluate(() =>
		[...document.querySelectorAll('.ctx-match')].map((m) => m.textContent?.trim())
	);
	h.check(
		matches.some((m) => m.includes('Path patrol')),
		`results show Group ▸ Label matches (${matches.slice(0, 3).join(' | ')})`
	);
	await A.page.keyboard.press('Enter');
	await h.eventually(() => nodeTypes(A.page), (t) => t.includes('pathpatrol'), 'Enter adds the node');
	h.check(!(await A.page.locator('[role="menu"]').isVisible()), 'the menu closes after adding');

	// Esc clears the query and keeps the grouped menu (empty spot, away from the new node)
	await pane.click({ button: 'right', position: { x: 660, y: 60 } });
	await A.page.waitForTimeout(300);
	await A.page.keyboard.type('w');
	await A.page.waitForTimeout(200);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);
	const afterEsc = await A.page.evaluate(() => ({
		query: document.querySelector('.ctx-filter-input')?.value ?? null,
		grouped: !!document.querySelector('[role="menu"]')?.textContent?.includes('Search nodes')
	}));
	h.check(afterEsc.query === '' && afterEsc.grouped, 'Esc clears the query back to the grouped menu');
	await A.page.keyboard.press('Escape'); // a second Esc closes it
	await A.page.waitForTimeout(200);
	h.check(!(await A.page.locator('[role="menu"]').isVisible()), 'a second Esc closes the menu');

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

	// A right-click near the bottom edge keeps the menu fully on screen. NOTE: the
	// old assertion here ("never scrolls, never capped") was left stale by the
	// later change that made tall menus CAP to the viewport and scroll vertically
	// (context-menu-overflow owns that contract) — this suite is on CLAUDE.md's
	// known-failing list partly because of it.
	await pane.click({ button: 'right', position: { x: 150, y: 285 } });
	await A.page.waitForTimeout(300);
	const menuBox = await A.page.evaluate(() => {
		const el = document.querySelector('[role="menu"]');
		const rect = el.getBoundingClientRect();
		return {
			overflowY: getComputedStyle(el).overflowY,
			fits: rect.bottom <= window.innerHeight + 1 && rect.top >= 0,
			capped: el.style.maxHeight !== ''
		};
	});
	h.check(
		menuBox.fits && menuBox.overflowY === 'auto' && menuBox.capped,
		`pane menu stays on screen, capped + vertically scrollable (${JSON.stringify(menuBox)})`
	);
	// ...and filtering from down there keeps the whole menu on screen
	await A.page.keyboard.type('s');
	await A.page.waitForTimeout(300);
	const searchFits = await A.page.evaluate(() => {
		const el = document.querySelector('[role="menu"]');
		if (!el) return { gone: true };
		const rect = el.getBoundingClientRect();
		return {
			ok: rect.bottom <= window.innerHeight + 1 && rect.top >= 0,
			top: Math.round(rect.top),
			bottom: Math.round(rect.bottom),
			vh: window.innerHeight,
			matches: document.querySelectorAll('.ctx-match').length
		};
	});
	h.check(searchFits.ok === true, `the filtered menu stays inside the viewport near the bottom (${JSON.stringify(searchFits)})`);
	await A.page.keyboard.press('Escape'); // clear the query
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
			// submenus are fixed-positioned OUTSIDE the scroll box, so the root menu
			// never needs a horizontal scrollbar (overflow-x is hidden outright)
			noHScroll: menu ? getComputedStyle(menu).overflowX === 'hidden' : false,
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

	// 16-P2: clicking "Search nodes…" reveals the (empty) filter WITHOUT closing
	// the menu — the grouped list stays as the browse view it always was
	await pane.click({ button: 'right', position: { x: 300, y: 100 } });
	await A.page.waitForTimeout(200);
	await A.page.getByText('Search nodes…').click();
	await A.page.waitForTimeout(300);
	const reveal = await A.page.evaluate(() => {
		const row = document.querySelector('.ctx-filter');
		const menu = document.querySelector('[role="menu"]');
		return {
			shown: (row?.getBoundingClientRect().height ?? 0) > 0,
			focused: document.activeElement === document.querySelector('.ctx-filter-input'),
			stillGrouped: !!menu?.textContent?.includes('Animation'),
			groups: menu ? menu.querySelectorAll('[role="menuitem"]').length : 0
		};
	});
	h.check(reveal.shown && reveal.focused, 'the row reveals the filter and keeps the keyboard');
	h.check(
		reveal.stillGrouped && reveal.groups > 5,
		`the grouped menu stays open behind it (${reveal.groups} rows)`
	);
	await A.page.keyboard.press('Escape'); // hides the filter again
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
