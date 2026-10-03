// 34 R2 — THE GAME KIT IN THE APP, on real peers. The rules themselves are proven on the headless
// logic sim (tests/unit/sim, ~110 checks in milliseconds); this suite proves only what the sim
// cannot: the kit's REAL wire (`kit` / `kitreq` through the dispatcher and wireValidate), the
// handshake push to a late joiner, a generated kit NODE acting on a replicated pulse in the real
// flowRuntime (once, though every peer sees the pulse), api.kit on a module, and kit.round driving
// core's game singleton on every peer.
const h = require('./helpers.cjs');

/** a probe module: an api handle on window, and an EVENT node type a test can pulse */
const PROBE = () => {
	const s = /** @type {any} */ (window).__stores;
	s.moduleSDK.initModules([
		{
			id: 'kitprobe',
			name: 'Kit probe',
			version: '1.0.0',
			register(/** @type {any} */ api) {
				/** @type {any} */ (window).__kitApi = api;
				api.registerNodeGroup({ group: 'Kit probe', items: [{ type: 'kitprobe', label: 'Kit probe pulse', defaults: {} }] });
				api.registerValueNode('kitprobe', () => 0, { vtype: 'event' });
			}
		}
	]);
	return !!(/** @type {any} */ (window).__kitApi?.kit?.score);
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) h.check(await p.page.evaluate(PROBE), p.id + ': api.kit is on a module (score, round, levels, rules, pickups)');
	const keys = await A.page.evaluate(() => Object.keys(/** @type {any} */ (window).__kitApi.kit));
	h.check(['rules', 'round', 'levels', 'score', 'pickups'].every((k) => keys.includes(k)), 'api.kit pieces: ' + keys.join(', '));
	const groups = await A.page.evaluate(() => /** @type {any} */ (window).__stores.nodeCatalog.nodeCatalog.filter((/** @type {any} */ g) => g.group.startsWith('Kit:')).map((/** @type {any} */ g) => g.group));
	h.check(['Kit: Rules', 'Kit: Round', 'Kit: Levels', 'Kit: Score', 'Kit: Pickups'].every((g) => groups.includes(g)), 'the node palette carries the generated kit groups: ' + groups.join(', '));

	await h.connect(B, A);
	const dbg = (/** @type {any} */ p) => p.page.evaluate(() => /** @type {any} */ (window).__stores.kit.kitDebug());
	const [da, db] = [await dbg(A), await dbg(B)];
	h.check(da.authority && da.authority === db.authority, `both peers name ONE authority (${da.authority} / ${db.authority})`);
	const authorityPeer = da.authority === A.id ? A : B;
	const other = authorityPeer === A ? B : A;

	// ---- 1. the code path over the real wire: a non-authority add is a request, applied once ----
	await other.page.evaluate(() => /** @type {any} */ (window).__kitApi.kit.score.add(2));
	await h.eventually(() => Promise.all([A, B].map((p) => p.page.evaluate(() => /** @type {any} */ (window).__kitApi.kit.score.total()))), (v) => v[0] === 2 && v[1] === 2, 'a score added on the NON-authority reaches both peers through the authority (kitreq -> kit)', 8000);

	// ---- 2. a kit NODE on a replicated pulse: every peer sees it, the score moves ONCE ----------
	const ids = await A.page.evaluate(() =>
		/** @type {any} */ (window).__kitApi.flow.addNodes({
			nodes: [
				{ type: 'kitprobe', x: 40, y: 40 },
				{ type: 'kit-score-add', x: 260, y: 40, data: { amount: 5 } }
			],
			edges: [{ from: 0, to: 1, handle: 'trigger' }]
		})
	);
	h.check(ids.length === 2, 'premise: the probe pulse and a "Kit: Score ▸ Add score" node, wired, created through api.flow');
	await h.eventually(() => B.page.evaluate((id) => /** @type {any} */ (window).__stores.flowStore?.findNodeAnyGraph?.((/** @type {any} */ n) => n.id === id) ? true : !!(/** @type {any} */ (window).__kitApi.flow.nodes('kit-score-add').length), ids[1]), (v) => v, 'premise: the peer holds the kit node', 10000);
	await A.page.waitForTimeout(1200); // past both peers' first sight of the new nodes (actionSeenAt)
	await B.page.evaluate(() => /** @type {any} */ (window).__kitApi.fireNodeTrigger('kitprobe'));
	await h.eventually(() => Promise.all([A, B].map((p) => p.page.evaluate(() => /** @type {any} */ (window).__kitApi.kit.score.total()))), (v) => v[0] === 7 && v[1] === 7, 'one replicated pulse into a kit node: +5 ONCE on both peers (7), never once per peer', 8000);
	await A.page.waitForTimeout(1500);
	const after = await Promise.all([A, B].map((p) => p.page.evaluate(() => /** @type {any} */ (window).__kitApi.kit.score.total())));
	h.check(after[0] === 7 && after[1] === 7, `…and it stays 7 (no late double: ${after})`);
	const dup = await Promise.all([A, B].map((p) => p.page.evaluate(() => /** @type {any} */ (window).__stores.kit.kitDebug().stats.duplicate)));
	h.check(dup[0] + dup[1] >= 1, `the second peer's ask for the same press was recognised as a duplicate (${dup})`);

	// ---- 3. kit.round drives core's game singleton on every peer -------------------------------
	await other.page.evaluate(() => {
		const k = /** @type {any} */ (window).__kitApi.kit;
		k.round.configure(0, 0, 'lose', 1);
		k.round.start();
	});
	const gstate = (/** @type {any} */ p) => p.page.evaluate(() => {
		let g;
		/** @type {any} */ (window).__stores.gameState.gameState.subscribe((/** @type {any} */ v) => (g = v))();
		return { state: g.state, round: g.round, phase: /** @type {any} */ (window).__kitApi.kit.round.phase() };
	});
	await h.eventually(() => Promise.all([A, B].map(gstate)), (v) => v.every((g) => g.state === 'playing' && g.phase === 'playing') && v[0].round === v[1].round && v[0].round > 0, 'kit.round.start from either peer: core\'s game is playing, one round, on both', 8000);
	const r0 = (await gstate(A)).round;
	await other.page.evaluate(() => /** @type {any} */ (window).__kitApi.kit.round.restart());
	await h.eventually(() => Promise.all([A, B].map(gstate)), (v) => v.every((g) => g.state === 'playing' && g.round === r0 + 1), 'Restart WHILE playing: a fresh core round on both peers (no menu detour)', 8000);
	await h.eventually(() => A.page.evaluate(() => /** @type {any} */ (window).__kitApi.kit.score.total()), (t) => t === 0, 'the new round zeroed the kit score', 5000);
	await other.page.evaluate(() => /** @type {any} */ (window).__kitApi.kit.round.win('probe'));
	await h.eventually(() => Promise.all([A, B].map((p) => p.page.evaluate(() => {
		let g;
		/** @type {any} */ (window).__stores.gameState.gameState.subscribe((/** @type {any} */ v) => (g = v))();
		return g.state + '/' + g.outcome;
	}))), (v) => v.every((x) => x === 'over/probe'), 'win(reason): core\'s game is over with the reason as its outcome, on both', 8000);

	// ---- 4. a late joiner gets the kit document in the handshake --------------------------------
	await authorityPeer.page.evaluate(() => /** @type {any} */ (window).__kitApi.kit.score.add(4));
	const C = await h.setupPage(browser, 'C');
	await C.page.evaluate(PROBE);
	await h.connect(C, A);
	await h.eventually(() => C.page.evaluate(() => [/** @type {any} */ (window).__kitApi.kit.score.total(), /** @type {any} */ (window).__kitApi.kit.round.phase()]), (v) => v[0] === 4 && (v[1] === 'won' || v[1] === 'results'), 'a LATE joiner holds the kit document (score 4, the ended round) from the handshake', 12000);
	const wire = await A.page.evaluate(() => /** @type {any} */ (window).__stores.kit.kitDebug().stats);
	h.check(wire.received > 0 || wire.applied > 0, 'the kit went over the real wire (' + JSON.stringify(wire) + ')');

	await h.finish(browser);
});
