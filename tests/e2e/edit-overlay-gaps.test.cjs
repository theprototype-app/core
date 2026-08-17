// The four serialize/parse paths PR #133 did not close.
//
// The mesh-edit wireframe is a CHILD of the edited mesh, so it rides inside
// objectsGroup — the replicated, serialized tree. #133 parked it for the
// autosave/session/history/duplicate paths; these four were missed:
//   prefab save, prefab clone, prefab instantiate, VR sleeve capture,
//   the viewer Share broadcast, and the GLTF/JSON import.
//
// The shape of every check is mesh-edit-display's: the overlay is LIVE before
// (premise), ABSENT from what gets written, and STILL LIVE afterwards — because
// a park that forgets to restore is its own bug.
const h = require('./helpers.cjs');

const OVERLAY = 'edit-overlay';

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const uuid = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 900));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		return g.children[g.children.length - 1].uuid;
	});
	h.check(!!uuid, 'a box exists (premise)');

	// open a session so the wireframe is really there
	const live = await A.page.evaluate(async (id) => {
		const w = window.__stores;
		w.faceEdit.enterFaceEdit(id);
		await new Promise((r) => setTimeout(r, 500));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', id);
		return object.children.filter((c) => c.name?.startsWith('edit-overlay')).length;
	}, uuid);
	h.check(live === 1, `the edit wireframe is on the object (premise: ${live})`);

	const countOverlays = (element) => {
		// walk an ObjectLoader JSON tree counting overlay-named children
		let found = 0;
		const walk = (node) => {
			if (typeof node?.name === 'string' && node.name.startsWith('edit-overlay')) found++;
			(node?.children ?? []).forEach(walk);
		};
		walk(element?.object ?? element);
		return found;
	};

	// ---- 1. savePrefab -----------------------------------------------------
	const prefab = await A.page.evaluate(async (id) => {
		const w = window.__stores;
		const entry = await w.prefabs.savePrefab(id, 'gap-probe');
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', id);
		return {
			element: entry?.element ?? null,
			liveAfter: object.children.filter((c) => c.name?.startsWith('edit-overlay')).length
		};
	}, uuid);
	h.check(!!prefab.element, 'the prefab saved (premise)');
	h.check(
		countOverlays(prefab.element) === 0,
		`a prefab saved DURING a session carries no wireframe (${countOverlays(prefab.element)})`
	);
	h.check(prefab.liveAfter === 1, '...and the live one is put straight back');

	// ---- 2. savePrefabSelection (the clone path) ---------------------------
	const multi = await A.page.evaluate(async (id) => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 700));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const other = g.children[g.children.length - 1].uuid;
		const entry = await w.prefabs.savePrefabSelection([id, other], 'gap-probe-multi');
		return entry?.element ?? null;
	}, uuid);
	h.check(!!multi, 'the multi-selection prefab saved (premise)');
	h.check(
		countOverlays(multi) === 0,
		`clone(true) does not carry the wireframe into a group prefab (${countOverlays(multi)})`
	);

	// ---- 3. instantiatePrefab heals an OLD prefab --------------------------
	const healed = await A.page.evaluate(async () => {
		const w = window.__stores;
		// craft what an older build would have stored: a box with an overlay child
		const box = new w.THREE.Mesh(new w.THREE.BoxGeometry(1, 1, 1), new w.THREE.MeshStandardMaterial());
		// a PLAIN BufferGeometry, not WireframeGeometry: ObjectLoader cannot rebuild
		// the latter, so a fixture using it fails to parse for a reason that has
		// nothing to do with what is being tested
		const wireGeometry = new w.THREE.BufferGeometry();
		wireGeometry.setAttribute(
			'position',
			new w.THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 1]), 3)
		);
		const wire = new w.THREE.LineSegments(wireGeometry, new w.THREE.LineBasicMaterial());
		wire.name = 'edit-overlay';
		box.add(wire);
		const element = box.toJSON();
		const object = w.prefabs.instantiatePrefab({ name: 'stale', element });
		return {
			carried: (element.object.children ?? []).filter((c) => c.name === 'edit-overlay').length,
			landed: object?.children?.filter((c) => c.name?.startsWith('edit-overlay')).length ?? -1
		};
	});
	h.check(healed.carried === 1, 'the crafted prefab really carries an overlay (premise)');
	h.check(healed.landed === 0, 'instantiating an OLD prefab drops the stale wireframe');

	// ---- 4. VR sleeve slot capture ----------------------------------------
	const sleeve = await A.page.evaluate(async (id) => {
		const w = window.__stores;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', id);
		const ok = w.vrSleeve.captureSlotFromObject(object);
		let slots = [];
		w.vrSleeve.sleeveSlots.subscribe((v) => (slots = v))();
		return {
			ok,
			element: slots[slots.length - 1]?.element ?? null,
			liveAfter: object.children.filter((c) => c.name?.startsWith('edit-overlay')).length
		};
	}, uuid);
	h.check(sleeve.ok && !!sleeve.element, 'a sleeve slot captured the object (premise)');
	h.check(
		countOverlays(sleeve.element) === 0,
		`a sleeve slot carries no wireframe (${countOverlays(sleeve.element)})`
	);
	h.check(sleeve.liveAfter === 1, '...and the live one survives the capture');

	// ---- 5. the Share broadcast -------------------------------------------
	const shared = await A.page.evaluate(async (id) => {
		const w = window.__stores;
		let original = null;
		w.peers.subscribe((p) => (original = p))();
		const sent = [];
		w.peers.set({ ...original, send: (m) => sent.push(m) });
		try {
			let g;
			w.objectsGroup.subscribe((v) => (g = v))();
			const object = g.getObjectByProperty('uuid', id);
			w.objectPermissions.shareObject(object);
			const message = sent.find((m) => m?.type === 'object');
			return {
				sentOne: !!message,
				element: message?.element ?? null,
				liveAfter: object.children.filter((c) => c.name?.startsWith('edit-overlay')).length
			};
		} finally {
			w.peers.set(original);
		}
	}, uuid);
	h.check(shared.sentOne, 'Share broadcast an object message (premise)');
	h.check(
		countOverlays(shared.element) === 0,
		`a shared object carries no wireframe to peers (${countOverlays(shared.element)})`
	);
	h.check(shared.liveAfter === 1, '...and the live one survives the share');

	// ---- 6. the strip helper on an imported tree ---------------------------
	// (the GLTF/JSON import calls exactly this on result.scene before adding and
	// broadcasting; building a real .gltf here would test three's loader, not us)
	const importPath = await A.page.evaluate(() => {
		const w = window.__stores;
		const root = new w.THREE.Group();
		const mesh = new w.THREE.Mesh(new w.THREE.BoxGeometry(), new w.THREE.MeshStandardMaterial());
		const wire = new w.THREE.LineSegments(
			new w.THREE.WireframeGeometry(new w.THREE.BoxGeometry()),
			new w.THREE.LineBasicMaterial()
		);
		wire.name = 'edit-overlay_1'; // the uniquifier shape, a second one on the mesh
		mesh.add(wire);
		root.add(mesh);
		const before = mesh.children.length;
		const removed = w.editOverlays.stripEditOverlays(root);
		return { before, removed, after: mesh.children.length };
	});
	h.check(importPath.before === 1, 'the crafted import tree has an overlay (premise)');
	h.check(
		importPath.removed === 1 && importPath.after === 0,
		`the import strip removes it, uniquifier suffix and all (${importPath.removed})`
	);

	// leaving the session must still leave a clean object
	const clean = await A.page.evaluate((id) => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', id);
		return object.children.filter((c) => c.name?.startsWith('edit-overlay')).length;
	}, uuid);
	h.check(clean === 0, 'leaving the session removes the wireframe as before');

	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A))})`);
	await h.finish(browser);
});
