// Phase 71: VR world grab — pure gesture math (scale/yaw/pan from two hand
// pairs), rig application, replication invariance (peers see local coords),
// reset. On-device feel is the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const compute = (start, now, rig0) =>
		A.page.evaluate(
			({ start, now, rig0 }) => window.__stores.vrControls.computeWorldGrabTransform(start, now, rig0),
			{ start, now, rig0 }
		);
	const identity = { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: 1 };

	// hands apart 2x around a fixed midpoint -> pure scale about the hands
	let t = await compute(
		{ a: [-0.5, 1, 0], b: [0.5, 1, 0] },
		{ a: [-1, 1, 0], b: [1, 1, 0] },
		identity
	);
	h.check(Math.abs(t.scale - 2) < 1e-6, `hands apart scales 2x (${t.scale})`);
	// the world point that was between the hands must stay there:
	// world = rig.pos + scale * p for p = mid0 = (0,1,0) -> pos + 2*(0,1,0) = (0,1,0)
	h.check(
		Math.abs(t.pos[0]) < 1e-6 && Math.abs(t.pos[1] + 1) < 1e-6 && Math.abs(t.pos[2]) < 1e-6,
		`midpoint stays glued under scale (pos ${t.pos.map((v) => v.toFixed(3))})`
	);

	// twist hands 90° CCW (from above) -> yaw only
	t = await compute(
		{ a: [-1, 1, 0], b: [1, 1, 0] },
		{ a: [0, 1, 1], b: [0, 1, -1] },
		identity
	);
	const yaw = 2 * Math.atan2(t.quat[1], t.quat[3]);
	h.check(Math.abs(t.scale - 1) < 1e-6, 'twist keeps scale 1');
	h.check(Math.abs(Math.abs(yaw) - Math.PI / 2) < 1e-6, `twist yields 90° yaw (${yaw.toFixed(3)})`);

	// moving both hands together pans 1:1
	t = await compute(
		{ a: [-0.5, 1, 0], b: [0.5, 1, 0] },
		{ a: [1.5, 1.2, 3], b: [2.5, 1.2, 3] },
		identity
	);
	h.check(
		Math.abs(t.pos[0] - 2) < 1e-6 && Math.abs(t.pos[1] - 0.2) < 1e-6 && Math.abs(t.pos[2] - 3) < 1e-6,
		`pan follows the hands (${t.pos.map((v) => v.toFixed(2))})`
	);

	// total scale clamps at 0.05x–20x
	t = await compute(
		{ a: [-1, 1, 0], b: [1, 1, 0] },
		{ a: [-0.001, 1, 0], b: [0.001, 1, 0] },
		{ ...identity, scale: 0.1 }
	);
	h.check(t.scale >= 0.05, `scale clamps low (${t.scale})`);

	// ---- rig application + replication invariance (71.4) ----
	const uuid = await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = g.children.find((c) => c.name === 'Box');
		box.position.set(2, 0, 0);
		window.__stores.peers.subscribe((p) =>
			p.send({ type: 'move', uuid: box.uuid, pos: [2, 0, 0], rot: [0, 0, 0, 'XYZ'], scale: [1, 1, 1] })
		)();
		return box.uuid;
	});
	await h.eventually(
		() =>
			B.page.evaluate(
				(uuid) =>
					new Promise((r) =>
						window.__stores.objectsGroup.subscribe((g) =>
							r(g?.getObjectByProperty('uuid', uuid)?.position.toArray() ?? null)
						)()
					),
				uuid
			),
		(p) => p && Math.abs(p[0] - 2) < 0.01,
		'box synced to B at local (2,0,0)'
	);

	// A grabs the world down to 0.5x around (0,1,0): locals must NOT change
	const [localA, worldA] = await A.page.evaluate(async (uuid) => {
		const rig = await new Promise((r) => window.__stores.worldRig.subscribe(r)());
		const next = window.__stores.vrControls.computeWorldGrabTransform(
			{ a: [-1, 1, 0], b: [1, 1, 0] },
			{ a: [-0.5, 1, 0], b: [0.5, 1, 0] },
			{ pos: rig.position.toArray(), quat: rig.quaternion.toArray(), scale: rig.scale.x }
		);
		rig.position.fromArray(next.pos);
		rig.quaternion.fromArray(next.quat);
		rig.scale.setScalar(next.scale);
		rig.updateMatrixWorld(true);
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = g.getObjectByProperty('uuid', uuid);
		const world = box.getWorldPosition(new window.__stores.THREE.Vector3());
		return [box.position.toArray(), world.toArray()];
	}, uuid);
	h.check(Math.abs(localA[0] - 2) < 1e-6, 'grabbed world leaves local coords untouched');
	// world pos: rig maps p -> pos + 0.5p with pos = (0,0.5,0) -> box at (1,0.5,0)
	h.check(
		Math.abs(worldA[0] - 1) < 1e-6 && Math.abs(worldA[1] - 0.5) < 1e-6,
		`world position scaled around the hands (${worldA.map((v) => v.toFixed(2))})`
	);
	const localB = await B.page.evaluate(
		(uuid) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r(g?.getObjectByProperty('uuid', uuid)?.position.toArray())
				)()
			),
		uuid
	);
	h.check(Math.abs(localB[0] - 2) < 0.01, 'B (unscaled) still sees the box at (2,0,0)');

	// reset restores 1:1
	await A.page.evaluate(() => window.__stores.vrControls.resetWorldRig());
	const rigState = await A.page.evaluate(async () => {
		const rig = await new Promise((r) => window.__stores.worldRig.subscribe(r)());
		return { scale: rig.scale.x, pos: rig.position.toArray() };
	});
	h.check(
		rigState.scale === 1 && rigState.pos.every((v) => v === 0),
		'Reset world restores identity'
	);

	await h.finish(browser);
});
