// 65 M2 + M6 PERFORMANCE PROTOCOL — the fps rows for the shader backgrounds, the smoke layer and the particle
// flow field, on the desktop and on the Quest profile (IWER, a Quest 3 emulated: the app's own XR path, low
// tier). Run under `e2e-slot --exclusive` (frame times mean nothing with another browser on the GPU).
//
// Chromium runs with the frame-rate limit and vsync OFF, so a frame interval is what the frame COSTS on this
// GPU (a vsync-capped p50 reads 16.7 ms for everything — the 37-fx lesson). Rows: p50 / p95 frame time over
// 3 s after a 1 s warm-up, and in the headset renderer.info calls / triangles (XR renders directly, no
// composer, so the counts are the scene's own). The Quest budget the rows are read against: <= 150 calls,
// <= 300k triangles, <= 13.9 ms (72 Hz) — the frame time here is the DECK's GPU running the headset's
// workload at the low tier, a proxy, not a Quest measurement.
//   APP_URL=https://localhost:5461/ node tests/e2e/visuals-perf.cjs   (OUT=<file.json> to save the rows)
const fs = require('fs');
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const ARGS = [...h.GPU_ARGS, '--disable-frame-rate-limit', '--disable-gpu-vsync'];
const PRESETS = ['soft-gradient', 'mesh-gradient', 'silk-gradient', 'noise-flow', 'metaballs', 'grain-dither'];
const BACKGROUNDS_DIR = process.env.BACKGROUNDS_DIR || require('path').join(__dirname, '../../../packs-lane-65-visuals/backgrounds');

/** p50/p95 of frame intervals over `ms`, plus renderer.info (per frame) — in XR on the session's rAF */
const measure = (page, ms = 3000) =>
	page.evaluate(async (ms) => {
		let r;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		const session = r.xr.isPresenting ? r.xr.getSession() : null;
		const raf = (cb) => (session ? session.requestAnimationFrame(cb) : requestAnimationFrame(cb));
		await new Promise((ok) => setTimeout(ok, 1000));
		const times = [];
		let last = 0;
		let calls = 0;
		let tris = 0;
		let n = 0;
		await new Promise((done) => {
			const end = performance.now() + ms;
			const tick = (t) => {
				if (last) times.push(t - last);
				last = t;
				calls += r.info.render.calls;
				tris += r.info.render.triangles;
				n++;
				if (performance.now() < end) raf(tick);
				else done();
			};
			raf(tick);
		});
		times.sort((a, b) => a - b);
		const q = (p) => +times[Math.min(times.length - 1, Math.floor(times.length * p))].toFixed(2);
		return { frames: times.length, p50: q(0.5), p95: q(0.95), calls: Math.round(calls / n), tris: Math.round(tris / n) };
	}, ms);

const setBackground = (page, key) =>
	page.evaluate(async (key) => {
		const s = window.__stores;
		if (!key) return s.backgroundLayer.removeBackground();
		return s.backgroundPresets.applyBackgroundPreset(key);
	}, key);

async function setup(browser, label, opts = {}) {
	const A = await h.setupPage(browser, label, { context: { viewport: { width: 1280, height: 800 } }, ...opts });
	await h.answerRestore(A).catch(() => {});
	await A.page.route(/\/backgrounds\/[A-Za-z0-9._-]+\.json(\?.*)?$/, (route) => {
		const name = new URL(route.request().url()).pathname.split('/').pop();
		const file = require('path').join(BACKGROUNDS_DIR, name);
		if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'missing' });
		return route.fulfill({ status: 200, contentType: 'application/json', body: fs.readFileSync(file, 'utf8') });
	});
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.objectActions?.deselectObject?.();
		s.qualityGovernor.setAutoQuality(false);
		s.qualityGovernor.governorForTest.reset();
	});
	return A;
}

h.run(async () => {
	const rows = [];
	const row = (profile, what, m) => {
		rows.push({ profile, what, ...m });
		console.log(`${profile.padEnd(8)} ${what.padEnd(34)} p50 ${String(m.p50).padStart(6)} ms  p95 ${String(m.p95).padStart(6)} ms  calls ${String(m.calls).padStart(4)}  tris ${String(m.tris).padStart(7)}  (${m.frames} frames)`);
	};
	const browser = await h.launch({ args: ARGS });

	console.log('\n=== desktop (1280 x 800, high tier) ===');
	const D = await setup(browser, 'D');
	let page = D.page;
	row('desktop', 'empty scene (baseline)', await measure(page));
	for (const key of PRESETS) {
		await setBackground(page, key);
		await h.eventually(() => page.evaluate(() => window.__stores.backgroundLayer.backgroundLayerDebug()), (s) => s.compiled && s.draw === 'screen', key, 8000).catch(() => {});
		row('desktop', 'background ' + key, await measure(page));
	}
	await setBackground(page, null);
	const fid = await page.evaluate(() => {
		const sp = window.__stores.scenePost;
		sp.setScenePostEnabled(true);
		return sp.addPostEffect('fluid');
	});
	row('desktop', 'smoke layer (128/512/20)', await measure(page));
	await setBackground(page, 'metaballs');
	row('desktop', 'smoke layer + metaballs', await measure(page));
	await page.evaluate((id) => window.__stores.scenePost.removePostEffect(id), fid);
	await setBackground(page, null);
	await page.evaluate(() => {
		const s = window.__stores;
		let cam;
		s.globalCamera.subscribe((c) => (cam = c))();
		const fwd = cam.getWorldDirection(cam.position.clone());
		const right = fwd.clone().cross(cam.up).normalize();
		window.__perfEmitters = [];
		for (let i = 0; i < 8; i++) {
			s.commandsHandler.sceneCommand('/create sphere');
			let group;
			s.objectsGroup.subscribe((g) => (group = g))();
			const o = group.children[group.children.length - 1];
			delete o.userData.physics;
			o.scale.setScalar(0.2);
			o.position.copy(cam.position).addScaledVector(fwd, 6).addScaledVector(right, (i - 3.5) * 0.9);
			o.updateMatrixWorld(true);
			s.particleActions.addParticlesPreset(o.uuid, 'flowfield');
			window.__perfEmitters.push(o.uuid);
		}
		s.objectActions.deselectObject();
	});
	row('desktop', '8 Flow field emitters (trails)', await measure(page));
	await page.evaluate(() => window.__perfEmitters.forEach((u) => window.__stores.particleActions.updateObjectParticles(u, { flow: 0 })));
	row('desktop', '8 same emitters, flow 0', await measure(page));
	await D.ctx.close().catch(() => {});

	console.log('\n=== Quest profile (IWER Quest 3, low tier) ===');
	const Q = await setup(browser, 'Q', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	page = Q.page;
	await iwer.enter(page);
	await iwer.pose(page, 'head', [0, 1.6, 0], { yaw: 0 });
	await iwer.pose(page, 'right', [0.2, 1.4, -0.3], { yaw: 0.1, pitch: 0.05 });
	await page.evaluate(() => window.__stores.qualityGovernor.governorForTest.reset());
	row('quest', 'empty scene (baseline)', await measure(page));
	for (const key of PRESETS) {
		await setBackground(page, key);
		await iwer.frames(page, 30);
		const b = await page.evaluate(() => window.__stores.backgroundLayer.backgroundLayerDebug());
		row('quest', `background ${key} (${b.draw}, cap ${b.octaveCap})`, await measure(page));
	}
	await setBackground(page, null);
	await page.evaluate(() => {
		const sp = window.__stores.scenePost;
		sp.setScenePostEnabled(true);
		sp.addPostEffect('fluid');
	});
	await iwer.frames(page, 30);
	const f = await page.evaluate(() => window.__stores.fluidLayer.fluidLayerDebug());
	row('quest', `smoke panel (${f.simRes}/${f.dyeRes}/${f.iterations})`, await measure(page));
	await setBackground(page, 'metaballs');
	await iwer.frames(page, 30);
	row('quest', 'smoke panel + metaballs sphere', await measure(page));

	const budget = rows.filter((r) => r.profile === 'quest');
	for (const r of budget) h.check(r.calls <= 150 && r.tris <= 300000, `Quest budget calls/tris: ${r.what} (${r.calls} calls, ${r.tris} tris)`);
	if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(rows, null, 2));
	await h.finish(browser);
});
