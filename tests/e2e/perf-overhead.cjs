// 34 PF — THE RECORDER'S OVERHEAD TABLE (not a suite: a measurement, run by hand under
// `e2e-slot --exclusive`, the Performance protocol: CDP CPU throttling 4x, GPU backend).
//
//   node tests/e2e/perf-overhead.cjs [out.md]      (APP_URL as for the suites)
//
// Per mode, on a scene of 300 boxes: the recorder's own hot-path cost per frame (its
// self-timing: mean / max ms), and the page's frame time p50 / p95 over the same window.
// "ring only" = the always-on light ring (what every user pays); "light rec" = a recording
// on top; "detailed rec" = CPU phases + the render wrap + a per-object capture each second.
const h = require('./helpers.cjs');
const fs = require('node:fs');
const { installProbe } = require('./sceneStressProbe.cjs');

(async () => {
	const out = process.argv[2] || '/home/deck/.code/lanes-30/after-34/34-perf-data/overhead.md';
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	const gpu = await installProbe(page);
	await page.evaluate(() => window.__stress.seedCubes(300));
	await page.evaluate(() => window.__stress.frameAll(300));
	const cdp = await A.ctx.newCDPSession(page);
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
	await page.waitForTimeout(3000);

	const measure = (mode) =>
		page.evaluate(async (mode) => {
			const p = window.__stores.perf;
			const frames = [];
			let last = 0;
			let alive = true;
			const loop = (t) => {
				if (last) frames.push(t - last);
				last = t;
				if (alive) requestAnimationFrame(loop);
			};
			requestAnimationFrame(loop);
			if (mode === 'light') p.startRecording({ mode: 'light' });
			if (mode === 'detailed') p.startRecording({ mode: 'detailed', durationMs: 0 });
			await new Promise((r) => setTimeout(r, 800));
			p.measureOverhead(true);
			frames.length = 0;
			await new Promise((r) => setTimeout(r, 8000));
			const o = p.perfOverhead();
			p.measureOverhead(false);
			alive = false;
			if (mode !== 'ring') await p.stopRecording();
			const s = [...frames].sort((a, b) => a - b);
			const pct = (q) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
			return { mode, frames: s.length, hotMean: o.meanMs, hotMax: o.maxMs, p50: pct(0.5), p95: pct(0.95) };
		}, mode);

	const rows = [];
	for (const mode of ['ring', 'light', 'detailed', 'ring']) {
		const r = await measure(mode);
		rows.push(r);
		console.log(JSON.stringify(r));
		await page.waitForTimeout(1500);
	}
	const calls = await page.evaluate(() => window.__stores.sceneBudget.sampleSceneMetrics().calls);
	const f = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '–');
	const md = [
		`# 34-perf-data — recorder overhead (${new Date().toISOString().slice(0, 16)})`,
		'',
		`GPU: ${gpu} · CPU throttling 4x · 300 boxes (${calls} draw calls) · 8 s per row`,
		'',
		'| mode | frames | recorder hot path mean ms | max ms | frame p50 ms | frame p95 ms |',
		'|---|---|---|---|---|---|',
		...rows.map((r) => `| ${r.mode} | ${r.frames} | ${f(r.hotMean, 4)} | ${f(r.hotMax)} | ${f(r.p50, 1)} | ${f(r.p95, 1)} |`),
		'',
		'Budget: light mode ≤ 0.3 ms/frame. The hot-path figure is the recorder timing itself (frame',
		'source → ring/recording write → stall check); the detailed row\'s extra cost is in the frame',
		'times (CPU phase timers, the render() wrap, one per-object capture a second). Quest numbers: OWED',
		'(the beacon will report device frame times once a preview runs with reports on).',
		''
	].join('\n');
	fs.writeFileSync(out, md);
	console.log(md);
	await browser.close();
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
