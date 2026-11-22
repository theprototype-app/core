// 100 C2-3 — WATER IN THE CINEMATIC VIEW, end to end, on the four template scenes that have water.
//
// Per scene (a fresh page each, bounded): load it, wait for the water's programs, hold time (flows paused, the water
// clock frozen, module frame tasks parked) and photograph the standard view and the Cinematic view from the scene's
// own camera, each with the water shown and hidden. The water's FOOTPRINT (what changes when it is hidden) must agree
// between the two views, and inside it the colour must be as close to the standard view as the rest of the image is
// (the view lights the scene itself: GI, AO, bloom). Then: no errors, every surface drawn through TSL, "Water" gone
// from the "Not shown" chip, and leaving the view puts every water material and placeholder back (zero change).
// On the first scene (aquarium): the camera under the surface in both views, and the frame cost with the water drawn
// vs the C2-2 view (debugCinematicNoWater: the plain stand-in) at Standard quality.
//
// GPU: real WebGPU wants the Deck (desk "local") or the PC through a remote slot; SwiftShader passes with
// debugCinematicSoftware=1 (slow, same code). Evidence: test-results/100-cover-water/<scene>/ (sheets + numbers).
//
//   APP_URL=https://theprototype.app:7042/ E2E_PC= e2e-slot --local --dev $PWD 7042 -- env E2E_GPU=1 node tests/e2e/cinematic-water.test.cjs
//   WATER_SCENES=aquarium  (a subset)   WATER_QUALITY=basic|standard|high (default standard)
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const ARGS = [...(process.env.E2E_GPU === '1' ? h.GPU_ARGS : []), '--enable-unsafe-webgpu', '--enable-features=Vulkan'];
const STORAGE = { debugCinematicSoftware: '1' };
const OUT = process.env.WATER_OUT || path.join(__dirname, '..', '..', 'test-results', '100-cover-water');
const SCENES = (process.env.WATER_SCENES || 'aquarium,pool-party,island-ocean,water-works').split(',').filter(Boolean);
const QUALITY = process.env.WATER_QUALITY || 'standard';
const SCENE_MS = Number(process.env.WATER_SCENE_MS || 420000);
const W = 480;
const H = 270;

/** @param {any} page */
const state = (page) => page.evaluate(() => { let s; window.__tp.test.v1.cinematicState.cinematicState.subscribe((v) => (s = v))(); return s; });
/** @param {any} page */
const debug = (page, reset = false) => page.evaluate(async (r) => (await window.__tp.test.v1.cinematicState.cinematicView()).cinematicDebug(r), reset);
/** @param {any} page @param {string} want @param {string} label */
const waitMode = (page, want, label, ms = 120000) => h.eventually(async () => (await state(page)).mode, (m) => m === want, label, ms);

/** in-page: capture (GL or view) into window.__wShots[name] (W x H RGBA) and return a PNG @param {any} page @param {string} name @param {boolean} view */
const grab = (page, name, view) =>
	page.evaluate(
		async ({ name, view, W, H }) => {
			const s = window.__tp.test.v1;
			const c = document.createElement('canvas');
			c.width = W;
			c.height = H;
			const x = c.getContext('2d');
			if (view) {
				const v = await s.cinematicState.cinematicView();
				for (let i = 0; i < 40; i++) await new Promise((r) => requestAnimationFrame(r));
				const url = await v.grabCinematic();
				const img = new Image();
				img.src = url;
				await img.decode();
				x.drawImage(img, 0, 0, W, H);
			} else {
				let r, sc, cam;
				s.globalRenderer.subscribe((v) => (r = v))();
				s.globalScene.subscribe((v) => (sc = v))();
				s.globalCamera.subscribe((v) => (cam = v))();
				r.render(sc, cam);
				r.render(sc, cam);
				x.drawImage(r.domElement, 0, 0, W, H);
			}
			window.__wShots = window.__wShots || {};
			window.__wShots[name] = x.getImageData(0, 0, W, H).data;
			return c.toDataURL('image/png');
		},
		{ name, view, W, H }
	);

/** in-page: show / hide every water object (the runtime hides its surfaces with them) @param {any} page @param {boolean} on */
const showWater = (page, on) =>
	page.evaluate(async (on) => {
		const s = window.__tp.test.v1;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		let n = 0;
		g.traverse((o) => {
			if (o.userData?.water) {
				o.visible = on;
				n++;
			}
		});
		// the runtime follows visibility on its next tick
		for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
		return n;
	}, on);

/** in-page: the water's footprint in both views and the colour inside it @param {any} page */
const compare = (page) =>
	page.evaluate(
		({ W, H }) => {
			const S = window.__wShots;
			const diff = (a, b, i) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
			const mask = (a, b) => {
				const m = new Uint8Array(W * H);
				for (let i = 0, j = 0; i < a.length; i += 4, j++) m[j] = diff(a, b, i) > 36 ? 1 : 0;
				return m;
			};
			const g = mask(S['gl:all'], S['gl:-water']);
			const v = mask(S['view:all'], S['view:-water']);
			// the noise floor of each view (two shots of one held moment) is nobody's footprint
			const ng = mask(S['gl:all'], S['gl:again']);
			const nv = mask(S['view:all'], S['view:again']);
			let noiseG = 0, noiseV = 0;
			for (let j = 0; j < W * H; j++) {
				noiseG += ng[j];
				noiseV += nv[j];
				if (ng[j]) g[j] = 0;
				if (nv[j]) v[j] = 0;
			}
			let ga = 0, va = 0, both = 0, gx = 0, gy = 0, vx = 0, vy = 0;
			// mean |gl - view| per channel inside the shared footprint, and on the pixels neither view counts as water
			let inSum = 0, inN = 0, outSum = 0, outN = 0, lumG = 0, lumV = 0;
			const A = S['gl:all'], B = S['view:all'];
			const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
			for (let j = 0, i = 0; j < W * H; j++, i += 4) {
				if (g[j]) { ga++; gx += j % W; gy += (j / W) | 0; }
				if (v[j]) { va++; vx += j % W; vy += (j / W) | 0; }
				if (g[j] && v[j]) {
					both++;
					inSum += diff(A, B, i) / 3;
					inN++;
					lumG += lum(A, i);
					lumV += lum(B, i);
				} else if (!g[j] && !v[j]) {
					outSum += diff(A, B, i) / 3;
					outN++;
				}
			}
			const mc = document.createElement('canvas');
			mc.width = W;
			mc.height = H;
			const x = mc.getContext('2d');
			const img = x.createImageData(W, H);
			for (let j = 0; j < W * H; j++) {
				img.data[j * 4] = g[j] * 255;
				img.data[j * 4 + 1] = v[j] * 255;
				img.data[j * 4 + 2] = ng[j] || nv[j] ? 160 : 0;
				img.data[j * 4 + 3] = 255;
			}
			x.putImageData(img, 0, 0);
			const c = (sx, sy, n) => (n ? [Math.round(sx / n), Math.round(sy / n)] : null);
			return {
				maskUrl: mc.toDataURL('image/png'),
				gl: ga,
				view: va,
				overlapOfGl: ga ? +(both / ga).toFixed(2) : 0,
				overlapOfView: va ? +(both / va).toFixed(2) : 0,
				glCentre: c(gx, gy, ga),
				viewCentre: c(vx, vy, va),
				waterDelta: inN ? +(inSum / inN).toFixed(1) : null,
				restDelta: outN ? +(outSum / outN).toFixed(1) : null,
				waterLuma: inN ? [+(lumG / inN).toFixed(1), +(lumV / inN).toFixed(1)] : null,
				noise: [noiseG, noiseV]
			};
		},
		{ W, H }
	);

/** GPU-bound frame cost of the view (30 frames back to back, timed to the queue), rAF numbers beside it @param {any} page */
const cost = async (page) => {
	await debug(page, true);
	await page.waitForTimeout(3000);
	const d = await debug(page);
	const bound = await page.evaluate(async () => {
		const v = await window.__tp.test.v1.cinematicState.cinematicView();
		const g = v.cinematicLiveForTest();
		const q = g.r.backend.device.queue;
		const once = async () => {
			const t0 = performance.now();
			for (let i = 0; i < 30; i++) {
				g.water?.scan();
				g.water?.beforeRender();
				g.built.render();
				g.water?.afterRender();
			}
			await q.onSubmittedWorkDone();
			return (performance.now() - t0) / 30;
		};
		await once();
		const runs = [await once(), await once(), await once()].sort((a, b) => a - b);
		return runs[1];
	});
	return { n: d.frames.n, median: +d.frames.median.toFixed(2), p95: +d.frames.p95.toFixed(2), bound: +bound.toFixed(2), scanMs: +(d.water?.scanMs ?? 0).toFixed(3), quality: d.quality };
};

/** @param {any} page */
const toggle = async (page, want) => {
	await page.click('#cinematic-toggle');
	await waitMode(page, want, `the view went ${want}`);
};

const png = (url) => Buffer.from(url.split(',')[1], 'base64');

/** two PNGs side by side @param {any} page @param {string[]} urls */
const sideBySide = (page, urls) =>
	page.evaluate(
		async ({ urls, W, H }) => {
			const c = document.createElement('canvas');
			c.width = W * urls.length + 8 * (urls.length - 1);
			c.height = H;
			const x = c.getContext('2d');
			x.fillStyle = '#111';
			x.fillRect(0, 0, c.width, c.height);
			for (const [i, url] of urls.entries()) {
				const img = new Image();
				img.src = url;
				await img.decode();
				x.drawImage(img, i * (W + 8), 0, W, H);
			}
			return c.toDataURL('image/png');
		},
		{ urls, W, H }
	);

/** @type {Record<string, any>} */
const summary = {};

/** @param {any} browser @param {string} slug @param {boolean} first */
async function oneScene(browser, slug, first) {
	const out = path.join(OUT, slug);
	fs.mkdirSync(out, { recursive: true });
	const row = (summary[slug] = { slug });
	const P = await h.setupPage(browser, slug, { context: { viewport: { width: 1440, height: 900 } }, storage: STORAGE });
	const page = P.page;
	try {
		if (!(await page.evaluate(() => !!navigator.gpu))) return h.check(true, `${slug}: SKIPPED, this browser has no WebGPU`);
		if (!(await page.evaluate(() => window.__tp.test.v1.cinematicState.probeCinematic()))) return h.check(true, `${slug}: SKIPPED, the view is not offered here (${(await state(page)).why})`);
		await page.evaluate((q) => window.__tp.test.v1.cinematicState.setCinematicQuality(q), QUALITY);

		// ---- 0. the scene, its water ready ------------------------------------------------------------------------
		const loaded = await page.evaluate(async (slug) => {
			const st = window.__tp.test.v1;
			st.sceneSwitch?.modulesOnOpen?.set('keep');
			await st.sceneTemplates.loadTemplatesIndex(true);
			const list = [];
			for (const k of ['templates', 'examples', 'games']) st.sceneTemplates[k]?.subscribe((v) => list.push(...(v || [])))();
			const entry = list.find((x) => x.slug === slug);
			if (!entry) return false;
			return !!(await st.sceneTemplates.loadRemoteScene(entry));
		}, slug);
		h.check(loaded, `${slug}: 0. the template loaded`);
		if (!loaded) return;
		/** @type {any} */
		let wd = null;
		await h.eventually(
			() => page.evaluate(() => window.__tp.test.v1.waterRuntime.waterDebug()).then((d) => (wd = d)),
			(d) => d.volumes > 0 && d.entries.every((e) => e.ready),
			`${slug}: the water's programs are ready`,
			90000
		);
		row.volumes = wd.volumes;
		row.shapes = wd.entries.map((e) => e.shape);
		row.tier = wd.tier;
		await page.waitForTimeout(4000);
		const held = await page.evaluate(() => {
			const s = window.__tp.test.v1;
			window.__parkedTasks = s.moduleSDK.moduleFrameTasks.splice(0);
			s.flowPaused.set({ paused: true, reason: 'cinematic-water: time held' });
			s.waterRuntime.freezeWaterClock(s.waterRuntime.waterClock());
			return s.waterRuntime.waterDebug().entries.filter((e) => e.visible).length;
		});
		h.check(held > 0, `   ${slug}: time held, ${held} of ${wd.volumes} water volume(s) drawn (${row.shapes.join(', ')}; tier ${wd.tier})`);

		// ---- 1. the standard view ---------------------------------------------------------------------------------
		const sheet = { gl: await grab(page, 'gl:all', false) };
		await page.waitForTimeout(500);
		await grab(page, 'gl:again', false);
		await showWater(page, false);
		sheet.glDry = await grab(page, 'gl:-water', false);
		await showWater(page, true);

		// ---- 2. the Cinematic view --------------------------------------------------------------------------------
		await toggle(page, 'on');
		const d0 = await debug(page);
		row.quality = d0.quality;
		row.water = d0.water;
		const surfaces = wd.entries.filter((e) => e.visible).length;
		const bodies = wd.entries.filter((e) => e.visible && e.body).length;
		h.check(d0.errors.length === 0, `${slug}: 2. the view is on (${d0.quality}), no errors (${JSON.stringify(d0.errors).slice(0, 400)})`);
		h.check(!!d0.water && d0.water.surfaces === surfaces && d0.water.bodies === bodies && !d0.water.errors.length, `   ${slug}: every surface and tank body drawn through TSL (${JSON.stringify(d0.water)}; want ${surfaces} surfaces, ${bodies} bodies)`);
		const chip = (await state(page)).notShown;
		row.chip = chip;
		h.check(!/Water/.test(chip), `   ${slug}: "Water" is not in the "Not shown" chip ("${chip}")`);
		sheet.view = await grab(page, 'view:all', true);
		await grab(page, 'view:again', true);
		await showWater(page, false);
		sheet.viewDry = await grab(page, 'view:-water', true);
		await showWater(page, true);
		await grab(page, 'view:all', true);

		// ---- 3. the water agrees ----------------------------------------------------------------------------------
		const r = await compare(page);
		fs.writeFileSync(path.join(out, 'mask-water.png'), png(r.maskUrl));
		delete r.maskUrl;
		row.compare = r;
		const near = r.glCentre && r.viewCentre ? Math.hypot(r.glCentre[0] - r.viewCentre[0], r.glCentre[1] - r.viewCentre[1]) : 999;
		h.check(r.gl > 200 && r.overlapOfGl >= 0.7 && r.overlapOfView >= 0.6 && near < 25, `${slug}: 3. the view draws the water where the standard view does (px ${r.gl} / ${r.view}, shared ${r.overlapOfGl} of gl / ${r.overlapOfView} of view, centres ${JSON.stringify(r.glCentre)} vs ${JSON.stringify(r.viewCentre)})`);
		// The view lights the scene itself (GI, AO, bloom, its own tone path), so its pixels differ from the standard
		// view everywhere; the water must not differ by more than that plus WATER_TOL (mean |delta| per channel, 0-255)
		const tol = Number(process.env.WATER_TOL || 18);
		h.check(r.waterDelta != null && r.waterDelta <= (r.restDelta ?? 0) + tol, `   ${slug}: the water's colour matches as well as the rest of the image (mean |delta| water ${r.waterDelta}, rest ${r.restDelta}, tolerance rest + ${tol}; water luma ${JSON.stringify(r.waterLuma)} standard / Cinematic)`);

		// ---- 4. under the surface (first scene) -------------------------------------------------------------------
		if (first) {
			const placed = await page.evaluate(() => {
				const s = window.__tp.test.v1;
				let g, cam;
				s.objectsGroup.subscribe((x) => (g = x))();
				s.globalCamera.subscribe((x) => (cam = x))();
				let w = null;
				g.traverse((o) => {
					if (!w && o.userData?.water && o.isMesh) w = o;
				});
				if (!w) return null;
				w.updateMatrixWorld(true);
				w.geometry.computeBoundingBox();
				const b = w.geometry.boundingBox.clone().applyMatrix4(w.matrixWorld);
				const c = b.getCenter(cam.position.clone());
				window.__camSaved = { p: cam.position.clone(), q: cam.quaternion.clone() };
				// inside, a third of the way up, looking along the tank's long side
				const lx = b.max.x - b.min.x, lz = b.max.z - b.min.z;
				cam.position.set(c.x - (lx >= lz ? lx * 0.3 : 0), b.min.y + (b.max.y - b.min.y) * 0.35, c.z - (lz > lx ? lz * 0.3 : 0));
				cam.lookAt(c.x + (lx >= lz ? lx : 0), b.min.y + (b.max.y - b.min.y) * 0.35, c.z + (lz > lx ? lz : 0));
				cam.updateMatrixWorld();
				window.__camUnder = { p: cam.position.clone(), q: cam.quaternion.clone() };
				return [cam.position.x, cam.position.y, cam.position.z].map((v) => +v.toFixed(2));
			});
			for (let i = 0; i < 10; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
			const du = await debug(page);
			sheet.viewUnder = await grab(page, 'view:under', true);
			h.check(!!placed && du.water?.underwater === true && du.errors.length === 0, `${slug}: 4. camera under the surface at ${JSON.stringify(placed)}: the view knows (${JSON.stringify(du.water)})`);
			row.underwater = { at: placed, view: du.water };
		}

		// ---- 5. frame cost: the water drawn vs the C2-2 view (the plain stand-in) -------------------------------
		if (first) {
			await page.evaluate(() => {
				const s = window.__tp.test.v1;
				let cam;
				s.globalCamera.subscribe((x) => (cam = x))();
				if (window.__camSaved) {
					cam.position.copy(window.__camSaved.p);
					cam.quaternion.copy(window.__camSaved.q);
					cam.updateMatrixWorld();
				}
			});
			const withWater = await cost(page);
			await showWater(page, false);
			const dry = await cost(page);
			await showWater(page, true);
			await toggle(page, 'off');
			await page.evaluate(() => localStorage.setItem('debugCinematicNoWater', '1'));
			await toggle(page, 'on');
			const ds = await debug(page);
			const standIn = await cost(page);
			const chipS = (await state(page)).notShown;
			await toggle(page, 'off');
			await page.evaluate(() => localStorage.removeItem('debugCinematicNoWater'));
			await toggle(page, 'on');
			const factor = standIn.bound > 0 ? +(withWater.bound / standIn.bound).toFixed(2) : null;
			const adapter = d0.adapter ? `${d0.adapter.vendor} ${d0.adapter.architecture} ${d0.adapter.description}`.trim() : 'unknown';
			row.cost = { adapter, withWater, dry, standIn, factor };
			h.check(withWater.n > 20 && withWater.bound > 0 && !ds.water && /Water/.test(chipS), `${slug}: 5. frame cost (${adapter}, ${withWater.quality}): GPU-bound ${withWater.bound} ms with the water drawn, ${standIn.bound} ms in the C2-2 view (stand-in, chip "${chipS}"), ${dry.bound} ms with no water; factor ${factor}; rAF median ${withWater.median} / ${standIn.median} ms; water scan ${withWater.scanMs} ms`);
			if (factor != null && factor > 1.5) h.check(true, `   ${slug}: NOTE the factor is over 1.5x (report it)`);
		}

		// ---- 6. out of the view: every water material and placeholder as it was ----------------------------------
		await toggle(page, 'off');
		const back = await page.evaluate(() => {
			const s = window.__tp.test.v1;
			let g, sc;
			s.objectsGroup.subscribe((x) => (g = x))();
			s.globalScene.subscribe((x) => (sc = x))();
			let twins = 0, hiddenWater = 0, placeholders = 0, hiddenPlaceholders = 0;
			sc.traverse((o) => {
				if (o.name === 'cinematic-water') twins++;
				if (/^water-(surface|body|underwater)$/.test(o.material?.name ?? '') && o.material.visible === false) hiddenWater++;
			});
			g.traverse((o) => {
				if (o.userData?.water && o.isMesh) {
					placeholders++;
					if (o.material?.name === 'cinematic-water-hidden' || o.material?.isNodeMaterial) hiddenPlaceholders++;
				}
			});
			return { twins, hiddenWater, placeholders, hiddenPlaceholders };
		});
		h.check(back.twins === 0 && back.hiddenWater === 0 && back.hiddenPlaceholders === 0, `${slug}: 6. off again: no twins, every water material visible, every placeholder its own (${JSON.stringify(back)})`);
		await page.waitForTimeout(600);
		sheet.after = await grab(page, 'gl:after', false);
		const zero = await page.evaluate(({ W, H }) => {
			const a = window.__wShots['gl:all'], b = window.__wShots['gl:after'];
			let n = 0;
			for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 36) n++;
			return n;
		}, { W, H });
		const noise = row.compare?.noise?.[0] ?? 0;
		row.zeroChange = { changed: zero, noise };
		h.check(zero <= Math.max(60, noise * 3), `   ${slug}: the standard view after the trip is the standard view before it (${zero} px changed; noise floor ${noise} px)`);
		// the standard view from the same spot under the surface, for the sheet and the mean colour
		if (first && sheet.viewUnder) {
			const glUnder = await page.evaluate(() => {
				const s = window.__tp.test.v1;
				let cam;
				s.globalCamera.subscribe((x) => (cam = x))();
				cam.position.copy(window.__camUnder.p);
				cam.quaternion.copy(window.__camUnder.q);
				cam.updateMatrixWorld();
				return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(s.waterRuntime.waterDebug().underwater))));
			});
			sheet.glUnder = await grab(page, 'gl:under', false);
			const tone = await page.evaluate(({ W, H }) => {
				const mean = (d) => {
					const m = [0, 0, 0];
					for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) m[k] += d[i + k];
					return m.map((v) => +(v / (W * H)).toFixed(1));
				};
				return { gl: mean(window.__wShots['gl:under']), view: mean(window.__wShots['view:under']) };
			}, { W, H });
			const dm = Math.max(...tone.gl.map((v, k) => Math.abs(v - tone.view[k])));
			row.underwater = { ...row.underwater, gl: glUnder, tone };
			h.check(!!glUnder && dm <= Number(process.env.WATER_UNDER_TOL || 40), `   ${slug}: under the surface both views are tinted alike (mean RGB standard ${JSON.stringify(tone.gl)}, Cinematic ${JSON.stringify(tone.view)}; largest channel gap ${dm.toFixed(1)})`);
			fs.writeFileSync(path.join(out, '06-sheet-under.png'), png(await sideBySide(page, [sheet.glUnder, sheet.viewUnder])));
		}

		// ---- evidence ---------------------------------------------------------------------------------------------
		fs.writeFileSync(path.join(out, '01-standard.png'), png(sheet.gl));
		fs.writeFileSync(path.join(out, '02-cinematic.png'), png(sheet.view));
		fs.writeFileSync(path.join(out, '03-standard-after.png'), png(sheet.after));
		fs.writeFileSync(path.join(out, '00-sheet.png'), png(await sideBySide(page, [sheet.gl, sheet.view])));
		fs.writeFileSync(path.join(out, '04-sheet-no-water.png'), png(await sideBySide(page, [sheet.glDry, sheet.viewDry])));
		if (sheet.viewUnder) fs.writeFileSync(path.join(out, '05-cinematic-under.png'), png(sheet.viewUnder));
		fs.writeFileSync(path.join(out, 'numbers.json'), JSON.stringify(row, null, 2));
	} finally {
		await page.context().close().catch(() => {});
	}
}

h.run(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await h.launch({ args: ARGS });
	for (const [i, slug] of SCENES.entries()) {
		const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), SCENE_MS));
		const res = await Promise.race([oneScene(browser, slug, i === 0).then(() => 'done'), timer]);
		if (res === 'timeout') h.check(false, `${slug}: did not finish within ${SCENE_MS / 1000} s`);
	}
	fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
	console.log('  evidence: ' + OUT);
	await h.finish(browser);
});
