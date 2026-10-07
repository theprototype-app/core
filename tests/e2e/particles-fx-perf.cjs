// 37-fx Performance protocol for the particle render modes: 8 emitters (the cap) x 500
// particles (the desktop max) in front of the camera, World space, continuous, moving — per
// mode: frame time (rAF p50/p95 over 4 s), draw calls, triangles; then the same with the VR cap
// (200 per emitter) for the Quest budget (<= 150 calls, <= 300k tris). Run it under
// `e2e-slot --exclusive` (frame times are meaningless with another browser on the GPU).
// READING THE COUNTS: on the desktop the post-processing composer renders last (a fullscreen
// pass), so renderer.info there reports that pass (1 call) — only the VR-cap rows (direct
// render, no composer) carry the scene's real calls/triangles. Measured 2026-10-06 (Deck,
// RADV): every mode p50 16.7 ms = vsync on the desktop; VR cap: points 1.8k, stretch 3.4k,
// trails 25.8k, ribbon 3.4k prims at 28 calls (8 emitters x 200 + the editor scene).
//   APP_URL=https://theprototype.app:5359/ node tests/e2e/particles-fx-perf.cjs
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.evaluate(() => {
		const s = window.__stores;
		let cam;
		s.globalCamera.subscribe((c) => (cam = c))();
		const fwd = cam.getWorldDirection(cam.position.clone());
		const right = fwd.clone().cross(cam.up).normalize();
		let group;
		window.__perfBoxes = [];
		for (let i = 0; i < 8; i++) {
			s.commandsHandler.sceneCommand('/create box');
			s.objectsGroup.subscribe((g) => (group = g))();
			const box = group.children[group.children.length - 1];
			delete box.userData.physics;
			box.scale.setScalar(0.2);
			box.userData.__home = cam.position.clone().addScaledVector(fwd, 6).addScaledVector(right, (i - 3.5) * 0.9);
			box.position.copy(box.userData.__home);
			window.__perfBoxes.push(box);
		}
		s.objectActions.deselectObject();
		const t0 = performance.now();
		const loop = () => {
			const t = (performance.now() - t0) / 1000;
			window.__perfBoxes.forEach((b, i) => {
				b.position.copy(b.userData.__home);
				b.position.y += Math.sin(t * 2 + i) * 0.8;
				b.position.x += Math.cos(t * 1.3 + i) * 0.4;
			});
			requestAnimationFrame(loop);
		};
		loop();
	});

	const measure = () =>
		page.evaluate(async () => {
			let renderer;
			window.__stores.globalRenderer.subscribe((r) => (renderer = r))();
			const times = [];
			let last = 0;
			let calls = 0;
			let tris = 0;
			let n = 0;
			await new Promise((done) => {
				const end = performance.now() + 4000;
				const tick = (t) => {
					if (last) times.push(t - last);
					last = t;
					calls += renderer.info.render.calls;
					tris += renderer.info.render.triangles + renderer.info.render.points;
					n++;
					if (t < end) requestAnimationFrame(tick);
					else done();
				};
				requestAnimationFrame(tick);
			});
			times.sort((a, b) => a - b);
			return {
				p50: +times[Math.floor(times.length * 0.5)].toFixed(2),
				p95: +times[Math.floor(times.length * 0.95)].toFixed(2),
				calls: Math.round(calls / n),
				prims: Math.round(tris / n)
			};
		});

	const rows = [];
	const setAll = (cfg) =>
		page.evaluate((c) => {
			for (const b of window.__perfBoxes) window.__stores.particleActions.setObjectParticles(b.uuid, c);
		}, cfg);
	await setAll(null);
	await page.waitForTimeout(1500);
	rows.push({ mode: 'none (baseline)', vr: false, ...(await measure()) });
	const base = { mode: 'continuous', count: 500, lifetime: 1.2, speed: 1.5, gravity: -1, drag: 0.5, turbulence: 0.4, sizeStart: 0.06, sizeEnd: 0.02, space: 'world', inherit: 0.5, trail: 0.4, trailSegments: 8, stretch: 0.05, blending: 'additive' };
	for (const vr of [false, true]) {
		await page.evaluate((v) => window.__stores.isVRMode.set(v), vr);
		for (const render of ['points', 'stretch', 'trails', 'ribbon']) {
			await setAll({ ...(await page.evaluate(() => window.__stores.particlePresets.PARTICLE_DEFAULTS)), ...base, render });
			await page.waitForTimeout(1500);
			rows.push({ mode: render, vr, ...(await measure()) });
		}
	}
	await page.evaluate(() => window.__stores.isVRMode.set(false));
	console.log('mode | vr cap | frame p50 ms | p95 ms | draw calls | triangles+points');
	for (const r of rows) console.log(`${r.mode} | ${r.vr ? '200/emitter' : '-'} | ${r.p50} | ${r.p95} | ${r.calls} | ${r.prims}`);
	const vrRows = rows.filter((r) => r.vr);
	h.check(vrRows.every((r) => r.calls <= 150 && r.prims <= 300000), 'every mode under the VR cap stays inside the Quest budget (calls <= 150, tris <= 300k)');
	await h.finish(browser);
});
