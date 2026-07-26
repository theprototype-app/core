// PFX-C: ground-impact events. A dynamic box falls under rapier; on contact the
// initiator fires (a) the object's "On impact" emitter as a replicated
// particleburst and (b) any On Impact node targeting the object (replicated
// nodetrigger) — filtered by pre-step downward velocity + per-body cooldown.
// Single-page: detection is initiator-side; replication paths are covered by a
// send spy + the shared appliers.
const h = require('./helpers.cjs');

const entriesOn = (page) => page.evaluate(() => window.__stores.particleRuntime.particleEntries());

h.run(async () => {
	const browser = await h.launch();

	// throwaway page warms the vite dep-optimizer for the lazy rapier import
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}

	const A = await h.setupPage(browser, 'A');

	// a dynamic box at y=5 with an "On impact" dust emitter + an On Impact node
	// (implicit owner, wired nowhere) in its own graph
	const uuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		window.__box = box;
		box.position.set(0, 5, 0);
		box.updateMatrixWorld(true);
		box.userData.physics = { mode: 'dynamic', mass: 2 };
		window.__stores.particleActions.addParticlesPreset(box.uuid, 'dust');
		window.__stores.particleActions.updateObjectParticles(box.uuid, { mode: 'impact' });
		window.__stores.flowGraphs.update((graphs) => ({
			...graphs,
			[box.uuid]: {
				nodes: [{ id: 'imp1', type: 'onimpact', position: { x: 20, y: 20 }, data: { type: 'onimpact', label: 'On Impact', pulse: 0.3, minStrength: 1 } }],
				edges: []
			}
		}));
		return box.uuid;
	});
	await A.page.waitForTimeout(400);

	// mode 'impact' is a triggered mode: the entry auto-fired once on attach —
	// clear the stamp so the FALL is what we measure
	await A.page.evaluate(() => {
		// spy every outgoing message; sim messages flow through the same send
		window.__sent = [];
		let peer;
		window.__stores.peers.subscribe((p) => (peer = p))();
		window.__peer = peer;
		peer.send = (m) => window.__sent.push(m.type);
	});

	const preSim = (await entriesOn(A.page)).find((x) => x.uuid === uuid);
	h.check(preSim?.space === 'world', `impact emitter live before the sim (${JSON.stringify(preSim?.space)})`);

	// start the sim and let the box fall ~1s (real-time accumulator)
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)())),
		(v) => v === true,
		'simulation started'
	);
	const burstBefore = (await entriesOn(A.page)).find((x) => x.uuid === uuid)?.burstT ?? -1;

	// the box lands -> burst re-stamps + particleburst broadcast + node trigger
	await h.eventually(
		() => A.page.evaluate(() => window.__box.position.y),
		(y) => y < 1.4,
		'box fell to the ground',
		15000
	);
	await h.eventually(
		() => entriesOn(A.page),
		(e) => (e.find((x) => x.uuid === uuid)?.burstT ?? -1) > burstBefore,
		'landing fires the on-impact emitter burst'
	);
	await h.eventually(
		() => A.page.evaluate(() => window.__sent.filter((t) => t === 'particleburst').length),
		(n) => n >= 1,
		'particleburst replicated to peers'
	);
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.flowTriggers.subscribe((t) => r(t.imp1 ?? null))())),
		(t) => !!t && t.lastT > 0,
		'On Impact node pulsed (replicated nodetrigger stamp)'
	);
	// cooldown: bounces within 300ms can't machine-gun (dust preset re-fires are
	// config-driven, not per-contact — assert a sane burst count, not dozens)
	const burstCount = await A.page.evaluate(() => window.__sent.filter((t) => t === 'particleburst').length);
	h.check(burstCount <= 5, `per-body cooldown holds (${burstCount} bursts)`);

	// stop + restore the spy
	await A.page.evaluate(() => {
		window.__stores.physics.toggleSimulation();
		delete window.__peer.send;
	});
	await A.page.waitForTimeout(500);
	const simOff = await A.page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)()));
	h.check(simOff === false, 'simulation stopped cleanly (EventQueue freed)');

	await h.finish(browser);
});
