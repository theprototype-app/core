// M5b VERTEX BEVEL: cut the corner off, cap the hole.
//
// This is the corner surgery an EDGE bevel also needs, so the checks are about the thing
// that made the first edge-bevel attempt unshippable: WATERTIGHTNESS. Every face around the
// corner has to hand back two vertices in the old one's place, or the mesh cracks along the
// edges those faces shared. A box corner (3 faces) is the smallest case that can go wrong,
// and multi-select on adjacent corners is where the width clamp earns its keep.
const h = require('./helpers.cjs');

const editBox = (page, size = 2) =>
	page.evaluate((size) => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand(`/create Box ${size} ${size} ${size}`);
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		s.meshEdit.enterEditMode(window.__box.uuid);
		return window.__box.uuid;
	}, size);

/** non-manifold edge count: 0 = watertight */
const oddEdges = (page) =>
	page.evaluate(() => {
		const tris = window.__stores.faceEdit.readTriangles(window.__box.geometry);
		const keyOf = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e4)).join(',');
		const counts = new Map();
		for (const t of tris) {
			const keys = t.map(keyOf);
			for (let e = 0; e < 3; e++) {
				const [a, b] = [keys[e], keys[(e + 1) % 3]].sort();
				counts.set(a + '|' + b, (counts.get(a + '|' + b) ?? 0) + 1);
			}
		}
		return [...counts.values()].filter((n) => n !== 2).length;
	});

/**
 * Select the handles at these local points. The search has to run FIRST and the selection
 * SECOND: probing with `selectHandle` replaces the selection on every step, so searching
 * and building at the same time destroys what it just built (this suite did exactly that).
 */
const selectAt = (page, points) =>
	page.evaluate((points) => {
		const s = window.__stores;
		const me = s.meshEdit;
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-6);
		/** @type {number[]} */
		const indices = [];
		for (const point of points) {
			for (let i = 0; i < 32; i++) {
				me.selectHandle(i);
				const at = controls.object?.position;
				if (!at) break;
				if (near([at.x, at.y, at.z], point)) {
					indices.push(i);
					break;
				}
			}
		}
		me.clearVertexSelection();
		indices.forEach((index, k) => (k === 0 ? me.selectHandle(index) : me.toggleVertexSelection(index)));
		let size;
		me.vertexSelectionSize.subscribe((v) => (size = v))();
		return { found: indices.length, size };
	}, points);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- ONE corner of a box ------------------------------------------------
	await editBox(A.page);
	const clean = await oddEdges(A.page);
	h.check(clean === 0, `the box starts watertight (${clean} odd edges)`);
	const one = await selectAt(A.page, [[1, 1, 1]]);
	h.check(one.found === 1 && one.size === 1, 'selected the (1,1,1) corner (premise)');
	const bevelled = await A.page.evaluate(() => {
		const s = window.__stores;
		const me = s.meshEdit;
		const fe = s.faceEdit;
		const before = fe.readTriangles(window.__box.geometry).length;
		const ok = me.bevelSelectedVerts(0.4, 0);
		const tris = fe.readTriangles(window.__box.geometry);
		const keyOf = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e4)).join(',');
		const corners = tris.flat().filter((v) => keyOf(v) === '10000,10000,10000').length;
		// the three offset points sit 0.4 along each edge from the old corner
		const offsets = [
			[0.6, 1, 1],
			[1, 0.6, 1],
			[1, 1, 0.6]
		];
		const present = offsets.map(
			(point) => tris.flat().filter((v) => point.every((c, k) => Math.abs([v.x, v.y, v.z][k] - c) < 1e-6)).length
		);
		const stored = s.meshTopology.readStoredFaces(window.__box.geometry);
		const capFace = (stored ?? []).find((face) =>
			face.every((ti) =>
				tris[ti].every((v) => offsets.some((p) => p.every((c, k) => Math.abs([v.x, v.y, v.z][k] - c) < 1e-6)))
			)
		);
		return { ok, before, after: tris.length, corners, present, capFace: capFace?.length ?? 0 };
	});
	h.check(bevelled.ok, 'the vertex bevel committed');
	h.check(bevelled.corners === 0, 'the old corner vertex is GONE — the corner was really cut off');
	h.check(
		bevelled.present.every((n) => n >= 2),
		`each of the three edges got its offset point, shared by both faces meeting there (${JSON.stringify(bevelled.present)})`
	);
	const oddOne = await oddEdges(A.page);
	h.check(
		oddOne === 0,
		`STILL WATERTIGHT (${oddOne} odd edges) — this is what the edge-bevel attempt could not do`
	);
	h.check(bevelled.after > bevelled.before, `the cap and the rebuilt faces arrived (${bevelled.before} -> ${bevelled.after})`);
	h.check(bevelled.capFace >= 1, `the cap is stored as ONE face, not loose triangles (${bevelled.capFace} triangles)`);

	// --- undo is one step ---------------------------------------------------
	const undo = await A.page.evaluate(() => {
		const s = window.__stores;
		const count = () => s.faceEdit.readTriangles(window.__box.geometry).length;
		const after = count();
		s.history.undo();
		const undone = count();
		s.history.redo();
		return { after, undone, redone: count() };
	});
	h.check(undo.undone === 12, `ONE undo restores the plain box (${undo.after} -> ${undo.undone})`);
	h.check(undo.redone === undo.after, 'redo puts the bevel back');

	// --- MULTI-select, including two ends of the same edge -------------------
	await editBox(A.page);
	const multi = await selectAt(A.page, [
		[1, 1, 1],
		[-1, 1, 1],
		[1, -1, 1]
	]);
	h.check(multi.found === 3 && multi.size === 3, `selected three corners (${multi.size})`);
	const many = await A.page.evaluate(() => {
		const s = window.__stores;
		// 0.9 would reach past the middle of the 2-unit edge between the first two corners;
		// the clamp (0.45 of each edge) must keep the two bevels from crossing
		const ok = s.meshEdit.bevelSelectedVerts(0.9, 0);
		const tris = s.faceEdit.readTriangles(window.__box.geometry);
		const keyOf = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e4)).join(',');
		const gone = ['10000,10000,10000', '-10000,10000,10000', '10000,-10000,10000'].map(
			(key) => tris.flat().filter((v) => keyOf(v) === key).length
		);
		// nothing may pass the midpoint of the shared edge (x = 0 for the first pair)
		let crossed = 0;
		for (const t of tris) for (const v of t) if (v.x < -1.001 || v.x > 1.001) crossed++;
		return { ok, gone, crossed, tris: tris.length };
	});
	h.check(many.ok, 'bevelling three corners at once committed');
	h.check(
		many.gone.every((n) => n === 0),
		`all three corners were cut (${JSON.stringify(many.gone)} left)`
	);
	h.check(many.crossed === 0, 'the width CLAMP kept two bevels on one edge from crossing');
	const oddMany = await oddEdges(A.page);
	h.check(oddMany === 0, `three corners at once stays watertight (${oddMany} odd edges)`);

	// --- profile: in / flat / out -------------------------------------------
	// The cap RING (the offset points) is the same at every profile — it is the APEX that
	// moves, out for a dome and in for a dish. Measuring the mesh's furthest reach only sees
	// the dome; the dish needs a look INSIDE the corner region, where a flat cap has nothing.
	const profiles = await A.page.evaluate(() => {
		const s = window.__stores;
		const me = s.meshEdit;
		const fe = s.faceEdit;
		const reachOf = (v) => (v.x + v.y + v.z) / Math.sqrt(3);
		const run = (profile) => {
			s.commandsHandler.sceneCommand('/create Box 2 2 2');
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			window.__box = g.children[g.children.length - 1];
			me.exitEditMode();
			me.enterEditMode(window.__box.uuid);
			let controls;
			s.TControls.subscribe((c) => (controls = c))();
			for (let i = 0; i < 32; i++) {
				me.selectHandle(i);
				const at = controls.object?.position;
				if (at && Math.abs(at.x - 1) < 1e-6 && Math.abs(at.y - 1) < 1e-6 && Math.abs(at.z - 1) < 1e-6)
					break;
			}
			me.bevelSelectedVerts(0.4, profile);
			const verts = fe.readTriangles(window.__box.geometry).flat();
			// the cap ring sits at reach 1.501 for width 0.4; anything in the corner region
			// (all coordinates well positive) below that is a DISHED apex, above it a DOME
			const inCorner = verts.filter((v) => v.x > 0.35 && v.y > 0.35 && v.z > 0.35);
			return {
				maxReach: Math.max(...verts.map(reachOf)),
				pulledIn: inCorner.filter((v) => reachOf(v) < 1.45).length
			};
		};
		return { flat: run(0), domed: run(1), dished: run(-1) };
	});
	h.check(
		profiles.domed.maxReach > profiles.flat.maxReach + 0.05,
		`profile OUT domes the cap past the flat chamfer (${profiles.flat.maxReach.toFixed(3)} -> ${profiles.domed.maxReach.toFixed(3)})`
	);
	h.check(profiles.flat.pulledIn === 0, `a FLAT cap has nothing inside the corner (${profiles.flat.pulledIn})`);
	h.check(
		profiles.dished.pulledIn >= 1 && profiles.dished.maxReach <= profiles.flat.maxReach + 1e-6,
		`profile IN dishes the apex into the corner without moving the ring (${profiles.dished.pulledIn} inner vertices)`
	);
	const oddProfile = await oddEdges(A.page);
	h.check(oddProfile === 0, `a dished cap is watertight too (${oddProfile} odd edges)`);

	// --- a TEXTURED mesh keeps its mapping (the triple commit) --------------
	const textured = await A.page.evaluate(async () => {
		const s = window.__stores;
		const me = s.meshEdit;
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		const uvBefore = !!window.__box.geometry.attributes.uv;
		me.exitEditMode();
		me.enterEditMode(window.__box.uuid);
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		for (let i = 0; i < 32; i++) {
			me.selectHandle(i);
			const at = controls.object?.position;
			if (at && Math.abs(at.x - 1) < 1e-6 && Math.abs(at.y - 1) < 1e-6 && Math.abs(at.z - 1) < 1e-6) break;
		}
		me.bevelSelectedVerts(0.3, 0);
		const uv = window.__box.geometry.attributes.uv;
		const position = window.__box.geometry.attributes.position;
		let nonZero = 0;
		if (uv) for (let i = 0; i < uv.count; i++) if (uv.getX(i) !== 0 || uv.getY(i) !== 0) nonZero++;
		return { uvBefore, has: !!uv, covers: uv ? uv.count === position.count : false, nonZero };
	});
	h.check(textured.uvBefore, 'a fresh box has uvs (premise)');
	h.check(textured.has && textured.covers, 'the bevel kept a COMPLETE uv attribute (the positions-only commit dropped it)');
	h.check(textured.nonZero > 0, '...with real coordinates, not zeros');

	// --- and a peer gets it -------------------------------------------------
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const netUuid = await editBox(A.page);
	await selectAt(A.page, [[1, 1, 1]]);
	const triCountOn = (page, uuid) =>
		page.evaluate((uuid) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const object = g.getObjectByProperty('uuid', uuid);
			return object?.geometry ? window.__stores.meshTopology.triangleCountOf(object.geometry) : null;
		}, uuid);
	await h.eventually(
		() => triCountOn(B.page, netUuid),
		(n) => n === 12,
		'B received the box (premise)',
		20000
	);
	await A.page.evaluate(() => window.__stores.meshEdit.bevelSelectedVerts(0.4, 0));
	await h.eventually(
		() => triCountOn(B.page, netUuid),
		(n) => n !== null && n > 12,
		'B receives the bevelled corner',
		20000
	);
	const peerTopo = await B.page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		return !!window.__stores.meshTopology.readStoredFaces(object.geometry);
	}, netUuid);
	h.check(peerTopo, 'B stored the topology that came with it (the cap stays one face there too)');

	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());
	await h.finish(browser);
});
