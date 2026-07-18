// Roadmap #8: Explorer Packs UX. Single-click the Packs root -> a grid of pack
// cards (P4); double-click -> the tree expands to per-pack rows. Opening a pack
// shows its items; a .zip import adds a local pack; right-click a pack row ->
// Delete (imported) / Hide (built-in) (P5). Drag-out still places into the scene.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(600);
	h.check(await A.page.locator('#explorer-list').isVisible(), 'Explorer opens');

	// P4: single-click the Packs root -> grid of pack cards (not the tree)
	await A.page.locator('#packs-folder').click();
	await A.page.waitForTimeout(400);
	const packCards = await A.page.locator('#explorer-list .explorer-card').count();
	h.check(packCards >= 1, `single-click Packs shows a grid of pack cards (${packCards})`);

	// P4: double-click the Packs root -> tree expands to per-pack rows
	await A.page.locator('#packs-folder').dblclick();
	await A.page.waitForTimeout(300);
	const packRows = await A.page.locator('#explorer-list [data-pack]').count();
	h.check(packRows >= 1, `double-click Packs expands the tree (${packRows} rows)`);

	// open a default pack from the tree -> its items render
	const firstPack = await A.page.locator('#explorer-list [data-pack]').first().getAttribute('data-pack');
	await A.page.locator(`#explorer-list [data-pack="${firstPack}"]`).click();
	await A.page.waitForTimeout(700);
	h.check((await A.page.locator('#explorer-list .explorer-card').count()) > 0, `opening a pack shows its items (${firstPack})`);

	// P5: right-click a built-in pack -> Hide (never a destructive delete). Dispatch the
	// contextmenu in page context (custom-chrome tree rows fail Playwright actionability).
	const rightClick = (pack) =>
		A.page.evaluate((p) => {
			document
				.querySelector(`#explorer-list [data-pack="${p}"]`)
				.dispatchEvent(new MouseEvent('contextmenu', { clientX: 60, clientY: 320, bubbles: true }));
		}, pack);
	await rightClick(firstPack);
	await A.page.waitForTimeout(150);
	h.check(await A.page.getByRole('menuitem', { name: /Hide pack/ }).count() === 1, 'built-in pack menu offers Hide (not Delete)');

	// import a .zip pack (box glb) via the store
	const glbArr = await A.page.evaluate(async () => {
		const s = window.__stores;
		const mesh = new s.THREE.Mesh(new s.THREE.BoxGeometry(1, 1, 1), new s.THREE.MeshStandardMaterial());
		const glb = await new Promise((res, rej) =>
			new s.GLTFExporterModule.GLTFExporter().parse(mesh, (r) => res(r), (e) => rej(e), { binary: true })
		);
		return Array.from(new Uint8Array(glb));
	});
	const { zipSync, strToU8 } = require('fflate');
	const zipBytes = zipSync(
		{
			'manifest.json': strToU8(JSON.stringify({ id: 'testpack', name: 'Test Pack', license: 'MIT', items: [{ id: 'box', name: 'Box', file: 'assets/box/model.glb' }] })),
			'assets/box/model.glb': new Uint8Array(glbArr)
		},
		{ level: 6 }
	);
	await A.page.evaluate(async (zipArr) => {
		await window.__stores.packs.importPackZip(new File([new Uint8Array(zipArr)], 'testpack.zip'));
	}, Array.from(zipBytes));
	await A.page.waitForTimeout(300);
	h.check((await A.page.locator('#explorer-list [data-pack="testpack"]').count()) === 1, 'the imported pack appears in the tree');

	// P5: right-click the imported pack -> Delete (opening a new menu replaces the old)
	await rightClick('testpack');
	await A.page.waitForTimeout(150);
	h.check(await A.page.getByRole('menuitem', { name: /Delete pack/ }).count() === 1, 'imported pack menu offers Delete');
	await A.page.mouse.click(5, 5); // dismiss the menu before the next interaction
	await A.page.waitForTimeout(150);

	// open it + place its item into the scene (drag path, via the stored item id)
	await A.page.locator('#explorer-list [data-pack="testpack"]').click();
	await A.page.waitForTimeout(400);
	h.check((await A.page.locator('#explorer-list .explorer-card').count()) === 1, 'the imported pack shows its one item');
	const placed = await A.page.evaluate(async () => {
		const s = window.__stores;
		let items;
		s.packs.openPackItems.subscribe((x) => (items = x))();
		const g0 = (() => { let g; s.objectsGroup.subscribe((x) => (g = x))(); return g.children.length; })();
		await s.explorerDrop.dropExplorerItem({ id: items[0].id, kind: 'object', name: items[0].name }, 400, 300);
		await new Promise((r) => setTimeout(r, 400));
		let g; s.objectsGroup.subscribe((x) => (g = x))();
		return { before: g0, after: g.children.length };
	});
	h.check(placed.after === placed.before + 1, `placing a pack item adds it to the scene (${placed.before}->${placed.after})`);

	await h.finish(browser);
});
