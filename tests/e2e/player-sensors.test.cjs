// 78 F10 — THE PLAYER IS FELT BY SENSORS. Before 78 the walker's capsule was never a scene
// collider (charController.js creates it straight onto the world, with no colliderOwner entry),
// so On Enter / On Exit never fired for the player: only the stepping peer even HAD a world,
// and its sensor path skipped every handle it did not own. Now every peer tests ITS OWN player
// against the scene's sensors (LOCAL, per peer, with or without a world) and the edge rides the
// ordinary replicated trigger stamp.
//   1. A (the stepping peer) walks through a sensor: On Enter fires ONCE, On Exit ONCE, on both
//      peers (the Counter downstream reads 1 on each).
//   2. B (no physics world of its own: A steps the simulation) walks through: 2 and 2 on both.
//   3. The `who` option: an On Enter set to "objects" never fires for the player, one set to
//      "player" fires with every player crossing; `other` reads 'player'.
//   4. Proximity "to: player" reads true only while MY player is within its radius.
//
//   APP_URL=https://theprototype.app:5802/ node tests/e2e/player-sensors.test.cjs
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
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const ids = await A.page.evaluate(() => {
		const s = window.__stores;
		const cmd = s.commandsHandler.sceneCommand;
		cmd('/create Box 4 2.4 2');
		cmd('/create Box 0.5 0.5 0.5');
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const [zone, crate] = g.children.slice(-2);
		zone.name = 'Sensor zone';
		zone.position.set(0, 1.2, -3);
		zone.updateMatrixWorld(true);
		crate.name = 'Crate';
		crate.position.set(8, 0.25, 8);
		crate.updateMatrixWorld(true);
		s.physics.setPhysicsFor(zone.uuid, { mode: 'static', sensor: true });
		// a dynamic body far away keeps this suite independent of F11 (an all-static level)
		s.physics.setPhysicsFor(crate.uuid, { mode: 'dynamic', mass: 5 });
		s.scenePhysics.setScenePhysics({ ground: { enabled: true, height: 0 }, play: { simOnPlay: true, spawn: { position: [0, 0.1, 2], yaw: 0 } } });
		return { zone: zone.uuid, crate: crate.uuid };
	});

	/** the same graph on both pages (flowNodes.set does not broadcast) @param {any} page */
	const buildGraph = (page) =>
		page.evaluate((u) => {
			const sel = (id, x, y) => ({ id, type: 'objectselector', position: { x, y }, data: { label: 'Object', selected: u.zone } });
			const nodes = [
				{ id: 'walk', type: 'charcontroller', position: { x: 0, y: -200 }, data: { label: 'Character Controller', mode: 'walk', speed: 0.08, jumpHeight: 1.1, eyeHeight: 1.7, gravity: true } },
				{ id: 'oe', type: 'onenter', position: { x: 0, y: 0 }, data: { label: 'On Enter', pulse: 0.3 } },
				{ id: 'ox', type: 'onexit', position: { x: 0, y: 160 }, data: { label: 'On Exit', pulse: 0.3 } },
				{ id: 'oeP', type: 'onenter', position: { x: 0, y: 320 }, data: { label: 'On Enter', pulse: 0.3, who: 'player' } },
				{ id: 'oeO', type: 'onenter', position: { x: 0, y: 480 }, data: { label: 'On Enter', pulse: 0.3, who: 'objects' } },
				{ id: 'cE', type: 'counter', position: { x: 300, y: 0 }, data: { label: 'Counter', op: 'up', step: 1 } },
				{ id: 'cX', type: 'counter', position: { x: 300, y: 160 }, data: { label: 'Counter', op: 'up', step: 1 } },
				{ id: 'cP', type: 'counter', position: { x: 300, y: 320 }, data: { label: 'Counter', op: 'up', step: 1 } },
				{ id: 'cO', type: 'counter', position: { x: 300, y: 480 }, data: { label: 'Counter', op: 'up', step: 1 } },
				{ id: 'near', type: 'proximity', position: { x: 0, y: 640 }, data: { label: 'Proximity', radius: 1.5, to: 'player' } },
				sel('s1', -300, 0),
				sel('s2', -300, 160),
				sel('s3', -300, 320),
				sel('s4', -300, 480),
				sel('s5', -300, 640)
			];
			const edges = [
				{ id: 'e-oe-s1', source: 'oe', target: 's1' },
				{ id: 'e-ox-s2', source: 'ox', target: 's2' },
				{ id: 'e-oeP-s3', source: 'oeP', target: 's3' },
				{ id: 'e-oeO-s4', source: 'oeO', target: 's4' },
				{ id: 'e-s5-near.a', source: 's5', target: 'near', targetHandle: 'a' },
				{ id: 'e-oe-cE', source: 'oe', target: 'cE' },
				{ id: 'e-ox-cX', source: 'ox', target: 'cX' },
				{ id: 'e-oeP-cP', source: 'oeP', target: 'cP' },
				{ id: 'e-oeO-cO', source: 'oeO', target: 'cO' }
			];
			window.__stores.flowNodes.set(nodes);
			window.__stores.flowEdges.set(edges);
		}, ids);
	await buildGraph(A.page);
	await buildGraph(B.page);
	await A.page.waitForTimeout(1500);

	const counts = (page) =>
		page.evaluate(() => {
			let t;
			window.__stores.flowTriggers.subscribe((v) => (t = v))();
			const c = (id) => t[id]?.count ?? 0;
			return { enter: c('cE'), exit: c('cX'), player: c('cP'), objects: c('cO'), other: window.__stores.flowRuntime.contactOtherOf('oe') };
		});
	const rig = (page) =>
		page.evaluate(() => {
			const s = window.__stores;
			let cam;
			s.playerCam.subscribe((c) => (cam = c))();
			const w = cam.getWorldPosition(new s.THREE.Vector3());
			return { z: w.z };
		});
	const near = (page) => page.evaluate(() => window.__stores.flowRuntime.nodeValueOf?.('near') ?? null);
	/** walk forward until the rig is past the sensor @param {any} peer */
	const walkThrough = async (peer) => {
		await peer.page.keyboard.down('KeyW');
		await h.eventually(() => rig(peer.page), (r) => r.z < -5.5, `${peer.id}: walks past the sensor`, 20000).catch(() => {});
		await peer.page.keyboard.up('KeyW');
		await peer.page.waitForTimeout(800);
		return rig(peer.page);
	};

	// 1. A — the stepping peer
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(
		() => A.page.evaluate(() => { let v; window.__stores.physics.simulating.subscribe((x) => (v = x))(); return v; }),
		(v) => v === true,
		'premise: Play starts the simulation on A',
		15000
	);
	await A.page.waitForTimeout(1200);
	const startA = await rig(A.page);
	h.check(startA.z > 1, `premise: A spawns in front of the sensor (z ${startA.z.toFixed(2)})`);
	const endA = await walkThrough(A);
	h.check(endA.z < -4.4, `premise: A walked all the way through the sensor (z ${endA.z.toFixed(2)})`);
	await A.page.waitForTimeout(1500);
	const a1 = await counts(A.page);
	const b1 = await counts(B.page);
	h.check(a1.enter === 1 && a1.exit === 1, `A walks through: On Enter fired ONCE and On Exit ONCE on A (${a1.enter}/${a1.exit})`);
	h.check(b1.enter === 1 && b1.exit === 1, `... and the stamps reached B (${b1.enter}/${b1.exit})`);
	h.check(a1.other === 'player', `the other body of a player crossing is 'player' (${a1.other})`);
	h.check(a1.player === 1 && a1.objects === 0, `who: player fires for the player, who: objects does not (${a1.player}/${a1.objects})`);
	await h.leavePlay(A);

	// 2. B — no world of its own (A steps the simulation)
	const bWorld = await B.page.evaluate(() => !!window.__stores.physics.physicsRuntime());
	h.check(!bWorld, 'premise: B holds no physics world (A is the stepping peer)');
	await B.page.evaluate(() => window.__stores.isLocked.set(true));
	await B.page.waitForTimeout(1500);
	const nearStart = await near(B.page);
	const endB = await walkThrough(B);
	h.check(endB.z < -4.4, `premise: B walked through the sensor (z ${endB.z.toFixed(2)})`);
	await B.page.waitForTimeout(1500);
	const a2 = await counts(A.page);
	const b2 = await counts(B.page);
	h.check(b2.enter === 2 && b2.exit === 2, `B walks through with no world: On Enter 2, On Exit 2 on B (${b2.enter}/${b2.exit})`);
	h.check(a2.enter === 2 && a2.exit === 2, `... and on A (${a2.enter}/${a2.exit})`);
	h.check(a2.objects === 0 && b2.objects === 0, `who: objects still never fired (${a2.objects}/${b2.objects})`);

	// 4. Proximity to: player — MY player only
	h.check(nearStart === false, `Proximity (to: player, r 1.5) is false while B stands 4 m away (${nearStart})`);
	await B.page.evaluate(() => {
		const s = window.__stores;
		let cam;
		s.playerCam.subscribe((c) => (cam = c))();
		// the play camera IS the rig PointerLockControls moves (Player.svelte: its parent is the
		// 0.9 m base group, which stays put); put it where the sensor stands
		cam.position.x = 0;
		cam.position.z = -3;
		cam.updateMatrixWorld(true);
	});
	await B.page.waitForTimeout(600);
	const nearIn = await near(B.page);
	const nearOnA = await near(A.page);
	h.check(nearIn === true, `Proximity reads true once B's player stands at the sensor (${nearIn})`);
	h.check(nearOnA === false, `... and false on A, whose player is not there (per peer, local) (${nearOnA})`);
	await h.leavePlay(B);
	await h.finish(browser);
});
