// M6: the cleanup commands — recalculate normals outside, merge by distance,
// smooth/flat shading. (Select all / invert / linked ship with M2 and are
// covered by mesh-loop-select.)
const h = require('./helpers.cjs');

const geoInfo = (page, uuid) =>
	page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const mesh = g.getObjectByProperty('uuid', uuid);
		const geo = mesh.geometry;
		const tris = w.faceEdit.readTriangles(geo);
		// signed volume: positive when the winding faces outward
		let volume = 0;
		for (const t of tris) {
			const cross = new w.THREE.Vector3().crossVectors(t[1], t[2]);
			volume += t[0].dot(cross) / 6;
		}
		// how many triangles disagree with the shell's overall orientation?
		return {
			tris: tris.length,
			volume: +volume.toFixed(4),
			shading: mesh.userData.shading ?? null,
			verts: geo.attributes.position.count
		};
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// -------------------------------- 1. recalculate normals on an inside-out box
	const flipped = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		w.faceEdit.enterFaceEdit(box.uuid);
		// turn the whole box inside out
		w.faceEdit.selectAllFaces();
		w.faceEdit.commitFaceOp('flip', 0);
		return box.uuid;
	});
	const inside = await geoInfo(A.page, flipped);
	h.check(inside.volume < 0, 'the box is inside-out after flipping every face (premise, vol ' + inside.volume + ')');

	const fixed = await A.page.evaluate(() => window.__stores.faceEdit.recalculateNormals());
	const outside = await geoInfo(A.page, flipped);
	h.check(fixed === true, 'Recalculate normals commits');
	h.check(outside.volume > 0, 'THE FIX: every face now points outward (vol ' + outside.volume + ')');
	h.check(outside.tris === inside.tris, '...without changing the triangle count');

	// running it again is a no-op with a toast, not a re-flip
	const again = await A.page.evaluate(() => window.__stores.faceEdit.recalculateNormals());
	const stillOut = await geoInfo(A.page, flipped);
	h.check(again === false, 'running it again reports "already outward" instead of re-flipping');
	h.check(stillOut.volume > 0, '...and leaves the mesh outward-facing');

	// undo restores the inside-out state in one step
	await A.page.evaluate(() => window.__stores.history.undo());
	const undone = await geoInfo(A.page, flipped);
	h.check(undone.volume < 0, 'ONE undo restores the previous winding');
	await A.page.evaluate(() => window.__stores.history.redo());

	// ------------------------------------------- 2. merge by distance
	const dup = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		w.commandsHandler.sceneCommand('/clear all');
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		// two quads that ALMOST touch: 0.0005 apart, well under a 0.01 threshold
		// and well over a 0.0001 one
		const a = [0, 0, 0, 1, 0, 0, 0, 1, 0];
		const b = [1.0005, 0, 0, 2, 0, 0, 1.0005, 1, 0];
		w.faceEdit.applyMeshGeo(box.uuid, [...a, ...b]);
		w.faceEdit.enterFaceEdit(box.uuid);
		return box.uuid;
	});
	const beforeMerge = await geoInfo(A.page, dup);
	h.check(beforeMerge.tris === 2, 'two nearly-touching triangles (premise)');

	const tooTight = await A.page.evaluate(() => window.__stores.faceEdit.mergeByDistance(0.0001));
	h.check(tooTight === false, 'a threshold BELOW the gap merges nothing');

	const mergedOk = await A.page.evaluate(() => window.__stores.faceEdit.mergeByDistance(0.01));
	const afterMerge = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const geo = g.getObjectByProperty('uuid', uuid).geometry;
		const pos = geo.attributes.position;
		const xs = new Set();
		for (let i = 0; i < pos.count; i++) xs.add(+pos.getX(i).toFixed(4));
		return { xs: [...xs].sort((a, b) => a - b), tris: pos.count / 3 };
	}, dup);
	h.check(mergedOk === true, 'a threshold ABOVE the gap merges');
	// only ONE of the two 1.0005 corners has a partner (the other triangle's
	// second corner at that x is far from anything), so the correct result is:
	// x=1 gone, replaced by the pair's centroid ~1.00025, and the lone 1.0005 kept
	h.check(
		!afterMerge.xs.includes(1) && afterMerge.xs.some((x) => x > 1.0001 && x < 1.0004),
		'the near-coincident PAIR collapses to their centroid (' + JSON.stringify(afterMerge.xs) + ')'
	);
	h.check(
		afterMerge.xs.includes(1.0005),
		'...while the corner with no partner is left alone (not swept up)'
	);
	h.check(afterMerge.tris === 2, 'both triangles survive — neither was degenerate');

	// a fully collapsed triangle IS dropped
	const degenerate = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		w.commandsHandler.sceneCommand('/clear all');
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		// one real triangle + one whose corners are all within 0.001
		const good = [0, 0, 0, 1, 0, 0, 0, 1, 0];
		const sliver = [5, 0, 0, 5.0004, 0, 0, 5, 0.0004, 0];
		w.faceEdit.applyMeshGeo(box.uuid, [...good, ...sliver]);
		w.faceEdit.enterFaceEdit(box.uuid);
		const ok = w.faceEdit.mergeByDistance(0.01);
		const geo = g.getObjectByProperty('uuid', box.uuid).geometry;
		return { ok, tris: geo.attributes.position.count / 3 };
	});
	h.check(degenerate.ok === true, 'merging a sliver commits');
	h.check(degenerate.tris === 1, '...and the collapsed triangle is dropped (' + degenerate.tris + ' left)');

	// ------------------------------------------------- 3. smooth / flat shading
	const shading = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		w.commandsHandler.sceneCommand('/clear all');
		// a BOX, not a sphere: SphereGeometry already ships smooth normals, so
		// smoothing it is a no-op and the check could not fail. A box is faceted,
		// and welding its 3 coincident corner normals visibly changes them.
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const s = g.children[g.children.length - 1];
		w.faceEdit.enterFaceEdit(s.uuid);
		const nAt = (i) => {
			const geo = g.getObjectByProperty('uuid', s.uuid).geometry;
			return [geo.attributes.normal.getX(i), geo.attributes.normal.getY(i), geo.attributes.normal.getZ(i)];
		};
		const flatN = nAt(0);
		const before = w.faceEdit.shadingMode();
		w.faceEdit.setShadingSmooth(true);
		const smoothN = nAt(0);
		const after = w.faceEdit.shadingMode();
		// smooth shading must SURVIVE a geometry swap (applyMeshGeo re-derives it)
		const top = w.faceEdit.currentFaces()[0];
		w.faceEdit.pickFaceUnit(top.triIndices[0]);
		w.faceEdit.commitFaceOp('subdivide', 0);
		const stillSmooth = g.getObjectByProperty('uuid', s.uuid).userData.shading;
		w.faceEdit.setShadingSmooth(false);
		return { before, after, flatN, smoothN, stillSmooth, backToFlat: w.faceEdit.shadingMode() };
	});
	h.check(shading.before === 'flat', 'a mesh starts flat-shaded (premise)');
	h.check(shading.after === 'smooth', 'Smooth shading sets the mode');
	h.check(
		shading.flatN.join() !== shading.smoothN.join(),
		'...and really changes the normals (' + shading.flatN.map((n) => n.toFixed(2)) + ' -> ' + shading.smoothN.map((n) => n.toFixed(2)) + ')'
	);
	h.check(shading.stillSmooth === 'smooth', 'smooth shading SURVIVES a geometry swap');
	h.check(shading.backToFlat === 'flat', 'clicking again returns to flat');

	// ------------------------------------------------------- 4. two peers
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const netUuid = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Sphere 0.5');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const s = g.children[g.children.length - 1];
		w.faceEdit.enterFaceEdit(s.uuid);
		return s.uuid;
	});
	await h.eventually(
		() => geoInfo(B.page, netUuid),
		(i) => !!i && i.tris > 0,
		'B received the sphere (premise)',
		20000
	);
	await A.page.evaluate(() => window.__stores.faceEdit.setShadingSmooth(true));
	await h.eventually(
		() => geoInfo(B.page, netUuid),
		(i) => i?.shading === 'smooth',
		'B applies the smooth-shading choice',
		20000
	);

	await h.finish(browser);
});
