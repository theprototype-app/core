// Roadmap 99 K4 families 4-6 (lane 99-ops-b): the mesh operators on the KERNEL, through the real app — family 4
// bridge / fill / solidify, family 5 face delete / merge by distance / edge dissolve / edge delete (the vertex-mode
// delete and dissolve are covered headless in tests/unit/meshOps99bIds), family 6 face subdivide / edge subdivide /
// symmetrize (live symmetry is mesh-symmetry-live's). For every
// ported operator, in a real edit session: the op commits through commitMesh with its element IDs on BOTH sides
// of the history entry; the pre-op vertex IDs survive except the ones the op consumed; undo brings back the exact
// pre-op bytes AND the selection that was live before the op; redo brings back the op's bytes and its own
// selection; and the next operator starts from exactly the redone IDs (no re-weld renumbering).
// The family-1-3 twin is mesh-kernel-ops (lane 99-ops-a).
const h = require('./helpers.cjs');

/** a fresh 2x2x2 box in a face session (faces submode). `crack`: one corner of one side moved 3e-4 off its
 * neighbours' (inside a 0.001 merge, outside the editor's 1e-4 weld), before the session opens */
const editBox = (page, crack = false) =>
	page.evaluate((crack) => {
		const s = window.__tp?.test.v1;
		s.faceEdit.exitFaceEdit?.();
		s.meshEdit.exitEditMode?.();
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		if (crack) {
			const p = window.__box.geometry.attributes.position;
			p.setX(0, p.getX(0) + 3e-4);
			p.needsUpdate = true;
		}
		s.faceEdit.enterFaceEdit(window.__box.uuid);
		s.faceEdit.setFaceSubmode('faces');
		return window.__box.uuid;
	}, crack);

/**
 * Run one operator in the page and report: the entry's ID channels, the pick before / after the op / after
 * undo / after redo, the bytes, and the next op's starting IDs. `kind` picks the setup + op.
 */
const runCase = (page, kind) =>
	page.evaluate(async (kind) => {
		const s = window.__tp.test.v1;
		const fe = s.faceEdit;
		const geo = () => window.__box.geometry;
		const get = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const pick = () => ({
			faces: [...get(fe.faceEditSelectedTris)].sort((a, b) => a - b),
			highlight: get(fe.faceEditHighlight),
			edges: [...get(fe.edgeEditSelected)].sort()
		});
		// the triangles' corner positions (an indexed entry box and its non-indexed undo state hold the same mesh)
		const bytes = () => fe.readTriangles(geo()).flat().map((v) => `${v.x},${v.y},${v.z}`).join(';');
		const entry = () => get(s.history.undoStack).at(-1);
		const tris = () => fe.readTriangles(geo());
		const faceWith = (test) => tris().findIndex((t) => t.every(test));
		/** open the box: delete its +Y face (its own undo step, before the measured op) */
		const openTop = () => {
			fe.highlightFaceByTriangle(faceWith((v) => v.y > 0.99));
			fe.pickFaceUnit(faceWith((v) => v.y > 0.99));
			return fe.commitFaceOp('delete', 0);
		};
		if (kind === 'bridge') {
			// the +Y and -Y faces: two pieces of one shell, a hole through the box
			fe.toggleFaceSelection(faceWith((v) => v.y > 0.99));
			fe.toggleFaceSelection(faceWith((v) => v.y < -0.99));
		} else if (kind === 'fill') {
			if (!openTop()) return { error: 'could not open the box' };
			fe.setFaceSubmode('edges');
			// one rim edge: a side triangle's edge on y = 1
			const all = tris();
			let picked = null;
			for (let ti = 0; ti < all.length && !picked; ti++) {
				const t = all[ti];
				const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
				for (let e = 0; e < 3 && !picked; e++) {
					if (!(t[e].y > 0.99 && t[(e + 1) % 3].y > 0.99)) continue;
					const mid = t[e].clone().add(t[(e + 1) % 3]).multiplyScalar(0.5);
					const key = fe.pickEdgeAt(ti, c.clone().lerp(mid, 0.95));
					if (!key) continue;
					fe.pickEdge(key, false);
					if (fe.edgeSelectionSize() === 1) picked = key;
				}
			}
			if (!picked) return { error: 'no rim edge' };
		} else if (kind === 'solidify') {
			if (!openTop()) return { error: 'could not open the box' };
			fe.setFaceGranularity('object');
			fe.selectAllFaces();
		} else if (kind === 'delete') {
			fe.highlightFaceByTriangle(faceWith((v) => v.y > 0.99));
			fe.pickFaceUnit(faceWith((v) => v.y > 0.99));
		} else if (kind === 'subdivide') {
			fe.highlightFaceByTriangle(faceWith((v) => v.y > 0.99));
			fe.pickFaceUnit(faceWith((v) => v.y > 0.99));
		} else if (kind === 'symmetrize') {
			// nothing to pick: the whole mesh, the +X half kept
		} else if (kind === 'dissolve' || kind === 'edelete' || kind === 'esub') {
			if (kind === 'dissolve') {
				// the top as a 2x2 grid (its own undo step): an interior edge joins two coplanar quads
				fe.highlightFaceByTriangle(faceWith((v) => v.y > 0.99));
				fe.pickFaceUnit(faceWith((v) => v.y > 0.99));
				if (fe.commitFaceOp('subdivide', 0) === false) return { error: 'could not subdivide the top' };
			}
			fe.setFaceSubmode('edges');
			const all = tris();
			// dissolve: the interior edge (0,1,0)-(1,1,0); delete: a rim edge of the top
			const wantMid = kind === 'dissolve' ? [0.5, 1, 0] : null;
			let picked = null;
			for (let ti = 0; ti < all.length && !picked; ti++) {
				const t = all[ti];
				const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
				for (let e = 0; e < 3 && !picked; e++) {
					const a = t[e];
					const b = t[(e + 1) % 3];
					if (!(a.y > 0.99 && b.y > 0.99)) continue;
					const mid = a.clone().add(b).multiplyScalar(0.5);
					if (wantMid && mid.distanceTo(new a.constructor(...wantMid)) > 1e-4) continue;
					const key = fe.pickEdgeAt(ti, c.clone().lerp(mid, 0.95));
					if (!key) continue;
					fe.pickEdge(key, false);
					if (fe.edgeSelectionSize() === 1) picked = key;
				}
			}
			if (!picked) return { error: 'no edge to pick' };
		}
		const before = pick();
		const beforeBytes = bytes();
		const stackBefore = get(s.history.undoStack).length;
		let ok;
		if (kind === 'bridge') ok = fe.bridgeFaces(1, 0, false);
		else if (kind === 'fill') ok = fe.fillHole();
		else if (kind === 'delete') ok = fe.commitFaceOp('delete', 0);
		else if (kind === 'merge') ok = fe.mergeByDistance(0.001);
		else if (kind === 'dissolve') ok = fe.dissolveEdges();
		else if (kind === 'edelete') ok = fe.deleteSelectedEdges();
		else if (kind === 'subdivide') ok = fe.commitFaceOp('subdivide', 0);
		else if (kind === 'esub') ok = fe.subdivideSelectedEdges();
		else if (kind === 'symmetrize') ok = fe.symmetrizeMesh('x', 1);
		else if (kind === 'solidify') {
			ok = fe.beginOpAdjust('solidify', { thickness: 0.1 });
			if (ok !== false) {
				fe.reapplyOpAdjust({ thickness: 0.15 });
				fe.settleOpAdjust();
			}
		}
		if (ok === false) return { error: kind + ' refused' };
		const e = entry();
		const recorded = get(s.history.undoStack).length > stackBefore && e?.kind === 'meshgeo';
		const ids = { b: e?.before?.ids ?? null, a: e?.after?.ids ?? null };
		const afterOp = pick();
		const afterBytes = bytes();
		let survivingVerts = 0;
		let lostVerts = 0;
		if (ids.b && ids.a) {
			const after = new Set(Array.from(ids.a.cornerVertex));
			for (const v of new Set(Array.from(ids.b.cornerVertex))) after.has(v) ? survivingVerts++ : lostVerts++;
		}
		// the face IDs of every pre-op triangle the op kept (fill / solidify append; a bridge drops its caps)
		let keptFaces = true;
		if (ids.b && ids.a && (kind === 'fill' || kind === 'solidify')) {
			const n = ids.b.triFace.length;
			for (let t = 0; t < n; t++) if (ids.a.triFace[t] !== ids.b.triFace[t]) keptFaces = false;
		}
		s.history.undo();
		const undone = pick();
		const undoneBytes = bytes();
		s.history.redo();
		const redone = pick();
		const redoneBytes = bytes();
		// the next operator starts from exactly the redone IDs
		let nextStarts = null;
		if (kind === 'fill' || kind === 'dissolve' || kind === 'edelete' || kind === 'esub') fe.setFaceSubmode('faces');
		fe.setFaceGranularity('quad');
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
			nextStarts
		};
	}, kind);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__tp?.test?.v1?.faceEdit, null, { timeout: 60000 });

	// what each op consumes: a bridge removes the two caps' faces but keeps every vertex (the box's caps have no
	// interior vertex); fill and solidify only ADD; a face / edge delete leaves every box corner on a third face; a
	// dissolve keeps the edge's ends (they are corners of the n-gon); a merge folds the cracked corner into its twin
	// subdivide (face or edge) only adds vertices; symmetrize keeping +X drops the four -X corners (their twins
	// are new vertices)
	const consumes = { bridge: 0, fill: 0, solidify: 0, delete: 0, merge: 1, dissolve: 0, edelete: 0, subdivide: 0, esub: 0, symmetrize: 4 };
	const kinds = ['bridge', 'fill', 'solidify', 'delete', 'merge', 'dissolve', 'edelete', 'subdivide', 'esub', 'symmetrize'];
	for (const kind of kinds) {
		console.log(`\n=== ${kind} ===`);
		await editBox(A.page, kind === 'merge');
		const r = await runCase(A.page, kind);
		if (r.error) {
			h.check(false, `${kind}: ${r.error} (premise)`);
			continue;
		}
		h.check(r.recorded && r.changed, `${kind}: committed one meshgeo entry and changed the mesh (premise)`);
		h.check(r.hasIds, `${kind}: the entry holds the element IDs on both sides`);
		h.check(
			r.lostVerts === consumes[kind] && r.survivingVerts > 0,
			`${kind}: every pre-op vertex ID survives but the ${consumes[kind]} the op consumed (${r.survivingVerts} kept, ${r.lostVerts} gone)`
		);
		if (kind === 'fill' || kind === 'solidify') h.check(r.keptFaces, `${kind}: every pre-op triangle keeps its face ID (the op appends)`);
		h.check(r.undoBytes, `${kind}: undo restores the exact pre-op bytes`);
		h.check(
			same(r.undone, r.before),
			`${kind}: the selection after undo is the selection before the op (${JSON.stringify(r.before)} / ${JSON.stringify(r.undone)})`
		);
		h.check(r.redoBytes, `${kind}: redo restores the op's bytes`);
		h.check(
			same(r.redone, r.afterOp),
			`${kind}: redo restores the op's own selection (${JSON.stringify(r.afterOp)} / ${JSON.stringify(r.redone)})`
		);
		h.check(!!r.nextStarts?.verts, `${kind}: the next operator starts from exactly the redone vertex IDs`);
		h.check(!!r.nextStarts?.shared, `${kind}: ...and a move after it shares its ID channels (no topology change)`);
	}
	await browser.close();
});
