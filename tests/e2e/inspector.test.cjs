// Phase 64: unified inspector — one drawer for mesh/light/scene targets and
// the drag-to-scrub transform rows (no recentring snap-back, live replication).
const h = require('./helpers.cjs');

const selectedX = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.selectedObject.subscribe((s) => r(s?.position.x))()
			)
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// record outgoing peer messages (send works with zero connections)
	await A.page.evaluate(async () => {
		window.__sent = [];
		const inst = await new Promise((r) => window.__stores.peers.subscribe(r)());
		const orig = inst.send.bind(inst);
		inst.send = (m) => {
			window.__sent.push(m);
			return orig(m);
		};
	});

	// ---- mesh target ----
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await A.page.evaluate(async () => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = g.children.find((c) => c.name === 'Box');
		window.__stores.objectActions.selectObject(box.uuid, true);
	});
	await A.page.waitForTimeout(600);
	h.check(
		await A.page.locator('#drawer-label').getByText('Mesh', { exact: true }).isVisible(),
		'mesh badge shown'
	);
	for (const label of ['Transform', 'Position', 'Rotation', 'Scale', 'Material']) {
		h.check(
			await A.page.getByText(label, { exact: true }).first().isVisible(),
			`section "${label}" visible`
		);
	}

	// ---- drag-to-scrub: +100px at 0.02/px ≈ +2, replicated live, no snap-back ----
	const scrubber = A.page.locator('#inspector-position .dn-wrap').first();
	const box = await scrubber.boundingBox();
	await A.page.mouse.move(box.x + 8, box.y + box.height / 2);
	await A.page.mouse.down();
	await A.page.mouse.move(box.x + 108, box.y + box.height / 2, { steps: 10 });
	await A.page.mouse.up();
	const afterDrag = await selectedX(A.page);
	h.check(Math.abs(afterDrag - 2) < 0.2, `drag scrubbed position.x to ~2 (got ${afterDrag})`);
	const moves = await A.page.evaluate(() => window.__sent.filter((m) => m.type === 'move').length);
	h.check(moves >= 5, `move replicated live during the drag (${moves} messages)`);
	await A.page.waitForTimeout(400);
	const settled = await selectedX(A.page);
	h.check(settled === afterDrag, 'no snap-back after the drag ends');

	// ---- click without moving = type the exact value ----
	await scrubber.click();
	const typeInput = A.page.locator('#inspector-position .dn-input').first();
	h.check(await typeInput.isVisible(), 'the scrubber is a typable field (16-Q3: always an input)');
	await typeInput.fill('5');
	await A.page.keyboard.press('Enter');
	h.check((await selectedX(A.page)) === 5, 'typed value commits');

	// ---- rename replicates ----
	await A.page.locator('#name').fill('MyBox');
	await A.page.keyboard.press('Enter');
	await A.page.waitForTimeout(200);
	const renamed = await A.page.evaluate(() =>
		window.__sent.some((m) => m.type === 'name' && m.name === 'MyBox')
	);
	h.check(renamed, 'rename sends the name message');

	// ---- light target: same drawer, light sections ----
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/light directional'));
	await A.page.evaluate(async () => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const light = g.children.find((c) => c.type === 'DirectionalLight');
		window.__stores.objectActions.selectObject(light.uuid, true);
	});
	await A.page.waitForTimeout(600);
	h.check(
		await A.page.locator('#drawer-label').getByText('DirectionalLight', { exact: true }).isVisible(),
		'light badge shown'
	);
	h.check(
		await A.page.locator('#inspector-intensity .dn-wrap').isVisible(),
		'intensity scrubber shown for lights'
	);
	h.check(
		await A.page.getByText('Cast Shadow', { exact: true }).isVisible(),
		'directional light parameters shown'
	);

	// ---- scene target through the same drawer ----
	await A.page.evaluate(() => window.__stores.showSidebar('scene'));
	await A.page.waitForTimeout(500);
	h.check(
		await A.page.locator('#drawer-label .ui-badge-type', { hasText: 'Scene' }).isVisible(),
		'scene badge shown'
	);
	h.check(
		await A.page.locator('#environment-presets').isVisible(),
		'environment presets in the scene inspector'
	);

	await h.finish(browser);
});
