// 31 K1 (D2/S1) — A GAME'S TELEPORT STAYS IN THE GAME. The user, on a Quest 3: "Dungeon
// Realms ... I would like to be able to teleport but not outside the dungeon walls" and "In
// Stars room I would like to be able to teleport but not outside the scene".
//
// A walled test room (a floor, a 1.5 m wall at x = 2, play.bounds x/z in [-4, 8]) with
// `play.locomotion.teleport: true`, in Interact, driven through fakeXR's real stick path
// (right stick UP arms the arc, release blinks):
// 1 the verdict entry point (the dungeon lane's e2e uses it): a floor target inside -> ok,
// behind the wall -> blocked, beyond the bounds -> outside, a wall face -> steep · 2 the REAL
// arc: aimed short it lands on the floor GREEN and the release moves you there, feet on the
// floor · 3 aimed over the wall it lands behind it RED and the release does nothing · 4 aimed
// at the wall it ends ON the wall face, red · 5 a dungeon RASTER: a wall cell on the way is
// refused (wall-cell) · 6 without `teleport` there is no arc at all in Interact · 7 Edit's
// teleport is unchanged: the same over-the-wall landing is green and taken.
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	await page.evaluate(async () => {
		const s = window.__stores;
		const get = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
		for (let i = 0; i < 2; i++) s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 600));
		const [floor, wall] = get(s.objectsGroup).children.filter((c) => c.name === 'Box');
		floor.scale.set(14, 0.2, 14);
		floor.position.set(2, -0.1, 2);
		floor.userData.physics = { mode: 'static' };
		wall.scale.set(0.3, 1.5, 14);
		wall.position.set(2, 0.75, 2);
		wall.userData.physics = { mode: 'static' };
		for (const b of [floor, wall]) b.updateMatrixWorld(true);
		s.objectActions.deselectObject();
		s.isVRMode.set(true);
		s.scenePhysics.setScenePhysics({ play: { locomotion: { teleport: true }, bounds: { min: [-4, -0.5, -4], max: [8, 0.5, 8] } } });
		s.objectActions.setEditorMode('interact');
		s.vrTeleportEnabled?.set?.(true);
	});
	await page.waitForTimeout(500);
	await xr.install(page);
	await xr.installSpace(page, { head: [0, 1.6, 0], yaw: 0 });

	// ---- 1 the verdict ---------------------------------------------------------------------------
	const v = await page.evaluate(() => {
		const t = window.__stores.vrControls.teleportVerdict;
		return {
			inside: t([0, 0, 0], [1, 0, 0]),
			behind: t([0, 0, 0], [5, 0, 0]),
			outside: t([0, 0, 0], [0, 0, 9]),
			steep: t([0, 0, 0], [1.85, 0.6, 0], 0)
		};
	});
	h.check(v.inside.ok, `a floor target inside -> ok (${JSON.stringify(v.inside)})`);
	h.check(!v.behind.ok && v.behind.reason === 'blocked', `behind the wall -> blocked (${JSON.stringify(v.behind)})`);
	h.check(!v.outside.ok && v.outside.reason === 'outside', `beyond the bounds -> outside (${JSON.stringify(v.outside)})`);
	h.check(!v.steep.ok && v.steep.reason === 'steep', `a wall face -> steep (${JSON.stringify(v.steep)})`);

	// ---- 1a a DYNAMIC body in the line is not a wall (the Stars Room's floating stars, at the
	// probe's height); the same box made static blocks
	const dyn = await page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 500));
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const star = g.children.filter((c) => c.name === 'Box').at(-1);
		star.scale.setScalar(0.4);
		star.position.set(0.8, 1.1, 0.8);
		star.updateMatrixWorld(true);
		s.objectActions.deselectObject();
		const t = s.vrControls.teleportVerdict;
		star.userData.physics = { mode: 'dynamic', mass: 1 };
		const dynamic = t([0, 0, 0], [1.5, 0, 1.5]);
		star.userData.physics = { mode: 'static' };
		const fixed = t([0, 0, 0], [1.5, 0, 1.5]);
		g.remove(star);
		return { dynamic, fixed };
	});
	h.check(dyn.dynamic.ok, `a dynamic body in the line does not refuse the landing (${JSON.stringify(dyn.dynamic)})`);
	h.check(!dyn.fixed.ok && dyn.fixed.reason === 'blocked', `the same box static blocks it (${JSON.stringify(dyn.fixed)})`);

	// ---- 1b no play.bounds: the scene's content box pulled in 0.3 m (the floor spans x -5..9) --
	const fb = await page.evaluate(() => {
		const s = window.__stores;
		s.scenePhysics.setScenePhysics({ play: { locomotion: { teleport: true }, bounds: null } });
		const t = s.vrControls.teleportVerdict;
		const r = { inside: t(null, [8.5, 0, 0]), edge: t(null, [8.85, 0, 0]), beyond: t(null, [12, 0, 0]) };
		s.scenePhysics.setScenePhysics({ play: { bounds: { min: [-4, -0.5, -4], max: [8, 0.5, 8] } } });
		return r;
	});
	h.check(fb.inside.ok && fb.edge.reason === 'outside' && fb.beyond.reason === 'outside', `no bounds: the content box shrunk 0.3 m decides (${JSON.stringify(fb)})`);

	// the stick: aim the right controller from (0, 1.2, 0) toward +x at `pitch`, push up, read
	const aimAndArm = async (pitch) => {
		await xr.pose(page, 'right', [0, 1.2, 0], { yaw: -Math.PI / 2, pitch });
		await xr.stick(page, 'right', 0, -1);
		await page.waitForTimeout(250);
		return page.evaluate(() => window.__stores.vrControls.teleportPreview());
	};
	const release = async () => {
		await xr.stick(page, 'right', 0, 0);
		await page.waitForTimeout(250);
		return xr.head(page);
	};

	// ---- 2 short: the floor, green, taken --------------------------------------------------------
	let p = await aimAndArm(-0.5);
	h.check(p.engaged && p.bounded && p.valid && p.color === 0x22cc66, `aimed short: a green arc on the floor (${JSON.stringify(p)})`);
	h.check(p.target && p.target[0] > 0.5 && p.target[0] < 1.9, `the landing is in front of the wall (x ${p.target?.[0]?.toFixed(2)})`);
	let head = await release();
	h.check(Math.abs(head.x - p.target[0]) < 0.05 && Math.abs(head.y - 1.6) < 0.05, `the release moves you there, feet on the floor (${head.x.toFixed(2)}, ${head.y.toFixed(2)})`);
	// back to the start
	await xr.installSpace(page, { head: [0, 1.6, 0], yaw: 0 });

	// ---- 2b onto a 0.5 m platform: the FEET land on its top (Edit keeps the head height) ------
	await page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 500));
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const b = g.children.filter((c) => c.name === 'Box').at(-1);
		b.scale.set(0.6, 0.5, 1);
		b.position.set(1.2, 0.25, -3);
		b.userData.physics = { mode: 'static' };
		b.updateMatrixWorld(true);
		s.objectActions.deselectObject();
	});
	// a simulation runs: without one the 30b walker has only the plane tier, nothing to stand
	// a platform on, and gravity takes you back down to y 0 (its limit, not the teleport's)
	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(() => page.evaluate(() => window.__stores.physics.physicsWorldDebug().running), (ok) => ok, 'premise: a simulation runs', 15000);
	await xr.installSpace(page, { head: [0, 1.6, -3], yaw: 0 });
	await xr.pose(page, 'right', [0, 1.2, -3], { yaw: -Math.PI / 2, pitch: -0.5 });
	await xr.stick(page, 'right', 0, -1);
	await page.waitForTimeout(250);
	p = await page.evaluate(() => window.__stores.vrControls.teleportPreview());
	h.check(p.valid && Math.abs(p.target[1] - 0.5) < 0.01, `aimed at the platform: a green landing on its top (${JSON.stringify(p.target)})`);
	head = await release();
	h.check(Math.abs(head.y - 2.1) < 0.05, `the release stands you ON it: head 0.5 m higher (${head.y.toFixed(2)})`);
	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await page.waitForTimeout(300);
	await xr.installSpace(page, { head: [0, 1.6, 0], yaw: 0 });

	// ---- 3 over the wall: red, and the release does nothing ------------------------------------
	p = await aimAndArm(0.35);
	h.check(p.target && p.target[0] > 2.2 && !p.valid && p.reason === 'blocked' && p.color === 0xcc3344, `over the wall: a RED arc behind it (${JSON.stringify(p)})`);
	head = await release();
	h.check(Math.abs(head.x) < 0.01 && Math.abs(head.z) < 0.01, `the release does nothing (${head.x.toFixed(2)}, ${head.z.toFixed(2)})`);

	// ---- 4 at the wall: the arc ends ON the face, red --------------------------------------------
	p = await aimAndArm(-0.05);
	h.check(p.target && Math.abs(p.target[0] - 1.85) < 0.05 && !p.valid && p.reason === 'steep', `at the wall: the arc ends on its face, refused (${JSON.stringify(p)})`);
	await release();

	// ---- 5 a dungeon raster -----------------------------------------------------------------------
	const raster = await page.evaluate(() => {
		const s = window.__stores;
		let scene;
		s.globalScene.subscribe((v) => (scene = v))();
		const THREE = s.THREE;
		const g = new THREE.Group();
		g.name = 'dungeon-module';
		// 10 x 10 cells from (-2, -2): floor everywhere but a wall column at x = 5 (cell 7)
		const W = 10;
		const grid = new Array(W * W).fill(0);
		for (let z = 0; z < W; z++) grid[z * W + 7] = 1;
		g.userData.play = { grid, width: W, height: W, minX: -2, minY: -2, floorValue: 0, rooms: [] };
		scene.add(g);
		const t = s.vrControls.teleportVerdict;
		const r = { near: t([0, 0, 0], [1, 0, 1]), across: t([4, 0, 0], [6.5, 0, 0]) };
		scene.remove(g);
		return r;
	});
	h.check(raster.near.ok, `raster: a floor cell nearby -> ok (${JSON.stringify(raster.near)})`);
	h.check(!raster.across.ok && raster.across.reason === 'wall-cell', `raster: a wall cell on the way -> refused (${JSON.stringify(raster.across)})`);

	// ---- 6 no teleport flag: no arc in Interact ----------------------------------------------------
	await page.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ play: { locomotion: {} } }));
	p = await aimAndArm(-0.5);
	h.check(!p.engaged, 'Interact without play.locomotion.teleport: no arc at all');
	await release();

	// ---- 7 Edit is unchanged: over the wall is green and taken -----------------------------------
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	await xr.installSpace(page, { head: [0, 1.6, 0], yaw: 0 });
	p = await aimAndArm(0.35);
	h.check(p.engaged && !p.bounded && p.valid && p.target[0] > 2.2, `Edit: the same landing behind the wall is green (${JSON.stringify(p)})`);
	head = await release();
	h.check(head.x > 2.2, `Edit: and taken (x ${head.x.toFixed(2)})`);

	await xr.uninstall(page);
	await h.finish(browser);
});
