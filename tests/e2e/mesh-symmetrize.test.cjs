// M7 SYMMETRIZE: keep one half of the mesh, replace the other with its mirror.
//
// Three things have to hold, and each has a way of going quietly wrong:
//  - the result must be SYMMETRIC, which means the mirrored half's positions match the kept
//    half's reflected, not merely "look about right";
//  - the mirrored faces must not be INSIDE OUT. A reflection flips handedness, so copying the
//    winding verbatim turns every mirrored triangle backwards — invisible from outside until
//    you notice you can see through the model;
//  - the SEAM must be watertight, which is why vertices near the plane are snapped ONTO it
//    before anything is copied.
const h = require('./helpers.cjs');

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

/** an asymmetric mesh: a box with its +X face pulled out, so mirroring is visible */
const lopsidedBox = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		fe.exitFaceEdit?.();
		fe.enterFaceEdit(window.__box.uuid);
		fe.setFaceGranularity('face');
		// extrude the +X face so the halves differ
		const faces = fe.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		fe.highlightFaceByTriangle(faces[xi].triIndices[0]);
		fe.commitFaceOp('extrude', 0.8);
		const tris = fe.readTriangles(window.__box.geometry);
		let maxX = -1e9;
		let minX = 1e9;
		for (const t of tris)
			for (const v of t) {
				maxX = Math.max(maxX, v.x);
				minX = Math.min(minX, v.x);
			}
		return { uuid: window.__box.uuid, tris: tris.length, maxX, minX };
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const lop = await lopsidedBox(A.page);
	h.check(
		Math.abs(lop.maxX - 1.8) < 1e-6 && Math.abs(lop.minX + 1) < 1e-6,
		`the box is now LOPSIDED: +X reaches ${lop.maxX.toFixed(2)}, -X only ${lop.minX.toFixed(2)}`
	);
	const cleanBefore = await oddEdges(A.page);
	h.check(cleanBefore === 0, `and watertight to start (${cleanBefore} odd edges)`);

	// --- mirror the + half onto the - half ----------------------------------
	const mirrored = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const ok = fe.symmetrizeMesh('x', 1);
		const tris = fe.readTriangles(window.__box.geometry);
		const keyOf = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e4)).join(',');
		const present = new Set();
		for (const t of tris) for (const v of t) present.add(keyOf(v));
		// EVERY vertex must have its mirror image present
		let unmatched = 0;
		for (const key of present) {
			const [x, y, z] = key.split(',').map(Number);
			if (!present.has([-x, y, z].join(','))) unmatched++;
		}
		// and the extrusion must now stick out BOTH ways
		let minX = 1e9;
		let maxX = -1e9;
		for (const t of tris)
			for (const v of t) {
				minX = Math.min(minX, v.x);
				maxX = Math.max(maxX, v.x);
			}
		// outward-facing check: every triangle's normal must point AWAY from the centre
		let inward = 0;
		for (const t of tris) {
			const centroid = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
			const normal = t[1].clone().sub(t[0]).cross(t[2].clone().sub(t[0])).normalize();
			if (normal.dot(centroid) < -1e-6) inward++;
		}
		return { ok, tris: tris.length, unmatched, minX, maxX, inward };
	});
	h.check(mirrored.ok, 'symmetrize committed');
	h.check(
		mirrored.unmatched === 0,
		`every vertex has its mirror image — the result really is symmetric (${mirrored.unmatched} unmatched)`
	);
	h.check(
		Math.abs(mirrored.minX + 1.8) < 1e-6 && Math.abs(mirrored.maxX - 1.8) < 1e-6,
		`the extrusion now reaches both ways (${mirrored.minX.toFixed(2)} .. ${mirrored.maxX.toFixed(2)})`
	);
	h.check(
		mirrored.inward === 0,
		`no mirrored face is INSIDE OUT (${mirrored.inward} inward) — a reflection flips handedness, so the winding has to be reversed`
	);
	const oddAfter = await oddEdges(A.page);
	h.check(oddAfter === 0, `the seam is watertight (${oddAfter} odd edges)`);

	// --- ONE undo ------------------------------------------------------------
	const undo = await A.page.evaluate(() => {
		const s = window.__stores;
		const count = () => s.faceEdit.readTriangles(window.__box.geometry).length;
		const after = count();
		s.history.undo();
		const undone = count();
		s.history.redo();
		return { after, undone, redone: count() };
	});
	h.check(undo.undone !== undo.after, `ONE undo restores the lopsided mesh (${undo.after} -> ${undo.undone})`);
	h.check(undo.redone === undo.after, 'redo mirrors it again');

	// --- the other direction, and the other axes ----------------------------
	const directions = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const run = (axis, keep) => {
			s.commandsHandler.sceneCommand('/create Box 2 2 2');
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			window.__box = g.children[g.children.length - 1];
			fe.exitFaceEdit();
			fe.enterFaceEdit(window.__box.uuid);
			fe.setFaceGranularity('face');
			const faces = fe.currentFaces();
			// pull out the +X face, then mirror across the requested axis
			const xi = faces.findIndex((f) => f.normal.x > 0.9);
			fe.highlightFaceByTriangle(faces[xi].triIndices[0]);
			fe.commitFaceOp('extrude', 0.8);
			const ok = fe.symmetrizeMesh(axis, keep);
			const tris = fe.readTriangles(window.__box.geometry);
			let minX = 1e9;
			let maxX = -1e9;
			for (const t of tris)
				for (const v of t) {
					minX = Math.min(minX, v.x);
					maxX = Math.max(maxX, v.x);
				}
			return { ok, minX, maxX, tris: tris.length };
		};
		return { keepNegative: run('x', -1), acrossY: run('y', 1) };
	});
	h.check(
		directions.keepNegative.ok && Math.abs(directions.keepNegative.maxX - 1) < 1e-6,
		`keeping the NEGATIVE half discards the extrusion (+X now ${directions.keepNegative.maxX.toFixed(2)})`
	);
	h.check(
		directions.acrossY.ok && Math.abs(directions.acrossY.maxX - 1.8) < 1e-6,
		`mirroring across Y leaves the X extrusion alone (+X still ${directions.acrossY.maxX.toFixed(2)})`
	);
	const oddY = await oddEdges(A.page);
	h.check(oddY === 0, `mirroring across Y is watertight too (${oddY} odd edges)`);

	// --- the refusal ---------------------------------------------------------
	const refusal = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		// move the whole mesh onto the negative side, then ask to keep the positive one
		const tris = fe.readTriangles(window.__box.geometry);
		const positions = [];
		for (const t of tris) for (const v of t) positions.push(v.x - 10, v.y, v.z);
		fe.commitMeshGeoSnapshot(window.__box.uuid, positions, positions);
		const count = () => fe.readTriangles(window.__box.geometry).length;
		const before = count();
		const refused = fe.symmetrizeMesh('x', 1) === false;
		return { refused, untouched: count() === before };
	});
	h.check(refusal.refused, 'mirroring an empty half is refused, with the reason');
	h.check(refusal.untouched, '...leaving the geometry untouched');

	// --- and a peer gets it -------------------------------------------------
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const net = await lopsidedBox(A.page);
	const extentOn = (page, uuid) =>
		page.evaluate((uuid) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const object = g.getObjectByProperty('uuid', uuid);
			const p = object?.geometry?.attributes?.position;
			if (!p) return null;
			let min = 1e9;
			for (let i = 0; i < p.count; i++) min = Math.min(min, p.getX(i));
			return min;
		}, uuid);
	await h.eventually(
		() => extentOn(B.page, net.uuid),
		(v) => v !== null && Math.abs(v + 1) < 1e-3,
		'B received the lopsided box (premise)',
		20000
	);
	await A.page.evaluate(() => window.__stores.faceEdit.symmetrizeMesh('x', 1));
	await h.eventually(
		() => extentOn(B.page, net.uuid),
		(v) => v !== null && v < -1.7,
		'B receives the mirrored geometry',
		20000
	);

	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit?.());
	await h.finish(browser);
});
