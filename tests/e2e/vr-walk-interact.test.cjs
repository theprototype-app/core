// 30b P3: WALK LIKE A GAME. The Quest report (the dungeon): "I can go through walls,
// teleport, I want to be able to do this only in edit mode and fly only in edit mode. In
// interactive mode I should be able to move like in a game, without going through walls."
// Interact's stick now walks: the step resolves through charController.resolveWalk (the
// rapier capsule while a sim runs), gravity holds the feet on the floor, a ~0.3 m step is
// climbed, and teleport/fly are off unless the play block allows them. Edit is unchanged
// (it flies, through walls, and teleports).
//
// Section 1 drives the walker step with a REAL rapier world; section 2 drives the REAL
// per-frame path (VRControls' task) through a fake XR session whose reference space
// composes offsets exactly as WebXR specifies (fakeXR.installSpace).
// Desktop Play's built-in flier gets the same walls (section 4).
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');

	// ---- the fixture: floor (top 0), a wall ahead, a 0.25 m step, a 0.6 m block --------------
	await A.page.evaluate(async () => {
		const s = window.__stores;
		const get = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
		for (let i = 0; i < 5; i++) s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 600));
		const [floor, wall, step, block, faller] = get(s.objectsGroup).children.filter((c) => c.name === 'Box');
		const place = (o, pos, scale) => { o.position.set(...pos); o.scale.set(...scale); o.updateMatrixWorld(true); };
		place(floor, [0, -0.25, 0], [20, 0.5, 20]);
		place(wall, [0, 1.5, -3], [10, 3, 0.4]); // front face at z = -2.8
		place(step, [3, 0.125, 0], [2, 0.25, 2]); // x 2..4, top 0.25
		place(block, [-3, 0.3, 0], [2, 0.6, 2]); // x -4..-2, top 0.6
		place(faller, [8, 3, 8], [0.4, 0.4, 0.4]);
		for (const o of [floor, wall, step, block]) s.physics.setPhysicsFor(o.uuid, { mode: 'static' });
		s.physics.setPhysicsFor(faller.uuid, { mode: 'dynamic', mass: 1 });
		s.objectActions.deselectObject();
	});
	await A.page.waitForTimeout(800);
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.physics.physicsWorldDebug().running),
		(ok) => ok,
		'premise: a simulation is running (the capsule tier needs a world)',
		15000
	);

	// ---- 1. the walker step against a real world -----------------------------------------------
	// charController primes physics with a LAZY dynamic import (a scene with no walker never
	// loads rapier), so the very first steps resolve on the plane tier: wait for the capsule
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.vrControls.vrWalkStep({ head: { x: 6, y: 1.6, z: 6 }, headHeight: 1.6, yaw: 0, stick: { x: 0, y: 0 }, dt: 0.016 }).source),
		(src) => src === 'rapier',
		'premise: the walker has its rapier capsule',
		10000
	);
	const walk = (input, steps) =>
		A.page.evaluate(
			({ input, steps }) => {
				const vr = window.__stores.vrControls;
				const head = { ...input.head };
				let last = null;
				for (let i = 0; i < steps; i++) {
					last = vr.vrWalkStep({ ...input, head: { ...head }, dt: 0.05 });
					head.x += last.dx;
					head.y += last.dy;
					head.z += last.dz;
				}
				return { head, feet: head.y - input.headHeight, source: last?.source, grounded: last?.grounded };
			},
			{ input, steps }
		);
	const fwd = { x: 0, y: -1 }; // stick UP
	let r = await walk({ head: { x: 0, y: 1.6, z: 0 }, headHeight: 1.6, yaw: 0, stick: fwd }, 80);
	h.check(r.source === 'rapier', `the walker resolved through the rapier capsule (${r.source})`);
	h.check(r.head.z < -2.2 && r.head.z > -2.6, `walking at a wall STOPS at it (z ${r.head.z.toFixed(2)}; the face is at -2.8, the capsule radius 0.3)`);
	r = await walk({ head: { x: 6, y: 4.6, z: 6 }, headHeight: 1.6, yaw: 0, stick: { x: 0, y: 0 } }, 60);
	h.check(Math.abs(r.feet) < 0.08 && r.grounded, `gravity puts the feet on the floor (feet ${r.feet.toFixed(3)}, grounded ${r.grounded})`);
	// 14 steps of 0.11 m from x 1.2 end ON the step (x 2..4), not past it
	r = await walk({ head: { x: 1.2, y: 1.6, z: 0 }, headHeight: 1.6, yaw: -Math.PI / 2, stick: fwd }, 14);
	h.check(r.head.x > 2.4 && r.head.x < 3.8 && Math.abs(r.feet - 0.25) < 0.08, `a 0.25 m step is climbed (x ${r.head.x.toFixed(2)}, feet ${r.feet.toFixed(2)})`);
	r = await walk({ head: { x: -1.2, y: 1.6, z: 0 }, headHeight: 1.6, yaw: Math.PI / 2, stick: fwd }, 30);
	h.check(r.head.x > -2.05 && r.feet < 0.1, `a 0.6 m block is a wall, not a step (x ${r.head.x.toFixed(2)}, feet ${r.feet.toFixed(2)})`);
	r = await walk({ head: { x: 6, y: 1.6, z: 6 }, headHeight: 1.6, yaw: 0, stick: fwd, fly: true, aim: { x: 0, y: 0.8, z: -0.6 } }, 20);
	h.check(r.feet > 1, `a flier (only when allowed) climbs along its aim (feet ${r.feet.toFixed(2)})`);

	// ---- 2. the real per-frame path: Interact walks into the wall and stops ----------------------
	await A.page.evaluate(() => window.__stores.isVRMode.set(true));
	await xr.install(A.page);
	await xr.installSpace(A.page, { head: [0, 1.6, 0], yaw: 0 });
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await A.page.waitForTimeout(300);
	let head = await xr.head(A.page);
	h.check(Math.abs(head.z) < 0.05 && Math.abs(head.y - 1.6) < 0.05, `premise: the head starts at the origin, 1.6 m up (${JSON.stringify(head)})`);
	await xr.stick(A.page, 'left', 0, -1);
	await A.page.waitForTimeout(2500);
	await xr.stick(A.page, 'left', 0, 0);
	head = await xr.head(A.page);
	h.check(head.z < -1.5, `Interact: the left stick walks you forward (z ${head.z.toFixed(2)})`);
	h.check(head.z > -2.6, `Interact: ...and the wall stops you (z ${head.z.toFixed(2)})`);
	h.check(Math.abs(head.y - 1.6) < 0.1, `Interact: the feet stay on the floor (head y ${head.y.toFixed(2)})`);

	// ---- 3. teleport: off in Interact, on in Edit, on in Interact when the play block allows ---
	const teleportArms = async () => {
		await xr.stick(A.page, 'right', 0, -1);
		await A.page.waitForTimeout(300);
		const st = await A.page.evaluate(() => window.__stores.vrControls.teleportState());
		await xr.stick(A.page, 'right', 0, 0);
		await A.page.waitForTimeout(300);
		return st.engaged;
	};
	h.check((await teleportArms()) === false, 'Interact: the right stick does NOT arm a teleport');
	await A.page.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ play: { locomotion: { teleport: true } } }));
	await A.page.waitForTimeout(200);
	h.check((await teleportArms()) === true, 'Interact + play.locomotion.teleport: the teleport arc arms');
	const saved = await A.page.evaluate(() => {
		let v;
		window.__stores.scenePhysics.scenePlay.subscribe((x) => (v = x))();
		return v;
	});
	h.check(saved.locomotion?.teleport === true && saved.locomotion.fly === undefined, `the play block stores only what was authored (${JSON.stringify(saved.locomotion)})`);
	await A.page.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ play: { locomotion: null } }));
	await A.page.waitForTimeout(200);
	const cleared = await A.page.evaluate(() => {
		let v;
		window.__stores.scenePhysics.scenePlay.subscribe((x) => (v = x))();
		return 'locomotion' in v;
	});
	h.check(cleared === false, 'clearing the block removes the key (a scene that never used it saves byte-identically)');

	// ---- 4. Edit flies through the same wall ----------------------------------------------------
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	h.check((await teleportArms()) === true, 'Edit: the teleport arc arms as it always did');
	await xr.stick(A.page, 'left', 0, -1);
	await A.page.waitForTimeout(2500);
	await xr.stick(A.page, 'left', 0, 0);
	head = await xr.head(A.page);
	h.check(head.z < -3.2, `Edit: the same stick flies THROUGH the wall (z ${head.z.toFixed(2)})`);
	await xr.uninstall(A.page);
	await A.page.evaluate(() => window.__stores.isVRMode.set(false));
	await A.page.waitForTimeout(300);

	// ---- 5. desktop Play's built-in flier stops at the wall too ------------------------------------
	const cam = () =>
		A.page.evaluate(() => {
			let c;
			window.__stores.playerCam.subscribe((x) => (c = x))();
			return c.getWorldPosition(new window.__stores.THREE.Vector3()).toArray();
		});
	await A.page.evaluate(() => {
		let c;
		window.__stores.playerCam.subscribe((x) => (c = x))();
		const THREE = window.__stores.THREE;
		const target = new THREE.Vector3(0, 1.7, 0);
		c.parent.worldToLocal(target);
		c.position.copy(target);
		c.quaternion.identity();
		window.__stores.isLocked.set(true);
	});
	await A.page.waitForTimeout(400);
	await A.page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true })));
	await A.page.waitForTimeout(2500);
	await A.page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true })));
	const p = await cam();
	h.check(p[2] < -1, `desktop Play: W flies you forward (z ${p[2].toFixed(2)})`);
	h.check(p[2] > -2.6, `desktop Play: ...and the wall stops you while a sim runs (z ${p[2].toFixed(2)})`);
	await A.page.evaluate(() => window.__stores.isLocked.set(false));

	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.finish(browser);
});
