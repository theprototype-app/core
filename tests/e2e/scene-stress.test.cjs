// 26-E — the scene-stress rig's REGRESSION suite (roadmap 26 section 6).
//
// `scene-stress.cjs` is the measurement rig, run by hand; this proves the machinery it
// stands on still measures what it says:
//   1. the percentile rule the rig reports is the meter's rule (pure, no browser)
//   2. THE FINDING: draw calls and triangles are counted per DISPLAY frame across every
//      `renderer.render()` — the raw `renderer.info` reads one fullscreen pass (1 call,
//      1 triangle with 150 boxes on screen), so the triangle and draw-call budgets could
//      never leave green
//   3. stopping the sampler hands the renderer back unwrapped, and starting re-wraps it
//   4. the metric sources the rig needed are registered from their own modules: physics
//      bodies + step time, autosave export ms/bytes, and the receive-side sync time
//   4b. a loading stall is measured from the last ARRIVAL, not the announcement (the rig
//      found a 3,000-object join declared dead at 63s while still landing)
//   5. the rig's per-size runner produces a COMPLETE row end to end at a tiny size, so
//      the manual rig cannot rot unnoticed between the runs that feed the roadmap
//
// Run: APP_URL=https://theprototype.app:5180/ npm run e2e -- scene-stress
const h = require('./helpers.cjs');
const { percentile, summarize, installProbe, measureScene } = require('./sceneStressProbe.cjs');

h.run(async () => {
	// ---- 1. the pure part --------------------------------------------------------------
	const ring = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
	h.check(percentile(ring, 0.5) === 50 && percentile(ring, 0.95) === 100, `nearest-rank percentiles (p50 ${percentile(ring, 0.5)}, p95 ${percentile(ring, 0.95)})`);
	const s = summarize([5, 1, NaN, 3]);
	h.check(s.n === 3 && s.p50 === 3 && s.max === 5, `summarize sorts, drops non-numbers and reports max (${JSON.stringify(s)})`);
	h.check(summarize([]).p95 === null, 'an empty window reports null, never a zero that reads as a fast frame');

	// GPU args: frame-time and per-frame render totals over real frames (the e2e skill's rule)
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const gpu = await installProbe(A.page);
	console.log('renderer: ' + gpu);

	// the meter's own rule, on the same numbers, in the page
	const meterRule = await A.page.evaluate((values) => {
		const b = window.__stores.sceneBudget;
		for (let i = 0; i < 300; i++) b.noteFrame(1000); // push the ring out of the way
		for (const v of values) for (let i = 0; i < 24; i++) b.noteFrame(v);
		return b.frameStats();
	}, ring);
	h.check(
		meterRule.p50 === percentile([...ring.flatMap((v) => Array(24).fill(v))], 0.5) &&
			meterRule.p95 === percentile([...ring.flatMap((v) => Array(24).fill(v))], 0.95),
		`the rig's percentile is the meter's percentile (meter p50 ${meterRule.p50} p95 ${meterRule.p95})`
	);

	// ---- 2. per-frame render totals ----------------------------------------------------
	const seeded = await A.page.evaluate(() => window.__stress.seedCubes(150));
	h.check(seeded.count === 150, `premise: 150 real boxes in the scene (${seeded.count})`);
	await A.page.evaluate(() => window.__stress.frameAll(150));
	const totals = await A.page.evaluate(async () => {
		const { sceneBudget, globalRenderer } = window.__stores;
		let r;
		globalRenderer.subscribe((/** @type {any} */ v) => (r = v))();
		await new Promise((res) => setTimeout(res, 1200));
		const m = sceneBudget.sampleSceneMetrics();
		// what one reader of renderer.info sees at an arbitrary moment: the last pass
		const lastPass = { calls: r.info.render.calls, triangles: r.info.render.triangles };
		return { calls: m.calls, triangles: m.triangles, rendersPerFrame: m.rendersPerFrame, lastPass, wrapped: !!r.__budgetRender };
	});
	h.check(totals.wrapped, 'the sampler wraps the live renderer');
	h.check(
		totals.rendersPerFrame > 1,
		`premise: a desktop frame is SEVERAL render() calls, not one (${totals.rendersPerFrame} per frame)`
	);
	h.check(
		totals.lastPass.calls < 150,
		`premise: raw renderer.info reads only the last pass (${totals.lastPass.calls} calls, ${totals.lastPass.triangles} triangles)`
	);
	h.check(totals.calls >= 150, `draw calls per frame count every box (${totals.calls} for 150 boxes)`);
	h.check(totals.triangles >= 150 * 12, `triangles per frame count every box (${totals.triangles} >= ${150 * 12})`);

	// more objects must move the reading — the axis is live, not a constant
	await A.page.evaluate(() => window.__stress.seedCubes(150));
	await A.page.evaluate(() => window.__stress.frameAll(300));
	const doubled = await A.page.evaluate(async () => {
		await new Promise((res) => setTimeout(res, 1200));
		return window.__stores.sceneBudget.sampleSceneMetrics();
	});
	h.check(
		doubled.calls > totals.calls * 1.5 && doubled.triangles > totals.triangles * 1.5,
		`doubling the boxes roughly doubles the reading (calls ${totals.calls} -> ${doubled.calls}, tris ${totals.triangles} -> ${doubled.triangles})`
	);

	// ---- 3. stop hands the renderer back, start re-wraps ------------------------------
	const cycle = await A.page.evaluate(async () => {
		const { sceneBudget, globalRenderer } = window.__stores;
		let r;
		globalRenderer.subscribe((/** @type {any} */ v) => (r = v))();
		// three defines `render` as an OWN property in its constructor, so "restored" means the
		// very same function object is back, not that the property is gone
		const original = r.__budgetRender;
		sceneBudget.stopSceneMetrics();
		const stopped = { wrapped: !!r.__budgetRender, same: !!original && r.render === original };
		sceneBudget.startSceneMetrics();
		await new Promise((res) => setTimeout(res, 800));
		return { stopped, restarted: !!r.__budgetRender };
	});
	h.check(!cycle.stopped.wrapped && cycle.stopped.same, `stopping the sampler restores the renderer's own render (${JSON.stringify(cycle.stopped)})`);
	h.check(cycle.restarted, 'starting it again re-wraps the renderer');

	// ---- 4. the metric sources ---------------------------------------------------------
	const save = await A.page.evaluate(async () => {
		await window.__stores.autosave.saveNow();
		const m = window.__stores.sceneBudget.sampleSceneMetrics();
		return { exportMs: m.autosaveExportMs, bytes: m.autosaveBytes };
	});
	h.check(save.exportMs > 0 && save.bytes > 1000, `autosave export ms and bytes reach the sampler (${save.exportMs}ms, ${save.bytes} bytes)`);

	const phys = await A.page.evaluate(async () => {
		const { physics, sceneBudget } = window.__stores;
		const before = sceneBudget.sampleSceneMetrics();
		const run = await window.__stress.physics(1500);
		const after = sceneBudget.sampleSceneMetrics();
		return { beforeBodies: before.bodies, beforeStep: before.physicsStepMs, run, afterBodies: after.bodies, afterStep: after.physicsStepMs, stats: physics.physicsStepStats() };
	});
	h.check(phys.beforeBodies === 0 && phys.beforeStep === null, `no simulation: 0 bodies and no step time (${phys.beforeBodies}, ${phys.beforeStep})`);
	h.check(phys.run.startedOk, 'premise: the simulation started');
	h.check(phys.run.bodies === 300, `while simulating the sampler counts the bodies (${phys.run.bodies} for 300 dynamic boxes)`);
	h.check(phys.run.step && phys.run.step.n > 20 && phys.run.step.p95 > 0, `…and the step time (${JSON.stringify(phys.run.step)})`);
	h.check(
		phys.afterBodies === 0 && phys.afterStep === null && phys.stats === null,
		`a stopped run reads as no run, never a stale cost (${phys.afterBodies}, ${phys.afterStep})`
	);

	const sync = await A.page.evaluate(async () => {
		const { commandsHandler, sceneBudget } = window.__stores;
		// a batch that FINISHES: every announced uuid counted as arrived
		await commandsHandler.createLoader(2, ['stress-a', 'stress-b'], 'nobody');
		await new Promise((res) => setTimeout(res, 300));
		commandsHandler.noteLoadFailed(['stress-a', 'stress-b']);
		const finished = { stats: commandsHandler.lastSyncStats(), metric: sceneBudget.sampleSceneMetrics().syncMs };
		// a batch that is CLOSED before it finishes (the sender left, a scene clear)
		await commandsHandler.createLoader(2, ['stress-c', 'stress-d'], 'nobody');
		await new Promise((res) => setTimeout(res, 100));
		commandsHandler.clearLoadingBatch();
		const closed = { stats: commandsHandler.lastSyncStats(), metric: sceneBudget.sampleSceneMetrics().syncMs };
		return { finished, closed };
	});
	h.check(
		sync.finished.stats?.complete === true && sync.finished.metric >= 280 && sync.finished.stats.objects === 2,
		`a finished batch reports its sync time, on one clock (${JSON.stringify(sync.finished)})`
	);
	h.check(
		sync.closed.stats?.complete === false && sync.closed.metric === null,
		`a batch closed before it finished reports NO sync time, not a fast one (${JSON.stringify(sync.closed)})`
	);
	// ---- 4b. a stall is SILENCE, not duration ------------------------------------------
	// The rig's finding: the 60s stall timer was armed once at the announcement, so a
	// 3,000-object join still landing ~10 objects a second was declared dead at 63s. Here
	// the stall is 800ms and the batch keeps making progress past it.
	const stall = await A.page.evaluate(async () => {
		const { commandsHandler, loading } = window.__stores;
		const read = () => {
			let v;
			loading.subscribe((/** @type {any} */ x) => (v = x))();
			return v.length;
		};
		const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
		commandsHandler.setLoadingStallMsForTest(800);
		try {
			await commandsHandler.createLoader(4, ['st-1', 'st-2', 'st-3', 'st-4'], 'nobody');
			const trace = [];
			// one arrival every 500ms: total 1.5s, never 800ms of silence
			for (const uuid of ['st-1', 'st-2', 'st-3']) {
				await sleep(500);
				commandsHandler.noteLoadFailed([uuid]);
				trace.push(read());
			}
			const aliveAfter1500 = read();
			// …then silence: the stall must still fire
			await sleep(1300);
			return { trace, aliveAfter1500, afterSilence: read(), sync: commandsHandler.lastSyncStats() };
		} finally {
			commandsHandler.setLoadingStallMsForTest();
		}
	});
	h.check(
		stall.aliveAfter1500 === 1,
		`a batch still arriving past the stall window is NOT given up on (${JSON.stringify(stall.trace)} left after 1.5s)`
	);
	h.check(
		stall.afterSilence === 0 && stall.sync?.complete === false,
		`…and real silence still ends it, reported as incomplete (${stall.afterSilence} left, ${JSON.stringify(stall.sync)})`
	);

	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A))})`);
	await A.ctx.close();

	// ---- 5. the rig's runner, end to end, at a tiny size -------------------------------
	const row = await measureScene(h, browser, { kind: 'cubes', size: 40, windowMs: 1000, physics: true });
	const numeric = ['seedMs', 'objects', 'triangles', 'calls', 'rendersPerFrame', 'geometries', 'textures', 'listMs', 'autosaveExportMs', 'autosaveBytes', 'bodies', 'stepP95'];
	const missing = numeric.filter((key) => !Number.isFinite(row[key]));
	h.check(missing.length === 0, `the rig produces a complete row (missing: ${JSON.stringify(missing)})`);
	h.check(row.idle.n > 20 && row.orbit.n > 20 && row.idle.p95 > 0, `…with real frame windows (idle ${row.idle.n} frames, orbit ${row.orbit.n})`);
	h.check(row.objects === 40 && row.listRows === 40 && row.bodies === 40, `…measuring the scene it built (${row.objects} objects, ${row.listRows} rows, ${row.bodies} bodies)`);
	h.check(row.pageErrors === 0, `…with no page errors (${row.pageErrors})`);

	await h.finish(browser);
});
