// 36 A4 — TRACKPAD TWO-FINGER PAN + PINCH ZOOM IN THE EDITOR VIEWPORT, with synthetic events
// driving the real window/document handlers (trackpadNav.js + OrbitControls):
//   - a two-finger swipe (fractional, two-axis wheel deltas) PANS: the orbit target moves,
//     the distance does not
//   - a pinch as Chromium/Firefox deliver it (ctrlKey wheel) ZOOMS, both ways
//   - a classic mouse wheel notch (wheelDeltaY multiple of 120) still ZOOMS, as before
//   - a pinch as Safari delivers it (gesturestart/gesturechange with a cumulative scale)
//     zooms by the scale RATIO between events; over UI it only keeps the page-zoom guard
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	const read = () =>
		page.evaluate(() => {
			let cam; window.__stores.globalCamera.subscribe((v) => (cam = v))();
			let ctl; window.__stores.orbitControls.subscribe((v) => (ctl = v))();
			return { target: ctl.target.toArray(), distance: cam.position.distanceTo(ctl.target) };
		});
	const moved = (a, b) => Math.hypot(a.target[0] - b.target[0], a.target[1] - b.target[1], a.target[2] - b.target[2]);

	/** a stream of wheel events on the canvas, ~8 ms apart (a dense trackpad stream) */
	const wheels = (list) =>
		page.evaluate(async (items) => {
			let r; window.__stores.globalRenderer.subscribe((v) => (r = v))();
			for (const init of items) {
				const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode: 0, ...init });
				if (init.wheelDeltaY !== undefined) Object.defineProperty(e, 'wheelDeltaY', { value: init.wheelDeltaY });
				r.domElement.dispatchEvent(e);
				await new Promise((res) => setTimeout(res, 8));
			}
		}, list);
	/** a Safari gesture sequence on a target ('canvas' or a CSS selector) */
	const gesture = (where, scales) =>
		page.evaluate(async ([w, ss]) => {
			let r; window.__stores.globalRenderer.subscribe((v) => (r = v))();
			const target = w === 'canvas' ? r.domElement : document.querySelector(w);
			const fire = (type, scale) => {
				const e = new Event(type, { bubbles: true, cancelable: true });
				Object.defineProperty(e, 'scale', { value: scale });
				target.dispatchEvent(e);
				return e.defaultPrevented;
			};
			let prevented = fire('gesturestart', 1);
			for (const s of ss) {
				prevented = fire('gesturechange', s) && prevented;
				await new Promise((res) => setTimeout(res, 16));
			}
			fire('gestureend', ss[ss.length - 1]);
			return prevented;
		}, [where, scales]);
	const settle = () => page.waitForTimeout(400);

	await page.evaluate(() => window.__stores.trackpadNav.trackpadMode.set('auto'));
	await settle();

	// 1. two-finger pan
	let a = await read();
	await wheels(Array.from({ length: 10 }, () => ({ deltaX: 6.5, deltaY: 3.25 })));
	await settle();
	let b = await read();
	h.check(moved(a, b) > 0.05, `a two-finger swipe pans the view (target moved ${moved(a, b).toFixed(3)})`);
	h.check(Math.abs(b.distance - a.distance) < 0.02, `...without zooming (distance ${a.distance.toFixed(2)} -> ${b.distance.toFixed(2)})`);
	await page.waitForTimeout(400); // let the gesture window close

	// 2. ctrlKey wheel = pinch (Chromium / Firefox)
	a = await read();
	await wheels(Array.from({ length: 8 }, () => ({ deltaY: -4, ctrlKey: true })));
	await settle();
	b = await read();
	h.check(b.distance < a.distance - 0.05, `a pinch out (ctrl wheel, -deltaY) zooms IN (${a.distance.toFixed(2)} -> ${b.distance.toFixed(2)})`);
	a = b;
	await wheels(Array.from({ length: 8 }, () => ({ deltaY: 4, ctrlKey: true })));
	await settle();
	b = await read();
	h.check(b.distance > a.distance + 0.05, `a pinch in (ctrl wheel, +deltaY) zooms OUT (${a.distance.toFixed(2)} -> ${b.distance.toFixed(2)})`);
	await page.waitForTimeout(400);

	// 3. a classic mouse wheel notch still zooms, unpanned
	a = await read();
	await wheels([{ deltaY: 100, wheelDeltaY: -120 }]);
	await settle();
	b = await read();
	h.check(b.distance > a.distance + 0.05 && moved(a, b) < 0.01, `a mouse wheel notch keeps zooming (${a.distance.toFixed(2)} -> ${b.distance.toFixed(2)}, pan ${moved(a, b).toFixed(3)})`);
	await page.waitForTimeout(400);

	// 4. Safari's gesture events
	a = await read();
	const prevented = await gesture('canvas', [1.1, 1.25, 1.5]);
	await settle();
	b = await read();
	h.check(Math.abs(b.distance - a.distance / 1.5) < 0.05 * a.distance, `a Safari pinch to scale 1.5 zooms in by 1.5x (${a.distance.toFixed(2)} -> ${b.distance.toFixed(2)}, want ${(a.distance / 1.5).toFixed(2)})`);
	h.check(prevented, 'and the page itself never zooms (gesture events prevented)');
	h.check(moved(a, b) < 0.01, 'a pinch does not pan');
	a = b;
	await gesture('canvas', [0.9, 0.8]);
	await settle();
	b = await read();
	h.check(Math.abs(b.distance - a.distance / 0.8) < 0.05 * a.distance, `a Safari pinch in to 0.8 zooms out (${a.distance.toFixed(2)} -> ${b.distance.toFixed(2)})`);
	a = b;
	await gesture('body', [1.5, 2]);
	await settle();
	b = await read();
	h.check(Math.abs(b.distance - a.distance) < 0.01, 'a Safari pinch over UI (not the canvas) leaves the camera alone');
	await page.evaluate(() => window.__stores.trackpadNav.pinchZoomEnabled.set(false));
	a = await read();
	await gesture('canvas', [1.5]);
	await settle();
	b = await read();
	h.check(Math.abs(b.distance - a.distance) < 0.01, 'with "Pinch to zoom" off, a Safari pinch does nothing');
	await page.evaluate(() => window.__stores.trackpadNav.pinchZoomEnabled.set(true));

	await h.finish(browser);
});
