// 78 F12 — TOUCH-COLLECT IN A NODE-ONLY SCENE. Walking over a gem collected it only when code
// registered the gem (kit.pickups.register in a behaviour's on.load); a scene built from nodes
// alone had a Collect pickup node per gem and nothing ever asked the kit for a touch, so walking
// over the gems did nothing (owner gem test 2026-10-28). Now the Collect pickup node has
// "Collect on touch" (default ON): it registers its gem for touch on every peer.
//   1. Three gems, each with ONE node in its own graph (Collect pickup, nothing wired): A walks
//      over gem 1 (walk controller, keyboard) — taken by A, the shared score 1, on both peers.
//   2. B (fly Play, no controller) stands on gem 2 — taken by B, score 2.
//   3. "Collect on touch" OFF on gem 3: standing on it takes nothing (the counterfactual).
//   4. The code path still works: a gem registered by kit.pickups.register (no node) is taken.
//
//   APP_URL=https://theprototype.app:5802/ node tests/e2e/touch-collect-nodes.test.cjs
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const ids = await A.page.evaluate(() => {
		const s = window.__stores;
		const cmd = s.commandsHandler.sceneCommand;
		for (let i = 0; i < 4; i++) cmd('/create Box 0.4 0.4 0.4');
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const gems = g.children.slice(-4);
		const spots = [
			[0, 0.3, -3],
			[4, 0.3, 0],
			[-4, 0.3, 0],
			[0, 0.3, 4]
		];
		gems.forEach((gem, i) => {
			gem.name = 'Gem ' + (i + 1);
			gem.position.set(...spots[i]);
			gem.updateMatrixWorld(true);
		});
		s.scenePhysics.setScenePhysics({ ground: { enabled: true, height: 0 }, play: { spawn: { position: [0, 0.1, 1], yaw: 0 } } });
		return gems.map((o) => o.uuid);
	});
	await A.page.waitForTimeout(1500);

	// each gem's OWN graph holds one Collect pickup node, nothing wired (the node-only scene):
	// created through the replicated object-flow path so B holds the same graphs
	await A.page.evaluate((uuids) => {
		const s = window.__stores;
		uuids.slice(0, 3).forEach((uuid, i) => {
			s.flowGraphs.update((m) => ({
				...m,
				[uuid]: {
					nodes: [
						{ id: 'collect-' + i, type: 'kit-pickups-collect', position: { x: 0, y: 0 }, data: { label: 'Collect pickup', score: 1, respawn: 0, ...(i === 2 ? { touch: false } : {}) } }
					],
					edges: []
				}
			}));
		});
	}, ids);
	await B.page.evaluate((uuids) => {
		const s = window.__stores;
		uuids.slice(0, 3).forEach((uuid, i) => {
			s.flowGraphs.update((m) => ({
				...m,
				[uuid]: {
					nodes: [
						{ id: 'collect-' + i, type: 'kit-pickups-collect', position: { x: 0, y: 0 }, data: { label: 'Collect pickup', score: 1, respawn: 0, ...(i === 2 ? { touch: false } : {}) } }
					],
					edges: []
				}
			}));
		});
	}, ids);
	// gem 4: the code path (a behaviour's on.load does exactly this)
	for (const peer of [A, B])
		await peer.page.evaluate((uuid) => window.__stores.kit.kit.impls.pickups.extra.register({ id: uuid, score: 1 }), ids[3]);
	// A walks with a controller; B flies (no controller on B's page)
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowNodes.set([{ id: 'walk', type: 'charcontroller', position: { x: 0, y: 0 }, data: { label: 'Character Controller', mode: 'walk', speed: 0.08, jumpHeight: 1.1, eyeHeight: 1.7, gravity: true } }]);
	});
	await A.page.waitForTimeout(1500);

	const doc = (page) =>
		page.evaluate(() => {
			const d = window.__stores.kit.kitDebug().doc;
			const taken = d?.slices?.pickups?.taken ?? {};
			const score = d?.slices?.score ?? {};
			return { taken: Object.fromEntries(Object.entries(taken).map(([k, v]) => [k, v.by])), total: score.total ?? null, me: window.__stores.kit.kitDebug().me };
		});
	const stand = (page, x, z) =>
		page.evaluate(
			([px, pz]) => {
				const s = window.__stores;
				let cam;
				s.playerCam.subscribe((c) => (cam = c))();
				cam.position.x = px;
				cam.position.z = pz;
				cam.updateMatrixWorld(true);
			},
			[x, z]
		);

	// 1. A walks over gem 1
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	await A.page.waitForTimeout(1500);
	await A.page.keyboard.down('KeyW');
	await h.eventually(() => doc(A.page), (d) => !!d.taken[ids[0]], 'A: walking over gem 1 takes it', 15000).catch(() => {});
	await A.page.keyboard.up('KeyW');
	await A.page.waitForTimeout(1500);
	const a1 = await doc(A.page);
	const b1 = await doc(B.page);
	h.check(!!a1.taken[ids[0]] && a1.taken[ids[0]] === a1.me, `A walks over gem 1: taken by A (${a1.taken[ids[0]] ?? 'not taken'})`);
	h.check(!!b1.taken[ids[0]], `... and B sees it taken (${b1.taken[ids[0]] ?? 'not taken'})`);
	await h.leavePlay(A);

	// 2. B (fly) stands on gem 2
	await B.page.evaluate(() => window.__stores.isLocked.set(true));
	await B.page.waitForTimeout(1200);
	await stand(B.page, 4, 0);
	await B.page.waitForTimeout(400);
	console.log('B after the teleport: ' + JSON.stringify(await B.page.evaluate(() => (() => {
			const s = window.__stores;
			let cam, gc, ctl;
			s.playerCam.subscribe((c) => (cam = c))();
			s.globalCamera?.subscribe?.((c) => (gc = c))();
			s.charController.charControl.subscribe((v) => (ctl = v))();
			const T = s.THREE;
			const w = (o) => (o ? o.getWorldPosition(new T.Vector3()).toArray().map((v) => +v.toFixed(2)) : null);
			let locked;
			s.isLocked.subscribe((v) => (locked = v))();
			return { cam: w(cam), parent: w(cam?.parent), global: w(gc), same: cam === gc, locked, ctl: ctl?.mode ?? null, body: JSON.parse(JSON.stringify(s.charController.localPlayerBody?.() ?? null)) };
		})())));
	await h.eventually(() => doc(B.page), (d) => !!d.taken[ids[1]], 'B: standing on gem 2 takes it', 10000).catch(() => {});
	await B.page.waitForTimeout(1500);
	const a2 = await doc(A.page);
	const b2 = await doc(B.page);
	h.check(!!b2.taken[ids[1]] && b2.taken[ids[1]] === b2.me, `B (fly Play) stands on gem 2: taken by B (${b2.taken[ids[1]] ?? 'not taken'})`);
	h.check(!!a2.taken[ids[1]], `... and A sees it taken`);

	// 3. Collect on touch OFF
	await stand(B.page, -4, 0);
	await B.page.waitForTimeout(2500);
	const b3 = await doc(B.page);
	h.check(!b3.taken[ids[2]], `COUNTERFACTUAL: gem 3 with "Collect on touch" off is not taken by standing on it (${b3.taken[ids[2]] ?? 'not taken'})`);

	// 4. the code path keeps working
	await stand(B.page, 0, 4);
	await h.eventually(() => doc(B.page), (d) => !!d.taken[ids[3]], 'B: the code-registered gem is taken', 10000).catch(() => {});
	const b4 = await doc(B.page);
	h.check(!!b4.taken[ids[3]], `a gem registered in code (kit.pickups.register) is still taken on touch`);
	await h.leavePlay(B);
	await h.finish(browser);
});
