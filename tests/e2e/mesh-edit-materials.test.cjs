// 15-G follow-up: mesh edits on a MULTI-MATERIAL mesh (what Convert to mesh
// produces) must keep the mesh renderable.
//
// The reported bug: merge two boxes, select a face on each, click Bridge —
// "nothing happens". The bridge ALGORITHM was fine (24 -> 28 triangles spanning
// both boxes); the mesh went INVISIBLE. three draws an array material by walking
// `geometry.groups`, and every geometry swap in faceEdit built a fresh geometry
// with no groups at all, so the renderer drew zero triangles for it.
//
// Every check here therefore asserts BOTH the geometry and that the renderer
// still draws the thing.
const h = require('./helpers.cjs');

/** install per-page helpers: exact triangle count the renderer draws for one object */
async function installProbe(page) {
	await page.evaluate(async () => {
		const w = window.__stores;
		const renderer = await new Promise((r) => w.globalRenderer.subscribe(r)());
		const scene = await new Promise((r) => w.globalScene.subscribe(r)());
		const camera = await new Promise((r) => w.globalCamera.subscribe(r)());
		const draw = () => {
			renderer.info.reset();
			renderer.render(scene, camera);
			return renderer.info.render.triangles;
		};
		// isolate ONE object's contribution by toggling it off for a second frame —
		// independent of the grid/environment/overlay triangles in the same scene
		window.__drawnFor = (uuid) => {
			const g = w.objectsGroup;
			let group;
			g.subscribe((v) => (group = v))();
			const mesh = group.getObjectByProperty('uuid', uuid);
			if (!mesh) return -1;
			const on = draw();
			mesh.visible = false;
			const off = draw();
			mesh.visible = true;
			return on - off;
		};
		window.__geoInfo = (uuid) => {
			const g = w.objectsGroup;
			let group;
			g.subscribe((v) => (group = v))();
			const mesh = group.getObjectByProperty('uuid', uuid);
			if (!mesh) return null;
			const verts = mesh.geometry.attributes.position.count;
			const groups = mesh.geometry.groups.map((x) => ({
				start: x.start,
				count: x.count,
				materialIndex: x.materialIndex
			}));
			// every vertex covered exactly once, in order, with no gap?
			let covered = 0;
			let contiguous = true;
			for (const x of [...groups].sort((a, b) => a.start - b.start)) {
				if (x.start !== covered) contiguous = false;
				covered += x.count;
			}
			return {
				verts,
				tris: verts / 3,
				groups,
				groupCount: groups.length,
				fullyCovered: groups.length === 0 || (contiguous && covered === verts),
				materials: Array.isArray(mesh.material) ? mesh.material.length : 1,
				slots: [...new Set(groups.map((x) => x.materialIndex))].sort()
			};
		};
	});
}

/** two coloured boxes side by side, merged into one multi-material mesh */
const mergedPair = (page) =>
	page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const [a, b] = g.children.slice(-2);
		a.position.set(-1.5, 0, 0);
		a.material.color.set('#ff0000');
		b.position.set(1.5, 0, 0);
		b.material.color.set('#0000ff');
		return await w.objectActions.convertToMesh([a.uuid, b.uuid]);
	});

/** enter face edit and select the two INNER facing faces (+X of the left box, -X of the right) */
const selectFacingFaces = (page, uuid) =>
	page.evaluate((uuid) => {
		const w = window.__stores;
		w.faceEdit.enterFaceEdit(uuid);
		const faces = w.faceEdit.currentFaces();
		const byNormal = (sign) =>
			faces
				.map((f, i) => ({ f, i }))
				.filter((e) => e.f.normal.x * sign > 0.99)
				.sort((p, q) => (p.f.centroid.x - q.f.centroid.x) * sign);
		const fA = byNormal(1)[0];
		const fB = byNormal(-1)[0];
		if (!fA || !fB) return null;
		w.faceEdit.faceEditMulti.set(true);
		w.faceEdit.faceEditSelectedTris.set([...fA.f.triIndices, ...fB.f.triIndices]);
		return { faces: faces.length, fA: fA.i, fB: fB.i };
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await installProbe(A.page);

	// ------------------------------------------------- 1. bridge a merged mesh
	const uuid = await mergedPair(A.page);
	const start = await A.page.evaluate((u) => window.__geoInfo(u), uuid);
	const drawnStart = await A.page.evaluate((u) => window.__drawnFor(u), uuid);
	h.check(start.materials === 2 && start.groupCount === 2, 'the merge starts multi-material with 2 groups (premise)');
	h.check(drawnStart > 0, 'the merged mesh renders before any edit (premise, ' + drawnStart + ' tris)');
	// each mesh is drawn once per PASS (shadow map + colour), so calibrate the
	// multiplier from this known-good state and demand it exactly afterwards — a
	// partially-grouped geometry draws only SOME of its triangles, which a bare
	// "> 0" would happily pass
	const passes = drawnStart / start.tris;
	h.check(Number.isInteger(passes) && passes > 0, 'render passes per mesh = ' + passes + ' (premise)');

	const picked = await selectFacingFaces(A.page, uuid);
	h.check(!!picked && picked.faces === 12, 'face edit sees 12 faces on the merged pair (premise)');

	const bridged = await A.page.evaluate(() => window.__stores.faceEdit.bridgeFaces());
	h.check(bridged === true, 'bridgeFaces reports success');

	const afterBridge = await A.page.evaluate((u) => window.__geoInfo(u), uuid);
	const drawnBridge = await A.page.evaluate((u) => window.__drawnFor(u), uuid);
	// 24 tris - 2 caps (2 tris each) + 4 wall quads (2 tris each) = 28
	h.check(afterBridge.tris === 28, 'both caps are gone and four wall quads stitched (28 tris)');
	h.check(
		drawnBridge === afterBridge.tris * passes,
		'THE BUG: every triangle of the bridged mesh is still drawn (' +
			drawnBridge + ' of ' + afterBridge.tris * passes + ')'
	);
	h.check(afterBridge.fullyCovered, 'the material groups cover every vertex, in order, with no gap');
	h.check(
		afterBridge.slots.length === 2,
		'both material slots survive the bridge (slots ' + JSON.stringify(afterBridge.slots) + ')'
	);

	// the tunnel really spans the gap between the two boxes
	const span = await A.page.evaluate(async (u) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = new w.THREE.Box3().setFromObject(g.getObjectByProperty('uuid', u));
		return { min: box.min.toArray(), max: box.max.toArray() };
	}, uuid);
	h.check(
		Math.abs(span.min[0] + 2) < 0.01 && Math.abs(span.max[0] - 2) < 0.01,
		'the bridged mesh still spans both boxes'
	);

	// ------------------------------------------------------- 2. undo / redo
	await A.page.evaluate(() => window.__stores.history.undo());
	const undone = await A.page.evaluate((u) => window.__geoInfo(u), uuid);
	const drawnUndo = await A.page.evaluate((u) => window.__drawnFor(u), uuid);
	h.check(undone.tris === 24, 'undo restores the 24-triangle pair');
	h.check(drawnUndo === undone.tris * passes, '...and it is still drawn after the undo swap');
	h.check(undone.fullyCovered && undone.slots.length === 2, '...with both slots intact');

	await A.page.evaluate(() => window.__stores.history.redo());
	const redone = await A.page.evaluate((u) => window.__geoInfo(u), uuid);
	const drawnRedo = await A.page.evaluate((u) => window.__drawnFor(u), uuid);
	h.check(redone.tris === 28 && drawnRedo === redone.tris * passes, 'redo re-bridges and still draws');

	// -------------------------------- 3. the other topology ops on the same mesh
	for (const op of ['extrude', 'inset', 'subdivide']) {
		const ok = await A.page.evaluate(
			({ uuid, op }) => {
				const w = window.__stores;
				w.faceEdit.enterFaceEdit(uuid);
				const faces = w.faceEdit.currentFaces();
				// a face on the SECOND material slot, so a lost slot shows up
				w.faceEdit.faceEditMulti.set(false);
				w.faceEdit.highlightFaceByTriangle(faces[faces.length - 1].triIndices[0]);
				return w.faceEdit.commitFaceOp(op, 0.2);
			},
			{ uuid, op }
		);
		const info = await A.page.evaluate((u) => window.__geoInfo(u), uuid);
		const drawn = await A.page.evaluate((u) => window.__drawnFor(u), uuid);
		h.check(ok === true, op + ' commits');
		h.check(
			drawn === info.tris * passes,
			op + ' leaves every triangle drawn (' + drawn + '/' + info.tris * passes + ')'
		);
		h.check(info.fullyCovered, op + ' leaves the groups covering the whole geometry');
		h.check(info.slots.length === 2, op + ' keeps both material slots');
	}
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());

	// ---------------------- 4. a SINGLE-material mesh is untouched by all this
	const plain = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		box.position.set(0, 0, 6);
		w.faceEdit.enterFaceEdit(box.uuid);
		const faces = w.faceEdit.currentFaces();
		w.faceEdit.highlightFaceByTriangle(faces[0].triIndices[0]);
		w.faceEdit.commitFaceOp('extrude', 0.4);
		w.faceEdit.exitFaceEdit();
		return box.uuid;
	});
	const plainInfo = await A.page.evaluate((u) => window.__geoInfo(u), plain);
	const plainDrawn = await A.page.evaluate((u) => window.__drawnFor(u), plain);
	h.check(plainInfo.materials === 1, 'a plain box is single-material (premise)');
	h.check(plainInfo.groupCount === 0, 'a single-material mesh gains NO groups (unchanged behaviour)');
	h.check(plainDrawn === plainInfo.tris * passes, '...and renders as before');

	// ------------------------------------------------------------ 5. two peers
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const B = await h.setupPage(browser, 'B');
	await installProbe(B.page);
	await h.connect(B, A);

	const netUuid = await mergedPair(A.page);
	await h.eventually(
		() => B.page.evaluate((u) => window.__geoInfo(u), netUuid),
		(info) => !!info && info.tris === 24,
		'B received the merged mesh (premise)',
		20000
	);
	await selectFacingFaces(A.page, netUuid);
	await A.page.evaluate(() => window.__stores.faceEdit.bridgeFaces());

	await h.eventually(
		() => B.page.evaluate((u) => window.__geoInfo(u), netUuid),
		(info) => !!info && info.tris === 28,
		'B receives the bridged geometry',
		20000
	);
	const remote = await B.page.evaluate((u) => window.__geoInfo(u), netUuid);
	const remoteDrawn = await B.page.evaluate((u) => window.__drawnFor(u), netUuid);
	h.check(remote.fullyCovered, 'B rebuilds groups covering the whole geometry');
	h.check(remote.slots.length === 2, 'B keeps both material slots');
	const remotePasses = remoteDrawn / remote.tris;
	h.check(
		Number.isInteger(remotePasses) && remotePasses > 0,
		'B still draws EVERY triangle of the bridged mesh (' + remoteDrawn + '/' + remote.tris + ')'
	);

	await h.finish(browser);
});
