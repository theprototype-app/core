// 15-G: "Convert to mesh" — a Group or a 2+ multi-selection merges into ONE mesh
// (every distinct source material kept as a slot), the originals are deleted, and
// the whole thing is ONE undo entry + ONE replicated object.
//
// Also covers the multi-select MENU AUDIT: single-target entries (Rename, Add
// note, Add flow to Scene graph, Ungroup) must not be offered while a SET is
// selected, and Properties must not COLLAPSE the set to the clicked object.
const h = require('./helpers.cjs');

/** compact description of every top-level object (uuid, type, material slots) */
const sceneInfo = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r(
						g.children.map((o) => ({
							uuid: o.uuid,
							name: o.name,
							type: o.type,
							isMesh: !!o.isMesh,
							children: o.children.length,
							groups: o.geometry ? o.geometry.groups.length : -1,
							// triangle CORNERS, so an indexed source and the non-indexed
							// merge are directly comparable
							vertices: o.geometry
								? o.geometry.index
									? o.geometry.index.count
									: o.geometry.attributes.position.count
								: -1,
							materials: Array.isArray(o.material)
								? o.material.map((m) => '#' + m.color.getHexString())
								: o.material
									? ['#' + o.material.color.getHexString()]
									: [],
							emissive: Array.isArray(o.material)
								? o.material.map((m) => m.emissive.getHex())
								: o.material
									? [o.material.emissive.getHex()]
									: []
						}))
					)
				)()
			)
	);

const selectionSet = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.selectedObjects.subscribe((v) => r([...v]))())
	);

/** labels of the object context menu built for `uuid` */
const menuLabels = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			window.__stores.objectMenu
				.buildObjectMenuItems(uuid)
				.map((item) => item.label)
				.filter(Boolean),
		uuid
	);

/** two boxes 2m apart with distinct colors; returns their uuids */
const makeTwoBoxes = (page) =>
	page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const [a, b] = g.children.slice(-2);
		a.position.set(-1, 0, 0);
		a.material.color.set('#ff0000');
		b.position.set(1, 0, 0);
		b.material.color.set('#0000ff');
		return [a.uuid, b.uuid];
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---------------------------------------------------------------- 1. merge
	const boxes = await makeTwoBoxes(A.page);
	let before = await sceneInfo(A.page);
	const baseCount = before.length - 2;
	h.check(before.length >= 2, 'two boxes exist to merge (premise)');
	const sourceVerts = before
		.filter((o) => boxes.includes(o.uuid))
		.reduce((sum, o) => sum + o.vertices, 0);

	await A.page.evaluate((ids) => window.__stores.objectActions.applySelectionSet(ids), boxes);
	h.check((await selectionSet(A.page)).length === 2, 'both boxes are in the selection set (premise)');
	// the "tint is not baked in" check below can only fail if the tint is REALLY on
	// the sources at merge time
	h.check(
		(await sceneInfo(A.page))
			.filter((o) => boxes.includes(o.uuid))
			.every((o) => o.emissive[0] === 0x2a4d8f),
		'the multi-select highlight is on both sources (premise)'
	);

	const mergedUuid = await A.page.evaluate(
		(ids) => window.__stores.objectActions.convertToMesh(ids),
		boxes
	);
	h.check(!!mergedUuid, 'convertToMesh returns the new mesh uuid');

	let after = await sceneInfo(A.page);
	const merged = after.find((o) => o.uuid === mergedUuid);
	h.check(after.length === baseCount + 1, 'the two sources became exactly one object');
	h.check(
		!after.some((o) => boxes.includes(o.uuid)),
		'both originals are gone from the scene'
	);
	h.check(!!merged && merged.isMesh, 'the result is a Mesh');
	h.check(!!merged && merged.groups === 2, 'geometry has 2 groups (one per source material)');
	h.check(!!merged && merged.materials.length === 2, 'the mesh carries a 2-slot material array');
	h.check(
		!!merged && merged.materials.includes('#ff0000') && merged.materials.includes('#0000ff'),
		'both source colors are preserved'
	);
	// the multi-select emissive HIGHLIGHT must not be baked into the copies (the
	// 15-B2 duplicate bug, same mechanism)
	h.check(
		!!merged && merged.emissive.every((hex) => hex !== 0x2a4d8f),
		'the selection tint is not baked into the merged materials'
	);
	h.check(!!merged && merged.vertices === sourceVerts, 'no geometry was lost (vertex counts add up)');

	// world geometry survived: the merge spans both original positions (-1 and +1)
	const bounds = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const mesh = g.getObjectByProperty('uuid', uuid);
		const box = new w.THREE.Box3().setFromObject(mesh);
		return { min: box.min.toArray(), max: box.max.toArray(), pos: mesh.position.toArray() };
	}, mergedUuid);
	h.check(
		Math.abs(bounds.min[0] + 1.5) < 0.01 && Math.abs(bounds.max[0] - 1.5) < 0.01,
		'the merged geometry spans both source positions in world space'
	);
	h.check(
		Math.abs(bounds.pos[0] + 1) < 0.01,
		'the new object sits at the first source position (coordinates stay local)'
	);
	h.check((await selectionSet(A.page))[0] === mergedUuid, 'the merged mesh becomes the selection');

	// ------------------------------------------------------------ 2. undo/redo
	await A.page.evaluate(() => window.__stores.history.undo());
	after = await sceneInfo(A.page);
	h.check(
		boxes.every((uuid) => after.some((o) => o.uuid === uuid)),
		'ONE undo restores both originals'
	);
	h.check(!after.some((o) => o.uuid === mergedUuid), '...and removes the merged mesh');

	await A.page.evaluate(() => window.__stores.history.redo());
	after = await sceneInfo(A.page);
	h.check(
		after.some((o) => o.uuid === mergedUuid) && !after.some((o) => boxes.includes(o.uuid)),
		'redo re-converts in one step'
	);
	// the redone mesh must still be a real merge, not an empty shell
	const redone = after.find((o) => o.uuid === mergedUuid);
	h.check(
		!!redone && redone.groups === 2 && redone.vertices === sourceVerts,
		'the redone mesh keeps its groups and geometry'
	);

	// ------------------------------------------------------------ 3. group path
	const groupUuid = await A.page.evaluate(async () => {
		const w = window.__stores;
		for (let i = 0; i < 3; i++) w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const kids = g.children.slice(-3);
		kids.forEach((o, i) => o.position.set(i * 2, 0, 4));
		w.objectActions.applySelectionSet(kids.map((o) => o.uuid));
		const uuid = w.objectActions.groupSelection();
		const grp = g.getObjectByProperty('uuid', uuid);
		grp.name = 'Fence';
		return uuid;
	});
	const groupMerged = await A.page.evaluate(
		(uuid) => window.__stores.objectActions.convertToMesh([uuid]),
		groupUuid
	);
	after = await sceneInfo(A.page);
	const fromGroup = after.find((o) => o.uuid === groupMerged);
	h.check(!!fromGroup && fromGroup.isMesh, 'a Group converts to a single mesh');
	h.check(!!fromGroup && fromGroup.groups === 3, '...with one geometry group per child mesh');
	h.check(!!fromGroup && fromGroup.materials.length === 3, '...and a 3-slot material array');
	h.check(!!fromGroup && fromGroup.name === 'Fence (mesh)', '...named after the group');
	h.check(!after.some((o) => o.uuid === groupUuid), '...and the group itself is gone');

	// -------------------------------------------- 3b. re-merging a MULTI-material
	// mergeGeometries writes ONE group per input geometry and ignores the groups
	// already on it, so a source that already carries a material ARRAY has to be
	// split along its own groups first — otherwise every slot but the first is lost.
	const reMerged = await A.page.evaluate(async (mergedUuid) => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const extra = g.children[g.children.length - 1];
		extra.position.set(0, 0, 9);
		extra.material.color.set('#00ff00');
		w.objectActions.applySelectionSet([mergedUuid, extra.uuid]);
		return await w.objectActions.convertToMesh([mergedUuid, extra.uuid]);
	}, mergedUuid);
	after = await sceneInfo(A.page);
	const three = after.find((o) => o.uuid === reMerged);
	h.check(!!three && three.groups === 3, 'a 2-slot mesh + a box re-merge into 3 geometry groups');
	h.check(
		!!three &&
			['#ff0000', '#0000ff', '#00ff00'].every((hex) => three.materials.includes(hex)),
		'...keeping all three materials (the source array was split along its groups)'
	);
	h.check(
		!!three && three.vertices === sourceVerts + sourceVerts / 2,
		'...and every triangle of both sources'
	);

	// ---------------------------------------------------------------- 4. guards
	const guards = await A.page.evaluate(async () => {
		const w = window.__stores;
		const out = {};
		const count = async () =>
			(await new Promise((r) => w.objectsGroup.subscribe(r)())).children.length;

		// a lone mesh has nothing to merge with
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const lone = g.children[g.children.length - 1].uuid;
		let n = await count();
		out.lone = await w.objectActions.convertToMesh([lone]);
		out.loneUnchanged = (await count()) === n;

		// a light contributes no mesh -> only one mesh left -> refuse
		w.commandsHandler.sceneCommand('/light point');
		g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const light = g.children[g.children.length - 1].uuid;
		n = await count();
		out.withLight = await w.objectActions.convertToMesh([lone, light]);
		out.withLightUnchanged = (await count()) === n;

		// a peer-locked object refuses outright
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const other = g.children[g.children.length - 1].uuid;
		w.lockedObjects.update((locks) => [...locks, ['ghost-peer', other]]);
		n = await count();
		out.locked = await w.objectActions.convertToMesh([lone, other]);
		out.lockedUnchanged = (await count()) === n;
		w.lockedObjects.update((locks) => locks.filter((l) => l[0] !== 'ghost-peer'));

		// with the lock released the SAME pair merges — proves the refusal above was
		// the lock and not some other guard
		out.afterUnlock = await w.objectActions.convertToMesh([lone, other]);
		out.afterUnlockCount = await count();
		out.expectedAfterUnlock = n - 1;
		return out;
	});
	h.check(guards.lone === null, 'a single mesh refuses (needs 2+)');
	h.check(guards.loneUnchanged, '...and changes nothing');
	h.check(guards.withLight === null, 'a selection whose only mesh is one object refuses');
	h.check(guards.withLightUnchanged, '...and changes nothing');
	h.check(guards.locked === null, 'a peer-locked object refuses');
	h.check(guards.lockedUnchanged, '...and changes nothing');
	h.check(
		!!guards.afterUnlock && guards.afterUnlockCount === guards.expectedAfterUnlock,
		'the same pair merges once the lock is released (the refusal was the lock)'
	);

	// ------------------------------------------------------- 5. menu audit
	const pair = await makeTwoBoxes(A.page);
	await A.page.evaluate((ids) => window.__stores.objectActions.applySelectionSet(ids), pair);
	const multiMenu = await menuLabels(A.page, pair[0]);
	h.check(multiMenu.includes('Convert to mesh (2)'), 'a multi-selection offers "Convert to mesh (2)"');
	h.check(!multiMenu.includes('Rename'), 'multi-select hides Rename (single-target)');
	h.check(!multiMenu.includes('Add note'), 'multi-select hides Add note (single-point)');
	h.check(
		!multiMenu.includes('Add flow to Scene graph'),
		'multi-select hides Add flow to Scene graph (single-target)'
	);

	// Properties during a multi-select must keep the SET, not collapse it
	await A.page.evaluate((uuid) => {
		const items = window.__stores.objectMenu.buildObjectMenuItems(uuid);
		items.find((item) => item.label === 'Properties').action();
	}, pair[0]);
	h.check(
		(await selectionSet(A.page)).length === 2,
		'Properties keeps the multi-selection instead of collapsing it to one object'
	);

	// a lone mesh is not mergeable, a lone GROUP is
	await A.page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid), pair[0]);
	const singleMenu = await menuLabels(A.page, pair[0]);
	h.check(
		!singleMenu.some((label) => label.startsWith('Convert to mesh')),
		'a lone mesh does not offer Convert to mesh'
	);
	h.check(singleMenu.includes('Rename'), 'a lone object still offers Rename (audit did not over-hide)');
	h.check(singleMenu.includes('Add note'), '...and Add note');

	const soloGroup = await A.page.evaluate(async () => {
		const w = window.__stores;
		for (let i = 0; i < 2; i++) w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const kids = g.children.slice(-2);
		kids.forEach((o, i) => o.position.set(i * 2, 0, -6));
		w.objectActions.applySelectionSet(kids.map((o) => o.uuid));
		const uuid = w.objectActions.groupSelection();
		w.objectActions.selectObject(uuid);
		return uuid;
	});
	const groupMenu = await menuLabels(A.page, soloGroup);
	h.check(groupMenu.includes('Convert to mesh'), 'a lone Group offers Convert to mesh');
	h.check(groupMenu.includes('Ungroup'), '...beside Ungroup');

	// ------------------------------------------- 6. one replicated object message
	const sent = await A.page.evaluate(async (ids) => {
		const w = window.__stores;
		const peer = await new Promise((r) => w.peers.subscribe(r)());
		const captured = [];
		// shadow the prototype method so everything else on the instance survives
		peer.send = (msg) => captured.push({ type: msg.type, uuid: msg.uuid, element: !!msg.element });
		w.objectActions.applySelectionSet(ids);
		const uuid = await w.objectActions.convertToMesh(ids);
		delete peer.send;
		return { uuid, captured };
	}, pair);
	const objectMsgs = sent.captured.filter((m) => m.type === 'object');
	const deleteMsgs = sent.captured.filter((m) => m.type === 'delete');
	h.check(objectMsgs.length === 1 && objectMsgs[0].element, 'exactly ONE object message carries the merge');
	h.check(
		deleteMsgs.length === 2 && pair.every((uuid) => deleteMsgs.some((m) => m.uuid === uuid)),
		'both originals are deleted for peers'
	);
	h.check(
		!sent.captured.some((m) => m.type === 'group'),
		'the merge does not travel as a group (sendObjects would have made it one)'
	);

	// -------------------------------------------------- 7. ungroup = ONE undo
	const ungroup = await A.page.evaluate(async () => {
		const w = window.__stores;
		for (let i = 0; i < 3; i++) w.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const kids = g.children.slice(-3).map((o) => o.uuid);
		w.objectActions.applySelectionSet(kids);
		const uuid = w.objectActions.groupSelection();
		w.objectActions.ungroupObject(uuid);
		g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const goneAfterUngroup = !g.getObjectByProperty('uuid', uuid);
		w.history.undo();
		g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const restored = g.getObjectByProperty('uuid', uuid);
		return { goneAfterUngroup, restored: !!restored, children: restored ? restored.children.length : -1 };
	});
	h.check(ungroup.goneAfterUngroup, 'ungroup removes the empty group (premise)');
	h.check(ungroup.restored, 'ONE undo brings the group back');
	h.check(ungroup.children === 3, '...with all three children back inside it');

	// ------------------------------------------------------------ 8. two peers
	// start B against an EMPTY scene: a joiner with 0 objects never triggers the
	// share-or-stash gate, so the handshake replies straight away
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const netBoxes = await makeTwoBoxes(A.page);
	await A.page.waitForTimeout(2500);
	await h.eventually(
		() => sceneInfo(B.page),
		(info) => netBoxes.every((uuid) => info.some((o) => o.uuid === uuid)),
		'B received both source boxes (premise)',
		20000
	);

	const netMerged = await A.page.evaluate(async (ids) => {
		const w = window.__stores;
		w.objectActions.applySelectionSet(ids);
		return await w.objectActions.convertToMesh(ids);
	}, netBoxes);

	await h.eventually(
		() => sceneInfo(B.page),
		(info) => info.some((o) => o.uuid === netMerged),
		'B receives the merged mesh',
		20000
	);
	await h.eventually(
		() => sceneInfo(B.page),
		(info) => !info.some((o) => netBoxes.includes(o.uuid)),
		'B loses both originals',
		20000
	);
	const remote = (await sceneInfo(B.page)).find((o) => o.uuid === netMerged);
	h.check(!!remote && remote.isMesh, 'B sees it as a Mesh, not a group');
	h.check(!!remote && remote.groups === 2, 'B sees both geometry groups');
	h.check(
		!!remote && remote.materials.includes('#ff0000') && remote.materials.includes('#0000ff'),
		'B sees both source colors'
	);
	h.check(!!remote && remote.vertices === sourceVerts, 'B sees the full merged geometry');

	await h.finish(browser);
});
