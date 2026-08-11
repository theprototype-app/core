// UV5 + the live-paint-preview fix, both from user reports on real content.
//
// 1. The UV canvas showed a stroke only on RELEASE. Its backdrop is decoded from
//    userData.mapDataUrl, which only changes when the stroke COMMITS, while the
//    3D model (and a peer) sees the CanvasTexture updating per dab. The backdrop
//    now prefers the live paint canvas.
// 2. "Editing UVs moves all 6 sides of a cube." Not a bug: a default BoxGeometry
//    has 24 uv entries but only FOUR distinct coordinates — every side maps onto
//    the same 0..1 square — so a welded cluster is 6 corners from 6 faces.
//    Nothing in UV space distinguishes them; the Edit Mesh pick does.
const h = require('./helpers.cjs');

const openOnBox = async (page) => {
	const uuid = await page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		w.objectActions.selectObject(box.uuid);
		w.uvEditorClose.set(false);
		w.bottomDock.activateDock('uv');
		return box.uuid;
	});
	await page.waitForTimeout(700);
	return uuid;
};

/**
 * Per-TRIANGLE uvs, index-expanded. A commit rebuilds the geometry non-indexed
 * (24 uv entries become 36), so comparing the raw attribute before/after is
 * apples-to-oranges — the same trap UV1's suite hit. Keyed by triangle so the
 * assertion can say WHICH faces moved.
 */
const uvByTri = (page, uuid) =>
	page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const geo = g.getObjectByProperty('uuid', uuid).geometry;
		const uv = geo.attributes.uv;
		const index = geo.index;
		const count = index ? index.count : uv.count;
		const out = [];
		for (let i = 0; i < count; i += 3) {
			const corners = [0, 1, 2].map((o) => {
				const j = index ? index.getX(i + o) : i + o;
				return uv.getX(j).toFixed(4) + ',' + uv.getY(j).toFixed(4);
			});
			out.push(corners.join(' | '));
		}
		return out;
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const uuid = await openOnBox(A.page);

	// ---------- the premise the user hit ----------
	const layout = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.getObjectByProperty('uuid', uuid);
		const uv = box.geometry.attributes.uv;
		const distinct = new Set();
		for (let i = 0; i < uv.count; i++) distinct.add(uv.getX(i).toFixed(4) + ',' + uv.getY(i).toFixed(4));
		return {
			uvCount: uv.count,
			distinct: distinct.size,
			cluster: w.uvEditor.weldedCluster(box.geometry, w.uvEditor.uvTriangles(box, 0)[0].indices[0]).length
		};
	}, uuid);
	h.check(
		layout.uvCount === 24 && layout.distinct === 4,
		`PREMISE: a default cube stacks all 6 sides on ONE uv square (${layout.uvCount} entries, ${layout.distinct} distinct)`
	);
	h.check(layout.cluster === 6, `...so an unscoped weld is 6 corners, one per side (${layout.cluster})`);

	// ---------- 2. face-scoped editing ----------
	const scoped = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.getObjectByProperty('uuid', uuid);
		// enter Edit Mesh and pick ONE face (the top), then turn the filter on
		w.faceEdit.enterFaceEdit(uuid);
		const top = w.faceEdit.currentFaces().find((f) => f.normal.y > 0.99);
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		w.uvEditor.uvFaceFilter.set('selection');
		await new Promise((r) => setTimeout(r, 350));
		const dbg = window.__uvDebug();
		const scopeTris = w.uvEditor.selectedFaceTris(uuid);
		const visible = w.uvEditor.uvTriangles(box, 0, scopeTris);
		const scope = w.uvEditor.uvIndicesOf(visible);
		const seed = visible[0].indices[0];
		return {
			filter: dbg.faceFilter,
			shown: dbg.tris,
			allTris: w.uvEditor.uvTriangles(box, 0).length,
			unscopedWeld: w.uvEditor.weldedCluster(box.geometry, seed).length,
			scopedWeld: w.uvEditor.weldedCluster(box.geometry, seed, scope).length
		};
	}, uuid);
	h.check(scoped.filter === 'selection', 'the face filter turns on');
	h.check(
		scoped.shown > 0 && scoped.shown < scoped.allTris,
		`the UV view shows ONLY the picked face's triangles (${scoped.shown} of ${scoped.allTris})`
	);
	h.check(
		scoped.scopedWeld < scoped.unscopedWeld,
		`THE FIX: a scoped weld is smaller than the all-faces weld (${scoped.scopedWeld} vs ${scoped.unscopedWeld})`
	);

	// dragging inside the scope must move ONLY the picked face's triangles
	const before = await uvByTri(A.page, uuid);
	const dragged = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.getObjectByProperty('uuid', uuid);
		const scopeTris = w.uvEditor.selectedFaceTris(uuid);
		const visible = w.uvEditor.uvTriangles(box, 0, scopeTris);
		const scope = w.uvEditor.uvIndicesOf(visible);
		const cluster = w.uvEditor.weldedCluster(box.geometry, visible[0].indices[0], scope);
		await w.uvEditor.beginUvDrag(uuid);
		w.uvEditor.moveUvCluster(box, cluster, 0.2, 0);
		w.uvEditor.endUvDrag(uuid);
		return { cluster: cluster.length, scoped: [...scopeTris] };
	}, uuid);
	const after = await uvByTri(A.page, uuid);
	const changedTris = before.map((s, i) => (s === after[i] ? -1 : i)).filter((i) => i >= 0);
	const outsideScope = changedTris.filter((i) => !dragged.scoped.includes(i));
	h.check(
		changedTris.length > 0 && before.length === after.length,
		`the scoped drag changed something (${changedTris.length} of ${before.length} triangles)`
	);
	h.check(
		outsideScope.length === 0,
		`THE USER'S BUG: only the PICKED face's triangles moved — the other 5 sides are untouched (${outsideScope.length} strays)`
	);
	await A.page.evaluate(() => {
		window.__stores.history.undo();
		window.__stores.uvEditor.uvFaceFilter.set('all');
		window.__stores.faceEdit.exitFaceEdit();
	});
	await A.page.waitForTimeout(400);

	// with the filter ON but nothing picked, the view falls back to every face
	const noPick = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.uvEditor.uvFaceFilter.set('selection');
		await new Promise((r) => setTimeout(r, 300));
		const dbg = window.__uvDebug();
		w.uvEditor.uvFaceFilter.set('all');
		return { scoped: dbg.scopedTris, shown: dbg.tris, note: !!document.getElementById('uv-filter-note') };
	});
	h.check(
		noPick.scoped === null && noPick.shown === 12,
		`the filter with no face selection shows everything rather than an empty view (${noPick.shown} tris)`
	);
	h.check(noPick.note, 'the topbar says so, instead of leaving the view mysteriously unfiltered');

	// the toggle button drives it
	const btn = await A.page.evaluate(async () => {
		const b = document.getElementById('uv-filter-faces');
		if (!b) return { present: false };
		b.click();
		await new Promise((r) => setTimeout(r, 200));
		const on = window.__uvDebug().faceFilter;
		b.click();
		await new Promise((r) => setTimeout(r, 200));
		return { present: true, on, off: window.__uvDebug().faceFilter };
	});
	h.check(btn.present, 'the topbar has a face-filter toggle');
	h.check(btn.on === 'selection' && btn.off === 'all', `the toggle switches both ways (${btn.on} -> ${btn.off})`);

	// ---------- 1. the live paint backdrop ----------
	const livePreview = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		document.getElementById('uv-tool-paint')?.click();
		await new Promise((r) => setTimeout(r, 200));
		const idle = window.__uvDebug();
		await w.uvEditor.beginPaintStroke(uuid, 0);
		w.uvEditor.paintMove(0.2, 0.5, '#ff0000', 40);
		w.uvEditor.paintMove(0.8, 0.5, '#ff0000', 40);
		await new Promise((r) => setTimeout(r, 200));
		const mid = window.__uvDebug(); // MID-stroke: nothing has committed yet
		const midTick = mid.tick;
		w.uvEditor.endPaintStroke('#ff0000', 40);
		await new Promise((r) => setTimeout(r, 700));
		const done = window.__uvDebug();
		return {
			idleLive: idle.backdropIsLiveCanvas,
			midLive: mid.backdropIsLiveCanvas,
			doneLive: done.backdropIsLiveCanvas,
			midTick
		};
	}, uuid);
	h.check(
		!livePreview.idleLive,
		'with no paint canvas the backdrop is the decoded texture (unchanged behaviour)'
	);
	h.check(
		livePreview.midLive,
		'THE FIX: mid-stroke the UV canvas draws the LIVE paint canvas, so strokes appear as you drag'
	);
	h.check(livePreview.doneLive, '...and keeps using it after the commit (same pixels, no reload flash)');

	// the redraw is actually driven: the tick advances per dab
	const ticks = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const read = () => new Promise((r) => w.uvEditor.uvPaintTick.subscribe((v) => r(v))());
		const t0 = await read();
		await w.uvEditor.beginPaintStroke(uuid, 0);
		for (let i = 0; i < 5; i++) w.uvEditor.paintMove(0.1 + i * 0.15, 0.2, '#00ff00', 20);
		const t1 = await read();
		w.uvEditor.endPaintStroke('#00ff00', 20);
		return { t0, t1 };
	}, uuid);
	h.check(
		ticks.t1 > ticks.t0,
		`each dab bumps the redraw tick, so the canvas repaints during the stroke (${ticks.t0} -> ${ticks.t1})`
	);

	// after an UNDO the cached canvas is stale — the backdrop must fall back
	const afterUndo = await A.page.evaluate(async () => {
		window.__stores.history.undo();
		await new Promise((r) => setTimeout(r, 700));
		return window.__uvDebug().backdropIsLiveCanvas;
	});
	h.check(
		!afterUndo,
		'after an undo the stale paint canvas is NOT used — the backdrop falls back to the real texture'
	);

	await h.finish(browser);
});
