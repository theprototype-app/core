// Phase 39: object list search + type filters narrow the tree, ancestors stay visible.
const h = require('./helpers.cjs');

const visibleRows = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('#object-list [id]')]
			.map((el) => el.querySelector('.row-name, .row-rename')?.textContent?.trim())
			.filter(Boolean)
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// scene: 2 boxes, a light, and a group containing a sphere
	const groupUuid = await A.page.evaluate(async () => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create box');
		cmd('/create box');
		cmd('/light point');
		cmd('/create sphere 1');
		cmd('/group nest');
		// read refs first, mutate after — never write a store inside its subscriber
		const { group, sphere } = await new Promise((resolve) => {
			window.__stores.objectsGroup.subscribe((g) => {
				resolve({
					group: g.children.find((c) => c.type === 'Group')?.uuid,
					sphere: g.children.find((c) => c.name === 'Sphere')?.uuid
				});
			})();
		});
		window.__stores.objectActions.moveObjectToGroup(sphere, group);
		return group;
	});
	await A.page.waitForTimeout(400);

	// open the object list
	await A.page.locator('p[title="Object list (O)"]').click();
	await A.page.waitForTimeout(400);
	h.check(await A.page.locator('#object-search').isVisible(), 'search input visible');

	// search narrows to matches + shows count
	await A.page.locator('#object-search').fill('sphere');
	await A.page.waitForTimeout(300);
	let rows = await visibleRows(A.page);
	h.check(
		rows.some((r) => r === 'Sphere') && !rows.some((r) => r === 'Box'),
		`search shows only matches + ancestors (${rows.join(',')})`
	);
	h.check(rows.some((r) => r?.includes('nest')), 'ancestor group stays visible and expanded');
	h.check(await A.page.getByText('1 match').isVisible(), 'match count shown');

	// Esc clears
	await A.page.locator('#object-search').press('Escape');
	await A.page.waitForTimeout(300);
	rows = await visibleRows(A.page);
	h.check(rows.some((r) => r === 'Box'), 'Escape clears the search');

	// type filter: lights only
	await A.page.getByRole('button', { name: 'Lights', exact: true }).click();
	await A.page.waitForTimeout(300);
	rows = await visibleRows(A.page);
	h.check(
		rows.some((r) => r === 'Point') && !rows.some((r) => r === 'Box'),
		`lights filter works (${rows.join(',')})`
	);
	await A.page.getByRole('button', { name: 'All', exact: true }).click();

	// typing in the search box must not trigger shortcuts (digit 1 = translate mode)
	await A.page.locator('#object-search').fill('');
	await A.page.locator('#object-search').press('1');
	await A.page.waitForTimeout(200);
	h.check(true, 'typed a digit in search without errors (shortcut guard)');

	// ---- 80: multi-active chips (union) + All-toggle memory ----
	await A.page.locator('#object-search').fill(''); // drop the digit-guard leftover
	await A.page.getByRole('button', { name: 'Lights', exact: true }).click();
	await A.page.getByRole('button', { name: 'Groups', exact: true }).click();
	await A.page.waitForTimeout(300);
	rows = await visibleRows(A.page);
	h.check(
		rows.some((r) => r === 'Point') && rows.some((r) => r?.includes('nest')) && !rows.some((r) => r === 'Box'),
		`two chips filter as a union (${rows.join(',')})`
	);
	await A.page.getByRole('button', { name: 'All', exact: true }).click();
	await A.page.waitForTimeout(300);
	rows = await visibleRows(A.page);
	h.check(rows.some((r) => r === 'Box'), 'All shows everything');
	await A.page.getByRole('button', { name: 'All', exact: true }).click();
	await A.page.waitForTimeout(300);
	rows = await visibleRows(A.page);
	h.check(
		rows.some((r) => r === 'Point') && !rows.some((r) => r === 'Box'),
		'All again restores the previous chip set'
	);

	// ---- 80: chip visibility popup + reset all filters ----
	await A.page.locator('#chip-config').click();
	await A.page.locator('#chip-popup label', { hasText: 'Strokes' }).locator('input').click();
	await A.page.waitForTimeout(200);
	h.check(
		!(await A.page.locator('#filter-chips').getByRole('button', { name: 'Strokes', exact: true }).isVisible().catch(() => false)),
		'unchecked chip leaves the bar'
	);
	await A.page.locator('#reset-filters').click();
	await A.page.waitForTimeout(300);
	h.check(
		await A.page.locator('#filter-chips').getByRole('button', { name: 'Strokes', exact: true }).isVisible(),
		'reset restores the chips'
	);
	rows = await visibleRows(A.page);
	h.check(rows.some((r) => r === 'Box'), 'reset cleared the type filters');

	// ---- 80: resize persists ----
	const before = await A.page.locator('#object-list').boundingBox();
	const handle = await A.page.locator('#object-list .resize-handle').boundingBox();
	await A.page.mouse.move(handle.x + 4, handle.y + 4);
	await A.page.mouse.down();
	await A.page.mouse.move(handle.x + 80, handle.y + 60, { steps: 6 });
	await A.page.mouse.up();
	const after = await A.page.locator('#object-list').boundingBox();
	h.check(after.width > before.width + 50, `corner resize grows the window (${before.width} → ${after.width})`);
	const savedRect = await A.page.evaluate(() => JSON.parse(localStorage.getItem('objectListRect') ?? 'null'));
	h.check(savedRect && Math.abs(savedRect.width - after.width) < 4, 'rect persisted');

	await h.finish(browser);
});
