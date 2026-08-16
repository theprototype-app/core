// M5 BEVEL on a FACE selection: fold the face's border into a chamfer by insetting and
// pushing the shrinking cap, `segments` times.
//
// The reason it is face-scoped is measured, not assumed: an EDGE bevel has to delete the
// edge's vertices and give the NEIGHBOURING faces two vertices in their place, so folding
// only the two faces that touch the edge leaves the third face at each corner still using
// the old vertex. The first pass did exactly that and the box came out with 12
// non-manifold edges — this suite keeps that watertightness check as the guard, because it
// is the one that caught it.
//
// 19-A P3 RE-BASELINE — width is a WORLD distance now (edge/vertex bevel always was;
// the face bevel read the same number as an inset FRACTION). Every expected number
// below is RE-DERIVED from the world-unit semantics, never pasted from output:
//   unit box, +Y face: corners (±0.5, 0.5, ±0.5), centroid (0, 0.5, 0), so the mean
//   boundary radius r = √(0.5² + 0.5²) = √0.5 ≈ 0.70711.
//   bevelFaces(w, n): the border travels w world units toward the centre
//   (per step t_k = worldStep_k / r_k, so the world travels ADD), and the cap
//   rises w along +normal (depth was always world units — unchanged).
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
	// RE-DERIVED (world units): width 0.2 → t = 0.2/√0.5 = 0.28284; the corner
	// (0.5, z) lerps to 0.5·(1 − t) = 0.35858, so the cap's x extent is
	// 2·0.35858 = 0.71716 (the old fraction semantics gave 0.5·0.8·2 = 0.8)
	h.check(
		Math.abs(one.capWidth - 0.71716) < 1e-3,
		`the cap shrank so its border travelled 0.2 WORLD units (x extent ${one.capWidth.toFixed(5)}, expected 0.71716)`
	);
	// RE-DERIVED: the push depth equals the width (world units, unchanged
	// dimension pre/post P3): 0.5 + 0.2 = 0.7 exactly
	h.check(
		Math.abs(one.yAfter - 0.7) < 1e-3 && one.yAfter > one.yBefore,
		`the cap rose exactly width along its normal (${one.yBefore.toFixed(2)} -> ${one.yAfter.toFixed(4)}, expected 0.7)`
	);
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
		return {
			ok,
			before,
			after: tris.length,
			maxY: Math.max(...tris.flat().map((v) => v.y)),
			levels: [...heights].filter((y) => y > 0.5).length
		};
	});
	h.check(three.ok, 'three segments committed');
	h.check(
		three.after === three.before + 24,
		`each segment adds its own ring (${three.before} -> ${three.after})`
	);
	h.check(three.levels >= 3, `the profile is stepped, not a single ramp (${three.levels} levels above the face)`);
	// RE-DERIVED: the quarter-circle pushes sum to the full depth = width, so the
	// cap tops out at 0.5 + 0.3 = 0.8 whatever the segment count
	h.check(
		Math.abs(three.maxY - 0.8) < 1e-3,
		`the cap tops out at exactly width above the face (${three.maxY.toFixed(4)}, expected 0.8)`
	);
	const oddThree = await oddEdges(A.page);
	h.check(oddThree === 0, `three segments stay watertight (${oddThree} odd edges)`);

	// --- ONE undo for the whole thing, and the refusals ---------------------
	// (kept DIRECTLY after the 3-segment bevel: it undoes the LAST history entry)
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

	// --- P3: the faces PROFILE lerps the schedule, DIRECTION signs the push ---
	await editBox(A.page);
	await pickTop(A.page);
	const linear = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		// profile 0 = LINEAR schedule: equal shares per step
		const ok = fe.bevelFaces(0.3, 3, 0);
		const tris = fe.readTriangles(window.__box.geometry);
		const heights = [...new Set(tris.flat().map((v) => Math.round(v.y * 1e4) / 1e4))]
			.filter((y) => y > 0.501)
			.sort((a, b) => a - b);
		return { ok, heights };
	});
	h.check(linear.ok, 'a profile-0 (linear) bevel committed');
	// RE-DERIVED: linear shares of depth 0.3 over 3 steps = 0.1 apiece, so the
	// ring heights are 0.6 / 0.7 / 0.8 — the quarter-circle (profile 1) puts
	// them at 0.5402 / 0.65 / 0.8 instead, which is what separates the schedules
	h.check(
		linear.heights.length === 3 &&
			[0.6, 0.7, 0.8].every((y, i) => Math.abs(linear.heights[i] - y) < 1e-3),
		`profile 0 spaces the rings LINEARLY at 0.6/0.7/0.8 (${JSON.stringify(linear.heights)})`
	);
	const oddLinear = await oddEdges(A.page);
	h.check(oddLinear === 0, `a linear-profile bevel is watertight (${oddLinear} odd edges)`);

	// --- 19-A P7a: the profile goes NEGATIVE, and that is the CONCAVE arc ------
	// The chamfer is a 2D curve, so measure it as one. Every ring of a bevelled
	// box face is a SQUARE, so its +x+z DIAGONAL corner describes the whole ring:
	// s = how far that corner travelled inward along the diagonal, rise = how far
	// it climbed above the original face. The two together are the step schedule
	// with the geometry stripped away.
	const ringProfile = (page) =>
		page.evaluate(() => {
			const tris = window.__stores.faceEdit.readTriangles(window.__box.geometry);
			/** @type {Map<number, {s: number, rise: number}>} */
			const seen = new Map();
			for (const v of tris.flat()) {
				if (v.y < 0.4999) continue; // below the original +Y face: the box body
				if (Math.abs(v.x - v.z) > 1e-4 || v.x <= 0) continue; // the +x+z corner column
				const key = Math.round(v.y * 1e6);
				if (!seen.has(key)) seen.set(key, { s: Math.SQRT2 * (0.5 - v.x), rise: v.y - 0.5 });
			}
			return [...seen.values()].sort((a, b) => a.rise - b.rise);
		});
	/**
	 * The signed distance of each INTERIOR ring from the straight chord between
	 * the first ring (the face border, at the origin of this 2D frame) and the
	 * last (the cap). The chord passes through the origin, so the perpendicular
	 * offset of a point is just its dot with the chord's normal. POSITIVE = the
	 * side the quarter circle leaves the ramp on at profile +1: it runs inward
	 * fast and rises late, so the chamfer leaves the surrounding surface
	 * tangentially and turns up into the cap. Negative is the mirror of that.
	 */
	const bulges = (rings) => {
		const last = rings[rings.length - 1];
		const len = Math.hypot(last.s, last.rise) || 1;
		const ds = last.s / len;
		const dy = last.rise / len;
		return rings.slice(1, -1).map((p) => p.s * dy - p.rise * ds);
	};
	const bevelAt = async (profile) => {
		await editBox(A.page);
		await pickTop(A.page);
		const ok = await A.page.evaluate((p) => window.__stores.faceEdit.bevelFaces(0.3, 3, p), profile);
		return { ok, rings: await ringProfile(A.page), odd: await oddEdges(A.page) };
	};
	const convex = await bevelAt(0.5);
	const concave = await bevelAt(-0.5);
	h.check(
		convex.ok && concave.ok && convex.rings.length === 4 && concave.rings.length === 4,
		`both profiles committed with 4 rings each (${convex.rings.length} / ${concave.rings.length})`
	);
	const convexBulge = bulges(convex.rings);
	const concaveBulge = bulges(concave.rings);
	h.check(
		convexBulge.length === 2 && convexBulge.every((b) => b > 0.02),
		`profile +0.5 bulges to the CONVEX side (${convexBulge.map((b) => b.toFixed(5)).join(', ')})`
	);
	h.check(
		concaveBulge.length === 2 && concaveBulge.every((b) => b < -0.02),
		`profile -0.5 bulges the other way (${concaveBulge.map((b) => b.toFixed(5)).join(', ')})`
	);
	// RE-DERIVED: at profile ±0.5, n=3, width 0.3 the blended schedule puts both
	// interior rings at (0.125, 0.0701) and (0.2299, 0.175) — a chord direction of
	// (1,1)/√2, so the offset is (s − rise)/√2 = ±0.03882. The two signs are exact
	// mirrors because the swap only exchanges the two columns.
	h.check(
		convexBulge.every((b) => Math.abs(b - 0.03882) < 1e-3) &&
			concaveBulge.every((b) => Math.abs(b + 0.03882) < 1e-3),
		`the two curves are exact mirrors of the ramp (expected ±0.03882)`
	);
	h.check(
		convex.odd === 0 && concave.odd === 0,
		`both curved profiles are watertight (${convex.odd} / ${concave.odd} odd edges)`
	);

	// REACH is profile-independent — that is the whole point of every step column
	// summing to 1, and it is what lets the sign be a pure shape control. The cap
	// plane must land at 0.5 + width = 0.8 at profile -1, 0 and +1 alike.
	const reaches = [];
	for (const p of [-1, 0, 1]) {
		await editBox(A.page);
		await pickTop(A.page);
		const r = await A.page.evaluate((prof) => {
			const fe = window.__stores.faceEdit;
			const ok = fe.bevelFaces(0.3, 3, prof);
			const tris = fe.readTriangles(window.__box.geometry);
			const heights = [...new Set(tris.flat().map((v) => Math.round(v.y * 1e4) / 1e4))]
				.filter((y) => y > 0.501)
				.sort((a, b) => a - b);
			return { ok, maxY: Math.max(...tris.flat().map((v) => v.y)), heights };
		}, p);
		reaches.push({ p, ...r, odd: await oddEdges(A.page) });
	}
	h.check(
		reaches.every((r) => r.ok && r.odd === 0),
		`profiles -1 / 0 / +1 all commit watertight (${reaches.map((r) => r.odd).join(', ')} odd edges)`
	);
	const spread = Math.max(...reaches.map((r) => r.maxY)) - Math.min(...reaches.map((r) => r.maxY));
	h.check(
		spread < 1e-6 && Math.abs(reaches[0].maxY - 0.8) < 1e-6,
		`the cap tops out at 0.8 whatever the profile (spread ${spread.toExponential(2)}, maxY ${reaches[0].maxY.toFixed(8)})`
	);
	// REGRESSION PIN: profile +1 is the pre-P7a schedule, unchanged. RE-DERIVED —
	// the quarter circle's cumulative push is (1 − cos θ)·depth at θ = 30/60/90°,
	// so the rings sit at 0.5 + 0.3·{0.13397, 0.5, 1} = 0.5402 / 0.65 / 0.8.
	const pinned = reaches.find((r) => r.p === 1);
	h.check(
		pinned.heights.length === 3 &&
			[0.5402, 0.65, 0.8].every((y, i) => Math.abs(pinned.heights[i] - y) < 1e-3),
		`profile 1 still spaces the rings on the quarter circle (${JSON.stringify(pinned.heights)})`
	);
	// ...and -1 is its mirror: 0.5 + 0.3·sin θ = 0.65 / 0.7598 / 0.8
	const mirrored = reaches.find((r) => r.p === -1);
	h.check(
		mirrored.heights.length === 3 &&
			[0.65, 0.7598, 0.8].every((y, i) => Math.abs(mirrored.heights[i] - y) < 1e-3),
		`profile -1 is its mirror, rising early instead of late (${JSON.stringify(mirrored.heights)})`
	);

	// direction: 'out' raises the cap along +normal, 'in' recesses it — the cap
	// centroid's displacement SIGN against the face normal is the whole contract
	const directions = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const run = (direction) => {
			s.commandsHandler.sceneCommand('/create Box 1 1 1');
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			window.__box = g.children[g.children.length - 1];
			fe.exitFaceEdit();
			fe.enterFaceEdit(window.__box.uuid);
			fe.setFaceGranularity('face');
			const faces = fe.currentFaces();
			const yi = faces.findIndex((f) => f.normal.y > 0.9);
			fe.highlightFaceByTriangle(faces[yi].triIndices[0]);
			const ok = fe.bevelFaces(0.2, 1, 1, direction);
			// the cap stays selected — read its plane height directly
			let sel;
			fe.faceEditSelectedTris.subscribe((v) => (sel = [...v]))();
			const tris = fe.readTriangles(window.__box.geometry);
			let capY = 0;
			let n = 0;
			for (const ti of sel) for (const v of tris[ti]) (capY += v.y), n++;
			return { ok, capY: capY / (n || 1) };
		};
		return { out: run('out'), inward: run('in') };
	});
	h.check(directions.out.ok && directions.inward.ok, 'both directions committed (premise)');
	// RE-DERIVED: +Y face at 0.5; width 0.2 → out lands the cap at 0.7, in at 0.3
	h.check(
		Math.abs(directions.out.capY - 0.7) < 1e-3,
		`direction OUT raises the cap along +normal (capY ${directions.out.capY.toFixed(4)}, expected 0.7)`
	);
	h.check(
		Math.abs(directions.inward.capY - 0.3) < 1e-3,
		`direction IN recesses it (capY ${directions.inward.capY.toFixed(4)}, expected 0.3)`
	);
	const oddIn = await oddEdges(A.page);
	h.check(oddIn === 0, `a recessed bevel is watertight too (${oddIn} odd edges)`);

	// --- the three bevels are three ops, not one wearing hats ----------------
	// This used to assert that NO edge bevel existed, because the first attempt cracked the
	// mesh and was dropped. It exists now (mesh-edge-bevel), built on the corner surgery the
	// vertex bevel introduced — so the check flips to what still matters: each element mode
	// has its OWN op, and the face one is not quietly delegating to another.
	const ops = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		const me = window.__stores.meshEdit;
		return {
			face: typeof fe.bevelFaces === 'function',
			edge: typeof fe.bevelEdges === 'function',
			vertex: typeof me.bevelSelectedVerts === 'function'
		};
	});
	h.check(ops.face && ops.edge && ops.vertex, 'all three bevels are exposed: faces, edges and vertices');

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
