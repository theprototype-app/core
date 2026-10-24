// 64-2d PERFORMANCE PROTOCOL — the fps rows for 2D: the 2D scene template (three parallax layers, an
// animated sprite sheet, Camera Follow 2D) and a stress row of 100 animated sprites, on the desktop and on
// the Quest profile (IWER, a Quest 3 emulated: the app's own XR path, low tier). Run under
// `e2e-slot --exclusive` (frame times mean nothing with another browser on the GPU). The 65-visuals
// protocol verbatim: frame-rate limit + vsync OFF, p50 / p95 frame time over 3 s after a 1 s warm-up,
// renderer.info calls / triangles per frame. Quest budget: <= 150 calls, <= 300k triangles (the frame
// time is the Deck's GPU running the headset workload, a proxy).
//   APP_URL=https://theprototype.app:5419/ node tests/e2e/sprite2d-perf.cjs   (OUT=<file.json> saves the rows)
const fs = require('fs');
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const ARGS = [...h.GPU_ARGS, '--disable-frame-rate-limit', '--disable-gpu-vsync'];

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

async function setup(browser, label, opts = {}) {
	const A = await h.setupPage(browser, label, { context: { viewport: { width: 1280, height: 800 } }, ...opts });
	await h.answerRestore(A).catch(() => {});
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.objectActions?.deselectObject?.();
		s.qualityGovernor.setAutoQuality(false);
		s.qualityGovernor.governorForTest.reset();
	});
	return A;
}

const openTemplate = (page) =>
	page.evaluate(async () => {
		const m = await import('/src/lib/sprite2d/template2d.js');
		const ok = await m.open2dTemplate();
		// images decode, the reconcile sizes the planes
		for (let i = 0; i < 100; i++) {
			let g;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			if (g?.getObjectByName('Player')?.material?.map?.image) break;
			await new Promise((r) => setTimeout(r, 200));
		}
		await new Promise((r) => setTimeout(r, 1000));
		return ok;
	});

/** 100 sprites sharing one 4-frame sheet, each walking (autoplay) — a crowd row */
const addCrowd = (page) =>
	page.evaluate(async () => {
		const s = window.__stores;
		const c = document.createElement('canvas');
		c.width = 64;
		c.height = 16;
		const g = c.getContext('2d');
		['#e74c3c', '#2ecc71', '#3498db', '#f1c40f'].forEach((col, i) => {
			g.fillStyle = col;
			g.fillRect(i * 16 + 4, 2, 8, 12);
		});
		const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
		let group;
		s.objectsGroup.subscribe((x) => (group = x))();
		const before = new Set(group.children.map((o) => o.uuid));
		for (let i = 0; i < 100; i++) s.commandsHandler.sceneCommand('/create Sprite');
		await new Promise((r) => setTimeout(r, 300));
		const made = group.children.filter((o) => !before.has(o.uuid) && o.userData?.sprite);
		made.forEach((o, i) => o.position.set(-12 + (i % 20) * 1.25, -2.5 + Math.floor(i / 20) * 1.1, 0.5));
		await s.sprite2dActions.setSpriteImage(made.map((o) => o.uuid), blob);
		for (const o of made) s.sprite2dActions.setSpriteFor(o.uuid, { sheet: { cols: 4, rows: 1 }, clips: [{ name: 'walk', from: 0, to: 3, fps: 8 + (made.indexOf(o) % 5) }], play: 'walk' });
		s.objectActions?.deselectObject?.();
		await new Promise((r) => setTimeout(r, 1500));
		return made.length;
	});

h.run(async () => {
	const rows = [];
	const row = (profile, what, m) => {
		rows.push({ profile, what, ...m });
		console.log(`${profile.padEnd(8)} ${what.padEnd(40)} p50 ${String(m.p50).padStart(6)} ms  p95 ${String(m.p95).padStart(6)} ms  calls ${String(m.calls).padStart(4)}  tris ${String(m.tris).padStart(7)}  (${m.frames} frames)`);
	};
	const browser = await h.launch({ args: ARGS });

	console.log('\n=== desktop (1280 x 800, high tier) ===');
	const D = await setup(browser, 'D');
	let page = D.page;
	row('desktop', 'empty scene (baseline)', await measure(page));
	h.check(await openTemplate(page), 'desktop: the 2D template opened');
	row('desktop', '2D template, 2D editor view (ortho)', await measure(page));
	await page.evaluate(async () => (await import('/src/lib/sprite2d/view2d.js')).exit2dView());
	await page.waitForTimeout(500);
	row('desktop', '2D template, perspective editor view', await measure(page));
	const n = await addCrowd(page);
	h.check(n === 100, 'desktop: 100 crowd sprites (' + n + ')');
	row('desktop', '2D template + 100 animated sprites', await measure(page));
	await D.ctx.close().catch(() => {});

	console.log('\n=== Quest profile (IWER Quest 3, low tier) ===');
	const Q = await setup(browser, 'Q', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	page = Q.page;
	await iwer.enter(page);
	await iwer.pose(page, 'head', [0, 1, 14], { yaw: 0 });
	await page.evaluate(() => window.__stores.qualityGovernor.governorForTest.reset());
	row('quest', 'empty scene (baseline)', await measure(page));
	h.check(await openTemplate(page), 'quest: the 2D template opened');
	await iwer.pose(page, 'head', [0, 1, 14], { yaw: 0 });
	await iwer.frames(page, 30);
	row('quest', '2D template (flat layers in 3D)', await measure(page));
	await addCrowd(page);
	await iwer.frames(page, 30);
	row('quest', '2D template + 100 animated sprites', await measure(page));
	const xr = await page.evaluate(() => window.__stores.sprite2d.sprite2dDebug());
	h.check(xr.xr && xr.sprites >= 100, 'quest: the sprites tick inside the XR session, parallax off in the headset (' + JSON.stringify({ xr: xr.xr, sprites: xr.sprites, layers: xr.layers }) + ')');

	const budget = rows.filter((r) => r.profile === 'quest');
	for (const r of budget) h.check(r.calls <= 150 && r.tris <= 300000, `Quest budget calls/tris: ${r.what} (${r.calls} calls, ${r.tris} tris)`);
	if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(rows, null, 2));
	await h.finish(browser);
});
