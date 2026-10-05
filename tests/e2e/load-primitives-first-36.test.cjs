// 36 S5 / F21 — A SCENE SHOWS ITS PRIMITIVES FIRST; THE WATER COMES AFTER, OFF-FRAME.
//
// The user (2026-10-05): "Island Ocean's first load: show primitives/placeholders early and a clear
// progress indicator so it never looks idle … today it seems to load the water first; defer heavy
// work (water shaders/warm-up, sims) until after the placeholders are on screen."
//
// Measured on 1.23.0 with this suite (CPU x4, GPU): the water renderer created its surface the
// moment the ocean object arrived and compiled its programs INSIDE the first frame that drew the
// scene — the scene appeared all at once after that frame, water included.
//
//   1. From the click to the end the bar is up and says what it is doing (downloading / objects).
//   2. While the objects are being built the water is NOT drawn (no water program in the frame).
//   3. The first frames after the build draw the island and the ocean's own placeholder material
//      while the water's programs compile off-frame; then the water is drawn (ready within 8 s).
//   4. Fluid tanks: no fluid sim ticks while a load builds (Fluid tank toy).
//   Reported, not gated: the longest task of the load (before/after in the evidence table).
//
// SCENES_DIR = a scenes checkout at origin/main or later; SKIPS when Island Ocean is not there.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const SCENES_DIR = process.env.SCENES_DIR || '/home/deck/.code/theprototype-app/scenes';
const ISLAND = path.join(SCENES_DIR, 'examples/island-ocean/scene.tpscene');
const FLUID = path.join(SCENES_DIR, 'examples/fluid-tank-toy/scene.tpscene');
const CPU = Number(process.env.CPU || 4);
const SHOTS = process.env.SHOTS_DIR || '';

h.run(async () => {
	if (!fs.existsSync(ISLAND)) {
		console.log('SKIP: no ' + ISLAND);
		process.exit(0);
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	// THEME=light for the light-theme screenshots (the default is dark)
	const A = await h.setupPage(browser, 'A', process.env.THEME ? { storage: { theme: process.env.THEME } } : {});
	const page = A.page;
	const cdp = await page.context().newCDPSession(page);

	// a per-frame recorder: load phase, objects, water entries (visible / ready), fluid ticks
	await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		const s = w.__stores;
		w.__rec = { on: false, t0: 0, frames: [], longtasks: [] };
		new PerformanceObserver((l) => {
			if (w.__rec.on) for (const e of l.getEntries()) w.__rec.longtasks.push(Math.round(e.duration));
		}).observe({ type: 'longtask', buffered: false });
		const tick = () => {
			if (w.__rec.on) {
				let job, group;
				s.sceneLoader.sceneLoad.subscribe((v) => (job = v))();
				s.objectsGroup.subscribe((g) => (group = g))();
				const wd = s.waterRuntime.waterDebug();
				w.__rec.frames.push({
					t: Math.round(performance.now() - w.__rec.t0),
					phase: job ? job.phase : null,
					bar: !!document.querySelector('#scene-load-bar'),
					objs: group?.children.length ?? 0,
					held: s.sceneLoader.framesHeld(),
					water: wd.entries.map((e) => (e.visible ? 'V' : e.ready ? 'r' : '-')).join(''),
					fluid: s.sim.fluidDebug().length
				});
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});

	const load = async (file) => {
		const b64 = fs.readFileSync(file).toString('base64');
		await page.evaluate(async (b64) => {
			const w = /** @type {any} */ (window);
			const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
			const s = w.__stores;
			// the person route: the click claims the load, then the bytes arrive (as from the CDN)
			const job = s.sceneLoader.claimLoad('Island ocean');
			w.__rec = { ...w.__rec, on: true, t0: performance.now(), frames: [], longtasks: [] };
			await new Promise((r) => setTimeout(r, 300));
			const payload = await s.sessions.readSessionZip(bytes.buffer);
			s.sessions.requestLoadPayload(payload, { job });
		}, b64);
	};

	await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
	await load(ISLAND);
	if (SHOTS) {
		for (let i = 0; i < 8; i++) {
			await page.screenshot({ path: SHOTS + '-' + String(i).padStart(2, '0') + '.png' }).catch(() => {});
			await page.waitForTimeout(350);
		}
	}
	await h.eventually(
		() => page.evaluate(() => /** @type {any} */ (window).__rec.frames.slice(-1)[0]),
		(f) => !!f && f.phase === null && f.water.includes('V'),
		'the island loads and its water is drawn',
		30000
	);
	await page.waitForTimeout(500);
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
	const rec = await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__rec.on = false;
		return w.__rec;
	});
	/** @type {any[]} */
	const frames = rec.frames;
	const compact = [];
	for (const f of frames) {
		const key = JSON.stringify({ ...f, t: 0 });
		if (!compact.length || compact[compact.length - 1].key !== key) compact.push({ key, f });
	}
	console.log('TIMELINE (ms phase bar objs held water fluid):');
	for (const { f } of compact) console.log(`  ${f.t}  ${f.phase} bar=${f.bar} objs=${f.objs} held=${f.held} water=${f.water || 'none'} fluid=${f.fluid}`);
	console.log('LONGTASKS ' + JSON.stringify(rec.longtasks) + ' max=' + Math.max(0, ...rec.longtasks));

	const loading = frames.filter((f) => f.phase !== null);
	h.check(loading.length > 0 && loading.every((f) => f.bar || f.t < 300), '1. the bar is up for the whole load (after its 250 ms grace)');
	h.check(loading.some((f) => f.phase === 'fetching'), '1b. it says "downloading" before the bytes are in');
	const buildingWater = frames.filter((f) => (f.phase === 'objects' || f.phase === 'preparing') && f.water.includes('V'));
	h.check(buildingWater.length === 0, '2. the water is not drawn while the objects are built (' + buildingWater.length + ' frames)');
	const firstWhole = frames.find((f) => f.objs >= 31 && !f.held && f.phase === null);
	h.check(!!firstWhole && !firstWhole.water.includes('V'), '3a. the first full frames show the island with the ocean placeholder, water still compiling (' + JSON.stringify(firstWhole) + ')');
	const waterAt = frames.find((f) => f.water.includes('V'));
	h.check(!!waterAt && !!firstWhole && waterAt.t >= firstWhole.t, '3b. then the water is drawn (at ' + waterAt?.t + ' ms, primitives at ' + firstWhole?.t + ' ms)');
	h.check(!!waterAt && waterAt.t - (firstWhole?.t ?? 0) < 8000, '3c. the water arrives within 8 s of the primitives');

	// 4. fluid sims wait for the build
	if (fs.existsSync(FLUID)) {
		await load(FLUID);
		await h.eventually(
			() => page.evaluate(() => /** @type {any} */ (window).__rec.frames.slice(-1)[0]),
			(f) => !!f && f.phase === null,
			'the fluid tank toy loads',
			30000
		);
		await page.waitForTimeout(1500);
		const fr = await page.evaluate(() => /** @type {any} */ (window).__rec.frames);
		const simDuringBuild = fr.filter((f) => f.phase && f.phase !== 'models' && f.fluid > 0);
		h.check(simDuringBuild.length === 0, '4. no fluid tank runs while the scene builds (' + simDuringBuild.length + ' frames)');
		h.check(fr.slice(-1)[0].fluid > 0 || fr.slice(-1)[0].fluid === null, '4b. the tanks start once it is in (' + fr.slice(-1)[0].fluid + ')');
	}

	h.check(h.pageErrors(A).length === 0, 'no page errors (' + h.pageErrors(A).join(' | ') + ')');
	await h.finish(browser);
});
