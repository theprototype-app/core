// 72 LK2 — ULTRAHDR SKIES, IN SIZES:
//   1. Auto on a desktop: the small file first (the light, and the sky until the larger lands), then
//      the 2K file swaps in as a cube a quarter of its width; the light never changes at the swap
//   2. the 2K sky is the same picture as the light's sky (mean pixel difference: a flipped or mirrored
//      cube is far off), and the UltraHDR light lights a box like the .hdr it replaces
//   3. Configure scene ▸ Sky quality: Max / Standard; only one cube stays; a blurred sky uses none
//   4. the player's pick overrides Auto; a scene's pick and a device pinned Low outrank it
//   5. two peers: the scene's settings replicate, each machine resolves its own size
//   6. N6 folded + unfolded: Auto stays on the small file, a scene's minimum raises it
//   7. Quest (IWER): Auto in the headset is a 1K cube, a scene's Max is capped at 2K
//   8. the files are not there (an old CDN ref): the .hdr still lights the scene, nothing errors
// Run: APP_URL=https://theprototype.app:5612/ SKIES_DIR=../packs-lane-72-skies/hdri npm run e2e -- sky-quality
const sharp = require('sharp');
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const GET = `(s) => { let v; s.subscribe((x) => (v = x))(); return v; }`;
const status = (page) => page.evaluate(`(${GET})(window.__stores.hdriStores.hdriStatus)`);
const debug = (page) =>
	page.evaluate(() => {
		const d = window.__stores.hdri.hdriDebug;
		let scene;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		return { cubes: d.skyCubes(), screen: d.skyOnScreen(), bg: scene.background?.name ?? null, env: scene.environment?.name ?? null, envUuid: scene.environment?.uuid ?? null };
	});
const pick = (page, key) => page.evaluate((k) => window.__stores.environment.setEnvironment(k), key);
const edit = (page, patch) => page.evaluate((p) => window.__stores.environment.editEnvSky({ hdri: p }), patch);
const skyIs = (page, sky, width, label, ms = 30000) =>
	h.eventually(() => status(page), (s) => s.state === 'ready' && s.sky === sky && s.skyWidth === width, label, ms);
const lightUp = (page, src) => h.eventually(() => status(page), (s) => s.state === 'ready' && s.src === src, src + ' is lit', 30000);

/** the camera from `from` looking at `to` (the orbit controls hold the pose, or the next frame undoes it) */
const aim = (page, from, to) =>
	page.evaluate(
		`((from, to) => {
			const get = ${GET};
			const st = window.__stores;
			const camera = get(st.globalCamera);
			const orbit = get(st.orbitControls);
			camera.position.set(...from);
			orbit?.target?.set(...to);
			camera.lookAt(...to);
			orbit?.update?.();
			camera.updateMatrixWorld(true);
		})(${JSON.stringify(from)}, ${JSON.stringify(to)})`
	);
/** the frame's middle (no chrome), as a small RGB grid */
async function pixels(page) {
	await page.waitForTimeout(1200);
	const png = await page.screenshot({ clip: { x: 340, y: 180, width: 600, height: 360 } });
	return sharp(png).removeAlpha().resize(60, 36, { fit: 'fill' }).raw().toBuffer();
}
/** toward the low sun, where the picture has the most in it */
async function skyPixels(page) {
	const sun = await page.evaluate(`(${GET})(window.__stores.globalScene).getObjectByName('env-rig-sun').position.clone().normalize().toArray()`);
	await aim(page, [0, 1.6, 0], [sun[0] * 10, 1.6 + sun[1] * 10, sun[2] * 10]);
	return pixels(page);
}
/** a white box, so only the light differs between two pages */
async function litBox(page) {
	await page.evaluate(`(() => {
		const g = (${GET})(window.__stores.objectsGroup);
		for (const o of g.children) o.material?.color?.set?.('#ffffff');
	})()`);
	await aim(page, [2.2, 1.6, 2.2], [0, 0.3, 0]);
	return pixels(page);
}
const meanDiff = (a, b) => {
	let d = 0;
	for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
	return d / a.length;
};

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const opts = { context: { viewport: { width: 1280, height: 720 } } };
	const A = await h.setupPage(browser, 'A', opts);
	const skies = await h.routeSkies(A.page);
	const box = (page) => page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await box(A.page);

	// ---- 1. small first, then swap ------------------------------------------------------------
	await pick(A.page, 'sunrise');
	await lightUp(A.page, 'bundled:sunrise');
	const lit = await debug(A.page);
	await skyIs(A.page, '2k', 2048, 'Auto on a desktop: the 2K sky lands');
	h.check(/spruit_sunrise_1k\.jpg$/.test(skies.hits[0] ?? '') && /spruit_sunrise_2k\.jpg$/.test(skies.hits[1] ?? '') && skies.count() === 2, `the small file first, then the 2K (${skies.hits.map((u) => u.split('/').pop()).join(', ')})`);
	let d = await debug(A.page);
	h.check(d.bg === 'hdri:bundled:sunrise|sky-2k' && d.env === 'hdri:bundled:sunrise|full', `the cube is the sky, the PMREM is the light (${d.bg} / ${d.env})`);
	h.check(d.envUuid === lit.envUuid, 'the light did not change at the swap');
	h.check(d.cubes.length === 1 && d.cubes[0].face === 512, `one cube, a quarter of the file's width (${JSON.stringify(d.cubes)})`);

	// ---- 2. the same picture ------------------------------------------------------------------
	const big = await skyPixels(A.page);
	await edit(A.page, { quality: 'standard' });
	await skyIs(A.page, '', 0, 'Standard: the light map draws the sky');
	const small = await skyPixels(A.page);
	const same = meanDiff(big, small);
	h.check(same < 10, `the 2K cube and the light's sky are one picture (mean diff ${same.toFixed(1)}/255)`);
	const turned = await (async () => {
		await edit(A.page, { rotation: 180 });
		// the rig sun turns with the sky: hold the camera where it was
		const px = await pixels(A.page);
		await edit(A.page, { rotation: 0 });
		return meanDiff(small, px);
	})();
	h.check(turned > 15 && turned > same * 3, `counterfactual: the sky turned 180° is plainly another picture (${turned.toFixed(1)} vs ${same.toFixed(1)})`);
	const jpgLit = await litBox(A.page);

	// ---- 3. Configure scene ▸ Sky quality ------------------------------------------------------
	await edit(A.page, { quality: 'max' });
	await skyIs(A.page, '4k', 4096, 'Max: 4K on a sky without an 8K file');
	d = await debug(A.page);
	h.check(d.cubes.filter((c) => c.ready).length === 1 && d.cubes[0].key.endsWith('4k'), `only one cube stays (${JSON.stringify(d.cubes)})`);
	await edit(A.page, { blur: 0.2 });
	await skyIs(A.page, '', 0, 'a blurred sky has no use for a cube');
	d = await debug(A.page);
	h.check(d.cubes.length === 0 && d.bg === d.env, `blur: the PMREM draws it, the cube left the GPU (${d.bg})`);
	await edit(A.page, { blur: 0 });
	await skyIs(A.page, '4k', 4096, 'blur off: back to the 4K (from the cache)');
	const fetches = skies.count();
	h.check(fetches === 3, `the 4K was downloaded once (${fetches} sky requests)`);

	// ---- 4. the player -----------------------------------------------------------------------
	await edit(A.page, { quality: 'auto' });
	await skyIs(A.page, '2k', 2048, 'back on Auto: 2K');
	await A.page.evaluate(() => window.__stores.gameSettings.setGameSetting('skyQuality', 'max'));
	await skyIs(A.page, '4k', 4096, "the game's options: Max overrides Auto");
	await edit(A.page, { quality: 'high' });
	await skyIs(A.page, '2k', 2048, 'a scene that names its quality outranks the player');
	await A.page.evaluate(() => window.__stores.hdriPrefs.hdriQuality.set('low'));
	await h.eventually(() => status(A.page), (s) => s.state === 'ready' && s.tier === 'low' && s.sky === '' && s.skyWidth === 0, 'a device pinned Low outranks the scene');
	await A.page.evaluate(() => {
		window.__stores.hdriPrefs.hdriQuality.set('auto');
		window.__stores.gameSettings.setGameSetting('skyQuality', 'auto');
	});
	// the row is drawn, in the real menu
	await A.page.evaluate(() => {
		const shell = window.__stores.gameKit.gameShell;
		window.__stores.editorMode.set('interact'); // the menu is offered while playing
		shell.markShellGame(true);
		shell.openShellMenu('settings');
	});
	await h.eventually(() => A.page.locator('[data-shell-setting="skyQuality"]').count(), (n) => n === 1, "the game's options draw a Sky quality row", 8000);
	// Auto -> Standard -> High -> Max, pressing Next the way a player does
	for (let i = 0; i < 3; i++) await A.page.locator('[data-shell-setting="skyQuality"] button[aria-label="Next Sky quality"]').click();
	h.check(/Max/.test(await A.page.locator('[data-shell-setting="skyQuality"] .gs-choice-value').innerText()), 'the row reads Max');
	await skyIs(A.page, '2k', 2048, 'pressing Max changes nothing while the scene names High');
	await edit(A.page, { quality: 'auto' });
	await skyIs(A.page, '4k', 4096, 'on Auto, the Max pressed in the menu applies');
	await A.page.evaluate(() => {
		const shell = window.__stores.gameKit.gameShell;
		window.__stores.gameSettings.setGameSetting('skyQuality', 'auto');
		shell.closeShellMenu();
		shell.markShellGame(false);
		window.__stores.editorMode.set('edit');
	});

	// ---- 5. two peers ------------------------------------------------------------------------
	const P = await h.setupPage(browser, 'P', { context: { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.6 } });
	await h.routeSkies(P.page);
	await h.connect(A, P);
	await edit(A.page, { quality: 'auto', minQuality: 'standard' });
	await pick(A.page, 'meadow');
	await lightUp(P.page, 'bundled:meadow');
	await skyIs(A.page, '2k', 2048, 'the desktop peer: Meadow at 2K');
	await skyIs(P.page, '', 0, 'N6 folded, same session: Auto stays on the small file');

	// ---- 6. a scene's minimum, phone in both postures -----------------------------------------
	await edit(A.page, { minQuality: 'high' });
	await h.eventually(() => P.page.evaluate(() => window.__stores.environment.presetPayload().hdri?.minQuality), (m) => m === 'high', 'the minimum replicates');
	await skyIs(P.page, '2k', 2048, "N6 folded: the scene's minimum raises it");
	await P.page.setViewportSize({ width: 1080, height: 1200 });
	await P.page.waitForTimeout(500);
	const unfolded = await status(P.page);
	h.check(unfolded.sky === '2k' && unfolded.skyWidth === 2048, 'N6 unfolded: the same sky, nothing reloads');
	const shot = await P.page.evaluate(`(${GET})(window.__stores.globalRenderer).domElement.getBoundingClientRect().width`);
	h.check(shot > 900, `N6 unfolded: the view fills the screen (${Math.round(shot)})`);
	await edit(A.page, { minQuality: 'standard', quality: 'auto' });
	await P.page.close();

	// ---- 7. the .hdr fallback ----------------------------------------------------------------
	const O = await h.setupPage(browser, 'O', opts);
	const oldCdn = await h.routeSkies(O.page);
	const hits = [];
	// registered last, so it answers first
	await O.page.route(/\/hdri\/[^/?#]+\.jpg(\?.*)?$/, (route) => {
		hits.push(route.request().url());
		return route.fulfill({ status: 404, body: '' });
	});
	const errors = [];
	O.page.on('pageerror', (e) => errors.push(String(e)));
	await pick(O.page, 'sunrise');
	await lightUp(O.page, 'bundled:sunrise');
	await O.page.waitForTimeout(1500);
	const od = await debug(O.page);
	h.check(hits.length >= 2 && oldCdn.hits.some((u) => /_1k\.hdr$/.test(u)), `it tried the new files, then the .hdr (${hits.length} misses)`);
	h.check(od.bg === od.env && errors.length === 0, `the light's map draws the sky and nothing errors (${od.bg}, ${errors.length})`);
	await box(O.page);
	await O.page.evaluate(() => window.__stores.hdriPrefs.hdriQuality.set('standard'));
	await O.page.waitForTimeout(500);
	const hdrLit = await litBox(O.page);
	const lightDiff = meanDiff(jpgLit, hdrLit);
	h.check(lightDiff < 6, `the UltraHDR light lights a box as the .hdr does (mean diff ${lightDiff.toFixed(1)}/255)`);
	await O.page.close();
	await A.page.close();

	// ---- 8. the Quest --------------------------------------------------------------------------
	const Q = await h.setupPage(browser, 'Q', { ...opts, init: iwer.initScript() });
	await h.routeSkies(Q.page);
	await pick(Q.page, 'sunrise');
	await lightUp(Q.page, 'bundled:sunrise');
	await iwer.enter(Q.page);
	await h.eventually(() => status(Q.page), (s) => s.state === 'ready' && s.tier === 'low' && s.sky === '1k' && s.skyWidth === 1024, 'in the headset: a small light, a 1K sky cube', 30000);
	d = await debug(Q.page);
	h.check(d.cubes.some((c) => c.ready && c.face === 256), `the cube is 256 per face, 3 MB of GPU (${JSON.stringify(d.cubes)})`);
	await iwer.frames(Q.page, 5);
	await edit(Q.page, { quality: 'max' });
	await skyIs(Q.page, '2k', 2048, "a scene's Max is capped at 2K in a headset");
	await iwer.frames(Q.page, 5);
	const presenting = await Q.page.evaluate(`(${GET})(window.__stores.globalRenderer).xr.isPresenting`);
	h.check(presenting === true, 'still presenting after the sky swapped inside the session');
	await iwer.exit(Q.page);
	// IWER is a Quest browser (its user agent): outside a session it is still a headset, so the cap holds
	const outside = await status(Q.page);
	h.check(outside.sky === '2k' && !(await Q.page.evaluate(`(${GET})(window.__stores.globalRenderer).xr.isPresenting`)), `out of the session, a Quest browser stays at 2K (${outside.sky})`);
	await h.finish(browser);
});
