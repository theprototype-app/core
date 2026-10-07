// 37 R11: LIVE SYMMETRY — while the toggle is on, every edit is mirrored across the plane
// from the side it happened on, and a vertex drag moves its mirror twin with it.
//
// What has to hold (and how each could go quietly wrong):
//  - the result is SYMMETRIC and WATERTIGHT after one-shot ops, adjust-engine ops (scrub +
//    settle), the knife, and vertex drags;
//  - the EDITED side wins: an extrude on -X is mirrored to +X, never discarded in favour of
//    the old +X half;
//  - ONE undo takes back the edit AND its mirror;
//  - RESTORE paths never mirror: undo/redo replays and a PEER's edit arrive exactly as sent
//    (the reason M7 shipped one-shot — hooking the commit path would mirror those too);
//  - peers receive the mirrored geometry.
const h = require('./helpers.cjs');

/** geometry facts of an object, LOCAL space: bounds, odd/same-way edges, lonely vertices */
const facts = (page, uuid) =>
	page.evaluate((uuid) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		if (!object?.geometry) return null;
		const tris = s.faceEdit.readTriangles(object.geometry);
		const keyOf = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e4)).join(',');
		const use = new Map();
		const directed = new Set();
		let sameWay = 0;
		let minX = 1e9;
		let maxX = -1e9;
		const keys = new Set();
		for (const t of tris) {
			const k = t.map(keyOf);
			for (let e = 0; e < 3; e++) {
				const [a, b] = [k[e], k[(e + 1) % 3]].sort();
				use.set(a + '|' + b, (use.get(a + '|' + b) ?? 0) + 1);
				const d = k[e] + '>' + k[(e + 1) % 3];
				if (directed.has(d)) sameWay++;
				directed.add(d);
			}
			for (const v of t) {
				minX = Math.min(minX, v.x);
				maxX = Math.max(maxX, v.x);
				keys.add(keyOf(v));
			}
		}
		let lonely = 0;
		for (const key of keys) {
			const [x, y, z] = key.split(',').map(Number);
			if (!keys.has([-x, y, z].join(','))) lonely++;
		}
		return {
			tris: tris.length,
			odd: [...use.values()].filter((n) => n !== 2).length,
			sameWay,
			lonely,
			minX: +minX.toFixed(4),
			maxX: +maxX.toFixed(4)
		};
	}, uuid);

/** a fresh box, symmetrized so its seam sits ON x = 0, in a face session */
const symmetricBox = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		s.meshToolParams.liveSymmetry.set(false);
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		s.meshEdit.exitEditMode?.();
		fe.exitFaceEdit?.();
		fe.enterFaceEdit(window.__box.uuid);
		fe.setFaceGranularity('face');
		fe.symmetrizeMesh('x', 1);
		return window.__box.uuid;
	});

/** select the face whose normal points along `dir` (x sign), by its first triangle */
const pickFace = (page, nx) =>
	page.evaluate((nx) => {
		const fe = window.__stores.faceEdit;
		const faces = fe.currentFaces();
		const face = faces.find((f) => f.normal.x * nx > 0.9);
		if (!face) return false;
		fe.highlightFaceByTriangle(face.triIndices[0]);
		return true;
	}, nx);

const settle = (page) => page.waitForTimeout(150);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const uuid = await symmetricBox(A.page);
	const start = await facts(A.page, uuid);
	h.check(
		start && start.odd === 0 && start.lonely === 0 && start.minX === -1 && start.maxX === 1,
		`premise: a symmetric, watertight box with its seam on the plane (${JSON.stringify(start)})`
	);

	// --- the toggle, through the real toolbox ---------------------------------
	const toggle = A.page.locator('#mesh-sym-live');
	if (!(await toggle.isVisible().catch(() => false))) {
		const head = A.page.locator('#mesh-sec-symmetry');
		if (await head.count()) await head.first().click();
		await A.page.waitForTimeout(150);
	}
	const toggleShown = await toggle.isVisible().catch(() => false);
	h.check(toggleShown, 'the Symmetry section has a "live symmetry" toggle');
	if (toggleShown) await toggle.click();
	else await A.page.evaluate(() => window.__stores.meshToolParams.liveSymmetry.set(true));
	const on = await A.page.evaluate(() => {
		let v;
		window.__stores.meshToolParams.liveSymmetry.subscribe((x) => (v = x))();
		return v;
	});
	h.check(on === true, 'live symmetry is ON');

	// --- a one-shot op on -X is mirrored to +X ---------------------------------
	const depth0 = await A.page.evaluate(() => {
		let st;
		window.__stores.history.undoStack.subscribe((v) => (st = v))();
		return st.length;
	});
	h.check(await pickFace(A.page, -1), 'picked the -X face (premise)');
	await A.page.evaluate(() => window.__stores.faceEdit.commitFaceOp('extrude', 0.6));
	await settle(A.page);
	const extruded = await facts(A.page, uuid);
	h.check(
		extruded.minX === -1.6 && extruded.maxX === 1.6,
		`an extrude on -X is MIRRORED to +X: x spans ${extruded.minX} .. ${extruded.maxX} (the edited side won)`
	);
	h.check(extruded.lonely === 0, `...every vertex has its mirror twin (${extruded.lonely} lonely)`);
	h.check(extruded.odd === 0 && extruded.sameWay === 0, `...watertight and consistently wound (${extruded.odd} odd, ${extruded.sameWay} same-way)`);
	const keptPick = await A.page.evaluate(() => {
		const s = window.__stores;
		let sel;
		s.faceEdit.faceEditSelectedTris.subscribe((v) => (sel = v))();
		const tris = s.faceEdit.readTriangles(window.__box.geometry);
		const xs = sel.flatMap((ti) => (tris[ti] ? tris[ti].map((v) => v.x) : []));
		return { count: sel.length, maxX: xs.length ? Math.max(...xs) : null };
	});
	h.check(
		keptPick.count > 0 && keptPick.maxX !== null && keptPick.maxX < -1.5,
		`...and the extruded CAP is still the selection, through the mirror's reorder (${keptPick.count} tris at x <= ${keptPick.maxX})`
	);
	const depth1 = await A.page.evaluate(() => {
		let st;
		window.__stores.history.undoStack.subscribe((v) => (st = v))();
		return st.length;
	});
	h.check(depth1 - depth0 === 1, `the op AND its mirror are ONE history entry (+${depth1 - depth0})`);
	await A.page.evaluate(() => window.__stores.history.undo());
	const undone = await facts(A.page, uuid);
	h.check(undone.minX === -1 && undone.maxX === 1 && undone.tris === start.tris, `ONE undo takes back the edit and its mirror (${undone.minX} .. ${undone.maxX})`);
	await A.page.evaluate(() => window.__stores.history.redo());
	const redone = await facts(A.page, uuid);
	h.check(redone.minX === -1.6 && redone.maxX === 1.6, `redo brings both back (${redone.minX} .. ${redone.maxX})`);

	// --- the peer gets the mirrored geometry -----------------------------------
	await h.eventually(
		() => facts(B.page, uuid),
		(f) => !!f && f.minX === -1.6 && f.maxX === 1.6 && f.lonely === 0,
		'peer B holds the MIRRORED result',
		20000
	);

	// --- the adjust engine: apply, scrub, settle — mirrored every run -----------
	h.check(await pickFace(A.page, -1), 'picked the -X cap again (premise)');
	const adjusted = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		const ok = fe.beginOpAdjust('extrude', { distance: 0.3 });
		fe.reapplyOpAdjust({ distance: 0.5 });
		const tris = fe.readTriangles(window.__box.geometry);
		let minX = 1e9;
		let maxX = -1e9;
		for (const t of tris) for (const v of t) (minX = Math.min(minX, v.x)), (maxX = Math.max(maxX, v.x));
		fe.settleOpAdjust();
		fe.endOpAdjust();
		return { ok, scrubMin: +minX.toFixed(4), scrubMax: +maxX.toFixed(4) };
	});
	h.check(adjusted.ok, 'the adjust engine applied the extrude (premise)');
	h.check(adjusted.scrubMin === -2.1 && adjusted.scrubMax === 2.1, `a SCRUB is mirrored live (${adjusted.scrubMin} .. ${adjusted.scrubMax})`);
	const settled = await facts(A.page, uuid);
	h.check(settled.minX === -2.1 && settled.maxX === 2.1 && settled.odd === 0 && settled.lonely === 0, `...and the settle commits it symmetric + watertight (${JSON.stringify(settled)})`);
	await A.page.evaluate(() => window.__stores.history.undo());
	const adjustUndone = await facts(A.page, uuid);
	h.check(adjustUndone.minX === -1.6 && adjustUndone.maxX === 1.6, `ONE undo takes the adjusted extrude back (${adjustUndone.minX} .. ${adjustUndone.maxX})`);

	// --- RESTORE paths never mirror --------------------------------------------
	await A.page.evaluate(() => window.__stores.meshToolParams.liveSymmetry.set(false));
	h.check(await pickFace(A.page, 1), 'picked the +X cap (premise)');
	await A.page.evaluate(() => window.__stores.faceEdit.commitFaceOp('extrude', 0.4));
	await settle(A.page);
	const lopsided = await facts(A.page, uuid);
	h.check(lopsided.maxX === 2 && lopsided.minX === -1.6, `with the toggle OFF an edit stays one-sided (premise: ${lopsided.minX} .. ${lopsided.maxX})`);
	await A.page.evaluate(() => window.__stores.meshToolParams.liveSymmetry.set(true));
	await A.page.evaluate(() => window.__stores.history.undo());
	await settle(A.page);
	const undoReplay = await facts(A.page, uuid);
	h.check(undoReplay.maxX === 1.6 && undoReplay.minX === -1.6, `with it ON, an UNDO replays exactly (${undoReplay.minX} .. ${undoReplay.maxX})`);
	await A.page.evaluate(() => window.__stores.history.redo());
	await settle(A.page);
	const redoReplay = await facts(A.page, uuid);
	h.check(
		redoReplay.maxX === 2 && redoReplay.minX === -1.6,
		`...and a REDO replays the one-sided edit as it was, NOT mirrored (${redoReplay.minX} .. ${redoReplay.maxX})`
	);
	// a PEER's edit arrives as sent: B (no live symmetry) pushes the +X face further out
	await h.eventually(
		() => facts(B.page, uuid),
		(f) => !!f && f.maxX === 2,
		'peer B holds the one-sided edit (premise)',
		20000
	);
	await B.page.evaluate((uuid) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		const before = Array.from(object.geometry.attributes.position.array);
		const after = before.slice();
		for (let i = 0; i < after.length; i += 3) if (after[i] > 1.99) after[i] = 2.5;
		s.faceEdit.commitMeshGeoSnapshot(uuid, before, after);
	}, uuid);
	await h.eventually(
		() => facts(A.page, uuid),
		(f) => !!f && f.maxX === 2.5,
		"A receives B's edit",
		20000
	);
	await settle(A.page);
	const peerEdit = await facts(A.page, uuid);
	h.check(peerEdit.maxX === 2.5 && peerEdit.minX === -1.6, `...and does NOT mirror it (a peer's edit is not A's operator: ${peerEdit.minX} .. ${peerEdit.maxX})`);

	// --- the knife: a cut on the -X half is mirrored -----------------------------
	const knifeBox = await symmetricBox(A.page);
	await A.page.evaluate(() => window.__stores.meshToolParams.liveSymmetry.set(true));
	const cutPoints = await A.page.evaluate(() => {
		const s = window.__stores;
		let camera;
		s.globalCamera.subscribe((c) => (camera = c))();
		let renderer;
		s.globalRenderer.subscribe((r) => (renderer = r))();
		const rect = renderer.domElement.getBoundingClientRect();
		const px = (x, y, z) => {
			const p = new s.THREE.Vector3(x, y, z).applyMatrix4(window.__box.matrixWorld).project(camera);
			return [rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height];
		};
		return [px(-1.6, 0.3, 1), px(-0.5, 0.35, 1), px(-0.45, -0.4, 1)];
	});
	await A.page.evaluate((points) => window.__stores.faceEdit.knifePolyline(points), cutPoints);
	await settle(A.page);
	const knifed = await facts(A.page, knifeBox);
	h.check(knifed.tris > start.tris, `the knife cut on the -X half (premise: ${start.tris} -> ${knifed.tris})`);
	h.check(knifed.lonely === 0 && knifed.odd === 0, `...is mirrored to +X: symmetric and watertight (${knifed.lonely} lonely, ${knifed.odd} odd)`);

	// --- vertex mode: a dragged vertex's TWIN follows ----------------------------
	const vbox = await symmetricBox(A.page);
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.faceEdit.exitFaceEdit();
		s.meshToolParams.liveSymmetry.set(true);
		s.meshEdit.enterEditMode(window.__box.uuid);
	});
	await A.page.waitForTimeout(200);
	const selectNearLocal = (point) =>
		A.page.evaluate((point) => {
			const s = window.__stores;
			const me = s.meshEdit;
			let controls;
			s.TControls.subscribe((c) => (controls = c))();
			let best = -1;
			let bestDistance = 1e9;
			for (let i = 0; i < 400; i++) {
				me.selectHandle(i);
				const p = controls.object?.position;
				if (!p) break;
				const local = window.__box.worldToLocal(p.clone());
				const d = Math.hypot(local.x - point[0], local.y - point[1], local.z - point[2]);
				if (d < bestDistance) (bestDistance = d), (best = i);
			}
			if (best >= 0) me.selectHandle(best);
			return { best, bestDistance };
		}, point);
	const corner = await selectNearLocal([-1, 1, 1]);
	h.check(corner.best >= 0 && corner.bestDistance < 1e-3, `picked the (-1, 1, 1) corner (premise, ${corner.bestDistance.toFixed(4)})`);
	const dragged = await A.page.evaluate(() => {
		const s = window.__stores;
		const me = s.meshEdit;
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		me.onProxyDragChanged(true);
		controls.object.position.x -= 0.3;
		controls.object.position.y += 0.2;
		me.onProxyMoved();
		me.onProxyDragChanged(false);
		const position = window.__box.geometry.attributes.position;
		const has = (x, y, z) => {
			for (let i = 0; i < position.count; i++)
				if (Math.abs(position.getX(i) - x) < 1e-4 && Math.abs(position.getY(i) - y) < 1e-4 && Math.abs(position.getZ(i) - z) < 1e-4)
					return true;
			return false;
		};
		return { moved: has(-1.3, 1.2, 1), twin: has(1.3, 1.2, 1), oldTwin: has(1, 1, 1) };
	});
	h.check(dragged.moved, 'the dragged corner moved to (-1.3, 1.2, 1) (premise)');
	h.check(dragged.twin && !dragged.oldTwin, 'its TWIN followed, mirrored, to (1.3, 1.2, 1)');
	const vfacts = await facts(A.page, vbox);
	h.check(vfacts.lonely === 0 && vfacts.odd === 0, `the mesh stays symmetric + watertight (${vfacts.lonely} lonely, ${vfacts.odd} odd)`);
	await h.eventually(
		() =>
			B.page.evaluate((uuid) => {
				let g;
				window.__stores.objectsGroup.subscribe((v) => (g = v))();
				const position = g.getObjectByProperty('uuid', uuid)?.geometry?.attributes.position;
				if (!position) return false;
				for (let i = 0; i < position.count; i++)
					if (Math.abs(position.getX(i) - 1.3) < 1e-4 && Math.abs(position.getY(i) - 1.2) < 1e-4) return true;
				return false;
			}, vbox),
		(v) => v === true,
		'peer B sees the twin move too',
		20000
	);
	const onPlane = await selectNearLocal([0, 1, 1]);
	h.check(onPlane.best >= 0 && onPlane.bestDistance < 1e-3, `picked a seam vertex ON the plane (premise, ${onPlane.bestDistance.toFixed(4)})`);
	const pinned = await A.page.evaluate(() => {
		const s = window.__stores;
		const me = s.meshEdit;
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		me.onProxyDragChanged(true);
		controls.object.position.x += 0.4;
		controls.object.position.y += 0.3;
		me.onProxyMoved();
		me.onProxyDragChanged(false);
		const position = window.__box.geometry.attributes.position;
		let onPlaneAtNewHeight = false;
		let offPlane = false;
		for (let i = 0; i < position.count; i++) {
			if (Math.abs(position.getY(i) - 1.3) < 1e-4 && Math.abs(position.getZ(i) - 1) < 1e-4) {
				if (Math.abs(position.getX(i)) < 1e-6) onPlaneAtNewHeight = true;
				else offPlane = true;
			}
		}
		return { onPlaneAtNewHeight, offPlane };
	});
	h.check(pinned.onPlaneAtNewHeight && !pinned.offPlane, 'a vertex ON the plane slides along it, never off it');
	await A.page.evaluate(() => {
		window.__stores.history.undo();
		window.__stores.history.undo();
	});
	const vundone = await facts(A.page, vbox);
	h.check(vundone.maxX === 1 && vundone.minX === -1 && vundone.lonely === 0, `two undos take both drags back, twins included (${vundone.minX} .. ${vundone.maxX})`);

	await A.page.evaluate(() => {
		window.__stores.meshEdit.exitEditMode?.();
		window.__stores.meshToolParams.liveSymmetry.set(false);
	});
	await h.finish(browser);
});
