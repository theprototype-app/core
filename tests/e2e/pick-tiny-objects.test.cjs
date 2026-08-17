// R2 — an object scaled (or animated) down to nothing stays clickable.
//
// Reported from the animation side: a scale channel that reaches 0 leaves no
// geometry for the raycaster, so the viewport click finds nothing and the object
// list is the only way back to it. Below a few projected pixels an object now gets
// a minimum-size hit target at its centre.
//
// The second half of this suite matters as much as the first: picking for
// NORMAL-sized objects must be unchanged, because this runs inside the one path
// selection, snapping and Explorer drops all share.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const built = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 800));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.children[g.children.length - 1];
		object.position.set(0, 1, 0);
		object.updateMatrixWorld(true);
		w.objectsGroup.update((v) => v);
		w.objectActions.deselectObject();
		return { uuid: object.uuid };
	});
	h.check(!!built.uuid, 'a box at (0,1,0) (premise)');

	// where it is on screen, while it is still full size
	const point = await h.projectPoint(A.page, [0, 1, 0]);
	h.check(!!point && point.x > 0 && point.y > 0, `it projects onto the canvas (${JSON.stringify(point)})`);

	// ---- 1. full size: the click works, and NO proxy was involved -----------
	await A.page.mouse.click(point.x, point.y);
	await A.page.waitForTimeout(300);
	const normal = await A.page.evaluate((uuid) => {
		const w = window.__stores;
		let set = [];
		w.selectedObjects.subscribe((v) => (set = v))();
		return { selected: set.length === 1 && set[0] === uuid };
	}, built.uuid);
	h.check(normal.selected, 'a full-size box selects on click (premise)');

	// ---- 2. scaled to nothing: the click still finds it ---------------------
	const shrunk = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		w.objectActions.deselectObject();
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		object.scale.set(0, 0, 0); // exactly what a scale channel at its far key does
		object.updateMatrixWorld(true);
		w.objectsGroup.update((v) => v);
		// the REAL raycast must find nothing now — that is the premise of the fix
		const raycaster = new w.THREE.Raycaster();
		let camera;
		w.globalCamera.subscribe((v) => (camera = v))();
		const centre = new w.THREE.Vector3(0, 1, 0).project(camera);
		raycaster.setFromCamera(new w.THREE.Vector2(centre.x, centre.y), camera);
		return { rawHits: w.scenePick.sceneHits(raycaster).length };
	}, built.uuid);
	h.check(shrunk.rawHits === 0, `a zero-scaled box has no geometry to hit (raw hits: ${shrunk.rawHits})`);

	await A.page.mouse.click(point.x, point.y);
	await A.page.waitForTimeout(300);
	const picked = await A.page.evaluate((uuid) => {
		let set = [];
		window.__stores.selectedObjects.subscribe((v) => (set = v))();
		return { selected: set.length === 1 && set[0] === uuid, count: set.length };
	}, built.uuid);
	h.check(
		picked.selected,
		`THE FIX: a real click still selects it (${picked.count} selected)`
	);

	// ---- 3. it is a PROXY hit, and only when asked for ----------------------
	const shape = await A.page.evaluate(() => {
		const w = window.__stores;
		const raycaster = new w.THREE.Raycaster();
		let camera;
		w.globalCamera.subscribe((v) => (camera = v))();
		// aim where the object ACTUALLY projects: the screen centre is wherever the
		// orbit target happens to be, which is not the same thing
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const centre = new w.THREE.Vector3(0, 1, 0).project(camera);
		raycaster.setFromCamera(new w.THREE.Vector2(centre.x, centre.y), camera);
		const without = w.scenePick.sceneHits(raycaster);
		const with_ = w.scenePick.sceneHits(raycaster, { tinyProxies: true });
		return {
			without: without.length,
			with: with_.length,
			isProxy: !!with_[0]?.tinyProxy,
			hasFace: !!with_[0]?.face
		};
	});
	h.check(shape.without === 0 && shape.with === 1, 'the proxy is OPT-IN (0 without, 1 with)');
	h.check(shape.isProxy, '...and is marked as a proxy hit');
	h.check(
		!shape.hasFace,
		'...carrying no face, so snapping and drops (which need surfaces) ignore it'
	);

	// ---- 4. normal picking is UNCHANGED — the regression guard --------------
	const unchanged = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		g.getObjectByProperty('uuid', uuid).scale.set(1, 1, 1);
		// a few more ordinary objects, so the comparison is not trivial
		w.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 400));
		w.commandsHandler.sceneCommand('/create box 2 2 2');
		await new Promise((r) => setTimeout(r, 600));
		w.objectsGroup.subscribe((v) => (g = v))();
		g.children.forEach((c, i) => c.position.set(i * 2 - 2, 1, 0));
		g.updateMatrixWorld(true);
		w.objectsGroup.update((v) => v);
		let camera;
		w.globalCamera.subscribe((v) => (camera = v))();
		const describe = (list) =>
			list.map((hit) => `${hit.object.uuid}@${hit.distance.toFixed(4)}`).join('|');
		// sweep the viewport rather than trusting one ray
		const rows = [];
		// rays aimed AT the objects (plus small offsets), so the comparison is over
		// rays that actually hit something — a blind NDC grid mostly hits empty space
		const aims = [];
		for (const child of g.children) {
			const ndc = child.getWorldPosition(new w.THREE.Vector3()).project(camera);
			for (const dx of [0, 0.01, -0.01]) for (const dy of [0, 0.01]) aims.push([ndc.x + dx, ndc.y + dy]);
		}
		for (const [x, y] of aims) {
			{
				const raycaster = new w.THREE.Raycaster();
				raycaster.setFromCamera(new w.THREE.Vector2(x, y), camera);
				rows.push({
					plain: describe(w.scenePick.sceneHits(raycaster)),
					proxied: describe(w.scenePick.sceneHits(raycaster, { tinyProxies: true }))
				});
			}
		}
		return {
			rays: rows.length,
			identical: rows.every((r) => r.plain === r.proxied),
			nonEmpty: rows.filter((r) => r.plain.length > 0).length
		};
	}, built.uuid);
	h.check(unchanged.nonEmpty > 3, `the sweep really hit things (${unchanged.nonEmpty} of ${unchanged.rays} rays)`);
	h.check(
		unchanged.identical,
		`with only normal-sized objects, the proxy changes NOTHING across ${unchanged.rays} rays`
	);

	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A))})`);
	await h.finish(browser);
});
