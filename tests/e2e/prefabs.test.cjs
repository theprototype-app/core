// Phase 44: prefabs — save with thumbnail, persist across reload, instantiate replicates,
// export/import round-trip.
const h = require('./helpers.cjs');

const prefabList = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.prefabs.prefabs.subscribe((list) =>
					r(list.map((p) => ({ id: p.id, name: p.name, hasThumb: !!p.thumbnail })))
				)()
			)
	);

const childNames = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => r(g?.children.map((c) => c.name) ?? []))()
			)
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// save a box as a prefab
	const uuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		return new Promise((resolve) =>
			window.__stores.objectsGroup.subscribe((g) => resolve(g.children[g.children.length - 1].uuid))()
		);
	});
	await A.page.evaluate(async (uuid) => {
		await window.__stores.prefabs.loadPrefabs();
		await window.__stores.prefabs.savePrefab(uuid, 'TestFab');
	}, uuid);
	let list = await prefabList(A.page);
	h.check(list.length === 1 && list[0].name === 'TestFab', 'prefab saved');
	h.check(list[0].hasThumb, 'thumbnail rendered');

	// survives a reload (IndexedDB)
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForTimeout(4000);
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.prefabs, { timeout: 30000 });
	await A.page.evaluate(() => window.__stores.prefabs.loadPrefabs());
	list = await prefabList(A.page);
	h.check(list.length === 1, 'prefab persisted across reload');

	// reconnect after reload, then instantiate twice -> appears on B too
	await h.connect(A, B, 9000);
	await A.page.evaluate(async () => {
		const lib = window.__stores.prefabs;
		const prefab = await new Promise((r) => lib.prefabs.subscribe((l) => r(l[0]))());
		lib.instantiatePrefab(prefab);
		lib.instantiatePrefab(prefab);
	});
	await h.eventually(
		() => childNames(A.page),
		(names) => names.filter((n) => n === 'TestFab').length === 2,
		'two instances in the scene on A'
	);
	await h.eventually(
		() => childNames(B.page),
		(names) => names.filter((n) => n === 'TestFab').length === 2,
		'instances replicated to B'
	);

	// export/import round-trip creates a second library entry
	const roundTrip = await A.page.evaluate(async () => {
		const lib = window.__stores.prefabs;
		const prefab = await new Promise((r) => lib.prefabs.subscribe((l) => r(l[0]))());
		const json = lib.exportPrefab(prefab);
		await lib.importPrefab(json);
		return new Promise((r) => lib.prefabs.subscribe((l) => r(l.length))());
	});
	h.check(roundTrip === 2, 'export/import round-trips');

	await h.finish(browser);
});
