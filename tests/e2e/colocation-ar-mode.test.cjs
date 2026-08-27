// CO4 — AR passthrough as a first-class mode. Headless has no XR device, so this
// suite drives the SIGNAL: `passthroughActive` is the one store everything keys
// off, and `sessionCompositesOverRoom` is the pure derivation Scene's
// session-start handler feeds it from (asserted here against fake sessions of
// every blend mode). The stand-down is asserted against the LIVE scene — sky and
// fog lifted, grid unmounted, the env-shadow-catcher KEPT (ShadowMaterial only
// darkens, which is what glues a virtual object to a real table), the sun rig
// still casting — and the restore is byte-exact through the ordinary
// applyEnvironment re-apply path (no hand-rolled second restore exists to test).
// CO2's ghost markers are asserted to take the AR palette live and give it back.

const h = require('./helpers.cjs');

/** run a body with `S` = the debug hook */
const ev = (page, fn, arg) =>
	page.evaluate(
		([body, a]) => new Function('S', 'arg', body)(window.__stores, a),
		[fn, arg ?? null]
	);

/** read the environment-facing scene state in one shot */
const envState = (page) =>
	ev(
		page,
		`
		let scene = null;
		S.globalScene.subscribe((v) => (scene = v))();
		let grid = null;
		scene.traverse((n) => { if (!grid && n.material?.uniforms?.cellSize) grid = n; });
		const catcher = scene.getObjectByName('env-shadow-catcher');
		const sun = scene.getObjectByName('env-rig-sun');
		return {
			background: scene.background ? '#' + scene.background.getHexString() : null,
			fog: scene.fog ? { color: '#' + scene.fog.color.getHexString(), near: scene.fog.near, far: scene.fog.far } : null,
			grid: !!grid,
			catcher: catcher ? { visible: catcher.visible, depthWrite: catcher.material.depthWrite, transparent: catcher.material.transparent, opacity: catcher.material.opacity, shadowMat: !!catcher.material.isShadowMaterial } : null,
			sun: sun ? { visible: sun.visible, castShadow: sun.castShadow } : null
		};
		`
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// ---------------------------------------------------------------- section 0
	console.log('\n=== 0. the seams exist (hook slots + the exported derivation) ===');
	const hook = await page.evaluate(() => ({
		derive: typeof window.__stores.sessionCompositesOverRoom,
		passthrough: typeof window.__stores.passthroughActive?.set,
		// neighbours of the colocation hook slots — the positional-destructure guard
		calibrate: typeof window.__stores.colocationCalibrate?.startCalibration,
		environment: typeof window.__stores.environment?.applyEnvironment
	}));
	h.check(hook.derive === 'function', '0.1 sessionCompositesOverRoom is exported from sceneStore');
	h.check(hook.passthrough === 'function', '0.2 passthroughActive is the writable signal');
	h.check(
		hook.calibrate === 'function' && hook.environment === 'function',
		'0.3 the neighbouring hook slots are intact (no positional shift)'
	);

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. the derivation: environmentBlendMode -> the signal ===');
	const derived = await ev(
		page,
		`
		const d = S.sessionCompositesOverRoom;
		return {
			alphaBlend: d({ environmentBlendMode: 'alpha-blend' }),
			additive: d({ environmentBlendMode: 'additive' }),
			opaque: d({ environmentBlendMode: 'opaque' }),
			none: d(null),
			undef: d(undefined)
		};
		`
	);
	h.check(derived.alphaBlend === true, "1.1 'alpha-blend' (camera passthrough) composites over the room");
	h.check(derived.additive === true, "1.2 'additive' (see-through glasses) composites over the room");
	h.check(derived.opaque === false, "1.3 'opaque' (ordinary VR) does NOT");
	h.check(derived.none === false && derived.undef === false, '1.4 no session at all reads false');

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. baseline: an environment WITH fog, sun, grid, catcher ===');
	await ev(page, `S.environment.setEnvironment('daylight');`);
	await page.waitForTimeout(300);
	const before = await envState(page);
	h.check(before.background === '#8db8dd', '2.1 daylight sky is up (' + before.background + ')');
	h.check(!!before.fog && before.fog.color === '#a9c8e4', '2.2 daylight fog is up');
	h.check(before.grid === true, '2.3 the grid renders in the editor');
	h.check(!!before.catcher && before.catcher.visible === true, '2.4 the shadow catcher is visible');
	h.check(
		!!before.catcher && before.catcher.shadowMat && before.catcher.transparent,
		'2.5 ...and it is a transparent ShadowMaterial (darkening-only — the AR-safe kind)'
	);
	h.check(!!before.sun && before.sun.visible && before.sun.castShadow, '2.6 the rig sun casts');

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. entering AR: the stand-down (sky, fog, grid) — catcher and sun stay ===');
	await ev(page, `S.passthroughActive.set(S.sessionCompositesOverRoom({ environmentBlendMode: 'alpha-blend' }));`);
	// applyEnvironment runs synchronously off the subscription; the grid unmount
	// is a svelte reactive tick — poll for it rather than sleeping
	await h.eventually(() => envState(page), (s) => s.grid === false, '3.0 grid unmounts');
	const during = await envState(page);
	h.check(during.background === null, '3.1 the sky is lifted — the room shows through');
	h.check(during.fog === null, '3.2 fog is OFF (fog over a real room reads as a broken camera)');
	h.check(during.grid === false, '3.3 the grid is OFF (no virtual ground in AR)');
	h.check(
		!!during.catcher && during.catcher.visible === true,
		'3.4 the shadow catcher SURVIVES passthrough (the CO4 flip — it used to be hidden here)'
	);
	h.check(!!during.sun && during.sun.visible && during.sun.castShadow, '3.5 the sun rig keeps casting in AR');

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. CO2 markers take the AR palette live, and give it back ===');
	const arMarkers = await ev(
		page,
		`
		S.colocationCalibrate.startCalibration({ roomKey: 'room-armode' });
		S.colocationCalibrate.samplePoint({ x: 1, y: 0.8, z: -2 });
		return S.colocationCalibrate.calibrateDebug().markers;
		`
	);
	const arPoint = arMarkers?.find((m) => m.name === 'colocate-point');
	const arArrow = arMarkers?.find((m) => m.name === 'colocate-aim');
	h.check(arPoint?.color === '9fe8ff', '4.1 the ghost point wears the AR palette (' + arPoint?.color + ')');
	h.check(arPoint?.opacity === 1, '4.2 ...at FULL opacity over the busy real room');
	h.check(arArrow?.color === '9fe8ff', '4.3 the aim arrow matches');

	// leave AR mid-ritual: the live markers restyle immediately, not on the next session
	const restyled = await ev(
		page,
		`
		S.passthroughActive.set(false);
		return S.colocationCalibrate.calibrateDebug().markers;
		`
	);
	const vrPoint = restyled?.find((m) => m.name === 'colocate-point');
	h.check(vrPoint?.color === '4da3ff', '4.4 leaving passthrough restores the ghost blue live');
	h.check(vrPoint?.opacity === 0.85, '4.5 ...and the ghost opacity');

	// and a session STARTED in AR builds AR-styled markers from the first frame
	const builtInAr = await ev(
		page,
		`
		S.colocationCalibrate.cancelCalibration();
		S.passthroughActive.set(true);
		S.colocationCalibrate.startCalibration({ roomKey: 'room-armode' });
		const markers = S.colocationCalibrate.calibrateDebug().markers;
		S.colocationCalibrate.cancelCalibration();
		return markers;
		`
	);
	h.check(
		builtInAr?.find((m) => m.name === 'colocate-point')?.color === '9fe8ff',
		'4.6 markers BUILT while in AR start on the AR palette'
	);

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. session end: everything restores through applyEnvironment ===');
	await ev(page, `S.passthroughActive.set(false);`);
	await h.eventually(() => envState(page), (s) => s.grid === true, '5.0 grid remounts');
	const after = await envState(page);
	h.check(after.background === before.background, '5.1 the sky restores byte-exact (' + after.background + ')');
	h.check(
		!!after.fog &&
			after.fog.color === before.fog.color &&
			after.fog.near === before.fog.near &&
			after.fog.far === before.fog.far,
		'5.2 the fog restores byte-exact'
	);
	h.check(after.grid === true, '5.3 the grid is back');
	h.check(!!after.catcher && after.catcher.visible === true, '5.4 the catcher stays per the normal rule');
	h.check(
		JSON.stringify(after) === JSON.stringify(before),
		'5.5 the WHOLE env-facing scene state round-trips (' +
			(JSON.stringify(after) === JSON.stringify(before) ? 'identical' : 'differs') +
			')'
	);

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. the entry affordance gates on real support ===');
	// headless chromium has no navigator.xr -> isSessionSupported never resolves
	// true -> the button must NOT render (the honest headless direction: the gate
	// itself is what is assertable without a device)
	const arButton = await page.evaluate(() => ({
		present: !!document.getElementById('ar-enter-button'),
		xr: typeof navigator.xr
	}));
	h.check(
		arButton.present === false,
		'6.1 no immersive-ar support -> no Enter AR button (navigator.xr is ' + arButton.xr + ')'
	);

	// restore the default environment for whoever reads the trailing state
	await ev(page, `S.environment.setEnvironment('studio');`);

	await h.finish(browser);
});
