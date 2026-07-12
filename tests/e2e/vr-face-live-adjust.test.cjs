// Phases 184 + 185: a VR trigger on a face STARTS a live extrude/inset adjust
// (applies the default at once — no separate press-to-move), controller motion
// tunes depth/size, and the NEXT trigger CONFIRMS (it used to feel like inset
// cancelled). Controller motion needs a headset; here we verify the two-trigger
// start->confirm state machine + that the amount drives the preview.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const vc = s.vrControls;
		s.commandsHandler.sceneCommand('/create box');
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		s.objectActions.selectObject(box.uuid);
		fe.enterFaceEdit(box.uuid);
		const pickX = () => {
			const faces = fe.currentFaces();
			const xi = faces.findIndex((f) => f.normal.x > 0.9);
			fe.highlightFaceByTriangle(faces[xi].triIndices[0]);
		};
		const tris = () => fe.readTriangles(box.geometry).length;
		const maxX = () => {
			const p = box.geometry.attributes.position;
			let m = -1e9;
			for (let i = 0; i < p.count; i++) m = Math.max(m, p.getX(i));
			return m;
		};

		// --- EXTRUDE: first trigger starts + applies, no separate press-to-move ---
		pickX();
		const before = tris();
		fe.setFaceOp('extrude');
		vc.vrFaceTrigger();
		const exPending = fe.faceGesturePending();
		const exStartedTris = tris();
		const capBeforeAdjust = maxX();
		fe.adjustFaceGesture(0.6, 0); // stands in for controller motion along the normal
		const capAfterAdjust = maxX();
		vc.vrFaceTrigger(); // CONFIRM
		const exConfirmedPending = fe.faceGesturePending();
		const exConfirmedTris = tris();
		s.history.undo();
		const exUndoTris = tris();

		// --- INSET: same start->confirm, second trigger does not cancel ---
		pickX();
		fe.setFaceOp('inset');
		vc.vrFaceTrigger();
		const inPending = fe.faceGesturePending();
		const inStartedTris = tris();
		vc.vrFaceTrigger(); // CONFIRM
		const inConfirmedPending = fe.faceGesturePending();
		const inConfirmedTris = tris();

		fe.exitFaceEdit();
		return {
			before,
			exPending,
			exStartedTris,
			capBeforeAdjust,
			capAfterAdjust,
			exConfirmedPending,
			exConfirmedTris,
			exUndoTris,
			inPending,
			inStartedTris,
			inConfirmedPending,
			inConfirmedTris
		};
	});

	h.check(res.before === 12, `box starts at 12 tris (${res.before})`);
	h.check(res.exPending === true && res.exStartedTris === 20, 'extrude: one trigger starts the live adjust + applies (12->20, no press-to-move)');
	h.check(res.capAfterAdjust > res.capBeforeAdjust + 0.4, `controller-motion adjust deepens the extrude (${res.capBeforeAdjust.toFixed(2)}->${res.capAfterAdjust.toFixed(2)})`);
	h.check(res.exConfirmedPending === false && res.exConfirmedTris === 20, 'extrude: the second trigger confirms (kept, not reverted)');
	h.check(res.exUndoTris === 12, 'extrude is undoable');
	h.check(res.inPending === true && res.inStartedTris === 20, 'inset: one trigger applies the default inset ring (12->20)');
	h.check(res.inConfirmedPending === false && res.inConfirmedTris === 20, 'inset: the second trigger confirms (does NOT cancel)');

	await h.finish(browser);
});
