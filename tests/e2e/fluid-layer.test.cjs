// 65 M6 — THE SMOKE / INK FLUID LAYER (a scene-look entry) and PARTICLE FLOW FIELDS, on a screen.
//   1. adding the look entry: the shared sim starts, the effect composites it, steps advance
//   2. the POINTER stirs it: with the automatic stirrer held, mouse strokes over the LEFT half put
//      dye on the left (read back from the sim) and change the frame; a still pointer adds none
//   3. ink composites differently from smoke (same dye, a different frame)
//   4. the BUDGET: governor level 3 (resolution 72 %) drops the grid to the medium tier; level 6
//      (scene look off) stops compositing, so the sim stops stepping
//   5. switching the entry off stops it too (nothing composites = nothing steps)
//   6. particle FLOW FIELDS: the Flow field preset drives uFlow; the field moves the particles
//      (frames differ from the same preset with flow 0); the governor's particle cap halves the
//      integration steps
// Run: APP_URL=https://localhost:5461/ node tests/e2e/fluid-layer.test.cjs
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.env.HOME, '.code/lanes-30/after-65/65-visuals');

const fl = (page) => page.evaluate(() => window.__stores.fluidLayer.fluidLayerDebug());
const dye = (page) => page.evaluate(() => window.__stores.fluidLayer.readFluidDyeForTest());

async function canvasRect(page) {
	return page.evaluate(() => {
		let renderer;
		window.__stores.globalRenderer.subscribe((v) => (renderer = v))();
		const b = renderer.domElement.getBoundingClientRect();
		return { x: b.x, y: b.y, w: b.width, h: b.height };
	});
}

/** a stroke of real mouse moves across part of the canvas (fractions of its size) */
async function stroke(page, r, x0, y0, x1, y1, steps = 24) {
	await page.mouse.move(r.x + r.w * x0, r.y + r.h * y0);
	for (let i = 1; i <= steps; i++) {
		const t = i / steps;
		await page.mouse.move(r.x + r.w * (x0 + (x1 - x0) * t), r.y + r.h * (y0 + (y1 - y0) * t));
		await page.waitForTimeout(16);
	}
}

h.run(async () => {
	fs.mkdirSync(EVIDENCE, { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	const page = A.page;
	await h.answerRestore(A).catch(() => {});
	await page.evaluate(() => {
		window.__stores.objectActions?.deselectObject?.();
		window.__stores.qualityGovernor.setAutoQuality(false);
		window.__stores.qualityGovernor.governorForTest.reset();
	});
	const r = await canvasRect(page);
	const band = { x: Math.round(r.x + r.w * 0.1), y: Math.round(r.y + r.h * 0.2), width: Math.round(r.w * 0.8), height: Math.round(r.h * 0.55) };

	console.log('\n=== 1. the look entry ===');
	let d = await fl(page);
	h.check(d.presenter === 'none' && !d.sim, '1.1 inert with no entry: ' + JSON.stringify({ presenter: d.presenter, sim: d.sim }));
	const before = await h.grabFrame(A, band);
	const id = await page.evaluate(() => {
		const sp = window.__stores.scenePost;
		sp.setScenePostEnabled(true);
		return sp.addPostEffect('fluid');
	});
	await h.eventually(() => fl(page), (s) => s.presenter === 'post' && s.steps > 10, 'fluid stepping', 10000).catch(() => {});
	d = await fl(page);
	h.check(d.presenter === 'post' && d.steps > 10, '1.2 the entry composites the shared sim and it steps: ' + JSON.stringify({ presenter: d.presenter, steps: d.steps }));
	h.check(d.tier === 'high' && d.simRes === 128 && d.dyeRes === 512 && d.iterations === 20, '1.3 a desktop runs the full grid (128 / 512 / 20): ' + JSON.stringify({ tier: d.tier, simRes: d.simRes, dyeRes: d.dyeRes, it: d.iterations }));
	h.check(d.sim && d.sim.sim[0] > d.sim.sim[1], '1.4 the grid follows the canvas aspect: ' + JSON.stringify(d.sim));
	await page.waitForTimeout(1500);
	const auto = await h.grabFrame(A, band);
	fs.writeFileSync(path.join(EVIDENCE, 'fluid-01-auto-stir.png'), auto);
	h.check((await h.frameDelta(page, before, auto)).fraction > 0.01, '1.5 the automatic stirrer alone puts smoke on screen');

	console.log('\n=== 2. the pointer stirs it ===');
	await page.evaluate((eid) => {
		const s = window.__stores;
		s.fluidLayer.holdFluidAutoForTest(true);
		s.scenePost.setPostEffectParams(eid, { fade: 3 });
	}, id);
	// let the auto smoke thin out
	await page.waitForTimeout(2500);
	await page.evaluate((eid) => window.__stores.scenePost.setPostEffectParams(eid, { fade: 0.3 }), id);
	await page.waitForTimeout(400);
	const still = await dye(page);
	const quiet = await h.grabFrame(A, band);
	await page.waitForTimeout(300);
	const quiet2 = await dye(page);
	h.check(quiet2 && quiet2.total <= still.total + 1, '2.1 a still pointer adds no dye (' + still.total.toFixed(1) + ' -> ' + quiet2.total.toFixed(1) + ')');
	const splatsBefore = (await fl(page)).splats;
	for (let i = 0; i < 3; i++) await stroke(page, r, 0.1, 0.3 + i * 0.15, 0.4, 0.35 + i * 0.15);
	await page.waitForTimeout(150);
	const stirred = await dye(page);
	d = await fl(page);
	h.check(d.splats > splatsBefore + 20, '2.2 mouse moves over the canvas became splats (' + (d.splats - splatsBefore) + ')');
	h.check(stirred.total > quiet2.total + 5, '2.3 ...which put dye in (' + quiet2.total.toFixed(1) + ' -> ' + stirred.total.toFixed(1) + ')');
	h.check(stirred.left > stirred.right * 2, '2.4 ...on the LEFT, where the pointer went (left ' + stirred.left.toFixed(1) + ' / right ' + stirred.right.toFixed(1) + ')');
	const smoke = await h.grabFrame(A, band);
	fs.writeFileSync(path.join(EVIDENCE, 'fluid-02-pointer-smoke.png'), smoke);
	h.check((await h.frameDelta(page, quiet, smoke)).fraction > 0.02, '2.5 ...and the frame shows it');

	console.log('\n=== 3. ink ===');
	await page.evaluate((eid) => window.__stores.scenePost.setPostEffectParams(eid, { style: 'ink', fade: 0 }), id);
	await h.eventually(() => fl(page), (s) => s.presenter === 'post', 'rebuilt', 5000).catch(() => {});
	await page.waitForTimeout(400);
	const ink = await h.grabFrame(A, band);
	fs.writeFileSync(path.join(EVIDENCE, 'fluid-03-ink.png'), ink);
	h.check((await h.frameDelta(page, smoke, ink)).fraction > 0.02, '3.1 ink composites the same dye differently from smoke');
	d = await fl(page);
	h.check(d.sim !== null, '3.2 ...on the SAME sim (a param edit rebuilds the effect, not the solver): ' + JSON.stringify(d.sim));

	console.log('\n=== 4. the device budget ===');
	await page.evaluate(() => window.__stores.qualityGovernor.governorForTest.setLevel(3, 1e9));
	await h.eventually(() => fl(page), (s) => s.tier === 'medium', 'medium tier', 5000).catch(() => {});
	d = await fl(page);
	h.check(d.tier === 'medium' && d.simRes === 96 && d.iterations === 14, '4.1 resolution 72 % drops the grid to the medium tier (96 / 384 / 14): ' + JSON.stringify({ tier: d.tier, simRes: d.simRes, it: d.iterations }));
	await page.evaluate(() => window.__stores.qualityGovernor.governorForTest.setLevel(6, 1e9 + 1000));
	await page.waitForTimeout(1200);
	const s1 = (await fl(page)).steps;
	await page.waitForTimeout(500);
	d = await fl(page);
	h.check(d.steps === s1 && d.presenter === 'none', '4.2 with the scene look given up, nothing composites and nothing steps: ' + JSON.stringify({ presenter: d.presenter, steps: [s1, d.steps] }));
	await page.evaluate(() => window.__stores.qualityGovernor.governorForTest.reset());
	await h.eventually(() => fl(page), (s) => s.presenter === 'post', 'back', 5000).catch(() => {});
	d = await fl(page);
	h.check(d.presenter === 'post' && d.tier === 'high', '4.3 full quality again: back on, full grid: ' + JSON.stringify({ presenter: d.presenter, tier: d.tier }));

	console.log('\n=== 5. switched off ===');
	await page.evaluate((eid) => window.__stores.scenePost.setPostEffectEnabled(eid, false), id);
	await page.waitForTimeout(900);
	const s2 = (await fl(page)).steps;
	await page.waitForTimeout(400);
	d = await fl(page);
	h.check(d.presenter === 'none' && d.steps === s2, '5.1 the entry off: no step, no composite: ' + JSON.stringify({ presenter: d.presenter, steps: [s2, d.steps] }));
	await page.evaluate((eid) => window.__stores.scenePost.removePostEffect(eid), id);

	console.log('\n=== 6. particle flow fields ===');
	const uuid = await page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create sphere');
		let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		const o = group.children[group.children.length - 1];
		delete o.userData.physics;
		let cam;
		s.globalCamera.subscribe((c) => (cam = c))();
		const fwd = cam.getWorldDirection(cam.position.clone());
		o.position.copy(cam.position).addScaledVector(fwd, 6);
		o.scale.setScalar(0.3);
		o.updateMatrixWorld(true);
		s.objectActions.deselectObject();
		s.particleActions.addParticlesPreset(o.uuid, 'flowfield');
		return o.uuid;
	});
	const entryOf = () => page.evaluate((u) => window.__stores.particleRuntime.particleEntries().find((e) => e.uuid === u) ?? null, uuid);
	await h.eventually(entryOf, (e) => !!e, 'emitter', 6000).catch(() => {});
	let e = await entryOf();
	h.check(e && e.flow > 0 && e.flowSteps === 4, '6.1 the Flow field preset drives the field (uFlow ' + e?.flow + ', 4 steps): ' + JSON.stringify(e && { flow: e.flow, steps: e.flowSteps }));
	await page.waitForTimeout(800);
	const withFlow = await h.grabFrame(A, band);
	fs.writeFileSync(path.join(EVIDENCE, 'fluid-06-flowfield.png'), withFlow);
	await page.evaluate((u) => window.__stores.particleActions.updateObjectParticles(u, { flow: 0 }), uuid);
	await h.eventually(entryOf, (x) => x && x.flow === 0, 'flow 0', 4000).catch(() => {});
	await page.waitForTimeout(800);
	const noFlow = await h.grabFrame(A, band);
	fs.writeFileSync(path.join(EVIDENCE, 'fluid-06-noflow.png'), noFlow);
	h.check((await h.frameDelta(page, withFlow, noFlow)).fraction > 0.002, '6.2 the field moves the particles (a frame with flow differs from one without)');
	await page.evaluate((u) => window.__stores.particleActions.updateObjectParticles(u, { flow: 1 }), uuid);
	await page.evaluate(() => window.__stores.qualityGovernor.governorForTest.setLevel(8, 2e9));
	await h.eventually(entryOf, (x) => x && x.flowSteps === 2, 'capped', 5000).catch(() => {});
	e = await entryOf();
	h.check(e && e.flowSteps === 2, '6.3 the governor\'s particle cap halves the integration steps (' + e?.flowSteps + ')');
	await page.evaluate(() => window.__stores.qualityGovernor.governorForTest.reset());
	await h.finish(browser);
});
