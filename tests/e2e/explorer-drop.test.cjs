// Phase 96: Explorer -> scene — prefab and object cards place at the pointed
// spot (replicated), an image card textures the mesh it lands on (replicated),
// and the window-level drop handler routes Explorer payloads.
const h = require('./helpers.cjs');

const TINY_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_OBJ = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';

const objectsOn = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((group) =>
					resolve(
						group.children.map((child) => ({
							name: child.name,
							pos: child.position.toArray().map((v) => Math.round(v * 100) / 100)
						}))
					)
				)();
			})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A, 8000);

	// seed the Explorer: an OBJ + an image, and a prefab from a box
	await A.page.evaluate(
		async ({ png, obj }) => {
			const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
			await window.__stores.explorer.importFiles(
				[
					new File([bytes], 'checker.png', { type: 'image/png' }),
					new File([new Blob([obj])], 'tri.obj', { type: 'text/plain' })
				],
				null
			);
			window.__stores.commandsHandler.sceneCommand('/create box');
			const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
			const box = group.children[group.children.length - 1];
			box.name = 'proto-box';
			await window.__stores.prefabs.savePrefab(box.uuid, 'MyPrefab');
		},
		{ png: TINY_PNG, obj: TINY_OBJ }
	);
	await A.page.waitForTimeout(1200);

	// prefab card dropped on empty ground places it at the ray point
	await A.page.evaluate(async () => {
		let list = [];
		window.__stores.prefabs.prefabs.subscribe((v) => (list = v))();
		await window.__stores.explorerDrop.dropExplorerItem(
			{ kind: 'prefab', name: 'MyPrefab', prefabId: list[0].id },
			420,
			560
		);
	});
	await A.page.waitForTimeout(1500);
	let aObjects = await objectsOn(A.page);
	const placedPrefab = aObjects.find((o, i) => o.name === 'MyPrefab');
	h.check(!!placedPrefab, 'prefab card instantiates on drop');
	h.check(
		Math.abs(placedPrefab.pos[1]) < 0.01 && (placedPrefab.pos[0] !== 0 || placedPrefab.pos[2] !== 0),
		`prefab placed at the ground ray point (${placedPrefab.pos})`
	);
	let bObjects = await objectsOn(B.page);
	const bPrefab = bObjects.find((o) => o.name === 'MyPrefab');
	h.check(
		bPrefab && bPrefab.pos.join(',') === placedPrefab.pos.join(','),
		`prefab replicated in place on B (${bPrefab?.pos})`
	);

	// object (OBJ) card imports AT the drop point on both peers
	await A.page.evaluate(async () => {
		let items = [];
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		const tri = items.find((i) => i.name === 'tri.obj');
		await window.__stores.explorerDrop.dropExplorerItem({ id: tri.id, kind: 'object', name: tri.name }, 860, 560);
	});
	await A.page.waitForTimeout(2000);
	aObjects = await objectsOn(A.page);
	const placedObj = aObjects.find((o) => o.name === 'tri');
	h.check(!!placedObj && (placedObj.pos[0] !== 0 || placedObj.pos[2] !== 0), `OBJ import lands at the drop point (${placedObj?.pos})`);
	bObjects = await objectsOn(B.page);
	const bObj = bObjects.find((o) => o.name === 'tri');
	h.check(
		bObj && bObj.pos.join(',') === placedObj.pos.join(','),
		`imported object replicated in place on B (${bObj?.pos})`
	);

	// image card textures the selected mesh through the Inspector drop helper
	const textured = await A.page.evaluate(async () => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const box = group.children.find((c) => c.name === 'proto-box');
		let items = [];
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		const img = items.find((i) => i.name === 'checker.png');
		const ok = await window.__stores.explorerDrop.applyExplorerImage(box.uuid, { id: img.id });
		return { ok, uuid: box.uuid, map: !!box.material.userData.mapDataUrl };
	});
	h.check(textured.ok && textured.map, 'Explorer image textures the mesh (local)');
	await B.page.waitForTimeout(1200);
	const bMap = await B.page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((group) => {
					const mesh = group.getObjectByProperty('uuid', uuid);
					resolve(!!mesh?.material?.userData?.mapDataUrl);
				})();
			}),
		textured.uuid
	);
	h.check(bMap, 'texture replicated to B');

	// window-level DOM drop routes Explorer payloads (App.handleDrop)
	await A.page.evaluate(() => {
		let items = [];
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		const tri = items.find((i) => i.name === 'tri.obj');
		const dt = new DataTransfer();
		dt.setData('application/x-explorer-item', JSON.stringify({ id: tri.id, kind: 'object', name: tri.name }));
		document
			.querySelector('canvas')
			.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, clientX: 300, clientY: 300 }));
	});
	await A.page.waitForTimeout(2000);
	aObjects = await objectsOn(A.page);
	h.check(
		aObjects.filter((o) => o.name === 'tri').length === 2,
		'DOM drop on the viewport routes through the Explorer handler'
	);

	await h.finish(browser);
});
