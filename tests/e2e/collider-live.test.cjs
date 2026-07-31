// CL-A A2/A3/A5/A6: live collider rebuild mid-sim (no restart), scene gravity
// applied live, freeze axes, and sensor enter/exit dispatch (asserted through
// injected onenter/onexit trigger stamps — the nodes themselves land in CL-C,
// but fireSensorEdge only needs node.type).
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

	// scene: a gentle static ramp + a sphere-collider ball that rolls down it
	await A.page.evaluate(() => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create Box 8 0.4 4');
		cmd('/create Sphere 0.5');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const ramp = g.children[g.children.length - 2];
		const ball = g.children[g.children.length - 1];
		ramp.position.set(0, 2, 0);
		ramp.rotation.z = -0.3; // tan ~0.31 < friction 0.5: a BOX holds, a sphere rolls
		ramp.updateMatrixWorld(true);
		ramp.userData.physics = { mode: 'static' };
		ball.position.set(-1.5, 3.2, 0);
		ball.updateMatrixWorld(true);
		ball.userData.physics = { mode: 'dynamic', mass: 1, collider: 'sphere' };
		window.__ramp = ramp;
		window.__ball = ball;
	});
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)())),
		(v) => v === true,
		'simulation started'
	);
	await h.eventually(
		() => A.page.evaluate(() => window.__ball.position.x),
		(x) => x > 0.5,
		'sphere collider rolls down the ramp',
		15000
	);

	// 1) LIVE rebuild: swap sphere -> box mid-sim; friction now holds it still
	await A.page.evaluate(() => {
		window.__ball.userData.physics = { ...window.__ball.userData.physics, collider: 'box' };
		window.__stores.physics.physicsShapeChanged(window.__ball.uuid);
	});
	await A.page.waitForTimeout(2500); // let the box scrub off the roll speed
	const still = await A.page.evaluate(async () => {
		const x0 = window.__ball.position.x;
		await new Promise((r) => setTimeout(r, 1200));
		const debug = window.__stores.physics.physicsDebug().find((b) => b.uuid === window.__ball.uuid);
		return { dx: window.__ball.position.x - x0, linvel: debug?.linvel ?? null, sim: !!debug };
	});
	h.check(still.sim, 'body still simulated after the live rebuild (no restart)');
	h.check(
		Math.abs(still.dx) < 0.15,
		`box collider stops the roll WITHOUT a sim restart (dx ${still.dx.toFixed(3)})`
	);

	// 2) LIVE gravity: flip it upward mid-sim -> the ball climbs
	const climb = await A.page.evaluate(async () => {
		window.__stores.scenePhysics.setSceneGravity(4);
		const y0 = window.__ball.position.y;
		await new Promise((r) => setTimeout(r, 1500));
		const dy = window.__ball.position.y - y0;
		window.__stores.scenePhysics.resetSceneGravity();
		return dy;
	});
	h.check(climb > 0.5, `upward gravity lifts the ball live (dy ${climb.toFixed(2)})`);

	// 3) scenephysics replication: the gravity write broadcast a singleton msg
	const sent = await A.page.evaluate(() => {
		window.__sent = [];
		let peer;
		window.__stores.peers.subscribe((p) => (peer = p))();
		const original = peer.send;
		peer.send = (m) => window.__sent.push(m.type);
		window.__stores.scenePhysics.setSceneGravity(-9.81);
		peer.send = original;
		return window.__sent;
	});
	h.check(sent.includes('scenephysics'), `setSceneGravity broadcasts (${JSON.stringify(sent)})`);
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await A.page.waitForTimeout(400);

	// 4) freeze axes: a frozen-rotation box dropped askew lands WITHOUT tumbling
	await A.page.evaluate(() => {
		window.__ball.position.set(30, 4, 30); // park
		window.__ball.updateMatrixWorld(true);
		window.__ball.userData.physics = { mode: 'static' };
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create Box 1 1 1');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		box.position.set(0, 4, -6);
		box.rotation.y = 0.4;
		box.updateMatrixWorld(true);
		box.userData.physics = {
			mode: 'dynamic',
			mass: 1,
			freeze: { rx: true, ry: true, rz: true }
		};
		window.__frozen = box;
		window.__rotY0 = box.rotation.y;
	});
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => window.__frozen.position.y),
		(y) => y < 1.2,
		'frozen box fell',
		10000
	);
	const frozen = await A.page.evaluate(() => ({
		rotY: window.__frozen.rotation.y,
		rotY0: window.__rotY0,
		rotX: window.__frozen.rotation.x,
		rotZ: window.__frozen.rotation.z
	}));
	h.check(
		Math.abs(frozen.rotY - frozen.rotY0) < 0.02 && Math.abs(frozen.rotX) < 0.02 && Math.abs(frozen.rotZ) < 0.02,
		`frozen rotations survive the landing (${JSON.stringify(frozen)})`
	);
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await A.page.waitForTimeout(400);

	// 5) sensor: a dynamic ball falls THROUGH a static sensor box and pulses
	// injected onenter/onexit trigger nodes (replicated stamps)
	await A.page.evaluate(() => {
		window.__frozen.userData.physics = { mode: 'static' }; // park as scenery
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create Box 2 0.6 2');
		cmd('/create Sphere 0.4');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const zone = g.children[g.children.length - 2];
		const drop = g.children[g.children.length - 1];
		zone.position.set(12, 2, 12);
		zone.updateMatrixWorld(true);
		zone.userData.physics = { mode: 'static', sensor: true };
		drop.position.set(12, 5, 12);
		drop.updateMatrixWorld(true);
		drop.userData.physics = { mode: 'dynamic', mass: 1, collider: 'sphere' };
		window.__zone = zone;
		window.__drop = drop;
		// raw trigger nodes wired to the ZONE — fireSensorEdge matches node.type
		const nodes = [
			{ id: 'oe1', type: 'onenter', position: { x: 0, y: 0 }, data: { label: 'On Enter', pulse: 0.3 } },
			{ id: 'ox1', type: 'onexit', position: { x: 0, y: 80 }, data: { label: 'On Exit', pulse: 0.3 } },
			{ id: 'sel1', type: 'objectselector', position: { x: 200, y: 40 }, data: { label: 'Object', selected: zone.uuid } }
		];
		const edges = [
			{ id: 'e1', source: 'oe1', target: 'sel1' },
			{ id: 'e2', source: 'ox1', target: 'sel1' }
		];
		window.__stores.flowNodes.set(nodes);
		window.__stores.flowEdges.set(edges);
	});
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => window.__drop.position.y),
		(y) => y < 1.0,
		'ball fell PAST the sensor zone (no collision with a sensor)',
		10000
	);
	const stamps = await A.page.evaluate(
		() => new Promise((r) => window.__stores.flowTriggers.subscribe(r)())
	);
	h.check(!!stamps.oe1?.lastT, `onenter pulsed (${JSON.stringify(stamps.oe1 ?? null)})`);
	h.check(!!stamps.ox1?.lastT, `onexit pulsed (${JSON.stringify(stamps.ox1 ?? null)})`);

	await A.page.evaluate(() => window.__stores.physics.stopSimulation());
	await h.finish(browser);
});
