// Phase 122: VR face manipulation v2 — rigid face grab (move/rotate/scale/push
// around the centroid) and live extrude/inset (default op then stick reshape,
// second trigger commits). Driven through the faceEdit core; the controller
// math + in-headset feel are the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// helper: enter face edit on a fresh box, highlight the +X face
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		window.__box = box;
		window.__stores.objectActions.selectObject(box.uuid);
		window.__stores.faceEdit.enterFaceEdit(box.uuid);
		// find the +X face index
		const faces = window.__stores.faceEdit.currentFaces();
		window.__xface = faces.findIndex((f) => f.normal.x > 0.9);
	});
	await A.page.waitForTimeout(300);

	// --- rigid grab: move the face's vertices by a local translation ---
	const grab = await A.page.evaluate(() => {
		const f = window.__stores.faceEdit;
		const THREE = window.__stores.THREE;
		const captured = [];
		let original;
		window.__stores.peers.subscribe((p) => (original = p))();
		window.__stores.peers.set({ ...(original ?? {}), peer: { id: 'me' }, send: (m) => captured.push(m) });

		f.beginFaceGrab(window.__xface);
		const before = window.__box.geometry.attributes.position.array.slice();
		// grab-move +0.6 in x, then commit
		f.applyFaceGrab({ dPos: new THREE.Vector3(0.6, 0, 0) });
		const maxXAfterMove = Math.max(
			...Array.from({ length: window.__box.geometry.attributes.position.count }, (_, i) =>
				window.__box.geometry.attributes.position.getX(i)
			)
		);
		const ok = f.commitFaceGrab();
		const meshgeos = captured.filter((m) => m.type === 'meshgeo').length;
		window.__stores.peers.set(original);
		return { beforeMaxX: Math.max(...before.filter((_, i) => i % 3 === 0)), maxXAfterMove, ok, meshgeos };
	});
	h.check(Math.abs(grab.beforeMaxX - 0.5) < 1e-6, 'box +X face starts at x=0.5');
	h.check(Math.abs(grab.maxXAfterMove - 1.1) < 1e-4, `grab moves the face +0.6 (maxX ${grab.maxXAfterMove.toFixed(2)})`);
	h.check(grab.ok && grab.meshgeos >= 1, 'grab commits one+ meshgeo snapshot');

	// --- undo restores the pre-grab geometry ---
	const undo = await A.page.evaluate(() => {
		window.__stores.history.undo();
		return Math.max(
			...Array.from({ length: window.__box.geometry.attributes.position.count }, (_, i) =>
				window.__box.geometry.attributes.position.getX(i)
			)
		);
	});
	h.check(Math.abs(undo - 0.5) < 1e-4, `grab is undoable (maxX back to ${undo.toFixed(2)})`);

	// --- scale around the centroid shrinks the GRABBED face's own verts ---
	const rotScale = await A.page.evaluate(() => {
		const f = window.__stores.faceEdit;
		const faces = f.currentFaces();
		const xi = faces.findIndex((fc) => fc.normal.x > 0.9);
		const tset = faces[xi].triIndices;
		const faceMaxY = () => {
			const tris = f.readTriangles(window.__box.geometry);
			let m = 0;
			tset.forEach((ti) => tris[ti].forEach((v) => (m = Math.max(m, Math.abs(v.y)))));
			return m;
		};
		f.beginFaceGrab(xi);
		f.applyFaceGrab({ scale: 0.5 }); // shrink the face around its centroid
		const maxY = faceMaxY();
		f.cancelFaceGrab();
		const maxYRestored = faceMaxY();
		return { maxY, maxYRestored };
	});
	h.check(Math.abs(rotScale.maxY - 0.25) < 1e-4, `scale 0.5 shrinks the face's own verts to 0.25 (${rotScale.maxY.toFixed(2)})`);
	h.check(Math.abs(rotScale.maxYRestored - 0.5) < 1e-4, 'cancel restores the pre-grab geometry');

	// --- live extrude adjust: default op, stick reshapes, second trigger commits ---
	const adjust = await A.page.evaluate(() => {
		const f = window.__stores.faceEdit;
		const tri = () => f.readTriangles(window.__box.geometry).length;
		const faces = f.currentFaces();
		const xi = faces.findIndex((fc) => fc.normal.x > 0.9);
		f.faceEditHighlight.set(xi);
		const before = tri();
		f.beginFaceAdjust(xi, 'extrude', 0.3);
		const afterBegin = tri();
		const maxX0 = Math.max(
			...Array.from({ length: window.__box.geometry.attributes.position.count }, (_, i) =>
				window.__box.geometry.attributes.position.getX(i)
			)
		);
		f.adjustFaceGesture(0.4, 0); // push the cap further out
		const maxX1 = Math.max(
			...Array.from({ length: window.__box.geometry.attributes.position.count }, (_, i) =>
				window.__box.geometry.attributes.position.getX(i)
			)
		);
		const committed = f.commitFaceAdjust();
		const afterCommit = tri();
		return { before, afterBegin, maxX0, maxX1, committed, afterCommit };
	});
	h.check(adjust.before === 12 && adjust.afterBegin === 20, `extrude adjust begins with the walls (${adjust.afterBegin} tris)`);
	h.check(adjust.maxX1 > adjust.maxX0 + 0.2, `stick depth pushes the cap further out (${adjust.maxX0.toFixed(2)}→${adjust.maxX1.toFixed(2)})`);
	h.check(adjust.committed && adjust.afterCommit === 20, 'the second trigger commits the extrude');

	// --- the committed adjust is undoable back to the base geometry ---
	const adjustUndo = await A.page.evaluate(() => {
		const f = window.__stores.faceEdit;
		window.__stores.history.undo();
		return f.readTriangles(window.__box.geometry).length;
	});
	h.check(adjustUndo === 12, `the committed extrude adjust is undoable (${adjustUndo})`);

	// --- cancel an adjust restores the pre-begin geometry (relative) ---
	const cancelAdjust = await A.page.evaluate(() => {
		const f = window.__stores.faceEdit;
		const tri = () => f.readTriangles(window.__box.geometry).length;
		const faces = f.currentFaces();
		const xi = faces.findIndex((fc) => fc.normal.x > 0.9);
		f.faceEditHighlight.set(xi);
		const base = tri();
		f.beginFaceAdjust(xi, 'extrude', 0.3);
		const during = tri();
		f.cancelFaceAdjust();
		return { base, during, after: tri() };
	});
	h.check(
		cancelAdjust.during === cancelAdjust.base + 8 && cancelAdjust.after === cancelAdjust.base,
		`cancel reverts the pending extrude (${cancelAdjust.base}→${cancelAdjust.during}→${cancelAdjust.after})`
	);

	// --- exiting mid-adjust reverts the uncommitted preview (relative) ---
	const exitRevert = await A.page.evaluate(() => {
		const f = window.__stores.faceEdit;
		const tri = () => f.readTriangles(window.__box.geometry).length;
		const faces = f.currentFaces();
		const xi = faces.findIndex((fc) => fc.normal.x > 0.9);
		f.faceEditHighlight.set(xi);
		const base = tri();
		f.beginFaceAdjust(xi, 'extrude', 0.3);
		f.exitFaceEdit();
		return { base, after: tri() };
	});
	h.check(exitRevert.after === exitRevert.base, `exiting mid-adjust drops the uncommitted preview (${exitRevert.base}→${exitRevert.after})`);

	await h.finish(browser);
});
