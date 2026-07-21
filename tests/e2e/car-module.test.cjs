// K-F: drivable car — the demo spawn replicates 5 objects + 4 motorized hinges,
// clicking the body claims it (a second driver is refused), and holding W with
// a running sim drives the assembly (wheel motors via the initiator), with the
// motion replicating as plain moves.
const h = require('./helpers.cjs');

const bodyOf = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					let body = null;
					g?.children.forEach((c) => {
						if (c.name === 'Carbody') body = { uuid: c.uuid, x: c.position.x, z: c.position.z };
					});
					resolve(body);
				})();
			})
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

	// spawn via the module menu action
	const spawned = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.moduleSDK.moduleMenuItems.subscribe((items) => {
					const entry = items.find((i) => i.moduleId === 'car');
					if (entry) {
						entry.action();
						resolve(true);
					} else resolve(false);
				})();
			})
	);
	h.check(spawned === true, 'car spawn menu action found + invoked');

	// the spawn is async (dynamic imports) — poll for the parts + hinges
	const partsOf = () =>
		A.page.evaluate(async () => {
			const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
			const joints = await new Promise((r) => window.__stores.joints.sceneJoints.subscribe(r)());
			return {
				body: group.children.filter((c) => c.name === 'Carbody').length,
				wheels: group.children.filter((c) => c.name === 'Cylinder').length,
				joints: joints.filter((j) => j.kind === 'revolute').length
			};
		});
	await h.eventually(partsOf, (c) => c.body === 1 && c.wheels === 4, 'car parts spawned (body + 4 wheels)');
	await h.eventually(partsOf, (c) => c.joints === 4, '4 motorized axle hinges created');

	// replicated to B: same parts + joints
	await h.eventually(
		() =>
			B.page.evaluate(async () => {
				const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
				const joints = await new Promise((r) => window.__stores.joints.sceneJoints.subscribe(r)());
				return { parts: group.children.filter((c) => c.name === 'Carbody' || c.name === 'Cylinder').length, joints: joints.length };
			}),
		(v) => v && v.parts === 5 && v.joints >= 4,
		'car + joints replicated to B',
		15000
	);

	// claim by clicking the body
	const body = await bodyOf(A.page);
	await A.page.evaluate((uuid) => {
		let target = null;
		window.__stores.objectsGroup.subscribe((g) => (target = g?.getObjectByProperty('uuid', uuid)))();
		for (const handler of window.__stores.moduleSDK.moduleClickHandlers) if (handler(target)) return;
	}, body.uuid);
	await B.page.waitForTimeout(800);

	// B trying to claim the same car is refused (claim map replicated)
	const bClaim = await B.page.evaluate((uuid) => {
		let target = null;
		window.__stores.objectsGroup.subscribe((g) => (target = g?.getObjectByProperty('uuid', uuid)))();
		for (const handler of window.__stores.moduleSDK.moduleClickHandlers) if (handler(target)) return 'consumed';
		return 'ignored';
	}, body.uuid);
	h.check(bClaim === 'consumed', "B's claim attempt is consumed (refusal toast, no takeover)");

	// drive: sim on A (initiator == driver), hold W — the car displaces.
	// C3: driving is gated on Play mode; the claim alone must not steal keys.
	const claimsOf = (page) =>
		page.evaluate(() => new Promise((r) => window.__stores.inputRuntime.inputClaims.subscribe(r)()));
	const followOf = (page) =>
		page.evaluate(() => new Promise((r) => window.__stores.possess.followingCam.subscribe(r)()));
	h.check(!(await claimsOf(A.page)).includes('keys'), 'claim alone does not claim keys (editor keeps WASD)');

	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)())),
		(v) => v === true,
		'simulation running'
	);
	await A.page.waitForTimeout(1000); // wheels settle onto the ground

	// NOT in play mode: holding W must not drive the car
	const preGate = await bodyOf(A.page);
	await A.page.keyboard.down('W');
	await A.page.waitForTimeout(1500);
	await A.page.keyboard.up('W');
	const postGate = await bodyOf(A.page);
	const gateDist = Math.hypot(postGate.x - preGate.x, postGate.z - preGate.z);
	h.check(gateDist < 0.3, `outside Play mode W does not drive (moved ${gateDist.toFixed(2)}m)`);

	// enter Play mode -> engagement: keys claimed + chase cam follows the body
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => claimsOf(A.page), (c) => c.includes('keys'), 'Play mode + sim + claim -> keys claimed');
	await h.eventually(() => followOf(A.page), (v) => v === body.uuid, 'chase cam follows the car body');

	const start = await bodyOf(A.page);
	await A.page.keyboard.down('W');
	await A.page.waitForTimeout(4000);
	await A.page.keyboard.up('W');
	const end = await bodyOf(A.page);
	const dist = Math.hypot(end.x - start.x, end.z - start.z);
	h.check(dist > 0.8, `holding W drives the car (moved ${dist.toFixed(2)}m)`);

	// the car stayed upright through the drive (C3 stability tuning)
	const upright = await A.page.evaluate((uuid) => {
		let target = null;
		window.__stores.objectsGroup.subscribe((g) => (target = g?.getObjectByProperty('uuid', uuid)))();
		const up = new window.__stores.THREE.Vector3(0, 1, 0).applyQuaternion(target.quaternion);
		return up.y;
	}, body.uuid);
	h.check(upright > 0.8, `car stayed upright (up.y = ${upright.toFixed(2)})`);

	// chase cam sits near behind the body while engaged
	const camDist = await A.page.evaluate((uuid) => {
		let target = null;
		window.__stores.objectsGroup.subscribe((g) => (target = g?.getObjectByProperty('uuid', uuid)))();
		let cam = null;
		window.__stores.globalCamera.subscribe((c) => (cam = c))();
		return cam.position.distanceTo(target.position);
	}, body.uuid);
	h.check(camDist < 10, `camera chases the car (${camDist.toFixed(1)}m away)`);

	// motion replicated to B
	await h.eventually(
		() => bodyOf(B.page),
		(p) => p && Math.hypot(p.x - start.x, p.z - start.z) > 0.8,
		'the drive replicated to B',
		10000
	);

	// leaving Play mode disengages (claim itself is kept)
	await A.page.evaluate(() => window.__stores.isLocked.set(null));
	await h.eventually(() => claimsOf(A.page), (c) => !c.includes('keys'), 'exiting Play releases the keys claim');
	await h.eventually(() => followOf(A.page), (v) => v === null, 'exiting Play restores the camera');

	await A.page.evaluate(() => window.__stores.physics.stopSimulation());

	await h.finish(browser);
});
