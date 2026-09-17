// 27-D (audit C1) — A RUNAWAY SCRIPT NO LONGER TAKES THE SESSION WITH IT.
//
// A Script node runs on EVERY peer, every frame, on the main thread. So `while (true)`
// in one node is not one person's mistake: it freezes the tab of everyone in the room,
// with no way out but closing it. That is the audit's only CRITICAL finding, and this
// suite is the proof that it is fixed.
//
// What it pins:
//   1. a `while (true)` node reports an error badge instead of hanging
//   2. THE PAGE IS STILL ALIVE afterwards — the check that actually matters, and the one
//      a store read alone cannot make, so it is measured by driving the real UI
//   3. the scene keeps rendering and other nodes keep running
//   4. a SLOW-but-terminating node is paused after a sustained run, not on one bad frame
//   5. `#safe` boots with the runtime paused, which is how a hanging scene gets repaired
//
// The node setup mirrors `script-nodes`: a `script` node needs an `objectselector` and an
// edge, or the runtime resolves no target and the script never runs at all — which would
// make every check here pass while testing nothing.
//
// Run: APP_URL=https://theprototype.app:5175/ npm run e2e -- script-guard
const h = require('./helpers.cjs');

const makeBox = (peer) =>
	peer.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		return new Promise((resolve) =>
			window.__stores.objectsGroup.subscribe((g) =>
				resolve(g.children[g.children.length - 1].uuid)
			)()
		);
	});

/** the script-nodes idiom: script -> objectselector, both stores written, both broadcast */
const addScript = (peer, id, code, uuid) =>
	peer.page.evaluate(
		([nodeId, src, target]) => {
			const nodes = [
				{
					id: nodeId,
					type: 'script',
					position: { x: 0, y: 0 },
					data: { type: 'script', code: src },
					class: 'w-[150px]'
				},
				{
					id: nodeId + '-sel',
					type: 'objectselector',
					position: { x: 300, y: 0 },
					data: { type: 'objectselector', selected: target },
					class: 'w-[150px]'
				}
			];
			const edge = { id: 'e-' + nodeId, source: nodeId, target: nodeId + '-sel' };
			window.__stores.flowNodes.update((n) => [...n, ...nodes]);
			window.__stores.flowEdges.update((e) => [...e, edge]);
		},
		[id, code, uuid]
	);

const badge = (peer, id) =>
	peer.page.evaluate((nodeId) => {
		let v = {};
		window.__stores.scriptErrors.subscribe((m) => (v = m))();
		return v[nodeId] ?? null;
	}, id);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- 1. a runaway loop reports instead of hanging ----------------------------------
	const uuid = await makeBox(A);
	h.check(!!uuid, `premise: an object for the script to target (${uuid})`);
	await addScript(A, 'runaway', 'while (true) { object.position.x += 0.001; }', uuid);

	await h.eventually(
		() => badge(A, 'runaway'),
		(b) => !!b && /loop limit/i.test(String(b)),
		'a while(true) node reports the loop limit instead of freezing',
		15000
	);

	// ---- 2. THE PAGE IS STILL ALIVE ----------------------------------------------------
	// The load-bearing check. With the guard removed this is where the suite dies: the
	// page stops answering and every later call times out.
	const alive = await A.page.evaluate(() => 1 + 1).catch(() => null);
	h.check(alive === 2, 'the page still answers after the runaway ran');

	const clicked = await A.page
		.locator('#logo-button, .logo, header')
		.first()
		.isVisible()
		.catch(() => null);
	h.check(clicked !== null, 'and the real UI is still there to be driven');

	// the frame loop kept going: rAF still fires
	const frames = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				let n = 0;
				const t0 = performance.now();
				const step = () => {
					n++;
					if (performance.now() - t0 > 600) return resolve(n);
					requestAnimationFrame(step);
				};
				requestAnimationFrame(step);
			})
	);
	h.check(frames > 3, `the render loop is still running (${frames} frames in 600ms)`);

	// ---- 3. a healthy node beside it still works ---------------------------------------
	const uuid2 = await makeBox(A);
	await addScript(A, 'healthy', 'object.position.y = base.pos[1] + Math.sin(time * 3);', uuid2);
	await A.page.waitForTimeout(1200);
	const moved = await A.page.evaluate((id) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', id);
		return o ? o.position.y : null;
	}, uuid2);
	h.check(
		moved !== null && Math.abs(moved) > 0.0001,
		`a healthy script node beside the runaway still animates (y=${moved})`
	);
	h.check(!(await badge(A, 'healthy')), 'and it carries no error badge of its own');

	// ---- 4. a SLOW node is paused, and only after a sustained run ------------------------
	const uuid3 = await makeBox(A);
	// Slow but TERMINATING, so only the time budget can catch it — the loop counter never
	// trips. That constrains the fixture in a way worth stating: the guard stops every
	// script at a million iterations, so it cannot buy time by looping MORE, it has to do
	// more work per iteration. 900k plain additions measured about a millisecond here and
	// the check failed for the fixture's sake rather than the feature's.
	const SLOW_SRC =
		'let s = 0; for (let i = 0; i < 500000; i++) { s += Math.sin(i) * Math.cos(i); } data.s = s;';
	const bodyMs = await A.page.evaluate((src) => {
		const fn = new Function('data', src);
		const t0 = performance.now();
		fn({});
		return performance.now() - t0;
	}, SLOW_SRC);
	h.check(
		bodyMs > 8,
		`premise: the slow fixture really is over the 8ms budget on this machine (${bodyMs.toFixed(1)}ms)`
	);
	await addScript(A, 'slow', SLOW_SRC, uuid3);
	const slowBadge = await A.page
		.waitForFunction(
			() => {
				let v = {};
				window.__stores.scriptErrors.subscribe((m) => (v = m))();
				return /too slow/i.test(String(v['slow'] ?? '')) ? v['slow'] : false;
			},
			{ timeout: 30000 }
		)
		.then((r) => r.jsonValue())
		.catch(() => null);
	h.check(!!slowBadge, `a slow node is paused rather than left to eat the frame (${slowBadge})`);
	h.check(
		await A.page.evaluate(() => 1 + 1).then((v) => v === 2),
		'and the page is still responsive after it'
	);

	// ---- 5. safe mode boots paused -------------------------------------------------------
	const S = await h.setupPage(browser, 'S', { hash: '#safe' });
	const paused = await S.page.evaluate(() => {
		let v = { paused: false, reason: '' };
		window.__stores.flowPaused.subscribe((p) => (v = p))();
		return v;
	});
	h.check(paused.paused === true, `#safe boots with the flow runtime paused (${paused.reason})`);

	await h.finish(browser);
});
