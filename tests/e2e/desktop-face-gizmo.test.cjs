// Phase 163: desktop face editing with a transform gizmo. Selecting a face
// attaches a gizmo (a scene-root proxy driving the shared 162 rigid grab); a
// drag moves the face + commits ONE meshgeo (undoable); 1/2/3 switch the gizmo
// mode without deselecting; leaving face mode detaches it. Pointer/gizmo feel
// is a desktop manual check — here we drive the proxy directly.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let grp; s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		s.objectActions.selectObject(box.uuid);
		s.faceEdit.enterFaceEdit(box.uuid);

		// pick the +X face + attach the gizmo
		const faces = s.faceEdit.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		s.faceEdit.highlightFaceByTriangle(faces[xi].triIndices[0]);
		s.faceEdit.attachFaceGizmo();
		let controls; s.TControls.subscribe((c) => (controls = c))();
		const attached = controls?.object?.userData?.isFaceProxy === true;

		const maxX = () => {
			const p = box.geometry.attributes.position;
			let m = -1e9;
			for (let i = 0; i < p.count; i++) m = Math.max(m, p.getX(i));
			return m;
		};
		const before = maxX();

		// simulate a translate drag of the gizmo (+0.5 world x)
		const captured = []; let original;
		s.peers.subscribe((p) => (original = p))();
		s.peers.set({ ...(original ?? {}), peer: { id: 'me' }, send: (m) => captured.push(m) });
		s.faceEdit.onFaceGizmoDragChanged(true); // begin grab
		controls.object.position.x += 0.5;
		s.faceEdit.onFaceGizmoMoved(); // apply live
		const dragged = maxX();
		s.faceEdit.onFaceGizmoDragChanged(false); // commit
		s.peers.set(original);
		const committed = maxX();
		const meshgeo = captured.filter((m) => m.type === 'meshgeo').length;

		// 1/2/3 switch the gizmo mode WITHOUT deselecting the face proxy
		s.objectActions.setTransformMode('rotate');
		const rotMode = controls.mode === 'rotate';
		const stillFace = controls.object?.userData?.isFaceProxy === true;

		s.history.undo();
		const undone = maxX();

		s.faceEdit.exitFaceEdit();
		const detached = controls.object?.userData?.isFaceProxy !== true;

		return { attached, before, dragged, committed, meshgeo, rotMode, stillFace, undone, detached };
	});

	h.check(res.attached, 'selecting a face attaches the transform gizmo');
	h.check(res.dragged > res.before + 0.4, `dragging the gizmo moves the face (+X ${res.before.toFixed(2)} -> ${res.dragged.toFixed(2)})`);
	h.check(res.meshgeo >= 1, 'the drag broadcasts a meshgeo snapshot (final + throttled previews)');
	h.check(res.committed > res.before + 0.4, 'the move persists after release');
	h.check(res.rotMode && res.stillFace, '1/2/3 switches the gizmo mode without deselecting');
	h.check(Math.abs(res.undone - res.before) < 1e-3, 'the face move is undoable');
	h.check(res.detached, 'leaving face mode detaches the gizmo');

	await h.finish(browser);
});
