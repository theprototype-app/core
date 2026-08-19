// 21-B B2 — the release-velocity estimator.
//
// Sections 1-4 are PURE: throwVelocity.js imports THREE and nothing else, so
// they import the ESM directly with no browser (the shader-compile precedent).
// Section 5 is the regression guard for the real caller — a held body released
// after a spin through the +-PI wrap (Scene.svelte's gizmo drag path).
//
// Both checks that matter carry their own counterfactual: the spin case
// RECOMPUTES the old Euler-difference formula in-test and asserts the two
// disagree in SIGN, and the clamp case measures the ANGLE between the input and
// output directions — every invariant a per-component clamp preserves (length
// <= 20, same octant) is preserved by the wrong answer too.

const { pathToFileURL } = require('url');
const path = require('path');
const h = require('./helpers.cjs');

const check = h.check;
const src = (f) => pathToFileURL(path.join(__dirname, '..', '..', 'src', 'lib', f)).href;

h.run(async () => {
	const THREE = await import('three');
	const { velocityFromSamples, clampThrow, MAX_LINVEL, MAX_ANGVEL } = await import(
		src('throwVelocity.js')
	);

	const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
	/** a sample ring at `hz`, posed by a function of the sample index */
	const ring = (count, dtMs, pose) =>
		Array.from({ length: count }, (_, i) => ({ t: 1000 + i * dtMs, ...pose(i) }));
	const euler = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));

	// ---- 1. linear ------------------------------------------------------------
	console.log('\n=== 1. linear velocity ===');
	{
		// 4 samples, 16ms apart, moving +2 m/s along X
		const samples = ring(4, 16, (i) => ({ pos: v3(i * 0.032, 0, 0), quat: euler(0, 0, 0) }));
		const { linvel } = velocityFromSamples(samples);
		check(Math.abs(linvel.x - 2) < 1e-6, '1.1 +2 m/s along X reads back as ' + linvel.x.toFixed(4));
		check(linvel.y === 0 && linvel.z === 0, '1.2 the other axes stay zero');
	}
	{
		const single = velocityFromSamples([{ t: 0, pos: v3(5, 5, 5), quat: euler(0, 0, 0) }]);
		check(single.linvel.length() === 0, '1.3 ONE sample yields zero, not NaN');
		const none = velocityFromSamples([]);
		check(none.linvel.length() === 0 && none.angvel.length() === 0, '1.4 no samples yields zero');
	}
	{
		// two samples in the same millisecond: the guard must bound the divisor
		const same = velocityFromSamples([
			{ t: 1000, pos: v3(0, 0, 0), quat: euler(0, 0, 0) },
			{ t: 1000.4, pos: v3(0.1, 0, 0), quat: euler(0, 0, 0) }
		]);
		check(
			Number.isFinite(same.linvel.x) && same.linvel.length() <= MAX_LINVEL,
			'1.5 samples <1ms apart do not divide by zero (|v| = ' + same.linvel.length().toFixed(2) + ')'
		);
	}

	// ---- 2. the Euler bug -----------------------------------------------------
	console.log('\n=== 2. angular velocity across a wrap ===');
	{
		// A ring spinning about +Y through the wrap. The angles are chosen around
		// 180deg on purpose: an object's `rotation` is re-derived from its
		// quaternion, so it is always normalised into (-PI, PI] and the wrap that
		// actually bites in the app is the one at +-PI, not at 0/360.
		const degs = [170, 175, 180, 185, 190];
		const samples = degs.map((d, i) => ({
			t: 1000 + i * 16,
			pos: v3(0, 0, 0),
			quat: euler(0, (d * Math.PI) / 180, 0)
		}));
		const { angvel } = velocityFromSamples(samples);
		// 20 degrees over 64 ms = 0.349 rad / 0.064 s = ~5.45 rad/s about +Y
		check(angvel.y > 4 && angvel.y < 7, '2.1 the spin reads ~+5.45 rad/s about +Y (got ' + angvel.y.toFixed(2) + ')');
		check(
			Math.abs(angvel.x) < 1e-6 && Math.abs(angvel.z) < 1e-6,
			'2.2 no phantom X/Z component (' + angvel.x.toFixed(4) + ', ' + angvel.z.toFixed(4) + ')'
		);

		// the counterfactual: the OLD formula, recomputed here
		const a = new THREE.Euler().setFromQuaternion(samples[0].quat, 'YXZ');
		const b = new THREE.Euler().setFromQuaternion(samples[samples.length - 1].quat, 'YXZ');
		const oldY = (b.y - a.y) / ((samples[4].t - samples[0].t) / 1000);
		check(
			oldY < 0 && angvel.y > 0,
			'2.3 the old Euler difference gets the SIGN wrong here (' +
				oldY.toFixed(2) +
				' vs ' +
				angvel.y.toFixed(2) +
				' rad/s)'
		);
	}
	{
		// no wrap, but an axis-coupling case the Euler derivative also gets wrong:
		// a spin about +Z while already pitched
		const samples = ring(3, 16, (i) => ({
			pos: v3(0, 0, 0),
			quat: new THREE.Quaternion()
				.setFromAxisAngle(new THREE.Vector3(0, 0, 1), i * 0.1)
				.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.2))
		}));
		const { angvel } = velocityFromSamples(samples);
		// the world axis of the spin is X-pitched Z
		const expected = new THREE.Vector3(0, 0, 1)
			.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.2))
			.multiplyScalar(0.2 / 0.032);
		check(
			angvel.distanceTo(expected) < 1e-3,
			'2.4 a coupled spin reads its true WORLD axis (err ' + angvel.distanceTo(expected).toFixed(5) + ')'
		);
	}
	{
		const still = velocityFromSamples(ring(4, 16, () => ({ pos: v3(0, 0, 0), quat: euler(0, 0, 0) })));
		check(still.angvel.length() === 0, '2.5 a motionless hold releases with zero spin (no axis noise)');
	}

	// ---- 3. the clamp is on the MAGNITUDE -------------------------------------
	console.log('\n=== 3. clamping preserves direction ===');
	{
		const wanted = v3(30, 30, 0); // |v| = 42.4, and each COMPONENT is over 20
		const { linvel } = clampThrow(wanted, null);
		check(
			Math.abs(linvel.length() - MAX_LINVEL) < 1e-6,
			'3.1 a 42.4 m/s throw clamps to exactly 20 (got ' + linvel.length().toFixed(4) + ')'
		);
		const angle = linvel.angleTo(wanted);
		check(angle < 1e-6, '3.2 the DIRECTION survives (angle ' + angle.toFixed(8) + ' rad)');
		// counterfactual: a per-component clamp would have turned it
		const perComponent = v3(
			Math.min(30, 20),
			Math.min(30, 20),
			0
		);
		check(
			perComponent.length() > MAX_LINVEL + 1e-6,
			'3.3 (the old per-component clamp left |v| = ' + perComponent.length().toFixed(2) + ', over the ceiling)'
		);
		const skew = v3(30, 5, 0);
		const clampedSkew = clampThrow(skew, null).linvel;
		const perComponentSkew = v3(20, 5, 0);
		check(
			clampedSkew.angleTo(skew) < 1e-6 && perComponentSkew.angleTo(skew) > 0.05,
			'3.4 ...and ROTATED an asymmetric throw by ' +
				((perComponentSkew.angleTo(skew) * 180) / Math.PI).toFixed(1) +
				' degrees; the magnitude clamp does not'
		);
	}
	{
		const under = clampThrow(v3(1, 2, 3), v3(0.1, 0, 0));
		check(
			Math.abs(under.linvel.length() - Math.sqrt(14)) < 1e-9,
			'3.5 a throw under the ceiling is untouched'
		);
		const spin = clampThrow(null, v3(0, 100, 0));
		check(Math.abs(spin.angvel.y - MAX_ANGVEL) < 1e-9, '3.6 angular clamps to 20 rad/s');
		const hostile = clampThrow([1e6, 1e6, 1e6], [Infinity, 0, 0]);
		check(
			hostile.linvel.length() <= MAX_LINVEL + 1e-6 && hostile.angvel.length() === 0,
			'3.7 a hostile payload (1e6 / Infinity) clamps and de-NaNs — B5 needs no validation of its own'
		);
	}
	{
		// the estimator's own output is clamped, so no caller can smuggle a spike past
		const fast = velocityFromSamples([
			{ t: 1000, pos: v3(0, 0, 0), quat: euler(0, 0, 0) },
			{ t: 1016, pos: v3(50, 0, 0), quat: euler(0, 0, 0) }
		]);
		check(
			Math.abs(fast.linvel.length() - MAX_LINVEL) < 1e-6,
			'3.8 velocityFromSamples clamps its own result (' + fast.linvel.length().toFixed(2) + ' m/s)'
		);
	}

	// ---- 4. accepted input shapes --------------------------------------------
	console.log('\n=== 4. wire shapes ===');
	{
		const fromArray = clampThrow([1, 2, 3], [4, 5, 6]);
		const fromObject = clampThrow({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 });
		check(
			fromArray.linvel.equals(fromObject.linvel) && fromArray.angvel.equals(fromObject.angvel),
			'4.1 a plain [x,y,z] (the `throw` message shape) and {x,y,z} agree'
		);
		const missing = clampThrow(undefined, undefined);
		check(missing.linvel.length() === 0, '4.2 undefined is zero, not NaN');
	}

	// ---- 5. the real caller ---------------------------------------------------
	// The regression guard for Scene.svelte's gizmo release: a body held through a
	// rotation that crosses +-PI used to come back with an angular velocity of the
	// WRONG SIGN and a magnitude only the (per-component) clamp kept finite.
	console.log('\n=== 5. in-browser: a held body released after a spin through the wrap ===');

	const browser = await h.launch();
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');

	const uuid = await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		box.position.set(0, 3, 0);
		// start it just under +PI about Y, so the drag below crosses the wrap
		box.rotation.set(0, Math.PI - 0.25, 0);
		box.userData.physics = { mode: 'dynamic', mass: 1 };
		window.__stores.objectsGroup.update((v) => v);
		return box.uuid;
	});
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)())),
		(v) => v === true,
		'5.1 (premise) the simulation is running'
	);

	const held = await A.page.evaluate((uuid) => window.__stores.physics.holdBody(uuid), uuid);
	check(held === true, '5.2 (premise) the box is held as a kinematic body');

	// Spin +0.075 rad per write, 8 writes 10 ms apart, starting at PI-0.3 — so the
	// +-PI crossing lands in the MIDDLE of the burst. That placement is the point:
	// samples are taken once per frame and the ring keeps only the last four, so a
	// slower spin would leave the whole ring on one side of the wrap and the guard
	// would pass with the old formula still in.
	//
	// The whole Euler is written, not just `.y`: the box fell and tumbled before
	// the hold, and setting one component on top of a tilted x/z turns it about a
	// TILTED axis whose projection onto world Y is small and can even be negative.
	// That is a property of the fixture, not of the estimator.
	for (let i = 1; i <= 16; i++) {
		await A.page.evaluate(
			([uuid, angle]) => {
				let group = null;
				window.__stores.objectsGroup.subscribe((v) => (group = v))();
				group.getObjectByProperty('uuid', uuid).rotation.set(0, angle, 0);
			},
			[uuid, Math.PI - 0.3 + i * 0.0375]
		);
		await A.page.waitForTimeout(25);
	}

	const after = await A.page.evaluate((uuid) => {
		window.__stores.physics.releaseBody(uuid);
		return window.__stores.physics.physicsDebug().find((b) => b.uuid === uuid);
	}, uuid);

	check(after?.hold === null, '5.3 the release put the body back to dynamic');
	const wy = after?.angvel?.y ?? 0;
	const mag = Math.hypot(after?.angvel?.x ?? 0, wy, after?.angvel?.z ?? 0);
	check(wy > 0.05, '5.4 the spin comes back POSITIVE about +Y across the wrap (' + wy.toFixed(2) + ' rad/s)');
	check(mag < 20 - 1e-6, '5.5 ...and well under the ceiling, not a clamped spike (|w| = ' + mag.toFixed(2) + ')');

	await A.page.evaluate(() => window.__stores.physics.stopSimulation());
	await h.finish(browser);
});
