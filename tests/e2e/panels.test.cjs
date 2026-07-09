// Phase 49: panel redesign smoke — everything still opens, closes and works.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// sidebar: sections + files row render, actions fire
	await A.page.evaluate(() => window.__stores.closeMenu.set(false));
	await A.page.waitForTimeout(500);
	for (const label of ['Create', 'Assets', 'Files', 'Scene', 'App']) {
		h.check(
			await A.page.getByText(label, { exact: true }).first().isVisible(),
			`sidebar section "${label}" visible`
		);
	}
	h.check(await A.page.getByRole('button', { name: /Import/ }).isVisible(), 'files row visible');

	// create group via sidebar still works
	await A.page.getByText('Create Group', { exact: true }).click();
	await h.eventually(
		() =>
			A.page.evaluate(
				() =>
					new Promise((r) =>
						window.__stores.objectsGroup.subscribe((g) =>
							r(g?.children.some((c) => c.type === 'Group'))
						)()
					)
			),
		(v) => v === true,
		'Create Group works'
	);

	// properties panel opens with the type chip header
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await A.page.evaluate(async () => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = g.children.find((c) => c.name === 'Box');
		window.__stores.objectActions.selectObject(box.uuid, true);
	});
	await A.page.waitForTimeout(600);
	h.check(
		await A.page.locator('#drawer-label').getByText('Mesh', { exact: true }).isVisible(),
		'properties header shows the type chip'
	);
	h.check(await A.page.locator('#name').isVisible(), 'name input still there');

	// object list window: styled header + rows work
	await A.page.locator('p[title="Object list (O)"]').click();
	await A.page.waitForTimeout(400);
	h.check(await A.page.getByText('Objects', { exact: false }).first().isVisible(), 'object list header visible');
	h.check(await A.page.locator('#object-search').isVisible(), 'search survived the restyle');

	// save dropdown format picker still opens
	await A.page.getByRole('button', { name: /json/i }).first().click();
	await A.page.waitForTimeout(300);
	h.check(await A.page.getByText('GLTF', { exact: true }).isVisible(), 'save format dropdown opens');

	await h.finish(browser);
});
