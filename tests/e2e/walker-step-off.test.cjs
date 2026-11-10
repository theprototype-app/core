// 78-int u2 — a walker that steps OFF a platform lands ON the ground plane: no pop.
// 5198fea5 stands a grounded walker on the enabled ground plane when the character controller's
// capsule has settled up to 5 cm into it. This suite pins the cases that rule must not change:
//   1. standing on a static platform (top 0.4 m) the feet stay on the PLATFORM (the rule only acts
//      under the plane's top, never above it);
//   2. walking off its edge, the feet fall and land on the plane with no pop on landing (a rise past 3 cm
//      between two frames; the controller's own 2 cm skin settle is allowed) and rest within -1 .. +5 cm;
//   3. walk mode with NO controller node (1.64: the F11 default walker is off, flowRuntime DEFAULT_WALKER_ON):
//      no walker, and the eye-height pin keeps the eye at 1.7 m over the plane while walking. With the fix-batch
//      card the default walker returns and this row asserts its feet ON the plane (0, not 1-3 cm under it).
//   4. the floor raised to 0.3 m BEFORE a Character Controller appears: it starts on the raised floor and a
//      2 s walk stays on it, grounded every frame (no plunge into the slab).
//   APP_URL=https://theprototype.app:5802/ node tests/e2e/walker-step-off.test.cjs
const h = require('./helpers.cjs');

/** @param {any} page @param {boolean} controller */
const buildLevel = (page, controller) =>
	page.evaluate((withNode) => {
		const s = window.__stores;
		const T = s.THREE;
		s.commandsHandler.sceneCommand('/clear all');
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const m = new T.Mesh(new T.BoxGeometry(3, 0.4, 3), new T.MeshStandardMaterial({ color: 0x888888 }));
		m.name = 'Platform';
		m.position.set(0, 0.2, -2.5); // top 0.4 m, spans z -4 .. -1
		m.userData.physics = { mode: 'static' };
		g.add(m);
		s.objectsGroup.update((v) => v);
		s.scenePhysics.setScenePhysics({
			ground: { enabled: true, height: 0 },
			play: { simOnPlay: true, grounded: !withNode, spawn: { position: [0, 0.45, -2.2], yaw: 0 } }
		});
		const walk = { id: 'walk', type: 'charcontroller', position: { x: 40, y: 40 }, data: { label: 'Character Controller', mode: 'walk', speed: 0.06, jumpHeight: 1.1, eyeHeight: 1.7, gravity: true } };
		s.flowNodes.set(withNode ? [walk] : []);
		s.flowEdges.set([]);
	}, controller);

/** @param {any} page */
const walker = (page) =>
	page.evaluate(() => {
		let st;
		window.__stores.charController.walkerState.subscribe((v) => (st = v))();
		return st;
	});
/** @param {any} page */
const simulating = (page) => page.evaluate(() => { let v; window.__stores.physics.simulating.subscribe((x) => (v = x))(); return v; });

h.run(async () => {
	const browser = await h.launch();
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(3000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// ---- 1. on the platform ------------------------------------------------------------------
	await buildLevel(page, true);
	await page.waitForTimeout(1200);
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => simulating(page), (v) => v === true, 'premise: Play starts the physics world', 12000);
	await h.eventually(
		() => walker(page),
		(s) => s && s.source === 'rapier' && s.grounded && Math.abs(s.ground - 0.4) < 0.03,
		'1.1 the walker stands on the 0.4 m platform (rapier tier, grounded)',
		10000
	);
	console.log('on the platform', JSON.stringify(await walker(page)));

	// ---- 2. walk off the far edge (z -4), sampling the feet every frame -----------------------
	await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__feet = [];
		w.__feetOn = true;
		const tick = () => {
			if (!w.__feetOn) return;
			let st;
			w.__stores.charController.walkerState.subscribe((v) => (st = v))();
			w.__feet.push({ y: st.ground, g: st.grounded, src: st.source });
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	await page.keyboard.down('KeyW');
	await h.eventually(() => walker(page), (s) => s && s.ground < 0.02 && s.grounded, 'premise: the walker walked off the edge and landed', 15000);
	await page.waitForTimeout(1200); // keep walking on the plane for a while after the landing
	await page.keyboard.up('KeyW');
	await page.waitForTimeout(600);
	const log = await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__feetOn = false;
		return w.__feet;
	});
	const ys = log.map((/** @type {any} */ s) => s.y);
	const left = ys.findIndex((y) => y < 0.35); // first frame below the platform top
	const land = ys.findIndex((y, i) => i > left && left >= 0 && y < 0.02);
	h.check(left > 0 && land > left, `premise: the log has the fall (${ys.length} frames, left at ${left}, landed at ${land})`);
	// during the fall and after the landing the feet never RISE by more than 1 cm between frames
	let rise = 0;
	for (let i = Math.max(1, left); i < ys.length; i++) rise = Math.max(rise, ys[i] - ys[i - 1]);
	// the character controller keeps a 2 cm skin under the capsule, so a landing settles up by about that much: a
	// rise past 3 cm in one frame is a pop (the 5 cm one 5198fea5 would have made), a skin's settle is not
	h.check(rise <= 0.03, `2.1 no pop: the feet never rise more than 3 cm in a frame after leaving the platform (max rise ${(rise * 100).toFixed(1)} cm)`);
	const after = ys.slice(land);
	const lo = Math.min(...after);
	const hi = Math.max(...after);
	h.check(lo >= -0.01 && hi <= 0.05, `2.2 after the landing the feet stay on the plane, within the controller's skin (${(lo * 100).toFixed(1)} .. ${(hi * 100).toFixed(1)} cm, -1 .. +5)`);
	await h.leavePlay(A);
	await page.evaluate(() => window.__stores.physics.stopSimulation?.());
	await page.waitForTimeout(800);

	// ---- 3. the default walker on the plane ---------------------------------------------------
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await page.evaluate(() => {
		const s = window.__stores;
		s.scenePhysics.setScenePhysics({ ground: { enabled: true, height: 0 }, play: { simOnPlay: true, grounded: true, spawn: { position: [0, 0.05, 1], yaw: 0 } } });
		s.flowNodes.set([]);
		s.flowEdges.set([]);
	});
	await page.waitForTimeout(800);
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await page.waitForTimeout(1500);
	await page.keyboard.down('KeyW');
	const samples = [];
	for (let i = 0; i < 8; i++) {
		await page.waitForTimeout(250);
		samples.push(
			await page.evaluate(() => {
				const s = window.__stores;
				let cam, ctrl;
				s.playerCam.subscribe((c) => (cam = c))();
				s.charController.charControl.subscribe((v) => (ctrl = v))();
				return { eye: cam.getWorldPosition(new s.THREE.Vector3()).y, mode: ctrl?.mode ?? null };
			})
		);
	}
	await page.keyboard.up('KeyW');
	h.check(
		samples.every((s) => s.mode === null && Math.abs(s.eye - 1.7) <= 0.01),
		`3.1 1.64: no default walker, the pin keeps the eye 1.7 m over the plane while walking (eye m: ${samples.map((s) => s.eye.toFixed(3)).join(' ')}; walker ${samples[0]?.mode})`
	);
	await h.leavePlay(A);
	await page.evaluate(() => window.__stores.physics.stopSimulation?.());
	await page.waitForTimeout(800);

	// ---- 4. the floor is raised BEFORE a controller appears, then a full walk -----------------
	// (a8ab5616: a walker that STARTS under the plane's top starts on it — on its first frame only; the per-frame
	// clamp 5198fea5 tried plunged the capsule. Over the whole walk: on the raised floor, grounded, no plunge)
	await page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/clear all');
		s.scenePhysics.setScenePhysics({ ground: { enabled: true, height: 0 }, play: { simOnPlay: true, grounded: true, spawn: { position: [0, 0.05, 1], yaw: 0 } } });
		s.flowNodes.set([]);
		s.flowEdges.set([]);
	});
	await page.waitForTimeout(800);
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await page.waitForTimeout(1200);
	await page.evaluate(() => {
		const s = window.__stores;
		s.scenePhysics.setScenePhysics({ ground: { enabled: true, height: 0.3 }, play: { grounded: false } });
		s.setActiveGraph(s.SCENE_GRAPH);
		s.flowNodes.set([{ id: 'cc', type: 'charcontroller', position: { x: 0, y: 0 }, data: { type: 'charcontroller', mode: 'walk', speed: 0.05, jumpHeight: 1, eyeHeight: 1.7, gravity: true } }]);
		s.flowEdges.set([]);
	});
	await h.eventually(() => walker(page), (st) => st && st.source === 'rapier' && st.grounded && Math.abs(st.ground - 0.3) < 0.05, '4.1 the late controller stands on the raised 0.3 m floor', 10000);
	await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__feet = [];
		w.__feetOn = true;
		const tick = () => {
			if (!w.__feetOn) return;
			let st;
			w.__stores.charController.walkerState.subscribe((v) => (st = v))();
			w.__feet.push({ y: st.ground, g: st.grounded });
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	await page.keyboard.down('KeyW');
	await page.waitForTimeout(2000);
	await page.keyboard.up('KeyW');
	await page.waitForTimeout(400);
	const walk4 = await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__feetOn = false;
		return w.__feet;
	});
	const y4 = walk4.map((/** @type {any} */ f) => f.y);
	const air = walk4.filter((/** @type {any} */ f) => !f.g).length;
	h.check(
		walk4.length > 10 && Math.min(...y4) >= 0.29 && Math.max(...y4) <= 0.35 && air === 0,
		`4.2 a full walk on the raised floor: no plunge, never airborne (${walk4.length} frames, feet ${(Math.min(...y4) * 100).toFixed(1)} .. ${(Math.max(...y4) * 100).toFixed(1)} cm, ${air} airborne)`
	);
	await h.leavePlay(A);
	await h.finish(browser);
});
