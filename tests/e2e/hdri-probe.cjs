// 37-hdri — evidence probe (not a suite): pick each HDRI preset, screenshot the viewport.
//   APP_URL=https://theprototype.app:5356/ node tests/e2e/hdri-probe.cjs [preset ...]
const h = require('./helpers.cjs');
const OUT = process.env.HDRI_OUT || '/home/deck/.code/lanes-30/after-37/37-hdri';
h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	// a few lit objects to read the IBL on
	await page.evaluate(() => {
		const c = window.__stores.commandsHandler;
		c.sceneCommand('/create box');
		c.sceneCommand('/create sphere');
	});
	await page.waitForTimeout(1500);
	const made = await page.evaluate(() => {
		const g = window.__stores.objectsGroup;
		let group;
		g.subscribe((v) => (group = v))();
		const kids = group.children.filter((o) => o.isMesh);
		kids.forEach((m, i) => {
			m.position.set(i * 2 - 1, 0.6, 0);
			if (m.material) {
				m.material.metalness = i === 1 ? 1 : 0;
				m.material.roughness = i === 1 ? 0.15 : 0.6;
				m.material.color?.set(i === 1 ? '#ffffff' : '#c8c8c8');
			}
		});
		window.__stores.selectedObjects.set([]);
		let tc;
		window.__stores.TControls.subscribe((v) => (tc = v))();
		tc?.detach?.();
		// a low 3/4 view with the horizon in frame: the sky, the IBL on both objects, the sun's shadow
		let camera;
		let orbit;
		window.__stores.globalCamera.subscribe((v) => (camera = v))();
		window.__stores.orbitControls.subscribe((v) => (orbit = v))();
		camera.position.set(3.2, 1.6, 4.2);
		orbit?.target?.set(0, 0.8, 0);
		camera.lookAt(0, 0.8, 0);
		orbit?.update?.();
		camera.updateMatrixWorld(true);
		return kids.length;
	});
	console.log('objects', made);
	const presets = process.argv.slice(2).length ? process.argv.slice(2) : ['studio', 'meadow', 'clearsky', 'sunrise', 'starlight', 'photostudio'];
	for (const [i, key] of presets.entries()) {
		await page.evaluate((k) => window.__stores.environment.setEnvironment(k), key);
		const state = await page.evaluate(() => window.__stores.hdri.hdriDebug.settle());
		await page.waitForTimeout(800);
		const info = await page.evaluate(() => {
			let scene;
			window.__stores.globalScene.subscribe((s) => (scene = s))();
			let st;
			window.__stores.hdriStores.hdriStatus.subscribe((s) => (st = s))();
			return { status: st, env: scene.environment?.name ?? null, bg: scene.background?.name ?? scene.background?.constructor?.name, post: window.__postDebug?.() && { chain: window.__postDebug().chain, type: window.__postDebug().composerBufferType } };
		});
		console.log(key, state, JSON.stringify(info));
		await page.screenshot({ path: `${OUT}/${String(i + 1).padStart(2, '0')}-preset-${key}.png` });
	}
	console.log('errors', JSON.stringify(page.__errors));
	await browser.close();
});
