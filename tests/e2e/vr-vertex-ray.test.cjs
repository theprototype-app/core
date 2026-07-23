// D8 (roadmap 13): in VERTEX edit mode the beam landed off-geometry — the
// blue wireframe overlay is a LineSegments CHILD of the edited object, and
// three raycasts lines with a 1-WORLD-UNIT threshold, so rays up to a metre
// off the surface "hit" invisible fat lines (faces mode was immune: its
// overlay lives at the scene root). The overlay is now non-raycastable and
// the scene-root vertex HANDLES join beamTarget so the reticle terminates on
// the dot you point at. On-device feel is the user's manual check.
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

		const beam = (x, y) => {
			const ray = new THREE.Raycaster();
			ray.ray.origin.set(x, y, 5);
			ray.ray.direction.set(0, 0, -1);
			return s.vrControls.beamTarget(ray);
		};

		// a ray passing 0.4 units OUTSIDE the box corner: within the 1-unit
		// line threshold of the overlay edges — used to phantom-hit
		const nearMiss = beam(0.9, 0.9);
		// a ray through the +Z face (off the corner handles + face diagonal)
		const surface = beam(0.2, -0.3);
		// a ray at the (0.5, 0.5, 0.5) corner: the handle dot is the nearest hit
		const handle = beam(0.5, 0.5);

		const out = {
			nearMiss: { hit: nearMiss.hit, d: nearMiss.distance },
			surface: {
				hit: surface.hit,
				d: surface.distance,
				isMesh: surface.info?.object?.isMesh === true,
				isLine: surface.info?.object?.isLineSegments === true,
				obj: surface.object?.uuid === box.uuid
			},
			handle: {
				hit: handle.hit,
				d: handle.distance,
				instanced: handle.info?.object?.isInstancedMesh === true,
				obj: handle.object
			}
		};
		s.meshEdit.exitEditMode();
		// after exit the same near-miss ray still hits nothing
		const after = beam(0.9, 0.9);
		out.afterExit = { hit: after.hit };
		return out;
	});

	h.check(
		res.nearMiss.hit === false,
		`a near-miss ray no longer phantom-hits the overlay lines (hit ${res.nearMiss.hit})`
	);
	h.check(
		res.surface.hit &&
			Math.abs(res.surface.d - 4.5) < 0.01 &&
			res.surface.isMesh &&
			!res.surface.isLine &&
			res.surface.obj,
		`a face ray lands ON the mesh surface at the true distance (d ${res.surface.d.toFixed(3)})`
	);
	h.check(
		res.handle.hit &&
			res.handle.d < 4.5 &&
			res.handle.instanced &&
			res.handle.obj === null,
		`the corner ray terminates on the vertex HANDLE dot, not the surface behind it (d ${res.handle.d.toFixed(3)})`
	);
	h.check(res.afterExit.hit === false, 'exiting edit mode removes the handle targets');

	await h.finish(browser);
});
