// 15-E (E6/E7/E10): inset keeps its new CAP selected (groupFaces re-merges a
// coplanar cap with its ring, so the highlight alone cannot describe it);
// Move — commit or gizmo — moves ONLY the cap plus its welded ring verts; the
// gizmo comes back seated on the cap after a commit.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		fe.enterFaceEdit(box.uuid);
		const read = (/** @type {any} */ store) => {
			let v;
			store.subscribe((/** @type {any} */ x) => (v = x))();
			return v;
		};
		// inset the +X face
		const faces = fe.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		fe.highlightFaceByTriangle(faces[xi].triIndices[0]);
		const capTris = faces[xi].triIndices.length;
		const insetOk = fe.commitFaceOp('inset', 0.3);
		const sel = read(fe.faceEditSelectedTris);
		// E7: the gizmo is seated after the commit
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		const gizmoBack = controls?.object?.userData?.isFaceProxy === true;
		const planeXs = () => {
			const p = box.geometry.attributes.position;
			const xs = [];
			for (let i = 0; i < p.count; i++) xs.push(p.getX(i));
			return xs;
		};
		const before = planeXs();
		const maxBefore = Math.max(...before);
		// MOVE the selected cap +0.4 along its normal
		const moveOk = fe.commitFaceOp('move', 0.4);
		const after = planeXs();
		const maxAfter = Math.max(...after);
		// the outer +X plane (ring boundary + side corners) must stay at 0.5
		const stayedOuter = after.filter((x) => Math.abs(x - 0.5) < 1e-3).length;
		const selAfterMove = read(fe.faceEditSelectedTris);
		// the gizmo grab path targets the SAME selection
		const began = fe.beginFaceGrab(fe.currentTargetFace());
		fe.applyFaceGrab({ dPos: new s.THREE.Vector3(0.2, 0, 0) });
		const dragMax = Math.max(...planeXs());
		fe.cancelFaceGrab();
		fe.exitFaceEdit();
		return {
			insetOk,
			capTris,
			sel: sel.length,
			gizmoBack,
			moveOk,
			maxBefore,
			maxAfter,
			stayedOuter,
			selAfterMove: selAfterMove.length,
			began,
			dragMax
		};
	});

	h.check(
		res.insetOk && res.sel === res.capTris,
		`inset keeps its cap selected (${res.sel}/${res.capTris} tris)`
	);
	h.check(res.gizmoBack, 'E7: the gizmo comes back seated after the commit');
	h.check(
		res.moveOk && Math.abs(res.maxAfter - (res.maxBefore + 0.4)) < 1e-3,
		`Move moves the selected cap only (+X ${res.maxBefore.toFixed(2)} -> ${res.maxAfter.toFixed(2)})`
	);
	h.check(res.stayedOuter >= 8, `the outer +X plane stays put (${res.stayedOuter} entries at 0.5)`);
	h.check(res.selAfterMove === res.sel, 'the cap stays selected through the move');
	h.check(
		res.began && Math.abs(res.dragMax - (res.maxBefore + 0.6)) < 1e-3,
		`the gizmo grab path moves the same selection (max ${res.dragMax.toFixed(2)})`
	);

	await h.finish(browser);
});
