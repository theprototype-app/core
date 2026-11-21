// 80a-fix4-ui G11 (release check r1590-08 BROKEN: on the HONOR the 2K sky swap held the main thread 133-158 ms):
// the swap's uploads, shader compile and draws now run as separate tasks. This suite measures the LONGEST main-thread
// task while the 2K sky swaps in (CPU slowed 4x, the phone's share of the work), three swaps, a fresh sky each time
// (a cached program would hide the compile). It runs on the PC GPU queue; A/B it against production with
// APP_URL=https://theprototype.pages.dev/ E2E_BLOCK_SW=1.
//   premise: the observer sees a long task (a 120 ms busy loop is caught)
//   premise: each swap lands (state ready, sky 2k AND its cube built: skyWidth > 0 — the status names the 2K file the
//            moment it is asked for, the cube lands later, so waiting on the name alone measured nothing)
//   the window runs from the ask to 1.5 s after the cube, so the first draw with it (its compile) is inside
//   the gate: the longest task during a swap < 50 ms (G11's proof) — logged per swap for the A/B
const h = require('./helpers.cjs');

const SKIES = ['bundled:sunrise', 'bundled:meadow', 'bundled:starlight'];
const ENV = { 'bundled:sunrise': 'sunrise', 'bundled:meadow': 'meadow', 'bundled:starlight': 'starlight' };

/** @param {any} page */
const status = (page) =>
	page.evaluate(() => {
		let v;
		/** @type {any} */ (window).__tp.test.v1.hdriStores.hdriStatus.subscribe((/** @type {any} */ x) => (v = x))();
		return v;
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'sky', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	const cdp = await page.context().newCDPSession(page);
	await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__longTasks = [];
		new PerformanceObserver((list) => {
			for (const e of list.getEntries()) w.__longTasks.push({ at: e.startTime, ms: e.duration });
		}).observe({ type: 'longtask', buffered: false });
	});
	// positive control: the observer reports a long task when there is one
	await page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 120); });
	await page.waitForTimeout(300);
	const control = await page.evaluate(() => /** @type {any} */ (window).__longTasks.reduce((/** @type {number} */ m, /** @type {any} */ t) => Math.max(m, t.ms), 0));
	h.check(control >= 100, `premise: the long-task observer catches a 120 ms busy loop (${Math.round(control)} ms)`);
	const RATE = Number(process.env.SKY_CPU_RATE || 4);
	/** @type {number[]} */
	const worst = [];
	for (const src of SKIES) {
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
		// light the sky on its small file first (Standard), then ask for the 2K: the swap is the only thing measured
		await page.evaluate((k) => /** @type {any} */ (window).__tp.test.v1.environment.setEnvironment(k), ENV[src]);
		await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.environment.editEnvSky({ hdri: { quality: 'standard' } }));
		await h.eventually(() => status(page), (s) => s?.state === 'ready' && s.src === src, `${src} is lit`, 60000);
		await page.waitForTimeout(1500);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });
		const t0 = await page.evaluate(() => performance.now());
		await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.environment.editEnvSky({ hdri: { quality: 'high' } }));
		await h.eventually(() => status(page), (s) => s?.state === 'ready' && s.sky === '2k' && s.skyWidth > 0, `${src}: the 2K sky swapped in (its cube built)`, 90000);
		const t1 = await page.evaluate(() => performance.now());
		await page.waitForTimeout(1500);
		const tasks = await page.evaluate(([a, b]) => /** @type {any} */ (window).__longTasks.filter((/** @type {any} */ t) => t.at >= a && t.at <= b), [t0, t1 + 1500]);
		const max = tasks.reduce((m, /** @type {any} */ t) => Math.max(m, t.ms), 0);
		worst.push(max);
		console.log(`  ${src}: swap ${Math.round(t1 - t0)} ms, long tasks ${JSON.stringify(tasks.map((/** @type {any} */ t) => Math.round(t.ms)))}, longest ${Math.round(max)} ms`);
	}
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
	const longest = Math.max(...worst);
	console.log(`  SKY-SWAP-LONGEST ${Math.round(longest)} ms (${worst.map((w) => Math.round(w)).join(' / ')})`);
	h.check(longest < 50, `G11 the longest main-thread task during a 2K sky swap is under 50 ms at ${RATE}x CPU (${Math.round(longest)} ms)`);
	await h.finish(browser);
});
