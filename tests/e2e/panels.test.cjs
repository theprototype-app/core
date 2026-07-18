// Phase 49: panel redesign smoke — everything still opens, closes and works.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// sidebar: flat rows render (203 dropped the Files/Scene/App section headers;
	// Create moved to the Add menu in 77; 126 moved Library/Assets to the Explorer)
	await A.page.evaluate(() => window.__stores.closeMenu.set(false));
	await A.page.waitForTimeout(500);
	for (const label of ['Import', 'Configure Scene', 'Modules', 'Sessions', 'Settings']) {
		h.check(
			await A.page.getByText(label, { exact: true }).first().isVisible(),
			`sidebar row "${label}" visible`
		);
	}
	h.check(
		!(await A.page.getByText('Create', { exact: true }).first().isVisible().catch(() => false)),
		'Create section left the sidebar'
	);
	h.check(await A.page.getByRole('button', { name: /Import/ }).isVisible(), 'files row visible');

	// groups now come from the Add menu / command path
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/group New'));
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
