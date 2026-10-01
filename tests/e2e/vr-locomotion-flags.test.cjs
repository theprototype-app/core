// 31 K1 (U1/J1) — THE GRIPS MOVE THE WORLD IN A GAME, WHEN THE GAME SAYS SO. The user, on a
// Quest 3: "Entangle game does not allow me to scale scene with grips within game, only in
// edit mode" and "In Jam Room I would like to be able to fly around and also scale the entire
// environment with grips and move around same as in edit mode".
//
// `play.locomotion.worldGrab: true` gives Interact/Play Edit's world gestures on any grip
// that does not start on something a player may hold. Through fakeXR (the real per-frame
// grip path), a game-shaped room: 1 the typed normaliser keeps worldGrab/teleport/fly and
// nothing else, and play.bounds survives the scene store · 2 WITHOUT the flag Interact's
// grips never move the world (the 30b rule, the counterfactual) · 3 WITH it two grips on the
// wall scale the world and one right grip pans it · 4 a grip on a grabbable still takes the
// BODY, not the world · 5 a module publisher can turn it on (userData.play) and the SDK
// probe says so. (`fly` is the 30b walker flag, unchanged and covered by vr-walk-interact.)
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');

const state = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const get = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
		const rig = get(s.worldRig);
		return { ...s.vrControls.vrGripDebug(), rigScale: rig.scale.x, rigPos: rig.position.toArray(), mode: get(s.editorMode) };
	});
const grip = async (page, hand, down) => {
	await xr.button(page, hand, 1, down);
	await page.waitForTimeout(250);
};
const setPlay = (page, play) =>
	page.evaluate((play) => {
		window.__stores.scenePhysics.setScenePhysics({ play });
	}, play);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// ---- 1 the normaliser --------------------------------------------------------------------
	const norm = await page.evaluate(() => {
		const s = window.__stores;
		const n = s.scenePhysics.normalizeScenePhysics({
			play: { locomotion: { worldGrab: true, teleport: true, fly: false, walkOnWater: true, jet: 'yes' }, bounds: { min: [4, 0, -4], max: [-4, 3, 4] } }
		});
		const bad = s.scenePhysics.normalizeScenePhysics({ play: { bounds: { min: [0, 0, 'x'], max: [1, 1, 1] } } });
		const plain = s.scenePhysics.normalizeScenePhysics({});
		return { loco: n.play.locomotion, bounds: n.play.bounds, bad: 'bounds' in bad.play && bad.play.bounds !== undefined ? bad.play.bounds : 'absent', plainKeys: Object.keys(plain.play) };
	});
	h.check(JSON.stringify(norm.loco) === JSON.stringify({ teleport: true, fly: false, worldGrab: true }), `locomotion keeps the typed flags only (${JSON.stringify(norm.loco)})`);
	h.check(JSON.stringify(norm.bounds) === JSON.stringify({ min: [-4, 0, -4], max: [4, 3, 4] }), `play.bounds survives, each axis ordered (${JSON.stringify(norm.bounds)})`);
	h.check(norm.bad === 'absent' || norm.bad === null, `a bad bounds is dropped (${JSON.stringify(norm.bad)})`);
	h.check(!norm.plainKeys.includes('bounds') && !norm.plainKeys.includes('locomotion'), 'a scene that never used them saves neither key');

	// ---- the fixture: a floor, a wall ahead, a dynamic cube -----------------------------------
	const ids = await page.evaluate(async () => {
		const s = window.__stores;
		const get = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
		for (let i = 0; i < 3; i++) s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 600));
		const [floor, wall, cube] = get(s.objectsGroup).children.filter((c) => c.name === 'Box');
		floor.scale.set(20, 0.5, 20);
		floor.position.set(0, -0.25, 0);
		floor.userData.physics = { mode: 'static' };
		wall.scale.set(10, 4, 0.5);
		wall.position.set(0, 2, -3);
		wall.userData.physics = { mode: 'static' };
		cube.scale.setScalar(0.4);
		cube.position.set(0, 1.2, -1.5);
		cube.userData.physics = { mode: 'dynamic', mass: 1 };
		for (const b of [floor, wall, cube]) b.updateMatrixWorld(true);
		s.objectActions.deselectObject();
		s.isVRMode.set(true);
		s.scenePhysics.setScenePhysics({ play: { interaction: 'grab' } });
		return { cube: cube.uuid };
	});
	await page.waitForTimeout(600);
	await xr.install(page);
	const aimWall = async () => {
		await xr.pose(page, 'left', [-0.3, 1.6, 0]);
		await xr.pose(page, 'right', [0.3, 1.6, 0]);
	};
	const spread = async () => {
		await xr.pose(page, 'left', [-0.6, 1.6, 0]);
		await xr.pose(page, 'right', [0.6, 1.6, 0]);
		await page.waitForTimeout(300);
	};
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));

	// ---- 2 without the flag: the world stays put (the counterfactual) -------------------------
	await aimWall();
	await grip(page, 'left', true);
	await grip(page, 'right', true);
	let s = await state(page);
	h.check(s.mode === 'interact' && !s.worldGrab, `no flag: Interact's two grips start no world gesture (${s.worldGrab})`);
	await spread();
	s = await state(page);
	h.check(Math.abs(s.rigScale - 1) < 1e-6, `no flag: the world stays 1:1 (x${s.rigScale})`);
	await grip(page, 'left', false);
	await grip(page, 'right', false);

	// ---- 3 with it: scale + pan ---------------------------------------------------------------
	await setPlay(page, { locomotion: { worldGrab: true } });
	await aimWall();
	await grip(page, 'left', true);
	await grip(page, 'right', true);
	s = await state(page);
	h.check(s.worldGrab && s.grab === null, 'worldGrab: two grips on the wall start the world grab');
	await spread();
	s = await state(page);
	h.check(s.rigScale > 1.8, `worldGrab: spreading the hands scales the world (x${s.rigScale.toFixed(2)})`);
	await grip(page, 'left', false);
	await grip(page, 'right', false);
	await page.evaluate(() => window.__stores.vrControls.resetWorldRig());
	await xr.pose(page, 'right', [0.3, 1.2, 0], { pitch: -Math.PI / 2 });
	await grip(page, 'right', true);
	s = await state(page);
	h.check(s.worldPan && s.grab === null, `worldGrab: one right grip on the floor pans the world (${s.worldPan})`);
	await grip(page, 'right', false);

	// ---- 4 a grip on the grabbable (dynamic) cube still takes the cube ---------------------------
	await xr.pose(page, 'right', [0, 1.2, 0]);
	await grip(page, 'right', true);
	s = await state(page);
	h.check(s.grab === ids.cube && !s.worldPan && !s.worldGrab, `worldGrab: a grip on the cube holds the CUBE (${s.grab})`);
	await grip(page, 'right', false);

	// ---- 5 a module publisher turns it on; the SDK says it can ------------------------------
	await setPlay(page, { locomotion: {} });
	const probe = await page.evaluate(async () => {
		const s = window.__stores;
		let api;
		await s.moduleSDK.initModules([{ id: 'loco31', name: 'Loco', version: '1.0.0', description: '31 K1', register(a) { api = a; } }]);
		const g = new api.THREE.Group();
		g.name = 'loco31-root';
		g.userData.play = { locomotion: { worldGrab: true } };
		api.scene().add(g);
		const r = s.playSettings.resolvePlaySettings((() => { let sc; s.globalScene.subscribe((v) => (sc = v))(); return sc; })());
		return { flag: api.locomotion, worldGrab: r.locomotion.worldGrab };
	});
	h.check(probe.flag?.worldGrab === true && probe.flag?.boundedTeleport === true, `api.locomotion is the feature probe (${JSON.stringify(probe.flag)})`);
	h.check(probe.worldGrab === true, 'a module publisher turns worldGrab on');
	await aimWall();
	await grip(page, 'left', true);
	await grip(page, 'right', true);
	s = await state(page);
	h.check(s.worldGrab, 'publisher worldGrab: the grips move the world');
	await grip(page, 'left', false);
	await grip(page, 'right', false);

	await xr.uninstall(page);
	await h.finish(browser);
});
