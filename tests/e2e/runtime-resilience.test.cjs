// 27-C (hardening audit, top-10 #3 and M7) — ONE THROW USED TO END THE SESSION.
//
// `tick` called `runTick(now)` and THEN re-armed the frame, so an exception escaped
// before `requestAnimationFrame` ever ran: no further frame was scheduled, every flow
// animation and every physics step stopped for the rest of the session, and nothing
// said so. A module frame task, a post-tick hook or one bad node evaluator was enough.
//
// What this suite pins:
//   1. a throwing module frame task does NOT stop the frame loop, and a spin node
//      carries on animating
//   2. a throwing post-tick hook is survived the same way
//   3. per-frame failures are RATE-LIMITED (first three, then one per 300) — a 60Hz
//      log buries the first failure, which is the only one that says what broke
//   4. a persistently throwing TICK pauses the runtime with a Resume card rather than
//      burning a core forever, and Resume restarts it
//   5. physics: a throwing step stops the simulation ONCE, with the scene intact
//
// Run: APP_URL=https://theprototype.app:5175/ npm run e2e -- runtime-resilience
const h = require('./helpers.cjs');

const paused = (page) =>
	page.evaluate(() => {
		let v = null;
		window.__stores.flowPaused.subscribe((x) => (v = x))();
		return v;
	});

const ringLines = (page) =>
	page.evaluate(() => window.__stores.diagnostics.lines());

h.run(async () => {
	const browser = await h.launch();
	const peer = await h.setupPage(browser, 'resilience');
	const page = peer.page;
	await page.waitForFunction(() => !!window.__stores?.flowRuntime && !!window.__stores?.flowPaused, {
		timeout: 30000
	});
	h.check(true, 'premise: the flow runtime and its paused store are live');

	// ---- 1. a throwing module frame task must not stop the loop ----------------------
	// A spin node is the visible half: it is a pure function of (base pose, time), so if
	// frames keep coming its rotation keeps changing.
	await page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
	});
	await page.waitForTimeout(600);
	const uuid = await page.evaluate(() => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		return group.children[group.children.length - 1].uuid;
	});
	await page.evaluate((id) => {
		const s = window.__stores;
		s.updateGraph(s.SCENE_GRAPH, () => ({
			nodes: [
				{ id: 'spin1', type: 'spin', position: { x: 40, y: 40 }, data: { type: 'spin', axis: 'y', speed: 2 } },
				{ id: 'sel1', type: 'objectselector', position: { x: 240, y: 40 }, data: { type: 'objectselector', selected: id } }
			],
			edges: [{ id: 'e-spin1-sel1', source: 'spin1', target: 'sel1' }]
		}));
	}, uuid);
	await page.waitForTimeout(500);

	const readRot = () =>
		page.evaluate((id) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((g) => (group = g))();
			return group.getObjectByProperty('uuid', id)?.rotation.y ?? null;
		}, uuid);

	const spinBefore = await readRot();
	await page.waitForTimeout(500);
	const spinAfter = await readRot();
	h.check(
		spinBefore !== null && spinAfter !== null && spinBefore !== spinAfter,
		`premise: the spin node is animating (${spinBefore} -> ${spinAfter})`
	);

	await page.evaluate(() => {
		window.__rt = { taskCalls: 0 };
		// `moduleFrameTasks` is the exported array `api.registerFrameTask` pushes onto —
		// the same list a real module's task lands in, so this is the real path.
		window.__stores.moduleSDK.moduleFrameTasks.push(() => {
			window.__rt.taskCalls++;
			throw new Error('frame-task-boom');
		});
	});
	await page.waitForTimeout(900);
	const afterTask = await readRot();
	const taskCalls = await page.evaluate(() => window.__rt.taskCalls);
	// Headless SwiftShader renders at ~5 fps here (CLAUDE.md measures ~4.5), so 900ms is a
	// handful of frames, not sixty. The claim is "it ran repeatedly", not a frame rate.
	h.check(taskCalls >= 3, `the throwing frame task really ran repeatedly (${taskCalls} calls)`);
	h.check(
		afterTask !== spinAfter,
		`the frame loop survived it — the spin node is still animating (${spinAfter} -> ${afterTask})`
	);
	const stillTicking = await paused(page);
	h.check(stillTicking?.paused === false, 'a throwing FRAME TASK does not pause the runtime (it is contained)');

	// ---- 3. and its log is rate-limited ----------------------------------------------
	const lines = await ringLines(page);
	const taskLines = lines.filter((l) => /frame task failed/i.test(l));
	h.check(
		taskLines.length > 0 && taskLines.length <= 4,
		`the per-frame failure is rate-limited, not one line per frame (${taskLines.length} lines for ${taskCalls} calls)`
	);

	// ---- 4. a persistently throwing TICK pauses, and Resume restarts it ---------------
	// Drive the counter directly at its own entry point rather than waiting out 120 real
	// frames: the guard under test is the threshold and the re-arm, not the clock.
	// Drive the XR PUMP directly rather than waiting out 120 real frames: at ~5 fps that is
	// ~25s of wall clock, and pumping also proves the XR path shares the guard — Scene.svelte
	// calls pumpFlowTick while presenting, where window.rAF is suspended.
	await page.evaluate(() => {
		const rt = window.__stores.flowRuntime;
		rt.failTicksForTest(130);
		for (let i = 0; i < 130; i++) rt.pumpFlowTick(performance.now());
	});
	await page.waitForTimeout(300);
	const nowPaused = await paused(page);
	h.check(nowPaused?.paused === true, `a tick that keeps throwing pauses the runtime (${JSON.stringify(nowPaused)})`);
	const toastShown = await page.evaluate(() =>
		document.body.innerText.includes('Flow runtime paused')
	);
	h.check(toastShown, 'and says so, with a Resume card');

	const frozen = await readRot();
	await page.waitForTimeout(400);
	h.check((await readRot()) === frozen, 'while paused, nothing ticks');

	await page.evaluate(() => {
		// Clear the forced failures FIRST. Resume restores ticking, and a tick that still
		// throws re-pauses at once — which is exactly what made this section red before.
		window.__stores.flowRuntime.failTicksForTest(0);
		window.__stores.flowRuntime.resumeFlowRuntime();
	});
	await page.waitForTimeout(900);
	const resumed = await paused(page);
	h.check(resumed?.paused === false, 'Resume clears the paused state');
	const spinResumed = await readRot();
	await page.waitForTimeout(900);
	h.check((await readRot()) !== spinResumed, 'and the animation runs again');

	// ---- 5. physics: a throwing step stops the run ONCE -------------------------------
	const physics = await page.evaluate(async () => {
		const s = window.__stores;
		// there is no startSimulation export — `toggleSimulation` is the entry point, and
		// it is async because it warms rapier's wasm on the first run.
		await s.physics.toggleSimulation();
		await new Promise((r) => setTimeout(r, 1200));
		let running = false;
		s.physics.simulating.subscribe((v) => (running = v))();
		return { running };
	});
	h.check(physics.running === true, 'premise: a simulation is running');

	await page.evaluate(() => window.__stores.physics.throwOnNextStepForTest());
	await page.waitForTimeout(2000);
	const afterThrow = await page.evaluate(() => {
		let running = true;
		window.__stores.physics.simulating.subscribe((v) => (running = v))();
		return { running, said: document.body.innerText.includes('Physics stopped after an error') };
	});
	h.check(afterThrow.running === false, 'a throwing physics step stops the simulation');
	h.check(afterThrow.said, 'and says so once, rather than logging 60 times a second in silence');

	const afterPhysics = await readRot();
	await page.waitForTimeout(900);
	h.check(
		(await readRot()) !== afterPhysics,
		'the FLOW loop survived the physics failure (they share one frame)'
	);

	await h.finish(browser);
});
