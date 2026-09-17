// 26-D — the adaptive quality governor (roadmap 26 section 4, Stage 1).
//
// The decision RULE is unit-tested (tests/unit/qualityGovernor.test.js). This suite proves
// the WIRING against the live app, in the order it matters:
//   1. a light scene on a slow machine is never governed (the 26-G ruling, held)
//   2. a heavy slow scene takes the first step: shadows go off on the renderer, the user's
//      saved shadowQuality is NOT written, the chip appears, the baseline is recorded
//   3. THE 26-G INTERACTION: a heavy scene whose draw calls the governor has brought down to
//      green still reads as heavy to the freeze guard, and a frozen streak still pauses
//   4. every step reaches its consumer (the real pixel ratio, the composer's buffer size) and
//      walking back restores it exactly
//   5. recovery on good frames, the chip's pin and release (with the release snooze), and the
//      opt-out
//   6. the INGEST DRAW GAP (26-E's finding): while a batch drains through slow frames the
//      renderer draws at most ~4 frames a second, sticky for the drain, off when it ends
//   7. END TO END on real frames: 3,000 real boxes on a real GPU engage the governor on their
//      own, and the measured draw calls fall
//
// Sections 1-6 stop the budget sampler so the metrics and frames are the suite's to write
// (the overload-guard suite's pattern); section 7 turns it back on.
//
// Run: APP_URL=https://theprototype.app:5180/ npm run e2e -- perf-governor
const h = require('./helpers.cjs');
const { installProbe } = require('./sceneStressProbe.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	await installProbe(A.page);

	// shared in-page helpers
	await A.page.evaluate(() => {
		const s = window.__stores;
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		window.__gov = {
			read,
			/** synthetic frames of `ms` for `durationMs`, ending at a time we choose */
			frames(ms, durationMs) {
				const q = s.qualityGovernor.governorForTest;
				let t = window.__gov.clock;
				const end = t + durationMs;
				while (t < end) {
					t += ms;
					q.frame(ms, t);
				}
				window.__gov.clock = t;
				return t;
			},
			decide() {
				return s.qualityGovernor.decideNow(window.__gov.clock);
			},
			metrics(m) {
				s.sceneBudget.sceneMetrics.set({ at: Date.now(), profile: 'desktop', ...m });
			},
			clock: 1e7
		};
	});

	const snap = () =>
		A.page.evaluate(() => {
			const s = window.__stores;
			const { read } = window.__gov;
			const r = read(s.globalRenderer);
			return {
				state: read(s.qualityGovernor.qualityState),
				overrides: read(s.qualityGovernor.qualityOverrides),
				baseline: read(s.sceneBudget.qualityBaseline),
				shadowMap: r.shadowMap.enabled,
				pixelRatio: r.getPixelRatio(),
				bufferWidth: r.getDrawingBufferSize(new s.THREE.Vector2()).x,
				canvasCss: r.domElement.clientWidth,
				storedShadowPref: localStorage.getItem('shadowQuality'),
				post: window.__postDebug ? (({ kinds, composerBufferWidth }) => ({ kinds, composerBufferWidth }))(window.__postDebug()) : null,
				chip: document.querySelector('#quality-chip')
					? { level: document.querySelector('#quality-chip').getAttribute('data-level'), pinned: document.querySelector('#quality-chip').getAttribute('data-pinned'), title: document.querySelector('#quality-chip').title }
					: null
			};
		});

	const base = await A.page.evaluate(() => {
		const s = window.__stores;
		s.sceneBudget.stopSceneMetrics();
		s.qualityGovernor.governorForTest.reset();
		return { dpr: window.devicePixelRatio, stored: localStorage.getItem('shadowQuality') };
	});
	const start = await snap();
	h.check(start.state.level === 0 && start.overrides.dprScale === 1 && !start.overrides.shadowsOff, `boots at full quality (${JSON.stringify(start.overrides)})`);
	h.check(start.chip === null, 'no chip at full quality');
	h.check(start.shadowMap === true, 'premise: the renderer draws shadows at full quality');

	// ---- 1. a light scene on a slow machine is never governed --------------------------
	const light = await A.page.evaluate(() => {
		const g = window.__gov;
		g.metrics({ objects: 12, meshes: 12, triangles: 144, calls: 24 });
		g.frames(400, 4000);
		return g.decide();
	});
	h.check(light.level === 0 && light.moved === null, `400ms frames on a 12-box scene change nothing (${JSON.stringify(light)})`);

	// ---- 2. a heavy slow scene: the first step --------------------------------------------
	// heavy by DRAW CALLS alone (objects green): the case where the governor's own shadows
	// step could talk 26-G out of a scene — the one section 3 is about
	const HEAVY = { objects: 1000, meshes: 1000, triangles: 60000, calls: 4800 };
	const first = await A.page.evaluate((m) => {
		const g = window.__gov;
		g.metrics(m);
		g.frames(50, 2200);
		return g.decide();
	}, HEAVY);
	h.check(first.moved === 'up' && first.level === 1, `50ms frames on a heavy scene take ONE step (${JSON.stringify(first)})`);
	await A.page.waitForTimeout(400);
	const afterFirst = await snap();
	h.check(afterFirst.overrides.shadowsOff === true && afterFirst.overrides.dprScale === 1, `the first step is SHADOWS (26-E: calls are the cost) (${JSON.stringify(afterFirst.overrides)})`);
	h.check(afterFirst.shadowMap === false, 'the renderer really stopped drawing shadows');
	h.check(
		afterFirst.storedShadowPref === base.stored,
		`…without touching the user's saved shadow preference (stored ${afterFirst.storedShadowPref} === ${base.stored})`
	);
	h.check(afterFirst.baseline?.calls === 4800 && afterFirst.baseline?.objects === 1000, `the pre-reduction readings are recorded (${JSON.stringify(afterFirst.baseline)})`);
	h.check(afterFirst.chip?.level === '1' && /shadows off/i.test(afterFirst.chip?.title ?? ''), `the chip appears and names what was reduced (${JSON.stringify(afterFirst.chip)})`);

	// ---- 3. the 26-G interaction --------------------------------------------------------
	// the SAME scene as the governor has made it: same objects, shadows off halved the calls
	// to green — by its LIVE readings this scene is light
	const guard = await A.page.evaluate(() => {
		const s = window.__stores;
		const g = window.__gov;
		g.metrics({ objects: 1000, meshes: 1000, triangles: 30000, calls: 1900 });
		const liveOnly = s.sceneBudget.isHeavy(s.sceneBudget.sceneMetrics ? g.read(s.sceneBudget.sceneMetrics) : {}, 'desktop', null);
		const guardSays = s.overloadGuard.sceneIsHeavy();
		let paused = null;
		for (let i = 0; i < 12; i++) s.overloadGuard.noteFrameForFreeze(300);
		paused = g.read(s.overloadGuard.renderPaused);
		s.overloadGuard.resumeRendering();
		return { liveOnly, guardSays, paused };
	});
	h.check(guard.liveOnly === false, 'premise: by its live readings alone the reduced scene is NOT heavy');
	h.check(guard.guardSays === true, "26-G still judges the scene by what it cost BEFORE the governor reduced it");
	h.check(!!guard.paused, `…so a frozen streak still pauses rendering (${JSON.stringify(guard.paused)})`);
	// a scene that really shrank (under 70% of the baseline objects) is not held heavy
	const shrunk = await A.page.evaluate(() => {
		const s = window.__stores;
		window.__gov.metrics({ objects: 400, meshes: 400, triangles: 5000, calls: 800 });
		return s.overloadGuard.sceneIsHeavy();
	});
	h.check(shrunk === false, 'a scene that really shrank is not held heavy by a stale baseline');
	await A.page.evaluate((m) => window.__gov.metrics(m), HEAVY);
	await A.page.waitForTimeout(3500); // the resume grace, so nothing below re-pauses

	// ---- 4. every step reaches its consumer, and walking back restores it ---------------
	const top = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.qualityGovernor.governorForTest.setLevel(s.qualityGovernor.governorForTest.level() + 100);
		await new Promise((r) => setTimeout(r, 800));
		return true;
	});
	void top;
	const atTop = await snap();
	h.check(
		atTop.overrides.dprScale === 0.5 && atTop.overrides.aoOff && atTop.overrides.postOff && atTop.overrides.particlesCapped && atTop.overrides.presenceSlow,
		`the last level holds every step (${JSON.stringify(atTop.overrides)})`
	);
	h.check(
		Math.abs(atTop.pixelRatio - base.dpr * 0.5) < 1e-6,
		`the renderer's pixel ratio follows the resolution step (${atTop.pixelRatio} = ${base.dpr} x 0.5)`
	);
	h.check(
		Math.abs(atTop.bufferWidth - Math.round(atTop.canvasCss * base.dpr * 0.5)) <= 1,
		`…so the drawing buffer really is half size (${atTop.bufferWidth}px for ${atTop.canvasCss} CSS px)`
	);
	h.check(
		start.post?.kinds?.includes('ao') && !atTop.post?.kinds?.includes('ao'),
		`the AO pass really leaves the compiled chain (${JSON.stringify(start.post?.kinds)} -> ${JSON.stringify(atTop.post?.kinds)})`
	);
	h.check(
		Math.abs((atTop.post?.composerBufferWidth ?? 0) - atTop.bufferWidth) <= 1 && atTop.post.composerBufferWidth < start.post.composerBufferWidth,
		`the composer's buffer follows the resolution step, not just the canvas (${start.post?.composerBufferWidth} -> ${atTop.post?.composerBufferWidth}px)`
	);
	await A.page.evaluate(async () => {
		window.__stores.qualityGovernor.governorForTest.setLevel(0);
		await new Promise((r) => setTimeout(r, 800));
	});
	const back = await snap();
	h.check(
		back.state.level === 0 && Math.abs(back.pixelRatio - base.dpr) < 1e-6 && back.shadowMap === true && back.baseline === null,
		`walking back restores everything exactly (dpr ${back.pixelRatio}, shadows ${back.shadowMap}, baseline ${JSON.stringify(back.baseline)})`
	);
	h.check(
		back.post?.kinds?.includes('ao') && back.post?.composerBufferWidth === start.post?.composerBufferWidth,
		`…including AO and the composer size (${JSON.stringify(back.post)})`
	);
	h.check(back.chip === null, 'the chip leaves at full quality');

	// ---- 5. recovery, pin/release, opt-out ----------------------------------------------
	const recovery = await A.page.evaluate((m) => {
		const g = window.__gov;
		g.metrics(m);
		g.frames(50, 2200);
		const up = g.decide();
		g.frames(16.7, 9000);
		const early = g.decide();
		g.frames(16.7, 1600);
		const down = g.decide();
		return { up: up.moved, early: early.moved, down: down.moved, level: down.level };
	}, HEAVY);
	h.check(recovery.up === 'up' && recovery.early === null && recovery.down === 'down' && recovery.level === 0, `recovers after 10s of good frames and not before (${JSON.stringify(recovery)})`);

	await A.page.evaluate(() => {
		const g = window.__gov;
		g.frames(50, 3200);
		g.decide();
	});
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => document.querySelector('#quality-chip').click());
	await A.page.waitForTimeout(200);
	const pinned = await A.page.evaluate(() => {
		const g = window.__gov;
		g.frames(16.7, 25000);
		const d = g.decide();
		return { d, chip: document.querySelector('#quality-chip')?.getAttribute('data-pinned') };
	});
	h.check(pinned.chip === 'true' && pinned.d.level === 1 && pinned.d.moved === null, `a click on the chip HOLDS the level through good frames (${JSON.stringify(pinned)})`);
	await A.page.evaluate(() => document.querySelector('#quality-chip').click());
	await A.page.waitForTimeout(300);
	const released = await snap();
	h.check(released.state.level === 0 && released.chip === null && released.shadowMap === true, 'a second click restores full quality');
	const snoozed = await A.page.evaluate(() => {
		const g = window.__gov;
		g.frames(50, 3200);
		return g.decide();
	});
	h.check(snoozed.level === 0, `…and it STICKS: no automatic step during the release snooze (${JSON.stringify(snoozed)})`);

	const off = await A.page.evaluate(() => {
		const s = window.__stores;
		s.qualityGovernor.governorForTest.reset(); // clears the snooze
		s.qualityGovernor.setAutoQuality(false);
		const g = window.__gov;
		g.frames(50, 3200);
		const d = g.decide();
		const stored = localStorage.getItem('autoQuality');
		s.qualityGovernor.setAutoQuality(true);
		localStorage.removeItem('autoQuality');
		return { level: d.level, stored };
	});
	h.check(off.level === 0 && off.stored === 'false', `turning it off stops it and is remembered locally (${JSON.stringify(off)})`);
	// the real entry point: Settings binds the same store
	await A.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await A.page.waitForTimeout(500);
	await A.page.locator('#settings-search').fill('heavy');
	await A.page.waitForTimeout(400);
	const box = A.page.locator('#auto-quality');
	const found = (await box.count()) > 0 && (await box.isVisible());
	const had = found ? await box.isChecked() : null;
	if (found) await box.click();
	await A.page.waitForTimeout(250);
	const afterSetting = await A.page.evaluate(() => ({
		store: window.__gov.read(window.__stores.qualityGovernor.autoQuality),
		stored: localStorage.getItem('autoQuality')
	}));
	if (found) await box.click();
	await A.page.waitForTimeout(250);
	const restoredSetting = await A.page.evaluate(() => {
		const on = window.__gov.read(window.__stores.qualityGovernor.autoQuality);
		localStorage.removeItem('autoQuality');
		window.__stores.settingsOpen.set(false);
		return on;
	});
	h.check(
		found && had === true && afterSetting.store === false && afterSetting.stored === 'false' && restoredSetting === true,
		`Settings > "Reduce quality when the scene is heavy" drives the same switch (found ${found}, checked ${had}, then ${JSON.stringify(afterSetting)}, back ${restoredSetting})`
	);
	await A.page.waitForTimeout(400);

	// ---- 6. the ingest draw gap ----------------------------------------------------------
	const gap = await A.page.evaluate(async () => {
		const s = window.__stores;
		const g = window.__gov;
		const r = g.read(s.globalRenderer);
		s.qualityGovernor.governorForTest.reset();
		const framesIn = async (ms) => {
			const a = r.info.render.frame;
			await new Promise((res) => setTimeout(res, ms));
			return r.info.render.frame - a;
		};
		const normal = await framesIn(1000);
		// a big batch draining through slow frames
		g.metrics({ objects: 200, meshes: 200, triangles: 3000, calls: 400, ingestBacklog: 800 });
		s.beginSceneBatch();
		try {
			g.frames(50, 2200);
			g.decide();
			const engaged = g.read(s.qualityGovernor.ingestDrawGap);
			const throttled = await framesIn(2000);
			// the throttled frames are FAST; the gap must not switch itself off on them
			g.frames(16.7, 2200);
			g.decide();
			const sticky = g.read(s.qualityGovernor.ingestDrawGap);
			// render() calls, not display frames: the composer makes several per frame, so the
			// claim is the RATIO against the same counter a second earlier
			return { normal, engaged, throttledPerSec: throttled / 2, ratio: throttled / 2 / Math.max(1, normal), sticky, stillLevel: g.read(s.qualityGovernor.qualityState).level };
		} finally {
			s.endSceneBatch();
			g.decide();
		}
	});
	const gapAfter = await A.page.evaluate(() => window.__gov.read(window.__stores.qualityGovernor.ingestDrawGap));
	h.check(gap.normal > 30, `premise: the renderer draws at display rate normally (${gap.normal} render() calls in 1s)`);
	h.check(gap.engaged === 250, `a draining batch through slow frames engages the draw gap (${gap.engaged}ms)`);
	h.check(
		gap.throttledPerSec > 0 && gap.ratio < 0.15,
		`…and the renderer really draws ~4 frames a second of 60 (${gap.throttledPerSec} render() calls/s against ${gap.normal}, ratio ${gap.ratio.toFixed(3)})`
	);
	h.check(gap.sticky === 250, 'the gap is sticky for the drain: its own cheap frames do not switch it off');
	h.check(gap.stillLevel === 0, 'a light scene receiving objects is not a quality step, only a drain');
	h.check(gapAfter === 0, 'the drain ends, the gap ends');

	// ---- 7. end to end on real frames --------------------------------------------------
	const real = await A.page.evaluate(async () => {
		const s = window.__stores;
		const read = window.__gov.read;
		s.qualityGovernor.governorForTest.reset();
		// OFF while the scene is built and measured at full quality, so "before" is clean
		s.qualityGovernor.setAutoQuality(false);
		s.sceneBudget.startSceneMetrics();
		await window.__stress.seedCubes(3000);
		window.__stress.frameAll(3000);
		await new Promise((r) => setTimeout(r, 2500));
		const before = s.sceneBudget.sampleSceneMetrics();
		const beforeRun = await window.__stress.frames(2000);
		s.qualityGovernor.setAutoQuality(true);
		localStorage.removeItem('autoQuality');
		// let it act: steps are held 3s apart
		const deadline = performance.now() + 20000;
		while (performance.now() < deadline && read(s.qualityGovernor.qualityState).level === 0) await new Promise((r) => setTimeout(r, 250));
		const engagedAfterMs = Math.round(20000 - (deadline - performance.now()));
		await new Promise((r) => setTimeout(r, 2500));
		const after = s.sceneBudget.sampleSceneMetrics();
		const afterRun = await window.__stress.frames(2000);
		const pct = (d) => {
			const x = [...d].sort((a, b) => a - b);
			return x[Math.min(x.length - 1, Math.ceil(0.95 * x.length) - 1)];
		};
		const state = read(s.qualityGovernor.qualityState);
		return {
			engagedAfterMs,
			state,
			beforeCalls: before.calls,
			afterCalls: after.calls,
			beforeP95: pct(beforeRun.deltas),
			afterP95: pct(afterRun.deltas),
			heavyStill: s.overloadGuard.sceneIsHeavy()
		};
	});
	console.log('real 3,000 boxes: ' + JSON.stringify(real));
	h.check(real.beforeP95 > 35, `premise: 3,000 real boxes miss 30fps on this GPU (p95 ${real.beforeP95}ms)`);
	h.check(real.state.level >= 1, `the governor engaged ON ITS OWN from real frames (level ${real.state.level} after ${real.engagedAfterMs}ms: ${real.state.labels.join(', ')})`);
	h.check(real.afterCalls < real.beforeCalls * 0.75, `…and the measured draw calls fell (${real.beforeCalls} -> ${real.afterCalls})`);
	h.check(real.heavyStill === true, '…while 26-G still judges the scene heavy');

	await A.page.evaluate(() => {
		window.__stores.qualityGovernor.governorForTest.reset();
	});
	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A))})`);
	await h.finish(browser);
});
