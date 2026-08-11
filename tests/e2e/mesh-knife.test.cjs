// M9b KNIFE: draw a line across the mesh on screen, every triangle it crosses is split.
//
// Two things can quietly go wrong and both are checked here:
//
// 1. WATERTIGHTNESS. The obvious construction — unproject the 2D crossing and intersect the
//    triangle's PLANE — gives two different 3D points for the two triangles sharing an edge
//    whenever they are not coplanar, i.e. a crack down every crease the cut touches. So
//    crossings are computed once per welded EDGE, and the check is the odd-edge count.
// 2. The screen parameter is NOT the 3D parameter under perspective. A cut that looks like it
//    passes through the middle of an edge must land in the middle in SPACE too; without the
//    correction it drifts toward the camera-near end. The check measures a cut aimed at a
//    known midpoint from an oblique camera.
const h = require('./helpers.cjs');

const editBox = (page, size = 2) =>
	page.evaluate((size) => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand(`/create Box ${size} ${size} ${size}`);
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		s.faceEdit.exitFaceEdit?.();
		s.faceEdit.enterFaceEdit(window.__box.uuid);
		return window.__box.uuid;
	}, size);

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
	await editBox(A.page);
	const clean = await oddEdges(A.page);
	h.check(clean === 0, `the box starts watertight (${clean} odd edges)`);

	// --- a cut straight across the box splits what it crosses ---------------
	// aim the line through the middle of the box in SCREEN space, well past both sides
	const across = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		let camera;
		s.globalCamera.subscribe((c) => (camera = c))();
		const project = (x, y, z) => {
			const v = new s.THREE.Vector3(x, y, z).project(camera);
			return [((v.x + 1) / 2) * window.innerWidth, ((1 - v.y) / 2) * window.innerHeight];
		};
		const centre = project(0, 0, 0);
		const before = fe.readTriangles(window.__box.geometry).length;
		// horizontal line through the centre, 600px each way — crosses the whole silhouette
		const ok = fe.knifeCut([centre[0] - 600, centre[1]], [centre[0] + 600, centre[1]]);
		return { ok, before, after: fe.readTriangles(window.__box.geometry).length };
	});
	h.check(across.ok, 'the knife cut committed');
	h.check(
		across.after > across.before,
		`triangles were split (${across.before} -> ${across.after})`
	);
	const oddAcross = await oddEdges(A.page);
	h.check(
		oddAcross === 0,
		`STILL WATERTIGHT (${oddAcross} odd edges) — the crossings are shared per edge, not re-derived per triangle`
	);

	// --- ONE undo -----------------------------------------------------------
	const undo = await A.page.evaluate(() => {
		const s = window.__stores;
		const count = () => s.faceEdit.readTriangles(window.__box.geometry).length;
		const after = count();
		s.history.undo();
		const undone = count();
		s.history.redo();
		return { after, undone, redone: count() };
	});
	h.check(undo.undone === 12, `ONE undo restores the plain box (${undo.after} -> ${undo.undone})`);
	h.check(undo.redone === undo.after, 'redo puts the cut back');

	// --- the PERSPECTIVE correction -----------------------------------------
	// Aim the cut at the exact screen position of a known edge MIDPOINT, from an oblique
	// camera, and demand the new vertex land at that midpoint in SPACE. Interpolating with
	// the screen parameter instead lands short, toward the camera.
	const perspective = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const THREE = s.THREE;
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		fe.exitFaceEdit();
		fe.enterFaceEdit(window.__box.uuid);
		let camera;
		s.globalCamera.subscribe((c) => (camera = c))();
		// a strongly oblique view, so the near end of the top edge is much closer than the far
		camera.position.set(3.5, 3, 4.5);
		camera.lookAt(0, 0, 0);
		camera.updateMatrixWorld(true);
		const project = (v) => {
			const p = v.clone().project(camera);
			return [((p.x + 1) / 2) * window.innerWidth, ((1 - p.y) / 2) * window.innerHeight];
		};
		// the top-front edge runs (-1,1,1) -> (1,1,1); its true midpoint is (0,1,1)
		const a = new THREE.Vector3(-1, 1, 1);
		const b = new THREE.Vector3(1, 1, 1);
		const midpoint = a.clone().lerp(b, 0.5);
		const screenMid = project(midpoint);
		// a cut running "down" the screen through that point crosses the top-front edge there
		const ok = fe.knifeCut([screenMid[0], screenMid[1] - 400], [screenMid[0], screenMid[1] + 400]);
		const tris = fe.readTriangles(window.__box.geometry);
		// the closest new vertex ON that edge to the true midpoint
		let best = 1e9;
		for (const t of tris)
			for (const v of t) {
				if (Math.abs(v.y - 1) > 1e-4 || Math.abs(v.z - 1) > 1e-4) continue; // on the edge
				if (Math.abs(Math.abs(v.x) - 1) < 1e-4) continue; // skip the two corners
				best = Math.min(best, Math.abs(v.x));
			}
		return { ok, offset: best };
	});
	h.check(perspective.ok, 'the oblique cut committed (premise)');
	h.check(
		perspective.offset < 0.02,
		`the new vertex landed on the edge MIDPOINT in space, not where the screen parameter alone would put it (off by ${perspective.offset.toFixed(4)})`
	);

	// --- the refusals -------------------------------------------------------
	const refusals = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const count = () => fe.readTriangles(window.__box.geometry).length;
		const before = count();
		// a line that misses the mesh entirely
		const missed = fe.knifeCut([2, 2], [2, 400]) === false;
		const afterMiss = count();
		// a zero-length "cut"
		const tiny = fe.knifeCut([300, 300], [301, 300]) === false;
		return { missed, tiny, untouched: afterMiss === before && count() === before };
	});
	h.check(refusals.missed, 'a line that misses the mesh is refused, with a reason');
	h.check(refusals.tiny, 'a too-short cut is refused');
	h.check(refusals.untouched, '...and neither touched the geometry');

	// --- a TEXTURED mesh keeps a complete mapping ---------------------------
	const textured = await A.page.evaluate(() => {
		const s = window.__stores;
		const fe = s.faceEdit;
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		fe.exitFaceEdit();
		fe.enterFaceEdit(window.__box.uuid);
		let camera;
		s.globalCamera.subscribe((c) => (camera = c))();
		const p = new s.THREE.Vector3(0, 0, 0).project(camera);
		const centre = [((p.x + 1) / 2) * window.innerWidth, ((1 - p.y) / 2) * window.innerHeight];
		fe.knifeCut([centre[0] - 600, centre[1] + 40], [centre[0] + 600, centre[1] - 40]);
		const geometry = window.__box.geometry;
		const uv = geometry.attributes.uv;
		let nonZero = 0;
		if (uv) for (let i = 0; i < uv.count; i++) if (uv.getX(i) !== 0 || uv.getY(i) !== 0) nonZero++;
		return {
			has: !!uv,
			covers: uv ? uv.count === geometry.attributes.position.count : false,
			nonZero
		};
	});
	h.check(textured.has && textured.covers, 'the cut kept a COMPLETE uv attribute');
	h.check(textured.nonZero > 0, '...with real coordinates (the cut points are interpolated barycentrically)');

	// --- and a peer gets it -------------------------------------------------
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const netUuid = await editBox(A.page);
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
	await A.page.evaluate(() => {
		const s = window.__stores;
		let camera;
		s.globalCamera.subscribe((c) => (camera = c))();
		const p = new s.THREE.Vector3(0, 0, 0).project(camera);
		const centre = [((p.x + 1) / 2) * window.innerWidth, ((1 - p.y) / 2) * window.innerHeight];
		s.faceEdit.knifeCut([centre[0] - 600, centre[1]], [centre[0] + 600, centre[1]]);
	});
	await h.eventually(
		() => triCountOn(B.page, netUuid),
		(n) => n !== null && n > 12,
		'B receives the cut geometry',
		20000
	);

	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit?.());
	await h.finish(browser);
});
