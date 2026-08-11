// M4 completion: the EDGE GIZMO. Edges could be selected, looped, ringed and dissolved
// but never DRAGGED — attachFaceGizmo bailed out of edge mode entirely, because falling
// through to opTargetFace would have moved whatever faces were picked before the switch.
//
// An edge move is the degenerate case of a face grab: no triangle moves rigidly, and the
// welded vertex groups of the edge's endpoints ride the neighbour path that already
// exists for face grabs. So the checks here are mostly about the SHAPE of the result —
// the edge moved, its welded neighbours stretched with it, the triangle count did not
// change, and the topology (P9) survived because of that.
const h = require('./helpers.cjs');

const editBox = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		s.faceEdit.enterFaceEdit(window.__box.uuid);
		s.faceEdit.setFaceSubmode('edges');
		return window.__box.uuid;
	});

/** pick a real (non-diagonal) edge of the top face and return its key + endpoints */
const pickTopEdge = (page) =>
	page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		const tris = fe.readTriangles(window.__box.geometry);
		for (let ti = 0; ti < tris.length; ti++) {
			const t = tris[ti];
			if (!t.every((v) => v.y > 0.49)) continue;
			const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
			for (let e = 0; e < 3; e++) {
				const mid = t[e].clone().add(t[(e + 1) % 3]).multiplyScalar(0.5);
				const key = fe.pickEdgeAt(ti, c.clone().lerp(mid, 0.95));
				if (!key) continue;
				fe.pickEdge(key, false);
				if (fe.edgeSelectionSize() === 1) return { key, ti };
			}
		}
		return null;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await editBox(A.page);
	const picked = await pickTopEdge(A.page);
	h.check(!!picked, 'picked a single real edge on the top face (premise)');

	// --- the gizmo seats on the EDGE, with an edge-shaped basis ---------------
	const seat = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const THREE = s.THREE;
		fe.setFaceOp('move');
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		const proxy = controls?.object;
		const target = fe.edgeGrabTarget();
		if (!proxy || !target) return { missing: true };
		// the proxy sits at the selection centroid in WORLD space
		window.__box.updateMatrixWorld(true);
		const expect = window.__box.localToWorld(target.centroid.clone());
		// gizmo X must run ALONG the edge
		const along = new THREE.Vector3(1, 0, 0).applyQuaternion(proxy.quaternion);
		const edgeDir = target.direction.clone().transformDirection(window.__box.matrixWorld).normalize();
		return {
			isProxy: proxy.userData?.isFaceProxy === true,
			distance: proxy.position.distanceTo(expect),
			alongDot: Math.abs(along.dot(edgeDir)),
			keys: target.vertexKeys.size,
			tris: target.triIndices.length
		};
	});
	h.check(!seat.missing && seat.isProxy, 'arming Move in edge mode seats the gizmo proxy');
	h.check(seat.distance < 1e-6, `...on the edge selection's centroid (off by ${seat.distance})`);
	h.check(seat.alongDot > 0.999, `...with X running ALONG the edge (dot ${seat.alongDot.toFixed(4)})`);
	h.check(
		seat.keys === 2 && seat.tris === 0,
		'the edge target names VERTEX KEYS and no triangles — the grab moves verts, not faces'
	);

	// --- dragging it moves the edge, stretches neighbours, keeps the count ----
	const drag = await A.page.evaluate((key) => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const THREE = s.THREE;
		const ends = () => {
			const parts = key.split('|');
			const tris = fe.readTriangles(window.__box.geometry);
			const found = [];
			for (const part of parts) {
				const [x, y, z] = part.split(',').map(Number);
				found.push(new THREE.Vector3(x / 1e4, y / 1e4, z / 1e4));
			}
			return { parts, tris };
		};
		const before = ends();
		const triCount = () => fe.readTriangles(window.__box.geometry).length;
		const trisBefore = triCount();
		const target = fe.edgeGrabTarget();
		const keys = new Set(target.vertexKeys);
		const keyOf = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e4)).join(',');
		// how many corners sit on the edge, and where the far corners of the touching
		// triangles are (they must NOT move — that is what "stretch, not translate" means)
		const cornersOn = [];
		const farCorners = [];
		before.tris.forEach((t, ti) =>
			t.forEach((v, c) => {
				if (keys.has(keyOf(v))) cornersOn.push({ ti, c, y: v.y });
				else farCorners.push({ ti, c, y: v.y });
			})
		);
		// drive the gizmo exactly as TransformControls does: move the proxy, fire the
		// change hooks
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		const proxy = controls.object;
		fe.onFaceGizmoDragChanged(true);
		proxy.position.y += 0.5;
		fe.onFaceGizmoMoved();
		const committed = fe.commitFaceGrab();
		const after = fe.readTriangles(window.__box.geometry);
		let movedUp = 0;
		let farMoved = 0;
		for (const corner of cornersOn)
			if (Math.abs(after[corner.ti][corner.c].y - (corner.y + 0.5)) < 1e-5) movedUp++;
		for (const corner of farCorners)
			if (Math.abs(after[corner.ti][corner.c].y - corner.y) > 1e-5) farMoved++;
		return {
			committed,
			cornersOn: cornersOn.length,
			movedUp,
			farMoved,
			trisBefore,
			trisAfter: after.length,
			stored: !!s.meshTopology.readStoredFaces(window.__box.geometry)
		};
	}, picked.key);
	h.check(drag.committed, 'the edge drag committed one meshgeo (premise)');
	h.check(drag.cornersOn >= 2, `the edge's welded corner set is real (${drag.cornersOn} corners)`);
	h.check(
		drag.movedUp === drag.cornersOn,
		`every welded corner on the edge moved with it (${drag.movedUp}/${drag.cornersOn})`
	);
	h.check(drag.farMoved === 0, 'the far corners of the touching triangles stayed put — the mesh STRETCHED');
	h.check(
		drag.trisAfter === drag.trisBefore,
		`the triangle count did not change (${drag.trisBefore} -> ${drag.trisAfter})`
	);
	h.check(drag.stored, 'the move carried the stored topology (count unchanged, so it must)');

	// --- undo restores it, and switching to faces detaches ------------------
	const rest = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const maxY = () => {
			let m = -1e9;
			for (const t of fe.readTriangles(window.__box.geometry)) for (const v of t) m = Math.max(m, v.y);
			return m;
		};
		const lifted = maxY();
		s.history.undo();
		const undone = maxY();
		s.history.redo();
		const redone = maxY();
		// no selection -> no gizmo (it must not linger on a stale centroid)
		fe.clearEdgeSelection();
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		const afterClear = controls?.object?.userData?.isFaceProxy === true;
		return { lifted, undone, redone, afterClear };
	});
	h.check(rest.lifted > 0.9, `the drag actually lifted the edge (max y ${rest.lifted.toFixed(3)})`);
	h.check(rest.undone < rest.lifted - 0.4, `undo put it back (max y ${rest.undone.toFixed(3)})`);
	h.check(Math.abs(rest.redone - rest.lifted) < 1e-6, 'redo returns the exact same geometry');
	h.check(!rest.afterClear, 'clearing the edge selection DETACHES the gizmo');

	// --- and the peer sees it ------------------------------------------------
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const netUuid = await editBox(A.page);
	const netEdge = await pickTopEdge(A.page);
	h.check(!!netEdge, 'picked an edge on the replicated box (premise)');
	const maxYOn = (page, uuid) =>
		page.evaluate((uuid) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const object = g.getObjectByProperty('uuid', uuid);
			const position = object?.geometry?.attributes?.position;
			if (!position) return null;
			let m = -1e9;
			for (let i = 0; i < position.count; i++) m = Math.max(m, position.getY(i));
			return m;
		}, uuid);
	await h.eventually(
		() => maxYOn(B.page, netUuid),
		(y) => y !== null && Math.abs(y - 0.5) < 1e-3,
		'B received the box (premise)',
		20000
	);
	await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		fe.setFaceOp('move');
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		fe.onFaceGizmoDragChanged(true);
		controls.object.position.y += 0.6;
		fe.onFaceGizmoMoved();
		fe.commitFaceGrab();
	});
	await h.eventually(
		() => maxYOn(B.page, netUuid),
		(y) => y !== null && y > 1.0,
		'B receives the edge move over the wire',
		20000
	);

	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit?.());
	await h.finish(browser);
});
