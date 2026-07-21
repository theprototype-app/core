// P-B: joints — replicated sceneJoints defs (weld/hinge), one-step undo, the
// Physics context-menu entry, welded pairs staying rigid through a fall, and a
// motorized hinge spinning its wheel. Two-peer + rapier prewarm.
const h = require('./helpers.cjs');

const jointsOf = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.joints.sceneJoints.subscribe((j) => r(j))()));

const posOf = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					resolve(o ? { x: o.position.x, y: o.position.y, z: o.position.z } : null);
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

	// --- create a pair, weld them, replicate + undo/redo ----------------------
	const { aUuid, bUuid, jointId } = await A.page.evaluate(async () => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create Box 1 1 1');
		cmd('/create Box 1 1 1');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const [a, b] = group.children.slice(-2);
		a.position.set(0, 4, 0);
		b.position.set(1.5, 4, 0);
		a.userData.physics = { mode: 'dynamic', mass: 1 };
		b.userData.physics = { mode: 'dynamic', mass: 1 };
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		peer.send({ type: 'move', uuid: a.uuid, pos: [0, 4, 0], rot: [0, 0, 0], scale: [1, 1, 1] });
		peer.send({ type: 'move', uuid: b.uuid, pos: [1.5, 4, 0], rot: [0, 0, 0], scale: [1, 1, 1] });
		const joint = window.__stores.joints.createJoint('fixed', a.uuid, b.uuid);
		return { aUuid: a.uuid, bUuid: b.uuid, jointId: joint.id };
	});
	h.check(!!jointId, 'weld joint created on A');

	await h.eventually(
		() => jointsOf(B.page),
		(j) => j.some((d) => d.id === jointId && d.kind === 'fixed'),
		'jointcreate replicated to B'
	);

	// one-step undo removes the def everywhere; redo restores it
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => jointsOf(B.page), (j) => !j.some((d) => d.id === jointId), 'undo removes the joint on B too');
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => jointsOf(B.page), (j) => j.some((d) => d.id === jointId), 'redo restores the joint on B');

	// --- context menu: two selected -> Physics submenu -------------------------
	const menu = await A.page.evaluate(
		([a, b]) => {
			window.__stores.objectActions.applySelectionSet([a, b]);
			const items = window.__stores.objectMenu.buildObjectMenuItems(a);
			const physics = items.find((i) => i.label === 'Physics');
			return physics ? physics.children.map((c) => c.label) : null;
		},
		[aUuid, bUuid]
	);
	h.check(!!menu && menu.some((l) => l.startsWith('Weld')), `menu offers Weld (${menu?.join(' | ')})`);
	h.check(!!menu && menu.filter((l) => l.startsWith('Hinge')).length === 3, 'menu offers Hinge X/Y/Z');
	h.check(!!menu && menu.some((l) => l.startsWith('Detach joints')), 'menu offers Detach for the jointed pair');
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());

	// --- welded pair falls as ONE rigid piece ----------------------------------
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(() => posOf(A.page, aUuid), (p) => p && p.y < 0.6, 'welded pair fell to the ground on A', 15000);
	await A.page.waitForTimeout(800); // settle
	const [pa, pb] = [await posOf(A.page, aUuid), await posOf(A.page, bUuid)];
	const gap = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
	h.check(Math.abs(gap - 1.5) < 0.15, `weld keeps the 1.5 offset through the fall (${gap.toFixed(2)})`);
	await h.eventually(
		() => Promise.all([posOf(B.page, aUuid), posOf(B.page, bUuid)]).then(([a2, b2]) => (a2 && b2 ? Math.hypot(b2.x - a2.x, b2.y - a2.y, b2.z - a2.z) : null)),
		(g) => g != null && Math.abs(g - 1.5) < 0.2,
		'welded fall replicated to B with the offset intact',
		10000
	);
	await A.page.evaluate(() => window.__stores.physics.stopSimulation());

	// --- motorized hinge spins its wheel ---------------------------------------
	// the wheel hangs IN THE AIR from the hinge (the old on-the-ground layout
	// could contact-lock anchor/wheel/ground and stall the motor — flaky read)
	const wheel = await A.page.evaluate(async () => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create Box 0.6 0.6 0.6'); // anchor block
		cmd('/create Cylinder 0.5 0.5 0.3'); // wheel
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const [anchor, wheel] = group.children.slice(-2);
		anchor.position.set(-4, 0.3, 0);
		wheel.position.set(-4, 1.8, 0);
		anchor.userData.physics = { mode: 'dynamic', mass: 5 };
		wheel.userData.physics = { mode: 'dynamic', mass: 1 };
		const joint = window.__stores.joints.createJoint('revolute', anchor.uuid, wheel.uuid, 'y');
		return { wheelUuid: wheel.uuid, jointId: joint.id };
	});
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await A.page.waitForTimeout(600);
	const motorOk = await A.page.evaluate((id) => window.__stores.physics.setJointMotor(id, 6, 200), wheel.jointId);
	h.check(motorOk === true, 'setJointMotor accepts the live joint');
	// poll (machine-load safe) instead of a one-shot read
	await h.eventually(
		() =>
			A.page.evaluate((uuid) => {
				const d = window.__stores.physics.physicsDebug().find((e) => e.uuid === uuid);
				return d?.angvel ? Math.hypot(d.angvel.x, d.angvel.y, d.angvel.z) : 0;
			}, wheel.wheelUuid),
		(spin) => spin > 1,
		'motor spins the hinged wheel',
		15000
	);
	await A.page.evaluate(() => window.__stores.physics.stopSimulation());

	// --- detach deletes the defs (replicated) ----------------------------------
	const removed = await A.page.evaluate(
		([a, b]) => window.__stores.joints.detachJoints([a, b]),
		[aUuid, bUuid]
	);
	h.check(removed === 1, `detach removed the weld (${removed})`);
	await h.eventually(() => jointsOf(B.page), (j) => !j.some((d) => d.id === jointId), 'detach replicated to B');

	await h.finish(browser);
});
