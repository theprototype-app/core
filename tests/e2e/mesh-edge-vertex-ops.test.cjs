// 19-A P5a: the four spec-tight new operators.
//
//   DELETE EDGES     — remove every face on both sides of the picked edges
//   DELETE VERTICES  — remove every face that uses a picked vertex
//   TRIANGULATE      — one stored face per triangle, positions untouched
//   TRIS TO QUADS    — store the pairQuads pairing, positions untouched
//
// The first two make HOLES by design, so nothing here asks for watertightness —
// what is asserted is the exact triangle count that goes (derived in-test from
// the welded map, never hardcoded), that undo restores the soup byte for byte,
// and that a peer ends up with the same mesh.
//
// The last two touch ONLY the stored partition, which is the interesting case:
// their history entries must write `faces` on BOTH sides. An absent `faces`
// means "carry the current partition", and since the positions do not change
// here the carry ALWAYS succeeds — so an implicit BEFORE would restore the
// partition the op just wrote, and the change would be silently un-undoable.
// The two undo checks below are exactly the ones that fail if that rule is
// broken, which is what makes them worth their line count.
const h = require('./helpers.cjs');

/** the mesh as a canonical string — the comparison for "undo restored the soup" */
const soup = (page, uuid) =>
	page.evaluate((uuid) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		const tris = s.faceEdit.readTriangles(object.geometry);
		return s.faceEdit
			.trisToPositions(tris)
			.map((n) => n.toFixed(4))
			.join(',');
	}, uuid);

const triCount = (page, uuid) =>
	page.evaluate((uuid) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		return object ? s.meshTopology.triangleCountOf(object.geometry) : -1;
	}, uuid);

/** the stored partition with a per-face size histogram, or null */
const stored = (page, uuid) =>
	page.evaluate((uuid) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		const faces = s.meshTopology.readStoredFaces(object.geometry);
		if (!faces) return null;
		return {
			count: faces.length,
			singles: faces.filter((f) => f.length === 1).length,
			pairs: faces.filter((f) => f.length === 2).length,
			valid: s.meshTopology.facesValidFor(faces, s.meshTopology.triangleCountOf(object.geometry))
		};
	}, uuid);

const wireOf = (page, uuid) =>
	page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		let n = 0;
		g.getObjectByProperty('uuid', uuid)?.traverse((o) => {
			if (o.name === 'edit-overlay') n = o.geometry.attributes.position.count / 2;
		});
		return n;
	}, uuid);

const freshBox = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		s.faceEdit.exitFaceEdit?.();
		s.meshEdit.exitEditMode?.();
		s.commandsHandler.sceneCommand('/clear all');
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		return g.children[g.children.length - 1].uuid;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ====================================================== 1. DELETE EDGES
	let uuid = await freshBox(A.page);
	const picked = await A.page.evaluate((uuid) => {
		const fe = window.__stores.faceEdit;
		fe.enterFaceEdit(uuid);
		fe.faceEditSubmode.set('edges');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const geo = g.getObjectByProperty('uuid', uuid).geometry;
		const tris = fe.readTriangles(geo);
		// pickEdgeAt SKIPS the quad diagonal, so probing toward triangle 0's first
		// edge midpoint yields a REAL edge of the model, whichever one that is
		const t = tris[0];
		const centroid = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
		const mid = t[0].clone().add(t[1]).multiplyScalar(0.5);
		const key = fe.pickEdgeAt(0, centroid.clone().lerp(mid, 0.95));
		// how many triangles USE that welded edge? derived here, never assumed
		const keyOf = (v) =>
			`${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
		const edgeKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
		let incident = 0;
		for (const tri of tris) {
			for (let e = 0; e < 3; e++)
				if (edgeKey(keyOf(tri[e]), keyOf(tri[(e + 1) % 3])) === key) {
					incident++;
					break;
				}
		}
		fe.pickEdge(key);
		return { key, incident };
	}, uuid);
	h.check(!!picked.key, 'a real (non-diagonal) box edge is picked: ' + picked.key);
	h.check(picked.incident === 2, `...used by ${picked.incident} triangles (a box edge joins two)`);

	const beforeSoup = await soup(A.page, uuid);
	const beforeTris = await triCount(A.page, uuid);
	const deleted = await A.page.evaluate(() => window.__stores.faceEdit.deleteSelectedEdges());
	const afterTris = await triCount(A.page, uuid);
	const selAfter = await A.page.evaluate(
		() =>
			new Promise((r) => window.__stores.faceEdit.edgeEditSelected.subscribe((v) => r(v.length))())
	);
	h.check(deleted === true, 'Delete edges commits');
	h.check(
		afterTris === beforeTris - picked.incident,
		`exactly the edge's ${picked.incident} incident triangles went (${beforeTris} -> ${afterTris})`
	);
	h.check(selAfter === 0, '...and the edge selection is cleared by the op itself');
	h.check(
		(await stored(A.page, uuid)).valid === true,
		'...leaving a partition that still covers the mesh'
	);

	await A.page.evaluate(() => window.__stores.history.undo());
	h.check((await triCount(A.page, uuid)) === beforeTris, 'ONE undo brings the faces back');
	h.check((await soup(A.page, uuid)) === beforeSoup, '...restoring the exact triangle soup');

	// refusals: nothing picked, and a pick that would take the whole mesh
	const refusals = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.clearEdgeSelection();
		const empty = fe.deleteSelectedEdges();
		fe.selectAllEdges();
		const everything = fe.deleteSelectedEdges();
		fe.clearEdgeSelection();
		return { empty, everything };
	});
	h.check(refusals.empty === false, 'delete with nothing picked refuses (toast, no commit)');
	h.check(refusals.everything === false, 'deleting EVERY edge refuses rather than emptying the mesh');
	h.check(
		(await triCount(A.page, uuid)) === beforeTris,
		'...and the mesh is untouched by either refusal'
	);

	// =================================================== 2. DELETE VERTICES
	uuid = await freshBox(A.page);
	const corner = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		s.meshEdit.enterEditMode(uuid);
		s.meshEdit.selectHandle(0);
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		const world = s.meshEdit.vertexSelectionWorldPoint();
		const local = object.worldToLocal(world.clone());
		const keyOf = (v) =>
			`${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
		const key = keyOf(local);
		// the corner's incident triangles, derived from the welded map
		const tris = s.faceEdit.readTriangles(object.geometry);
		let incident = 0;
		for (const t of tris) if (t.some((v) => keyOf(v) === key)) incident++;
		let size = 0;
		s.meshEdit.vertexSelectionSize.subscribe((v) => (size = v))();
		return { key, incident, size, tris: tris.length };
	}, uuid);
	h.check(corner.size === 1, 'a plain click selects exactly one vertex handle');
	h.check(
		corner.incident > 0 && corner.incident < corner.tris,
		`the picked corner is used by ${corner.incident} of ${corner.tris} triangles (derived)`
	);

	const vBeforeSoup = await soup(A.page, uuid);
	const vDeleted = await A.page.evaluate(() => window.__stores.meshEdit.deleteSelectedVerts());
	const vAfter = await triCount(A.page, uuid);
	const vSel = await A.page.evaluate(
		() => new Promise((r) => window.__stores.meshEdit.vertexSelectionSize.subscribe((v) => r(v))())
	);
	h.check(vDeleted === true, 'Delete vertices commits');
	h.check(
		vAfter === corner.tris - corner.incident,
		`exactly the corner's ${corner.incident} faces went (${corner.tris} -> ${vAfter})`
	);
	h.check(vSel === 0, '...and the stale vertex selection is dropped');

	await A.page.evaluate(() => window.__stores.history.undo());
	h.check((await triCount(A.page, uuid)) === corner.tris, 'ONE undo brings them back');
	h.check((await soup(A.page, uuid)) === vBeforeSoup, '...restoring the exact triangle soup');

	const vRefusals = await A.page.evaluate(() => {
		const me = window.__stores.meshEdit;
		me.clearVertexSelection();
		const empty = me.deleteSelectedVerts();
		me.selectAllVerts();
		const everything = me.deleteSelectedVerts();
		me.clearVertexSelection();
		return { empty, everything };
	});
	h.check(vRefusals.empty === false, 'delete with no vertex picked refuses');
	h.check(
		vRefusals.everything === false,
		'deleting EVERY vertex refuses rather than emptying the mesh'
	);
	h.check(
		(await triCount(A.page, uuid)) === corner.tris,
		'...and the mesh is untouched by either refusal'
	);
	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());

	// ====================================================== 3. TRIANGULATE
	uuid = await freshBox(A.page);
	await A.page.evaluate((uuid) => {
		const fe = window.__stores.faceEdit;
		fe.meshEditTriWire.set(false); // the QUAD view — the default
		fe.enterFaceEdit(uuid);
	}, uuid);
	const quadWire = await wireOf(A.page, uuid);
	h.check(quadWire === 12, `premise: the quad wire draws the box's 12 real edges (${quadWire})`);

	const triSoup = await soup(A.page, uuid);
	const triangulated = await A.page.evaluate(() => window.__stores.faceEdit.triangulateMesh());
	const triStored = await stored(A.page, uuid);
	const triWire = await wireOf(A.page, uuid);
	h.check(triangulated === true, 'Triangulate commits');
	h.check(
		(await soup(A.page, uuid)) === triSoup,
		'positions are IDENTICAL — this op only rewrites the topology'
	);
	h.check(
		triStored.count === 12 && triStored.singles === 12,
		`the stored partition is one singleton per triangle (${triStored.count} faces, ${triStored.singles} singletons)`
	);
	h.check(triStored.valid === true, '...and it validates against the mesh');
	h.check(
		triWire === 18,
		`the structure wire now shows all 18 edges — no face hides a diagonal (${triWire})`
	);
	h.check(
		(await A.page.evaluate(() => window.__stores.faceEdit.triangulateMesh())) === false,
		'running it again reports "already one face per triangle" instead of re-committing'
	);

	// THE both-sides-explicit check. The positions never changed, so a carry-over
	// would succeed and hand back the SINGLETONS: this can only pass if the entry's
	// BEFORE side wrote the quad partition explicitly.
	await A.page.evaluate(() => window.__stores.history.undo());
	const undone = await stored(A.page, uuid);
	const undoneWire = await wireOf(A.page, uuid);
	h.check(
		!!undone && undone.count === 6 && undone.pairs === 6,
		`UNDO RESTORES THE QUAD PARTITION: 6 quads (got ${undone && undone.count} faces, ${undone && undone.pairs} pairs)`
	);
	h.check(undoneWire === 12, '...and the structure wire is back to 12 edges');
	await A.page.evaluate(() => window.__stores.history.redo());
	h.check((await stored(A.page, uuid)).singles === 12, 'redo re-applies the singleton partition');

	// ==================================================== 4. TRIS TO QUADS
	// the mesh is triangulated right now — pair it back up
	const quadSoup = await soup(A.page, uuid);
	const quadified = await A.page.evaluate(() => window.__stores.faceEdit.trisToQuadsMesh());
	const quadStored = await stored(A.page, uuid);
	h.check(quadified === true, 'Tris to quads commits');
	h.check((await soup(A.page, uuid)) === quadSoup, 'positions are IDENTICAL here too');
	h.check(
		quadStored.count === 6 && quadStored.pairs === 6,
		`the 12 triangles pair back into 6 quads (${quadStored.count} faces, ${quadStored.pairs} pairs)`
	);
	h.check(quadStored.valid === true, '...and that partition validates too');
	h.check(
		(await A.page.evaluate(() => window.__stores.faceEdit.trisToQuadsMesh())) === false,
		'running it again reports "already paired" instead of re-committing'
	);

	await A.page.evaluate(() => window.__stores.history.undo());
	const backToSingles = await stored(A.page, uuid);
	h.check(
		!!backToSingles && backToSingles.singles === 12,
		`undo restores the SINGLETON partition (got ${backToSingles && backToSingles.singles} singletons)`
	);
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());

	// ===================================================== 5. the toolbox UI
	uuid = await freshBox(A.page);
	await A.page.evaluate((uuid) => {
		const fe = window.__stores.faceEdit;
		fe.enterFaceEdit(uuid);
		fe.faceEditSubmode.set('edges');
	}, uuid);
	await A.page.waitForTimeout(400);
	const edgeBtn = A.page.locator('#edge-delete');
	h.check((await edgeBtn.count()) === 1, 'the edges Tools row has a Delete button (#edge-delete)');
	h.check(
		((await edgeBtn.getAttribute('class')) || '').includes('tbx-danger'),
		'...styled as a danger action'
	);

	// Cleanup starts collapsed, so open it first
	await A.page.evaluate(() => document.querySelector('#mesh-sec-cleanup').click());
	await A.page.waitForTimeout(300);
	const cleanup = await A.page.evaluate(() => {
		const head = document.querySelector('#mesh-sec-cleanup');
		const next = document.querySelector('#mesh-sec-symmetry');
		const tri = document.querySelector('#mesh-fix-triangulate');
		const quads = document.querySelector('#mesh-fix-quads');
		const before = (a, b) =>
			!!a && !!b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
		return {
			tri: !!tri,
			quads: !!quads,
			// the section renders NO wrapper element (its rows must stay grid children),
			// so "inside the section" is a DOM ORDER question: after its own header and
			// before the next section's
			inSection: before(head, tri) && before(head, quads) && before(tri, next) && before(quads, next),
			siblings:
				!!document.querySelector('#mesh-fix-normals') &&
				!!document.querySelector('#mesh-fix-merge')
		};
	});
	h.check(cleanup.tri && cleanup.quads, 'Cleanup gained #mesh-fix-triangulate and #mesh-fix-quads');
	h.check(cleanup.inSection, '...both between the Cleanup header and the next section');
	h.check(cleanup.siblings, '...beside the existing Recalculate normals / Merge by distance');

	await A.page.evaluate((uuid) => {
		window.__stores.faceEdit.exitFaceEdit();
		window.__stores.meshEdit.enterEditMode(uuid);
	}, uuid);
	await A.page.waitForTimeout(400);
	const vertBtn = A.page.locator('#mesh-delete-verts');
	h.check(
		(await vertBtn.count()) === 1,
		'the vertices Tools row has a Delete button (#mesh-delete-verts)'
	);
	const vertClass = (await vertBtn.getAttribute('class')) || '';
	h.check(vertClass.includes('tbx-danger'), '...styled as a danger action');
	h.check(vertClass.includes('tbx-disabled'), '...and reads disabled with nothing selected');
	await A.page.evaluate(() => window.__stores.meshEdit.selectHandle(0));
	await A.page.waitForTimeout(200);
	h.check(
		!((await vertBtn.getAttribute('class')) || '').includes('tbx-disabled'),
		'...and enabled once a vertex is picked'
	);
	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());

	// ================================================= 6. a peer sees the hole
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const netUuid = await freshBox(A.page);
	await h.eventually(
		() => triCount(B.page, netUuid),
		(n) => n === 12,
		'B received the box (premise)',
		20000
	);
	await A.page.evaluate((uuid) => {
		const fe = window.__stores.faceEdit;
		fe.enterFaceEdit(uuid);
		fe.faceEditSubmode.set('edges');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const tris = fe.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
		const t = tris[0];
		const centroid = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
		const mid = t[0].clone().add(t[1]).multiplyScalar(0.5);
		fe.pickEdge(fe.pickEdgeAt(0, centroid.clone().lerp(mid, 0.95)));
		fe.deleteSelectedEdges();
	}, netUuid);
	const mineTris = await triCount(A.page, netUuid);
	h.check(mineTris === 10, `A deleted the edge's two faces while connected (${mineTris} left)`);
	await h.eventually(
		() => triCount(B.page, netUuid),
		(n) => n === mineTris,
		`B ends up with the same triangle count (${mineTris})`,
		20000
	);
	h.check(
		(await soup(B.page, netUuid)) === (await soup(A.page, netUuid)),
		'...and byte-for-byte the same mesh'
	);
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());

	await h.finish(browser);
});
