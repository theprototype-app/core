// Selection undo/redo (user ask: "allow to undo/redo vertices and polygon
// selections"). Picks record a 'selection' history entry — the ONE kind that
// never broadcasts, because a selection is per viewer. The entries are
// SESSION-LOCAL: Ctrl+Z walks back a loop select or an invert while you edit,
// and the 15-F seal drops them on Done, so the sealed entry still describes
// the geometry change rather than which faces happened to be lit.
const h = require('./helpers.cjs');

const undoLen = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.history.undoStack.subscribe((v) => r(v.length))())
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --------------------------------------------------- 1. faces
	const faces = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		fe.enterFaceEdit(window.__box.uuid);
		fe.setFaceSubmode('faces');
		const sel = () => {
			let v;
			fe.faceEditSelectedTris.subscribe((x) => (v = [...x]))();
			return v;
		};
		fe.pickFaceUnit(0); // one quad
		const afterPick = sel().length;
		fe.selectAllFaces(); // the whole box
		const afterAll = sel().length;
		s.history.undo();
		const undone = sel().length;
		s.history.redo();
		const redone = sel().length;
		s.history.undo();
		s.history.undo(); // back past the first pick
		const empty = sel().length;
		return { afterPick, afterAll, undone, redone, empty };
	});
	h.check(faces.afterPick === 2, 'a quad pick selects its 2 triangles (premise)');
	h.check(faces.afterAll === 12, 'select-all takes the whole box (premise)');
	h.check(faces.undone === faces.afterPick, 'undo walks back to the previous face selection');
	h.check(faces.redone === faces.afterAll, 'redo puts it back');
	h.check(faces.empty === 0, 'a second undo reaches the empty selection the session started with');

	// a no-op pick must not fill the stack
	const noop = await A.page.evaluate(() => {
		const s = window.__stores;
		const len = () => {
			let n;
			s.history.undoStack.subscribe((v) => (n = v.length))();
			return n;
		};
		s.faceEdit.pickFaceUnit(0);
		const before = len();
		s.faceEdit.pickFaceUnit(0); // the same unit again
		return { before, after: len() };
	});
	h.check(noop.after === noop.before, 'picking the same unit twice records nothing');

	// --------------------------------------------------- 2. edges
	const edges = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		fe.setFaceSubmode('edges');
		const sel = () => {
			let v;
			fe.edgeEditSelected.subscribe((x) => (v = [...x]))();
			return v;
		};
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const t = fe.readTriangles(window.__box.geometry)[0];
		const mid = t[0].clone().add(t[1]).multiplyScalar(0.5);
		const probe = t[0]
			.clone()
			.add(t[1])
			.add(t[2])
			.multiplyScalar(1 / 3)
			.lerp(mid, 0.95);
		fe.pickEdge(fe.pickEdgeAt(0, probe), false);
		const afterPick = sel().length;
		fe.selectAllEdges();
		const afterAll = sel().length;
		s.history.undo();
		const undone = sel().length;
		// the submode is restored with the entry, so the undo is VISIBLE
		let mode;
		fe.faceEditSubmode.subscribe((v) => (mode = v))();
		return { afterPick, afterAll, undone, mode };
	});
	h.check(edges.afterPick === 1, 'an edge pick selects one edge (premise)');
	h.check(edges.afterAll > edges.afterPick, 'select-all-edges takes the rest (premise)');
	h.check(edges.undone === edges.afterPick, 'undo walks back to the previous edge selection');
	h.check(edges.mode === 'edges', '...in the submode the entry belongs to');

	// --------------------------------------------------- 3. vertices
	const verts = await A.page.evaluate(() => {
		const s = window.__stores;
		s.faceEdit.exitFaceEdit();
		s.meshEdit.enterEditMode(window.__box.uuid);
		const size = () => {
			let n;
			s.meshEdit.vertexSelectionSize.subscribe((v) => (n = v))();
			return n;
		};
		s.meshEdit.selectHandle(0);
		const one = size();
		s.meshEdit.selectAllVerts();
		const all = size();
		s.history.undo();
		const undone = size();
		s.history.redo();
		return { one, all, undone, redone: size() };
	});
	h.check(verts.one === 1, 'a plain vertex click selects one handle (premise)');
	h.check(verts.all > verts.one, 'select-all takes every handle (premise)');
	h.check(verts.undone === verts.one, 'undo walks back to the previous vertex selection');
	h.check(verts.redone === verts.all, 'redo puts it back');

	// ------------------------------------- 4. Done drops the selection steps
	const sealedLen = await undoLen(A.page);
	const sealed = await A.page.evaluate(() => {
		const s = window.__stores;
		s.meshEdit.exitEditMode();
		s.editSession.sealEditHistorySession();
		let stack;
		s.history.undoStack.subscribe((v) => (stack = v.map((e) => e.kind)))();
		return { stack };
	});
	h.check(
		!sealed.stack.includes('selection'),
		'Done leaves NO selection entries behind (they are session-local)'
	);
	h.check(
		sealed.stack.length < sealedLen,
		'...so the sealed session is shorter than the live one was'
	);

	// ------------------------- 5. a geometry op still seals as ONE undo entry
	// (the seal's meshgeo compaction must survive selection entries sitting
	// between the geometry steps)
	const withOps = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const tris = () => fe.readTriangles(window.__box.geometry).length;
		let stackBefore;
		s.history.undoStack.subscribe((v) => (stackBefore = v.length))();
		fe.enterFaceEdit(window.__box.uuid);
		fe.setFaceSubmode('faces');
		fe.pickFaceUnit(0); // a selection entry
		const startTris = tris();
		fe.commitFaceOp('extrude', 0.3); // a meshgeo entry
		fe.selectAllFaces(); // another selection entry
		fe.commitFaceOp('subdivide', 0); // another meshgeo entry
		const grown = tris();
		fe.exitFaceEdit();
		s.editSession.sealEditHistorySession();
		let kinds;
		s.history.undoStack.subscribe((v) => (kinds = v.map((e) => e.kind)))();
		s.history.undo();
		return {
			startTris,
			grown,
			added: kinds.length - stackBefore,
			lastKind: kinds[kinds.length - 1],
			afterUndo: tris()
		};
	});
	h.check(withOps.grown > withOps.startTris, 'extrude + subdivide grew the mesh (premise)');
	h.check(withOps.added === 1, 'the whole session seals into ONE undo entry');
	h.check(withOps.lastKind === 'meshgeo', '...compacted to a meshgeo, not a composite');
	h.check(
		withOps.afterUndo === withOps.startTris,
		'...and undoing it restores the geometry the session started with'
	);

	await h.finish(browser);
});
