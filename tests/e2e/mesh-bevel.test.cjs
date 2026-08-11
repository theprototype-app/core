// M5 BEVEL on a FACE selection: fold the face's border into a chamfer by insetting and
// pushing the shrinking cap, `segments` times.
//
// The reason it is face-scoped is measured, not assumed: an EDGE bevel has to delete the
// edge's vertices and give the NEIGHBOURING faces two vertices in their place, so folding
// only the two faces that touch the edge leaves the third face at each corner still using
// the old vertex. The first pass did exactly that and the box came out with 12
// non-manifold edges — this suite keeps that watertightness check as the guard, because it
// is the one that caught it.
const h = require('./helpers.cjs');

const editBox = (page, cmd = '/create Box 1 1 1') =>
	page.evaluate((c) => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand(c);
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		s.faceEdit.exitFaceEdit?.();
		s.faceEdit.enterFaceEdit(window.__box.uuid);
		s.faceEdit.setFaceSubmode('faces');
		return window.__box.uuid;
	}, cmd);

/** highlight the +Y face and return its triangle count */
const pickTop = (page) =>
	page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.setFaceGranularity('face');
		const faces = fe.currentFaces();
		const yi = faces.findIndex((f) => f.normal.y > 0.9);
		if (yi < 0) return 0;
		fe.highlightFaceByTriangle(faces[yi].triIndices[0]);
		return faces[yi].triIndices.length;
	});

/** every mesh edge shared by exactly two triangles = watertight */
const oddEdges = (page) =>
	page.evaluate(() => {
		const tris = window.__stores.faceEdit.readTriangles(window.__box.geometry);
		const keyOf = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e4)).join(',');
		const counts = new Map();
		for (const t of tris) {
			const keys = t.map(keyOf);
			for (let e = 0; e < 3; e++) {
				const [a, b] = [keys[e], keys[(e + 1) % 3]].sort();
				const k = a + '|' + b;
				counts.set(k, (counts.get(k) ?? 0) + 1);
			}
		}
		return [...counts.values()].filter((n) => n !== 2).length;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- one segment ---------------------------------------------------------
	await editBox(A.page);
	const capTris = await pickTop(A.page);
	h.check(capTris === 2, `the +Y face is one quad (${capTris} triangles)`);
	const clean = await oddEdges(A.page);
	h.check(clean === 0, `the box starts watertight (${clean} odd edges)`);
	const one = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const t = s.meshTopology;
		const before = fe.readTriangles(window.__box.geometry);
		const maxY = (tris) => Math.max(...tris.flat().map((v) => v.y));
		const ok = fe.bevelFaces(0.2, 1);
		const after = fe.readTriangles(window.__box.geometry);
		let sel;
		fe.faceEditSelectedTris.subscribe((v) => (sel = [...v]))();
		const stored = t.readStoredFaces(window.__box.geometry);
		// the cap shrank: its extent in x/z is smaller than the face it came from
		const capExtent = (tris, indices) => {
			let lo = 1e9;
			let hi = -1e9;
			for (const ti of indices)
				for (const v of tris[ti]) {
					lo = Math.min(lo, v.x);
					hi = Math.max(hi, v.x);
				}
			return hi - lo;
		};
		return {
			ok,
			trisBefore: before.length,
			trisAfter: after.length,
			yBefore: maxY(before),
			yAfter: maxY(after),
			sel: sel.length,
			capWidth: capExtent(after, sel),
			stored: !!stored,
			covers: stored ? stored.reduce((sum, f) => sum + f.length, 0) === after.length : false
		};
	});
	h.check(one.ok, 'the face bevel committed');
	h.check(
		one.trisAfter === one.trisBefore + 8,
		`one segment stitches a 4-quad ring around the face (${one.trisBefore} -> ${one.trisAfter})`
	);
	const oddOne = await oddEdges(A.page);
	h.check(oddOne === 0, `...and the mesh is STILL watertight (${oddOne} odd edges — the edge-bevel pass gave 12 here)`);
	h.check(one.capWidth < 0.9, `the cap shrank inward (x extent ${one.capWidth.toFixed(3)})`);
	h.check(one.yAfter > one.yBefore + 0.05, `the cap rose along its normal (${one.yBefore.toFixed(2)} -> ${one.yAfter.toFixed(2)})`);
	h.check(one.sel === 2, 'the cap stays selected, ready to scale or move');
	h.check(one.stored && one.covers, 'the bevel stored a partition covering every triangle');

	// --- more segments = a rounder profile, still watertight ------------------
	await editBox(A.page);
	await pickTop(A.page);
	const three = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		const before = fe.readTriangles(window.__box.geometry).length;
		const ok = fe.bevelFaces(0.3, 3);
		const tris = fe.readTriangles(window.__box.geometry);
		// the three rings sit at three DIFFERENT heights: that is what "rounder" means
		const heights = new Set(tris.flat().map((v) => Math.round(v.y * 1e3) / 1e3));
		return { ok, before, after: tris.length, levels: [...heights].filter((y) => y > 0.5).length };
	});
	h.check(three.ok, 'three segments committed');
	h.check(
		three.after === three.before + 24,
		`each segment adds its own ring (${three.before} -> ${three.after})`
	);
	h.check(three.levels >= 3, `the profile is stepped, not a single ramp (${three.levels} levels above the face)`);
	const oddThree = await oddEdges(A.page);
	h.check(oddThree === 0, `three segments stay watertight (${oddThree} odd edges)`);

	// --- ONE undo for the whole thing, and the refusals ---------------------
	const rest = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const count = () => fe.readTriangles(window.__box.geometry).length;
		const bevelled = count();
		s.history.undo();
		const undone = count();
		s.history.redo();
		const redone = count();
		// a CLOSED selection has no border to fold — refuse rather than translate
		fe.setFaceGranularity('object');
		fe.highlightFaceByTriangle(0);
		const closedRefused = fe.bevelFaces(0.2, 1) === false;
		const afterClosed = count();
		fe.setFaceGranularity('face');
		return { bevelled, undone, redone, closedRefused, closedUntouched: afterClosed === redone };
	});
	h.check(rest.undone === rest.bevelled - 24, `ONE undo removes all three rings (${rest.bevelled} -> ${rest.undone})`);
	h.check(rest.redone === rest.bevelled, 'redo puts them back');
	h.check(rest.closedRefused, 'bevelling a CLOSED selection is refused (no border to fold)');
	h.check(rest.closedUntouched, '...leaving the geometry untouched');

	// --- edge mode still says what it cannot do ------------------------------
	const edgeMode = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		return { noEdgeBevel: typeof fe.bevelEdges !== 'function' };
	});
	h.check(edgeMode.noEdgeBevel, 'there is no half-working edge bevel exposed — face bevel is the shipped op');

	// --- and a peer gets it -------------------------------------------------
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const netUuid = await editBox(A.page);
	await pickTop(A.page);
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
	await A.page.evaluate(() => window.__stores.faceEdit.bevelFaces(0.2, 2));
	await h.eventually(
		() => triCountOn(B.page, netUuid),
		(n) => n === 28,
		'B receives the bevelled geometry (12 + two 8-triangle rings)',
		20000
	);
	const peer = await B.page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		const faces = window.__stores.meshTopology.readStoredFaces(object.geometry);
		return { has: !!faces, quads: faces ? faces.filter((f) => f.length === 2).length : 0 };
	}, netUuid);
	h.check(peer.has, 'B stored the topology that came with the bevel');
	h.check(peer.quads >= 8, `...including both chamfer rings as quads (${peer.quads})`);

	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit?.());
	await h.finish(browser);
});
