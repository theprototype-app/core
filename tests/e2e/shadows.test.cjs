// V-1: shadows on by default — renderer shadow map enabled, the env sun casts,
// created meshes cast+receive, a shadow catcher lives under ENV_ROOT, and the
// 'off' quality disables the renderer shadow map. Single page (nothing new
// replicates: the flags are derived locally on every peer).
const h = require('./helpers.cjs');

const snapshot = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					window.__stores.globalRenderer.subscribe((renderer) => {
						const sun = scene?.getObjectByName('env-rig-sun');
						const catcher = scene?.getObjectByName('env-shadow-catcher');
						let box = null;
						scene?.traverse((o) => {
							if (o.name === 'Box' && o.isMesh) box = o;
						});
						resolve({
							shadowMapEnabled: !!renderer?.shadowMap?.enabled,
							sunCasts: !!sun?.castShadow,
							catcherPresent: !!catcher,
							catcherReceives: !!catcher?.receiveShadow,
							boxCasts: box ? box.castShadow : null,
							boxReceives: box ? box.receiveShadow : null
						});
					})();
				})();
			})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await A.page.waitForTimeout(500);

	let s = await snapshot(A.page);
	h.check(s.shadowMapEnabled === true, 'renderer shadow map enabled by default');
	h.check(s.sunCasts === true, 'env rig sun casts shadows');
	h.check(s.catcherPresent === true, 'shadow catcher present under the scene root');
	h.check(s.catcherReceives === true, 'shadow catcher receives shadows');
	h.check(s.boxCasts === true, 'created box casts shadows by default');
	h.check(s.boxReceives === true, 'created box receives shadows by default');

	// catcher lives at the scene root, never in the synced objects
	const inObjects = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r(g?.children.some((c) => c.name === 'env-shadow-catcher') ?? false)
				)()
			)
	);
	h.check(inObjects === false, 'catcher is not part of the replicated objects');

	// shadowQuality 'off' disables the renderer shadow map
	await A.page.evaluate(() => window.__stores.lightParams.shadowQuality.set('off'));
	await A.page.waitForTimeout(300);
	s = await snapshot(A.page);
	h.check(s.shadowMapEnabled === false, "shadowQuality 'off' disables the shadow map");
	h.check(s.catcherPresent === true && s.catcherReceives === true, 'catcher still exists when off');

	// back to high re-enables
	await A.page.evaluate(() => window.__stores.lightParams.shadowQuality.set('high'));
	await A.page.waitForTimeout(300);
	s = await snapshot(A.page);
	h.check(s.shadowMapEnabled === true, "shadowQuality back to 'high' re-enables the shadow map");

	await h.finish(browser);
});
