// Roadmap 99 K5 (lane 99-live): LIVE EDITS WITHOUT A REBUILD, through the real app.
//   1. a face grab writes into ONE geometry for the whole drag (a session-private copy made at grab start, never the
//      entry geometry): same geometry, same position array, its version advancing per frame
//   2. only the touched normals change: every corner off the moved triangles' vertices keeps its normal bytes
//   3. the pick BVH is refitted during the drag, never rebuilt and never switched off
//   4. a cancelled grab puts the ORIGINAL geometry object back, bytes unchanged
//   5. a committed grab's undo brings back the exact pre-grab bytes AND the pick the grab started from (K4 rule)
//   6. a loop cut scrub that keeps the layout (one cut, the position scrubbed) writes in place: one geometry
//   7. the edge grab (edge submode) moves the edge's two vertex groups and keeps the edge selected
// Run with the mesh suites for a change to the face grab, the adjust engine, applyMeshGeo or bvhPicking.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const r = await A.page.evaluate(async () => {
		const s = window.__tp.test.v1;
		const fe = s.faceEdit;
		const get = (st) => {
			let v;
			st.subscribe((x) => (v = x))();
			return v;
		};
		const raf = () => new Promise((res) => requestAnimationFrame(res));
		// a 48 x 24 sphere (2208 triangles: over the BVH floor), non-indexed (flat normals after the swap), in a face session
		const ws = 48,
			hs = 24;
		const grid = [];
		for (let iy = 0; iy <= hs; iy++) {
			const row = [];
			for (let ix = 0; ix <= ws; ix++) {
				const u = ix / ws,
					v = iy / hs;
				row.push([-Math.cos(u * 2 * Math.PI) * Math.sin(v * Math.PI), Math.cos(v * Math.PI), Math.sin(u * 2 * Math.PI) * Math.sin(v * Math.PI)]);
			}
			grid.push(row);
		}
		const positions = [];
		for (let iy = 0; iy < hs; iy++)
			for (let ix = 0; ix < ws; ix++) {
				const a = grid[iy][ix + 1],
					b = grid[iy][ix],
					c = grid[iy + 1][ix],
					d = grid[iy + 1][ix + 1];
				if (iy !== 0) positions.push(...a, ...b, ...d);
				if (iy !== hs - 1) positions.push(...b, ...c, ...d);
			}
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = get(s.objectsGroup);
		const obj = g.children[g.children.length - 1];
		fe.applyMeshGeo(obj.uuid, positions);
		const V3 = obj.position.constructor;
		fe.enterFaceEdit(obj.uuid);
		fe.setFaceSubmode('faces');
		fe.setFaceGranularity('quad');
		for (let i = 0; i < 3; i++) await raf();
		const out = {};
		const faceNear = (x, y, z) => {
			const faces = fe.currentFaces();
			let best = -1,
				bd = Infinity;
			faces.forEach((f, i) => {
				const d = f.centroid.distanceTo(new V3(x, y, z));
				if (d < bd) (bd = d), (best = i);
			});
			return best;
		};
		const bytes = () => Array.from(obj.geometry.attributes.position.array).join(',');
		// 1-3. the grab writes in place
		const entryGeometry = obj.geometry;
		const fi = faceNear(1, 0.05, 0);
		const t0 = fe.currentFaces()[fi].triIndices[0];
		fe.pickFaceUnit(t0);
		const pickBefore = [...get(fe.faceEditSelectedTris)].sort((a, b) => a - b);
		const bytesBefore = bytes();
		const bvh0 = s.bvhPicking.bvhDebug();
		out.began = fe.beginFaceGrab(fi);
		const live = obj.geometry;
		out.copyNotEntry = live !== entryGeometry;
		const arr = live.attributes.position.array;
		const v0 = live.attributes.position.version;
		const n0 = Float32Array.from(live.attributes.normal.array);
		const ids = [];
		for (let i = 1; i <= 8; i++) {
			fe.applyFaceGrab({ dPos: new V3(0.02 * i, 0, 0) });
			ids.push(obj.geometry === live && obj.geometry.attributes.position.array === arr);
			// a pick through the scene (refits the BVH of the edited object)
			s.bvhPicking.ensureBoundsTrees(g, [], [obj.uuid]);
			await raf();
		}
		out.sameGeometry = ids.every(Boolean);
		out.versionAdvanced = live.attributes.position.version - v0;
		// 2. normals: which corners changed, and do they all sit on a vertex of a moved triangle
		const n1 = live.attributes.normal.array;
		const p1 = live.attributes.position.array;
		const key = (i) => [0, 1, 2].map((a) => Math.round(p1[i * 3 + a] * 1e4)).join('|');
		const movedTris = new Set();
		let changed = 0,
			offVertex = 0;
		const hotKeys = new Set();
		// the moved triangles: any corner whose position moved this drag
		const before = bytesBefore.split(',').map(Number);
		for (let i = 0; i < p1.length / 3; i++)
			if (before[i * 3] !== p1[i * 3] || before[i * 3 + 1] !== p1[i * 3 + 1] || before[i * 3 + 2] !== p1[i * 3 + 2]) movedTris.add(Math.floor(i / 3));
		for (const t of movedTris) for (let c = 0; c < 3; c++) hotKeys.add(key(t * 3 + c));
		for (let i = 0; i < n1.length / 3; i++) {
			if (n1[i * 3] === n0[i * 3] && n1[i * 3 + 1] === n0[i * 3 + 1] && n1[i * 3 + 2] === n0[i * 3 + 2]) continue;
			changed++;
			if (!hotKeys.has(key(i))) offVertex++;
		}
		out.normalsChanged = changed;
		out.normalsTotal = n1.length / 3;
		out.normalsOffVertex = offVertex;
		out.movedTris = movedTris.size;
		const bvh1 = s.bvhPicking.bvhDebug();
		out.bvh = { refitted: bvh1.refitted - bvh0.refitted, rebuilt: bvh1.rebuilt - bvh0.rebuilt, built: bvh1.built - bvh0.built, tree: !!live.boundsTree };
		// 4. cancel puts the original geometry object back
		fe.cancelFaceGrab();
		out.cancelRestoresObject = obj.geometry === entryGeometry;
		out.cancelRestoresBytes = bytes() === bytesBefore;
		// 5. commit + undo: bytes and pick
		fe.pickFaceUnit(t0);
		fe.beginFaceGrab(fi);
		for (let i = 1; i <= 4; i++) fe.applyFaceGrab({ dPos: new V3(0, 0.03 * i, 0) });
		out.committed = fe.commitFaceGrab();
		out.commitMoved = bytes() !== bytesBefore;
		fe.faceEditSelectedTris.set([]);
		s.history.undo();
		await raf();
		out.undoBytes = bytes() === bytesBefore;
		out.undoPick = JSON.stringify([...get(fe.faceEditSelectedTris)].sort((a, b) => a - b)) === JSON.stringify(pickBefore);
		// 6. a loop cut scrub with a fixed layout writes in place
		fe.pickFaceUnit(fe.currentFaces()[faceNear(1, 0.05, 0)].triIndices[0]);
		let began = false;
		for (let i = 0; i < 100 && !began; i++) {
			began = fe.beginOpAdjust('loopcut', { cuts: 1, position: 0.5 }) !== false;
			if (!began) await new Promise((res) => setTimeout(res, 50));
		}
		out.scrubBegan = began;
		if (began) {
			fe.reapplyOpAdjust({ position: 0.3 });
			const g1 = obj.geometry;
			const a1 = g1.attributes.position.array;
			const b1 = bytes();
			fe.reapplyOpAdjust({ position: 0.6 });
			out.scrubInPlace = obj.geometry === g1 && obj.geometry.attributes.position.array === a1;
			out.scrubMoved = bytes() !== b1;
			fe.settleOpAdjust();
			fe.endOpAdjust();
			s.history.undo();
			await raf();
			out.scrubUndo = bytes() === bytesBefore;
		}
		// 7. an edge grab: one edge of the face, its two vertex groups move, the edge stays selected
		fe.setFaceSubmode('edges');
		const f = fe.currentFaces()[faceNear(1, 0.05, 0)];
		const tri = f.triIndices[0];
		const P = obj.geometry.attributes.position.array;
		const c = new V3(
			(P[tri * 9] + P[tri * 9 + 3] + P[tri * 9 + 6]) / 3,
			(P[tri * 9 + 1] + P[tri * 9 + 4] + P[tri * 9 + 7]) / 3,
			(P[tri * 9 + 2] + P[tri * 9 + 5] + P[tri * 9 + 8]) / 3
		);
		const mid = new V3((P[tri * 9] + P[tri * 9 + 3]) / 2, (P[tri * 9 + 1] + P[tri * 9 + 4]) / 2, (P[tri * 9 + 2] + P[tri * 9 + 5]) / 2);
		const ek = fe.pickEdgeAt(tri, c.clone().lerp(mid, 0.95));
		out.edgePicked = !!ek;
		if (ek) {
			fe.pickEdge(ek, false);
			const keys = new Set(ek.split('|'));
			const eb = bytes();
			const began2 = fe.beginFaceGrab({ vertexKeys: keys, triIndices: [], centroid: c.clone(), normal: f.normal.clone() });
			out.edgeBegan = began2;
			for (let i = 1; i <= 3; i++) fe.applyFaceGrab({ dPos: new V3(0.02 * i, 0, 0) });
			fe.commitFaceGrab();
			out.edgeMoved = bytes() !== eb;
			out.edgeStillSelected = get(fe.edgeEditSelected).length === 1;
			const ends = fe.edgeEndpoints?.(get(fe.edgeEditSelected)[0]);
			out.edgeResolves = !!ends;
		}
		fe.setFaceSubmode('faces');
		fe.exitFaceEdit();
		return out;
	});
	console.log('[live-edit] ' + JSON.stringify(r));
	h.check(r.began === true, '1. a face grab begins on a 48x24 sphere (premise)');
	h.check(r.copyNotEntry === true, '1. ...it writes into a session-private copy, never the entry geometry');
	h.check(r.sameGeometry === true, '1. ...ONE geometry and ONE position array for the whole drag (no swap per frame)');
	h.check(r.versionAdvanced >= 8, '1. ...the attribute version advances per frame (' + r.versionAdvanced + ')');
	h.check(r.normalsChanged > 0 && r.normalsChanged < r.normalsTotal / 4, '2. only the touched normals change (' + r.normalsChanged + ' of ' + r.normalsTotal + ')');
	h.check(r.normalsOffVertex === 0, '2. ...and every changed normal sits on a vertex of a moved triangle (' + r.normalsOffVertex + ' off)');
	h.check(r.bvh.tree === true && r.bvh.refitted > 0 && r.bvh.rebuilt === 0, '3. the pick BVH is refitted, not rebuilt, and stays on (' + JSON.stringify(r.bvh) + ')');
	h.check(r.cancelRestoresObject === true, '4. a cancelled grab puts the original geometry object back');
	h.check(r.cancelRestoresBytes === true, '4. ...with its bytes unchanged');
	h.check(r.committed === true && r.commitMoved === true, '5. a committed grab moved the face');
	h.check(r.undoBytes === true, '5. ...its undo brings back the exact pre-grab bytes');
	h.check(r.undoPick === true, '5. ...and the pick the grab started from');
	h.check(r.scrubBegan === true, '6. a loop cut adjust begins (premise)');
	h.check(r.scrubInPlace === true, '6. ...a position scrub (same layout) writes into the same geometry');
	h.check(r.scrubMoved === true, '6. ...and moves the cut');
	h.check(r.scrubUndo === true, '6. ...one undo removes the cut');
	h.check(r.edgePicked === true && r.edgeBegan === true, '7. an edge grab begins (premise)');
	h.check(r.edgeMoved === true, '7. ...the edge moves');
	h.check(r.edgeStillSelected === true && r.edgeResolves === true, '7. ...and stays selected under its new key');
	await h.finish(browser);
});
