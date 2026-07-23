// D2 (roadmap 13): three caches an InstancedMesh boundingSphere for its
// raycast pre-check; refreshHandleMatrix never invalidated it, so vertex
// handles that moved outside the initial bounds (the edited object moved, a
// far vertex drag) were silently unpickable. We enter edit mode, verify a
// handle picks at the spawn spot, MOVE the object far away, re-pose the
// handles (tickMeshEdit) and check the handle still picks at its new spot.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		s.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		box.position.set(0, 0, 0);
		box.updateMatrixWorld(true);
		s.meshEdit.enterEditMode(box.uuid);

		const rayAt = (x, y) => {
			const rc = new THREE.Raycaster();
			rc.ray.origin.set(x, y, 5);
			rc.ray.direction.set(0, 0, -1);
			return s.meshEdit.vrRaycastHandle(rc);
		};

		// baseline: the (0.5, 0.5, 0.5) corner handle picks where it spawned
		const before = rayAt(0.5, 0.5);

		// move the object FAR outside the initial handle bounds and re-pose
		box.position.set(50, 0, 0);
		box.updateMatrixWorld(true);
		s.meshEdit.tickMeshEdit();
		const after = rayAt(50.5, 0.5);
		const staleSpot = rayAt(0.5, 0.5);

		s.meshEdit.exitEditMode();
		return { before, after, staleSpot };
	});

	h.check(res.before >= 0, `handle picks at the spawn spot (index ${res.before})`);
	h.check(
		res.after >= 0,
		`handle still picks after the object moved 50 units away (index ${res.after})`
	);
	h.check(res.staleSpot === -1, 'nothing picks at the old spot anymore');

	await h.finish(browser);
});
