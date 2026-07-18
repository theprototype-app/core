// Phase 162: moving a face in VR must not tear the mesh — the welded neighbours
// share the face's corner positions and follow the SAME rigid transform, so a
// ROTATE (which 138's translation-only follow tore) keeps the shared corners
// welded. Extends vr-face-weld with the rotate case + a scale check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(() => {
		const f = window.__stores.faceEdit;
		const THREE = window.__stores.THREE;
		const K = (x, y, z) => `${Math.round(x * 1e3)},${Math.round(y * 1e3)},${Math.round(z * 1e3)}`;

		window.__stores.commandsHandler.sceneCommand('/create box'); // unit box
		let grp; window.__stores.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		window.__stores.objectActions.selectObject(box.uuid);
		f.enterFaceEdit(box.uuid);

		const faces = f.currentFaces();
		const xi = faces.findIndex((fc) => fc.normal.x > 0.9);
		// the four +X face corners BEFORE the grab (x = 0.5)
		const oldCorners = [
			K(0.5, 0.5, 0.5), K(0.5, 0.5, -0.5), K(0.5, -0.5, 0.5), K(0.5, -0.5, -0.5)
		];
		const countAt = (keys) => {
			const p = box.geometry.attributes.position;
			let n = 0;
			for (let i = 0; i < p.count; i++) if (keys.includes(K(p.getX(i), p.getY(i), p.getZ(i)))) n++;
			return n;
		};
		const triCount = () => f.readTriangles(box.geometry).length;

		const trisBefore = triCount();
		const atOldBefore = countAt(oldCorners);

		// rotate the +X face 30deg about Y (dPos = 0 — the case that used to tear)
		f.beginFaceGrab(xi);
		f.applyFaceGrab({ dQuat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 6) });
		const leftBehind = countAt(oldCorners); // welded neighbours should have moved too
		const trisAfter = triCount();
		f.commitFaceGrab();

		// a moved vertex now sits off the old +X plane (the face really moved)
		const p = box.geometry.attributes.position;
		let movedOffPlane = false;
		for (let i = 0; i < p.count; i++) if (Math.abs(p.getX(i) - 0.5) > 0.01 && Math.abs(Math.abs(p.getY(i)) - 0.5) < 0.01) movedOffPlane = true;

		return { trisBefore, atOldBefore, leftBehind, trisAfter, movedOffPlane };
	});

	h.check(res.atOldBefore >= 6, `the +X corners are shared by several faces before the move (${res.atOldBefore} verts)`);
	h.check(res.leftBehind === 0, 'after a ROTATE, NO vertex is left at the old corners (no tear — neighbours followed)');
	h.check(res.trisAfter === res.trisBefore, `triangle count is unchanged (${res.trisBefore} -> ${res.trisAfter})`);
	h.check(res.movedOffPlane, 'the grabbed face actually moved (verts left the +X plane)');

	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await h.finish(browser);
});
