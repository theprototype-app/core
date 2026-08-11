// M5c EDGE BEVEL, second attempt — and the guard is the one that killed the first.
//
// A true edge bevel REMOVES the edge's endpoints and hands every face around them the offset
// points that belong to it. Folding only the two faces touching the edge leaves the third
// face at each corner still using the old vertex, and the mesh cracks along the edges they
// shared: 12 non-manifold edges on a box, measured. So the headline check here is
// watertightness, at every segment count and profile.
//
// The corner surgery is exact when an endpoint has THREE faces around it (a box corner, an
// extrusion corner, a loop-cut band). More than that needs a mitered vertex mesh, which is
// REFUSED with the reason rather than guessed at — and that refusal is checked too.
const h = require('./helpers.cjs');

const editBox = (page, size = 2) =>
	page.evaluate((size) => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand(`/create Box ${size} ${size} ${size}`);
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		s.faceEdit.exitFaceEdit?.();
		s.faceEdit.enterFaceEdit(window.__box.uuid);
		s.faceEdit.setFaceSubmode('edges');
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

/** pick ONE real edge of the top face; returns its key */
const pickTopEdge = (page) =>
	page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		const tris = fe.readTriangles(window.__box.geometry);
		for (let ti = 0; ti < tris.length; ti++) {
			const t = tris[ti];
			if (!t.every((v) => v.y > 0.99)) continue;
			const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
			for (let e = 0; e < 3; e++) {
				const mid = t[e].clone().add(t[(e + 1) % 3]).multiplyScalar(0.5);
				const key = fe.pickEdgeAt(ti, c.clone().lerp(mid, 0.95));
				if (!key) continue;
				fe.pickEdge(key, false);
				if (fe.edgeSelectionSize() === 1) return key;
			}
		}
		return null;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- one flat segment ----------------------------------------------------
	await editBox(A.page);
	const key = await pickTopEdge(A.page);
	h.check(!!key, 'picked one real edge of the top face (premise)');
	const clean = await oddEdges(A.page);
	h.check(clean === 0, `the box starts watertight (${clean} odd edges)`);
	const one = await A.page.evaluate((key) => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const before = fe.readTriangles(window.__box.geometry).length;
		const ends = new Set(key.split('|'));
		const keyOf = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e4)).join(',');
		const ok = fe.bevelEdges(0.3, 1, 0);
		const tris = fe.readTriangles(window.__box.geometry);
		return {
			ok,
			before,
			after: tris.length,
			endpointsLeft: tris.flat().filter((v) => ends.has(keyOf(v))).length
		};
	}, key);
	h.check(one.ok, 'the edge bevel committed');
	h.check(
		one.endpointsLeft === 0,
		`both ENDPOINTS of the edge are gone — the corner was really removed (${one.endpointsLeft} left)`
	);
	const oddOne = await oddEdges(A.page);
	h.check(
		oddOne === 0,
		`WATERTIGHT (${oddOne} odd edges) — the first attempt measured 12 here, which is why it was dropped`
	);
	h.check(one.after > one.before, `the chamfer arrived (${one.before} -> ${one.after})`);

	// --- undo is one step ----------------------------------------------------
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

	// --- segments, and profile OUT / IN --------------------------------------
	const variants = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const run = (segments, profile) => {
			s.commandsHandler.sceneCommand('/create Box 2 2 2');
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			window.__box = g.children[g.children.length - 1];
			fe.exitFaceEdit();
			fe.enterFaceEdit(window.__box.uuid);
			fe.setFaceSubmode('edges');
			const tris = fe.readTriangles(window.__box.geometry);
			let picked = null;
			for (let ti = 0; ti < tris.length && !picked; ti++) {
				const t = tris[ti];
				if (!t.every((v) => v.y > 0.99)) continue;
				const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
				for (let e = 0; e < 3 && !picked; e++) {
					const mid = t[e].clone().add(t[(e + 1) % 3]).multiplyScalar(0.5);
					const candidate = fe.pickEdgeAt(ti, c.clone().lerp(mid, 0.95));
					if (!candidate) continue;
					fe.pickEdge(candidate, false);
					if (fe.edgeSelectionSize() === 1) picked = candidate;
				}
			}
			if (!picked) return null;
			const ok = fe.bevelEdges(0.3, segments, profile);
			const after = fe.readTriangles(window.__box.geometry);
			// Measure the chamfer BAND, and take its MINIMUM reach: the band's outer corners
			// never move, so a bulge or a hollow only shows in how far the INTERIOR rings sit
			// from the corner. A max over the whole mesh reads a different box corner entirely
			// and reports the same number for flat and hollow (it did).
			const band = after
				.flat()
				.filter((v) => v.y > 0.6 && v.z > 0.6 && Math.abs(v.x) < 0.9)
				.map((v) => (v.y + v.z) / Math.SQRT2);
			return { ok, tris: after.length, reach: Math.min(...band), band: band.length };
		};
		return { flat1: run(1, 0), flat3: run(3, 0), out: run(3, 1), inward: run(3, -1) };
	});
	h.check(variants.flat3.ok && variants.flat3.tris > variants.flat1.tris, `3 segments add more geometry than 1 (${variants.flat1.tris} -> ${variants.flat3.tris})`);
	h.check(
		variants.out.reach > variants.flat3.reach + 0.02,
		`profile OUT bulges the interior rings outward (band min ${variants.flat3.reach.toFixed(3)} -> ${variants.out.reach.toFixed(3)})`
	);
	h.check(
		variants.inward.reach < variants.flat3.reach - 0.02,
		`profile IN hollows them inward (band min ${variants.inward.reach.toFixed(3)})`
	);
	const oddVariant = await oddEdges(A.page);
	h.check(oddVariant === 0, `a hollowed 3-segment chamfer is watertight (${oddVariant} odd edges)`);

	// --- the refusals -------------------------------------------------------
	const refusals = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const out = {};
		// nothing picked
		fe.clearEdgeSelection();
		out.emptyRefused = fe.bevelEdges(0.2, 1, 0) === false;
		// a HIGH-VALENCE endpoint: subdividing the top face makes its centre vertex touch
		// four faces, so an edge into it has no unambiguous corner and must be refused
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		fe.exitFaceEdit();
		fe.enterFaceEdit(window.__box.uuid);
		fe.setFaceSubmode('faces');
		fe.setFaceGranularity('face');
		const faces = fe.currentFaces();
		const yi = faces.findIndex((f) => f.normal.y > 0.9);
		fe.highlightFaceByTriangle(faces[yi].triIndices[0]);
		fe.commitFaceOp('subdivide', 0);
		fe.setFaceSubmode('edges');
		const tris = fe.readTriangles(window.__box.geometry);
		// an edge touching the subdivided centre (0, 1, 0)
		let key = null;
		for (let ti = 0; ti < tris.length && !key; ti++) {
			const t = tris[ti];
			if (!t.some((v) => Math.abs(v.x) < 1e-6 && v.y > 0.99 && Math.abs(v.z) < 1e-6)) continue;
			const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
			for (let e = 0; e < 3 && !key; e++) {
				const mid = t[e].clone().add(t[(e + 1) % 3]).multiplyScalar(0.5);
				const candidate = fe.pickEdgeAt(ti, c.clone().lerp(mid, 0.95));
				if (candidate && candidate.includes('0,10000,0')) key = candidate;
			}
		}
		if (!key) return { ...out, noHighValence: true };
		fe.pickEdge(key, false);
		const countBefore = fe.readTriangles(window.__box.geometry).length;
		out.valenceRefused = fe.bevelEdges(0.2, 1, 0) === false;
		out.valenceUntouched = fe.readTriangles(window.__box.geometry).length === countBefore;
		return out;
	});
	h.check(refusals.emptyRefused, 'bevel with nothing picked is refused');
	if (refusals.noHighValence) {
		h.check(false, 'found an edge into a high-valence vertex (premise)');
	} else {
		h.check(
			refusals.valenceRefused,
			'an endpoint with FOUR faces is refused rather than guessed (that needs a mitered corner)'
		);
		h.check(refusals.valenceUntouched, '...leaving the geometry untouched');
	}

	// --- and a peer gets it -------------------------------------------------
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const netUuid = await editBox(A.page);
	const netKey = await pickTopEdge(A.page);
	h.check(!!netKey, 'picked an edge on the replicated box (premise)');
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
	await A.page.evaluate(() => window.__stores.faceEdit.bevelEdges(0.3, 2, 0.5));
	await h.eventually(
		() => triCountOn(B.page, netUuid),
		(n) => n !== null && n > 12,
		'B receives the bevelled edge',
		20000
	);

	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit?.());
	await h.finish(browser);
});
