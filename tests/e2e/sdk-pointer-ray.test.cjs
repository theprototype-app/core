// SDK api.pointerRay (190): a world-space Raycaster for wherever the user
// points — desktop mouse over the viewport (VR = the pointer hand, headless
// untestable). Fresh instance per call; null before the first pointer event.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// centre of the screen -> the ray should march into the scene
	await A.page.mouse.move(640, 400);
	await A.page.waitForTimeout(200);
	const centre = await A.page.evaluate(() => {
		const ray = window.__stores.moduleSDK.pointerRayNow();
		if (!ray) return null;
		return { origin: ray.ray.origin.toArray(), direction: ray.ray.direction.toArray() };
	});
	h.check(!!centre, 'pointerRay returns a raycaster after a pointer move');
	h.check(Math.abs(Math.hypot(...(centre?.direction ?? [0, 0, 0])) - 1) < 1e-6, 'direction is normalized');

	// the ray tracks the pointer: two screen points give diverging directions
	await A.page.mouse.move(200, 300);
	await A.page.waitForTimeout(100);
	const left = await A.page.evaluate(() => window.__stores.moduleSDK.pointerRayNow()?.ray.direction.toArray());
	await A.page.mouse.move(1080, 500);
	await A.page.waitForTimeout(100);
	const right = await A.page.evaluate(() => window.__stores.moduleSDK.pointerRayNow()?.ray.direction.toArray());
	const dot = left && right ? left[0] * right[0] + left[1] * right[1] + left[2] * right[2] : 1;
	h.check(dot < 0.9999, 'the ray follows the pointer (directions differ across the screen)');

	// a fresh instance every call (safe for modules to keep)
	const distinct = await A.page.evaluate(() => {
		const a = window.__stores.moduleSDK.pointerRayNow();
		const b = window.__stores.moduleSDK.pointerRayNow();
		return a !== b;
	});
	h.check(distinct, 'each call returns a fresh Raycaster (no shared-temp corruption)');

	await h.finish(browser);
});
