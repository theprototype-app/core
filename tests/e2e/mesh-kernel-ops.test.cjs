// Roadmap 99 K4 (families 1-3): the mesh operators on the KERNEL, through the real app. For every
// ported operator, in a real edit session: the op commits through commitMesh with its element IDs on
// BOTH sides of the history entry; the pre-op IDs survive (the vertex IDs of every corner the op did
// not consume, the face IDs of every triangle an append-only op kept); undo brings back the exact pre-op
// bytes AND the selection that was live before the op; redo brings back the op's bytes and its own
// selection; and the next operator starts from exactly the redone IDs (no re-weld renumbering).
const h = require('./helpers.cjs');

/** a fresh 2x2x2 box in a face session (faces submode) */
const editBox = (page) =>
	page.evaluate(() => {
		const s = window.__tp?.test.v1;
		s.faceEdit.exitFaceEdit?.();
		s.meshEdit.exitEditMode?.();
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		s.faceEdit.enterFaceEdit(window.__box.uuid);
		s.faceEdit.setFaceSubmode('faces');
		return window.__box.uuid;
	});

/**
 * Run one operator in the page and report: the entry's ID channels, the pick before / after the op /
 * after undo / after redo, the bytes, and the next op's starting IDs. `kind` picks the setup + op.
 */
const runCase = (page, kind) =>
	page.evaluate(async (kind) => {
		const s = window.__tp.test.v1;
		const fe = s.faceEdit;
		const me = s.meshEdit;
		const geo = () => window.__box.geometry;
		const get = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const pick = () => ({
			faces: [...get(fe.faceEditSelectedTris)].sort((a, b) => a - b),
			highlight: get(fe.faceEditHighlight),
			edges: [...get(fe.edgeEditSelected)].sort(),
			verts: get(me.vertexSelectionSize)
		});
		// the triangles' positions: an op's before-state is the session's triangle soup, so a mesh that started
		// INDEXED (a fresh box) comes back de-indexed with the same triangles
		const bytes = () => fe.readTriangles(geo()).flat().map((v) => `${v.x},${v.y},${v.z}`).join(';');
		const entry = () => get(s.history.undoStack).at(-1);
		const keyOf = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e4)).join(',');
		const tris = () => fe.readTriangles(geo());
		// setup: the +Y face picked, or one real edge of it, or the (1,1,1) corner in vertex mode
		if (kind === 'edge') {
			fe.setFaceSubmode('edges');
			const all = tris();
			let picked = null;
			for (let ti = 0; ti < all.length && !picked; ti++) {
				const t = all[ti];
				if (!t.every((v) => v.y > 0.99)) continue;
				const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
				for (let e = 0; e < 3 && !picked; e++) {
					const mid = t[e].clone().add(t[(e + 1) % 3]).multiplyScalar(0.5);
					const key = fe.pickEdgeAt(ti, c.clone().lerp(mid, 0.95));
					if (!key) continue;
					fe.pickEdge(key, false);
					if (fe.edgeSelectionSize() === 1) picked = key;
				}
			}
			if (!picked) return { error: 'no top edge' };
		} else if (kind === 'connect') {
			// two opposite corners of the top face in vertex mode (whichever diagonal is not already an edge)
			fe.exitFaceEdit();
			me.enterEditMode(window.__box.uuid);
			const handleAt = (x, y, z) => {
				for (let i = 0; i < 64; i++) {
					me.selectHandle(i);
					const w = me.vertexSelectionWorldPoint();
					if (!w) break;
					const l = window.__box.worldToLocal(w.clone());
					if (Math.abs(l.x - x) + Math.abs(l.y - y) + Math.abs(l.z - z) < 1e-4) return i;
				}
				return -1;
			};
			window.__pairs = [
				[handleAt(1, 1, 1), handleAt(-1, 1, -1)],
				[handleAt(1, 1, -1), handleAt(-1, 1, 1)]
			];
			if (window.__pairs.flat().some((i) => i < 0)) return { error: 'no top corners' };
			me.clearVertexSelection();
			me.selectHandle(window.__pairs[0][0]);
			me.toggleVertexSelection(window.__pairs[0][1]);
		} else if (kind === 'vertex') {
			fe.exitFaceEdit();
			me.enterEditMode(window.__box.uuid);
			let controls;
			s.TControls.subscribe((c) => (controls = c))();
			let found = -1;
			for (let i = 0; i < 32 && found < 0; i++) {
				me.selectHandle(i);
				const at = controls.object?.position;
				if (at && Math.abs(at.x - 1) < 1e-6 && Math.abs(at.y - 1) < 1e-6 && Math.abs(at.z - 1) < 1e-6) found = i;
			}
			if (found < 0) return { error: 'no corner handle' };
			me.clearVertexSelection();
			me.selectHandle(found);
		} else {
			const faces = fe.currentFaces();
			const k = faces.findIndex((f) => f.normal.y > 0.9);
			if (k < 0) return { error: 'no top face' };
			fe.highlightFaceByTriangle(faces[k].triIndices[0]);
		}
		const before = pick();
		const beforeBytes = bytes();
		const trisBefore = tris().length;
		const stackBefore = get(s.history.undoStack).length;
		let ok;
		if (kind === 'extrude') ok = fe.commitFaceOp('extrude', 0.4);
		else if (kind === 'inset') ok = fe.commitFaceOp('inset', 0.3);
		else if (kind === 'move') ok = fe.commitFaceOp('move', 0.25);
		else if (kind === 'bevel') ok = fe.bevelFaces(0.2, 2);
		else if (kind === 'edge') ok = fe.bevelEdges(0.2, 2, 0);
		else if (kind === 'loopcut') ok = fe.commitLoopCut(1, 0.5);
		else if (kind === 'knife') {
			// a line through the box's middle on screen, well past both sides (mesh-knife's aim)
			let camera;
			s.globalCamera.subscribe((c) => (camera = c))();
			const v = new s.THREE.Vector3(0, 0, 0).project(camera);
			const c = [((v.x + 1) / 2) * window.innerWidth, ((1 - v.y) / 2) * window.innerHeight];
			ok = fe.knifePolyline([
				[c[0] - 600, c[1] + 7],
				[c[0] + 600, c[1] - 5]
			]);
		} else if (kind === 'connect') {
			ok = me.connectSelectedVerts();
			if (ok === false) {
				// that diagonal was the box's own triangulation edge: the other one
				me.clearVertexSelection();
				me.selectHandle(window.__pairs[1][0]);
				me.toggleVertexSelection(window.__pairs[1][1]);
				ok = me.connectSelectedVerts();
			}
		} else ok = me.bevelSelectedVerts(0.4, 0);
		if (ok === false) return { error: kind + ' refused' };
		const e = entry();
		const recorded = get(s.history.undoStack).length > stackBefore && e?.kind === 'meshgeo';
		const ids = { b: e?.before?.ids ?? null, a: e?.after?.ids ?? null };
		const afterOp = pick();
		const afterBytes = bytes();
		// pre-op IDs that survive: every vertex ID the op did not consume, every kept triangle's face ID
		let survivingVerts = 0;
		let lostVerts = 0;
		let keptFaces = true;
		if (ids.b && ids.a) {
			const after = new Set(Array.from(ids.a.cornerVertex));
			for (const v of new Set(Array.from(ids.b.cornerVertex))) after.has(v) ? survivingVerts++ : lostVerts++;
			if (['extrude', 'inset', 'move', 'bevel'].includes(kind)) {
				const n = ids.b.triFace.length;
				for (let t = 0; t < n; t++) if (ids.a.triFace[t] !== ids.b.triFace[t]) keptFaces = false;
			}
		}
		s.history.undo();
		const undone = pick();
		const undoneBytes = bytes();
		s.history.redo();
		const redone = pick();
		const redoneBytes = bytes();
		// the next operator starts from exactly the redone IDs
		let nextStarts = null;
		if (kind === 'vertex' || kind === 'connect') {
			me.exitEditMode();
			fe.enterFaceEdit(window.__box.uuid);
			fe.setFaceSubmode('faces');
		} else if (kind === 'edge') fe.setFaceSubmode('faces');
		const faces = fe.currentFaces();
		const k = faces.findIndex((f) => f.normal.x > 0.9);
		if (k >= 0) {
			fe.highlightFaceByTriangle(faces[k].triIndices[0]);
			const moved = fe.commitFaceOp('move', 0.1);
			const n2 = entry();
			if (moved !== false && n2 !== e)
				nextStarts = {
					verts: Array.from(n2.before.ids?.cornerVertex ?? []).join(',') === Array.from(ids.a?.cornerVertex ?? []).join(','),
					shared: n2.after.ids === n2.before.ids
				};
		}
		return {
			recorded,
			hasIds: !!(ids.b?.cornerVertex && ids.b?.triFace && ids.a?.cornerVertex && ids.a?.triFace),
			survivingVerts,
			lostVerts,
			keptFaces,
			changed: afterBytes !== beforeBytes,
			before,
			afterOp,
			undone,
			redone,
			undoBytes: undoneBytes === beforeBytes,
			redoBytes: redoneBytes === afterBytes,
			nextStarts,
			trisBefore,
			trisAfter: afterBytes.split(';').length / 3,
			keyCount: new Set(tris().flat().map(keyOf)).size
		};
	}, kind);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__tp?.test?.v1?.faceEdit, null, { timeout: 60000 });

	// what each op consumes: extrude/inset/move/face bevel keep every pre-op vertex (a detach only ADDS), the edge
	// bevel consumes the edge's two ends, the vertex bevel its corner
	// (family 3: the cuts reuse every corner — a loop cut's sub-quads end on the ring's own corners, the knife and
	// connect only add)
	const consumes = { extrude: 0, inset: 0, move: 0, bevel: 0, edge: 2, vertex: 1, loopcut: 0, knife: 0, connect: 0 };
	// the triangle counts the cuts must reach on a 2x2x2 box (12 triangles): a loop cut splits a 4-quad ring in two
	// (+8), a connect re-splits one quad (+0), the knife splits what it crosses (more)
	const grows = { loopcut: (b, a) => a === b + 8, knife: (b, a) => a > b, connect: (b, a) => a === b };
	for (const kind of ['extrude', 'inset', 'move', 'bevel', 'edge', 'vertex', 'loopcut', 'knife', 'connect']) {
		console.log(`\n=== ${kind} ===`);
		await editBox(A.page);
		const r = await runCase(A.page, kind);
		if (r.error) {
			h.check(false, `${kind}: ${r.error} (premise)`);
			continue;
		}
		h.check(r.recorded && r.changed, `${kind}: committed one meshgeo entry and changed the mesh (premise)`);
		h.check(r.hasIds, `${kind}: the entry holds the element IDs on both sides`);
		if (grows[kind])
			h.check(grows[kind](r.trisBefore, r.trisAfter), `${kind}: the cut's triangle count (${r.trisBefore} -> ${r.trisAfter})`);
		h.check(
			r.lostVerts === consumes[kind] && r.survivingVerts > 0,
			`${kind}: every pre-op vertex ID survives but the ${consumes[kind]} the op consumed (${r.survivingVerts} kept, ${r.lostVerts} gone)`
		);
		if (['extrude', 'inset', 'move', 'bevel'].includes(kind))
			h.check(r.keptFaces, `${kind}: every pre-op triangle keeps its face ID (the op appends)`);
		h.check(r.undoBytes, `${kind}: undo restores the exact pre-op triangles`);
		h.check(
			same(r.undone, r.before),
			`${kind}: the selection after undo is the selection before the op (${JSON.stringify(r.before)} / ${JSON.stringify(r.undone)})`
		);
		h.check(r.redoBytes, `${kind}: redo restores the op's triangles`);
		h.check(
			same(r.redone, r.afterOp),
			`${kind}: redo restores the op's own selection (${JSON.stringify(r.afterOp)} / ${JSON.stringify(r.redone)})`
		);
		h.check(!!r.nextStarts?.verts, `${kind}: the next operator starts from exactly the redone vertex IDs`);
		h.check(!!r.nextStarts?.shared, `${kind}: ...and a move after it shares its ID channels (no topology change)`);
	}
	await browser.close();
});
