// Phase 213: VR mesh-edit undo. Mesh ops done in VR record ONE meshgeo undo
// entry, and the radial Undo (executeVRMenuAction 'undo'/'redo') reverts/reapplies
// them while a VR edit session is live — the applier rebuilds the face cache
// (golden rule #6) so editing continues cleanly. On-device feel is manual.
const h = require('./helpers.cjs');

const read = (A, path) =>
	A.page.evaluate((p) => {
		let v;
		const store = p.split('.').reduce((o, k) => o[k], window.__stores);
		store.subscribe((x) => (v = x))();
		return v;
	}, path);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- a VR-driven extrude, then radial undo/redo, cache stays valid ---
	const face = await A.page.evaluate(() => {
		const s = window.__stores;
		const rd = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		s.commandsHandler.sceneCommand('/create box');
		const group = rd(s.objectsGroup);
		const box = group.children[group.children.length - 1];
		window.__mbox = box;
		s.isVRMode.set(true);
		s.objectActions.selectObject(box.uuid);
		// index-aware tri count (a fresh box is indexed; edited geometry is not)
		const tris = () => s.faceEdit.readTriangles(box.geometry).length;
		const tris0 = tris();

		// the VR path: Edit Mesh -> arm Extrude -> highlight a face -> commit
		s.vrMenuOpen.set(true);
		s.vrControls.executeVRMenuAction('obj:editmesh');
		s.vrControls.executeVRMenuAction('face:extrude');
		s.faceEdit.highlightFaceByTriangle(0);
		s.faceEdit.faceEditAmount.set(0.5);
		const committed = s.faceEdit.commitArmedFaceOp();
		const trisExtruded = tris();

		// radial Undo (the dispatcher the ring fires) — reverts + rebuilds the cache
		s.vrControls.executeVRMenuAction('undo');
		const trisUndone = tris();
		const facesAfterUndo = s.faceEdit.faceCount(); // must be valid, not stale

		// radial Redo re-applies
		s.vrControls.executeVRMenuAction('redo');
		const trisRedone = tris();
		const facesAfterRedo = s.faceEdit.faceCount();
		return { tris0, committed, trisExtruded, trisUndone, facesAfterUndo, trisRedone, facesAfterRedo };
	});
	h.check(face.committed && face.trisExtruded === face.tris0 + 8, `VR extrude grows the mesh (${face.tris0}→${face.trisExtruded} tris)`);
	h.check(face.trisUndone === face.tris0, `radial Undo restores the pre-extrude geometry (${face.trisUndone} tris)`);
	h.check(face.facesAfterUndo === 6, `the face cache rebuilds after undo (${face.facesAfterUndo} faces, no stale cache)`);
	h.check(face.trisRedone === face.tris0 + 8 && face.facesAfterRedo > 0, `radial Redo re-applies the extrude (${face.trisRedone} tris)`);

	// --- a VR stretch, then radial undo ---
	const stretch = await A.page.evaluate(() => {
		const s = window.__stores;
		const rd = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		// leave face edit, start fresh with a new box
		s.vrControls.executeVRMenuAction('obj:editmesh'); // toggle mesh-edit off
		s.commandsHandler.sceneCommand('/create box');
		const group = rd(s.objectsGroup);
		const box = group.children[group.children.length - 1];
		s.objectActions.selectObject(box.uuid);
		const span = () => {
			box.geometry.computeBoundingBox();
			return box.geometry.boundingBox.max.x - box.geometry.boundingBox.min.x;
		};
		const span0 = span();
		s.vrControls.beginStretch(box.uuid);
		s.vrControls.setStretch(0, 2); // 2x on X
		s.vrControls.commitStretch();
		const spanStretched = span();
		s.vrControls.executeVRMenuAction('undo');
		const spanUndone = span();
		return { span0, spanStretched, spanUndone };
	});
	h.check(
		Math.abs(stretch.spanStretched - stretch.span0 * 2) < 0.01,
		`VR stretch doubles the X extent (${stretch.span0.toFixed(2)}→${stretch.spanStretched.toFixed(2)})`
	);
	h.check(
		Math.abs(stretch.spanUndone - stretch.span0) < 0.01,
		`radial Undo reverts the stretch (${stretch.spanUndone.toFixed(2)})`
	);

	await h.finish(browser);
});
