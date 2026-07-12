// Phase 192: VR inset felt like the second trigger CANCELLED it. Root cause:
// the live adjust clamped the amount to [-5,5] for every op, so controller
// motion could drive the INSET amount to ~0/negative and collapse the ring.
// Fix: inset stays in [0.02,0.9]; extrude keeps its signed range. The second
// trigger then confirms a visible inset.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		s.commandsHandler.sceneCommand('/create box');
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		s.objectActions.selectObject(box.uuid);
		fe.enterFaceEdit(box.uuid);
		const tris = () => fe.readTriangles(box.geometry).length;
		const pickX = () => {
			const faces = fe.currentFaces();
			const xi = faces.findIndex((f) => f.normal.x > 0.9);
			fe.highlightFaceByTriangle(faces[xi].triIndices[0]);
			return xi;
		};

		// INSET: a hard pull must NOT collapse it below 0.02
		const xi = pickX();
		fe.beginFaceAdjust(xi, 'inset', 0.2);
		const insetStart = tris();
		fe.adjustFaceGesture(-1.0, 0); // pull hard past zero
		const insetAmt = fe.faceAdjustAmount();
		const insetAfterAdjust = tris();
		const insetCommit = fe.commitFaceAdjust();
		const insetTris = tris();
		s.history.undo();

		// EXTRUDE: a negative amount is still allowed (push into the mesh)
		const xi2 = pickX();
		fe.beginFaceAdjust(xi2, 'extrude', 0.3);
		fe.adjustFaceGesture(-1.0, 0);
		const extrudeAmt = fe.faceAdjustAmount();
		fe.cancelFaceAdjust();

		fe.exitFaceEdit();
		return { insetStart, insetAmt, insetAfterAdjust, insetCommit, insetTris, extrudeAmt };
	});

	h.check(res.insetStart === 20, `inset begins with the ring (12->${res.insetStart})`);
	h.check(res.insetAmt === 0.02, `inset amount clamps to 0.02 under a hard pull (${res.insetAmt}) - never collapses`);
	h.check(res.insetAfterAdjust === 20, 'the inset ring survives the adjust (not collapsed)');
	h.check(res.insetCommit === true && res.insetTris === 20, 'the second trigger CONFIRMS the inset (20 tris, not cancelled)');
	h.check(res.extrudeAmt < 0, `extrude still allows a negative amount (${res.extrudeAmt}) - into the mesh`);

	await h.finish(browser);
});
