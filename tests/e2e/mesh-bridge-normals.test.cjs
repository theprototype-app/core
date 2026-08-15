// Which way a BRIDGE's tunnel walls face, which turns out to be two different questions
// with two different answers — and the first pass answered only one of them (reported:
// "bridging two parallel quads of a subdivided cube I had to flip normals, but bridging
// two separate shells works fine").
//
// Deleting both caps from ONE shell punches a HOLE THROUGH a solid, and what you see of a
// hole is its INNER surface, so those walls must face the tunnel axis. Two SEPARATE shells
// get an exterior connection — a tube seen from outside — facing away from the axis. The
// old rule always wound outward, which is right for the tube and inside-out for the hole.
const h = require('./helpers.cjs');

/** every triangle as {centroid, normal}, in object space */
const trisOf = (page) =>
	page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		return fe.readTriangles(window.__box.geometry).map((t) => {
			const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
			const n = t[1].clone().sub(t[0]).cross(t[2].clone().sub(t[0])).normalize();
			return { c: [c.x, c.y, c.z], n: [n.x, n.y, n.z] };
		});
	});

/** odd (non-manifold) edge count — a bridge must stay watertight either way */
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

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ===================== 1. ONE shell: a shaft straight through it
	// INSET both caps first, so the shaft runs strictly INSIDE the cube. Bridging a unit
	// cube's full top and bottom faces is the degenerate case mesh-ops already documents
	// (the walls land exactly on the cube's own sides), and it is not what a user does —
	// the report came from a SUBDIVIDED cube, i.e. two parallel quads smaller than the face.
	const hole = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		fe.enterFaceEdit(window.__box.uuid);
		fe.setFaceGranularity('face');
		// inset leaves its CAP selected, which is exactly the quad we want to bridge — and
		// it has to be captured, because an inset cap is COPLANAR with the ring it stitched,
		// so Face granularity re-merges the two into one 10-triangle face and bridging THAT
		// connects the outer boundaries again (the degenerate case, measured: 28 -> 16).
		const insetAndCapture = (/** @type {(f: any) => boolean} */ test) => {
			const face = fe.currentFaces().find(test);
			if (!face) return null;
			fe.faceEditSelectedTris.set([...face.triIndices]);
			fe.highlightFaceByTriangle(face.triIndices[0]);
			if (!fe.commitFaceOp('inset', 0.45)) return null;
			let cap;
			fe.faceEditSelectedTris.subscribe((v) => (cap = [...v]))();
			return cap;
		};
		const topCap = insetAndCapture((f) => f.normal.y > 0.9);
		const bottomCap = insetAndCapture((f) => f.normal.y < -0.9);
		if (!topCap?.length || !bottomCap?.length) return { missing: true };
		fe.faceEditSelectedTris.set([...topCap, ...bottomCap]);
		// healStale=false: with the cap coplanar with its ring, Face granularity resolves a
		// 10-triangle unit that is not a subset of the two caps, and the heal would CLEAR
		// the very selection being built (it silently did — "Multi-select two faces first")
		fe.highlightFaceByTriangle(topCap[0], false);
		const trisBefore = fe.readTriangles(window.__box.geometry).length;
		const ok = fe.commitFaceOp('bridge', 0);
		return {
			ok,
			trisBefore,
			trisAfter: fe.readTriangles(window.__box.geometry).length
		};
	});
	h.check(!hole.missing && hole.ok, 'inset both caps, then bridged them into a shaft (premise)');
	h.check(
		hole.trisAfter === hole.trisBefore - 4 + 8,
		`the caps went and the shaft arrived (${hole.trisBefore} -> ${hole.trisAfter})`
	);
	const holeOdd = await oddEdges(A.page);
	h.check(holeOdd === 0, `the box with a shaft through it is watertight (${holeOdd} odd edges)`);
	// the shaft walls are the vertical triangles near the y axis: check the sign of
	// normal . radial-out. A hole shows its INNER surface, so this must be negative.
	const holeWalls = await trisOf(A.page);
	const wallSigns = holeWalls
		.filter((t) => Math.abs(t.n[1]) < 0.3 && Math.hypot(t.c[0], t.c[2]) < 0.3)
		.map((t) => {
			const radial = [t.c[0], t.c[2]];
			const length = Math.hypot(radial[0], radial[1]) || 1;
			return (t.n[0] * radial[0] + t.n[2] * radial[1]) / length;
		});
	h.check(wallSigns.length >= 8, `found the shaft walls (${wallSigns.length} triangles)`);
	h.check(
		wallSigns.every((sign) => sign < -0.5),
		`every shaft wall faces INWARD, so the hole shows its inner surface (worst ${Math.max(...wallSigns).toFixed(2)})`
	);
	// ===================== 2. TWO shells: the facing caps = an exterior TUBE
	const tube = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		fe.exitFaceEdit();
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		// ONE mesh holding TWO shells, 3 apart on x (the mesh-ops bridge idiom)
		const T = s.THREE;
		const cube = (ox) => {
			const geo = new T.BoxGeometry(1, 1, 1).toNonIndexed();
			const arr = Array.from(geo.attributes.position.array);
			geo.dispose();
			for (let i = 0; i < arr.length; i += 3) arr[i] += ox;
			return arr;
		};
		fe.applyMeshGeo(window.__box.uuid, [...cube(0), ...cube(3)]);
		fe.enterFaceEdit(window.__box.uuid);
		fe.setFaceGranularity('face');
		const faces = fe.currentFaces();
		// the two FACING caps: +X of the left box, -X of the right one
		const left = faces.find((f) => f.normal.x > 0.9 && Math.abs(f.centroid.x - 0.5) < 0.01);
		const right = faces.find((f) => f.normal.x < -0.9 && Math.abs(f.centroid.x - 2.5) < 0.01);
		if (!left || !right) return { missing: true, faces: faces.length };
		fe.faceEditSelectedTris.set([...left.triIndices, ...right.triIndices]);
		fe.highlightFaceByTriangle(left.triIndices[0]);
		const trisBefore = fe.readTriangles(window.__box.geometry).length;
		const ok = fe.commitFaceOp('bridge', 0);
		return { ok, trisBefore, trisAfter: fe.readTriangles(window.__box.geometry).length };
	});
	h.check(!tube.missing && tube.ok, 'bridged the facing caps of two separate shells (premise)');
	h.check(tube.trisAfter === tube.trisBefore - 4 + 8, `the tube arrived (${tube.trisBefore} -> ${tube.trisAfter})`);
	const tubeOdd = await oddEdges(A.page);
	h.check(tubeOdd === 0, `the connected pair is watertight (${tubeOdd} odd edges)`);
	const tubeTris = await trisOf(A.page);
	const tubeSigns = tubeTris
		.filter((t) => Math.abs(t.n[0]) < 0.3 && t.c[0] > 0.6 && t.c[0] < 2.4)
		.map((t) => {
			const radial = [t.c[1], t.c[2]];
			const length = Math.hypot(radial[0], radial[1]) || 1;
			return (t.n[1] * radial[0] + t.n[2] * radial[1]) / length;
		});
	h.check(tubeSigns.length >= 8, `found the tube walls (${tubeSigns.length} triangles)`);
	h.check(
		tubeSigns.every((sign) => sign > 0.5),
		`every tube wall faces OUTWARD, because you see a tube from outside (worst ${Math.min(...tubeSigns).toFixed(2)})`
	);

	// ===================== 3. 19-A P3: TWIST rotates the loop pairing
	// The tunnel's RAIL edges run from a left-cap corner (x=0.5) to its paired
	// right-cap corner (x=2.5). With twist 0 the angle pairing lines the two
	// square caps up, so all 4 rails are STRAIGHT (same y,z at both ends); one
	// twist step pairs every corner with its neighbour instead, so no rail is
	// straight — and the tunnel must still close watertight.
	const straightRails = (page) =>
		page.evaluate(() => {
			const tris = window.__stores.faceEdit.readTriangles(window.__box.geometry);
			let straight = 0;
			const seen = new Set();
			for (const t of tris)
				for (let e = 0; e < 3; e++) {
					const p = t[e];
					const q = t[(e + 1) % 3];
					// a rail spans the tunnel: one end on each cap plane
					const spans =
						(Math.abs(p.x - 0.5) < 1e-4 && Math.abs(q.x - 2.5) < 1e-4) ||
						(Math.abs(q.x - 0.5) < 1e-4 && Math.abs(p.x - 2.5) < 1e-4);
					if (!spans) continue;
					// UNDIRECTED key: a rail is shared by two wall quads and shows up
					// in both directions — sort the endpoints or every rail counts twice
					const ends = [p, q]
						.map((v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e4)).join(','))
						.sort()
						.join('|');
					if (seen.has(ends)) continue;
					seen.add(ends);
					if (Math.abs(p.y - q.y) < 1e-4 && Math.abs(p.z - q.z) < 1e-4) straight++;
				}
			return straight;
		});
	// premise on the twist-0 tube built above: all 4 rails are straight
	const straight0 = await straightRails(A.page);
	h.check(straight0 === 4, `twist 0 pairs the aligned corners — 4 straight rails (${straight0})`);
	const twisted = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		fe.exitFaceEdit();
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		const T = s.THREE;
		const cube = (ox) => {
			const geo = new T.BoxGeometry(1, 1, 1).toNonIndexed();
			const arr = Array.from(geo.attributes.position.array);
			geo.dispose();
			for (let i = 0; i < arr.length; i += 3) arr[i] += ox;
			return arr;
		};
		fe.applyMeshGeo(window.__box.uuid, [...cube(0), ...cube(3)]);
		fe.enterFaceEdit(window.__box.uuid);
		fe.setFaceGranularity('face');
		const faces = fe.currentFaces();
		const left = faces.find((f) => f.normal.x > 0.9 && Math.abs(f.centroid.x - 0.5) < 0.01);
		const right = faces.find((f) => f.normal.x < -0.9 && Math.abs(f.centroid.x - 2.5) < 0.01);
		if (!left || !right) return { missing: true };
		fe.faceEditSelectedTris.set([...left.triIndices, ...right.triIndices]);
		fe.highlightFaceByTriangle(left.triIndices[0]);
		const trisBefore = fe.readTriangles(window.__box.geometry).length;
		const ok = fe.bridgeFaces(0, 1); // one twist step
		return { ok, trisBefore, trisAfter: fe.readTriangles(window.__box.geometry).length };
	});
	h.check(!twisted.missing && twisted.ok, 'bridged the same caps with twist 1 (premise)');
	h.check(
		twisted.trisAfter === twisted.trisBefore - 4 + 8,
		`twist changes the pairing, never the count (${twisted.trisBefore} -> ${twisted.trisAfter})`
	);
	const straight1 = await straightRails(A.page);
	h.check(
		straight1 === 0,
		`twist 1 pairs every corner with its NEIGHBOUR — no straight rail survives (${straight1})`
	);
	const twistedOdd = await oddEdges(A.page);
	h.check(twistedOdd === 0, `and the twisted tunnel is still watertight (${twistedOdd} odd edges)`);

	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit?.());
	await h.finish(browser);
});
