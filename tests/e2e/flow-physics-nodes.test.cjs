// C2 (roadmap #13): constant-rotation physics nodes. An Angular Velocity node
// alone makes its object spin under physics (implied dynamic mass 1), a Motor
// node drives every revolute joint touching its object, param edits re-apply
// LIVE mid-sim, api applyTorqueImpulse spins a dynamic body, and the motion
// replicates to a second peer as plain moves (authoritative sync).
const h = require('./helpers.cjs');

const rotOf = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					resolve(o ? { y: o.rotation.y, qy: o.quaternion.y, qw: o.quaternion.w } : null);
				})();
			}),
		uuid
	);

h.run(async () => {
	const browser = await h.launch();
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// scene: Spinner (only an Angular Velocity node), Base + Rotor hinged about y
	// (Rotor dynamic, floats above the base so nothing brakes the motor)
	const ids = await A.page.evaluate(async () => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create box');
		cmd('/create box');
		cmd('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const [spinner, base, rotor] = group.children;
		spinner.name = 'Spinner';
		base.name = 'Base';
		rotor.name = 'Rotor';
		spinner.position.set(0, 0.5, 0);
		base.position.set(6, 0.5, 0);
		rotor.position.set(6, 2.2, 0);
		rotor.userData.physics = { mode: 'dynamic', mass: 1 };
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		[spinner, base, rotor].forEach((o) => {
			peer.send({ type: 'move', uuid: o.uuid, pos: o.position.toArray(), rot: [0, 0, 0], scale: [1, 1, 1] });
			if (o.userData.physics)
				peer.send({ type: 'objectParameters', parameter: 'physics', uuid: o.uuid, physics: o.userData.physics });
		});
		// hinge Rotor to Base about y (replicated jointcreate inside createJoint)
		const joint = window.__stores.joints.createJoint('revolute', base.uuid, rotor.uuid, 'y');
		// graph: angularvelocity -> Spinner, motor -> Rotor
		const nodes = [
			{ id: 'av1', type: 'angularvelocity', position: { x: 0, y: 0 }, data: { type: 'angularvelocity', axis: 'y', speed: 3 }, class: 'w-[150px]' },
			{ id: 'selS', type: 'objectselector', position: { x: 300, y: 0 }, data: { type: 'objectselector', selected: spinner.uuid }, class: 'w-[150px]' },
			{ id: 'mo1', type: 'motor', position: { x: 0, y: 200 }, data: { type: 'motor', vel: 4, maxForce: 150 }, class: 'w-[150px]' },
			{ id: 'selR', type: 'objectselector', position: { x: 300, y: 200 }, data: { type: 'objectselector', selected: rotor.uuid }, class: 'w-[150px]' }
		];
		const edges = [
			{ id: 'e-av1-selS', source: 'av1', target: 'selS' },
			{ id: 'e-mo1-selR', source: 'mo1', target: 'selR' }
		];
		window.__stores.flowNodes.set(nodes);
		window.__stores.flowEdges.set(edges);
		nodes.forEach((node) => peer.send({ type: 'nodecreate', node }));
		edges.forEach((edge) => peer.send({ type: 'edgecreate', edge }));
		return { spinner: spinner.uuid, base: base.uuid, rotor: rotor.uuid, joint: joint?.id ?? null };
	});
	h.check(!!ids.joint, 'revolute joint created');
	await A.page.waitForTimeout(2500);

	// simulate on A
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)())),
		(v) => v === true,
		'simulation started on A'
	);

	// the Angular Velocity node made Spinner a dynamic body (implied mass 1) that
	// picked up spin — ground friction decays the angvel itself within ~a frame,
	// so assert the body's accumulated rotation, not the live velocity
	const debugOf = () => A.page.evaluate(() => window.__stores.physics.physicsDebug());
	await h.eventually(
		debugOf,
		(d) => {
			const s = d.find((e) => e.uuid === ids.spinner);
			return s && s.mode === 'dynamic' && s.bodyRot && Math.abs(s.bodyRot.y) > 0.02;
		},
		'Spinner is a dynamic body that picked up y spin (no Mass node wired)'
	);
	await h.eventually(
		() => rotOf(A.page, ids.spinner),
		(r) => r && Math.abs(r.qy) > 0.05,
		'Spinner visibly rotates on A'
	);

	// the Motor node spins the hinged Rotor
	await h.eventually(
		() => rotOf(A.page, ids.rotor),
		(r) => r && Math.abs(r.qy) > 0.05,
		'Motor node spins the hinged Rotor on A',
		15000
	);

	// rotation replicates to B as plain moves
	await h.eventually(
		() => rotOf(B.page, ids.spinner),
		(r) => r && Math.abs(r.qy) > 0.05,
		'Spinner rotation replicated to B',
		15000
	);
	await h.eventually(
		() => rotOf(B.page, ids.rotor),
		(r) => r && Math.abs(r.qy) > 0.05,
		'Rotor rotation replicated to B',
		15000
	);

	// LIVE re-apply: flip the Angular Velocity sign mid-sim via setNodeData
	await A.page.evaluate(() => window.__stores.nodesHandler.setNodeData('av1', { speed: -5 }));
	await h.eventually(
		debugOf,
		(d) => {
			const s = d.find((e) => e.uuid === ids.spinner);
			return s && s.angvel && s.angvel.y < -1;
		},
		'editing the node mid-sim re-applies the angular velocity (live)',
		10000
	);

	// SDK torque impulse on a dynamic body (initiator-only)
	const torqued = await A.page.evaluate(
		(uuid) => window.__stores.physics.applyTorqueImpulse(uuid, [0, 4, 0]),
		ids.rotor
	);
	h.check(torqued === true, 'applyTorqueImpulse accepted on a dynamic body');
	const refused = await A.page.evaluate(
		(uuid) => window.__stores.physics.applyTorqueImpulse(uuid, [0, 4, 0]),
		ids.base
	);
	h.check(refused === false, 'applyTorqueImpulse refused on a non-dynamic body');

	await A.page.evaluate(() => window.__stores.physics.stopSimulation());
	await h.finish(browser);
});
