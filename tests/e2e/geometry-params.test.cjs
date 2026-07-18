// Phase 78: geometry parameters — live rebuild replicates, undo restores,
// params survive the GLTF sync so a late joiner keeps editing.
const h = require('./helpers.cjs');

const geoOf = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					if (!o) return r(null);
					o.geometry.computeBoundingSphere();
					r({
						radius: o.geometry.boundingSphere.radius,
						verts: o.geometry.attributes.position.count,
						params: o.userData?.geometryParams ?? null
					});
				})()
			),
		uuid
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const uuid = await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create Sphere 1');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		return g.children.find((c) => c.name === 'Sphere')?.uuid;
	});
	await h.eventually(
		() => geoOf(B.page, uuid),
		(geo) => !!geo,
		'sphere synced to B'
	);

	// params were stamped at creation
	let a = await geoOf(A.page, uuid);
	h.check(a.params?.gtype === 'Sphere' && Math.abs(a.params.params.radius - 1) < 0.01, 'params stamped on create');

	// edit radius + segments -> rebuild replicates exactly
	await A.page.evaluate(
		(uuid) => window.__stores.geometryEdit.applyGeometry(uuid, { radius: 2, widthSegments: 12, heightSegments: 8 }),
		uuid
	);
	await h.eventually(
		() => Promise.all([geoOf(A.page, uuid), geoOf(B.page, uuid)]),
		([ga, gb]) =>
			Math.abs(ga.radius - 2) < 0.05 &&
			Math.abs(gb.radius - 2) < 0.05 &&
			ga.verts === gb.verts,
		'rebuild replicated (radius 2, same vertex count)'
	);

	// one undo restores the old geometry on both peers
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(
		() => Promise.all([geoOf(A.page, uuid), geoOf(B.page, uuid)]),
		([ga, gb]) => Math.abs(ga.radius - 1) < 0.05 && Math.abs(gb.radius - 1) < 0.05,
		'undo restored radius 1 on both peers'
	);
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(
		() => geoOf(B.page, uuid),
		(g) => Math.abs(g.radius - 2) < 0.05,
		'redo re-applied on B'
	);

	// late joiner receives userData params through the GLTF sync and can edit
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A, 14000);
	await h.eventually(
		() => geoOf(C.page, uuid),
		(g) => g && g.params?.gtype === 'Sphere' && Math.abs(g.params.params.radius - 2) < 0.05,
		'late joiner got the editable params',
		15000
	);
	await C.page.evaluate(
		(uuid) => window.__stores.geometryEdit.applyGeometry(uuid, { radius: 0.5 }),
		uuid
	);
	await h.eventually(
		() => Promise.all([geoOf(A.page, uuid), geoOf(C.page, uuid)]),
		([ga, gc]) => Math.abs(ga.radius - 0.5) < 0.05 && Math.abs(gc.radius - 0.5) < 0.05,
		'late joiner edit replicated back to A'
	);

	await h.finish(browser);
});
