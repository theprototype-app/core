// Phase 173: in mesh-edit, F frames the selected vertex/face (not the whole
// object); the two redundant "Editing..." entry tooltips are gone.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// getters + tooltip absence
	const res = await A.page.evaluate(() => {
		const s = window.__stores;
		const seen = [];
		const unsub = s.toastStore.subscribe((list) => (list || []).forEach((t) => seen.push(JSON.stringify(t))));

		s.commandsHandler.sceneCommand('/create box');
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		s.objectActions.selectObject(box.uuid);

		// FACE: focus target = selected face world centroid
		s.faceEdit.enterFaceEdit(box.uuid);
		const faces = s.faceEdit.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		s.faceEdit.highlightFaceByTriangle(faces[xi].triIndices[0]);
		box.updateMatrixWorld(true);
		const exp = box.localToWorld(faces[xi].centroid.clone());
		const ft = s.faceEdit.focusTargetFace();
		const faceCenterOk = !!ft && ft.center.distanceTo(exp) < 1e-6 && ft.radius > 0;
		s.faceEdit.exitFaceEdit();
		const faceNullAfterExit = s.faceEdit.focusTargetFace() === null;

		// VERTEX: focus target = selected handle world position (a corner, not the center)
		s.meshEdit.enterEditMode(box.uuid);
		s.meshEdit.selectHandle(0);
		const vt = s.meshEdit.focusTargetVertex();
		const vtOk = !!vt && vt.radius > 0 && vt.center.length() > 0.1;
		s.meshEdit.exitEditMode();
		const vertNullAfterExit = s.meshEdit.focusTargetVertex() === null;

		unsub();
		const noTooltips = !seen.some((m) => /drag the vertex handles|point at a face, trigger/.test(m));
		return { faceCenterOk, faceNullAfterExit, vtOk, vertNullAfterExit, noTooltips };
	});

	h.check(res.faceCenterOk, 'focusTargetFace returns the selected face world centroid + radius');
	h.check(res.faceNullAfterExit, 'focusTargetFace is null after leaving face mode');
	h.check(res.vtOk, 'focusTargetVertex returns the selected vertex world position + radius');
	h.check(res.vertNullAfterExit, 'focusTargetVertex is null after leaving vertex mode');
	h.check(res.noTooltips, 'entering edit modes no longer shows the redundant tooltips');

	// integration: F (focusObject) reframes on the selected face
	const focusRes = await A.page.evaluate(async () => {
		const s = window.__stores;
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		s.objectActions.selectObject(box.uuid);
		s.faceEdit.enterFaceEdit(box.uuid);
		const faces = s.faceEdit.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		s.faceEdit.highlightFaceByTriangle(faces[xi].triIndices[0]);
		box.updateMatrixWorld(true);
		const exp = box.localToWorld(faces[xi].centroid.clone());
		let controls;
		s.orbitControls.subscribe((c) => (controls = c))();
		s.objectActions.focusObject();
		await new Promise((r) => setTimeout(r, 900));
		return { distToFace: controls.target.distanceTo(exp), distToObjCenter: controls.target.length() };
	});
	h.check(focusRes.distToFace < 0.25, `F frames the selected face (target->face ${focusRes.distToFace.toFixed(3)})`);
	h.check(focusRes.distToFace < focusRes.distToObjCenter, 'F targets the face, not the object center');

	await h.finish(browser);
});
