// 36 L2 — WHEN DOES A SCENE LOAD PARK THE CAMERA, and does it override a move the user made
// meanwhile? For each scene (Templates path: loadRemoteScene -> importSessionZip -> applySession):
//   still   no input: every frame's camera pose is sampled from the load's start; reports when the
//           pose first equals the scene's saved view (payload.camera) and when the load ended
//   moved   a REAL mouse drag on the canvas shortly after the load starts (OrbitControls), then
//           the final pose: SNAPPED = back on the saved view (the bug), KEPT = where the drag left it
//
//   APP_URL=https://theprototype.app:5345/ node scripts/start-view-probe.cjs
//   SCENES_DIR=<scenes checkout> PACKS_DIR=<packs mirror> SLUGS=... CPU=1 DRAG_AT=400 OUT=<file.json>
const fs = require('fs');
const path = require('path');
const h = require('../tests/e2e/helpers.cjs');

const SCENES_DIR = process.env.SCENES_DIR || '/home/deck/.code/theprototype-app/scenes-lane-36-load-polish';
const PACKS_DIR = process.env.PACKS_DIR || '/home/deck/.code/lanes-30/levels-packs';
const SLUGS = (process.env.SLUGS || 'tavern-interior,market-square,castle-courtyard,forest-clearing').split(',').filter(Boolean);
const CPU = Number(process.env.CPU || 1);
const DRAG_AT = Number(process.env.DRAG_AT || 400);
const OUT = process.env.OUT || '';

/** serve the scenes checkout + the packs mirror in place of the CDN */
async function routeCdn(page, index) {
	await page.route('**/cdn.jsdelivr.net/**', async (route) => {
		const url = route.request().url();
		const scenes = url.match(/\/theprototype-app\/scenes@[^/]+\/(.*)$/);
		if (scenes) {
			if (scenes[1] === 'index.json') return route.fulfill({ json: index });
			const file = path.join(SCENES_DIR, decodeURIComponent(scenes[1]));
			if (fs.existsSync(file)) return route.fulfill({ body: fs.readFileSync(file) });
			return route.fulfill({ status: 404 });
		}
		const packs = url.match(/\/theprototype-app\/packs@[^/]+\/(.*)$/);
		if (packs) {
			const file = path.join(PACKS_DIR, decodeURIComponent(packs[1].split('?')[0]));
			if (fs.existsSync(file)) return route.fulfill({ body: fs.readFileSync(file) }).catch(() => {});
		}
		return route.continue();
	});
}

/** in-page: sample the camera each frame from now, and stamp the load's phases */
const ARM = () => {
	const w = /** @type {any} */ (window);
	const s = w.__stores;
	const rec = { t0: performance.now(), samples: /** @type {any[]} */ ([]), phases: /** @type {any[]} */ ([]), ended: 0, on: true, down: 0, up: 0 };
	w.__svp = rec;
	window.addEventListener('pointerdown', () => (rec.down ||= Math.round(performance.now() - rec.t0)), true);
	window.addEventListener('pointerup', () => (rec.up = Math.round(performance.now() - rec.t0)), true);
	let cam, ctl;
	s.globalCamera.subscribe((v) => (cam = v))();
	s.orbitControls.subscribe((v) => (ctl = v))();
	const tick = () => {
		if (!rec.on) return;
		rec.samples.push({ t: Math.round(performance.now() - rec.t0), p: cam.position.toArray().map((v) => +v.toFixed(3)), q: ctl?.target?.toArray().map((v) => +v.toFixed(3)) });
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	let last = '';
	const un = s.sceneLoader.sceneLoad.subscribe((job) => {
		const key = job ? job.phase : 'none';
		if (key !== last) rec.phases.push({ t: Math.round(performance.now() - rec.t0), phase: key });
		last = key;
	});
	rec.un = un;
};

const near = (a, b, eps = 0.02) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) < eps);

h.run(async () => {
	const index = JSON.parse(fs.readFileSync(path.join(SCENES_DIR, 'index.json'), 'utf8'));
	const browser = await h.launch({ args: h.GPU_ARGS });
	const results = [];
	for (const slug of SLUGS) {
		const entry = [...(index.templates ?? []), ...(index.examples ?? []), ...(index.games ?? [])].find((t) => t.slug === slug);
		if (!entry) {
			console.log('no entry for ' + slug);
			continue;
		}
		for (const mode of ['still', 'moved']) {
			const A = await h.setupPage(browser, slug + '-' + mode, { context: { viewport: { width: 1280, height: 800 } } });
			const page = A.page;
			await routeCdn(page, index);
			const cdp = await page.context().newCDPSession(page);
			if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
			const sceneUrl = await page.evaluate((p) => window.__stores.sceneTemplates.resolveUrl(p, window.__stores.sceneTemplates.SCENES_BASE), entry.scene);
			// the saved view, read from the file itself
			const saved = await page.evaluate(async (url) => {
				const buf = await (await fetch(url)).arrayBuffer();
				const payload = await window.__stores.sessions.readSessionZip(buf);
				return payload?.camera ?? null;
			}, sceneUrl);
			await page.evaluate(ARM);
			await page.evaluate((url) => void window.__stores.sceneTemplates.loadRemoteScene({ slug: 'x', title: 'x', sceneUrl: url }), sceneUrl);
			let dragged = null;
			if (mode === 'moved') {
				await page.waitForTimeout(DRAG_AT);
				const box = await page.evaluate(() => {
					let r;
					window.__stores.globalRenderer.subscribe((v) => (r = v))();
					const b = r.domElement.getBoundingClientRect();
					return { x: b.x, y: b.y, width: b.width, height: b.height };
				});
				const cx = box.x + box.width / 2;
				const cy = box.y + box.height / 2;
				await page.mouse.move(cx, cy);
				await page.mouse.down();
				for (let i = 1; i <= 5; i++) await page.mouse.move(cx + i * 50, cy + i * 12);
				await page.mouse.up();
				await page.waitForTimeout(600); // damping settles
				dragged = await page.evaluate(() => {
					const r = window.__svp;
					return r.samples[r.samples.length - 1];
				});
			}
			// wait for the load to end + 1.5 s
			await h.eventually(
				() => page.evaluate(() => window.__svp.phases.some((p) => p.phase === 'none' && p.t > 0)),
				(v) => v,
				slug + ' ' + mode + ' load ended',
				120000
			);
			await page.waitForTimeout(1500);
			const rec = await page.evaluate(() => {
				const r = window.__svp;
				r.on = false;
				r.un?.();
				return { samples: r.samples, phases: r.phases, down: r.down, up: r.up };
			});
			// a SNAP: after the drag ended, the camera came back onto the saved view (the drag
			// itself swung it 15-35 m away; damping after a snap drifts it by a metre or two)
			const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
			let snapAt = null;
			if (dragged) {
				for (const smp of rec.samples) {
					if (smp.t > rec.up && dist(smp.p, saved.position) < 0.3) {
						snapAt = { t: smp.t, toSaved: +dist(smp.p, saved.position).toFixed(3) };
						break;
					}
				}
			}
			const first = rec.samples.find((s) => near(s.p, saved?.position) && near(s.q, saved?.target));
			const end = rec.samples[rec.samples.length - 1];
			const loadEnd = rec.phases.filter((p) => p.phase === 'none').pop()?.t;
			const row = {
				slug,
				mode,
				savedView: saved,
				parkedAtMs: first?.t ?? null,
				loadEndMs: loadEnd,
				phases: rec.phases,
				...(mode === 'moved'
					? {
							dragEndPose: dragged,
							finalPose: end,
							dragMs: [rec.down, rec.up],
							snapAt,
							finalToSavedM: +dist(end.p, saved.position).toFixed(3),
							finalToDragM: +dist(end.p, dragged.p).toFixed(3),
							verdict: snapAt ? 'SNAPPED' : 'KEPT'
						}
					: { finalOnSavedView: near(end.p, saved?.position) && near(end.q, saved?.target) })
			};
			console.log(JSON.stringify({ slug, mode, parkedAtMs: row.parkedAtMs, loadEndMs: row.loadEndMs, verdict: row.verdict, dragMs: row.dragMs, snapAt: row.snapAt, finalToSavedM: row.finalToSavedM, finalOnSavedView: row.finalOnSavedView, phases: rec.phases.map((p) => p.phase + '@' + p.t).join(' ') }));
			results.push(row);
			await A.ctx.close();
		}
	}
	if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
	await h.finish(browser);
});
