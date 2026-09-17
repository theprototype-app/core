// 26-G — Stages 3 and 4: the runtime auto-stops and the paused overlay
// (roadmap 26 section 4).
//
// Stages 0-2 stop the app freezing on the way IN. This is what happens once a heavy
// scene is already here and the device cannot keep up.
//
// What is asserted, in the order it matters:
//  1. the streak rule — consecutive, once per streak — because a single hitch must never
//     stop anybody's simulation;
//  2. a simulation too slow to keep up is stopped ONCE, says so, and offers Resume;
//  3. a frozen render loop pauses drawing, but a backgrounded tab never does;
//  4. Reduce sets the newest objects aside ON THIS DEVICE ONLY, and — the hazard this
//     design exists for — they STAY in the autosave export;
//  5. the restore prompt says how the snapshot compares with this device's budget.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');

	// ---- 1. the streak rule --------------------------------------------------
	const streak = await A.page.evaluate(() => {
		const { createStreakWatch } = window.__stores.overloadGuard;
		const w = createStreakWatch({ overMs: 24, count: 5 });
		const fires = [];
		// four slow, one fast: the streak BREAKS and nothing fires
		for (const ms of [30, 30, 30, 30, 10]) fires.push(w.note(ms));
		const brokenStreak = fires.every((f) => !f);
		// five slow in a row fires exactly once, on the fifth
		const run = [30, 30, 30, 30, 30, 30, 30].map((ms) => w.note(ms));
		const firedOnFifth = run[4] === true && run.filter(Boolean).length === 1;
		// a sample exactly ON the threshold is not over it
		const w2 = createStreakWatch({ overMs: 24, count: 2 });
		const onThreshold = [24, 24, 24].map((ms) => w2.note(ms)).some(Boolean);
		// after a fast sample the watch re-arms and can fire again
		w.note(10);
		const again = [30, 30, 30, 30, 30].map((ms) => w.note(ms)).filter(Boolean).length === 1;
		return { brokenStreak, firedOnFifth, onThreshold, again };
	});
	h.check(streak.brokenStreak, 'a streak broken by one fast sample fires nothing — a single hitch is not a heavy scene');
	h.check(streak.firedOnFifth, 'N slow samples in a row fire exactly once, and not again while the streak continues');
	h.check(!streak.onThreshold, 'a sample exactly on the threshold is not over it');
	h.check(streak.again, 'a fast sample re-arms the watch');

	// ---- 2. physics: a simulation too slow to keep up -------------------------
	await A.page.evaluate(async () => {
		const { commandsHandler } = window.__stores;
		commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
	});
	const started = await A.page.evaluate(async () => {
		const { physics } = window.__stores;
		// prewarm rapier (lazy wasm), then run
		await physics.toggleSimulation();
		await new Promise((r) => setTimeout(r, 1500));
		let sim; const s = physics.simulating.subscribe((/** @type {any} */ v) => (sim = v)); s();
		return sim;
	});
	h.check(started === true, 'the simulation is running (premise)');
	await A.page.evaluate(() => window.__stores.toastStore.set([]));
	const slow = await A.page.evaluate(async () => {
		const { physics, overloadGuard } = window.__stores;
		// one short of the streak must NOT stop it
		const early = physics.noteSlowStepsForTest(overloadGuard.PHYSICS_SLOW_STEPS - 1, 40);
		let sim; let s = physics.simulating.subscribe((/** @type {any} */ v) => (sim = v)); s();
		const stillRunning = sim;
		// a fast step breaks that streak, then a full one stops the run
		physics.noteSlowStepsForTest(1, 5);
		const fired = physics.noteSlowStepsForTest(overloadGuard.PHYSICS_SLOW_STEPS, 40);
		s = physics.simulating.subscribe((/** @type {any} */ v) => (sim = v)); s();
		return { early, stillRunning, fired, stopped: sim === false };
	});
	h.check(!slow.early && slow.stillRunning, 'one step short of the streak leaves the simulation running');
	h.check(slow.fired && slow.stopped, 'a full streak of slow steps STOPS the simulation');
	await h.eventually(
		() => A.page.locator('.tp-toast', { hasText: 'too slow for this device' }).count(),
		(n) => n > 0,
		'…and says so, naming the reason'
	);
	const resume = A.page.locator('.tp-toast', { hasText: 'too slow for this device' }).getByRole('button', { name: 'Resume' });
	h.check((await resume.count()) > 0, '…with a Resume button, so the stop is never a dead end');
	await resume.first().click();
	await h.eventually(
		() => A.page.evaluate(() => { let v; const s = window.__stores.physics.simulating.subscribe((/** @type {any} */ x) => (v = x)); s(); return v; }),
		(v) => v === true,
		'Resume starts the simulation again'
	);
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());

	// ---- 3. the render freeze -------------------------------------------------
	h.check((await A.page.locator('#render-paused').count()) === 0, 'the paused overlay starts hidden (premise)');

	// THE REGRESSION THIS RULE WAS REWRITTEN FOR: a SLOW MACHINE drawing a LIGHT scene. A
	// software-rendered page lives at ~2.5fps — 400ms frames, forever — and the first
	// version of this trigger paused it, covering every non-GPU e2e suite with the overlay
	// ("#render-paused intercepts pointer events", 23 times in one battery). Pausing a
	// light scene helps nothing: there is nothing heavy to set aside.
	const light = await A.page.evaluate(() => {
		const g = window.__stores.overloadGuard;
		const b = window.__stores.sceneBudget;
		g.resumeRendering();
		const realNow = Date.now;
		Date.now = () => realNow() + 10000;
		b.sceneMetrics.set({ at: Date.now(), profile: 'desktop', objects: 12, triangles: 144, calls: 12 });
		const heavy = g.sceneIsHeavy();
		let paused = false;
		for (let i = 0; i < 40; i++) paused = g.noteFrameForFreeze(400) || paused;
		Date.now = realNow;
		return { heavy, paused };
	});
	h.check(!light.heavy, 'twelve boxes are not a heavy scene (premise)');
	h.check(!light.paused, 'forty 400ms frames on a LIGHT scene never pause — a slow machine is not an overloaded scene');

	const freeze = await A.page.evaluate(() => {
		const g = window.__stores.overloadGuard;
		// a HEAVY reading: past the desktop object budget, so pausing could actually help
		window.__stores.sceneBudget.sceneMetrics.set({ at: Date.now(), profile: 'desktop', objects: 4200, triangles: 900000, calls: 2600 });
		g.resumeRendering();
		// resumeRendering starts a grace window; step past it for the test
		const realNow = Date.now;
		Date.now = () => realNow() + 10000;
		const short = [];
		for (let i = 0; i < g.FREEZE_FRAMES - 1; i++) short.push(g.noteFrameForFreeze(400));
		const notYet = !short.some(Boolean);
		g.noteFrameForFreeze(16); // breaks it
		let paused = false;
		for (let i = 0; i < g.FREEZE_FRAMES; i++) paused = g.noteFrameForFreeze(400) || paused;
		Date.now = realNow;
		let state; const s = g.renderPaused.subscribe((/** @type {any} */ v) => (state = v)); s();
		return { notYet, paused, reason: state?.reason };
	});
	h.check(freeze.notYet, 'nine frozen frames do not pause — the rule is ten in a row');
	h.check(freeze.paused && freeze.reason === 'frozen', `ten frames over 250ms PAUSE drawing (reason: ${freeze.reason})`);
	await A.page.waitForSelector('#render-paused', { timeout: 5000 });
	h.check(true, 'the "Rendering paused" overlay appears');
	const card = await A.page.locator('#render-paused').textContent();
	h.check(/Nothing is lost/.test(String(card)) && /autosave keeps running/.test(String(card)), 'it says nothing is lost and autosave carries on');

	// the render loop really stops: renderer.info.render.frame stops advancing
	const frozenFrames = await A.page.evaluate(async () => {
		let renderer; const s = window.__stores.globalRenderer.subscribe((/** @type {any} */ r) => (renderer = r)); s();
		const a = renderer.info.render.frame;
		await new Promise((r) => setTimeout(r, 600));
		return renderer.info.render.frame - a;
	});
	h.check(frozenFrames === 0, `no frame is drawn while paused (${frozenFrames} frames in 600ms)`);

	await A.page.locator('#render-paused-resume').click();
	await A.page.waitForTimeout(700);
	const liveFrames = await A.page.evaluate(async () => {
		let renderer; const s = window.__stores.globalRenderer.subscribe((/** @type {any} */ r) => (renderer = r)); s();
		const a = renderer.info.render.frame;
		await new Promise((r) => setTimeout(r, 600));
		return renderer.info.render.frame - a;
	});
	h.check((await A.page.locator('#render-paused').count()) === 0, 'Resume closes the overlay');
	h.check(liveFrames > 5, `…and drawing starts again (${liveFrames} frames in 600ms)`);

	// a BACKGROUNDED tab throttles rAF to ~1Hz on purpose — that must never pause
	const hidden = await A.page.evaluate(() => {
		const g = window.__stores.overloadGuard;
		// HEAVY, or this check passes vacuously — a light scene never pauses anyway
		window.__stores.sceneBudget.sceneMetrics.set({ at: Date.now(), profile: 'desktop', objects: 4200, triangles: 900000, calls: 2600 });
		g.resumeRendering();
		const realNow = Date.now;
		Date.now = () => realNow() + 10000;
		const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
		let paused = false;
		for (let i = 0; i < 30; i++) paused = g.noteFrameForFreeze(1000) || paused;
		// …and the FIRST frame back spans the whole absence
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
		const firstBack = g.noteFrameForFreeze(60000);
		delete document.visibilityState;
		if (desc) Object.defineProperty(Document.prototype, 'visibilityState', desc);
		Date.now = realNow;
		return { paused, firstBack };
	});
	h.check(!hidden.paused, 'thirty 1-second frames in a HIDDEN tab never pause — that is the browser throttling, not a heavy scene');
	h.check(!hidden.firstBack, 'the first frame after coming back is ignored — its delta is the whole absence');

	// ---- 4. Reduce: newest set aside, LOCALLY, and still in the autosave ------
	const reduce = await A.page.evaluate(async () => {
		const { THREE, objectsGroup, pokeScene, overloadGuard, autosave } = window.__stores;
		let group; { const s = objectsGroup.subscribe((/** @type {any} */ g) => (group = g)); s(); }
		group.clear();
		// 3,200 top-level objects: 200 past the desktop object budget (3,000). EMPTY GROUPS,
		// not meshes: the budget counts tree NODES, so a Group counts exactly like a mesh,
		// and it costs this memory-starved box no geometry and no GPU upload (a run with
		// 3,200 real meshes died here with "Resulting promise was garbage collected").
		for (let i = 0; i < 3200; i++) {
			const m = new THREE.Group();
			m.name = 'r' + i;
			group.add(m);
		}
		pokeScene();
		await new Promise((r) => setTimeout(r, 300));
		const n = overloadGuard.reduceScene('desktop');
		const newest = group.children[group.children.length - 1];
		const oldest = group.children[0];
		// the camera draws layer 0; a reduced object is on the reduced layer
		const cam = new THREE.PerspectiveCamera();
		return {
			n,
			newestReduced: overloadGuard.isReduced(newest.uuid) && !cam.layers.test(newest.layers),
			oldestDrawn: !overloadGuard.isReduced(oldest.uuid) && cam.layers.test(oldest.layers),
			stillVisibleFlag: newest.visible === true,
			stillInScene: group.children.length,
			hasExport: typeof autosave.exportScene === 'function' || typeof autosave.snapshotScene === 'function'
		};
	});
	h.check(reduce.n === 200, `Reduce sets aside exactly the overflow, newest first (${reduce.n})`);
	h.check(reduce.newestReduced, 'the NEWEST object is set aside and no longer drawn');
	h.check(reduce.oldestDrawn, 'the oldest is untouched');
	h.check(reduce.stillInScene === 3200, `nothing was removed from the scene (${reduce.stillInScene})`);
	h.check(
		reduce.stillVisibleFlag,
		'`visible` is NOT touched — GLTFExporter drops invisible objects from autosave, and this must not'
	);

	// the hazard, proven: a GLTF export (autosave's serializer, no options) still carries
	// a reduced object, where a `visible = false` hide would have dropped it
	const exported = await A.page.evaluate(async () => {
		const { THREE, GLTFExporterModule, objectsGroup, overloadGuard } = window.__stores;
		let group; { const s = objectsGroup.subscribe((/** @type {any} */ g) => (group = g)); s(); }
		const probe = new THREE.Group();
		const reducedOne = group.children[group.children.length - 1].clone();
		reducedOne.name = 'probe-reduced';
		reducedOne.layers.set(overloadGuard.REDUCED_LAYER);
		const hiddenOne = group.children[0].clone();
		hiddenOne.name = 'probe-hidden';
		hiddenOne.visible = false;
		probe.add(reducedOne, hiddenOne);
		const json = await new Promise((resolve) =>
			new GLTFExporterModule.GLTFExporter().parse(probe, resolve, () => resolve(null))
		);
		const names = (json?.nodes ?? []).map((/** @type {any} */ n) => n.name);
		return { reduced: names.includes('probe-reduced'), hidden: names.includes('probe-hidden') };
	});
	h.check(exported.reduced, 'a REDUCED object is still in a default GLTF export — autosave keeps it');
	h.check(!exported.hidden, '…while a `visible = false` one is dropped: the counterfactual, measured in the same export');

	const restored = await A.page.evaluate(() => {
		const { objectsGroup, overloadGuard } = window.__stores;
		let group; { const s = objectsGroup.subscribe((/** @type {any} */ g) => (group = g)); s(); }
		const n = overloadGuard.restoreReduced();
		const newest = group.children[group.children.length - 1];
		return { n, back: !overloadGuard.isReduced(newest.uuid) && newest.layers.mask === 1 };
	});
	h.check(restored.n === 200 && restored.back, `restoring puts every set-aside object back on its original layer (${restored.n})`);

	// the overlay's own Reduce button, end to end
	await A.page.evaluate(() => {
		const g = window.__stores.overloadGuard;
		g.pauseRendering('frozen');
		window.__stores.toastStore.set([]);
	});
	await A.page.waitForSelector('#render-paused-reduce', { timeout: 5000 });
	await A.page.locator('#render-paused-reduce').click();
	await A.page.waitForTimeout(400);
	h.check((await A.page.locator('#render-paused').count()) === 0, 'Reduce resumes drawing');
	h.check(
		(await A.page.locator('.tp-toast', { hasText: 'nothing was deleted' }).count()) > 0,
		'…and says what it did, and that nothing was deleted'
	);
	h.check(
		(await A.page.locator('.tp-toast').getByRole('button', { name: 'Show them again' }).count()) > 0,
		'…with a way to undo it'
	);
	// leave a LIGHT scene behind: 3,200 objects is heavy by definition, and the real frame
	// loop would be entitled to pause over it on a saturated box while section 5 runs
	await A.page.evaluate(() => {
		const { objectsGroup, pokeScene, overloadGuard } = window.__stores;
		overloadGuard.restoreReduced();
		let group; { const s = objectsGroup.subscribe((/** @type {any} */ g) => (group = g)); s(); }
		group.clear();
		pokeScene();
		overloadGuard.resumeRendering();
	});

	// ---- 5. the restore prompt names the budget ------------------------------
	await A.page.evaluate(() => {
		window.__stores.toastStore.set([]);
		window.__stores.autosave.restoreAvailable.set({ objects: 4200, ts: Date.now() });
	});
	await h.eventually(
		() => A.page.locator('.tp-toast', { hasText: 'Restore previous session?' }).textContent().catch(() => ''),
		(t) => /4200 objects/.test(String(t)) && /above the 3000 recommended/.test(String(t)),
		'the restore prompt says the snapshot is above this device\'s budget'
	);
	await A.page.evaluate(() => window.__stores.autosave.restoreAvailable.set({ objects: 40, ts: Date.now() }));
	await h.eventually(
		() => A.page.locator('.tp-toast', { hasText: 'Restore previous session?' }).textContent().catch(() => ''),
		(t) => /40 objects/.test(String(t)) && !/recommended/.test(String(t)),
		'…and says nothing about the budget for a small one'
	);
	await A.page.evaluate(() => window.__stores.autosave.restoreAvailable.set(null));

	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A))})`);
	await h.finish(browser);
});
