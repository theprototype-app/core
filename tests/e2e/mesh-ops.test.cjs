// CL-B: Edit Mesh Pro — B1 inset gizmo-gating regression, B2 face-mode
// wireframe + toggle, B3 Face/Triangle/Shell granularity, B4 subdivide /
// flip / weld / bridge ops.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const uuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		window.__box = box;
		return box.uuid;
	});

	// --- B1: arming inset detaches the gizmo; two auto-applies both commit ---
	const inset = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		const fe = s.faceEdit;
		fe.enterFaceEdit(uuid);
		const triCount = () => window.__box.geometry.attributes.position.count / 3;
		// the +X PLANE must not translate (the old bug rigid-moved the face);
		// a vertex-count average would shift as insets ADD verts near the face
		const maxX = () => {
			const p = window.__box.geometry.attributes.position;
			let m = -1e9;
			for (let i = 0; i < p.count; i++) m = Math.max(m, p.getX(i));
			return m;
		};
		// highlight the +X face, arm MOVE first (seats the gizmo)...
		const faces = fe.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		fe.highlightFaceByTriangle(faces[xi].triIndices[0]);
		fe.setFaceOp('move');
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		const moveSeats = controls?.object?.userData?.isFaceProxy === true;
		// ...then arming INSET must DETACH it (it intercepted the next click)
		fe.setFaceOp('inset');
		const insetDetaches = controls?.object?.userData?.isFaceProxy !== true;
		// two consecutive auto-applies (what two face clicks dispatch) both grow
		const t0 = triCount();
		const x0 = maxX();
		fe.highlightFaceByTriangle(faces[xi].triIndices[0]);
		fe.autoApplyFaceOp();
		const t1 = triCount();
		// re-pick the (rebuilt) +X cap and inset again
		const faces2 = fe.currentFaces();
		const xi2 = faces2.findIndex((f) => f.normal.x > 0.9);
		fe.highlightFaceByTriangle(faces2[xi2].triIndices[0]);
		fe.autoApplyFaceOp();
		const t2 = triCount();
		const drift = Math.abs(maxX() - x0);
		return { moveSeats, insetDetaches, t0, t1, t2, drift };
	}, uuid);
	h.check(inset.moveSeats, 'arming Move seats the face gizmo');
	h.check(inset.insetDetaches, 'arming Inset DETACHES the gizmo (B1 interception fix)');
	h.check(inset.t1 > inset.t0 && inset.t2 > inset.t1, `both insets committed (${inset.t0}->${inset.t1}->${inset.t2})`);
	h.check(inset.drift < 0.01, `the +X plane did not rigid-drift (moved ${inset.drift.toFixed(4)})`);

	// --- B2: face-mode wireframe overlay + display toggle ---
	const wire = await A.page.evaluate(() => {
		const s = window.__stores;
		const find = () => window.__box.children.find((c) => c.name === 'edit-overlay');
		const present = !!find();
		s.faceEdit.meshEditWireframe.set(false);
		const hidden = find() ? !find().visible : false;
		s.faceEdit.meshEditWireframe.set(true);
		const back = find() ? find().visible : false;
		return { present, hidden, back };
	});
	h.check(wire.present, 'face mode has the wireframe overlay (B2)');
	h.check(wire.hidden && wire.back, `the Wireframe toggle hides/shows it (${JSON.stringify(wire)})`);

	// --- B3: granularity picks — face (2 tris) vs triangle (1) vs shell ---
	// (a FRESH box: the inset test above mutated __box's coplanar groups)
	const gran = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		fe.exitFaceEdit();
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		window.__granBox = grp.children[grp.children.length - 1];
		fe.enterFaceEdit(window.__granBox.uuid);
		const read = () => {
			let sel;
			fe.faceEditSelectedTris.subscribe((v) => (sel = v))();
			return sel.length;
		};
		fe.toggleFaceMulti(); // multi ON
		fe.setFaceGranularity('face');
		fe.toggleFaceSelection(0);
		const facePick = read();
		fe.setFaceGranularity('triangle');
		fe.toggleFaceSelection(0);
		const triPick = read();
		// legacy 'polygon' still lands on triangle
		fe.setFaceGranularity('polygon');
		let g;
		fe.faceEditGranularity.subscribe((v) => (g = v))();
		fe.toggleFaceMulti(); // multi OFF (clears)
		return { facePick, triPick, migrated: g };
	});
	h.check(gran.facePick === 2, `face granularity picks the coplanar pair (${gran.facePick})`);
	h.check(gran.triPick === 1, `triangle granularity picks one tri (${gran.triPick})`);
	h.check(gran.migrated === 'triangle', `legacy 'polygon' migrates to triangle (${gran.migrated})`);

	// --- B4: subdivide grows the target face 4x ---
	const subdiv = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.setFaceGranularity('face');
		// triangleCount handles the fresh box's INDEXED geometry (24 entries)
		const triCount = () => fe.triangleCount(window.__granBox);
		const faces = fe.currentFaces();
		const yi = faces.findIndex((f) => f.normal.y > 0.9);
		const t0 = triCount();
		const target = faces[yi].triIndices.length;
		fe.highlightFaceByTriangle(faces[yi].triIndices[0]);
		const ok = fe.commitFaceOp('subdivide', 0);
		return { ok, t0, t1: triCount(), target };
	});
	h.check(
		subdiv.ok && subdiv.t1 === subdiv.t0 + subdiv.target * 3,
		`subdivide splits each target tri into 4 (${subdiv.t0}+${subdiv.target}*3 -> ${subdiv.t1})`
	);

	// --- B4: flip reverses a face normal ---
	const flip = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		const faces = fe.currentFaces();
		const zi = faces.findIndex((f) => f.normal.z > 0.9);
		fe.highlightFaceByTriangle(faces[zi].triIndices[0]);
		const ok = fe.commitFaceOp('flip', 0);
		const after = fe.currentFaces();
		// the flipped group now reports a -Z normal (same tris, reversed winding)
		const flipped = after.some((f) => f.normal.z < -0.9 && Math.abs(f.centroid.z - 0.5) < 0.01);
		return { ok, flipped };
	});
	h.check(flip.ok && flip.flipped, 'flip reverses the face normal sign');

	// --- B4: bridge the FACING faces of two separated cubes = a watertight
	// connector (bridging a single solid's own opposite faces overlaps its
	// side walls — a degenerate scenario, not a correctness check) ---
	const bridge = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		fe.exitFaceEdit();
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box2 = g.children[g.children.length - 1];
		window.__box2 = box2;
		// one soup, two unit cubes: A at x=0, B at x=3
		const T = s.THREE;
		const cube = (ox) => {
			const geo = new T.BoxGeometry(1, 1, 1).toNonIndexed();
			const arr = Array.from(geo.attributes.position.array);
			geo.dispose();
			for (let i = 0; i < arr.length; i += 3) arr[i] += ox;
			return arr;
		};
		fe.applyMeshGeo(box2.uuid, [...cube(0), ...cube(3)]);
		fe.enterFaceEdit(box2.uuid);
		const faces = fe.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9 && Math.abs(f.centroid.x - 0.5) < 0.01);
		const xn = faces.findIndex((f) => f.normal.x < -0.9 && Math.abs(f.centroid.x - 2.5) < 0.01);
		fe.toggleFaceMulti();
		fe.setFaceGranularity('face');
		fe.toggleFaceSelection(faces[xi].triIndices[0]);
		fe.toggleFaceSelection(faces[xn].triIndices[0]);
		const ok = fe.commitFaceOp('bridge', 0);
		const tris = fe.readTriangles(box2.geometry);
		// watertight check: every edge is shared by exactly two triangles
		const counts = new Map();
		const key = (v) => Math.round(v.x * 1e4) + ',' + Math.round(v.y * 1e4) + ',' + Math.round(v.z * 1e4);
		tris.forEach((t) => {
			for (let e = 0; e < 3; e++) {
				const k = [key(t[e]), key(t[(e + 1) % 3])].sort().join('|');
				counts.set(k, (counts.get(k) || 0) + 1);
			}
		});
		const boundary = [...counts.values()].filter((c) => c !== 2).length;
		fe.toggleFaceMulti();
		fe.exitFaceEdit();
		return { ok, tris: tris.length, boundary };
	});
	h.check(bridge.ok, 'bridge commits on the two facing faces');
	h.check(bridge.tris === 28, `bridge = 24 - 4 caps + 8 wall tris (${bridge.tris})`);
	h.check(bridge.boundary === 0, `the connector is watertight (${bridge.boundary} odd edges)`);

	// --- B3: shell granularity picks a whole disconnected piece ---
	const shell = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		// two separated tetra-ish pieces as one soup: piece A at 0, piece B at +5
		const tri = (ox, i) => {
			const p = [
				[ox, 0, 0, ox + 1, 0, 0, ox, 1, 0],
				[ox, 0, 0, ox, 0, 1, ox + 1, 0, 0],
				[ox, 1, 0, ox + 1, 0, 0, ox, 0, 1]
			];
			return p[i];
		};
		const positions = [...tri(0, 0), ...tri(0, 1), ...tri(0, 2), ...tri(5, 0), ...tri(5, 1)];
		s.faceEdit.applyMeshGeo(window.__box2.uuid, positions);
		fe.enterFaceEdit(window.__box2.uuid);
		fe.toggleFaceMulti();
		fe.setFaceGranularity('shell');
		fe.toggleFaceSelection(3); // a tri of piece B
		let sel;
		fe.faceEditSelectedTris.subscribe((v) => (sel = v))();
		const pieceB = [...sel].sort().join(',');
		fe.toggleFaceMulti();
		fe.setFaceGranularity('face');
		fe.exitFaceEdit();
		return { pieceB };
	});
	h.check(shell.pieceB === '3,4', `shell granularity picks the whole disconnected piece (${shell.pieceB})`);

	// --- OBJECT granularity + "the gizmo drags what the highlight promised" ----
	// The bug: highlight/overlay and the toolbar ops were granularity-aware but the
	// GIZMO drag grabbed `faces[faceEditHighlight]` — a single coplanar face. With
	// Shell picked on a box that read as "whole object lit up, one surface moved,
	// the far vertices stuck". beginFaceGrab now takes the same synthesized target
	// every other op uses, so a shell/object grab moves rigidly.
	const grab = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const THREE = s.THREE;
		// two SEPARATE islands in one mesh: object takes both, shell only the one
		// under the cursor
		const tri = (ox, i) =>
			[
				[ox, 0, 0, ox + 1, 0, 0, ox, 1, 0],
				[ox, 0, 0, ox, 0, 1, ox + 1, 0, 0],
				[ox, 1, 0, ox + 1, 0, 0, ox, 0, 1]
			][i];
		const positions = [...tri(0, 0), ...tri(0, 1), ...tri(0, 2), ...tri(5, 0), ...tri(5, 1)];
		fe.applyMeshGeo(window.__box2.uuid, positions);
		fe.enterFaceEdit(window.__box2.uuid);

		const readY = () => {
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const arr = g.getObjectByProperty('uuid', window.__box2.uuid).geometry.attributes.position
				.array;
			const ys = [];
			for (let i = 1; i < arr.length; i += 3) ys.push(Math.round(arr[i] * 1000) / 1000);
			return ys;
		};
		/** how many vertices moved by ~dy */
		const movedCount = (before, after, dy) =>
			after.filter((y, i) => Math.abs(y - before[i] - dy) < 1e-3).length;
		const drag = (granularity, tri) => {
			fe.setFaceGranularity(granularity);
			fe.highlightFaceByTriangle(tri);
			const before = readY();
			const began = fe.beginFaceGrab(fe.currentTargetFace());
			fe.applyFaceGrab({ dPos: new THREE.Vector3(0, 2, 0) });
			const after = readY();
			fe.cancelFaceGrab();
			return { began, moved: movedCount(before, after, 2), before };
		};

		const shellDrag = drag('shell', 3); // a tri of the FAR island
		const objectDrag = drag('object', 3);
		const faceDrag = drag('face', 0); // the historical default must not change
		fe.setFaceGranularity('face');
		fe.exitFaceEdit();
		return {
			total: faceDrag.before.length,
			began: shellDrag.began && objectDrag.began && faceDrag.began,
			shellMoved: shellDrag.moved,
			objectMoved: objectDrag.moved,
			faceMoved: faceDrag.moved,
			restored: readY().join(',') === faceDrag.before.join(',')
		};
	});
	h.check(grab.began, 'every granularity can begin a gizmo grab');
	h.check(
		grab.shellMoved === 6,
		`a SHELL grab moves its whole island rigidly and nothing else (${grab.shellMoved}/${grab.total} verts)`
	);
	h.check(
		grab.objectMoved === grab.total,
		`an OBJECT grab moves every vertex, across disconnected islands (${grab.objectMoved}/${grab.total})`
	);
	h.check(
		grab.faceMoved > 0 && grab.faceMoved < grab.total,
		`FACE granularity still grabs just its own face (${grab.faceMoved}/${grab.total})`
	);
	h.check(grab.restored, 'cancelling a grab restores the geometry');

	// the same thing through the REAL gizmo path (seat it, then press a handle):
	// the target is stashed at seat time, because when the user grabs a handle the
	// pointer is over the gizmo and the live hover no longer describes the pick
	const gizmoGrab = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const THREE = s.THREE;
		fe.enterFaceEdit(window.__box2.uuid);
		const readY = () => {
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const arr = g.getObjectByProperty('uuid', window.__box2.uuid).geometry.attributes.position
				.array;
			const ys = [];
			for (let i = 1; i < arr.length; i += 3) ys.push(arr[i]);
			return ys;
		};
		fe.setFaceGranularity('shell');
		fe.highlightFaceByTriangle(3); // a tri of the far island
		fe.attachFaceGizmo();
		const before = readY();
		// the pointer now sits on the gizmo, so the hover is stale/cleared —
		// the seated target must still be the shell
		fe.highlightFaceByTriangle(-1);
		fe.onFaceGizmoDragChanged(true);
		fe.applyFaceGrab({ dPos: new THREE.Vector3(0, 3, 0) });
		const after = readY();
		fe.cancelFaceGrab();
		fe.setFaceGranularity('face');
		fe.exitFaceEdit();
		return { moved: after.filter((y, i) => Math.abs(y - before[i] - 3) < 1e-3).length };
	});
	h.check(
		gizmoGrab.moved === 6,
		`the seated GIZMO drags the whole shell even after the hover clears (${gizmoGrab.moved} verts)`
	);

	// --- B4: weld merges the vertex multi-selection ---
	const weld = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		const me = s.meshEdit;
		s.faceEdit.exitFaceEdit();
		me.enterEditMode(uuid);
		const weldedKeys = () => {
			const p = window.__box.geometry.attributes.position;
			const set = new Set();
			for (let i = 0; i < p.count; i++)
				set.add(Math.round(p.getX(i) * 1e4) + ',' + Math.round(p.getY(i) * 1e4) + ',' + Math.round(p.getZ(i) * 1e4));
			return set.size;
		};
		const k0 = weldedKeys();
		me.toggleVertexSelection(0);
		me.toggleVertexSelection(1);
		me.toggleVertexSelection(2);
		const ok = me.weldSelectedVerts();
		const k1 = weldedKeys();
		me.exitEditMode();
		const undoable = (() => {
			s.history.undo();
			return weldedKeys() === k0;
		})();
		return { ok, k0, k1, undoable };
	}, uuid);
	h.check(weld.ok && weld.k1 === weld.k0 - 2, `weld merges 3 welded keys into 1 (${weld.k0} -> ${weld.k1})`);
	h.check(weld.undoable, 'weld is undoable (one meshgeo entry)');

	// --- D1 (15): weld on a FRESH box — INDEXED geometry. The old snapshot took
	// the raw position attribute (24 triples) which applyMeshGeo reinterpreted as
	// 8 arbitrary triangles: the weld mangled the mesh and undo replayed the same
	// wrong representation. (The block above only passed because ITS box was
	// de-indexed by the earlier inset commits.) Also covers the vertex-session
	// refresh hook: undo while STILL editing rebuilds the handles.
	const weldIndexed = await A.page.evaluate(() => {
		const s = window.__stores;
		const me = s.meshEdit;
		const fe = s.faceEdit;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		const uuid = box.uuid;
		const live = () => g.getObjectByProperty('uuid', uuid);
		const indexed = !!box.geometry.index;
		const tris = () => fe.readTriangles(live().geometry).length;
		const keys = () => {
			const p = live().geometry.attributes.position;
			const set = new Set();
			for (let i = 0; i < p.count; i++)
				set.add(Math.round(p.getX(i) * 1e4) + ',' + Math.round(p.getY(i) * 1e4) + ',' + Math.round(p.getZ(i) * 1e4));
			return set.size;
		};
		const t0 = tris(); // 12
		const k0 = keys(); // 8
		me.enterEditMode(uuid);
		me.toggleVertexSelection(0);
		me.toggleVertexSelection(1);
		const ok = me.weldSelectedVerts();
		const t1 = tris();
		const k1 = keys();
		let nan = false;
		const arr = live().geometry.attributes.position.array;
		for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) nan = true;
		// undo while STILL in vertex mode: the D1 refresh hook rebuilds the handles
		s.history.undo();
		// the meshEdit refresh sits behind applyMeshGeo's dynamic import — allow a tick
		return new Promise((resolve) =>
			setTimeout(() => {
				const t2 = tris();
				const k2 = keys();
				let editing;
				me.editingObject.subscribe((v) => (editing = v))();
				const handleCount = me.vertexHandleMesh() ? me.vertexHandleMesh().count : -1;
				me.exitEditMode();
				resolve({ indexed, ok, t0, k0, t1, k1, nan, t2, k2, handleCount, stillEditing: editing === uuid });
			}, 400)
		);
	});
	h.check(weldIndexed.indexed, 'the fresh box is INDEXED (the D1 repro precondition)');
	h.check(
		weldIndexed.ok && weldIndexed.t1 === 12,
		`weld on the indexed box keeps 12 triangles (${weldIndexed.t1})`
	);
	h.check(
		weldIndexed.k1 === weldIndexed.k0 - 1,
		`welding 2 verts drops exactly one welded key (${weldIndexed.k0} -> ${weldIndexed.k1})`
	);
	h.check(!weldIndexed.nan, 'no NaN in the welded geometry');
	h.check(
		weldIndexed.t2 === weldIndexed.t0 && weldIndexed.k2 === weldIndexed.k0,
		`undo restores exactly (${weldIndexed.t2} tris, ${weldIndexed.k2} welded keys)`
	);
	h.check(weldIndexed.stillEditing, 'the vertex session survives the undo (no exit/enter)');
	h.check(
		weldIndexed.handleCount === weldIndexed.k2,
		`the refresh hook rebuilt the handles to match (${weldIndexed.handleCount} handles for ${weldIndexed.k2} welded keys)`
	);

	await h.finish(browser);
});
