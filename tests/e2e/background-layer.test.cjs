// 65 M2 — THE BACKGROUND LAYER renders every preset, and the POINTER moves it.
//
// The packs set is served from the lane's packs checkout (BACKGROUNDS_DIR, else the sibling
// packs-lane-65-visuals / packs folder) by a route on PACKS_BASE/backgrounds/, so the suite
// proves the app's own loader against the files the packs PR ships — not a copy.
//   1. no background: nothing drawn (the inert path), a baseline frame of the empty view
//   2. per preset (the five packs presets + the built-in): applied through the loader, it
//      compiles, draws full screen, changes most of the frame; with the CLOCK HELD, two frames
//      at one pointer position are identical (control) and a pointer move changes the frame
//   3. On a plane: the layer follows a picked object; deleting the object hides it, undo
//      brings it back
//   4. scene data: the document survives the SAVE snapshot (the post/background prune fix —
//      on v1.41.0 `pruneMissing` dropped every non-object key), and a selection carries none
//   5. View ▸ Overrides ▸ Scene shaders off hides it here, on hides it again
//   6. the Configure Scene section drives the same document (preset picker + mode)
// Run: APP_URL=https://localhost:5461/ node tests/e2e/background-layer.test.cjs
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.env.HOME, '.code/lanes-30/after-65/65-visuals');
const PRESETS = ['mesh-gradient', 'silk-gradient', 'noise-flow', 'metaballs', 'grain-dither'];

function backgroundsDir() {
	return [
		process.env.BACKGROUNDS_DIR,
		path.join(__dirname, '../../../packs-lane-65-visuals/backgrounds'),
		path.join(__dirname, '../../../packs/backgrounds')
	]
		.filter(Boolean)
		.find((d) => fs.existsSync(path.join(d, 'index.json')));
}

const bg = (page) => page.evaluate(() => window.__stores.backgroundLayer.backgroundLayerDebug());
const errorsOf = (page) =>
	page.evaluate(() => {
		let e = null;
		window.__stores.shaderGraph.shaderErrors.subscribe((v) => (e = v))();
		return e.background ?? [];
	});

/** a chrome-free band of the canvas: the middle 60 % horizontally, upper-middle vertically */
async function band(page) {
	const r = await page.evaluate(() => {
		let renderer;
		window.__stores.globalRenderer.subscribe((v) => (renderer = v))();
		const b = renderer.domElement.getBoundingClientRect();
		return { x: b.x, y: b.y, w: b.width, h: b.height };
	});
	return { x: Math.round(r.x + r.w * 0.2), y: Math.round(r.y + r.h * 0.22), width: Math.round(r.w * 0.6), height: Math.round(r.h * 0.4) };
}

h.run(async () => {
	const dir = backgroundsDir();
	if (!dir) throw new Error('no backgrounds/ checkout — set BACKGROUNDS_DIR');
	fs.mkdirSync(EVIDENCE, { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	const page = A.page;
	await h.answerRestore(A).catch(() => {});
	let served = 0;
	await page.route(/\/backgrounds\/[A-Za-z0-9._-]+\.json(\?.*)?$/, (route) => {
		const name = new URL(route.request().url()).pathname.split('/').pop();
		const file = path.join(dir, name);
		if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'missing' });
		served++;
		return route.fulfill({ status: 200, contentType: 'application/json', body: fs.readFileSync(file, 'utf8') });
	});
	// an empty view: deselect, look at the sky
	await page.evaluate(() => window.__stores.objectActions?.deselectObject?.());

	console.log('\n=== 1. no background: inert ===');
	let d = await bg(page);
	h.check(d.draw === 'none' && !d.visible.screen, '1.1 nothing drawn with no document: ' + JSON.stringify({ draw: d.draw, visible: d.visible }));
	const clip = await band(page);
	await page.mouse.move(clip.x + 10, clip.y + 10);
	const empty = await h.grabFrame(A, clip);
	fs.writeFileSync(path.join(EVIDENCE, '01-no-background.png'), empty);

	console.log('\n=== 2. every preset renders, and the pointer moves it ===');
	const list = await page.evaluate(() => window.__stores.backgroundPresets.loadBackgroundPresets({ force: true }));
	h.check(list.status === 'ready', '2.0 the packs index loads through PACKS_BASE: ' + list.status + ' ' + list.error);
	h.check(
		PRESETS.every((k) => list.presets.some((p) => p.key === k && p.source === 'packs')) && list.presets.some((p) => p.source === 'builtin'),
		'2.0b ...all five packs presets plus the built-in: ' + list.presets.map((p) => p.key).join(', ')
	);
	let n = 1;
	for (const key of [...PRESETS, 'soft-gradient']) {
		n++;
		const res = await page.evaluate((k) => window.__stores.backgroundPresets.applyBackgroundPreset(k), key);
		h.check(res.ok, `2.${n}a ${key}: applied (${res.error ?? 'ok'})`);
		await h.eventually(() => bg(page), (s) => s.compiled && s.preset === key && s.draw === 'screen', key + ' drawing', 8000);
		d = await bg(page);
		const errs = await errorsOf(page);
		h.check(d.draw === 'screen' && d.visible.screen && errs.length === 0, `2.${n}b ${key}: compiled and drawn full screen, no errors: ` + JSON.stringify({ draw: d.draw, errs }));
		await page.evaluate(() => window.__stores.backgroundLayer.setBackgroundClockForTest(123.4));
		await page.mouse.move(clip.x + clip.width * 0.15, clip.y + clip.height * 0.3);
		await page.waitForTimeout(900);
		const at1 = await h.grabFrame(A, clip);
		await page.waitForTimeout(300);
		const at1b = await h.grabFrame(A, clip);
		const vsEmpty = await h.frameDelta(page, empty, at1);
		h.check(vsEmpty.fraction > 0.5, `2.${n}c ${key}: it paints the view (${(vsEmpty.fraction * 100).toFixed(1)} % of the band changed vs no background)`);
		const still = await h.frameDelta(page, at1, at1b);
		h.check(still.fraction < 0.01, `2.${n}d ${key}: CONTROL — clock held, pointer still: the frame holds (${(still.fraction * 100).toFixed(2)} % changed)`);
		await page.mouse.move(clip.x + clip.width * 0.85, clip.y + clip.height * 0.75, { steps: 6 });
		await page.waitForTimeout(900);
		const at2 = await h.grabFrame(A, clip);
		const moved = await h.frameDelta(page, at1, at2);
		d = await bg(page);
		h.check(moved.fraction > 0.02, `2.${n}e ${key}: the POINTER moves it (${(moved.fraction * 100).toFixed(1)} % changed; pointer ${d.pointer.x.toFixed(2)},${d.pointer.y.toFixed(2)})`);
		fs.writeFileSync(path.join(EVIDENCE, `02-${key}.png`), at2);
		await page.evaluate(() => window.__stores.backgroundLayer.setBackgroundClockForTest(null));
	}
	h.check(served >= 6, '2.9 the files came from the packs checkout (' + served + ' served)');
	// the clock runs again: the background drifts on its own (the shared clock)
	const t0 = await h.grabFrame(A, clip);
	await page.waitForTimeout(1500);
	const t1 = await h.grabFrame(A, clip);
	h.check((await h.frameDelta(page, t0, t1)).fraction > 0.02, '2.10 released, the shared clock animates it');

	console.log('\n=== 3. on a plane ===');
	const uuid = await page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		const box = group.children[group.children.length - 1];
		delete box.userData.physics;
		let cam;
		s.globalCamera.subscribe((c) => (cam = c))();
		const fwd = cam.getWorldDirection(cam.position.clone());
		box.position.copy(cam.position).addScaledVector(fwd, 4);
		box.lookAt(cam.position);
		box.scale.set(2.4, 1.4, 0.05);
		box.updateMatrixWorld(true);
		s.objectActions.deselectObject();
		return box.uuid;
	});
	await page.evaluate((u) => window.__stores.backgroundLayer.setBackgroundLayer({ mode: 'plane', target: u }), uuid);
	await h.eventually(() => bg(page), (s) => s.draw === 'plane', 'plane drawing', 5000);
	d = await bg(page);
	h.check(d.draw === 'plane' && d.visible.plane && !d.visible.screen, '3.1 drawn on the picked object, not full screen: ' + JSON.stringify(d.visible));
	h.check(Math.abs(d.uniforms.aspect - 2.4 / 1.4) < 0.05, '3.2 ...with the plane\'s own aspect (' + d.uniforms.aspect.toFixed(3) + ' ≈ ' + (2.4 / 1.4).toFixed(3) + ')');
	fs.writeFileSync(path.join(EVIDENCE, '03-on-a-plane.png'), await h.grabFrame(A));
	await page.evaluate((u) => window.__stores.objectActions.deleteObjectsByUuid([u]), uuid);
	await h.eventually(() => bg(page), (s) => s.draw === 'none', 'plane gone', 5000).catch(() => {});
	d = await bg(page);
	h.check(d.draw === 'none' && !d.visible.plane, '3.3 its object deleted: nothing drawn (no orphan overlay)');
	await page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => bg(page), (s) => s.draw === 'plane', 'plane back', 5000).catch(() => {});
	d = await bg(page);
	h.check(d.draw === 'plane', '3.4 undo brings the object back, and the layer with it: ' + d.draw);
	await page.evaluate(() => window.__stores.backgroundLayer.setBackgroundLayer({ mode: 'screen' }));

	console.log('\n=== 4. scene data ===');
	const snap = await page.evaluate(() => {
		const s = window.__stores;
		let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		const pruneMissing = (id) => !group.getObjectByProperty('uuid', id);
		const saved = s.shaderGraph.shaderGraphsSnapshot({ pruneMissing });
		return { keys: Object.keys(saved), layer: saved.background?.layer, preset: saved.background?.preset };
	});
	h.check(snap.keys.includes('background') && snap.preset === 'soft-gradient', '4.1 the background survives the SAVE snapshot (pruneMissing no longer drops scene documents): ' + JSON.stringify(snap));
	const sel = await page.evaluate((u) => Object.keys(window.__stores.sessions?.buildSelectionPayload?.('sel', [u])?.shaderGraphs ?? { na: 1 }), uuid);
	h.check(!sel.includes('background'), '4.2 ...and a SELECTION (a prefab) carries no background: ' + JSON.stringify(sel));

	console.log('\n=== 5. the local override ===');
	await page.evaluate(() => window.__stores.viewportOverrides?.setRenderLayer?.('shaders', false));
	await page.waitForTimeout(200);
	d = await bg(page);
	h.check(d.draw === 'none', '5.1 View ▸ Overrides ▸ Scene shaders off: not drawn here (' + d.draw + ')');
	await page.evaluate(() => window.__stores.viewportOverrides?.setRenderLayer?.('shaders', true));
	await page.waitForTimeout(200);
	d = await bg(page);
	h.check(d.draw === 'screen', '5.2 ...on again: drawn (' + d.draw + ')');

	console.log('\n=== 6. Configure Scene ▸ Background ===');
	await page.evaluate(() => window.__stores.openSceneSection?.('Background'));
	await page.waitForTimeout(800);
	const section = page.locator('#background-preset');
	h.check((await section.count()) > 0, '6.1 the section is in Configure Scene');
	if (await section.count()) {
		await section.first().click();
		await page.waitForTimeout(300);
		const opt = page.getByRole('option', { name: 'Metaballs' });
		if (await opt.count()) await opt.first().click();
		await h.eventually(() => bg(page), (s) => s.preset === 'metaballs', 'picker applied', 6000).catch(() => {});
		d = await bg(page);
		h.check(d.preset === 'metaballs', '6.2 picking a preset in the section applies it: ' + d.preset);
		await page.locator('#background-mode-off').click().catch(() => {});
		await page.waitForTimeout(300);
		d = await bg(page);
		h.check(d.layer?.mode === 'off' && d.draw === 'none', '6.3 Where ▸ Off keeps the document and stops drawing: ' + JSON.stringify({ mode: d.layer?.mode, draw: d.draw }));
		fs.writeFileSync(path.join(EVIDENCE, '06-section.png'), await page.screenshot());
		await page.locator('#background-mode-screen').click().catch(() => {});
	}
	await h.finish(browser);
});
