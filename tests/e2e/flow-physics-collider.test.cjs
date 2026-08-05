// CL-C: physics nodes — collider (shape override + object-source hull + live
// mid-sim rebuild + sensor), onenter/onexit pulses via a node-driven sensor,
// velocity node speed feed.
const h = require('./helpers.cjs');

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

	// scene: a gentle ramp + a ball whose INSPECTOR collider is sphere, with a
	// collider NODE forcing box — the node must win (the ball holds still)
	await A.page.evaluate(() => {
		const s = window.__stores;
		const cmd = s.commandsHandler.sceneCommand;
		cmd('/create Box 8 0.4 4');
		cmd('/create Sphere 0.5');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const ramp = g.children[g.children.length - 2];
		const ball = g.children[g.children.length - 1];
		ramp.position.set(0, 2, 0);
		ramp.rotation.z = -0.3;
		ramp.updateMatrixWorld(true);
		ramp.userData.physics = { mode: 'static' };
		ball.position.set(-1.5, 3.2, 0);
		ball.updateMatrixWorld(true);
		ball.userData.physics = { mode: 'dynamic', mass: 1, collider: 'sphere' };
		window.__ball = ball;
		const nodes = [
			{ id: 'col1', type: 'collider', position: { x: 0, y: 0 }, data: { label: 'Collider', type: 'collider', shape: 'box', sensor: false, scale: 1 } },
			{ id: 'sel1', type: 'objectselector', position: { x: 220, y: 0 }, data: { label: 'Object', selected: ball.uuid } }
		];
		const edges = [{ id: 'e1', source: 'col1', target: 'sel1' }];
		s.flowNodes.set(nodes);
		s.flowEdges.set(edges);
	});
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)())),
		(v) => v === true,
		'simulation started'
	);
	await A.page.waitForTimeout(2500); // settle on the ramp
	const held = await A.page.evaluate(async () => {
		const x0 = window.__ball.position.x;
		await new Promise((r) => setTimeout(r, 1200));
		return window.__ball.position.x - x0;
	});
	h.check(Math.abs(held) < 0.1, `collider NODE (box) overrides the Inspector sphere — ball holds (dx ${held.toFixed(3)})`);

	// live: flip the node shape to sphere mid-sim -> the ball starts rolling
	await A.page.evaluate(() => window.__stores.nodesHandler.setNodeData('col1', { shape: 'sphere' }));
	await h.eventually(
		() => A.page.evaluate(() => window.__ball.position.x),
		(x) => x > 0.5,
		'live node shape edit rebuilds mid-sim (ball rolls)',
		15000
	);

	// velocity feed: rolling ball reports a speed on the initiator
	const speed = await A.page.evaluate(() => window.__stores.flowRuntime.speedOf(window.__ball.uuid));
	h.check(speed > 0.2, `velocity feed reads the rolling ball (${speed.toFixed(2)} m/s)`);
	await A.page.evaluate(() => window.__stores.physics.stopSimulation());
	await A.page.waitForTimeout(700);
	const atRest = await A.page.evaluate(() => window.__stores.flowRuntime.speedOf(window.__ball.uuid));
	h.check(atRest === 0, `velocity reads 0 once the feed goes quiet (${atRest})`);

	// 'object' source: a box body borrows ANOTHER object's hull
	await A.page.evaluate(() => {
		const s = window.__stores;
		const cmd = s.commandsHandler.sceneCommand;
		window.__ball.userData.physics = { mode: 'static' }; // park
		window.__ball.position.set(40, 1, 40);
		window.__ball.updateMatrixWorld(true);
		cmd('/create Box 1 1 1');
		cmd('/create Sphere 0.7');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const body = g.children[g.children.length - 2];
		const donor = g.children[g.children.length - 1];
		body.position.set(10, 2, 10);
		body.updateMatrixWorld(true);
		body.userData.physics = { mode: 'dynamic', mass: 1 };
		donor.position.set(20, 0.7, 20);
		donor.updateMatrixWorld(true);
		donor.userData.physics = { mode: 'static' };
		window.__body = body;
		const nodes = [
			{ id: 'col2', type: 'collider', position: { x: 0, y: 0 }, data: { label: 'Collider', type: 'collider', shape: 'object', sensor: false, scale: 1 } },
			{ id: 'sel2', type: 'objectselector', position: { x: 220, y: 0 }, data: { label: 'Object', selected: body.uuid } },
			{ id: 'src2', type: 'objectselector', position: { x: -220, y: 0 }, data: { label: 'Source', selected: donor.uuid } }
		];
		const edges = [
			{ id: 'e2', source: 'col2', target: 'sel2' },
			{ id: 'e3', source: 'src2', target: 'col2', targetHandle: 'source' }
		];
		s.flowNodes.set(nodes);
		s.flowEdges.set(edges);
	});
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => {
			const d = window.__stores.physics.physicsDebug().find((b) => b.uuid === window.__body.uuid);
			return d ? d.hull : null;
		}),
		(hull) => hull === true,
		"shape 'object' hulls the wired source geometry (hull flag)"
	);
	await A.page.evaluate(() => window.__stores.physics.stopSimulation());
	await A.page.waitForTimeout(400);

	// sensor via the NODE + onenter/onexit pulses on pass-through
	await A.page.evaluate(() => {
		const s = window.__stores;
		const cmd = s.commandsHandler.sceneCommand;
		window.__body.userData.physics = { mode: 'static' }; // park as scenery
		cmd('/create Box 2 0.6 2');
		cmd('/create Sphere 0.4');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const zone = g.children[g.children.length - 2];
		const drop = g.children[g.children.length - 1];
		zone.position.set(-14, 2, -14);
		zone.updateMatrixWorld(true);
		zone.userData.physics = { mode: 'static' };
		drop.position.set(-14, 5, -14);
		drop.updateMatrixWorld(true);
		drop.userData.physics = { mode: 'dynamic', mass: 1, collider: 'sphere' };
		window.__drop = drop;
		const nodes = [
			{ id: 'col3', type: 'collider', position: { x: 0, y: 0 }, data: { label: 'Collider', type: 'collider', shape: 'box', sensor: true, scale: 1 } },
			{ id: 'sel3', type: 'objectselector', position: { x: 220, y: 0 }, data: { label: 'Object', selected: zone.uuid } },
			{ id: 'oe1', type: 'onenter', position: { x: 0, y: 120 }, data: { label: 'On Enter', pulse: 0.3 } },
			{ id: 'ox1', type: 'onexit', position: { x: 0, y: 200 }, data: { label: 'On Exit', pulse: 0.3 } }
		];
		const edges = [
			{ id: 'e4', source: 'col3', target: 'sel3' },
			{ id: 'e5', source: 'oe1', target: 'sel3' },
			{ id: 'e6', source: 'ox1', target: 'sel3' }
		];
		s.flowNodes.set(nodes);
		s.flowEdges.set(edges);
	});
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => window.__drop.position.y),
		(y) => y < 1.0,
		'ball falls THROUGH the node-driven sensor zone',
		10000
	);
	const stamps = await A.page.evaluate(
		() => new Promise((r) => window.__stores.flowTriggers.subscribe(r)())
	);
	h.check(!!stamps.oe1?.lastT, `onenter pulsed via the sensor node (${JSON.stringify(stamps.oe1 ?? null)})`);
	h.check(!!stamps.ox1?.lastT, `onexit pulsed (${JSON.stringify(stamps.ox1 ?? null)})`);

	await A.page.evaluate(() => window.__stores.physics.stopSimulation());
	await h.finish(browser);
});
