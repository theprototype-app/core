// 30b P4: ENTER INTERACT, SWITCH IN VR, SPAWN. The Quest report: "By default for games
// there should be interact mode in VR, but I should be able to switch to edit mode" and
// "When getting back to interactive mode, if the game should have a specific place where
// the character should stand, it should move."
//  · a VR session on a GAME lands in Interact (vrControls.onVRSessionStart),
//  · the LEFT Y button toggles Edit <-> Interact, with a haptic tick and a wrist label,
//  · entering Interact resets the world to 1:1 and puts the FEET on the spawn, facing it,
//  · the spawn is the scene's `play.spawn`, overridden by a module's api.setSpawn,
//  · desktop Play spawns the play camera there; desktop Interact flies the editor view.
// Driven through the real per-frame path with a spec-accurate fake XR space (fakeXR.cjs).
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');

const mode = (page) => page.evaluate(() => { let v; window.__stores.editorMode.subscribe((x) => (v = x))(); return v; });
const near = (a, b, eps = 0.05) => Math.abs(a - b) < eps;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await A.page.waitForTimeout(400);

	// ---- 0. no spawn, not a game: a session start keeps Edit --------------------------------
	await A.page.evaluate(() => window.__stores.isVRMode.set(true));
	await xr.install(A.page);
	await xr.installSpace(A.page, { head: [0.4, 1.6, 0.2], yaw: 0.3 });
	await A.page.evaluate(() => window.__stores.vrControls.onVRSessionStart());
	h.check((await mode(A.page)) === 'edit', 'a plain scene: entering VR stays in Edit');
	h.check(!(await A.page.evaluate(() => window.__stores.vrControls.sceneIsGame())), 'premise: the scene is not a game');

	// ---- 1. a game (it names a spawn): entering VR lands in Interact, ON the spawn -------------
	const SPAWN = { position: [3, 0, -4], yaw: Math.PI / 2 };
	await A.page.evaluate((spawn) => window.__stores.scenePhysics.setScenePhysics({ play: { spawn } }), SPAWN);
	// the world was left grabbed in Edit: Interact must put it back to 1:1
	await A.page.evaluate(() => {
		let rig;
		window.__stores.worldRig.subscribe((x) => (rig = x))();
		rig.scale.setScalar(2.5);
		rig.position.set(1, 0, 1);
		rig.updateMatrixWorld(true);
	});
	await A.page.evaluate(() => window.__stores.vrControls.onVRSessionStart());
	await A.page.waitForTimeout(300);
	h.check((await mode(A.page)) === 'interact', 'a game: entering VR lands in INTERACT');
	let head = await xr.head(A.page);
	h.check(near(head.x, 3) && near(head.z, -4), `the player stands ON the spawn (head ${head.x.toFixed(2)}, ${head.z.toFixed(2)})`);
	h.check(near(head.y - 1.6, 0), `the FEET are at the spawn height (feet ${(head.y - 1.6).toFixed(2)})`);
	h.check(near(wrap(head.yaw - SPAWN.yaw), 0, 0.02), `facing the spawn's yaw (${head.yaw.toFixed(3)})`);
	const rig = await A.page.evaluate(() => { let r; window.__stores.worldRig.subscribe((x) => (r = x))(); return { s: r.scale.x, p: r.position.toArray() }; });
	h.check(rig.s === 1 && rig.p.every((v) => v === 0), `Interact put the world back to 1:1 (${JSON.stringify(rig)})`);

	// ---- 2. the LEFT Y button: to Edit, with a tick and the label -------------------------------
	let label = await A.page.evaluate(() => window.__stores.vrControls.vrModeLabelDebug());
	h.check(label.visible && label.text === 'INTERACT' && label.hand === 'left', `the wrist label says INTERACT on the left hand (${JSON.stringify(label)})`);
	const before = await xr.pulses(A.page);
	await xr.button(A.page, 'left', 5, true);
	await A.page.waitForTimeout(200);
	await xr.button(A.page, 'left', 5, false);
	await A.page.waitForTimeout(200);
	h.check((await mode(A.page)) === 'edit', 'left Y: Interact -> Edit');
	const after = await xr.pulses(A.page);
	h.check(after.left === before.left + 1, `a haptic tick on the left hand (${before.left} -> ${after.left})`);
	label = await A.page.evaluate(() => window.__stores.vrControls.vrModeLabelDebug());
	h.check(label.text === 'EDIT', `the label follows: ${label.text}`);
	h.check(!(await A.page.evaluate(() => { let v; window.__stores.vrMenuOpen.subscribe((x) => (v = x))(); return v; })), 'the radial menu (right B by default) did not open');

	// walk away in Edit, then Y again: Interact puts you back on the spawn
	await A.page.evaluate(() => {
		const r = window.__fakeXR.renderer;
		r.xr.setReferenceSpace(r.xr.getReferenceSpace().getOffsetReferenceSpace(new XRRigidTransform({ x: -2, y: 0, z: 3 })));
	});
	head = await xr.head(A.page);
	h.check(!near(head.x, 3), `premise: moved off the spawn in Edit (x ${head.x.toFixed(2)})`);
	await xr.button(A.page, 'left', 5, true);
	await A.page.waitForTimeout(200);
	await xr.button(A.page, 'left', 5, false);
	await A.page.waitForTimeout(200);
	head = await xr.head(A.page);
	h.check((await mode(A.page)) === 'interact' && near(head.x, 3) && near(head.z, -4), `left Y back to Interact re-spawns (${head.x.toFixed(2)}, ${head.z.toFixed(2)})`);

	// ---- 3. a menu on the LEFT hand moves the mode button to the right B ----------------------
	await A.page.evaluate(() => window.__stores.vrMenuHand.set('left'));
	await xr.button(A.page, 'right', 5, true);
	await A.page.waitForTimeout(200);
	await xr.button(A.page, 'right', 5, false);
	await A.page.waitForTimeout(200);
	h.check((await mode(A.page)) === 'edit', 'menu on the left: the RIGHT B toggles the mode');
	await A.page.evaluate(() => window.__stores.vrMenuHand.set('right'));
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));

	// ---- 4. a module's api.setSpawn overrides the scene's; teleport moves you now --------------
	await A.page.evaluate(() => {
		window.__stores.moduleSDK.initModules([{ id: 'spawntest', name: 'Spawn test', version: '1', register(api) { window.__spawnApi = api; } }]);
	});
	const ok = await A.page.evaluate(() => window.__spawnApi.setSpawn([-5, 0, 2], Math.PI));
	h.check(ok === true, 'api.setSpawn accepts [x, y, z] + yaw');
	head = await xr.head(A.page);
	h.check(near(head.x, 3), 'without {teleport} a new spawn is a checkpoint: nobody moves yet');
	await A.page.evaluate(() => window.__spawnApi.setSpawn([-5, 0, 2], Math.PI, { teleport: true }));
	await A.page.waitForTimeout(100);
	head = await xr.head(A.page);
	h.check(near(head.x, -5) && near(head.z, 2) && near(head.y, 1.6), `{teleport: true} moves the player there now (${head.x.toFixed(2)}, ${head.y.toFixed(2)}, ${head.z.toFixed(2)})`);
	h.check(near(Math.abs(wrap(head.yaw)), Math.PI, 0.02), `...facing the module's yaw (${head.yaw.toFixed(3)})`);
	h.check(!(await A.page.evaluate(() => window.__spawnApi.setSpawn([1, NaN, 2]))), 'a malformed spawn is refused');
	await A.page.evaluate(() => window.__stores.moduleSDK.deactivateModule('spawntest'));
	const back = await A.page.evaluate(() => window.__stores.playSettings.resolvePlaySettings((() => { let v; window.__stores.globalScene.subscribe((x) => (v = x))(); return v; })()).spawn);
	h.check(back && back.position[0] === 3, `disabling the module drops its spawn: the scene's is back (${JSON.stringify(back)})`);

	await xr.uninstall(A.page);
	await A.page.evaluate(() => window.__stores.isVRMode.set(false));
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	await A.page.waitForTimeout(300);

	// ---- 5. desktop Play spawns the play camera on the scene's spawn ------------------------------
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	await A.page.waitForTimeout(500);
	const cam = await A.page.evaluate(() => {
		let c;
		window.__stores.playerCam.subscribe((x) => (c = x))();
		const THREE = window.__stores.THREE;
		const p = c.getWorldPosition(new THREE.Vector3());
		const f = new THREE.Vector3(0, 0, -1).applyQuaternion(c.getWorldQuaternion(new THREE.Quaternion()));
		return { p: p.toArray(), yaw: Math.atan2(-f.x, -f.z) };
	});
	h.check(near(cam.p[0], 3) && near(cam.p[2], -4) && near(cam.p[1], 1.7), `desktop Play: the camera's eye is on the spawn (${cam.p.map((v) => v.toFixed(2))})`);
	h.check(near(wrap(cam.yaw - SPAWN.yaw), 0, 0.02), `desktop Play: facing the spawn's yaw (${cam.yaw.toFixed(3)})`);
	await A.page.evaluate(() => window.__stores.isLocked.set(false));
	await A.page.waitForTimeout(400);

	// ---- 6. desktop Interact flies the editor view there --------------------------------------------
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await A.page.waitForTimeout(900);
	const ed = await A.page.evaluate(() => { let c; window.__stores.globalCamera.subscribe((x) => (c = x))(); return c.position.toArray(); });
	h.check(near(ed[0], 3, 0.2) && near(ed[2], -4, 0.2), `desktop Interact: the editor view moved to the spawn (${ed.map((v) => v.toFixed(2))})`);
	await A.page.evaluate(() => {
		window.__stores.objectActions.setEditorMode('edit');
		window.__stores.scenePhysics.setScenePhysics({ play: { spawn: null } });
	});

	await h.finish(browser);
});
