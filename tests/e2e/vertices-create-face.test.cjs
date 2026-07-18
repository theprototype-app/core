// Phase 177: the Vertices toolbar can multi-select vertices (ctrl/shift-click ->
// toggleVertexSelection) and build a triangle/quad face from 3-4 of them,
// replicated as a meshgeo snapshot and undoable. Fewer than 3 is refused.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(() => {
		const s = window.__stores;
		const me = s.meshEdit;
		const fe = s.faceEdit;
		s.commandsHandler.sceneCommand('/create box');
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		const uuid = box.uuid;
		s.objectActions.selectObject(uuid);
		me.enterEditMode(uuid);

		const size = () => {
			let v;
			me.vertexSelectionSize.subscribe((x) => (v = x))();
			return v;
		};
		const tris = () => fe.readTriangles(box.geometry).length;

		const before = tris();

		// too few: 2 vertices is refused
		me.toggleVertexSelection(0);
		me.toggleVertexSelection(1);
		const twoSize = size();
		const twoOk = me.createSelectedFace();
		me.clearVertexSelection();
		const clearedSize = size();

		// 3 vertices -> one triangle
		me.toggleVertexSelection(0);
		me.toggleVertexSelection(1);
		me.toggleVertexSelection(2);
		const selCount = size();
		const created = me.createSelectedFace();
		const afterTris = tris();
		const sizeAfter = size();

		// undoable
		s.history.undo();
		const afterUndo = tris();

		me.exitEditMode();
		return { before, twoSize, twoOk, clearedSize, selCount, created, afterTris, sizeAfter, afterUndo };
	});

	h.check(res.before === 12, `a box starts at 12 triangles (${res.before})`);
	h.check(res.twoSize === 2 && res.twoOk === false, 'Create face refuses fewer than 3 vertices');
	h.check(res.clearedSize === 0, 'clearing the multi-selection resets the count');
	h.check(res.selCount === 3, 'ctrl-selecting 3 vertices sets the multi-selection size to 3');
	h.check(res.created, 'Create face succeeds with 3 vertices');
	h.check(res.afterTris === 13, `create-face appends one triangle (${res.before}->${res.afterTris})`);
	h.check(res.sizeAfter === 0, 'the multi-selection clears after creating the face');
	h.check(res.afterUndo === 12, 'create-face is undoable (back to 12)');

	await h.finish(browser);
});
