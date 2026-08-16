// 19-A P5b: four operators with real geometric subtlety.
//
//   EDGE SUBDIVIDE — both sharers split at the IDENTICAL welded midpoint (the knife's
//                    crack rule), pieces rejoin the parent's stored face, half-edges
//                    stay selected, midpoint uvs are per-triangle corner LERPS.
//   EDGE EXTRUDE   — an ADJUST-ENGINE op: border edges only, chains weld into ONE
//                    strip (one offset copy per welded endpoint), interior edges are
//                    refused by name, distance re-runs live, new outer edges selected.
//   DUPLICATE      — coincident copies authored with the source's partition; the gizmo
//                    grab peels ONLY the copies off (the coincident-patch stitch skip).
//   SMOOTH/RELAX   — Jacobi Laplacian over the selected welded keys; factor 1 lands
//                    each vertex EXACTLY on its neighbour average (derived in-test),
//                    factor 0.5 exactly halfway; boundary verts stay put.
//
// Everything numeric is DERIVED in-test from the welded soup, never hardcoded from a
// run — including the extrude direction (the documented averaged-owning-normal rule)
// and the smooth averages (triangle-edge adjacency, the op's own definition).
const h = require('./helpers.cjs');

/** the mesh as a canonical string — the comparison for "undo restored the soup" */
const soup = (page, uuid) =>
	page.evaluate((uuid) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		const tris = s.faceEdit.readTriangles(object.geometry);
		return s.faceEdit
			.trisToPositions(tris)
			.map((n) => n.toFixed(4))
			.join(',');
	}, uuid);

const triCount = (page, uuid) =>
	page.evaluate((uuid) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		return object ? s.meshTopology.triangleCountOf(object.geometry) : -1;
	}, uuid);

/** welded edges used other than exactly twice — 0 = watertight (the crack check) */
const oddEdges = (page, uuid) =>
	page.evaluate((uuid) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const tris = s.faceEdit.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
		const keyOf = (v) =>
			`${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
		const use = new Map();
		for (const t of tris)
			for (let e = 0; e < 3; e++) {
				const a = keyOf(t[e]);
				const b = keyOf(t[(e + 1) % 3]);
				const k = a < b ? a + '|' + b : b + '|' + a;
				use.set(k, (use.get(k) || 0) + 1);
			}
		let odd = 0;
		for (const n of use.values()) if (n !== 2) odd++;
		return odd;
	}, uuid);

const freshBox = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		s.faceEdit.exitFaceEdit?.();
		s.meshEdit.exitEditMode?.();
		s.commandsHandler.sceneCommand('/clear all');
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		return g.children[g.children.length - 1].uuid;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ====================================================== 1. EDGE SUBDIVIDE
	let uuid = await freshBox(A.page);
	const pick = await A.page.evaluate((uuid) => {
		const fe = window.__stores.faceEdit;
		fe.enterFaceEdit(uuid);
		fe.faceEditSubmode.set('edges');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const tris = fe.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
		// pickEdgeAt skips the quad diagonal, so this yields a REAL box edge
		const t = tris[0];
		const centroid = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
		const mid = t[0].clone().add(t[1]).multiplyScalar(0.5);
		const key = fe.pickEdgeAt(0, centroid.clone().lerp(mid, 0.95));
		fe.pickEdge(key);
		const keyOf = (v) =>
			`${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
		const ends = fe.edgeEndpoints(key).map((p) => [p.x, p.y, p.z]);
		const expectMid = [0, 1, 2].map((i) => (ends[0][i] + ends[1][i]) / 2);
		// expected midpoint uv PER INCIDENT TRIANGLE — the corner lerp, asserted per
		// corner, never in aggregate (the mesh-grab-uv lesson)
		const expectedUvs = [];
		let incident = 0;
		for (const tri of tris)
			for (let e = 0; e < 3; e++) {
				const a = keyOf(tri[e]);
				const b = keyOf(tri[(e + 1) % 3]);
				const k = a < b ? a + '|' + b : b + '|' + a;
				if (k !== key) continue;
				incident++;
				if (tri.uv)
					expectedUvs.push([
						(tri.uv[e][0] + tri.uv[(e + 1) % 3][0]) / 2,
						(tri.uv[e][1] + tri.uv[(e + 1) % 3][1]) / 2
					]);
				break;
			}
		return { key, expectMid, expectedUvs, incident, before: tris.length };
	}, uuid);
	h.check(pick.incident === 2, `premise: the picked box edge joins ${pick.incident} triangles`);
	h.check(
		pick.expectedUvs.length === 2,
		'premise: the box carries uvs — both sharers have corner uvs to lerp'
	);

	const beforeSoup = await soup(A.page, uuid);
	const r1 = await A.page.evaluate(() => window.__stores.faceEdit.subdivideSelectedEdges());
	h.check(r1 === true, 'Edge subdivide commits');
	h.check(
		(await triCount(A.page, uuid)) === pick.before + 2,
		`+2 triangles — both sharers split (${pick.before} -> ${pick.before + 2})`
	);
	h.check(
		(await oddEdges(A.page, uuid)) === 0,
		'WATERTIGHT: 0 odd welded edges — both sides split at the numerically identical midpoint'
	);

	const midInfo = await A.page.evaluate(
		({ uuid, expectMid, expectedUvs }) => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const tris = s.faceEdit.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
			let exact = 0;
			let uvChecked = 0;
			let uvOk = true;
			for (const t of tris)
				t.forEach((v, c) => {
					const d =
						Math.abs(v.x - expectMid[0]) + Math.abs(v.y - expectMid[1]) + Math.abs(v.z - expectMid[2]);
					if (d > 1e-9) return;
					exact++;
					if (!t.uv) return;
					uvChecked++;
					// this corner's uv must be ONE of the two per-triangle corner lerps
					const uv = t.uv[c];
					const hit = expectedUvs.some(
						(e) => Math.abs(uv[0] - e[0]) < 1e-6 && Math.abs(uv[1] - e[1]) < 1e-6
					);
					if (!hit) uvOk = false;
				});
			let sel;
			s.faceEdit.edgeEditSelected.subscribe((v) => (sel = v))();
			// the stored partition: pieces rejoined their parents' faces, so the two
			// split quads are 3-tri faces now and the other four stay pairs
			const faces = s.meshTopology.readStoredFaces(
				g.getObjectByProperty('uuid', uuid).geometry
			);
			const sizes = faces ? faces.map((f) => f.length).sort().join(',') : '';
			return { exact, uvChecked, uvOk, selected: sel.length, sizes };
		},
		{ uuid, expectMid: pick.expectMid, expectedUvs: pick.expectedUvs }
	);
	h.check(midInfo.exact > 0, `the midpoint vertex exists at the EXACT endpoint average (${midInfo.exact} corners)`);
	h.check(
		midInfo.uvChecked > 0 && midInfo.uvOk,
		`each midpoint corner uv is its own triangle's corner LERP (${midInfo.uvChecked} corners checked)`
	);
	h.check(midInfo.selected === 2, 'the two HALF-edges are selected afterwards');
	h.check(
		midInfo.sizes === '2,2,2,2,3,3',
		`the pieces rejoined their parents' faces: two 3-tri faces + four quads (${midInfo.sizes})`
	);

	await A.page.evaluate(() => window.__stores.history.undo());
	h.check((await triCount(A.page, uuid)) === pick.before, 'ONE undo removes the split');
	h.check((await soup(A.page, uuid)) === beforeSoup, '...restoring the exact triangle soup');

	const subRefuse = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.clearEdgeSelection();
		return fe.subdivideSelectedEdges();
	});
	h.check(subRefuse === false, 'subdivide with nothing picked refuses');
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());

	// ======================================================= 2. EDGE EXTRUDE
	uuid = await freshBox(A.page);
	const opened = await A.page.evaluate((uuid) => {
		const fe = window.__stores.faceEdit;
		fe.enterFaceEdit(uuid);
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const tris = fe.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
		// the +Y quad: both tris whose normal points up
		const top = [];
		tris.forEach((t, ti) => {
			const n = t[1].clone().sub(t[0]).cross(t[2].clone().sub(t[0])).normalize();
			if (n.y > 0.9) top.push(ti);
		});
		fe.faceEditSelectedTris.set(top);
		const ok = fe.commitFaceOp('delete', 0);
		return { ok, top: top.length };
	}, uuid);
	h.check(opened.ok === true && opened.top === 2, 'premise: the +Y quad (2 tris) deletes — an open box');
	h.check((await triCount(A.page, uuid)) === 10, 'premise: 10 triangles left');
	const openSoup = await soup(A.page, uuid);

	const ext = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		const fe = s.faceEdit;
		fe.setFaceSubmode('edges');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const tris = fe.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
		const keyOf = (v) =>
			`${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
		// border edges = welded edges used ONCE, with their single owning triangle
		const use = new Map();
		tris.forEach((t, ti) => {
			for (let e = 0; e < 3; e++) {
				const a = keyOf(t[e]);
				const b = keyOf(t[(e + 1) % 3]);
				const k = a < b ? a + '|' + b : b + '|' + a;
				let list = use.get(k);
				if (!list) use.set(k, (list = []));
				list.push(ti);
			}
		});
		const borders = [...use].filter(([, list]) => list.length === 1);
		// two CHAINED border edges (sharing one endpoint key)
		let pair = null;
		outer: for (const [a] of borders)
			for (const [b] of borders) {
				if (a === b) continue;
				const [a0, a1] = a.split('|');
				if (b.split('|').some((k) => k === a0 || k === a1)) {
					pair = [a, b];
					break outer;
				}
			}
		fe.pickEdge(pair[0]);
		fe.pickEdge(pair[1], true);
		// DERIVE the spec: offset dir = normalized sum of the two owning triangles'
		// normals (in ascending tri order, the scan order the core uses); expected
		// offset corners = each unique endpoint + dir * distance
		const owners = pair
			.map((k) => use.get(k)[0])
			.sort((x, y) => x - y)
			.map((ti) => tris[ti]);
		const dir = new s.THREE.Vector3();
		for (const t of owners)
			dir.add(t[1].clone().sub(t[0]).cross(t[2].clone().sub(t[0])).normalize());
		dir.normalize();
		const endpointKeys = new Set(pair.flatMap((k) => k.split('|')));
		const endpoints = [];
		for (const t of tris)
			for (const v of t) {
				const k = keyOf(v);
				if (endpointKeys.has(k) && !endpoints.some((p) => keyOf(p) === k)) endpoints.push(v.clone());
			}
		const preKeys = new Set();
		for (const t of tris) for (const v of t) preKeys.add(keyOf(v));
		const began = fe.extrudeSelectedEdges(0.5);
		return {
			borders: borders.length,
			endpoints: endpoints.map((p) => [p.x, p.y, p.z]),
			dir: [dir.x, dir.y, dir.z],
			preKeys: [...preKeys],
			began
		};
	}, uuid);
	h.check(ext.borders === 4, `premise: the open rim is 4 border edges (${ext.borders})`);
	h.check(ext.endpoints.length === 3, `premise: 2 chained edges span 3 welded endpoints (${ext.endpoints.length})`);
	h.check(ext.began === true, 'edge extrude begins (adjust-engine op, applied on the spot)');
	h.check((await triCount(A.page, uuid)) === 14, 'ONE strip: +4 triangles for 2 chained edges');

	/** verify the appended strip against the derived spec at a given distance */
	const stripAt = (distance) =>
		A.page.evaluate(
			({ uuid, endpoints, dir, preKeys, distance }) => {
				const s = window.__stores;
				let g;
				s.objectsGroup.subscribe((v) => (g = v))();
				const tris = s.faceEdit.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
				const keyOf = (v) =>
					`${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
				const pre = new Set(preKeys);
				// unique corners of the appended 4 tris; the NEW ones must be exactly
				// {endpoint + dir*distance} — 3 of them (the shared endpoint got ONE copy)
				const appended = tris.slice(10);
				const uniq = new Map();
				for (const t of appended) for (const v of t) uniq.set(keyOf(v), v);
				const fresh = [...uniq.entries()].filter(([k]) => !pre.has(k)).map(([, v]) => v);
				const expected = endpoints.map((p) => [
					p[0] + dir[0] * distance,
					p[1] + dir[1] * distance,
					p[2] + dir[2] * distance
				]);
				const matched = expected.filter((e) =>
					fresh.some(
						(v) =>
							Math.abs(v.x - e[0]) < 1e-5 && Math.abs(v.y - e[1]) < 1e-5 && Math.abs(v.z - e[2]) < 1e-5
					)
				).length;
				let sel;
				s.faceEdit.edgeEditSelected.subscribe((v) => (sel = v))();
				let adj;
				s.faceEdit.opAdjustState.subscribe((v) => (adj = v))();
				return {
					unique: uniq.size,
					fresh: fresh.length,
					matched,
					selected: sel.length,
					adjustOp: adj && adj.op
				};
			},
			{ uuid, endpoints: ext.endpoints, dir: ext.dir, preKeys: ext.preKeys, distance }
		);

	let strip = await stripAt(0.5);
	h.check(
		strip.unique === 6 && strip.fresh === 3,
		`the strip WELDS the shared endpoint: 6 unique corners, 3 offset copies (got ${strip.unique}/${strip.fresh}; 7/4 would be a torn corner)`
	);
	h.check(
		strip.matched === 3,
		`every offset copy sits at endpoint + chainNormal x 0.5 — the documented direction rule (${strip.matched}/3)`
	);
	h.check(strip.selected === 2, 'the NEW outer edges are the selection');
	h.check(strip.adjustOp === 'edge-extrude', 'the adjust engine is live on edge-extrude');

	const scrubbed = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		const ok = fe.reapplyOpAdjust({ distance: 1.2 });
		fe.settleOpAdjust();
		return ok;
	});
	h.check(scrubbed === true, 'scrubbing the distance re-runs the core live');
	h.check((await triCount(A.page, uuid)) === 14, '...from the ORIGINAL snapshot — the strip never stacks');
	strip = await stripAt(1.2);
	h.check(
		strip.matched === 3 && strip.unique === 6,
		`after the scrub the offsets sit at distance 1.2, still welded (${strip.matched}/3, ${strip.unique} corners)`
	);
	h.check(strip.selected === 2, '...and the selection re-follows the moved outer edges');

	await A.page.evaluate(() => window.__stores.history.undo());
	h.check((await triCount(A.page, uuid)) === 10, 'ONE undo removes the whole adjusted strip (one entry, settled in place)');
	h.check((await soup(A.page, uuid)) === openSoup, '...restoring the exact open-box soup');

	// refusal: an INTERIOR edge (a face on both sides) is refused with the rule named
	const refuse = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		const fe = s.faceEdit;
		fe.clearEdgeSelection();
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const tris = fe.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
		const keyOf = (v) =>
			`${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
		const use = new Map();
		for (const t of tris)
			for (let e = 0; e < 3; e++) {
				const a = keyOf(t[e]);
				const b = keyOf(t[(e + 1) % 3]);
				const k = a < b ? a + '|' + b : b + '|' + a;
				use.set(k, (use.get(k) || 0) + 1);
			}
		// a REAL interior edge the picker would offer (skip quad diagonals by asking
		// the same internalEdgeSet rule the tools use)
		const internal = fe.internalEdgeSet(g.getObjectByProperty('uuid', uuid).geometry);
		const interior = [...use].find(([k, n]) => n === 2 && !internal.has(k));
		fe.pickEdge(interior[0]);
		const began = fe.extrudeSelectedEdges(0.5);
		let msgs;
		s.toastStore.subscribe((v) => (msgs = v))();
		const last = msgs[msgs.length - 1];
		fe.clearEdgeSelection();
		return { began, text: typeof last === 'string' ? last : (last && last.text) || '' };
	}, uuid);
	h.check(refuse.began === false, 'an interior-only selection refuses (no commit)');
	h.check(
		/BORDER/i.test(refuse.text) && /both sides/i.test(refuse.text),
		`...with a toast naming the rule ("${refuse.text}")`
	);
	h.check((await triCount(A.page, uuid)) === 10, '...and the mesh is untouched');
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());

	// ==================================================== 3. DUPLICATE FACES
	uuid = await freshBox(A.page);
	const preDupSoup = await soup(A.page, uuid);
	const dup = await A.page.evaluate((uuid) => {
		const fe = window.__stores.faceEdit;
		fe.enterFaceEdit(uuid);
		// two disjoint quads
		const q0 = fe.quadOfTriangle(0);
		let q1 = null;
		for (let ti = 1; ti < 12; ti++) {
			const q = fe.quadOfTriangle(ti);
			if (q.length === 2 && !q.some((x) => q0.includes(x))) {
				q1 = q;
				break;
			}
		}
		fe.faceEditSelectedTris.set([...q0, ...q1]);
		const src = [...q0, ...q1];
		const ok = fe.duplicateSelectedFaces();
		let sel;
		fe.faceEditSelectedTris.subscribe((v) => (sel = v))();
		return { ok, sel, src };
	}, uuid);
	h.check(dup.ok === true, 'Duplicate commits');
	h.check((await triCount(A.page, uuid)) === 16, '+4 triangles (two quads copied)');
	h.check(
		dup.sel.length === 4 && dup.sel.every((ti) => ti >= 12),
		'the COPIES are the selection (all indices in the appended range)'
	);

	const geoInfo = await A.page.evaluate(
		({ uuid, src }) => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const object = g.getObjectByProperty('uuid', uuid);
			const tris = s.faceEdit.readTriangles(object.geometry);
			// coincident: copy i (12+i) equals source src[i], corner for corner, EXACTLY
			let coincident = true;
			src.forEach((ti, i) => {
				const a = tris[ti];
				const b = tris[12 + i];
				for (let c = 0; c < 3; c++)
					if (a[c].x !== b[c].x || a[c].y !== b[c].y || a[c].z !== b[c].z) coincident = false;
			});
			const faces = s.meshTopology.readStoredFaces(object.geometry);
			const copyPairs = faces
				? faces.filter((f) => f.length === 2 && f.every((ti) => ti >= 12)).length
				: -1;
			const valid = faces ? s.meshTopology.facesValidFor(faces, 16) : false;
			return { coincident, copyPairs, valid };
		},
		{ uuid, src: dup.src }
	);
	h.check(geoInfo.coincident, 'the copies are corner-for-corner COINCIDENT with their sources');
	h.check(
		geoInfo.copyPairs === 2 && geoInfo.valid,
		`the stored partition covers the copies with the SOURCE grouping — 2 quads in the appended range (${geoInfo.copyPairs}), and it validates`
	);

	// the real gizmo path: beginFaceGrab -> applyFaceGrab -> commitFaceGrab. The
	// coincident-patch rule must skip the weld stitch, or the drag would carry the
	// source (and the box sides welded to it) along.
	const grab = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		const fe = s.faceEdit;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		const preFirst12 = s.faceEdit
			.trisToPositions(fe.readTriangles(object.geometry))
			.slice(0, 12 * 9)
			.map((n) => n.toFixed(5))
			.join(',');
		const target = fe.currentTargetFace();
		const ok = fe.beginFaceGrab(target);
		fe.applyFaceGrab({ dPos: { x: 0, y: 0.7, z: 0 } });
		const committed = fe.commitFaceGrab();
		const after = fe.readTriangles(object.geometry);
		const postFirst12 = s.faceEdit
			.trisToPositions(after)
			.slice(0, 12 * 9)
			.map((n) => n.toFixed(5))
			.join(',');
		return { ok, committed, originalsUnchanged: preFirst12 === postFirst12 };
	}, uuid);
	h.check(grab.ok === true && grab.committed === true, 'the gizmo grab begins and commits on the copies');
	h.check(
		grab.originalsUnchanged,
		'the SOURCE faces (and everything welded to them) did NOT move — the coincident patch captured no stitch'
	);
	const movedInfo = await A.page.evaluate(
		({ uuid, src }) => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const tris = s.faceEdit.readTriangles(g.getObjectByProperty('uuid', uuid).geometry);
			// each copy corner = its (unmoved) source corner + (0, 0.7, 0)
			let moved = true;
			src.forEach((ti, i) => {
				const a = tris[ti];
				const b = tris[12 + i];
				for (let c = 0; c < 3; c++)
					if (
						Math.abs(b[c].x - a[c].x) > 1e-5 ||
						Math.abs(b[c].y - (a[c].y + 0.7)) > 1e-5 ||
						Math.abs(b[c].z - a[c].z) > 1e-5
					)
						moved = false;
			});
			return moved;
		},
		{ uuid, src: dup.src }
	);
	h.check(movedInfo, 'the copies moved by exactly the drag delta (+0.7 y) — a clean peel');

	await A.page.evaluate(() => {
		window.__stores.history.undo(); // the grab
		window.__stores.history.undo(); // the duplicate
	});
	h.check((await triCount(A.page, uuid)) === 12, 'two undos remove the move, then the copies');
	h.check((await soup(A.page, uuid)) === preDupSoup, '...restoring the exact original soup');
	const dupRefuse = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.faceEditSelectedTris.set([]);
		fe.faceEditHighlight.set(-1);
		fe.faceEditHoverTri.set(-1);
		return fe.duplicateSelectedFaces();
	});
	h.check(dupRefuse === false, 'duplicate with nothing selected refuses');
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());

	// ===================================================== 4. SMOOTH / RELAX
	// a noisy 4x4 plane grid: subdivide twice, then jitter per WELDED key (a
	// per-entry jitter would tear the soup and change the welded structure)
	const gridUuid = await A.page.evaluate(() => {
		const s = window.__stores;
		s.faceEdit.exitFaceEdit?.();
		s.meshEdit.exitEditMode?.();
		s.commandsHandler.sceneCommand('/clear all');
		s.commandsHandler.sceneCommand('/create Plane 2 2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const uuid = g.children[g.children.length - 1].uuid;
		const fe = s.faceEdit;
		fe.enterFaceEdit(uuid);
		fe.selectAllFaces();
		fe.commitFaceOp('subdivide', 0);
		fe.selectAllFaces();
		fe.commitFaceOp('subdivide', 0);
		fe.exitFaceEdit();
		const object = g.getObjectByProperty('uuid', uuid);
		const pos = object.geometry.attributes.position;
		const keyOf = (x, y, z) =>
			`${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
		let seed = 7;
		const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
		const off = new Map();
		for (let i = 0; i < pos.count; i++) {
			const k = keyOf(pos.getX(i), pos.getY(i), pos.getZ(i));
			if (!off.has(k)) off.set(k, rand() * 0.3);
			pos.setZ(i, pos.getZ(i) + off.get(k)); // the plane faces +Z, so z = "height"
		}
		pos.needsUpdate = true;
		return uuid;
	});
	h.check((await triCount(A.page, gridUuid)) === 32, 'premise: the plane subdivided twice is a 4x4 grid (32 tris)');
	const noisySoup = await soup(A.page, gridUuid);

	// derive the spec in-test: welded adjacency by TRIANGLE edges (the op's own
	// definition, diagonals included), interior = no incident border edge
	const derived = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		s.meshEdit.enterEditMode(uuid);
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		const tris = s.faceEdit.readTriangles(object.geometry);
		const keyOf = (v) =>
			`${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
		const pos = new Map();
		const adj = new Map();
		const use = new Map();
		for (const t of tris) {
			const ks = t.map(keyOf);
			ks.forEach((k, c) => {
				if (!pos.has(k)) pos.set(k, [t[c].x, t[c].y, t[c].z]);
			});
			for (let e = 0; e < 3; e++) {
				const a = ks[e];
				const b = ks[(e + 1) % 3];
				if (a === b) continue;
				if (!adj.has(a)) adj.set(a, new Set());
				adj.get(a).add(b);
				if (!adj.has(b)) adj.set(b, new Set());
				adj.get(b).add(a);
				const ek = a < b ? a + '|' + b : b + '|' + a;
				use.set(ek, (use.get(ek) || 0) + 1);
			}
		}
		const borderKeys = new Set();
		for (const [ek, n] of use) if (n === 1) ek.split('|').forEach((k) => borderKeys.add(k));
		const interior = [...pos.keys()].filter((k) => !borderKeys.has(k));
		// handle index per key: replicate buildHandles' first-occurrence order
		const attr = object.geometry.attributes.position;
		const firstIdx = new Map();
		for (let i = 0; i < attr.count; i++) {
			const k = keyOf({ x: attr.getX(i), y: attr.getY(i), z: attr.getZ(i) });
			if (!firstIdx.has(k)) firstIdx.set(k, { handle: firstIdx.size, entry: i });
		}
		s.meshEdit.clearVertexSelection();
		for (const k of interior) s.meshEdit.toggleVertexSelection(firstIdx.get(k).handle);
		// expected: ONE Jacobi pass from the PRE-op positions
		const expected = {};
		for (const k of interior) {
			const around = [...adj.get(k)];
			const avg = [0, 0, 0];
			for (const nk of around) {
				const p = pos.get(nk);
				avg[0] += p[0];
				avg[1] += p[1];
				avg[2] += p[2];
			}
			expected[k] = avg.map((v) => v / around.length);
		}
		const borders = {};
		for (const k of borderKeys) borders[k] = pos.get(k);
		const entryOf = {};
		for (const [k, v] of firstIdx) entryOf[k] = v.entry;
		const orig = {};
		for (const [k, p] of pos) orig[k] = p;
		let size = 0;
		s.meshEdit.vertexSelectionSize.subscribe((v) => (size = v))();
		return { interior, expected, borders, entryOf, orig, size, count: attr.count };
	}, gridUuid);
	h.check(derived.interior.length === 9, `premise: the 4x4 grid has 9 interior vertices (${derived.interior.length})`);
	h.check(derived.size === 9, 'all 9 are selected through the store API');

	/** read the live positions of a set of keys by their first attribute entry */
	const positionsOf = (keys) =>
		A.page.evaluate(
			({ uuid, keys, entryOf }) => {
				const s = window.__stores;
				let g;
				s.objectsGroup.subscribe((v) => (g = v))();
				const attr = g.getObjectByProperty('uuid', uuid).geometry.attributes.position;
				const out = {};
				for (const k of keys) {
					const i = entryOf[k];
					out[k] = [attr.getX(i), attr.getY(i), attr.getZ(i)];
				}
				return { out, count: attr.count };
			},
			{ uuid: gridUuid, keys, entryOf: derived.entryOf }
		);

	// ---- factor 0.5: exactly halfway to the neighbour average
	const half = await A.page.evaluate(() => window.__stores.meshEdit.smoothSelectedVerts(0.5, 1));
	h.check(half === true, 'Smooth commits (factor 0.5, 1 pass)');
	let read = await positionsOf(derived.interior);
	let worst = 0;
	for (const k of derived.interior) {
		const o = derived.orig[k];
		const e = derived.expected[k];
		const want = [0, 1, 2].map((i) => o[i] + (e[i] - o[i]) * 0.5);
		const got = read.out[k];
		for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
	}
	h.check(worst < 1e-5, `factor 0.5 lands each vertex exactly HALFWAY to its neighbour average (worst ${worst.toExponential(2)})`);
	h.check(read.count === derived.count, 'the vertex count is unchanged');

	await A.page.evaluate(() => window.__stores.history.undo());
	h.check((await soup(A.page, gridUuid)) === noisySoup, 'ONE undo restores the noisy grid exactly');

	// ---- factor 1: lands exactly ON the average; boundary stays put
	const again = await A.page.evaluate(() => {
		const me = window.__stores.meshEdit;
		let size = 0;
		me.vertexSelectionSize.subscribe((v) => (size = v))();
		return { size, ok: me.smoothSelectedVerts(1, 1) };
	});
	h.check(again.size === 9, 'the selection SURVIVED the undo (counts unchanged, handles rebuilt in place)');
	h.check(again.ok === true, 'Smooth commits again (factor 1, 1 pass)');
	read = await positionsOf(derived.interior);
	worst = 0;
	for (const k of derived.interior) {
		const e = derived.expected[k];
		const got = read.out[k];
		for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(got[i] - e[i]));
	}
	h.check(
		worst < 1e-5,
		`factor 1 lands each selected vertex EXACTLY on its neighbour average — Jacobi, derived in-test (worst ${worst.toExponential(2)})`
	);
	const borderKeys = Object.keys(derived.borders);
	const borderRead = await positionsOf(borderKeys);
	let borderWorst = 0;
	for (const k of borderKeys) {
		const p = derived.borders[k];
		const got = borderRead.out[k];
		for (let i = 0; i < 3; i++) borderWorst = Math.max(borderWorst, Math.abs(got[i] - p[i]));
	}
	h.check(borderWorst < 1e-6, `unselected boundary vertices stay put (worst ${borderWorst.toExponential(2)})`);

	const smoothRefuse = await A.page.evaluate(() => {
		const me = window.__stores.meshEdit;
		me.clearVertexSelection();
		return me.smoothSelectedVerts(1, 1);
	});
	h.check(smoothRefuse === false, 'smooth with no vertex picked refuses (toast, no commit)');
	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());

	// ====================================================== 5. the toolbox UI
	uuid = await freshBox(A.page);
	await A.page.evaluate((uuid) => {
		const fe = window.__stores.faceEdit;
		fe.enterFaceEdit(uuid);
		fe.setFaceSubmode('edges');
		fe.clearEdgeSelection();
	}, uuid);
	await A.page.waitForTimeout(400);
	h.check((await A.page.locator('#edge-extrude').count()) === 1, 'the edges Tools row has #edge-extrude');
	h.check((await A.page.locator('#edge-subdivide').count()) === 1, '...and #edge-subdivide');
	// clicking Extrude with nothing picked focuses the pane and shows the hint
	await A.page.click('#edge-extrude');
	await A.page.waitForTimeout(300);
	h.check((await A.page.locator('#edge-extrude-params').count()) === 1, 'clicking it opens the edge-extrude options pane');
	const edgeHint = await A.page.evaluate(() => document.querySelector('#mesh-op-hint')?.textContent || '');
	h.check(/border edge/i.test(edgeHint), `...with the pick-first hint ("${edgeHint.trim()}")`);

	await A.page.evaluate(() => {
		window.__stores.faceEdit.setFaceSubmode('faces');
	});
	await A.page.waitForTimeout(300);
	h.check(
		(await A.page.locator('#mesh-op-duplicate').count()) === 1,
		'the faces Operations grid has #mesh-op-duplicate'
	);

	await A.page.evaluate((uuid) => {
		window.__stores.faceEdit.exitFaceEdit();
		window.__stores.meshEdit.enterEditMode(uuid);
		window.__stores.meshEdit.clearVertexSelection();
	}, uuid);
	await A.page.waitForTimeout(400);
	h.check((await A.page.locator('#mesh-smooth').count()) === 1, 'the vertices Tools row has #mesh-smooth');
	await A.page.click('#mesh-smooth');
	await A.page.waitForTimeout(300);
	h.check((await A.page.locator('#smooth-params').count()) === 1, 'clicking it opens the smooth options pane (factor + passes)');
	const smoothHint = await A.page.evaluate(() => document.querySelector('#mesh-op-hint')?.textContent || '');
	h.check(/vertex first/i.test(smoothHint), `...with the pick-first hint ("${smoothHint.trim()}")`);
	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());

	// ================================================ 6. two-peer smooth parity
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const netUuid = await freshBox(A.page);
	await h.eventually(
		() => triCount(B.page, netUuid),
		(n) => n === 12,
		'B received the box (premise)',
		20000
	);
	await A.page.evaluate((uuid) => {
		const me = window.__stores.meshEdit;
		me.enterEditMode(uuid);
		me.selectHandle(0);
		me.smoothSelectedVerts(0.5, 2);
	}, netUuid);
	const mineSoup = await soup(A.page, netUuid);
	h.check(mineSoup.length > 0, 'A smoothed a corner while connected');
	await h.eventually(
		async () => (await soup(B.page, netUuid)) === mineSoup,
		(same) => same === true,
		'B converges to byte-for-byte the same smoothed mesh',
		20000
	);
	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());

	await h.finish(browser);
});
