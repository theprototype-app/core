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

	// ---- 21-H2: the Explorer path -----------------------------------------------------
	// `prefabObject(id)` is the seam the Properties preview and the GLTF export share, so
	// it is asserted here beside the store it reads: a LIVE tree, never in the scene, and
	// with fresh uuids (the export TRAVERSES it, and a uuid colliding with a live object
	// is a trap waiting for the first thing that looks one up).
	const parsed = await A.page.evaluate(async () => {
		const lib = window.__stores.prefabs;
		const prefab = await new Promise((r) => lib.prefabs.subscribe((l) => r(l[0]))());
		const object = lib.prefabObject(prefab.id);
		const uuids = [];
		object?.traverse((n) => uuids.push(n.uuid));
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g))());
		return {
			ok: !!object,
			name: object?.name,
			isMesh: !!object?.isMesh,
			// nothing was added to the scene, and no uuid collides with what IS in it
			inScene: uuids.some((u) => !!group.getObjectByProperty('uuid', u)),
			children: group.children.length,
			// a second call is a second INDEPENDENT tree (the export must not hand back
			// the object the preview is rendering)
			distinct: lib.prefabObject(prefab.id)?.uuid !== object?.uuid,
			missing: lib.prefabObject('nope') === null
		};
	});
	const sceneBefore = (await childNames(A.page)).length;
	h.check(parsed.ok && parsed.isMesh, 'prefabObject parses the stored JSON into a live tree');
	h.check(parsed.name === 'TestFab', 'the parsed tree carries the prefab name');
	h.check(parsed.inScene === false, 'prefabObject NEVER adds to the scene, and mints fresh uuids');
	h.check(parsed.distinct, 'each call returns its own tree');
	h.check(parsed.missing, 'an unknown id parses to null rather than throwing');
	h.check(sceneBefore === parsed.children, 'the scene is untouched by a parse');

	// prefabFacts describes THAT tree (a box: 12 triangles), for the Properties pane
	const boxFacts = await A.page.evaluate(async () => {
		const lib = window.__stores.prefabs;
		const prefab = await new Promise((r) => lib.prefabs.subscribe((l) => r(l[0]))());
		return lib.prefabFacts(prefab.id);
	});
	h.check(boxFacts?.objects === 1 && boxFacts.meshes === 1, `facts count the objects (${boxFacts?.objects})`);
	h.check(boxFacts?.tris === 12, `facts count the triangles (${boxFacts?.tris})`);
	h.check(!!boxFacts?.createdAt && boxFacts.updatedAt === null, 'facts carry the saved date, and no update yet');

	// updatePrefab writes IN PLACE — same id, same name, new bytes, no second entry
	const updated = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create sphere');
		const uuid = await new Promise((r) =>
			s.objectsGroup.subscribe((g) => r(g.children[g.children.length - 1].uuid))()
		);
		const before = await new Promise((r) => s.prefabs.prefabs.subscribe((l) => r(l))());
		const target = before[0];
		await s.prefabs.updatePrefab(target.id, [uuid]);
		const after = await new Promise((r) => s.prefabs.prefabs.subscribe((l) => r(l))());
		return {
			count: after.length,
			sameCount: after.length === before.length,
			id: after[0].id === target.id,
			name: after[0].name === target.name,
			facts: s.prefabs.prefabFacts(target.id)
		};
	});
	h.check(updated.sameCount && updated.count === 2, `update replaces, never appends (${updated.count})`);
	h.check(updated.id && updated.name, 'update keeps the prefab id and name');
	h.check(updated.facts.tris > 12, `update re-saves the geometry (${updated.facts.tris} tris)`);
	h.check(!!updated.facts.updatedAt, 'update stamps updatedAt');

	// an update REPLICATES like any other instantiation afterwards: B gets the new shape
	await A.page.evaluate(async () => {
		const lib = window.__stores.prefabs;
		const prefab = await new Promise((r) => lib.prefabs.subscribe((l) => r(l[0]))());
		lib.instantiatePrefab(prefab);
	});
	await h.eventually(
		() =>
			B.page.evaluate(
				() =>
					new Promise((r) =>
						window.__stores.objectsGroup.subscribe((g) =>
							r(g?.children.filter((c) => c.name === 'TestFab').length ?? 0)
						)()
					)
			),
		(n) => n === 3,
		'an instance of the UPDATED prefab still replicates'
	);

	await h.finish(browser);
});
