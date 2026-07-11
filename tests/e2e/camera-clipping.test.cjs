// Phase 123: camera clipping v2 — near/far are local, persisted view prefs
// applied live, and the far plane is PAIRED with the orbit maxDistance so
// zooming out can't fly past it and blank the scene.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- pure math ---
	const math = await A.page.evaluate(() => {
		const c = window.__stores.cameraClip;
		return {
			floor: c.effectiveFar(5000, 0), // small scene → the user floor
			grows: c.effectiveFar(5000, 2000), // radius*6 = 12000 wins
			capped: c.effectiveFar(1e9, 10), // clamped to the cap
			orbit: c.maxOrbitDistance(10000)
		};
	});
	h.check(math.floor === 5000, 'far honors the user floor for small scenes');
	h.check(math.grows === 12000, 'far grows to radius*6 for large scenes');
	h.check(math.capped === 200000, 'far clamps to the 200k cap');
	h.check(math.orbit === 9000, 'orbit maxDistance is 90% of the far plane');

	// --- setting near/far applies live + persists; far pairs with maxDistance ---
	const applied = await A.page.evaluate(() => {
		const c = window.__stores.cameraClip;
		c.setCameraNear(0.02);
		c.setCameraFar(8000);
		let cam, orbit;
		window.__stores.editorCam.subscribe((v) => (cam = v))();
		window.__stores.orbitControls.subscribe((v) => (orbit = v))();
		return {
			near: cam?.near,
			far: cam?.far,
			maxDistance: orbit?.maxDistance,
			storedNear: localStorage.getItem('cameraNear'),
			storedFar: localStorage.getItem('cameraFar')
		};
	});
	h.check(Math.abs(applied.near - 0.02) < 1e-9, `near clip applies live (${applied.near})`);
	h.check(applied.far === 8000, `far clip applies live (${applied.far})`);
	h.check(applied.maxDistance === 7200, `orbit maxDistance pairs with far (${applied.maxDistance})`);
	h.check(applied.storedNear === '0.02' && applied.storedFar === '8000', 'clip prefs persist to localStorage');

	// --- the pairing invariant: the camera can't dolly past the far plane ---
	const invariant = await A.page.evaluate(() => {
		let orbit, cam;
		window.__stores.orbitControls.subscribe((v) => (orbit = v))();
		window.__stores.editorCam.subscribe((v) => (cam = v))();
		return { safe: orbit.maxDistance < cam.far };
	});
	h.check(invariant.safe, 'max zoom distance stays inside the far plane (no blank-out)');

	// --- persists across reload ---
	await A.page.reload();
	await A.page.waitForFunction(() => !!window.__stores?.cameraClip, { timeout: 20000 });
	await A.page.waitForTimeout(500);
	const rehydrated = await A.page.evaluate(() => {
		let near, far;
		window.__stores.cameraClip.cameraNear.subscribe((v) => (near = v))();
		window.__stores.cameraClip.cameraFar.subscribe((v) => (far = v))();
		return { near, far };
	});
	h.check(Math.abs(rehydrated.near - 0.02) < 1e-9 && rehydrated.far === 8000, `clip prefs rehydrate on boot (${rehydrated.near}/${rehydrated.far})`);

	await h.finish(browser);
});
