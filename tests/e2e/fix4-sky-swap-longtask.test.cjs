// 80a-fix4-ui G11 (release check r1590-08 BROKEN: on the HONOR the 2K sky swap held the main thread 133-158 ms):
// the swap's uploads, shader compile and draws now run as separate tasks. This suite measures the LONGEST main-thread
// task while the 2K sky swaps in (CPU slowed 4x, the phone's share of the work), three swaps, a fresh sky each time
// (a cached program would hide the compile). It runs on the PC GPU queue; A/B it against production with
// APP_URL=https://theprototype.pages.dev/ E2E_BLOCK_SW=1.
//   premise: each swap lands (state ready, sky 2k)
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
	/** @type {number[]} */
	const worst = [];
	for (const src of SKIES) {
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
		// light the sky on its small file first (Standard), then ask for the 2K: the swap is the only thing measured
		await page.evaluate((k) => /** @type {any} */ (window).__tp.test.v1.environment.setEnvironment(k), ENV[src]);
		await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.environment.editEnvSky({ hdri: { quality: 'standard' } }));
		await h.eventually(() => status(page), (s) => s?.state === 'ready' && s.src === src, `${src} is lit`, 60000);
		await page.waitForTimeout(1500);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
		const t0 = await page.evaluate(() => performance.now());
		await page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.environment.editEnvSky({ hdri: { quality: 'high' } }));
		await h.eventually(() => status(page), (s) => s?.state === 'ready' && s.sky === '2k', `${src}: the 2K sky swapped in`, 90000);
		const t1 = await page.evaluate(() => performance.now());
		await page.waitForTimeout(300);
		const tasks = await page.evaluate(([a, b]) => /** @type {any} */ (window).__longTasks.filter((/** @type {any} */ t) => t.at >= a && t.at <= b), [t0, t1]);
		const max = tasks.reduce((m, /** @type {any} */ t) => Math.max(m, t.ms), 0);
		worst.push(max);
		console.log(`  ${src}: swap ${Math.round(t1 - t0)} ms, long tasks ${JSON.stringify(tasks.map((/** @type {any} */ t) => Math.round(t.ms)))}, longest ${Math.round(max)} ms`);
	}
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
	const longest = Math.max(...worst);
	console.log(`  SKY-SWAP-LONGEST ${Math.round(longest)} ms (${worst.map((w) => Math.round(w)).join(' / ')})`);
	h.check(longest < 50, `G11 the longest main-thread task during a 2K sky swap is under 50 ms at 4x CPU (${Math.round(longest)} ms)`);
	await h.finish(browser);
});
