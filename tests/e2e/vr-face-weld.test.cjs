// Phase 138: moving a face carries its WELDED (shared-position) vertices so the
// object stretches instead of tearing a hole. Pure geometry checks on the
// faceEdit core; on-device feel manual.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- moveFaceAlongNormal welds: no vertex left at the old +X corner ---
	const welded = await A.page.evaluate(() => {
		const f = window.__stores.faceEdit;
		const THREE = window.__stores.THREE;
		const K = (x, y, z) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
		const tris = f.readTriangles(new THREE.BoxGeometry(1, 1, 1));
		const faces = f.groupFaces(tris);
		const xFace = faces.find((fc) => fc.normal.x > 0.9);
		// how many verts sit at the +X/+Y/+Z corner before + which faces touch it
		const corner = K(0.5, 0.5, 0.5);
		const before = tris.flat().filter((v) => K(v.x, v.y, v.z) === corner).length;
		const moved = f.moveFaceAlongNormal(tris, xFace, 0.5); // +X face out to x=1
		const stillAtOldCorner = moved.flat().filter((v) => K(v.x, v.y, v.z) === corner).length;
		const atNewCorner = moved.flat().filter((v) => K(v.x, v.y, v.z) === K(1, 0.5, 0.5)).length;
		return { before, stillAtOldCorner, atNewCorner };
	});
	h.check(welded.before >= 3, `the +X/+Y/+Z corner is shared by several faces (${welded.before} verts)`);
	h.check(welded.stillAtOldCorner === 0, 'a welded move leaves NO vertex behind at the old corner (no tear)');
	h.check(welded.atNewCorner >= 3, `every shared copy moved to the new corner (${welded.atNewCorner})`);

	// --- grip-grab translation welds neighbours; rotate/scale stay face-local ---
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		window.__box = box;
		window.__stores.objectActions.selectObject(box.uuid);
		window.__stores.faceEdit.enterFaceEdit(box.uuid);
	});
	await A.page.waitForTimeout(300);
	const grab = await A.page.evaluate(() => {
		const f = window.__stores.faceEdit;
		const THREE = window.__stores.THREE;
		const K = (x, y, z) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
		const faces = f.currentFaces();
		const xi = faces.findIndex((fc) => fc.normal.x > 0.9);
		f.beginFaceGrab(xi);
		f.applyFaceGrab({ dPos: new THREE.Vector3(0.4, 0, 0) }); // pure translate +0.4x
		const p = window.__box.geometry.attributes.position;
		const oldCorner = K(0.5, 0.5, 0.5);
		let leftBehind = 0;
		for (let i = 0; i < p.count; i++) if (K(p.getX(i), p.getY(i), p.getZ(i)) === oldCorner) leftBehind++;
		f.cancelFaceGrab();
		return { leftBehind };
	});
	h.check(welded.before >= 3, 'sanity');
	h.check(grab.leftBehind === 0, 'grab-translate carries welded neighbours (no vertex left at the old corner)');

	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await h.finish(browser);
});
