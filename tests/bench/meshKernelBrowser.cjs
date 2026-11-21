// @ts-nocheck — bench runner (browser). Roadmap 99 K1 row 4, the Deck-browser half.
// Loads the app from a dev server (APP_URL), then imports tests/bench/meshKernelBench.js THROUGH
// vite (bare imports and $lib resolve as in the app, and faceEdit is the app's own instance) and
// runs the same bench node runs. Not an e2e suite (not in battery.json): a measurement.
//   APP_URL=https://theprototype.app:7060/ e2e-slot --local --dev <tree> 7060 -- node tests/bench/meshKernelBrowser.cjs
// BENCH_OUT=<file> writes the table; BENCH_TODAY_MAX caps the old path (default 100k: at 1M it
// holds a Vector3 per corner in one tab).
const fs = require('fs');
const { launch, setupPage } = require('../e2e/helpers.cjs');

(async () => {
	const browser = await launch({ args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
	let rc = 0;
	try {
		const { page } = await setupPage(browser, 'bench');
		page.on('console', (msg) => msg.text().startsWith('[bench]') && console.log(msg.text()));
		const todayMax = process.env.BENCH_TODAY_MAX || '100k';
		const sizes = process.env.BENCH_SIZES ? process.env.BENCH_SIZES.split(',') : undefined;
		const { rows, table, ua } = await page.evaluate(
			async ({ todayMax, sizes }) => {
				const m = await import('/tests/bench/meshKernelBench.js');
				const rows = await m.runBench({ todayMax, sizes, log: (s) => console.log('[bench] ' + s) });
				const ua = navigator.userAgent.match(/(HeadlessChrome|Chrome)\/[\d.]+/)?.[0] ?? navigator.userAgent;
				return { rows, ua, table: m.benchTable(rows, `browser ${ua}, gc ${typeof globalThis.gc === 'function' ? 'exposed' : 'off'}`) };
			},
			{ todayMax, sizes }
		);
		console.log(table);
		if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ ua, rows }, null, 2) + '\n\n' + table + '\n');
	} catch (error) {
		console.error('bench failed:', error);
		rc = 1;
	} finally {
		await browser.close();
	}
	process.exit(rc);
})();
