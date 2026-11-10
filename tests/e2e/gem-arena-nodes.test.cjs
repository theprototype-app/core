// 78 — THE GEM ARENA, BUILT FROM NODES ONLY (the scene the agent testers failed on, 2026-10-28).
// Static walls, three gems, a gate that opens at 3 and a HUD score — no code, no behaviour, no
// On Enter wiring:
//   · each gem's own graph holds ONE Collect pickup node (F12 "Collect on touch", default on)
//   · the scene graph: Score -> HUD text "Gems: {v}/3"; Score >= 3 -> Not -> Visibility (the gate)
//   · Play on A starts the physics world for the all-static arena (F11) and A walks (1.64: the eye-height pin;
//     the F11 default walker is off until its fix-batch card)
// Two peers: A walks over gem 1, B (fly Play) stands on gems 2 and 3. Both HUDs read "Gems: 3/3"
// and the gate is gone on both.
//
//   APP_URL=https://theprototype.app:5802/ node tests/e2e/gem-arena-nodes.test.cjs
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
	await h.connect(B, A);

	const ids = await A.page.evaluate(() => {
		const s = window.__stores;
		const cmd = s.commandsHandler.sceneCommand;
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const make = (/** @type {string} */ c, /** @type {string} */ name, /** @type {number[]} */ at, /** @type {any} */ physics) => {
			cmd(c);
			const o = g.children[g.children.length - 1];
			o.name = name;
			o.position.set(at[0], at[1], at[2]);
			if (physics) o.userData.physics = physics;
			else delete o.userData.physics;
			o.updateMatrixWorld(true);
			return o.uuid;
		};
		const wall = { mode: 'static' };
		const walls = [
			make('/create Box 12 1.5 0.3', 'Wall N', [0, 0.75, -6], wall),
			make('/create Box 12 1.5 0.3', 'Wall S', [0, 0.75, 6], wall),
			make('/create Box 0.3 1.5 12', 'Wall W', [-6, 0.75, 0], wall),
			make('/create Box 0.3 1.5 12', 'Wall E', [6, 0.75, 0], wall)
		];
		const gate = make('/create Box 2 2 0.3', 'Gate', [0, 1, -5.5], wall);
		const gems = [
			make('/create Box 0.4 0.4 0.4', 'Gem 1', [0, 0.3, -3]),
			make('/create Box 0.4 0.4 0.4', 'Gem 2', [4, 0.3, 0]),
			make('/create Box 0.4 0.4 0.4', 'Gem 3', [-4, 0.3, 0])
		];
		s.scenePhysics.setScenePhysics({ ground: { enabled: true, height: 0 }, play: { grounded: true, spawn: { position: [0, 0.1, 1], yaw: 0 } } });
		s.objectsGroup.update((v) => v);
		{ let peer; s.peers.subscribe((v) => (peer = v))(); for (const o of [...walls, gate, ...gems].map((u) => g.getObjectByProperty('uuid', u))) peer?.send({ type: 'move', uuid: o.uuid, pos: o.position.toArray(), rot: [o.rotation.x, o.rotation.y, o.rotation.z], scale: o.scale.toArray() }); } // the poses set above reach B (a direct set sends nothing)
		return { walls, gate, gems };
	});
	await A.page.waitForTimeout(1500);

	// the graphs + the HUD, applied identically on both pages (same ids)
	const build = (page) =>
		page.evaluate(({ gate, gems }) => {
			const s = window.__stores;
			s.hudDocs.setHudDocFor('scene', {
				screens: [{ id: 'main', name: 'Main', elements: [{ id: 'score', kind: 'text', label: '', anchor: 'top-right', x: 20, y: 20, w: 180, h: 26 }] }],
				active: 'main'
			});
			const N = (id, type, data, x = 0, y = 0) => ({ id, type, position: { x, y }, data: { label: id, ...data } });
			s.flowGraphs.update((m) => {
				const next = { ...m };
				gems.forEach((uuid, i) => {
					next[uuid] = { nodes: [N('collect-' + i, 'kit-pickups-collect', { label: 'Collect pickup', score: 1, respawn: 0 })], edges: [] };
				});
				next.scene = {
					nodes: [
						N('score', 'kit-score-total', { label: 'Score' }, 0, 0),
						N('txt', 'hudtext', { element: 'score', format: 'Gems: {v}/3', decimals: 0 }, 260, 0),
						N('enough', 'compare', { op: 'gte', a: 0, b: 3 }, 260, 120),
						N('shut', 'gate', { op: 'not', a: false, b: false }, 460, 120),
						N('gateVis', 'visibility', { on: true, target: gate }, 660, 120)
					],
					edges: [
						{ id: 'e-txt', source: 'score', target: 'txt', targetHandle: 'value' },
						{ id: 'e-cmp', source: 'score', target: 'enough', targetHandle: 'a' },
						{ id: 'e-not', source: 'enough', target: 'shut', targetHandle: 'a' },
						{ id: 'e-vis', source: 'shut', target: 'gateVis', targetHandle: 'on' }
					]
				};
				return next;
			});
		}, ids);
	await build(A.page);
	await build(B.page);
	await A.page.waitForTimeout(1500);

	const state = (page) =>
		page.evaluate((gate) => {
			const s = window.__stores;
			const d = s.kit.kitDebug().doc;
			/** @type {any} */ let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const taken = d?.slices?.pickups?.taken ?? {};
			return {
				taken: Object.fromEntries(Object.entries(taken).map(([k, v]) => [k, v.by])),
				total: d?.slices?.score?.total ?? 0,
				hud: document.querySelector('[data-hud-id="score"] .hud-el')?.textContent?.trim() ?? null,
				gateVisible: g.getObjectByProperty('uuid', gate)?.visible ?? null,
				me: s.kit.kitDebug().me
			};
		}, ids.gate);
	const stand = (page, x, z) =>
		page.evaluate(
			([px, pz]) => {
				let cam;
				window.__stores.playerCam.subscribe((c) => (cam = c))();
				cam.position.x = px;
				cam.position.z = pz;
				cam.updateMatrixWorld(true);
			},
			[x, z]
		);

	const s0 = await state(A.page);
	h.check(s0.total === 0 && s0.gateVisible === true, `premise: score 0, the gate stands (${JSON.stringify(s0)})`);
	h.check(s0.hud === 'Gems: 0/3', `premise: the HUD reads "Gems: 0/3" (${JSON.stringify(s0.hud)})`);

	// A: Play starts the arena's world (all static) and A walks over gem 1
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => A.page.evaluate(() => window.__stores.physics.isInitiator()), (on) => on === true, 'Play on A runs the all-static arena\'s world (F11)', 10000);
	await A.page.keyboard.down('KeyW');
	await h.eventually(() => state(A.page), (s) => !!s.taken[ids.gems[0]], 'A walks over gem 1 and takes it', 15000).catch(() => {});
	await A.page.keyboard.up('KeyW');
	const a1 = await state(A.page);
	h.check(a1.taken[ids.gems[0]] === a1.me, `gem 1 taken by A (${a1.taken[ids.gems[0]] ?? 'not taken'})`);
	await h.eventually(() => state(B.page), (s) => s.hud === 'Gems: 1/3', 'B\'s HUD reads "Gems: 1/3"', 8000);

	// B (fly Play) stands on gems 2 and 3
	await B.page.evaluate(() => window.__stores.isLocked.set(true));
	await B.page.waitForTimeout(1200);
	await stand(B.page, 4, 0);
	await h.eventually(() => state(B.page), (s) => !!s.taken[ids.gems[1]], 'B stands on gem 2 and takes it', 10000);
	h.check((await state(B.page)).gateVisible === true, 'the gate still stands at 2');
	await stand(B.page, -4, 0);
	await h.eventually(() => state(B.page), (s) => !!s.taken[ids.gems[2]], 'B stands on gem 3 and takes it', 10000);

	for (const [name, page] of [['A', A.page], ['B', B.page]]) {
		await h.eventually(() => state(page), (s) => s.total === 3 && s.hud === 'Gems: 3/3' && s.gateVisible === false, `${name}: score 3, the HUD reads "Gems: 3/3", the gate is gone`, 10000);
	}
	const fa = await state(A.page);
	const fb = await state(B.page);
	console.log('  A', JSON.stringify(fa), '\n  B', JSON.stringify(fb));
	h.check(fa.taken[ids.gems[1]] === fb.me && fa.taken[ids.gems[2]] === fb.me, 'A agrees B took gems 2 and 3');

	await h.leavePlay(B);
	await h.leavePlay(A);
	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, 'no page error');
	await h.finish(browser);
});
