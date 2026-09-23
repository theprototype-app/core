// 30b P2: GRIPS BY MODE. The Quest report: "when in game and in edit mode I should be able
// to move around the world and scale it with grips, now it disables this for some reason".
// Nothing disabled the world grab — it only ever fired on EMPTY AIR, and a game scene has
// none: every controller ray ends on a floor, a wall or a ceiling, so every grip grabbed
// the ROOM. The grip now passes through scenery (vrGrip.js), and the mode decides the rest:
// Edit holds anything that is not scenery and moves the world on air; Interact holds only
// dynamic bodies and never moves the world.
//
// Driven through the REAL per-frame path (Scene's useTask -> updateVRControls) with a fake
// XR session (fakeXR.cjs): the suite presses grips and moves controllers.
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');

const state = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const get = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
		const rig = get(s.worldRig);
		return {
			...s.vrControls.vrGripDebug(),
			rigScale: rig.scale.x,
			rigPos: rig.position.toArray(),
			selected: [...get(s.selectedObjects)],
			undo: s.history.undoStack ? get(s.history.undoStack).length : null,
			mode: get(s.editorMode)
		};
	});
const posOf = (page, uuid) =>
	page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		return g.getObjectByProperty('uuid', uuid).position.toArray();
	}, uuid);
const grip = async (page, hand, down) => {
	await xr.button(page, hand, 1, down);
	await page.waitForTimeout(250);
};
const resetRig = (page) => page.evaluate(() => window.__stores.vrControls.resetWorldRig());

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');

	// ---- the fixture: a game-shaped room ---------------------------------------------------
	// a 20 m floor, a 10 m wall 3 m ahead, a dynamic cube and a static podium in front of it
	const ids = await A.page.evaluate(async () => {
		const s = window.__stores;
		const get = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
		for (let i = 0; i < 4; i++) s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 600));
		const boxes = get(s.objectsGroup).children.filter((c) => c.name === 'Box');
		const [floor, wall, cube, podium] = boxes;
		floor.scale.set(20, 0.5, 20);
		floor.position.set(0, -0.25, 0);
		floor.userData.physics = { mode: 'static' };
		wall.scale.set(10, 4, 0.5);
		wall.position.set(0, 2, -3);
		wall.userData.physics = { mode: 'static' };
		cube.scale.setScalar(0.4);
		cube.position.set(0, 1.2, -1.5);
		cube.userData.physics = { mode: 'dynamic', mass: 1 };
		podium.scale.setScalar(0.4);
		podium.position.set(1.2, 1.2, -1.5);
		podium.userData.physics = { mode: 'static' };
		for (const b of boxes) b.updateMatrixWorld(true);
		s.objectActions.deselectObject();
		s.isVRMode.set(true);
		return { floor: floor.uuid, wall: wall.uuid, cube: cube.uuid, podium: podium.uuid };
	});
	await A.page.waitForTimeout(800);
	await xr.install(A.page);
	// both hands aim straight ahead at the WALL (the only thing along -Z at y 1.6)
	const aimWall = async () => {
		await xr.pose(A.page, 'left', [-0.3, 1.6, 0]);
		await xr.pose(A.page, 'right', [0.3, 1.6, 0]);
	};
	await aimWall();
	await A.page.waitForTimeout(200);

	// ---- 1. EDIT: two grips on the wall = the WORLD grab, not the wall ----------------------
	let s = await state(A.page);
	h.check(s.mode === 'edit' && Math.abs(s.rigScale - 1) < 1e-6, `premise: Edit, the world at 1:1 (${s.rigScale})`);
	const wallBefore = await posOf(A.page, ids.wall);
	await grip(A.page, 'left', true);
	await grip(A.page, 'right', true);
	s = await state(A.page);
	h.check(s.grab === null, `Edit: a grip on a wall does not hold the wall (grab ${s.grab})`);
	h.check(s.worldGrab, 'Edit: two grips on scenery start the two-grip WORLD grab');
	// spread the hands: the world scales up
	await xr.pose(A.page, 'left', [-0.6, 1.6, 0]);
	await xr.pose(A.page, 'right', [0.6, 1.6, 0]);
	await A.page.waitForTimeout(300);
	s = await state(A.page);
	h.check(s.rigScale > 1.8, `Edit: spreading the hands scales the world (x${s.rigScale.toFixed(2)})`);
	const wallAfter = await posOf(A.page, ids.wall);
	h.check(JSON.stringify(wallAfter) === JSON.stringify(wallBefore), 'Edit: the wall itself never moved');
	await grip(A.page, 'left', false);
	await grip(A.page, 'right', false);
	await resetRig(A.page);
	await aimWall();

	// ---- 2. EDIT: one right grip on the floor = the one-hand world PAN --------------------------
	await xr.pose(A.page, 'right', [0.3, 1.2, 0], { pitch: -Math.PI / 2 }); // straight down at the floor
	await grip(A.page, 'right', true);
	s = await state(A.page);
	h.check(s.grab === null && s.worldPan, `Edit: a right grip on the floor pans the world (grab ${s.grab}, pan ${s.worldPan})`);
	await grip(A.page, 'right', false);
	await aimWall();

	// ---- 3. EDIT: a grip on the cube still holds and moves it, as always -------------------------
	await xr.pose(A.page, 'right', [0, 1.2, 0]); // aims -Z through the cube at (0,1.2,-1.5)
	const undoBefore = (await state(A.page)).undo;
	await grip(A.page, 'right', true);
	s = await state(A.page);
	h.check(s.grab === ids.cube && !s.grabInteract, `Edit: a grip on the cube holds it (${s.grab})`);
	h.check(s.selected.includes(ids.cube), 'Edit: holding selects it (the editor lock)');
	await xr.pose(A.page, 'right', [0.5, 1.2, 0]);
	await A.page.waitForTimeout(250);
	await grip(A.page, 'right', false);
	const cubeMoved = await posOf(A.page, ids.cube);
	h.check(Math.abs(cubeMoved[0] - 0.5) < 0.05, `Edit: the cube followed the hand (x ${cubeMoved[0].toFixed(2)})`);
	s = await state(A.page);
	if (undoBefore !== null) h.check(s.undo === undoBefore + 1, `Edit: the move is one undo entry (${undoBefore} -> ${s.undo})`);
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());

	// ---- 4. INTERACT: scenery and air do nothing — the world never moves ------------------------
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await aimWall();
	await A.page.waitForTimeout(200);
	await grip(A.page, 'left', true);
	await grip(A.page, 'right', true);
	s = await state(A.page);
	h.check(s.grab === null && !s.worldGrab && !s.worldPan, `Interact: two grips on the wall hold nothing and start no world gesture (${JSON.stringify(s)})`);
	await xr.pose(A.page, 'left', [-0.8, 1.6, 0]);
	await xr.pose(A.page, 'right', [0.8, 1.6, 0]);
	await A.page.waitForTimeout(300);
	s = await state(A.page);
	h.check(Math.abs(s.rigScale - 1) < 1e-6 && s.rigPos.every((v) => Math.abs(v) < 1e-6), `Interact: the world stays put (x${s.rigScale})`);
	await grip(A.page, 'left', false);
	await grip(A.page, 'right', false);

	// ---- 5. INTERACT: the static podium is not holdable ------------------------------------------
	await xr.pose(A.page, 'right', [1.2, 1.2, 0]);
	await grip(A.page, 'right', true);
	s = await state(A.page);
	h.check(s.grab === null, `Interact: a static podium is not holdable (${s.grab})`);
	await grip(A.page, 'right', false);

	// ---- 6. INTERACT: the dynamic cube IS, as a player's hand -----------------------------------
	const cubeNow = await posOf(A.page, ids.cube);
	await xr.pose(A.page, 'right', [cubeNow[0], 1.2, 0]);
	const undoInteract = (await state(A.page)).undo;
	await grip(A.page, 'right', true);
	s = await state(A.page);
	h.check(s.grab === ids.cube && s.grabInteract, `Interact: a grip holds the dynamic cube (${s.grab}, interact ${s.grabInteract})`);
	h.check(!s.selected.includes(ids.cube), 'Interact: holding is not selecting (no editor lock)');
	await xr.pose(A.page, 'right', [cubeNow[0] - 0.5, 1.2, 0]);
	await A.page.waitForTimeout(250);
	await grip(A.page, 'right', false);
	const cubeThrown = await posOf(A.page, ids.cube);
	h.check(Math.abs(cubeThrown[0] - (cubeNow[0] - 0.5)) < 0.05, `Interact: the cube followed the hand (x ${cubeThrown[0].toFixed(2)})`);
	s = await state(A.page);
	if (undoInteract !== null) h.check(s.undo === undoInteract, `Interact: a player's grab is not an undo step (${undoInteract} -> ${s.undo})`);

	// ---- 7. back to EDIT: the world grab works again ---------------------------------------------
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	await aimWall();
	await grip(A.page, 'left', true);
	await grip(A.page, 'right', true);
	s = await state(A.page);
	h.check(s.worldGrab, 'back in Edit: two grips on the wall grab the world again');
	await grip(A.page, 'left', false);
	await grip(A.page, 'right', false);

	await resetRig(A.page);
	await xr.uninstall(A.page);
	await A.page.evaluate(() => window.__stores.isVRMode.set(false));
	await h.finish(browser);
});
