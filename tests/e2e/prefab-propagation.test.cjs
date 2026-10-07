// 37 R4 — PREFAB UPDATE PROPAGATION, on two peers.
//
// A saves a prefab (a box carrying a flow graph) and places two copies. One copy gets its
// own colour (an override); the other is edited (scale + a second graph node) and applied
// back to the prefab. The toast's "Update 1 instance" brings the other copy along: it keeps
// its colour, takes the scale and the graph, keeps its uuid, and B sees all of it. One
// Ctrl+Z puts it back on both peers; Reset overrides and Unlink round it off. Peer B never
// holds the prefab — the copies are scene content, the library is A's.
const h = require('./helpers.cjs');

/** a value read off one object on a page @param {any} peer @param {string} uuid */
const probe = (peer, uuid) =>
	peer.page.evaluate((uuid) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const o = g?.getObjectByProperty('uuid', uuid);
		if (!o) return null;
		const graph = s.graphOf(uuid);
		return {
			color: o.material?.color?.getHexString?.() ?? null,
			scale: +o.scale.x.toFixed(3),
			pos: o.position.toArray().map((v) => +v.toFixed(3)),
			link: o.userData?.prefab ?? null,
			nodes: graph?.nodes?.length ?? 0
		};
	}, uuid);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---- 0. a prefab that carries a flow graph -------------------------------------------
	const setup = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		s.updateGraph(box.uuid, () => ({ nodes: [{ id: 'n1', type: 'counter', position: { x: 0, y: 0 }, data: {} }], edges: [] }));
		await s.prefabs.loadPrefabs();
		const entry = await s.prefabs.savePrefab(box.uuid, 'Crate');
		const one = s.prefabs.instantiatePrefab(entry, { x: 3, y: 0.5, z: 0 });
		const two = s.prefabs.instantiatePrefab(entry, { x: -3, y: 0.5, z: 0 });
		return { id: entry.id, graphs: Object.keys(entry.graphs ?? {}).length, one: one.uuid, two: two.uuid };
	});
	h.check(setup.graphs === 1, `the prefab carries its object's flow graph (${setup.graphs})`);
	await A.page.waitForTimeout(1200);
	let a1 = await probe(A, setup.one);
	let a2 = await probe(A, setup.two);
	h.check(a1?.link?.id === setup.id && a1.link.rev === 0, 'a placed copy is linked to its prefab at revision 0');
	h.check(a1?.nodes === 1 && a2?.nodes === 1, `each copy got the prefab's graph (${a1?.nodes}, ${a2?.nodes})`);
	await h.eventually(() => probe(B, setup.two), (v) => !!v, 'B received the second copy', 15000);

	// ---- 1. an override on copy 2, an edit on copy 1 applied back to the prefab ------------
	await A.page.evaluate(({ one, two }) => {
		const s = window.__stores;
		s.materialsHandler.setObjectColor(two, '#123456');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', one);
		o.scale.set(2, 2, 2);
		let peer;
		s.peers.subscribe((v) => (peer = v))();
		peer?.send({ type: 'move', uuid: one, pos: o.position.toArray(), rot: o.rotation.toArray().slice(0, 3), scale: [2, 2, 2] });
		const graph = s.graphOf(one);
		s.updateGraph(one, () => ({ nodes: [...graph.nodes, { id: 'n2', type: 'counter', position: { x: 200, y: 0 }, data: {} }], edges: [] }));
		s.clearToast();
	}, setup);
	await h.eventually(() => probe(B, setup.two), (v) => v?.color === '123456', "B sees copy 2's own colour", 8000);
	const overrides = await A.page.evaluate((two) => window.__stores.prefabLinks.instanceOverrides(two), setup.two);
	h.check(Array.isArray(overrides) && overrides.length === 1 && /material/.test(overrides[0]), `copy 2 reports its one override (${JSON.stringify(overrides)})`);

	const before = await A.page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
	await A.page.evaluate((one) => window.__stores.prefabLinks.applyInstanceToPrefab(one), setup.one);
	const offer = A.page.getByText('Update 1 instance', { exact: true });
	await offer.waitFor({ timeout: 8000 });
	h.check(true, 'applying an edit offers "Update 1 instance"');
	a1 = await probe(A, setup.one);
	h.check(a1?.link?.rev === 1, `the copy the edit came from moved to revision 1 silently (${a1?.link?.rev})`);
	await offer.click();
	await A.page.waitForTimeout(800);

	a2 = await probe(A, setup.two);
	h.check(a2?.color === '123456', `copy 2 kept its own colour (${a2?.color})`);
	h.check(a2?.scale === 2, `copy 2 took the prefab's new scale (${a2?.scale})`);
	h.check(a2?.pos?.[0] === -3, `copy 2 stayed where it was placed (${a2?.pos})`);
	h.check(a2?.link?.rev === 1, `copy 2 is at revision 1 (${a2?.link?.rev})`);
	h.check(a2?.nodes === 2, `copy 2's graph took the prefab's second node (${a2?.nodes})`);
	const after = await A.page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
	h.check(after >= before + 1, `the update is on the undo stack (${before} -> ${after})`);
	await h.eventually(() => probe(B, setup.two), (v) => v?.scale === 2 && v.color === '123456' && v.link?.rev === 1, 'B sees copy 2 updated, override kept', 10000);
	await h.eventually(() => probe(B, setup.two), (v) => v?.nodes === 2, "B sees copy 2's graph updated", 10000);

	// ---- 2. one undo puts it back, on both peers -----------------------------------------
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(600);
	a2 = await probe(A, setup.two);
	h.check(a2?.scale === 1 && a2.link?.rev === 0 && a2.nodes === 1, `one undo restores copy 2 (scale ${a2?.scale}, rev ${a2?.link?.rev}, nodes ${a2?.nodes})`);
	await h.eventually(() => probe(B, setup.two), (v) => v?.scale === 1 && v.link?.rev === 0, 'B sees the undo', 10000);
	await h.eventually(() => probe(B, setup.two), (v) => v?.nodes === 1, "B sees the graph's undo", 10000);
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => probe(A, setup.two), (v) => v?.scale === 2, 'redo applies it again', 5000);

	// ---- 3. reset overrides, then unlink ---------------------------------------------------
	await A.page.evaluate((two) => window.__stores.prefabLinks.resetInstance(two), setup.two);
	await A.page.waitForTimeout(600);
	a2 = await probe(A, setup.two);
	h.check(a2?.color !== '123456' && a2?.pos?.[0] === -3, `reset overrides drops the colour, keeps the placement (${a2?.color} at ${a2?.pos})`);
	await h.eventually(() => probe(B, setup.two), (v) => v && v.color !== '123456', 'B sees the reset', 10000);

	const menu = await A.page.evaluate((two) => window.__stores.objectMenu.buildObjectMenuItems(two).map((i) => i.label).filter(Boolean), setup.two);
	h.check(menu.includes('Prefab: Crate'), `the object menu has the Prefab submenu (${menu.filter((l) => /Prefab/.test(l))})`);

	await A.page.evaluate((two) => window.__stores.prefabLinks.unlinkInstance(two), setup.two);
	await A.page.waitForTimeout(400);
	a2 = await probe(A, setup.two);
	const count = await A.page.evaluate((id) => window.__stores.prefabLinks.prefabInstances(id).length, setup.id);
	h.check(!a2?.link && count === 1, `unlink cuts the copy loose (${JSON.stringify(a2?.link)}, ${count} left)`);
	await h.eventually(() => probe(B, setup.two), (v) => v && !v.link, 'B sees the unlink', 10000);

	await h.finish(browser);
});
