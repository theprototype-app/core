// Phase 24: physics preview — mass-wired cube falls identically on both peers,
// one-step undo restores, busy-guard blocks a second simulation, scenery stays put.
const h = require('./helpers.cjs');

const objState = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					resolve(o ? { y: o.position.y, x: o.position.x, z: o.position.z } : null);
				})();
			}),
		uuid
	);

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
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// falling cube at y=6 wired to a Mass node; static cube stays at the origin area
	const { cubeUuid, sceneryUuid } = await A.page.evaluate(async () => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create box');
		cmd('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const [cube, scenery] = group.children;
		cube.position.set(0, 6, 0);
		scenery.position.set(3, 0.5, 0);
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		peer.send({ type: 'move', uuid: cube.uuid, pos: [0, 6, 0], rot: [0, 0, 0], scale: [1, 1, 1] });
		peer.send({ type: 'move', uuid: scenery.uuid, pos: [3, 0.5, 0], rot: [0, 0, 0], scale: [1, 1, 1] });
		const nodes = [
			{ id: 'm1', type: 'mass', position: { x: 0, y: 0 }, data: { type: 'mass', kg: 2 }, class: 'w-[150px]' },
			{
				id: 'sel1',
				type: 'objectselector',
				position: { x: 300, y: 0 },
				data: { type: 'objectselector', selected: cube.uuid },
				class: 'w-[150px]'
			}
		];
		const edge = { id: 'e1', source: 'm1', target: 'sel1' };
		window.__stores.flowNodes.set(nodes);
		window.__stores.flowEdges.set([edge]);
		nodes.forEach((node) => peer.send({ type: 'nodecreate', node }));
		peer.send({ type: 'edgecreate', edge });
		return { cubeUuid: cube.uuid, sceneryUuid: scenery.uuid };
	});
	await A.page.waitForTimeout(2500);

	// simulate on A
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)())),
		(v) => v === true,
		'simulation started on A'
	);

	// busy-guard on B
	await h.eventually(
		() => B.page.evaluate(() => new Promise((r) => window.__stores.physics.remoteSimulating.subscribe(r)())),
		(v) => v === A.id,
		'B knows A is simulating'
	);
	await B.page.evaluate(() => window.__stores.physics.toggleSimulation());
	const bSimulating = await B.page.evaluate(
		() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)())
	);
	h.check(bSimulating === false, 'second simulation refused while A runs');

	// cube settles near the ground on both peers
	await h.eventually(() => objState(A.page, cubeUuid), (s) => s && s.y < 1.2, 'cube fell on A', 15000);
	await h.eventually(() => objState(B.page, cubeUuid), (s) => s && s.y < 1.2, 'fall replicated to B', 15000);

	// stop -> final state + one-step undo restores y=6 everywhere
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await A.page.waitForTimeout(800);
	const scenery = await objState(A.page, sceneryUuid);
	h.check(Math.abs(scenery.x - 3) < 0.01 && Math.abs(scenery.y - 0.5) < 0.01, 'unwired scenery never moved');

	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => objState(A.page, cubeUuid), (s) => s && Math.abs(s.y - 6) < 0.01, 'undo restores the layout on A');
	await h.eventually(() => objState(B.page, cubeUuid), (s) => s && Math.abs(s.y - 6) < 0.01, 'restore replicated to B');

	await h.finish(browser);
});
