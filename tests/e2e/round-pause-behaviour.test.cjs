// 54i F15 (roadmap 78) — a round paused for 6 s and resumed keeps playing, with the pause left out of
// its clock, even with a behaviour countdown in the scene. The research repro ("limit 30 → start →
// pause ~6 s → resume ⇒ lost 'Out of time'") was the starter Countdown behaviour (10 s,
// `this.after(1, 'tick')`): its timers ran straight through the pause and lost the round 10 s of WALL
// time after go. Behaviour timers now hold while the game is paused (the rules are proven on the
// logic sim: tests/unit/sim/behaviourPause.test.js); this is the live app: a behaviour node loaded
// through the module loader + sandbox, kit.round on sessionNow, core's game singleton, the real tick.
const path = require('path');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

/** a probe module: the SDK api on window (flow.addNodes, kit) */
const PROBE = () => {
	const s = /** @type {any} */ (window).__stores;
	s.moduleSDK.initModules([
		{
			id: 'pauseprobe',
			name: 'Pause probe',
			version: '1.0.0',
			register(/** @type {any} */ api) {
				/** @type {any} */ (window).__pApi = api;
			}
		}
	]);
	return !!(/** @type {any} */ (window).__pApi?.kit);
};
const E = (/** @type {any} */ p, /** @type {Function} */ fn, /** @type {any} */ arg) => p.page.evaluate(fn, arg);
const round = (/** @type {any} */ p) =>
	E(p, () => {
		const r = /** @type {any} */ (window).__stores.kit.kit.impls.round;
		return { phase: r.phase(), elapsed: r.elapsed(), remaining: r.remaining(), outcome: r.outcome(), pausedMs: r.extra.state().pausedMs };
	});
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	h.check(await E(A, PROBE), 'probe module up');
	// the file a new Behaviour node starts with (a leaf with no imports)
	const starter = (await import(pathToFileURL(path.resolve(__dirname, '../../src/lib/behaviours/starter.js')).href)).BEHAVIOUR_STARTER;
	h.check(typeof starter === 'string' && /kit\.round\.lose\('Out of time'\)/.test(starter), 'the starter behaviour is the 10 s Countdown that loses the round');

	// the behaviour node with the starter file (the first behaviour also loads the sandbox engine: up to 40 s headless)
	const [bid] = await E(A, (code) => /** @type {any} */ (window).__pApi.flow.addNodes({ nodes: [{ type: 'behaviour', x: 40, y: 40, data: { name: 'Countdown', code } }] }), starter);
	await h.eventually(
		() => E(A, (i) => /** @type {any} */ (window).__stores.behaviours.behavioursDebug().status[i]?.status ?? null, bid),
		(v) => v === 'running',
		'the Countdown behaviour node runs',
		40000
	);
	// the joiner grace (2 s) passes before the authority acts on its own
	await sleep(2500);

	// configure limit 30 → start → (1 s intro) → play ~2 s → pause ~6 s → resume
	await E(A, () => {
		const k = /** @type {any} */ (window).__pApi.kit;
		k.round.configure(1, 30, 'lose', 1);
		k.round.start();
	});
	await h.eventually(() => round(A), (r) => r.phase === 'playing', 'the round plays after its 1 s intro', 15000);
	await h.eventually(
		() => E(A, (i) => /** @type {any} */ (window).__stores.behaviours.behavioursDebug().live(i)?.state?.left ?? 0, bid),
		(left) => left > 0,
		'the Countdown started on go',
		10000
	);
	await sleep(2000);
	await E(A, () => /** @type {any} */ (window).__pApi.kit.round.pause());
	await h.eventually(() => round(A), (r) => r.phase === 'paused', 'paused', 5000);
	const leftAtPause = await E(A, (i) => /** @type {any} */ (window).__stores.behaviours.behavioursDebug().live(i)?.state?.left, bid);
	await sleep(6000);
	const leftAfterPause = await E(A, (i) => /** @type {any} */ (window).__stores.behaviours.behavioursDebug().live(i)?.state?.left, bid);
	h.check(leftAfterPause === leftAtPause, `the Countdown held through the pause (${leftAtPause} -> ${leftAfterPause})`);
	await E(A, () => /** @type {any} */ (window).__pApi.kit.round.resume());
	await h.eventually(() => round(A), (r) => r.phase === 'playing', 'resumed', 5000);

	// 6 s after resuming: ~14 s of WALL time since go (more than the Countdown's 10), ~8 s of PLAY
	await sleep(6000);
	const r = await round(A);
	h.check(r.phase === 'playing', `still playing 6 s after resuming (phase ${r.phase}${r.outcome ? ', outcome ' + r.outcome : ''})`);
	h.check(r.pausedMs >= 5500, `the pause is banked (${r.pausedMs} ms)`);
	// the pause is NOT on the clock: time left + time played = the limit (a headless page runs at a
	// few fps, so the waits above stretch: ~22 s left on the desk, less on a loaded slot)
	h.check(r.remaining > 14 && Math.abs(r.remaining + r.elapsed - 30) < 0.5, `${r.remaining.toFixed(1)} s left on the 30 s limit after ${r.elapsed.toFixed(1)} s played (the ${(r.pausedMs / 1000).toFixed(1)} s pause excluded)`);
	// and the Countdown still ends it after 10 s of PLAY
	await h.eventually(() => round(A), (x) => x.phase !== 'playing', 'the Countdown ends the round after its 10 s of play', 15000);
	const end = await round(A);
	// each `this.after(1, 'tick')` is scheduled from the frame that ran the last one, so at a few
	// fps the ten ticks drift late: never early, which is the pause's whole point
	h.check(end.outcome === 'Out of time' && end.elapsed > 9.5 && end.elapsed < 18, `lost "Out of time" after ${end.elapsed.toFixed(1)} s of play (10 s of ticks)`);
	await h.finish(browser);
});
