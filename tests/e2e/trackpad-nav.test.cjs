// QW (launch polish): trackpad navigation + page-zoom guards. Two-finger trackpad
// swipes (fine pixel deltas / any deltaX) PAN the orbit camera; classic mouse
// wheels keep zooming through OrbitControls; pinch (ctrlKey wheel) never zooms the
// PAGE — over UI it's swallowed unless the accessibility toggle re-allows it.
// Synthetic WheelEvents drive the real window-capture handler in trackpadNav.js.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const read = () =>
		A.page.evaluate(() => {
			let cam; window.__stores.globalCamera.subscribe((v) => (cam = v))();
			let ctl; window.__stores.orbitControls.subscribe((v) => (ctl = v))();
			return {
				target: ctl.target.toArray(),
				distance: cam.position.distanceTo(ctl.target),
				touchAction: document.body.style.touchAction
			};
		});

	/** dispatch a wheel on the viewport canvas; returns defaultPrevented */
	const wheelCanvas = (init) =>
		A.page.evaluate((opts) => {
			let renderer; window.__stores.globalRenderer.subscribe((v) => (renderer = v))();
			const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode: 0, ...opts });
			renderer.domElement.dispatchEvent(e);
			return e.defaultPrevented;
		}, init);

	/** dispatch a wheel on a UI element (the logo area); returns defaultPrevented */
	const wheelUi = (init) =>
		A.page.evaluate((opts) => {
			const el = document.querySelector('input[placeholder="Enter peer ID to connect"]') || document.body;
			const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode: 0, ...opts });
			el.dispatchEvent(e);
			return e.defaultPrevented;
		}, init);

	// --- mobile/page guard: chrome refuses browser pinch-zoom by default
	let s = await read();
	h.check(s.touchAction === 'pan-x pan-y', 'body touch-action blocks page pinch-zoom by default');

	// --- trackpad-like swipe over the canvas PANS (target moves, distance holds)
	const before = await read();
	for (let i = 0; i < 5; i++) await wheelCanvas({ deltaX: 12, deltaY: 8.5 });
	await A.page.waitForTimeout(200);
	s = await read();
	const targetMoved = Math.hypot(
		s.target[0] - before.target[0], s.target[1] - before.target[1], s.target[2] - before.target[2]);
	h.check(targetMoved > 0.01, `trackpad swipe pans the camera (target moved ${targetMoved.toFixed(3)})`);
	h.check(Math.abs(s.distance - before.distance) < 0.05, 'panning keeps the orbit distance (no zoom)');

	// --- reverse toggle flips the pan direction (compare x-delta signs)
	const beforeDir = await read();
	await wheelCanvas({ deltaX: 40, deltaY: 0 });
	await A.page.waitForTimeout(150);
	const afterDefault = await read();
	const dxDefault = afterDefault.target[0] - beforeDir.target[0];
	await A.page.evaluate(() => window.__stores.trackpadNav.reversePan.set(true));
	await wheelCanvas({ deltaX: 40, deltaY: 0 });
	await A.page.waitForTimeout(150);
	const afterReversed = await read();
	const dxReversed = afterReversed.target[0] - afterDefault.target[0];
	h.check(
		dxDefault !== 0 && dxReversed !== 0 && Math.sign(dxDefault) !== Math.sign(dxReversed),
		`reverse toggle flips pan direction (${dxDefault.toFixed(3)} vs ${dxReversed.toFixed(3)})`
	);
	await A.page.evaluate(() => window.__stores.trackpadNav.reversePan.set(false));

	// --- classic mouse wheel still ZOOMS (distance changes, target holds)
	const preZoom = await read();
	for (let i = 0; i < 3; i++) await wheelCanvas({ deltaY: 120 });
	await A.page.waitForTimeout(300);
	s = await read();
	h.check(Math.abs(s.distance - preZoom.distance) > 0.05, `mouse wheel still zooms (distance ${preZoom.distance.toFixed(2)} -> ${s.distance.toFixed(2)})`);
	const zoomTargetMoved = Math.hypot(
		s.target[0] - preZoom.target[0], s.target[1] - preZoom.target[1], s.target[2] - preZoom.target[2]);
	h.check(zoomTargetMoved < 0.01, 'zooming does not move the target');

	// --- pinch (ctrl+wheel) over UI: page zoom swallowed
	h.check(await wheelUi({ deltaY: -40, ctrlKey: true }), 'pinch over UI is prevented (no page zoom)');

	// --- mode off: swipes stop panning
	await A.page.evaluate(() => window.__stores.trackpadNav.trackpadMode.set('off'));
	const preOff = await read();
	await wheelCanvas({ deltaX: 12, deltaY: 8.5 });
	await A.page.waitForTimeout(150);
	s = await read();
	const offMoved = Math.hypot(
		s.target[0] - preOff.target[0], s.target[1] - preOff.target[1], s.target[2] - preOff.target[2]);
	h.check(offMoved < 0.001, 'mode Off: swipes no longer pan');
	await A.page.evaluate(() => window.__stores.trackpadNav.trackpadMode.set('auto'));

	// --- accessibility escape hatch: browser zoom allowed again
	await A.page.evaluate(() => window.__stores.trackpadNav.allowBrowserZoom.set(true));
	await A.page.waitForTimeout(100);
	h.check(!(await wheelUi({ deltaY: -40, ctrlKey: true })), 'allowBrowserZoom: pinch over UI is NOT prevented');
	s = await read();
	h.check(s.touchAction === '', 'allowBrowserZoom clears the body touch-action guard');
	await A.page.evaluate(() => window.__stores.trackpadNav.allowBrowserZoom.set(false));

	await h.finish(browser);
});
