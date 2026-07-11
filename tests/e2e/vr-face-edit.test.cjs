// Phase 118 (last, riskiest): VR face editing. The topology core — face
// grouping (a cube = 6 faces), extrude/inset/move/delete geometry math, the
// meshgeo snapshot replication + undo — plus the VR flow (enter mode, arm op,
// highlight, commit) and the cap refusal. In-headset ray-highlight + ghost
// feel is the user's manual check; the ops are verified by driving the core.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- topology core: a box groups into 6 faces; ops rebuild geometry ---
	const core = await A.page.evaluate(() => {
		const f = window.__stores.faceEdit;
		const THREE = window.__stores.THREE;
		const box = new THREE.BoxGeometry(1, 1, 1);
		const tris = f.readTriangles(box);
		const faces = f.groupFaces(tris);
		// pick the +X face (normal ≈ (1,0,0))
		const xFace = faces.find((fc) => fc.normal.x > 0.9);
		const extruded = f.extrudeFace(tris, xFace, 0.5);
		const moved = f.moveFaceAlongNormal(tris, xFace, 0.5);
		const inset = f.insetFace(tris, xFace, 0.3);
		const deleted = f.deleteFaceTris(tris, xFace);
		// the extruded cap sits 0.5 further out in x
		const capMaxX = Math.max(...extruded.flat().map((v) => v.x));
		const movedMaxX = Math.max(...moved.flat().map((v) => v.x));
		return {
			triCount: tris.length,
			faceCount: faces.length,
			xFaceTris: xFace.triIndices.length,
			extrudedTris: extruded.length,
			deletedTris: deleted.length,
			movedTris: moved.length,
			insetTris: inset.length,
			capMaxX,
			movedMaxX
		};
	});
	h.check(core.triCount === 12 && core.faceCount === 6, `a cube is 12 tris / 6 faces (${core.faceCount})`);
	h.check(core.xFaceTris === 2, 'each cube face groups two triangles');
	h.check(
		core.extrudedTris === 12 + 8,
		`extrude adds 2 wall tris per boundary edge (${core.extrudedTris})`
	);
	h.check(
		Math.abs(core.capMaxX - 1) < 1e-6 && Math.abs(core.movedMaxX - 1) < 1e-6,
		`extrude + move push the +X cap to x=1 (${core.capMaxX.toFixed(2)}/${core.movedMaxX.toFixed(2)})`
	);
	h.check(core.deletedTris === 10, 'delete drops the face tris (12→10)');
	h.check(core.movedTris === 12 && core.insetTris === 12, 'move + inset keep the triangle count');

	// --- eligibility cap ---
	const cap = await A.page.evaluate(() => {
		const f = window.__stores.faceEdit;
		const THREE = window.__stores.THREE;
		const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
		const dense = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 32));
		return { cap: f.VR_FACE_CAP, boxOk: f.vrFaceEditable(box), denseOk: f.vrFaceEditable(dense) };
	});
	h.check(cap.cap === 300, 'VR face cap is 300 triangles');
	h.check(cap.boxOk === true && cap.denseOk === false, 'a box is editable, a dense sphere is refused');

	// --- VR flow: enter mode, arm op, highlight, commit an extrude ---
	const flow = await A.page.evaluate(async () => {
		const s = window.__stores;
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		s.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		window.__fbox = box;
		s.objectActions.selectObject(box.uuid);
		const trisBefore = s.faceEdit.readTriangles(box.geometry).length;

		s.vrMenuOpen.set(true);
		s.vrControls.executeVRMenuAction('nav:faces'); // enters face mode + faces ring
		const editing = read(s.faceEdit.faceEditObject) === box.uuid;
		let ring;
		s.vrRadialMenu.activeRing.subscribe((r) => (ring = r))();
		s.vrControls.executeVRMenuAction('face:extrude'); // arm extrude, closes ring
		const armed = read(s.faceEdit.faceEditOp);

		// highlight a face (as the pointer ray would) and commit
		s.faceEdit.highlightFaceByTriangle(0);
		const hi = read(s.faceEdit.faceEditHighlight);
		s.faceEdit.faceEditAmount.set(0.5);
		const ok = s.faceEdit.commitArmedFaceOp();
		const trisAfter = s.faceEdit.readTriangles(box.geometry).length;
		return { editing, ring, armed, hi, ok, trisBefore, trisAfter };
	});
	h.check(flow.editing && flow.ring === 'faces', 'Faces ▸ enters face-edit mode and opens the ops ring');
	h.check(flow.armed === 'extrude', 'selecting Extrude arms the op');
	h.check(flow.hi >= 0, 'a face highlights');
	h.check(
		flow.ok && flow.trisAfter === flow.trisBefore + 8,
		`committing extrude rebuilds the geometry (${flow.trisBefore}→${flow.trisAfter} tris)`
	);

	// --- the commit records an undoable meshgeo entry ---
	const undo = await A.page.evaluate(() => {
		const box = window.__fbox;
		const before = box.geometry.attributes.position.count / 3;
		window.__stores.history.undo();
		const after = box.geometry.attributes.position.count / 3;
		return { before, after };
	});
	h.check(undo.before === 20 && undo.after === 12, `undo restores the pre-extrude geometry (${undo.after} tris)`);

	// --- commit broadcasts a meshgeo snapshot ---
	const sent = await A.page.evaluate(() => {
		const s = window.__stores;
		const captured = [];
		let original;
		s.peers.subscribe((p) => (original = p))();
		s.peers.set({ ...(original ?? {}), peer: { id: 'me' }, send: (m) => captured.push(m) });
		s.faceEdit.highlightFaceByTriangle(0);
		s.faceEdit.setFaceOp('move');
		s.faceEdit.faceEditAmount.set(0.3);
		s.faceEdit.commitArmedFaceOp();
		s.peers.set(original);
		const msg = captured.find((m) => m.type === 'meshgeo');
		return { hasMsg: !!msg, uuid: msg?.uuid === window.__fbox.uuid, len: msg?.positions?.length };
	});
	h.check(sent.hasMsg && sent.uuid && sent.len > 0, `commit broadcasts a meshgeo snapshot (${sent.len} floats)`);

	// --- applyMeshGeo swaps a receiver's geometry ---
	const applied = await A.page.evaluate(() => {
		const s = window.__stores;
		const box = window.__fbox;
		const flat = [];
		const p = box.geometry.attributes.position;
		for (let i = 0; i < p.count; i++) flat.push(p.getX(i) + 2, p.getY(i), p.getZ(i)); // shift +2x
		s.faceEdit.applyMeshGeo(box.uuid, flat);
		const minX = Math.min(...Array.from({ length: box.geometry.attributes.position.count }, (_, i) => box.geometry.attributes.position.getX(i)));
		return { minX, faceEdited: box.userData.faceEdited === true };
	});
	h.check(applied.minX > 1 && applied.faceEdited, 'applyMeshGeo swaps geometry + flags the object');

	// --- exit + grip exits, back on the faces ring exits ---
	const exit = await A.page.evaluate(() => {
		const s = window.__stores;
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		s.faceEdit.exitFaceEdit();
		const cleared = read(s.faceEdit.faceEditObject);
		let scene;
		s.globalScene.subscribe((x) => (scene = x))();
		return { cleared, overlayGone: !scene?.getObjectByName('face-edit-overlay') };
	});
	h.check(exit.cleared === null && exit.overlayGone, 'exit clears face mode and removes the overlay');

	// --- locked objects refuse entering face mode ---
	const locked = await A.page.evaluate(() => {
		const s = window.__stores;
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		s.objectActions.selectObject(window.__fbox.uuid);
		s.lockedObjects.set([['peerX', window.__fbox.uuid]]);
		s.vrControls.executeVRMenuAction('nav:faces');
		const editing = read(s.faceEdit.faceEditObject);
		s.lockedObjects.set([]);
		return editing;
	});
	h.check(locked === null, 'a peer-locked object refuses face editing');

	await h.finish(browser);
});
