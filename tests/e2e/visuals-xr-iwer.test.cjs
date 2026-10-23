// 65 M2 + M6 — THE QUEST PROFILE: the shader background and the smoke layer in a headset, on IWER
// (48 G2: the app's own XR path, a Quest 3 emulated).
//   1. on the screen first: the background draws full screen at the high tier (octave cap 8), the
//      smoke is a look entry composited by the post stack
//   2. in the headset: the background becomes the big SPHERE at the LOW tier (octave cap 2 — the
//      budget fallback), the smoke becomes a world PANEL ahead of the viewer on the low grid
//      (64 / 256 / 8), under background-root (never a scene object)
//   3. the right controller's ray moves the background's pointer (aim left vs right)
//   4. sweeping a controller ray across the panel stirs it (splats + dye)
//   5. the Quest budget: once the governor caps particles, the headset gives up the smoke entirely
//      (panel hidden, nothing steps); the background stays (at low)
//   6. leaving the headset: the screen effect takes over again, the background back to full screen
// Run: APP_URL=https://localhost:5461/ node tests/e2e/visuals-xr-iwer.test.cjs
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.env.HOME, '.code/lanes-30/after-65/65-visuals');
const bg = (page) => page.evaluate(() => window.__stores.backgroundLayer.backgroundLayerDebug());
const fl = (page) => page.evaluate(() => window.__stores.fluidLayer.fluidLayerDebug());

h.run(async () => {
	fs.mkdirSync(EVIDENCE, { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	await h.answerRestore(A).catch(() => {});

	console.log('\n=== 1. on the screen ===');
	const applied = await page.evaluate(async () => {
		const s = window.__stores;
		s.qualityGovernor.setAutoQuality(false);
		s.qualityGovernor.governorForTest.reset();
		const r = await s.backgroundPresets.applyBackgroundPreset('soft-gradient');
		s.scenePost.setScenePostEnabled(true);
		s.scenePost.addPostEffect('fluid');
		return r;
	});
	h.check(applied.ok, '1.0 the built-in background applies: ' + JSON.stringify(applied));
	await h.eventually(() => bg(page), (s) => s.draw === 'screen' && s.compiled, 'bg compiled', 8000).catch(() => {});
	let b = await bg(page);
	h.check(b.draw === 'screen' && b.tier === 'high' && b.octaveCap === 8, '1.1 full screen at the high tier, octave cap 8: ' + JSON.stringify({ draw: b.draw, tier: b.tier, cap: b.octaveCap }));
	await h.eventually(() => fl(page), (s) => s.presenter === 'post', 'fluid post', 8000).catch(() => {});
	let f = await fl(page);
	h.check(f.presenter === 'post' && f.tier === 'high', '1.2 the smoke composites as a look entry at the high tier: ' + JSON.stringify({ presenter: f.presenter, tier: f.tier }));

	console.log('\n=== 2. in the headset ===');
	await iwer.enter(page);
	await iwer.pose(page, 'head', [0, 1.6, 0], { yaw: 0 });
	await iwer.frames(page, 20);
	await page.evaluate(() => window.__stores.qualityGovernor.governorForTest.reset());
	await iwer.frames(page, 20);
	b = await bg(page);
	h.check(b.draw === 'sphere' && b.visible.sphere && !b.visible.screen, '2.1 the background becomes the sphere around you (never a head-locked quad): ' + JSON.stringify({ draw: b.draw, visible: b.visible }));
	h.check(b.tier === 'low' && b.octaveCap === 2, '2.2 ...at the LOW tier, octave cap 2 (the Quest budget): ' + JSON.stringify({ tier: b.tier, cap: b.octaveCap }));
	f = await fl(page);
	h.check(f.presenter === 'panel' && f.panel?.visible && f.panel?.parent === 'background-root', '2.3 the smoke becomes a world panel under background-root: ' + JSON.stringify({ presenter: f.presenter, panel: f.panel }));
	h.check(f.tier === 'low' && f.simRes === 64 && f.dyeRes === 256 && f.iterations === 8, '2.4 ...on the low grid (64 / 256 / 8): ' + JSON.stringify({ tier: f.tier, simRes: f.simRes, dyeRes: f.dyeRes, it: f.iterations }));
	const s0 = f.steps;
	await iwer.frames(page, 20);
	f = await fl(page);
	h.check(f.steps > s0 + 10, '2.5 ...stepped by the XR frame loop (' + s0 + ' -> ' + f.steps + ')');

	console.log('\n=== 3. the controller moves the background pointer ===');
	const aim = async (yaw) => {
		await iwer.pose(page, 'right', [0.2, 1.4, -0.3], { yaw, pitch: 0.05 });
		await iwer.pose(page, 'left', [-0.2, 1.4, -0.3], { yaw, pitch: 0.05 });
		await iwer.frames(page, 40);
		return (await bg(page)).pointer;
	};
	const pl = await aim(0.6);
	const pr = await aim(-0.6);
	h.check(Math.abs(pl.x - pr.x) > 0.05, '3.1 aiming left vs right moves the pointer on the sphere (x ' + pl.x.toFixed(3) + ' vs ' + pr.x.toFixed(3) + ')');

	console.log('\n=== 4. a controller ray stirs the panel ===');
	await page.evaluate(() => window.__stores.fluidLayer.holdFluidAutoForTest(true));
	const splats0 = (await fl(page)).splats;
	const dye0 = await page.evaluate(() => window.__stores.fluidLayer.readFluidDyeForTest());
	for (let i = 0; i <= 20; i++) {
		const yaw = 0.35 - (0.7 * i) / 20;
		await iwer.pose(page, 'right', [0.2, 1.4, -0.3], { yaw, pitch: 0.05 });
		await iwer.frames(page, 2);
	}
	f = await fl(page);
	const dye1 = await page.evaluate(() => window.__stores.fluidLayer.readFluidDyeForTest());
	h.check(f.splats > splats0 + 10, '4.1 sweeping the ray across the panel splats (' + (f.splats - splats0) + ')');
	h.check(dye1 && dye0 && dye1.total > dye0.total + 2, '4.2 ...and puts dye in (' + dye0?.total.toFixed(1) + ' -> ' + dye1?.total.toFixed(1) + ')');
	await page.evaluate(() => window.__stores.fluidLayer.holdFluidAutoForTest(false));
	await page.screenshot({ path: path.join(EVIDENCE, 'xr-panel-mirror.png') }).catch(() => {});

	console.log('\n=== 5. the Quest budget fallback ===');
	await page.evaluate(() => window.__stores.qualityGovernor.governorForTest.setLevel(8, 1e9));
	await iwer.frames(page, 20);
	const s1 = (await fl(page)).steps;
	await iwer.frames(page, 20);
	f = await fl(page);
	h.check(f.presenter === 'none' && !f.panel?.visible && f.steps === s1, '5.1 particles capped in a headset: the smoke is given up (panel hidden, no steps): ' + JSON.stringify({ presenter: f.presenter, panel: f.panel, steps: [s1, f.steps] }));
	b = await bg(page);
	h.check(b.draw === 'sphere' && b.tier === 'low', '5.2 ...the background stays, at low: ' + JSON.stringify({ draw: b.draw, tier: b.tier }));
	await page.evaluate(() => window.__stores.qualityGovernor.governorForTest.reset());
	await iwer.frames(page, 20);
	f = await fl(page);
	h.check(f.presenter === 'panel' && f.panel?.visible, '5.3 full quality again: the panel is back: ' + f.presenter);

	console.log('\n=== 6. out of the headset ===');
	await iwer.exit(page);
	await page.waitForTimeout(800);
	b = await bg(page);
	h.check(b.draw === 'screen' && b.tier === 'high' && b.octaveCap === 8, '6.1 the background is full screen again, high tier: ' + JSON.stringify({ draw: b.draw, tier: b.tier, cap: b.octaveCap }));
	await h.eventually(() => fl(page), (s) => s.presenter === 'post', 'post again', 5000).catch(() => {});
	f = await fl(page);
	h.check(f.presenter === 'post' && !f.panel?.visible, '6.2 the screen effect takes the smoke back, the panel hides: ' + JSON.stringify({ presenter: f.presenter, panel: f.panel }));
	await h.finish(browser);
});
