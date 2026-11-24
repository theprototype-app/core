// 100 C2-2 / C2-4 — PARTICLES, BURSTS, BUBBLES AND VERTEX DEFORMERS IN THE CINEMATIC VIEW, end to end.
//
// One scene with each piece: a point-mode emitter (fire), a trails emitter, a confetti burst (the effectburst path),
// a bubble emitter (userData.bubbles), and three deformed meshes (windsway, bodywave, jiggle flow nodes). Time is held
// (flows paused, the water clock frozen, the burst frame task parked) so the standard view and the Cinematic view are
// photographed at the SAME moment from the same camera. For each piece the suite measures what it adds to the image
// (the pixels that change when that piece alone is hidden) in both views, and asks the two footprints to agree.
// Then: nothing of it is in the "Not shown" chip, no GPU error, the frame cost with and without, motion resumes with
// the clock, and leaving the view puts every source material back.
//
// GPU: real WebGPU wants the Deck (desk "local") or the PC through a remote slot; SwiftShader passes with
// debugCinematicSoftware=1 (slow, same code). Evidence: test-results/100-cover-fx/ (sheet + numbers).
//
//   APP_URL=https://theprototype.app:7040/ E2E_PC= e2e-slot --local --dev $PWD 7040 -- env E2E_GPU=1 node tests/e2e/cinematic-fx.test.cjs
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const ARGS = [...(process.env.E2E_GPU === '1' ? h.GPU_ARGS : []), '--enable-unsafe-webgpu', '--enable-features=Vulkan'];
const STORAGE = { debugCinematicSoftware: '1' };
const OUT = process.env.FX_OUT || path.join(__dirname, '..', '..', 'test-results', '100-cover-fx');
const W = 480;
const H = 270;

/** @param {any} page */
const state = (page) => page.evaluate(() => { let s; window.__tp.test.v1.cinematicState.cinematicState.subscribe((v) => (s = v))(); return s; });
/** @param {any} page */
const debug = (page, reset = false) => page.evaluate(async (r) => (await window.__tp.test.v1.cinematicState.cinematicView()).cinematicDebug(r), reset);
/** @param {any} page @param {string} want @param {string} label */
const waitMode = (page, want, label, ms = 90000) => h.eventually(async () => (await state(page)).mode, (m) => m === want, label, ms);

h.run(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await h.launch({ args: ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } }, storage: STORAGE });
	const page = A.page;
	if (!(await page.evaluate(() => !!navigator.gpu))) {
		h.check(true, 'SKIPPED: this browser has no WebGPU');
		return h.finish(browser);
	}
	const offered = await page.evaluate(() => window.__tp.test.v1.cinematicState.probeCinematic());
	if (!offered) {
		h.check(true, `SKIPPED: the view is not offered here (${(await state(page)).why})`);
		return h.finish(browser);
	}
	await page.evaluate(() => window.__tp.test.v1.cinematicState.setCinematicQuality('basic'));

	// ---- 0. the scene ----------------------------------------------------------------------------------------------
	const ids = await page.evaluate(() => {
		const s = window.__tp.test.v1;
		const mk = (cmd, at) => s.addObjects.spawnAtPoint(cmd, at)?.uuid;
		const out = {
			floor: mk('/create Box 1 1 1', [0, -0.05, 0]),
			fire: mk('/create Box 1 1 1', [-3.2, 0.2, 0]),
			trails: mk('/create Box 1 1 1', [-1.4, 0.2, 0]),
			bubbles: mk('/create Box 1 1 1', [0.4, 0.15, 0]),
			plant: mk('/create Box 1 1 1', [2, 0.9, 0]),
			fish: mk('/create Box 1 1 1', [3.6, 1.2, 0]),
			jelly: mk('/create Sphere 0.5', [5, 0.6, 0])
		};
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const o = (k) => g.getObjectByProperty('uuid', out[k]);
		o('floor').scale.set(14, 0.1, 6);
		o('fire').scale.set(0.4, 0.4, 0.4);
		o('trails').scale.set(0.4, 0.4, 0.4);
		o('bubbles').scale.set(0.6, 0.3, 0.6);
		o('plant').scale.set(0.2, 1.8, 0.2);
		o('fish').scale.set(0.3, 0.3, 1.6);
		for (const k of Object.keys(out)) o(k).updateMatrix();
		const fire = s.particlePresets.particlePreset('fire');
		o('fire').userData.particles = { ...fire, count: 200 };
		o('trails').userData.particles = { ...s.particlePresets.particlePreset('sparkles'), render: 'trails', trail: 0.5, count: 60, speed: 2, sizeStart: 0.06, sizeEnd: 0.02 };
		o('bubbles').userData.bubbles = { enabled: true, count: 60, height: 2.2, sizeMin: 0.05, sizeMax: 0.1, rate: 30 };
		const node = (id, type, data) => s.nodesHandler.createFlowNode({ id, type, position: { x: 0, y: 0 }, data: { type, ...data } });
		const edge = (a, b) => s.nodesHandler.createFlowEdge({ id: 'e-' + a + '-' + b, source: a, target: b });
		node('ws', 'windsway', { mode: 'plant', anchor: 'bottom', strength: 0.9, frequency: 0.6, gust: 0.5 });
		node('selPlant', 'objectselector', { selected: out.plant });
		node('bw', 'bodywave', { amplitude: 0.45, wavelength: 1, frequency: 1.2, stiffness: 0 });
		node('selFish', 'objectselector', { selected: out.fish });
		node('jg', 'jiggle', { amplitude: 0.4, frequency: 3, wind: 1, maxOffset: 0.35 });
		node('selJelly', 'objectselector', { selected: out.jelly });
		edge('ws', 'selPlant');
		edge('bw', 'selFish');
		edge('jg', 'selJelly');
		// the camera: the whole row, slightly from above
		let cam, ctl;
		s.globalCamera.subscribe((x) => (cam = x))();
		s.orbitControls?.subscribe?.((x) => (ctl = x))();
		cam.position.set(0.9, 2.6, 7.2);
		if (ctl?.target) {
			ctl.target.set(0.9, 0.9, 0);
			ctl.update?.();
		}
		cam.lookAt(0.9, 0.9, 0);
		cam.updateMatrixWorld();
		return out;
	});
	h.check(Object.values(ids).every(Boolean), `0. the scene: ${Object.keys(ids).join(', ')}`);
	// the effects have started (emitters, bubbles, deformers on their materials)
	/** @type {any} */
	let started = null;
	await h.eventually(
		() =>
			page.evaluate((ids) => {
				const s = window.__tp.test.v1;
				let g, sc;
				s.objectsGroup.subscribe((x) => (g = x))();
				s.globalScene.subscribe((x) => (sc = x))();
				let particles = 0, bubbles = 0;
				sc.traverse((o) => {
					if (/^particles-/.test(o.name)) particles++;
					if (o.name === 'water-bubbles' && o.visible) bubbles++;
				});
				const deformed = ['plant', 'fish', 'jelly'].filter((k) => typeof g.getObjectByProperty('uuid', ids[k])?.material?.customProgramCacheKey === 'function' && /\|/.test(g.getObjectByProperty('uuid', ids[k]).material.customProgramCacheKey()));
				return { particles, bubbles, deformed: deformed.length };
			}, ids).then((r) => (started = r)),
		(r) => r.particles >= 2 && r.bubbles >= 1 && r.deformed === 3,
		'the emitters, the bubbles and three deformers are running',
		30000
	);
	h.check(true, `   running: ${JSON.stringify(started)}`);

	// ---- 1. hold time; fire the burst ------------------------------------------------------------------------------
	await page.waitForTimeout(1800); // emitters fill their life cycle; deformers swing out
	const held = await page.evaluate(() => {
		const s = window.__tp.test.v1;
		const fx = s.gameKit.effectsBurst;
		fx.burst([-0.5, 1.6, 0.8], { kind: 'confetti' });
		for (let i = 0; i < 18; i++) fx.stepBursts(1 / 60);
		// park every module frame task (the burst's own stepping) and the flow tick, freeze the water clock
		window.__parkedTasks = s.moduleSDK.moduleFrameTasks.splice(0);
		s.flowPaused.set({ paused: true, reason: 'cinematic-fx: time held' });
		s.waterRuntime.freezeWaterClock(s.waterRuntime.waterClock());
		return { live: fx.burstDebug().live.length };
	});
	h.check(held.live === 1, `1. time held with a confetti burst in the air (${held.live} live)`);

	/** in-page: capture (GL or view) into window.__fxShots[name] (480x270 RGBA) and return a PNG */
	const grab = (name, view) =>
		page.evaluate(
			async ({ name, view, W, H }) => {
				const s = window.__tp.test.v1;
				const c = document.createElement('canvas');
				c.width = W;
				c.height = H;
				const x = c.getContext('2d');
				if (view) {
					const v = await s.cinematicState.cinematicView();
					// TRAA settles over frames: let the view draw a while after a change
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
					x.drawImage(r.domElement, 0, 0, W, H);
				}
				window.__fxShots = window.__fxShots || {};
				window.__fxShots[name] = x.getImageData(0, 0, W, H).data;
				return c.toDataURL('image/png');
			},
			{ name, view, W, H }
		);

	/** in-page: hide / show one piece. Hidden the way each runtime leaves alone while time is held. */
	const PIECES = ['fire', 'trails', 'burst', 'bubbles', 'plant', 'fish', 'jelly'];
	const show = (piece, on) =>
		page.evaluate(
			({ piece, on, ids }) => {
				const s = window.__tp.test.v1;
				let g, sc;
				s.objectsGroup.subscribe((x) => (g = x))();
				s.globalScene.subscribe((x) => (sc = x))();
				const byUuid = (u) => g.getObjectByProperty('uuid', u);
				if (piece === 'fire' || piece === 'trails') {
					const key = 'particles-ud:' + ids[piece];
					const p = sc.getObjectByName(key);
					if (p) p.visible = on;
					return !!p;
				}
				if (piece === 'burst') {
					let n = 0;
					sc.traverse((o) => {
						if (/^effects-burst-/.test(o.name) && o.geometry?.drawRange?.count > 0) {
							o.visible = on;
							n++;
						}
					});
					return n > 0;
				}
				if (piece === 'bubbles') {
					const o = byUuid(ids.bubbles);
					o.userData.bubbles = { ...o.userData.bubbles, enabled: on };
					return true;
				}
				const o = byUuid(ids[piece]);
				o.visible = on;
				return !!o;
			},
			{ piece, on, ids }
		);

	/** in-page: the pixels piece P adds (all vs P hidden), compared GL vs view */
	const compare = (piece) =>
		page.evaluate(
			({ piece, W, H, PIECES }) => {
				const S = window.__fxShots;
				const mask = (a, b) => {
					const m = new Uint8Array(W * H);
					for (let i = 0, j = 0; i < a.length; i += 4, j++) m[j] = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 36 ? 1 : 0;
					return m;
				};
				// a footprint grown by 2 px (sprites differ by a pixel of filtering between the two renderers)
				const grow = (m) => {
					const o = new Uint8Array(W * H);
					for (let y = 0; y < H; y++)
						for (let x = 0; x < W; x++) {
							if (!m[y * W + x]) continue;
							for (let dy = -2; dy <= 2; dy++)
								for (let dx = -2; dx <= 2; dx++) {
									const X = x + dx, Y = y + dy;
									if (X >= 0 && Y >= 0 && X < W && Y < H) o[Y * W + X] = 1;
								}
						}
					return o;
				};
				const g = mask(S['gl:all'], S['gl:-' + piece]);
				const v = mask(S['view:all'], S['view:-' + piece]);
				// pixels inside ANOTHER piece's own footprint (grown 3 px) are not this piece's, in either view: the jiggle
				// spring swings in the wind between two shots (tickSim, not held by the flow pause), and one PC run read
				// the jelly's moving edge as 41 px of the burst's centre (fx11). The same rule on both sides.
				const other = new Uint8Array(W * H);
				for (const q of PIECES) {
					if (q === piece) continue;
					for (const [a, b] of [[S['gl:all'], S['gl:-' + q]], [S['view:all'], S['view:-' + q]]]) {
						const m = mask(a, b);
						for (let y = 0; y < H; y++)
							for (let x = 0; x < W; x++) {
								if (!m[y * W + x]) continue;
								for (let dy = -3; dy <= 3; dy++)
									for (let dx = -3; dx <= 3; dx++) {
										const X = x + dx, Y = y + dy;
										if (X >= 0 && Y >= 0 && X < W && Y < H) other[Y * W + X] = 1;
									}
							}
					}
				}
				for (let j = 0; j < W * H; j++) {
					if (window.__fxNoiseGl?.[j] || other[j]) g[j] = 0;
					if (window.__fxNoise?.[j] || other[j]) v[j] = 0;
				}
				// debug picture: gl footprint red, view footprint green, the noise floor and the other pieces blue
				const mc = document.createElement('canvas');
				mc.width = W;
				mc.height = H;
				const x = mc.getContext('2d');
				const img = x.createImageData(W, H);
				for (let j = 0; j < W * H; j++) {
					img.data[j * 4] = g[j] * 255;
					img.data[j * 4 + 1] = v[j] * 255;
					img.data[j * 4 + 2] = window.__fxNoise?.[j] || other[j] ? 160 : 0;
					img.data[j * 4 + 3] = 255;
				}
				x.putImageData(img, 0, 0);
				const maskUrl = mc.toDataURL('image/png');
				const gg = grow(g), vg = grow(v);
				// the mean luma the piece adds where it is drawn (a sprite drawn black adds a negative number)
				const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
				const lift = (all, minus, m) => {
					let sum = 0, n = 0;
					for (let j = 0; j < m.length; j++) if (m[j]) { sum += lum(all, j * 4) - lum(minus, j * 4); n++; }
					return n ? +(sum / n).toFixed(1) : 0;
				};
				const glLift = lift(S['gl:all'], S['gl:-' + piece], g);
				const viewLift = lift(S['view:all'], S['view:-' + piece], v);
				let ga = 0, va = 0, gIn = 0, vIn = 0;
				let gx = 0, gy = 0, vx = 0, vy = 0;
				for (let i = 0; i < W * H; i++) {
					if (g[i]) { ga++; gx += i % W; gy += (i / W) | 0; if (vg[i]) gIn++; }
					if (v[i]) { va++; vx += i % W; vy += (i / W) | 0; if (gg[i]) vIn++; }
				}
				const c = (sx, sy, n) => (n ? [Math.round(sx / n), Math.round(sy / n)] : null);
				return { maskUrl, glLift, viewLift, gl: ga, view: va, glCovered: ga ? +(gIn / ga).toFixed(2) : 0, viewCovered: va ? +(vIn / va).toFixed(2) : 0, glCentre: c(gx, gy, ga), viewCentre: c(vx, vy, va) };
			},
			{ piece, W, H, PIECES }
		);

	// ---- 2. the standard view, every piece and every piece-hidden ---------------------------------------------------
	const sheet = { gl: await grab('gl:all', false) };
	await page.waitForTimeout(700);
	await grab('gl:again', false);
	for (const p of PIECES) {
		await show(p, false);
		await page.waitForTimeout(120); // the water tick hides the bubble mesh on its next frame
		await grab('gl:-' + p, false);
		await show(p, true);
		await page.waitForTimeout(120);
	}
	await grab('gl:all', false);

	// ---- 3. into the view ------------------------------------------------------------------------------------------
	await page.click('#cinematic-toggle');
	await waitMode(page, 'on', 'the view came on');
	const d0 = await debug(page);
	h.check(d0.errors.length === 0, `3. the view is on, no errors (${JSON.stringify(d0.errors).slice(0, 400)})`);
	h.check(!!d0.fx && d0.fx.particles === 2 && d0.fx.bursts >= 1 && d0.fx.bubbles === 1 && d0.fx.deform === 3 && !d0.fx.errors.length, `   drawn through TSL: ${JSON.stringify(d0.fx)}`);
	const chip = (await state(page)).notShown;
	h.check(!/Particles|Jiggle and sway/.test(chip), `   none of them is in the "Not shown" chip ("${chip}")`);
	sheet.view = await grab('view:all', true);
	// the noise floor: two shots of the same held moment (anything that changes here is not a piece's footprint)
	await grab('view:again', true);
	// the noise floor in each view: what changes between two shots of the same held moment (the jiggle spring keeps
	// swinging in the wind, a horizon line aliases). Those pixels, grown by 1 px, belong to no piece's footprint.
	const floor = await page.evaluate(({ W, H }) => {
		const noise = (a, b) => {
			const m = new Uint8Array(W * H);
			let n = 0;
			for (let i = 0, j = 0; i < a.length; i += 4, j++)
				if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 36) {
					n++;
					const x = j % W, y = (j / W) | 0;
					for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H) m[(y + dy) * W + x + dx] = 1;
				}
			return { m, n };
		};
		const g = noise(window.__fxShots['gl:all'], window.__fxShots['gl:again']);
		const v = noise(window.__fxShots['view:all'], window.__fxShots['view:again']);
		window.__fxNoiseGl = g.m;
		window.__fxNoise = v.m;
		return { gl: g.n, view: v.n };
	}, { W, H });
	h.check(true, `   noise floor: ${floor.gl} px (standard) / ${floor.view} px (Cinematic) change between two shots of the same held moment`);
	for (const p of PIECES) {
		await show(p, false);
		await page.waitForTimeout(120);
		await grab('view:-' + p, true);
		await show(p, true);
		await page.waitForTimeout(120);
	}
	await grab('view:all', true);

	// ---- 4. footprints agree
	// The view's footprint runs larger (measured 1.0-2.0x): its bloom lays a halo round every bright sprite, which the
	// standard view does not draw. So the size bound is loose (0.5-3x) and the two coverage numbers carry the claim:
	// nearly every standard-view pixel is inside the view's footprint, and most of the view's lie within 2 px of it. -----------------------------------------------------------------------------------------
	/** @type {Record<string, any>} */
	const rows = {};
	for (const p of PIECES) {
		const r = await compare(p);
		fs.writeFileSync(path.join(OUT, `mask-${p}.png`), Buffer.from(r.maskUrl.split(',')[1], 'base64'));
		delete r.maskUrl;
		rows[p] = r;
		const ratio = r.gl ? r.view / r.gl : 0;
		const near = r.glCentre && r.viewCentre ? Math.hypot(r.glCentre[0] - r.viewCentre[0], r.glCentre[1] - r.viewCentre[1]) : 999;
		h.check(
			r.gl > 30 && ratio > 0.5 && ratio < 3 && r.glCovered >= 0.6 && r.viewCovered >= 0.5 && near < 20,
			`4. ${p}: the view draws it where and as large as the standard view (px gl ${r.gl} / view ${r.view}, ratio ${ratio.toFixed(2)}, ` +
				`gl px inside the view's ${r.glCovered}, view px inside gl's ${r.viewCovered}, centres ${JSON.stringify(r.glCentre)} vs ${JSON.stringify(r.viewCentre)})`
		);
	}

	for (const p of ['fire', 'trails', 'bubbles']) {
		const r = rows[p];
		h.check(r.glLift > 0 && r.viewLift > 0.3 * r.glLift, `   ${p} lightens the image in both views, as much within a factor of 3 (mean luma +${r.glLift} standard, +${r.viewLift} Cinematic)`);
	}

	// ---- 5. the frame cost with and without the effects ----------------------------------------------------------
	// the rAF interval is capped by vsync; the GPU-bound number is 30 frames drawn back to back, timed to the queue
	const cost = async (label) => {
		await debug(page, true);
		await page.waitForTimeout(3000);
		const d = await debug(page);
		const bound = await page.evaluate(async () => {
			const v = await window.__tp.test.v1.cinematicState.cinematicView();
			const g = v.cinematicLiveForTest();
			const q = g.r.backend.device.queue;
			const once = async () => {
				const t0 = performance.now();
				for (let i = 0; i < 30; i++) g.built.render();
				await q.onSubmittedWorkDone();
				return (performance.now() - t0) / 30;
			};
			await once();
			const runs = [await once(), await once(), await once()].sort((a, b) => a - b);
			return runs[1];
		});
		return { label, n: d.frames.n, median: +d.frames.median.toFixed(2), p95: +d.frames.p95.toFixed(2), bound: +bound.toFixed(2), scanMs: +(d.fx?.scanMs ?? 0).toFixed(3) };
	};
	const withFx = await cost('with');
	for (const p of PIECES) await show(p, false);
	const without = await cost('without');
	for (const p of PIECES) await show(p, true);
	const adapter = d0.adapter ? `${d0.adapter.vendor} ${d0.adapter.architecture} ${d0.adapter.description}`.trim() : 'unknown';
	h.check(withFx.n > 20 && withFx.bound > 0, `5. frame cost (${adapter}): GPU-bound ${withFx.bound} ms with the effects, ${without.bound} ms with them hidden; rAF median ${withFx.median} / ${without.median} ms, p95 ${withFx.p95} / ${without.p95}; per-frame cover pass ${withFx.scanMs} ms`);

	// ---- 6. time runs again: the effects move in the view -------------------------------------------------------------
	await page.evaluate(() => {
		const s = window.__tp.test.v1;
		s.moduleSDK.moduleFrameTasks.push(...(window.__parkedTasks || []));
		s.flowRuntime.resumeFlowRuntime();
		s.waterRuntime.freezeWaterClock(null);
	});
	await grab('view:t0', true);
	await page.waitForTimeout(700);
	await grab('view:t1', true);
	const moved = await page.evaluate(({ W, H }) => {
		const a = window.__fxShots['view:t0'], b = window.__fxShots['view:t1'];
		let n = 0;
		for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 36) n++;
		return n / (W * H);
	}, { W, H });
	h.check(moved > 0.002, `6. with the clock running the effects move in the view (${(moved * 100).toFixed(2)} % of pixels changed in 0.7 s)`);
	const d1 = await debug(page);
	h.check(d1.errors.length === 0 && (await state(page)).mode === 'on', `   still on, no errors (${JSON.stringify(d1.errors).slice(0, 300)})`);

	// a burst fired while the view is on is drawn the frame it appears
	const late = await page.evaluate(async () => {
		const s = window.__tp.test.v1;
		s.gameKit.effectsBurst.burst([1, 1.5, 0], { kind: 'sparks' });
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		return (await s.cinematicState.cinematicView()).cinematicDebug().fx;
	});
	h.check(late.bursts >= 1, `   a burst fired with the view on gets its twin at once (${JSON.stringify(late)})`);

	// ---- 7. out of the view: every source as it was ------------------------------------------------------------------
	await page.click('#cinematic-toggle');
	await waitMode(page, 'off', 'the view went off');
	const back = await page.evaluate((ids) => {
		const s = window.__tp.test.v1;
		let g, sc;
		s.objectsGroup.subscribe((x) => (g = x))();
		s.globalScene.subscribe((x) => (sc = x))();
		let twins = 0, hiddenSources = 0, nodes = 0;
		sc.traverse((o) => {
			if (o.name === 'cinematic-fx') twins++;
			if ((/^particles-|^effects-burst-/.test(o.name) || o.name === 'water-bubbles') && o.material && o.material.visible === false) hiddenSources++;
		});
		for (const k of ['plant', 'fish', 'jelly']) if ('positionNode' in (g.getObjectByProperty('uuid', ids[k])?.material ?? {})) nodes++;
		return { twins, hiddenSources, nodes };
	}, ids);
	h.check(back.twins === 0 && back.hiddenSources === 0 && back.nodes === 0, `7. off again: no twins, every source material visible, no position nodes left (${JSON.stringify(back)})`);
	await page.waitForTimeout(600);
	sheet.after = await grab('gl:after', false);

	// ---- evidence ------------------------------------------------------------------------------------------------------
	const png = (url) => Buffer.from(url.split(',')[1], 'base64');
	fs.writeFileSync(path.join(OUT, '01-standard-view.png'), png(sheet.gl));
	fs.writeFileSync(path.join(OUT, '02-cinematic-view.png'), png(sheet.view));
	fs.writeFileSync(path.join(OUT, '03-standard-after.png'), png(sheet.after));
	const sideBySide = await page.evaluate(
		async ({ a, b, W, H }) => {
			const c = document.createElement('canvas');
			c.width = W * 2 + 8;
			c.height = H;
			const x = c.getContext('2d');
			x.fillStyle = '#111';
			x.fillRect(0, 0, c.width, c.height);
			for (const [i, url] of [a, b].entries()) {
				const img = new Image();
				img.src = url;
				await img.decode();
				x.drawImage(img, i * (W + 8), 0, W, H);
			}
			return c.toDataURL('image/png');
		},
		{ a: sheet.gl, b: sheet.view, W, H }
	);
	fs.writeFileSync(path.join(OUT, '00-sheet-standard-vs-cinematic.png'), png(sideBySide));
	fs.writeFileSync(path.join(OUT, 'fx-numbers.json'), JSON.stringify({ adapter, rows, cost: [withFx, without], moved, fx: d0.fx, chip }, null, 2));
	console.log('  evidence: ' + OUT);
	await h.finish(browser);
});
