// B8: `scenePhysics.play.simOnPlay` is HONOURED — entering play mode starts the
// simulation when the scene asks for it, and only then. The flag shipped in 21-B B1
// (schema + Inspector checkbox) with no consumer at all, and a game template whose
// rules live on spawn nodes and sensors was a silent no-op until someone found P.
// Contract pinned here: default OFF is byte-identical to before; ON starts a sim on
// play entry; a sim already running anywhere (remote included) is left alone with no
// busy toast; and leaving play never stops the run (start-only).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const a = await h.setupPage(browser, 'A');
	const page = a.page;

	// a sim needs at least one dynamic body; /create Box stamps {mode:'dynamic'}
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create Box'));
	await page.waitForTimeout(800);

	const simState = () =>
		page.evaluate(() => {
			const s = window.__stores;
			/** @param {any} st */
			const g = (st) => {
				let v;
				st.subscribe((/** @type {any} */ x) => (v = x))();
				return v;
			};
			return { sim: !!g(s.physics.simulating), remote: g(s.physics.remoteSimulating) };
		});
	const toastTexts = () =>
		page.evaluate(() => {
			let v;
			window.__stores.toastStore.subscribe((/** @type {any} */ x) => (v = x))();
			return (v ?? []).map((/** @type {any} */ t) => String(t?.message ?? t?.text ?? t));
		});
	const enterPlay = () => page.evaluate(() => window.__stores.isLocked.set(true));
	const exitPlay = async () => {
		await page.evaluate(() => window.__stores.isLocked.set(false));
		await page.waitForTimeout(300); // the transient false settles to null on a macrotask
	};

	// 1 — the counterfactual: default simOnPlay=false, play entry starts NOTHING
	await enterPlay();
	await page.waitForTimeout(1200);
	let st = await simState();
	h.check(st.sim === false, 'default (simOnPlay off): entering play starts no sim');
	await exitPlay();

	// 2 — the flag on: play entry starts the sim
	await page.evaluate(() =>
		window.__stores.scenePhysics.setScenePhysics({ play: { simOnPlay: true } })
	);
	await enterPlay();
	await h.eventually(
		() => simState().then((v) => v.sim),
		(v) => v === true,
		'simOnPlay on: entering play starts the simulation',
		10000
	);

	// 3 — start-only: leaving play keeps the run alive (another peer may be mid-round)
	await exitPlay();
	await page.waitForTimeout(800);
	st = await simState();
	h.check(st.sim === true, 'leaving play does NOT stop the simulation (start-only)');

	// 4 — re-entering play over a live sim starts nothing new and toasts nothing
	await enterPlay();
	await page.waitForTimeout(800);
	const toasts1 = await toastTexts();
	h.check(
		!toasts1.some((t) => /already simulating/i.test(t)),
		're-entry over a live sim is a quiet skip, not the busy toast'
	);
	await exitPlay();
	await page.evaluate(() => window.__stores.physics.stopSimulation());
	await page.waitForTimeout(400);

	// 5 — a REMOTE sim is respected: nothing starts and no busy toast fires
	await page.evaluate(() => window.__stores.physics.remoteSimulating.set('peer-fake'));
	await enterPlay();
	await page.waitForTimeout(1000);
	st = await simState();
	h.check(st.sim === false, 'a remote sim in flight: play entry starts nothing');
	const toasts2 = await toastTexts();
	h.check(
		!toasts2.some((t) => /already simulating/i.test(t)),
		'the remote-busy skip is silent (no toast)'
	);
	await exitPlay();
	await page.evaluate(() => window.__stores.physics.remoteSimulating.set(null));

	await h.finish(browser);
});
