// Phase 73: advanced mode — System filter reveals module/env scene-root objects,
// read-only rows with focus; disclaimer dismisses persistently.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// off by default: no System chip
	await A.page.locator('p[title="Object list (O)"]').click();
	await A.page.waitForTimeout(400);
	h.check(
		!(await A.page.getByRole('button', { name: 'System', exact: true }).isVisible().catch(() => false)),
		'no System chip without advanced mode'
	);

	// enable advanced mode -> chip appears
	await A.page.evaluate(() => window.__stores.advancedMode.set(true));
	await A.page.waitForTimeout(300);
	h.check(
		await A.page.getByRole('button', { name: 'System', exact: true }).isVisible(),
		'System chip appears in advanced mode'
	);

	// spawn pong, open the System view
	await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.moduleSDK.moduleMenuItems.subscribe((items) => {
					items.find((i) => i.label === 'Pong: spawn / remove')?.action();
					resolve();
				})();
			})
	);
	await A.page.getByRole('button', { name: 'System', exact: true }).click();
	await A.page.waitForTimeout(400);
	h.check(await A.page.getByText('pong-module', { exact: true }).isVisible(), 'module content listed');
	// phase 70 folded the rig lights under one environment-root group
	h.check(await A.page.getByText('environment-root', { exact: true }).isVisible(), 'environment root listed');
	h.check(
		await A.page.getByText(/managed by modules and the environment/).isVisible(),
		'disclaimer shown'
	);

	// dismiss persists
	await A.page.getByText(/managed by modules/).locator('..').getByRole('button').click();
	await A.page.waitForTimeout(200);
	await A.page.getByRole('button', { name: 'All', exact: true }).click();
	await A.page.getByRole('button', { name: 'System', exact: true }).click();
	await A.page.waitForTimeout(300);
	h.check(
		!(await A.page.getByText(/managed by modules and the environment/).isVisible().catch(() => false)),
		'disclaimer stays dismissed'
	);

	// focus flies the camera toward the pong table
	const before = await A.page.evaluate(
		() => new Promise((r) => window.__stores.globalCamera.subscribe((c) => r(c.position.toArray()))())
	);
	await A.page
		.getByText('pong-module', { exact: true })
		.locator('..')
		.getByTitle('Focus the camera on it')
		.click();
	await A.page.waitForTimeout(800);
	const after = await A.page.evaluate(
		() => new Promise((r) => window.__stores.globalCamera.subscribe((c) => r(c.position.toArray()))())
	);
	h.check(
		Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]) > 0.5,
		'focus moves the camera'
	);

	// normal filters still work
	await A.page.getByRole('button', { name: 'All', exact: true }).click();
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await A.page.waitForTimeout(300);
	h.check(
		await A.page.locator('#object-list').getByText('Box', { exact: true }).isVisible(),
		'regular list unaffected'
	);

	await h.finish(browser);
});
