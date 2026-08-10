// 15-G follow-up 2: face ops on a multi-selection that spans SEPARATE SHELLS.
//
// Reported: merge two cubes standing side by side with a gap, multi-select the
// top face of each, Extrude — the two walls FACING EACH OTHER never appear.
//
// `opTargetFace()` synthesizes ONE face for a multi-selection, and its centroid
// lands in the empty gap between the shells. extrudeFace derived each wall's
// visible side from that centroid, so for the inner edges "away from the
// centroid" was the exact opposite of "away from the cube": those walls were
// wound inward and backface-culled. insetFace had the same flaw from the other
// end — both faces shrank toward the shared centroid, sliding into the gap
// instead of insetting in place.
//
// The walls' outward direction is now derived LOCALLY from each boundary edge
// (edge x its own triangle's normal), and inset works per connected component.
const h = require('./helpers.cjs');

/** N unit cubes in a row on X with a 1-unit gap, merged into one mesh.
 * Returns { uuid, centres } — centres are MESH-LOCAL x of each cube. */
const mergedRow = (page, n) =>
	page.evaluate(async (n) => {
		const w = window.__stores;
		const uuids = [];
		for (let i = 0; i < n; i++) {
			w.commandsHandler.sceneCommand('/create Box 1 1 1');
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const box = g.children[g.children.length - 1];
			box.position.set(i * 3, 0, 0); // 1-wide cubes, 2-wide gaps
			uuids.push(box.uuid);
		}
		const uuid = await w.objectActions.convertToMesh(uuids);
		// the merge sits at the FIRST cube, so local centres are 0, 3, 6, ...
		return { uuid, centres: uuids.map((_, i) => i * 3) };
	}, n);

/** enter face edit and multi-select every +Y face */
const selectAllTops = (page, uuid) =>
	page.evaluate((uuid) => {
		const w = window.__stores;
		w.faceEdit.enterFaceEdit(uuid);
		const tops = w.faceEdit.currentFaces().filter((f) => f.normal.y > 0.99);
		w.faceEdit.faceEditMulti.set(true);
		w.faceEdit.faceEditSelectedTris.set(tops.flatMap((f) => f.triIndices));
		return tops.length;
	}, uuid);

/** every triangle of a mesh as { c: centroid, n: normal, slot } */
const trianglesOf = (page, uuid) =>
	page.evaluate(async (uuid) => {
		const w = window.__stores;
		const T = w.THREE;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const mesh = g.getObjectByProperty('uuid', uuid);
		const pos = mesh.geometry.attributes.position;
		const slotAt = (i) => {
			const hit = mesh.geometry.groups.find((x) => i >= x.start && i < x.start + x.count);
			return hit ? hit.materialIndex : 0;
		};
		const out = [];
		for (let i = 0; i < pos.count; i += 3) {
			const p = [0, 1, 2].map((k) => new T.Vector3(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)));
			const n = new T.Vector3()
				.subVectors(p[1], p[0])
				.cross(new T.Vector3().subVectors(p[2], p[0]))
				.normalize();
			out.push({
				c: p[0].clone().add(p[1]).add(p[2]).multiplyScalar(1 / 3).toArray(),
				n: n.toArray(),
				slot: slotAt(i)
			});
		}
		return out;
	}, uuid);

/** the +Y faces' centroids and X extents, per face */
const topFaces = (page) =>
	page.evaluate(() =>
		window.__stores.faceEdit
			.currentFaces()
			.filter((f) => f.normal.y > 0.99)
			.map((f) => ({ x: +f.centroid.x.toFixed(3), z: +f.centroid.z.toFixed(3) }))
			.sort((p, q) => p.x - q.x)
	);

/**
 * Every SIDE wall of the extruded band must face away from the cube it belongs
 * to. A wall is assigned to the nearest cube centre; "outward" is the sign of
 * n . (c - centre) in the horizontal plane.
 */
function inwardWalls(tris, centres, bandMinY) {
	const bad = [];
	for (const t of tris) {
		const [cx, cy, cz] = t.c;
		const [nx, , nz] = t.n;
		if (cy < bandMinY) continue; // only the new band
		if (Math.abs(t.n[1]) > 0.5) continue; // skip the cap
		const centre = centres.reduce((best, x) => (Math.abs(x - cx) < Math.abs(best - cx) ? x : best), centres[0]);
		const dot = nx * (cx - centre) + nz * cz;
		if (dot <= 0) bad.push({ c: t.c.map((v) => +v.toFixed(2)), n: t.n.map((v) => +v.toFixed(2)), centre });
	}
	return bad;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ------------------------------------------- 1. the reported case: 2 cubes
	const two = await mergedRow(A.page, 2);
	const tops = await selectAllTops(A.page, two.uuid);
	h.check(tops === 2, 'both cube tops are multi-selected (premise, ' + tops + ')');

	const beforeTris = (await trianglesOf(A.page, two.uuid)).length;
	h.check(beforeTris === 24, 'the merged pair starts at 24 triangles (premise)');

	const extruded = await A.page.evaluate(() => window.__stores.faceEdit.commitFaceOp('extrude', 0.4));
	h.check(extruded === true, 'extrude commits on the two-shell selection');

	const after = await trianglesOf(A.page, two.uuid);
	// 24 + one wall quad (2 tris) per boundary edge: 4 edges per cube, 2 cubes
	h.check(after.length === 24 + 16, 'eight wall quads are stitched (' + after.length + ' tris)');

	const bad = inwardWalls(after, two.centres, 0.5);
	h.check(
		bad.length === 0,
		'THE BUG: every extrude wall faces away from its OWN cube (' + bad.length + ' inward: ' + JSON.stringify(bad.slice(0, 2)) + ')'
	);

	// name the two walls the user actually saw missing, so a regression is legible
	const wallAt = (x, sign) =>
		after.find(
			(t) => Math.abs(t.c[0] - x) < 0.01 && t.c[1] > 0.5 && Math.abs(t.n[0] - sign) < 0.01
		);
	h.check(!!wallAt(0.5, 1), 'the left cube\'s INNER wall faces +X (into the gap)');
	h.check(!!wallAt(2.5, -1), 'the right cube\'s INNER wall faces -X (into the gap)');
	h.check(!!wallAt(-0.5, -1) && !!wallAt(3.5, 1), '...and the outer walls still face outward');

	// each cube's walls carry that cube's own material slot
	const leftWall = wallAt(0.5, 1);
	const rightWall = wallAt(2.5, -1);
	h.check(
		leftWall?.slot === 0 && rightWall?.slot === 1,
		'each cube\'s walls take that cube\'s material slot (' +
			leftWall?.slot + '/' + rightWall?.slot + ')'
	);

	// ---------------------------------- 2. a MIDDLE shell (walls on both sides)
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const three = await mergedRow(A.page, 3);
	h.check((await selectAllTops(A.page, three.uuid)) === 3, 'three cube tops multi-selected (premise)');
	await A.page.evaluate(() => window.__stores.faceEdit.commitFaceOp('extrude', 0.4));
	const threeTris = await trianglesOf(A.page, three.uuid);
	const badThree = inwardWalls(threeTris, three.centres, 0.5);
	h.check(
		badThree.length === 0,
		'a MIDDLE shell gets outward walls on both sides too (' + badThree.length + ' inward)'
	);
	h.check(threeTris.length === 36 + 24, 'three cubes stitch twelve wall quads');

	// ------------------------------------------------------------- 3. inset
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const pair = await mergedRow(A.page, 2);
	await selectAllTops(A.page, pair.uuid);
	const insetBefore = await topFaces(A.page);
	h.check(
		insetBefore.length === 2 && insetBefore[0].x === 0 && insetBefore[1].x === 3,
		'the two top faces start centred on their own cubes (premise)'
	);
	await A.page.evaluate(() => window.__stores.faceEdit.commitFaceOp('inset', 0.3));
	const insetAfter = await topFaces(A.page);
	h.check(
		insetAfter.length === 2 &&
			Math.abs(insetAfter[0].x - 0) < 0.001 &&
			Math.abs(insetAfter[1].x - 3) < 0.001,
		'each face insets toward its OWN centre, neither slides into the gap (' +
			JSON.stringify(insetAfter.map((f) => f.x)) + ')'
	);
	// ...and it really shrank, SYMMETRICALLY about its own centre. The left cube
	// spans x -0.5..0.5, so a 0.3 inset must leave vertices at exactly +/-0.35.
	// Shrinking toward the shared centroid instead put them at 0.1 and 0.8.
	const insetXs = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const pos = g.getObjectByProperty('uuid', uuid).geometry.attributes.position;
		let topY = -Infinity;
		for (let i = 0; i < pos.count; i++) topY = Math.max(topY, pos.getY(i));
		const xs = new Set();
		for (let i = 0; i < pos.count; i++) {
			if (Math.abs(pos.getY(i) - topY) > 1e-4) continue;
			if (Math.abs(pos.getX(i)) > 1.5) continue; // the LEFT cube only
			xs.add(+pos.getX(i).toFixed(3));
		}
		return [...xs].sort((a, b) => a - b);
	}, pair.uuid);
	h.check(
		insetXs.includes(-0.35) && insetXs.includes(0.35),
		'the inset face shrinks symmetrically about its own centre (x ' + JSON.stringify(insetXs) + ')'
	);
	h.check(insetXs.includes(-0.5) && insetXs.includes(0.5), '...with the original boundary kept as the ring');

	// ------------------ 3b. BRIDGE must act on the SELECTION, not on the
	// coplanar groups it touches. Extruding a top leaves a wall COPLANAR with
	// the flat side beneath it, so groupFaces merges the two into one logical
	// face — picking just the wall band used to bridge the whole side of the
	// shell (the op-target rule: never expand a selection to faces[...]).
	const scenario = async () => {
		await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
		await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
		const row = await mergedRow(A.page, 2);
		await selectAllTops(A.page, row.uuid);
		await A.page.evaluate(() => window.__stores.faceEdit.commitFaceOp('extrude', 0.3));
		return row.uuid;
	};

	/** the +X / -X faces flanking the gap, as { minY, maxY, tris } */
	const innerSides = (page, uuid) =>
		page.evaluate(async (uuid) => {
			const w = window.__stores;
			const T = w.THREE;
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const pos = g.getObjectByProperty('uuid', uuid).geometry.attributes.position;
			const tri = (ti) =>
				[0, 1, 2].map((k) => new T.Vector3(pos.getX(ti * 3 + k), pos.getY(ti * 3 + k), pos.getZ(ti * 3 + k)));
			return w.faceEdit
				.currentFaces()
				.filter((f) => Math.abs(f.normal.x) > 0.99 && (Math.abs(f.centroid.x - 0.5) < 0.01 || Math.abs(f.centroid.x - 2.5) < 0.01))
				.map((f) => {
					const box = new T.Box3();
					f.triIndices.forEach((ti) => tri(ti).forEach((v) => box.expandByPoint(v)));
					return { x: +f.centroid.x.toFixed(2), maxY: +box.max.y.toFixed(2), tris: f.triIndices.length };
				})
				.sort((p, q) => p.x - q.x);
		}, uuid);

	// (i) TRIANGLE granularity, only the two 2-triangle wall bands selected
	const bandUuid = await scenario();
	const bandPick = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const T = w.THREE;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const pos = g.getObjectByProperty('uuid', uuid).geometry.attributes.position;
		const picked = [];
		for (let ti = 0; ti < pos.count / 3; ti++) {
			const p = [0, 1, 2].map((k) => new T.Vector3(pos.getX(ti * 3 + k), pos.getY(ti * 3 + k), pos.getZ(ti * 3 + k)));
			const c = p[0].clone().add(p[1]).add(p[2]).multiplyScalar(1 / 3);
			const n = new T.Vector3().subVectors(p[1], p[0]).cross(new T.Vector3().subVectors(p[2], p[0])).normalize();
			if (c.y <= 0.5 || Math.abs(n.x) < 0.99) continue;
			if (Math.abs(c.x - 0.5) < 0.01 || Math.abs(c.x - 2.5) < 0.01) picked.push(ti);
		}
		w.faceEdit.setFaceGranularity('triangle');
		w.faceEdit.faceEditMulti.set(true);
		w.faceEdit.faceEditSelectedTris.set(picked);
		return picked.length;
	}, bandUuid);
	h.check(bandPick === 4, 'the two extruded wall bands are 2 triangles each (premise, ' + bandPick + ')');

	const bandOk = await A.page.evaluate(() => window.__stores.faceEdit.bridgeFaces());
	h.check(bandOk === true, 'bridge commits on the two extruded bands');
	const bandSides = await innerSides(A.page, bandUuid);
	h.check(
		bandSides.length === 2 && bandSides.every((s) => s.maxY === 0.5 && s.tris === 2),
		'THE BUG: only the BAND is consumed — each inner side is left intact up to y 0.5 (' +
			JSON.stringify(bandSides) + ')'
	);
	// the tunnel really spans the gap: an underside at y 0.5 between the cubes
	const floor = await A.page.evaluate(() =>
		window.__stores.faceEdit
			.currentFaces()
			.filter((f) => f.normal.y < -0.99 && Math.abs(f.centroid.y - 0.5) < 0.01)
			.map((f) => +f.centroid.x.toFixed(2))
	);
	h.check(
		floor.length === 1 && Math.abs(floor[0] - 1.5) < 0.01,
		'the tunnel floor spans the gap between the cubes (x ' + JSON.stringify(floor) + ')'
	);

	// (ii) FACE granularity picks the WHOLE coplanar side, and bridging that
	// consumes the whole side — correct for THAT selection, and it must differ
	// from (i), which is the proof the selection is honoured
	const faceUuid = await scenario();
	await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		void g;
		const fs = w.faceEdit.currentFaces();
		const inner = fs.filter(
			(f) => Math.abs(f.normal.x) > 0.99 && (Math.abs(f.centroid.x - 0.5) < 0.01 || Math.abs(f.centroid.x - 2.5) < 0.01)
		);
		w.faceEdit.setFaceGranularity('face');
		w.faceEdit.faceEditMulti.set(true);
		w.faceEdit.faceEditSelectedTris.set(inner.flatMap((f) => f.triIndices));
	}, faceUuid);
	await A.page.evaluate(() => window.__stores.faceEdit.bridgeFaces());
	const faceSides = await innerSides(A.page, faceUuid);
	h.check(
		faceSides.length === 0,
		'a whole-face pick consumes the whole side (a DIFFERENT result — the selection decides)'
	);

	// (iii) two TOUCHING picks are refused with a clear message, not garbage
	await scenario();
	const touching = await A.page.evaluate(() => {
		const w = window.__stores;
		const fs = w.faceEdit.currentFaces();
		// the +X and +Z sides of the same cube share an edge
		const a = fs.find((f) => f.normal.x > 0.99 && f.centroid.x < 1.5);
		const b = fs.find((f) => f.normal.z > 0.99 && f.centroid.x < 1.5);
		w.faceEdit.faceEditMulti.set(true);
		w.faceEdit.faceEditSelectedTris.set([...a.triIndices, ...b.triIndices]);
		return w.faceEdit.bridgeFaces();
	});
	h.check(touching === false, 'two TOUCHING selections are refused rather than bridged into garbage');

	// -------------------------- 4. a plain single-face extrude is unchanged
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const plain = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		w.faceEdit.enterFaceEdit(box.uuid);
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.faceEditMulti.set(false);
		w.faceEdit.highlightFaceByTriangle(top.triIndices[0]);
		w.faceEdit.commitFaceOp('extrude', 0.4);
		w.faceEdit.exitFaceEdit();
		return box.uuid;
	});
	const plainTris = await trianglesOf(A.page, plain);
	h.check(plainTris.length === 12 + 8, 'a lone face still stitches four wall quads');
	h.check(
		inwardWalls(plainTris, [0], 0.5).length === 0,
		'a lone face\'s walls all face outward (unchanged behaviour)'
	);

	await h.finish(browser);
});
