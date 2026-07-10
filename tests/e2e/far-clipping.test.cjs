// Phase 60: large scenes stop clipping — camera far grows with the scene, fog reach too.
const h = require('./helpers.cjs');

const camFar = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.editorCam.subscribe((c) => r(c?.far))()));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// baseline far raised
	h.check((await camFar(A.page)) >= 5000, `baseline far >= 5000 (${await camFar(A.page)})`);

	// a far-away object grows the far plane (2.5s bounds sweep, forced once)
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		group.children[0].position.set(60000, 0, 0);
		window.__stores.sceneBounds.refreshSceneBounds();
	});
	await h.eventually(() => camFar(A.page), (far) => far >= 200000, 'far grows to fit a huge scene', 8000);

	// fog reach follows the bounds (daylight preset has far=220 normally)
	await A.page.evaluate(() => window.__stores.environment.setEnvironment('daylight'));
	await A.page.waitForTimeout(400);
	const fogFar = await A.page.evaluate(
		() => new Promise((r) => window.__stores.globalScene.subscribe((s) => r(s?.fog?.far ?? null))())
	);
	h.check(fogFar !== null && fogFar > 100000, `fog reach scales with the scene (${fogFar})`);

	// radius helper reports something sensible
	const radius = await A.page.evaluate(() => window.__stores.sceneBounds.sceneRadius());
	h.check(radius > 50000, `scene radius measured (${Math.round(radius)})`);

	await h.finish(browser);
});
