// Phase 196: reproduce desktop (noVR) face INSET. Arm inset, highlight a face,
// commit at the default amount, and assert it produces valid, grown geometry
// (the inset adds a frame ring) with rebuilt face groups — the same contract the
// extrude path already satisfies. Diagnostic first: if this passes, desktop inset
// works headlessly and any remaining "broken" is visual/interaction.
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
		const fe = s.faceEdit;
		s.objectActions.selectObject(box.uuid);
		fe.enterFaceEdit(box.uuid);

		const beforeTris = fe.readTriangles(box.geometry).length;
		const facesBefore = fe.faceCount();

		fe.setFaceOp('inset');
		let op, amount;
		fe.faceEditOp.subscribe((v) => (op = v))();
		fe.faceEditAmount.subscribe((v) => (amount = v))();
		fe.highlightFaceByTriangle(0);
		const committed = fe.commitFaceOp('inset', amount);

		const pos = box.geometry.getAttribute('position').array;
		let hasNaN = false;
		for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) { hasNaN = true; break; }
		const afterTris = fe.readTriangles(box.geometry).length;
		const facesAfter = fe.faceCount();

		return { op, amount, committed, beforeTris, afterTris, facesBefore, facesAfter, hasNaN };
	});

	h.check(res.op === 'inset', `arming inset sets the op (op=${res.op})`);
	h.check(res.amount > 0 && res.amount <= 0.9, `inset default amount is in range (${res.amount})`);
	h.check(res.committed, 'commitFaceOp("inset") returns true');
	h.check(res.afterTris > res.beforeTris, `inset grows the mesh with a frame ring (${res.beforeTris}->${res.afterTris})`);
	h.check(!res.hasNaN, 'inset geometry has no NaN/degenerate positions');
	h.check(res.facesAfter >= res.facesBefore, `face groups rebuilt after inset (${res.facesBefore}->${res.facesAfter})`);

	await h.finish(browser);
});
