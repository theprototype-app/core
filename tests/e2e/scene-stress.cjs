// 26-E — THE SCENE-STRESS RIG (roadmap 26 section 6). A MEASUREMENT, run by hand.
//
//   APP_URL=https://theprototype.app:5180/ node tests/e2e/scene-stress.cjs \
//       [--sizes 100,1000,3000,10000] [--dense 1,5,15] [--dense-tris 200000] \
//       [--physics 100,300,1000] [--sync 1000,3000] [--window 4000] \
//       [--view shaded-ao|shaded] [--out path.md]
//
// NOT a .test.cjs on purpose: a full sweep runs for many minutes. `npm run e2e --
// scene-stress` runs the small REGRESSION suite instead (scene-stress.test.cjs), which
// drives the same probe (sceneStressProbe.cjs) at a tiny size.
//
// WHY IT EXISTS: roadmap 26 section 2's budget numbers were starting points reasoned from
// WebGL practice. The governor (26-D) and the auto-stops (26-G) steer by them, so they
// have to be MEASURED. Per scene size this records:
//   - seed / import cost and the long tasks it caused
//   - frame p50/p95/p99 idle and while ORBITING (navigation is when a heavy scene hurts)
//   - draw calls and triangles per DISPLAY frame (see sceneBudget's render-totals note —
//     the raw `renderer.info` reads one fullscreen pass and cannot be used)
//   - GPU proxies (geometries/textures) and the JS heap
//   - object-list render ms (and whether 26-B windowed it)
//   - one autosave export: ms and bytes
//   - optionally, physics over the same scene: body count, step p50/p95, whether 26-G's
//     slow-step stop fired
//   - optionally, a second peer JOINING: time-to-synced as the joiner's own
//     `syncMs` reads it (announcement -> last object landed), plus the joiner's long tasks
//
// CAVEATS worth printing with every table:
//   - the numbers belong to ONE GPU; the report names it (WEBGL_debug_renderer_info). A
//     SwiftShader row (no GPU) measures the CPU rasteriser, not the app — the rig refuses
//     to treat one as data and says so.
//   - headless Chromium has no compositor pressure from other windows; a real desktop is
//     worse, never better.
//   - the two-peer sync uses whatever signaling the helpers use (PEER_CONFIG). It is ONE
//     joiner and one handshake — not a flood.

const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');
const { measureScene, installProbe, summarize } = require('./sceneStressProbe.cjs');

const argv = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
function arg(name, fallback) {
	const i = argv.indexOf('--' + name);
	return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback;
}
/** @param {string} value */
const list = (value) =>
	value
		.split(',')
		.map((n) => parseInt(n, 10))
		.filter((n) => Number.isFinite(n) && n > 0);

const SIZES = list(arg('sizes', '100,1000,3000,10000'));
const DENSE = list(arg('dense', '1,5,15'));
const DENSE_TRIS = parseInt(arg('dense-tris', '200000'), 10);
const PHYSICS = list(arg('physics', ''));
const SYNC = list(arg('sync', ''));
const WINDOW_MS = parseInt(arg('window', '4000'), 10);
const VIEW = arg('view', '');
const OUT = arg('out', '');
const storage = VIEW ? { viewMode: VIEW } : undefined;

/** @param {any} x @param {number} [d] */
const r = (x, d = 1) => (x == null || !Number.isFinite(Number(x)) ? '—' : Number(Number(x).toFixed(d)));

/**
 * A second peer joins a host already holding `size` boxes. The joiner's own `syncMs`
 * metric (commandsHandler, 26-E) is the answer: announcement to last object, measured on
 * one clock.
 * @param {any} browser @param {number} size
 */
async function measureSync(browser, size) {
	const host = await h.setupPage(browser, 'host-' + size, { storage });
	const joiner = await h.setupPage(browser, 'join-' + size, { storage });
	try {
		await installProbe(host.page);
		await installProbe(joiner.page);
		await host.page.evaluate((n) => window.__stress.seedCubes(n), size);
		const t0 = Date.now();
		await joiner.page.evaluate(() => (window.__stress.joinStarted = performance.now()));
		await h.connect(joiner, host, 0);
		// wait for the joiner to hold the scene AND for its batch to have closed
		const deadline = Date.now() + 240000;
		/** @type {any} */
		let got = null;
		while (Date.now() < deadline) {
			got = await joiner.page.evaluate(() => ({
				count: window.__stress.count(),
				sync: window.__stores.commandsHandler.lastSyncStats(),
				tasks: window.__stress.tasksSince(window.__stress.joinStarted)
			}));
			if (got.sync && got.count >= size) break;
			await joiner.page.waitForTimeout(250);
		}
		return {
			size,
			wallMs: Date.now() - t0,
			objects: got?.count ?? 0,
			syncMs: got?.sync?.complete ? got.sync.ms : null,
			complete: !!got?.sync?.complete,
			joinerLongTasks: got?.tasks?.count ?? null,
			joinerLongestTask: got?.tasks ? Math.round(got.tasks.longest) : null,
			joinerBusyMs: got?.tasks ? Math.round(got.tasks.busy) : null
		};
	} finally {
		await host.ctx.close();
		await joiner.ctx.close();
	}
}

/** @param {any[]} rows @param {any[]} dense @param {any[]} physics @param {any[]} sync */
function report(rows, dense, physics, sync) {
	const gpu = rows[0]?.gpu ?? dense[0]?.gpu ?? physics[0]?.gpu ?? 'unknown';
	const L = [];
	L.push('# 26-E — scene stress, measured');
	L.push('');
	L.push('GPU: `' + gpu + '`  ·  window ' + WINDOW_MS + 'ms per reading  ·  1280x720  ·  view ' + (VIEW || 'default'));
	if (/swiftshader|llvmpipe|software/i.test(gpu))
		L.push('\n**WARNING: software rasteriser — these rows measure the CPU renderer, not the app. Do not fold them into the budget.**');
	L.push('');
	L.push('## Boxes (the real `/create box` path)');
	L.push('');
	L.push('| objects | seed ms | seed longest task | idle p50/p95/p99 | orbit p50/p95/p99 | orbit long tasks | calls/frame | tris/frame | renders/frame | geoms | textures | heap MB | list ms (rows, mode) | autosave ms / MB |');
	L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
	for (const w of rows) {
		L.push(
			'| ' + w.objects +
				' | ' + r(w.seedMs, 0) +
				' | ' + r(w.seedLongestTask, 0) +
				' | ' + r(w.idle.p50) + ' / ' + r(w.idle.p95) + ' / ' + r(w.idle.p99) +
				' | ' + r(w.orbit.p50) + ' / ' + r(w.orbit.p95) + ' / ' + r(w.orbit.p99) +
				' | ' + w.orbitLongTasks + ' (max ' + r(w.orbitLongestTask, 0) + ')' +
				' | ' + r(w.calls, 0) +
				' | ' + r(w.triangles, 0) +
				' | ' + r(w.rendersPerFrame) +
				' | ' + r(w.geometries, 0) +
				' | ' + r(w.textures, 0) +
				' | ' + r(w.heapMB, 0) +
				' | ' + r(w.listMs, 0) + ' (' + w.listRows + ', ' + w.listMode + ')' +
				' | ' + r(w.autosaveExportMs, 0) + ' / ' + r((w.autosaveBytes ?? 0) / 1048576, 2) +
				(w.autosaveError ? ' ERR' : '') +
				' |'
		);
	}
	if (dense.length) {
		L.push('');
		L.push('## Dense models (a ' + DENSE_TRIS + '-triangle GLB through the real import path)');
		L.push('');
		L.push('| models | import p50/max ms | import longest task | idle p50/p95/p99 | orbit p50/p95/p99 | tris/frame | calls/frame | heap MB | autosave ms / MB |');
		L.push('|---|---|---|---|---|---|---|---|---|');
		for (const w of dense) {
			L.push(
				'| ' + w.objects +
					' | ' + r(w.importMsP50, 0) + ' / ' + r(w.importMsMax, 0) +
					' | ' + r(w.importLongestTask, 0) +
					' | ' + r(w.idle.p50) + ' / ' + r(w.idle.p95) + ' / ' + r(w.idle.p99) +
					' | ' + r(w.orbit.p50) + ' / ' + r(w.orbit.p95) + ' / ' + r(w.orbit.p99) +
					' | ' + r(w.triangles, 0) +
					' | ' + r(w.calls, 0) +
					' | ' + r(w.heapMB, 0) +
					' | ' + r(w.autosaveExportMs, 0) + ' / ' + r((w.autosaveBytes ?? 0) / 1048576, 2) +
					' |'
			);
		}
	}
	if (physics.length) {
		L.push('');
		L.push('## Physics over N dynamic boxes (26-G stops a run at ' + '30 steps over 24ms)');
		L.push('');
		L.push('| boxes | bodies | step p50 / p95 ms | frame p50/p95 while simulating | auto-stopped |');
		L.push('|---|---|---|---|---|');
		for (const w of physics) {
			L.push(
				'| ' + w.size +
					' | ' + (w.physicsAutoStopped ? 'stopped' : r(w.bodies, 0)) +
					' | ' + r(w.stepP50) + ' / ' + r(w.stepP95) +
					' | ' + (w.physicsFrame ? r(w.physicsFrame.p50) + ' / ' + r(w.physicsFrame.p95) : '—') +
					' | ' + (w.physicsStarted ? (w.physicsAutoStopped ? 'YES' : 'no') : 'did not start') +
					' |'
			);
		}
	}
	if (sync.length) {
		L.push('');
		L.push('## A joiner receiving the scene (two peers, one handshake)');
		L.push('');
		L.push('| objects | joiner syncMs | wall ms (dial -> synced) | joiner long tasks | longest | busy ms |');
		L.push('|---|---|---|---|---|---|');
		for (const w of sync) {
			L.push(
				'| ' + w.objects + '/' + w.size +
					' | ' + (w.complete ? r(w.syncMs, 0) : 'INCOMPLETE') +
					' | ' + r(w.wallMs, 0) +
					' | ' + r(w.joinerLongTasks, 0) +
					' | ' + r(w.joinerLongestTask, 0) +
					' | ' + r(w.joinerBusyMs, 0) +
					' |'
			);
		}
	}
	L.push('');
	L.push('```json');
	L.push(JSON.stringify({ rows, dense, physics, sync }, null, 1));
	L.push('```');
	return L.join('\n');
}

(async () => {
	// precise-memory: without it performance.memory is bucketed and every size reads the same heap
	const browser = await h.launch({ args: [...h.GPU_ARGS, '--enable-precise-memory-info'] });
	const rows = [];
	const dense = [];
	const physics = [];
	const sync = [];
	try {
		for (const size of SIZES) {
			console.log('\n==== ' + size + ' boxes ====');
			const row = await measureScene(h, browser, { kind: 'cubes', size, windowMs: WINDOW_MS, storage });
			console.log(JSON.stringify({ ...row, gpu: undefined }));
			rows.push(row);
		}
		for (const size of DENSE) {
			console.log('\n==== ' + size + ' dense models ====');
			const row = await measureScene(h, browser, { kind: 'dense', size, windowMs: WINDOW_MS, denseTris: DENSE_TRIS, storage });
			console.log(JSON.stringify({ ...row, gpu: undefined }));
			dense.push(row);
		}
		for (const size of PHYSICS) {
			console.log('\n==== physics over ' + size + ' boxes ====');
			const row = await measureScene(h, browser, { kind: 'cubes', size, windowMs: WINDOW_MS, physics: true, autosave: false, storage });
			console.log(JSON.stringify({ bodies: row.bodies, stepP50: row.stepP50, stepP95: row.stepP95, stopped: row.physicsAutoStopped, frame: row.physicsFrame }));
			physics.push(row);
		}
		for (const size of SYNC) {
			console.log('\n==== a joiner receiving ' + size + ' boxes ====');
			const row = await measureSync(browser, size);
			console.log(JSON.stringify(row));
			sync.push(row);
		}
		const md = report(rows, dense, physics, sync);
		console.log('\n' + md.split('```json')[0]);
		if (OUT) {
			const out = path.isAbsolute(OUT) ? OUT : path.resolve(process.cwd(), OUT);
			fs.mkdirSync(path.dirname(out), { recursive: true });
			fs.writeFileSync(out, md);
			console.log('written to ' + out);
		}
	} catch (err) {
		console.error('STRESS RUN FAILED:', err && err.stack ? err.stack : err);
		process.exitCode = 1;
	} finally {
		await browser.close();
	}
	void summarize;
})();
