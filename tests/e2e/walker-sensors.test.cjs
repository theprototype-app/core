// 33-scenes — a SENSOR is pass-through for the walker too. The character controller's sweep
// (charController.js, rapier's KinematicCharacterController) ran with no query filter, so every
// sensor — the grass, flowers, rugs and water the 30c levels mark pass-through, a trim, a
// trigger volume — was a wall in Play (found: the Tavern's open front door held the walker at
// its threshold, where a pass-through wainscot trim stands). Now it sweeps EXCLUDE_SENSORS.
//   1. the walker walks THROUGH a sensor wall;
//   2. and is still STOPPED by a solid one (the filter excludes sensors, nothing else).
//
//   APP_URL=https://theprototype.app:5282/ node tests/e2e/walker-sensors.test.cjs
const h = require('./helpers.cjs');

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
	await page.evaluate(() => {
		const s = window.__stores;
		const T = s.THREE;
		s.commandsHandler.sceneCommand('/clear all');
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const wall = (name, z, sensor) => {
			const m = new T.Mesh(new T.BoxGeometry(6, 2.4, 0.3), new T.MeshStandardMaterial({ color: sensor ? 0x44aa66 : 0xaa4444 }));
			m.name = name;
			m.position.set(0, 1.2, z);
			m.userData.physics = sensor ? { mode: 'static', sensor: true } : { mode: 'static' };
			g.add(m);
		};
		wall('Sensor wall', -3, true);
		wall('Solid wall', -7, false);
		// a dynamic body far away: a scene with none starts no simulation on Play
		const crate = new T.Mesh(new T.BoxGeometry(0.5, 0.5, 0.5), new T.MeshStandardMaterial());
		crate.name = 'Crate';
		crate.position.set(8, 0.25, 8);
		crate.userData.physics = { mode: 'dynamic', mass: 5 };
		g.add(crate);
		s.objectsGroup.update((v) => v);
		s.scenePhysics.setScenePhysics({ ground: { enabled: true, height: 0 }, play: { simOnPlay: true, spawn: { position: [0, 0.1, 1], yaw: 0 } } });
		const walk = { id: 'walk', type: 'charcontroller', position: { x: 40, y: 40 }, data: { label: 'Character Controller', mode: 'walk', speed: 0.08, jumpHeight: 1.1, eyeHeight: 1.7, gravity: true } };
		s.flowNodes.set([walk]);
		s.flowEdges.set([]);
	});
	await page.waitForTimeout(1500);
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(
		() => page.evaluate(() => { let v; window.__stores.physics.simulating.subscribe((x) => (v = x))(); return v; }),
		(v) => v === true,
		'premise: Play starts the simulation',
		15000
	);
	await page.waitForTimeout(1200);
	const rig = () =>
		page.evaluate(() => {
			const s = window.__stores;
			let cam;
			s.playerCam.subscribe((c) => (cam = c))();
			const w = cam.getWorldPosition(new s.THREE.Vector3());
			let state;
			s.charController.walkerState.subscribe((v) => (state = v))();
			return { z: w.z, source: state?.source };
		});
	const start = await rig();
	h.check(start.source === 'rapier', `premise: the walker sweeps through the physics world (${start.source})`);
	await page.keyboard.down('KeyW');
	await page.waitForTimeout(3500);
	await page.keyboard.up('KeyW');
	await page.waitForTimeout(300);
	const end = await rig();
	h.check(end.z < -3.6, `the walker walks THROUGH the sensor wall at z -3 (z ${start.z.toFixed(2)} -> ${end.z.toFixed(2)})`);
	h.check(end.z > -6.9, `and is STOPPED by the solid wall at z -7 (z ${end.z.toFixed(2)})`);
	await h.finish(browser);
});
