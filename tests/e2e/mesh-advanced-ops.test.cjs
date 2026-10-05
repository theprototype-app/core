// 19-A P6 (36-mesh-ops): the risky operators, driven through the REAL toolbox.
//
//   EDGE SLIDE  — an adjust-engine op: a loop-cut ring slides along its rails, both
//                 signs land on the derived halfway line, ONE undo restores the soup.
//   CONNECT     — two corners of one face (button and J) split it into two faces;
//                 neighbours are refused by rule.
//   DISSOLVE    — a box corner's three quads become one face, the mesh stays closed.
//   FILL HOLE   — ONE rim edge of an opened box fills its whole hole (button and F),
//                 wound with its neighbours: closed and outward again.
//   SOLIDIFY    — an adjust-engine op: the opened box gets walls of the scrubbed
//                 thickness, closed + consistently wound; a patch of a closed box is
//                 refused (it would make three-face edges).
//   TWO PEERS   — B holds A's settled solidify byte for byte.
//   SEPARATE    — (P6b) see the second half of this file.
//
// The pure cores carry their own unit suite (tests/unit/meshOpsP6.test.js); this one
// proves the wiring: buttons, panes, hotkeys, the engine's ONE entry, replication.
// Every expected number is DERIVED from the fixture in-test.
const h = require('./helpers.cjs');

/** the object, wherever it lives */
const objectOf = (page, uuid) =>
	page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return !!g.getObjectByProperty('uuid', uuid);
	}, uuid);

/** geometry facts in one round trip: soup, tri count, odd + same-way edges,
 * signed volume, stored face sizes */
const facts = (page, uuid) =>
	page.evaluate((uuid) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		if (!object?.geometry) return null;
		const tris = s.faceEdit.readTriangles(object.geometry);
		const keyOf = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
		const use = new Map();
		const dir = new Set();
		let sameWay = 0;
		let volume = 0;
		for (const t of tris) {
			volume += t[0].dot(t[1].clone().cross(t[2])) / 6;
			for (let e = 0; e < 3; e++) {
				const a = keyOf(t[e]);
				const b = keyOf(t[(e + 1) % 3]);
				const k = a < b ? a + '|' + b : b + '|' + a;
				use.set(k, (use.get(k) || 0) + 1);
				if (dir.has(a + '>' + b)) sameWay++;
				dir.add(a + '>' + b);
			}
		}
		let odd = 0;
		for (const n of use.values()) if (n !== 2) odd++;
		const faces = s.meshTopology.readStoredFaces(object.geometry);
		let sum = 0;
		const pos = object.geometry.attributes.position.array;
		for (let i = 0; i < pos.length; i++) sum += pos[i] * ((i % 97) + 1);
		return {
			soup: s.faceEdit.trisToPositions(tris).map((n) => n.toFixed(4)).join(','),
			tris: tris.length,
			odd,
			sameWay,
			volume,
			faces: faces ? faces.map((f) => f.length).sort((a, b) => a - b).join(',') : '',
			faceCount: faces ? faces.length : 0,
			keys: [...new Set(tris.flatMap((t) => t.map(keyOf)))],
			checksum: Math.round(sum * 1e3) / 1e3
		};
	}, uuid);

const freshBox = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		s.faceEdit.exitFaceEdit?.();
		s.meshEdit.exitEditMode?.();
		// granularity is a PERSISTED pick setting — a section that switched to Object
		// must not turn the next section's quad pick into the whole mesh
		s.faceEdit.setFaceGranularity('quad');
		s.commandsHandler.sceneCommand('/clear all');
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		return g.children[g.children.length - 1].uuid;
	});

/** vertex mode on `uuid`, selecting the handles at the given LOCAL corners (first =
 * plain click, the rest Ctrl+click) — handle indices are found by position */
const pickVerts = (page, uuid, corners) =>
	page.evaluate(
		({ uuid, corners }) => {
			const s = window.__stores;
			s.meshEdit.enterEditMode(uuid);
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const object = g.getObjectByProperty('uuid', uuid);
			const found = [];
			for (const c of corners) {
				let hit = -1;
				for (let i = 0; i < 400; i++) {
					s.meshEdit.selectHandle(i);
					const w = s.meshEdit.vertexSelectionWorldPoint();
					if (!w) break;
					const l = object.worldToLocal(w.clone());
					if (Math.abs(l.x - c[0]) + Math.abs(l.y - c[1]) + Math.abs(l.z - c[2]) < 1e-4) {
						hit = i;
						break;
					}
				}
				found.push(hit);
			}
			if (found.some((i) => i < 0)) return { found, size: -1 };
			s.meshEdit.selectHandle(found[0]);
			for (const i of found.slice(1)) s.meshEdit.toggleVertexSelection(i);
			let size = 0;
			s.meshEdit.vertexSelectionSize.subscribe((v) => (size = v))();
			return { found, size };
		},
		{ uuid, corners }
	);

const adjustOp = (page) =>
	page.evaluate(() => {
		let v = null;
		window.__stores.faceEdit.opAdjustState.subscribe((x) => (v = x))();
		return v?.op ?? null;
	});

const undo = (page) => page.evaluate(() => window.__stores.history.undo());

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ======================================================== 1. EDGE SLIDE
	// a box split once across its width: the x = 0 line runs round four faces as a
	// closed loop of valence-4 vertices — the case slide is for. (A LOOP CUT on a bare
	// box is not this: its flanking quads keep their full edge, T-junctions by design.)
	let uuid = await A.page.evaluate(() => {
		const s = window.__stores;
		s.faceEdit.exitFaceEdit?.();
		s.meshEdit.exitEditMode?.();
		s.commandsHandler.sceneCommand('/clear all');
		s.commandsHandler.sceneCommand('/create Box 1 1 1 2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const uuid = g.children[g.children.length - 1].uuid;
		s.faceEdit.enterFaceEdit(uuid);
		return uuid;
	});
	const ring = await A.page.evaluate((uuid) => {
		const fe = window.__stores.faceEdit;
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const tris = fe.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
		const keyOf = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
		const axis = 'x';
		const onPlane = (v) => Math.abs(v.x) < 1e-6;
		const edges = new Set();
		for (const t of tris)
			for (let e = 0; e < 3; e++) {
				const p = t[e];
				const q = t[(e + 1) % 3];
				if (!onPlane(p) || !onPlane(q)) continue;
				const a = keyOf(p);
				const b = keyOf(q);
				edges.add(a < b ? a + '|' + b : b + '|' + a);
			}
		// no quad diagonal lies in x = 0, so these are exactly the loop's four edges
		fe.setFaceSubmode('edges');
		fe.clearEdgeSelection();
		for (const k of edges) fe.pickEdge(k, true);
		let sel;
		fe.edgeEditSelected.subscribe((v) => (sel = v))();
		return { axis, edges: [...edges], picked: sel.length };
	}, uuid);
	h.check(ring.edges.length === 4, `the x = 0 loop = 4 edges (${ring.edges.length})`);
	h.check(ring.picked === 4, 'all four ring edges picked');
	const preSlide = await facts(A.page, uuid);
	h.check(preSlide.odd === 0, 'premise: the split box is watertight');

	h.check((await A.page.locator('#edge-slide').count()) === 1, 'the edges Tools row has #edge-slide');
	await A.page.click('#edge-slide');
	await A.page.waitForTimeout(300);
	h.check((await adjustOp(A.page)) === 'edge-slide', 'clicking Slide applies through the adjust engine');
	h.check(
		(await A.page.locator('#edge-slide-params').count()) === 1,
		'...and the pane is the live edge-slide adjust (#edge-slide-params)'
	);
	h.check((await A.page.locator('#mesh-adjust-revert').count()) === 1, '...with ✕ Revert');
	const slid = await A.page.evaluate(
		({ uuid, axis }) => {
			const fe = window.__stores.faceEdit;
			fe.reapplyOpAdjust({ factor: 0.3 });
			fe.reapplyOpAdjust({ factor: 0.5 });
			fe.settleOpAdjust();
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const tris = fe.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
			// every vertex is now on the 4 box planes ±0.5 OR on the slid ring
			const levels = new Set();
			for (const t of tris) for (const v of t) if (Math.abs(Math.abs(v[axis]) - 0.5) > 1e-6) levels.add(v[axis].toFixed(4));
			let sel;
			fe.edgeEditSelected.subscribe((v) => (sel = v))();
			return { levels: [...levels], selected: sel.filter((k) => !!fe.edgeEndpoints(k)).length };
		},
		{ uuid, axis: ring.axis }
	);
	h.check(
		slid.levels.length === 1 && Math.abs(Math.abs(Number(slid.levels[0])) - 0.25) < 1e-4,
		`factor 0.5 lands the whole ring halfway to one neighbour line (${slid.levels})`
	);
	h.check(slid.selected === 4, 'the slid ring stays selected (keys follow the new positions)');
	const afterSlide = await facts(A.page, uuid);
	h.check(afterSlide.odd === 0 && afterSlide.sameWay === 0, 'still watertight and consistently wound');
	h.check(afterSlide.tris === preSlide.tris, `slide never changes the triangle count (${afterSlide.tris})`);
	h.check(afterSlide.faces === preSlide.faces, 'every stored face keeps its triangles');
	await undo(A.page);
	h.check((await facts(A.page, uuid)).soup === preSlide.soup, 'ONE undo restores the exact pre-slide soup');
	const other = await A.page.evaluate(
		({ uuid, edges, axis }) => {
			const fe = window.__stores.faceEdit;
			fe.clearEdgeSelection();
			for (const k of edges) fe.pickEdge(k, true);
			const ok = fe.beginOpAdjust('edge-slide', { factor: -0.5 });
			fe.settleOpAdjust();
			fe.endOpAdjust();
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const tris = fe.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
			const levels = new Set();
			for (const t of tris) for (const v of t) if (Math.abs(Math.abs(v[axis]) - 0.5) > 1e-6) levels.add(v[axis].toFixed(4));
			return { ok, levels: [...levels] };
		},
		{ uuid, edges: ring.edges, axis: ring.axis }
	);
	h.check(
		other.ok && other.levels.length === 1 && Number(other.levels[0]) === -Number(slid.levels[0]),
		`factor -0.5 slides the OTHER way (${other.levels} vs ${slid.levels})`
	);
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());

	// =========================================================== 2. CONNECT
	uuid = await freshBox(A.page);
	const pre = await facts(A.page, uuid);
	let picked = await pickVerts(A.page, uuid, [
		[-0.5, 0.5, -0.5],
		[0.5, 0.5, 0.5]
	]);
	h.check(picked.size === 2, `two opposite top corners picked (handles ${picked.found})`);
	h.check((await A.page.locator('#mesh-connect').count()) === 1, 'the vertices Tools row has #mesh-connect');
	await A.page.click('#mesh-connect');
	let f = await facts(A.page, uuid);
	h.check(f.tris === 12, `connect creates no vertex and no triangle (${f.tris})`);
	h.check(f.faceCount === 7, `the top quad is TWO faces now: 7 stored faces (${f.faces})`);
	h.check(f.odd === 0 && f.sameWay === 0 && Math.abs(f.volume - 1) < 1e-6, 'closed, consistently wound, volume 1');
	await undo(A.page);
	h.check((await facts(A.page, uuid)).soup === pre.soup, 'ONE undo restores the box');
	picked = await pickVerts(A.page, uuid, [
		[-0.5, 0.5, -0.5],
		[0.5, 0.5, 0.5]
	]);
	h.check(picked.size === 2, 'the pair is picked again for the hotkey');
	await A.page.keyboard.press('j');
	await A.page.waitForTimeout(200);
	const viaJ = await facts(A.page, uuid);
	h.check(viaJ.faceCount === 7, `J connects the same pair (the hotkey path; ${viaJ.faces})`);
	await undo(A.page);
	picked = await pickVerts(A.page, uuid, [
		[-0.5, 0.5, -0.5],
		[0.5, 0.5, -0.5]
	]);
	const refused = await A.page.evaluate(() => window.__stores.meshEdit.connectSelectedVerts());
	h.check(refused === false, 'two corners that already share an edge are refused');
	h.check((await facts(A.page, uuid)).soup === pre.soup, '...and the mesh is untouched');
	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());

	// ========================================================== 3. DISSOLVE
	uuid = await freshBox(A.page);
	const preD = await facts(A.page, uuid);
	picked = await pickVerts(A.page, uuid, [[0.5, 0.5, 0.5]]);
	h.check(picked.size === 1, 'the corner handle is picked');
	await A.page.click('#mesh-dissolve-verts');
	f = await facts(A.page, uuid);
	h.check(f.tris === 10, `three quads -> one hexagon of 4 triangles: 12 -> ${f.tris}`);
	h.check(!f.keys.includes('5000,5000,5000'), 'the corner vertex is gone');
	h.check(f.faces.split(',').includes('4'), `the hexagon is ONE stored face (${f.faces})`);
	h.check(f.odd === 0 && f.sameWay === 0 && f.volume > 0, 'still closed, consistently wound and outward');
	await undo(A.page);
	h.check((await facts(A.page, uuid)).soup === preD.soup, 'ONE undo restores the corner');
	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());

	// ========================================================= 4. FILL HOLE
	uuid = await freshBox(A.page);
	const opened = await A.page.evaluate((uuid) => {
		const fe = window.__stores.faceEdit;
		fe.enterFaceEdit(uuid);
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const tris = fe.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
		const top = tris.findIndex((t) => t.every((v) => Math.abs(v.y - 0.5) < 1e-6));
		fe.highlightFaceByTriangle(top);
		fe.pickFaceUnit(top);
		return fe.commitFaceOp('delete', 0);
	}, uuid);
	h.check(opened === true, 'premise: the top quad is deleted');
	const holed = await facts(A.page, uuid);
	h.check(holed.odd === 4 && holed.tris === 10, `premise: a 4-edge hole (${holed.odd} open edges)`);
	const rimEdge = '-5000,5000,5000|5000,5000,5000';
	await A.page.evaluate((k) => {
		const fe = window.__stores.faceEdit;
		fe.setFaceSubmode('edges');
		fe.clearEdgeSelection();
		fe.pickEdge(k);
	}, rimEdge);
	h.check((await A.page.locator('#edge-fill').count()) === 1, 'the edges Tools row has #edge-fill');
	await A.page.click('#edge-fill');
	f = await facts(A.page, uuid);
	h.check(f.tris === 12, `ONE rim edge fills its whole hole with a convex quad cap (${f.tris} tris)`);
	h.check(f.odd === 0 && f.sameWay === 0 && Math.abs(f.volume - 1) < 1e-6, 'closed, wound with its neighbours, volume 1');
	h.check(f.faceCount === 6, `the cap is ONE face (${f.faces})`);
	await undo(A.page);
	h.check((await facts(A.page, uuid)).odd === 4, 'ONE undo reopens the hole');
	await A.page.evaluate((k) => {
		const fe = window.__stores.faceEdit;
		fe.clearEdgeSelection();
		fe.pickEdge(k);
	}, rimEdge);
	await A.page.keyboard.press('f');
	await A.page.waitForTimeout(200);
	h.check((await facts(A.page, uuid)).odd === 0, 'F fills it too (the hotkey path)');
	await undo(A.page);
	const interior = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.clearEdgeSelection();
		fe.pickEdge('-5000,-5000,-5000|5000,-5000,-5000');
		return fe.fillHole();
	});
	h.check(interior === false, 'an interior edge is refused (Fill needs BORDER edges)');

	// ========================================================== 5. SOLIDIFY
	const preS = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.setFaceSubmode('faces');
		fe.setFaceGranularity('object');
		fe.selectAllFaces();
		let sel;
		fe.faceEditSelectedTris.subscribe((v) => (sel = v))();
		return sel.length;
	});
	h.check(preS === 10, `the whole opened box is selected (${preS} tris)`);
	const preSol = await facts(A.page, uuid);
	h.check((await A.page.locator('#mesh-op-solidify').count()) === 1, 'the faces Operations grid has Solidify');
	await A.page.click('#mesh-op-solidify');
	await A.page.waitForTimeout(300);
	h.check((await adjustOp(A.page)) === 'solidify', 'clicking Solidify applies through the adjust engine');
	h.check((await A.page.locator('#solidify-params').count()) === 1, '...and opens its live pane');
	await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.reapplyOpAdjust({ thickness: 0.2 });
		fe.reapplyOpAdjust({ thickness: 0.05 });
		fe.settleOpAdjust();
	});
	f = await facts(A.page, uuid);
	h.check(f.tris === 10 + 10 + 4 * 2, `front + back + a 4-quad rim: ${f.tris} tris`);
	h.check(f.odd === 0 && f.sameWay === 0, 'the walls are closed and consistently wound');
	// the open box's inner + outer walls enclose (1 - (1-2t)^2 (1-t)) of material,
	// the back copy sits t INSIDE every wall — positive volume, smaller than the box
	h.check(f.volume > 0 && f.volume < 1, `the shell encloses a positive volume under 1 (${f.volume.toFixed(4)})`);
	await undo(A.page);
	h.check((await facts(A.page, uuid)).soup === preSol.soup, 'ONE undo removes the back AND the rim');
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	uuid = await freshBox(A.page);
	const patch = await A.page.evaluate((uuid) => {
		const fe = window.__stores.faceEdit;
		fe.enterFaceEdit(uuid);
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const tris = fe.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
		const top = tris.findIndex((t) => t.every((v) => Math.abs(v.y - 0.5) < 1e-6));
		fe.highlightFaceByTriangle(top);
		fe.pickFaceUnit(top);
		return fe.beginOpAdjust('solidify', { thickness: 0.1 });
	}, uuid);
	h.check(patch === false, 'a patch of a closed box is refused (its rim would make three-face edges)');
	h.check((await facts(A.page, uuid)).tris === 12, '...and nothing changed');
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());

	// ===================================== 5b. P7c: mitered corner + vertex segments
	// an octahedron has FOUR faces at every vertex — the case the edge bevel used to
	// refuse. Through the real button at 3 segments: watertight and wound outward.
	uuid = await A.page.evaluate(() => {
		const s = window.__stores;
		s.faceEdit.exitFaceEdit?.();
		s.meshEdit.exitEditMode?.();
		s.commandsHandler.sceneCommand('/clear all');
		s.commandsHandler.sceneCommand('/create Octahedron 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const uuid = g.children[g.children.length - 1].uuid;
		s.faceEdit.enterFaceEdit(uuid);
		s.faceEdit.setFaceSubmode('edges');
		const tris = s.faceEdit.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
		const keyOf = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
		const a = keyOf(tris[0][0]);
		const b = keyOf(tris[0][1]);
		s.faceEdit.clearEdgeSelection();
		s.faceEdit.pickEdge(a < b ? a + '|' + b : b + '|' + a);
		s.meshToolParams.bevelSegments.set(3);
		s.meshToolParams.bevelProfile.set(0);
		return uuid;
	});
	const preOct = await facts(A.page, uuid);
	await A.page.click('#edge-bevel');
	await A.page.waitForTimeout(300);
	f = await facts(A.page, uuid);
	h.check(f.tris > preOct.tris, `the valence-4 edge bevels now (${preOct.tris} -> ${f.tris} tris)`);
	h.check(f.odd === 0 && f.sameWay === 0, 'mitered at both ends: watertight and consistently wound');
	h.check(f.volume > 0 && f.volume < preOct.volume, `the chamfer removed material (${preOct.volume.toFixed(4)} -> ${f.volume.toFixed(4)})`);
	await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		for (const n of [1, 2, 5, 8]) fe.reapplyOpAdjust({ segments: n });
		fe.settleOpAdjust();
	});
	f = await facts(A.page, uuid);
	h.check(f.odd === 0 && f.sameWay === 0, 'scrubbed through 1/2/5/8 segments and settled at 8: still watertight');
	await undo(A.page);
	h.check((await facts(A.page, uuid)).soup === preOct.soup, 'ONE undo restores the octahedron');
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	// the vertex bevel's new SEGMENTS row, in vertex mode, on the octahedron's top
	picked = await pickVerts(A.page, uuid, [[0, 1, 0]]);
	h.check(picked.size === 1, 'the top vertex is picked');
	h.check((await A.page.locator('#mesh-vertex-bevel').count()) === 1, 'the vertex bevel button is there');
	await A.page.evaluate(() => window.__stores.meshToolParams.bevelProfile.set(1));
	await A.page.click('#mesh-vertex-bevel');
	await A.page.waitForTimeout(300);
	h.check((await A.page.locator('#bevel-segments').count()) === 1, 'vertex mode shows a segments row now');
	f = await facts(A.page, uuid);
	// 4 faces: their 4 corners -> 8 offsets; the cap: 4 * 2 * (3 - 1) ring tris + 4 fan tris
	h.check(f.tris === preOct.tris + 4 + 4 * 2 * 2 + 4, `3 segments round the cap: ${preOct.tris} -> ${f.tris} tris`);
	h.check(f.odd === 0 && f.sameWay === 0, 'the rounded corner is watertight');
	await undo(A.page);
	await A.page.evaluate(() => {
		window.__stores.meshEdit.exitEditMode();
		window.__stores.meshToolParams.resetToolParams();
	});

	// ========================================================= 6. TWO PEERS
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	uuid = await freshBox(A.page);
	await h.eventually(() => objectOf(B.page, uuid), (v) => v === true, 'B received the box (premise)', 20000);
	await A.page.evaluate((uuid) => {
		const fe = window.__stores.faceEdit;
		fe.enterFaceEdit(uuid);
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const tris = fe.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
		const top = tris.findIndex((t) => t.every((v) => Math.abs(v.y - 0.5) < 1e-6));
		fe.highlightFaceByTriangle(top);
		fe.pickFaceUnit(top);
		fe.commitFaceOp('delete', 0);
		fe.setFaceGranularity('object');
		fe.selectAllFaces();
		fe.beginOpAdjust('solidify', { thickness: 0.1 });
		fe.reapplyOpAdjust({ thickness: 0.15 });
		fe.settleOpAdjust();
	}, uuid);
	const finalA = await facts(A.page, uuid);
	h.check(finalA.tris === 28, `A settled the solidify (${finalA.tris} tris)`);
	await h.eventually(
		() => facts(B.page, uuid),
		(v) => v && v.tris === finalA.tris && v.checksum === finalA.checksum,
		`B holds A's settled geometry (checksum ${finalA.checksum})`,
		20000
	);
	const bFaces = await facts(B.page, uuid);
	h.check(bFaces.faces === finalA.faces, `...and A's authored partition rode the topology channel (${bFaces.faces})`);
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());

	// ============================================ 7. SEPARATE (P6b, replication)
	// the top quad leaves the box as a NEW object: an `object` create + a source
	// meshgeo, ONE undo step in the session, both replicated, a late joiner sees it
	uuid = await freshBox(A.page);
	await h.eventually(() => objectOf(B.page, uuid), (v) => v === true, 'B received the box to separate from', 20000);
	const childrenOf = (page) =>
		page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			return g.children.filter((c) => c.isMesh).map((c) => c.uuid);
		});
	await A.page.evaluate((uuid) => {
		const fe = window.__stores.faceEdit;
		fe.enterFaceEdit(uuid);
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const tris = fe.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
		const top = tris.findIndex((t) => t.every((v) => Math.abs(v.y - 0.5) < 1e-6));
		fe.highlightFaceByTriangle(top);
		fe.pickFaceUnit(top);
	}, uuid);
	h.check((await A.page.locator('#mesh-op-separate').count()) === 1, 'the faces Operations grid has Separate');
	const preSep = await facts(A.page, uuid);
	await A.page.click('#mesh-op-separate');
	await A.page.waitForTimeout(300);
	const kids = await childrenOf(A.page);
	const pieceUuid = kids.find((k) => k !== uuid);
	h.check(kids.length === 2 && !!pieceUuid, `a NEW object exists beside the box (${kids.length} meshes)`);
	const piece = await facts(A.page, pieceUuid);
	const src = await facts(A.page, uuid);
	h.check(piece && piece.tris === 2, `the piece holds the top quad's 2 triangles (${piece?.tris})`);
	h.check(piece && piece.faces === '2', `...as ONE stored quad face (${piece?.faces})`);
	h.check(src.tris === 10 && src.odd === 4, `the box lost exactly those faces: 10 tris, a 4-edge hole (${src.tris}/${src.odd})`);
	const pose = await A.page.evaluate(
		({ a, b }) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const x = g.getObjectByProperty('uuid', a);
			const y = g.getObjectByProperty('uuid', b);
			x.updateMatrixWorld();
			y.updateMatrixWorld();
			const same = x.matrixWorld.elements.every((v, i) => Math.abs(v - y.matrixWorld.elements[i]) < 1e-9);
			return { same, ownMaterial: x.material !== y.material, name: y.name };
		},
		{ a: uuid, b: pieceUuid }
	);
	h.check(pose.same, 'the piece sits on the SAME world matrix as its source');
	h.check(pose.ownMaterial, `...with its own material clone ("${pose.name}")`);
	await h.eventually(
		() => facts(B.page, pieceUuid),
		(v) => v && v.tris === 2 && v.checksum === piece.checksum,
		'B received the piece through the existing object message',
		20000
	);
	await h.eventually(
		() => facts(B.page, uuid),
		(v) => v && v.tris === 10 && v.checksum === src.checksum,
		"B's box lost the same faces (the source meshgeo)",
		20000
	);
	// ONE undo takes the piece back: the object goes AND the box is whole again
	await undo(A.page);
	h.check(!(await objectOf(A.page, pieceUuid)), 'ONE undo removes the piece...');
	h.check((await facts(A.page, uuid)).soup === preSep.soup, '...and restores the box in the SAME step');
	await h.eventually(() => objectOf(B.page, pieceUuid), (v) => v === false, 'B drops the piece on the undo', 20000);
	await h.eventually(() => facts(B.page, uuid), (v) => v && v.tris === 12, "B's box is whole again", 20000);
	await A.page.evaluate(() => window.__stores.history.redo());
	h.check(!!(await objectOf(A.page, pieceUuid)) && (await facts(A.page, uuid)).tris === 10, 'redo separates again (same uuid)');
	await h.eventually(() => objectOf(B.page, pieceUuid), (v) => v === true, 'B gets the piece back on redo', 20000);
	// Done seals the session: the mixed-kind run is ONE composite step after it
	await A.page.evaluate(() => {
		window.__stores.faceEdit.exitFaceEdit();
		window.__stores.editSession?.sealEditHistorySession?.();
	});
	const sealed = await A.page.evaluate(() => {
		let stack;
		window.__stores.history.undoStack.subscribe((v) => (stack = v))();
		return stack.length ? stack[stack.length - 1].kind : '';
	});
	h.check(['session', 'aibatch'].includes(sealed), `the sealed session is one composite entry (${sealed})`);
	// a LATE joiner sees the piece and the opened box from the ordinary scene walk
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	await h.eventually(() => facts(C.page, pieceUuid), (v) => v && v.tris === 2, 'a late joiner (C) gets the piece', 30000);
	await h.eventually(() => facts(C.page, uuid), (v) => v && v.tris === 10, '...and the box without those faces', 30000);
	await A.page.evaluate(() => window.__stores.history.undo());
	h.check(!(await objectOf(A.page, pieceUuid)) && (await facts(A.page, uuid)).tris === 12, 'after Done, ONE undo still reverts both halves');
	await h.eventually(() => objectOf(C.page, pieceUuid), (v) => v === false, '...on the late joiner too', 20000);

	await h.finish(browser);
});
