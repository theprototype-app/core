// Phase 159: a VR trigger that misses the object must NOT tear down the mesh
// edit session. Vertex mode used to exit on any trigger; face mode already
// no-ops when nothing is highlighted. Exit stays explicit (Done / ring).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		window.__box = g.children[g.children.length - 1].uuid;
	});

	const read = (mod, store) =>
		A.page.evaluate(([m, s]) => {
			let v;
			window.__stores[m][s].subscribe((x) => (v = x))();
			return v && v.uuid !== undefined ? v.uuid : v;
		}, [mod, store]);

	// --- face mode: a trigger with nothing highlighted keeps the session ---
	const face = await A.page.evaluate(() => {
		const s = window.__stores;
		s.faceEdit.enterFaceEdit(window.__box); // nothing highlighted yet (-1)
		s.vrControls.vrFaceTrigger(); // a "miss" trigger
		let fe; s.faceEdit.faceEditObject.subscribe((v) => (fe = v))();
		return fe === window.__box;
	});
	h.check(face, 'a miss trigger in FACE mode keeps the session (no exit)');
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	h.check((await read('faceEdit', 'faceEditObject')) === null, 'explicit exit still ends face mode');

	// --- vertex mode: a trigger no longer exits the session (159 fix) ---
	const vert = await A.page.evaluate(() => {
		const s = window.__stores;
		s.meshEdit.enterEditMode(window.__box);
		s.vrControls.vrVertexTrigger(0); // used to call exitEditMode()
		let ve; s.meshEdit.editingObject.subscribe((v) => (ve = v))();
		return ve === window.__box;
	});
	h.check(vert, 'a trigger in VERTEX mode keeps the session (no exit)');
	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());
	h.check((await read('meshEdit', 'editingObject')) === null, 'explicit exit still ends vertex mode');

	await h.finish(browser);
});
