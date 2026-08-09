// 15-F: session-scoped undo. While an Edit Mesh session is active, Ctrl+Z
// steps only through the session's own edits (a live barrier — entries land
// on undoStack normally); Done seals the whole session into ONE undo entry
// (all-meshgeo sessions compact to a single synthetic meshgeo; mixed kinds
// become a 'session' composite). Collider PROXY sessions discard.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// setup: a box to edit + a second object whose undone creation leaves a
	// PRE-session redo entry to protect
	const pre = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		s.commandsHandler.sceneCommand('/create Sphere 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 2];
		window.__sphere = g.children[g.children.length - 1];
		s.history.undo(); // sphere creation -> the redo stack
		return { sphereGone: !g.getObjectByProperty('uuid', window.__sphere.uuid) };
	});
	h.check(pre.sphereGone, 'setup: a pre-session redo entry exists (sphere undone)');

	// --- in-session stepping + the barrier ---
	const inSession = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const undoLen = () => {
			let n;
			s.history.undoStack.subscribe((v) => (n = v.length))();
			return n;
		};
		const tris = () => fe.readTriangles(window.__box.geometry).length;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const baseLen = undoLen();
		fe.enterFaceEdit(window.__box.uuid);
		// pre-session redo is protected while the session is open
		s.history.redo();
		const redoBlocked = !g.getObjectByProperty('uuid', window.__sphere.uuid);
		const faces = fe.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		fe.highlightFaceByTriangle(faces[xi].triIndices[0]);
		const t0 = tris();
		fe.commitFaceOp('inset', 0.3);
		const t1 = tris();
		fe.commitFaceOp('extrude', 0.4); // E6: applies to the selected cap
		const t2 = tris();
		s.history.undo();
		const afterUndo1 = tris();
		s.history.undo();
		const afterUndo2 = tris();
		const lenAtBarrier = undoLen();
		s.history.undo(); // barrier: must be a no-op
		const barrierHeld = tris() === afterUndo2 && undoLen() === lenAtBarrier;
		s.history.redo(); // in-session redo works
		const afterRedo = tris();
		return { baseLen, redoBlocked, t0, t1, t2, afterUndo1, afterUndo2, barrierHeld, afterRedo };
	});
	h.check(inSession.redoBlocked, 'pre-session redo is protected while the session is open');
	h.check(
		inSession.t1 > inSession.t0 && inSession.t2 > inSession.t1,
		`two ops committed (${inSession.t0} -> ${inSession.t1} -> ${inSession.t2})`
	);
	h.check(
		inSession.afterUndo1 === inSession.t1 && inSession.afterUndo2 === inSession.t0,
		'in-session undo steps back through the session ops'
	);
	h.check(inSession.barrierHeld, 'a third undo hits the barrier and changes nothing');
	h.check(inSession.afterRedo === inSession.t1, 'in-session redo re-applies');

	// --- Done collapses the session into EXACTLY one compacted meshgeo ---
	const sealed = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const undoLen = () => {
			let n;
			s.history.undoStack.subscribe((v) => (n = v.length))();
			return n;
		};
		const tris = () => fe.readTriangles(window.__box.geometry).length;
		s.history.redo(); // the extrude comes back -> full session state
		const t2 = tris();
		fe.exitFaceEdit();
		s.editSession.sealEditHistorySession(); // the Done path
		const lenAfterDone = undoLen();
		let top;
		s.history.undoStack.subscribe((v) => (top = v[v.length - 1]))();
		s.history.undo(); // ONE undo restores pre-session geometry
		const restored = tris();
		s.history.redo(); // redo re-applies the whole session
		const reapplied = tris();
		return { lenAfterDone, topKind: top.kind, t2, restored, reapplied };
	});
	h.check(
		sealed.lenAfterDone === inSession.baseLen + 1,
		`Done grew the undo stack by exactly 1 (${inSession.baseLen} -> ${sealed.lenAfterDone})`
	);
	h.check(sealed.topKind === 'meshgeo', `an all-mesh session compacts to one meshgeo (${sealed.topKind})`);
	h.check(sealed.restored === inSession.t0, `one undo restores pre-session geometry (${sealed.restored})`);
	h.check(sealed.reapplied === sealed.t2, `one redo re-applies the whole session (${sealed.reapplied})`);

	// --- a VR-style grab commit collapses into the same single entry ---
	const vrStyle = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const undoLen = () => {
			let n;
			s.history.undoStack.subscribe((v) => (n = v.length))();
			return n;
		};
		const tris = () => fe.readTriangles(window.__box.geometry).length;
		const preTris = tris();
		const base = undoLen();
		fe.enterFaceEdit(window.__box.uuid);
		const faces = fe.currentFaces();
		fe.highlightFaceByTriangle(faces[0].triIndices[0]);
		fe.commitFaceOp('inset', 0.2);
		fe.beginFaceGrab(fe.currentTargetFace());
		fe.applyFaceGrab({ dPos: new s.THREE.Vector3(0, 0.3, 0) });
		fe.commitFaceGrab(); // the VR commit path
		fe.exitFaceEdit();
		s.editSession.sealEditHistorySession();
		const grew = undoLen() - base;
		s.history.undo();
		return { grew, restored: tris() === preTris };
	});
	h.check(vrStyle.grew === 1, `a VR-style grab commit joins the collapse (${vrStyle.grew} entries)`);
	h.check(vrStyle.restored, 'undoing the sealed session restores the pre-session geometry');

	// --- mixed kinds (meshgeo + props) seal as a 'session' composite ---
	const mixed = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const undoLen = () => {
			let n;
			s.history.undoStack.subscribe((v) => (n = v.length))();
			return n;
		};
		const tris = () => fe.readTriangles(window.__box.geometry).length;
		const preTris = tris();
		const base = undoLen();
		fe.enterFaceEdit(window.__box.uuid);
		const faces = fe.currentFaces();
		fe.highlightFaceByTriangle(faces[0].triIndices[0]);
		fe.commitFaceOp('inset', 0.2);
		s.physics.setPhysicsFor(window.__box.uuid, { mode: 'fixed' }); // a 'props' entry mid-session
		fe.exitFaceEdit();
		s.editSession.sealEditHistorySession();
		const grew = undoLen() - base;
		let top;
		s.history.undoStack.subscribe((v) => (top = v[v.length - 1]))();
		s.history.undo(); // the composite reverts BOTH kinds
		const physicsReverted = window.__box.userData.physics?.mode !== 'fixed';
		return { grew, topKind: top.kind, physicsReverted, restored: tris() === preTris };
	});
	h.check(
		mixed.grew === 1 && mixed.topKind === 'session',
		`a mixed-kind session seals as ONE composite (${mixed.grew}, ${mixed.topKind})`
	);
	h.check(
		mixed.physicsReverted && mixed.restored,
		'the composite undo reverts both the props change and the geometry'
	);

	// --- undoing the only op, then Done: the seal records nothing ---
	const emptySeal = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const undoLen = () => {
			let n;
			s.history.undoStack.subscribe((v) => (n = v.length))();
			return n;
		};
		const base = undoLen();
		fe.enterFaceEdit(window.__box.uuid);
		const faces = fe.currentFaces();
		fe.highlightFaceByTriangle(faces[0].triIndices[0]);
		fe.commitFaceOp('inset', 0.2);
		s.history.undo(); // back to the session start
		fe.exitFaceEdit();
		s.editSession.sealEditHistorySession();
		return { grew: undoLen() - base };
	});
	h.check(emptySeal.grew === 0, 'undoing the only op then Done records nothing');

	// --- collider sessions DISCARD their proxy edits; only the props entry lands ---
	const collider = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				const s = window.__stores;
				const fe = s.faceEdit;
				const ce = s.colliderEdit;
				const undoLen = () => {
					let n;
					s.history.undoStack.subscribe((v) => (n = v.length))();
					return n;
				};
				const base = undoLen();
				const preCollider = window.__box.userData.physics?.collider ?? null;
				ce.enterColliderEdit(window.__box.uuid);
				const faces = fe.currentFaces();
				fe.highlightFaceByTriangle(faces[0].triIndices[0]);
				fe.commitFaceOp('extrude', 0.3); // a meshgeo entry on the PROXY
				const during = undoLen() - base;
				const ok = ce.commitColliderEdit();
				setTimeout(() => {
					let top;
					s.history.undoStack.subscribe((v) => (top = v[v.length - 1]))();
					const after = undoLen() - base;
					const saved = window.__box.userData.physics?.collider === 'custom';
					s.history.undo(); // the props entry restores the previous collider
					const undone = (window.__box.userData.physics?.collider ?? null) === preCollider;
					resolve({ ok, during, after, topKind: top.kind, saved, undone });
				}, 150);
			})
	);
	h.check(collider.ok && collider.saved, 'the collider commit saves the custom collider');
	h.check(collider.during === 1, `the proxy edit landed above the barrier (${collider.during})`);
	h.check(
		collider.after === 1 && collider.topKind === 'props',
		`the seal DISCARDS proxy edits — only the props entry lands (${collider.after}, ${collider.topKind})`
	);
	h.check(collider.undone, 'undoing the props entry restores the previous collider');

	await h.finish(browser);
});
