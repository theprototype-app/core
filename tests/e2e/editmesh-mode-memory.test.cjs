// Phase 175: switching Vertices<->Faces clears the other mode's highlight (no
// stale face highlight in vertices mode) and remembers the last selection per
// mode (the same face/vertex is restored on returning).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		const uuid = box.uuid;
		s.objectActions.selectObject(uuid);

		const fe = s.faceEdit;
		const me = s.meshEdit;
		const hl = () => {
			let v;
			fe.faceEditHighlight.subscribe((x) => (v = x))();
			return v;
		};
		const faceObj = () => {
			let v;
			fe.faceEditObject.subscribe((x) => (v = x))();
			return v;
		};
		const vertObj = () => {
			let v;
			me.editingObject.subscribe((x) => (v = x))();
			return v;
		};

		// FACES: pick a face
		fe.enterFaceEdit(uuid);
		const faces = fe.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		fe.highlightFaceByTriangle(faces[xi].triIndices[0]);
		const pickedFi = hl();

		// switch to VERTICES (mirrors the toolbar's setMode)
		fe.exitFaceEdit();
		me.enterEditMode(uuid);
		const modeIsVertices = vertObj() === uuid && !faceObj();
		const faceClearedInVerts = hl() === -1;

		// select a vertex
		me.selectHandle(2);
		const vSel = me.selectedVertexHandle();

		// switch back to FACES: vertex clears, face restored
		me.exitEditMode();
		fe.enterFaceEdit(uuid);
		const modeIsFaces = faceObj() === uuid && !vertObj();
		const faceRestored = hl() === pickedFi;
		const vertClearedInFaces = me.selectedVertexHandle() === -1;

		// switch back to VERTICES: vertex restored
		fe.exitFaceEdit();
		me.enterEditMode(uuid);
		const vertRestored = me.selectedVertexHandle() === 2;
		me.exitEditMode();

		return { pickedFi, modeIsVertices, faceClearedInVerts, vSel, modeIsFaces, faceRestored, vertClearedInFaces, vertRestored };
	});

	h.check(res.pickedFi >= 0, 'a face is highlighted in faces mode');
	h.check(res.modeIsVertices, 'the toolbar mode tracks the switch to vertices (editingObject set, faceEditObject clear)');
	h.check(res.faceClearedInVerts, 'face highlight clears when switching to vertices (no stale highlight)');
	h.check(res.vSel === 2, 'a vertex handle is selected in vertices mode');
	h.check(res.modeIsFaces, 'the toolbar mode tracks the switch back to faces');
	h.check(res.faceRestored, 'returning to faces restores the previously selected face');
	h.check(res.vertClearedInFaces, 'the vertex selection is not shown in faces mode');
	h.check(res.vertRestored, 'returning to vertices restores the previously selected vertex');

	await h.finish(browser);
});
