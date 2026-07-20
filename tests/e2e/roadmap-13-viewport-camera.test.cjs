// Roadmap #13 Batch B — viewport & camera.
//   B3  default camera FOV is 40° (was an extreme-telephoto 15°); the Configure
//       Scene "Camera lens" presets set the matching vertical FOV.
// B1 (grid fade scales with camera distance) and B2 (N8AO half-size ghost on HiDPI)
// are verified visually (before/after screenshots at devicePixelRatio 2) — not
// asserted here.
const h = require('./helpers.cjs');

const fovOf = (peer) =>
	peer.page.evaluate(
		() => new Promise((r) => window.__stores.globalCamera.subscribe((c) => r(c ? Math.round(c.fov) : null))())
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- B3: default FOV ------------------------------------------------------
	h.check((await fovOf(A)) === 40, 'B3: default camera FOV is 40 degrees');

	// --- B3: lens presets in Configure Scene ---------------------------------
	await A.page.evaluate(() => {
		window.__stores.inspectorKind.set('scene');
		window.__stores.inspectorClose.set(false);
	});
	await A.page.waitForTimeout(400);
	h.check(await A.page.locator('#lens-presets').first().isVisible(), 'B3: lens presets row renders in Configure Scene');

	await A.page.locator('#lens-presets button', { hasText: 'Natural' }).click();
	await A.page.waitForTimeout(200);
	h.check((await fovOf(A)) === 27, 'B3: "Natural" preset sets ~50mm (27 deg vertical FOV)');

	await A.page.locator('#lens-presets button', { hasText: 'Wide' }).click();
	await A.page.waitForTimeout(200);
	h.check((await fovOf(A)) === 53, 'B3: "Wide" preset sets ~24mm (53 deg vertical FOV)');

	await A.page.locator('#lens-presets button', { hasText: 'Portrait' }).click();
	await A.page.waitForTimeout(200);
	h.check((await fovOf(A)) === 16, 'B3: "Portrait" preset sets ~85mm (16 deg vertical FOV)');

	await h.finish(browser);
});
