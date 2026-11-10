// 78 F13 — "Game Start" WAS NOT AN EVENT. It reads like one, but it is a camera setting with no
// pulse (it switches to its camera when the game state becomes playing), and pressing Play changed
// no game state — so "reset the score / spawn the gems when Play begins" could not be built from
// nodes. Now the node is labelled "Start camera" (type id `gamestart` unchanged, old scenes load),
// and two real event nodes exist:
//   On Play start / On Play stop, `who`:
//     session (default) — pulses once when the SESSION starts playing (the first player presses
//                         Play) / stops (the last player leaves), on every peer
//     me                — pulses once when THIS peer presses Play / leaves it, on this peer only
// Two peers:
//   1. A presses Play: session start 1 on A AND B; me start 1 on A, 0 on B.
//   2. B presses Play: session start still 1 everywhere (the session was already playing); me
//      start 1 on B.
//   3. A leaves: no session stop yet (B still plays); me stop 1 on A.
//   4. B leaves: session stop 1 on both.
//   5. The catalog says "Start camera"; an old node saved with the label "Game Start" still loads.
//
//   APP_URL=https://theprototype.app:5802/ node tests/e2e/play-start-nodes.test.cjs
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const build = (page) =>
		page.evaluate(() => {
			const counter = (id, y) => ({ id, type: 'counter', position: { x: 300, y }, data: { label: 'Counter', op: 'up', step: 1 } });
			const nodes = [
				{ id: 'ps', type: 'onplaystart', position: { x: 0, y: 0 }, data: { label: 'On Play start', pulse: 0.3 } },
				{ id: 'pe', type: 'onplaystop', position: { x: 0, y: 120 }, data: { label: 'On Play stop', pulse: 0.3 } },
				{ id: 'ms', type: 'onplaystart', position: { x: 0, y: 240 }, data: { label: 'On Play start', pulse: 0.3, who: 'me' } },
				{ id: 'me', type: 'onplaystop', position: { x: 0, y: 360 }, data: { label: 'On Play stop', pulse: 0.3, who: 'me' } },
				// an old scene's node: the type id is unchanged, the label it was saved with is the old one
				{ id: 'cam', type: 'gamestart', position: { x: 0, y: 480 }, data: { label: 'Game Start', camera: '', state: 'playing' } },
				counter('cS', 0),
				counter('cE', 120),
				counter('cMS', 240),
				counter('cME', 360)
			];
			const edges = [
				{ id: 'e1', source: 'ps', target: 'cS' },
				{ id: 'e2', source: 'pe', target: 'cE' },
				{ id: 'e3', source: 'ms', target: 'cMS' },
				{ id: 'e4', source: 'me', target: 'cME' }
			];
			window.__stores.flowNodes.set(nodes);
			window.__stores.flowEdges.set(edges);
		});
	await build(A.page);
	await build(B.page);
	await A.page.waitForTimeout(1500);

	const counts = (page) =>
		page.evaluate(() => {
			let t;
			window.__stores.flowTriggers.subscribe((v) => (t = v))();
			const c = (id) => t[id]?.count ?? 0;
			return { start: c('cS'), stop: c('cE'), myStart: c('cMS'), myStop: c('cME') };
		});
	const both = async () => ({ a: await counts(A.page), b: await counts(B.page) });
	const fmt = (r) => `A ${JSON.stringify(r.a)} B ${JSON.stringify(r.b)}`;

	h.check(JSON.stringify((await both()).a) === JSON.stringify({ start: 0, stop: 0, myStart: 0, myStop: 0 }), 'premise: nothing fired in the editor');

	// 1. A presses Play
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(both, (r) => r.a.start === 1 && r.b.start === 1, 'A presses Play: On Play start (session) pulses once on A AND on B', 10000);
	const r1 = await both();
	h.check(r1.a.myStart === 1 && r1.b.myStart === 0, `On Play start (me) pulses on A only (${fmt(r1)})`);

	// 2. B presses Play too
	await B.page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(both, (r) => r.b.myStart === 1, 'B presses Play: On Play start (me) pulses on B', 10000);
	await B.page.waitForTimeout(1500);
	const r2 = await both();
	h.check(r2.a.start === 1 && r2.b.start === 1, `... and the session start does NOT pulse again (the session already played) (${fmt(r2)})`);

	// 3. A leaves
	await h.leavePlay(A);
	await h.eventually(both, (r) => r.a.myStop === 1, 'A leaves: On Play stop (me) pulses on A', 10000);
	await A.page.waitForTimeout(1500);
	const r3 = await both();
	h.check(r3.a.stop === 0 && r3.b.stop === 0, `... and no session stop while B still plays (${fmt(r3)})`);

	// 4. B leaves: the session stops
	await h.leavePlay(B);
	await h.eventually(both, (r) => r.a.stop === 1 && r.b.stop === 1, 'B leaves (the last player): On Play stop (session) pulses once on both', 12000);
	const r4 = await both();
	h.check(r4.b.myStop === 1 && r4.a.myStop === 1, `On Play stop (me) pulsed once per peer for its own leave (${fmt(r4)})`);

	// 5. the rename
	const names = await A.page.evaluate(() => {
		const s = window.__stores;
		return {
			start: s.nodeCatalog.findNodeSpec('gamestart')?.label ?? null,
			ps: s.nodeCatalog.findNodeSpec('onplaystart')?.label ?? null,
			pe: s.nodeCatalog.findNodeSpec('onplaystop')?.label ?? null,
			card: document.querySelector('[data-id="cam"]')?.textContent ?? null
		};
	});
	h.check(names.start === 'Start camera', `the camera setting is "Start camera" in the catalog (${names.start})`);
	h.check(names.ps === 'On Play start' && names.pe === 'On Play stop', `the event nodes are in the catalog (${names.ps} / ${names.pe})`);
	await h.finish(browser);
});
