// @ts-nocheck — bench runner (browser). Roadmap 99 K3 row 6: enter-edit time in the Deck browser,
// against K1's table (tests/bench/meshKernelBrowser.cjs: kernel build 49 ms / +weld 183 ms vs
// today's enter-edit 678 ms at 67k).
//   ENTER: the app's own face-mode entry (`faceEdit.enterFaceEdit`) on a mesh from K1's
//   `makeMesh('grid', size)`, wall time of the synchronous call, median of RUNS. On the K3 branch
//   the call also opens the one session and STARTS the kernel build (off-thread); the same script
//   against the base tree gives the before number. Longest main-thread task in the 1.5 s after
//   entry (PerformanceObserver longtask) shows what the off-thread build still costs the page.
//   KERNEL READY: entry -> the session's ID maps resolved (`editSession.whenSessionKernel`), K3 only.
//   WORKER BUILD: `meshSession.buildSessionKernel` straight (worker, weld 1e-4) at every size incl.
//   1M (a session skips the kernel above the commit ceiling, 166k tris; this times the build itself).
// Not an e2e suite (not in battery.json): a measurement.
//   APP_URL=https://theprototype.app:7065/ e2e-slot --local --dev <tree> 7065 -- node tests/bench/meshSessionBrowser.cjs
// BENCH_OUT=<file> appends the table; BENCH_ENTER_SIZES (default 10k,67k,100k), BENCH_BUILD_SIZES
// (default 67k,1M), BENCH_RUNS (default 3).
const fs = require('fs');
const path = require('path');
const { launch, setupPage } = require('../e2e/helpers.cjs');

(async () => {
	const browser = await launch({
		args: ['--enable-precise-memory-info', '--js-flags=--expose-gc']
	});
	let rc = 0;
	try {
		const { page } = await setupPage(browser, 'bench');
		const adapter = await page.evaluate(() =>
			fetch('/src/lib/meshKernel/three.js').then((r) => r.text())
		);
		const threeUrl = adapter.match(/from "(\/node_modules\/\.vite\/deps\/three\.js[^"]*)"/)?.[1];
		if (!threeUrl) throw new Error("could not find the app's three URL in the vite-served adapter");
		const source = fs
			.readFileSync(path.join(__dirname, 'meshKernelBench.js'), 'utf8')
			.replace(/from 'three'/g, `from '${threeUrl}'`)
			.replace(/from '\$lib\//g, "from '/src/lib/");
		await page.route('**/tests/bench/meshKernelBench.js', (route) =>
			route.fulfill({ status: 200, contentType: 'text/javascript', body: source })
		);
		const enterSizes = (process.env.BENCH_ENTER_SIZES ?? '10k,67k,100k').split(',').filter(Boolean);
		const buildSizes = (process.env.BENCH_BUILD_SIZES ?? '67k,1M').split(',').filter(Boolean);
		const runs = Number(process.env.BENCH_RUNS ?? 3);
		const result = await page.evaluate(
			async ({ enterSizes, buildSizes, runs }) => {
				const s = window.__tp.test.v1;
				const bench = await import('/tests/bench/meshKernelBench.js');
				const median = (a) =>
					a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
				const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
				const es = await import('/src/lib/editSession.js').catch(() => null);
				const k3 = typeof es?.whenSessionKernel === 'function';
				// the vertex cap the face mode checks; raised so 100k enters (a local pref, this tab only)
				s.faceEdit.vrFaceCap?.set?.(2_000_000);
				s.commandsHandler.sceneCommand('/create Box 1 1 1');
				let g;
				s.objectsGroup.subscribe((v) => (g = v))();
				const object = g.children[g.children.length - 1];
				const rows = [];
				for (const size of enterSizes) {
					const geometry = bench.makeMesh('grid', size);
					object.geometry = geometry;
					const tris =
						(geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
					const enter = [];
					const ready = [];
					const longest = [];
					for (let r = 0; r < runs; r++) {
						const tasks = [];
						const obs = new PerformanceObserver((list) =>
							list.getEntries().forEach((e) => tasks.push(e.duration))
						);
						try {
							obs.observe({ type: 'longtask', buffered: false });
						} catch {}
						globalThis.gc?.();
						await frame();
						const t0 = performance.now();
						s.faceEdit.enterFaceEdit(object.uuid);
						const t1 = performance.now();
						if (
							!s.faceEdit.faceEditObject ||
							!(() => {
								let v;
								s.faceEdit.faceEditObject.subscribe((x) => (v = x))();
								return v;
							})()
						) {
							rows.push({ size, tris, error: 'face mode refused to enter' });
							break;
						}
						enter.push(t1 - t0);
						if (k3) {
							const maps = await es.whenSessionKernel();
							if (maps) ready.push(performance.now() - t0);
						}
						await new Promise((r) => setTimeout(r, 1500));
						obs.disconnect();
						longest.push(tasks.length ? Math.max(...tasks) : 0);
						s.faceEdit.exitFaceEdit();
						await frame();
					}
					if (enter.length)
						rows.push({
							size,
							tris,
							enterMs: median(enter),
							kernelReadyMs: k3 ? median(ready) : null,
							longestTaskMs: median(longest)
						});
				}
				const builds = [];
				const ms = k3 ? await import('/src/lib/meshSession.js') : null;
				if (ms)
					for (const size of buildSizes) {
						const geometry = bench.makeMesh('grid', size);
						const tris =
							(geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
						const wall = [];
						const worker = [];
						for (let r = 0; r < runs; r++) {
							globalThis.gc?.();
							const t0 = performance.now();
							const built = await ms.buildSessionKernel(geometry);
							wall.push(performance.now() - t0);
							worker.push(built?.ms ?? NaN);
						}
						builds.push({ size, tris, wallMs: median(wall), workerMs: median(worker) });
					}
				const ua =
					navigator.userAgent.match(/(HeadlessChrome|Chrome)\/[\d.]+/)?.[0] ?? navigator.userAgent;
				return { k3, rows, builds, ua, version: s.appVersion ?? null };
			},
			{ enterSizes, buildSizes, runs }
		);
		const r1 = (v) => (v == null ? 'n/a' : typeof v === 'number' ? v.toFixed(v < 10 ? 1 : 0) : v);
		const lines = [
			`### enter-edit in the app (${result.k3 ? 'K3 branch' : 'base, pre-K3'}), ${result.ua}, ${new URL(process.env.APP_URL).port}, median of ${runs}`,
			'',
			'| mesh | tris | enterFaceEdit ms | kernel ready ms (off-thread) | longest main-thread task ms (1.5 s after entry) |',
			'|---|---|---|---|---|',
			...result.rows.map((r) =>
				r.error
					? `| ${r.size} | ${r.tris} | ${r.error} | | |`
					: `| ${r.size} | ${r.tris} | ${r1(r.enterMs)} | ${r1(r.kernelReadyMs)} | ${r1(r.longestTaskMs)} |`
			)
		];
		if (result.builds.length)
			lines.push(
				'',
				'| mesh | tris | session kernel build, worker ms (weld 1e-4, + ID maps) | wall ms incl. transfer |',
				'|---|---|---|---|',
				...result.builds.map(
					(b) => `| ${b.size} | ${b.tris} | ${r1(b.workerMs)} | ${r1(b.wallMs)} |`
				)
			);
		const table = lines.join('\n');
		console.log(table);
		if (process.env.BENCH_OUT) fs.appendFileSync(process.env.BENCH_OUT, table + '\n\n');
	} catch (error) {
		console.error('bench failed:', error);
		rc = 1;
	} finally {
		await browser.close();
	}
	process.exit(rc);
})();
