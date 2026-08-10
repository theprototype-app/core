// Loop tools after other edits (user report: "loop is still not perfect - after
// multi extrude, move/scale/subdivide a face or a loop of faces, applying loop
// again misbehaves", and "loop cut in faces mode selects some triangles").
//
// Three root causes, three groups of checks:
//  1. loop cut read a MODULE-LEVEL axis left over from the last Loop press (and
//     from the previous object's session) - it derives the ring from the
//     selection now, and leaves the new band selected.
//  2. Subdivide split each TRIANGLE into four, giving a quad 8 triangles with
//     no grid pairing - pairQuads then produced a pinwheel and the loop walk
//     had nothing sane to follow. Quads split 2x2 now.
//  3. faceLoopRing continued through a NON-MANIFOLD edge by picking an
//     arbitrary neighbour; it stops there now.
// Section 3b pins down the one gap a triangle soup cannot close (a rotate
// TWISTS quads apart, indistinguishable from a real crease) so the topology
// workstream has a number to beat.
const h = require('./helpers.cjs');

const editBox = (page, cmd = '/create Box 1 1 1') =>
	page.evaluate((c) => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand(c);
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		s.faceEdit.enterFaceEdit(window.__box.uuid);
		s.faceEdit.setFaceSubmode('faces');
		return window.__box.uuid;
	}, cmd);

// quads whose two triangles are BOTH in the given tri list
const quadStats = (page) =>
	page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		const tris = fe.readTriangles(window.__box.geometry);
		let sel;
		fe.faceEditSelectedTris.subscribe((v) => (sel = [...v]))();
		const pairs = new Set();
		let lone = 0;
		for (let i = 0; i < tris.length; i++) {
			const q = fe.quadOfTriangle(i);
			if (q.length === 2) pairs.add(Math.min(q[0], q[1]));
			else lone++;
		}
		return { tris: tris.length, quads: pairs.size, lone, sel: sel.length };
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ============================= 1. loop cut: axis from the SELECTION
	await editBox(A.page);
	// Cut the SAME box twice from scratch, once with each of the two loops
	// through triangle 0 selected, never calling selectFaceLoop (so no
	// module-level axis can have been set). The two results must DIFFER — that
	// is exactly what "the axis comes from the selection" means, and both runs
	// used to produce the same cut because loopAxis was whatever was left over.
	const fingerprint = async (which) => {
		await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
		await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
		await editBox(A.page);
		return A.page.evaluate((w) => {
			const fe = window.__stores.faceEdit;
			const ring = fe.faceLoopTris(0, w);
			fe.faceEditSelectedTris.set(ring);
			const ok = fe.commitFaceOp('loopcut', 1);
			// the mid-plane vertices the cut introduced, as a stable signature
			const pts = [];
			for (const t of fe.readTriangles(window.__box.geometry))
				for (const v of t)
					pts.push(
						[v.x, v.y, v.z].map((n) => Math.round(n * 1000) / 1000).join(',')
					);
			return { ok, sig: [...new Set(pts)].sort().join(' '), ringQuads: ring.length / 2 };
		}, which);
	};
	const cutA = await fingerprint(0);
	const cutB = await fingerprint(1);
	h.check(cutA.ok && cutB.ok, 'loop cut commits from a selection made without Loop select');
	h.check(cutA.ringQuads > 1 && cutB.ringQuads > 1, 'both loops are real rings (premise)');
	h.check(cutA.sig !== cutB.sig, 'the cut follows the SELECTED loop, not a leftover axis');

	// the new band is selected, the hover is cleared, and nothing scattered
	const cut = await quadStats(A.page);
	const hover = await A.page.evaluate(
		() => new Promise((r) => window.__stores.faceEdit.faceEditHoverTri.subscribe(r)())
	);
	h.check(cut.sel > 0, `loop cut leaves the NEW band selected (${cut.sel} tris)`);
	h.check(cut.sel % 2 === 0, '...an even number of triangles, i.e. whole quads');
	const bandWhole = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		let sel;
		fe.faceEditSelectedTris.subscribe((v) => (sel = [...v]))();
		const set = new Set(sel);
		// every selected triangle's quad partner must be selected too - a stale
		// index set would scatter across unrelated triangles
		return sel.every((ti) => {
			const q = fe.quadOfTriangle(ti);
			return q.length === 2 && q.every((t) => set.has(t));
		});
	});
	h.check(bandWhole, '...and every selected triangle keeps its quad mate (no scatter)');
	h.check(hover === -1, 'the hover triangle is cleared, so nothing extra stays lit');

	// ============================= 2. quad-aware subdivide
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await editBox(A.page);
	const sub = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.setFaceGranularity('quad');
		fe.pickFaceUnit(0); // one quad = 2 tris
		const ok = fe.commitFaceOp('subdivide', 0);
		let sel;
		fe.faceEditSelectedTris.subscribe((v) => (sel = [...v]))();
		const set = new Set(sel);
		const pairs = new Set();
		let lone = 0;
		for (const ti of sel) {
			const q = fe.quadOfTriangle(ti);
			if (q.length === 2 && q.every((t) => set.has(t))) pairs.add(Math.min(q[0], q[1]));
			else lone++;
		}
		return { ok, sel: sel.length, quads: pairs.size, lone };
	});
	h.check(sub.ok === true, 'subdivide commits on a quad');
	h.check(sub.sel === 8, 'one quad becomes 8 triangles (premise)');
	h.check(sub.quads === 4 && sub.lone === 0, `...forming exactly 4 quads, no pinwheel (${sub.quads} quads, ${sub.lone} lone)`);

	// and a loop through one of the new sub-quads walks a real ring
	const subLoop = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		let sel;
		fe.faceEditSelectedTris.subscribe((v) => (sel = [...v]))();
		fe.faceEditSelectedTris.set([sel[0]]);
		const ok = fe.selectFaceLoop();
		let loop;
		fe.faceEditSelectedTris.subscribe((v) => (loop = [...v]))();
		return { ok, loop: loop.length };
	});
	h.check(subLoop.ok === true, 'Loop select works on a sub-quad of a subdivided face');
	h.check(subLoop.loop >= 2, `...and returns a ring, not a single triangle (${subLoop.loop} tris)`);

	// a lone (unpaired) triangle still takes the 4-way split
	const loneSplit = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		const before = fe.readTriangles(window.__box.geometry).length;
		fe.setFaceGranularity('triangle');
		fe.pickFaceUnit(0);
		fe.commitFaceOp('subdivide', 0);
		return { before, after: fe.readTriangles(window.__box.geometry).length };
	});
	h.check(loneSplit.after === loneSplit.before + 3, 'a single triangle still splits 4-way (+3 tris)');

	// ============================= 3. the user's scenario: extrude x2, scale, loop
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await editBox(A.page);
	const scenario = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.setFaceGranularity('quad');
		// pick the TOP quad and extrude it twice: two stacked wall bands
		const tris = fe.readTriangles(window.__box.geometry);
		const topTri = tris.findIndex((t) => t.every((v) => v.y > 0.49));
		fe.pickFaceUnit(topTri);
		const e1 = fe.commitFaceOp('extrude', 0.4);
		const e2 = fe.commitFaceOp('extrude', 0.4);
		// scale the cap so the top band becomes a TRAPEZOID - the bend that used
		// to push those quads past the coplanarity gate and out of the topology
		let sel;
		fe.faceEditSelectedTris.subscribe((v) => (sel = [...v]))();
		const THREE = window.__stores.THREE;
		// a SYNTHESIZED target, the way the gizmo seats one (the granularity-aware
		// path) — a bare face index would grab the coplanar group instead
		const normal = fe.currentFaces()[fe.faceIndexForTriangle(sel[0])]?.normal.clone();
		const centroid = new THREE.Vector3();
		let count = 0;
		for (const ti of sel)
			for (const v of fe.readTriangles(window.__box.geometry)[ti]) (centroid.add(v), count++);
		centroid.divideScalar(count || 1);
		fe.beginFaceGrab({ triIndices: [...sel], normal, centroid });
		fe.applyFaceGrab({ scale: new THREE.Vector3(1.3, 1, 1.3) });
		fe.commitFaceGrab();
		// now loop-select a vertical ring on a WALL
		const after = fe.readTriangles(window.__box.geometry);
		const wallTri = after.findIndex((t) => t.every((v) => v.x > 0.49));
		fe.faceEditSelectedTris.set([]);
		fe.faceEditHoverTri.set(wallTri >= 0 ? wallTri : 0);
		const looped = fe.selectFaceLoop();
		let ring;
		fe.faceEditSelectedTris.subscribe((v) => (ring = [...v]))();
		// how many DISTINCT heights does the ring span? one band = 2 planes,
		// the whole stack = 4
		const ys = new Set();
		for (const ti of ring) for (const v of after[ti]) ys.add(Math.round(v.y * 100) / 100);
		const cutOk = fe.commitFaceOp('loopcut', 1);
		return { e1, e2, looped, ring: ring.length, heights: ys.size, cutOk, wallTri };
	});
	h.check(scenario.e1 && scenario.e2, 'two stacked extrudes commit (premise)');
	h.check(scenario.wallTri >= 0, 'found a wall triangle after the scale (premise)');
	h.check(scenario.looped === true, 'loop select still works after extrude x2 + a scale');
	h.check(scenario.ring >= 4, `...and returns a real ring (${scenario.ring} tris)`);
	h.check(scenario.cutOk === true, 'loop cut through that ring commits');

	// ============================= 4. one undo per op, geometry restored
	const undoOne = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		const before = fe.readTriangles(window.__box.geometry).length;
		window.__stores.history.undo();
		return { before, after: fe.readTriangles(window.__box.geometry).length };
	});
	h.check(undoOne.after < undoOne.before, 'ONE undo takes the loop cut back out');

	// ===================== 3b. KNOWN LIMITATION, pinned down deliberately
	// A rigid ROTATE twists each wall quad: a 4-degree turn makes its two
	// triangles diverge by ~9 (measured here), which in a triangle SOUP is
	// indistinguishable from a genuine 9-degree crease — so pairQuads drops
	// them and the loop walk has nothing to follow. No threshold fixes it: one
	// loose enough to keep a twisted quad also pairs across the segments of a
	// smooth sphere. This check RECORDS the boundary rather than asserting the
	// bug is gone, so the topology workstream has a number to beat.
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await editBox(A.page);
	const bent = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		const THREE = window.__stores.THREE;
		fe.setFaceGranularity('quad');
		const tris = fe.readTriangles(window.__box.geometry);
		const topTri = tris.findIndex((t) => t.every((v) => v.y > 0.49));
		fe.pickFaceUnit(topTri);
		fe.commitFaceOp('extrude', 0.5);
		let sel;
		fe.faceEditSelectedTris.subscribe((v) => (sel = [...v]))();
		const live = fe.readTriangles(window.__box.geometry);
		const normal = fe.currentFaces()[fe.faceIndexForTriangle(sel[0])]?.normal.clone();
		const centroid = new THREE.Vector3();
		let count = 0;
		for (const ti of sel) for (const v of live[ti]) (centroid.add(v), count++);
		centroid.divideScalar(count || 1);
		// ~4 degrees about Y: every wall quad becomes a slightly twisted rectangle
		fe.beginFaceGrab({ triIndices: [...sel], normal, centroid });
		fe.applyFaceGrab({
			dQuat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.07)
		});
		fe.commitFaceGrab();
		// how many of the WALL triangles (those spanning the extruded band) are
		// still quad-paired? unpaired walls are invisible to every loop tool
		const after = fe.readTriangles(window.__box.geometry);
		let wall = 0;
		let paired = 0;
		after.forEach((t, ti) => {
			const ys = t.map((v) => v.y);
			if (Math.max(...ys) > 0.9 && Math.min(...ys) < 0.6) {
				wall++;
				if (fe.quadOfTriangle(ti).length === 2) paired++;
			}
		});
		// and a loop through one of them still walks the band
		const wallTri = after.findIndex((t) => {
			const ys = t.map((v) => v.y);
			return Math.max(...ys) > 0.9 && Math.min(...ys) < 0.6;
		});
		fe.faceEditSelectedTris.set([]);
		fe.faceEditHoverTri.set(wallTri);
		const looped = fe.selectFaceLoop();
		let ring;
		fe.faceEditSelectedTris.subscribe((v) => (ring = [...v]))();
		// how far apart the twisted quad's two triangles actually point
		const nrm = (t) =>
			t[1].clone().sub(t[0]).cross(t[2].clone().sub(t[0])).normalize();
		const keyOf = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e4)).join(',');
		const shared = new Map();
		after.forEach((t, ti) => {
			const ys = t.map((v) => v.y);
			if (!(Math.max(...ys) > 0.9 && Math.min(...ys) < 0.6)) return;
			for (let e = 0; e < 3; e++) {
				const [a, b] = [keyOf(t[e]), keyOf(t[(e + 1) % 3])].sort();
				const k = a + '|' + b;
				if (!shared.has(k)) shared.set(k, []);
				shared.get(k).push(ti);
			}
		});
		let twist = 1;
		for (const list of shared.values())
			if (list.length === 2) twist = Math.min(twist, nrm(after[list[0]]).dot(nrm(after[list[1]])));
		return { wall, paired, looped, ring: ring.length, twist };
	});
	h.check(bent.wall >= 8, `the rotated extrusion has wall triangles (premise, ${bent.wall})`);
	h.check(
		bent.twist < 0.995,
		`a 4-degree rotate twists wall quads past any safe pairing threshold (dot ${bent.twist.toFixed(4)})`
	);
	h.check(
		bent.paired === 0,
		`...so they leave the quad topology — the documented soup limitation (${bent.paired}/${bent.wall} paired)`
	);
	h.check(
		bent.looped === false || bent.ring <= 2,
		'loop select declines rather than walking a wrong band there'
	);

	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await h.finish(browser);
});
