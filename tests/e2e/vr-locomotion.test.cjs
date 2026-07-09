// Phase 52: VR locomotion math (headless — no XR session): the agreed map's
// pure helper behaves per spec; flying toggle persists. On-device feel is a
// manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const run = (input) =>
		A.page.evaluate((input) => window.__stores.vrControls.computeMoveOffset(input), input);

	const base = {
		grip: false,
		flying: false,
		aimDir: { x: 0, y: -0.7, z: -0.7 },
		cameraDir: { x: 0, y: 0, z: -1 },
		speed: 0.05
	};

	// stick forward (y = -1), grounded: move along -z (offset.z positive per the
	// reference-space convention), no vertical component
	let o = await run({ ...base, x: 0, y: -1 });
	h.check(o.z > 0.04 && o.y === 0 && Math.abs(o.x) < 1e-9, `grounded forward is level (${JSON.stringify(o)})`);

	// flying: same input gains a vertical component along the aim
	o = await run({ ...base, x: 0, y: -1, flying: true });
	h.check(o.y > 0.02 && o.z > 0.02, `flying follows the aim pitch (${JSON.stringify(o)})`);

	// grip: stick becomes pan/elevate — y moves vertically, no forward motion
	o = await run({ ...base, x: 0, y: 1, grip: true });
	h.check(o.y > 0.05 && o.z === 0, `grip+stick elevates (${JSON.stringify(o)})`);
	o = await run({ ...base, x: 1, y: 0, grip: true });
	h.check(Math.abs(o.x) > 0.05 && o.y === 0, `grip+stick pans sideways (${JSON.stringify(o)})`);

	// strafe stays horizontal even when flying
	o = await run({ ...base, x: 1, y: 0, flying: true });
	h.check(o.y === 0 && Math.abs(o.x) > 0.03, `strafe stays level (${JSON.stringify(o)})`);

	// deadzone
	o = await run({ ...base, x: 0.05, y: -0.05 });
	h.check(o.x === 0 && o.y === 0 && o.z === 0, 'deadzone filters drift');

	// flying toggle persists via settings store
	await A.page.evaluate(() => {
		window.__stores.vrFlying.set(true);
		localStorage.setItem('vrFlying', 'true');
	});
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForTimeout(4000);
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.vrFlying, { timeout: 30000 });
	const flying = await A.page.evaluate(
		() => new Promise((r) => window.__stores.vrFlying.subscribe(r)())
	);
	h.check(flying === true, 'VR flying setting persists');

	await h.finish(browser);
});
