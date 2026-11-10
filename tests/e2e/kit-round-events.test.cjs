// 78 F17 — ROUND EVENTS AND REFUSALS, the agent research's shape (round 1, preview-55): the
// authority is one peer, the button is pressed on the OTHER (the agent's page), kit ACTION nodes
// run from a replicated On Click, and the round's EVENT nodes are read back from the trigger log.
// Reported: "started" never pulsed (only "go") and "lost" from a Lose node never pulsed (only the
// "results" a second later); "win" during the results was refused with no reason anywhere.
// Now: every event pulses on both peers, and a refusal carries its reason to the requester
// ({refused: true, reason}), to kitDebug().refusals and to the diagnostics log (the agent's logs
// and the Debug console read it).
const h = require('./helpers.cjs');

const PROBE = () => {
	const s = /** @type {any} */ (window).__stores;
	s.moduleSDK.initModules([
		{
			id: 'kitprobe',
			name: 'Kit probe',
			version: '1.0.0',
			register(/** @type {any} */ api) {
				/** @type {any} */ (window).__kitApi = api;
			}
		}
	]);
	return !!(/** @type {any} */ (window).__kitApi?.kit?.round);
};

const ACTIONS = [
	['kit-round-configure', { intro: 1, limit: 0, timeout: 'lose', outro: 1 }],
	['kit-round-start', {}],
	['kit-round-lose', { reason: 'lab' }],
	['kit-round-win', { reason: 'late' }],
	['kit-round-restart', {}]
];
const EVENTS = ['started', 'go', 'lost', 'results'];

/** the last stamp of each event node, per page (null = never) */
const stamps = (/** @type {any} */ p) =>
	p.page.evaluate((events) => {
		const S = /** @type {any} */ (window).__stores;
		let trig;
		S.flowTriggers.subscribe((/** @type {any} */ m) => (trig = m))();
		return Object.fromEntries(events.map((e) => [e, trig?.['ev-' + e]?.lastT ?? null]));
	}, EVENTS);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) h.check(await p.page.evaluate(PROBE), 'premise: api.kit on ' + p.id);
	await h.connect(B, A);
	const auth = await A.page.evaluate(() => /** @type {any} */ (window).__stores.kit.kitDebug().authority);
	const host = auth === A.id ? A : B;
	const other = host === A ? B : A;
	console.log('  authority ' + host.id + ', presses on ' + other.id);

	// buttons (one box per action, an On Click -> the action in its own flow) + the event nodes in the scene graph
	const buttons = await A.page.evaluate(({ actions, events }) => {
		const S = /** @type {any} */ (window).__stores;
		/** @type {string[]} */
		const ids = [];
		actions.forEach(([type, data], i) => {
			S.commandsHandler.sceneCommand('/create box');
			let g;
			S.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
			const box = g.children[g.children.length - 1];
			box.name = 'btn ' + type;
			box.position.set(i * 1.2 - 3, 0.5, 0);
			ids.push(box.uuid);
			const c = 'click-' + i, a = 'act-' + i, sel = 'sel-' + i;
			S.nodesHandler.createFlowNode({ id: sel, type: 'objectselector', position: { x: 0, y: i * 120 }, data: { type: 'objectselector', selected: box.uuid } });
			S.nodesHandler.createFlowNode({ id: c, type: 'onclick', position: { x: 200, y: i * 120 }, data: { type: 'onclick' } });
			S.nodesHandler.createFlowNode({ id: a, type, position: { x: 400, y: i * 120 }, data: { type, ...data } });
			S.nodesHandler.createFlowEdge({ id: 'e-' + c + '-' + sel, source: c, target: sel });
			S.nodesHandler.createFlowEdge({ id: 'e-' + c + '-' + a + '.trigger', source: c, target: a, targetHandle: 'trigger' });
		});
		events.forEach((/** @type {string} */ e, i) =>
			S.nodesHandler.createFlowNode({ id: 'ev-' + e, type: 'kit-round-' + e, position: { x: 700, y: i * 120 }, data: { type: 'kit-round-' + e } })
		);
		S.objectActions.deselectObject();
		return ids;
	}, { actions: ACTIONS, events: EVENTS });
	await h.eventually(
		() => Promise.all([A, B].map((p) => p.page.evaluate(() => /** @type {any} */ (window).__stores.nodesHandler.graphHash()))),
		(hs) => hs[0] === hs[1],
		'premise: both peers hold the graph',
		30000
	);
	await A.page.waitForTimeout(1500); // past both peers' first sight of the action nodes

	const press = async (/** @type {number} */ i) => {
		const n = await other.page.evaluate((u) => /** @type {any} */ (window).__stores.flowRuntime.fireObjectClick(u), buttons[i]);
		h.check(n >= 1, 'premise: the press of ' + ACTIONS[i][0] + ' reached its On Click (' + n + ')');
	};
	const phase = () => host.page.evaluate(() => /** @type {any} */ (window).__kitApi.kit.round.phase());

	await press(0);
	await h.eventually(() => host.page.evaluate(() => /** @type {any} */ (window).__stores.kit.kitDebug().doc.slices.round.intro), (v) => v === 1, 'premise: configured (intro 1 s)', 8000);

	// ---- 1. start: "started" pulses (then "go"), on BOTH peers ----------------------------------
	await press(1);
	await h.eventually(phase, (v) => v === 'playing', 'premise: the round started and is playing after its 1 s intro', 10000);
	for (const p of [A, B]) {
		const s = await stamps(p);
		h.check(s.started !== null, '1.1 "On round start" pulsed on ' + p.id + ' (' + JSON.stringify(s) + ')');
		h.check(s.go !== null, '1.2 "On go" pulsed on ' + p.id);
	}

	// ---- 2. a Lose node: "lost" pulses (then "results") -----------------------------------------
	await press(2);
	await h.eventually(phase, (v) => v === 'results', 'premise: lost, then the results after the 1 s outro', 10000);
	for (const p of [A, B]) {
		const s = await stamps(p);
		h.check(s.lost !== null, '2.1 "On round lost" pulsed on ' + p.id + ' (' + JSON.stringify(s) + ')');
		h.check(s.results !== null, '2.2 "On results" pulsed on ' + p.id);
	}

	// ---- 3. win during the results is refused WITH a reason, everywhere it is asked -------------
	const viaApi = await other.page.evaluate(() => /** @type {any} */ (window).__kitApi.kit.round.win('api'));
	console.log('  win() on the non-authority returned ' + JSON.stringify(viaApi));
	await press(3);
	await h.eventually(
		() => host.page.evaluate(() => /** @type {any} */ (window).__stores.kit.kitDebug().refusals ?? []),
		(r) => r.some((/** @type {any} */ x) => x.piece === 'round' && x.op === 'win' && /results/.test(x.reason)),
		'3.1 the authority keeps the refusal with its reason (kitDebug().refusals: round.win, "…results…")',
		8000
	);
	await h.eventually(
		() => other.page.evaluate(() => /** @type {any} */ (window).__stores.kit.kitDebug().refusals ?? []),
		(r) => r.some((/** @type {any} */ x) => x.piece === 'round' && x.op === 'win' && /results/.test(x.reason)),
		'3.2 …and so does the peer that pressed (the reason came back with the document)',
		8000
	);
	const logLine = await other.page.evaluate(() =>
		/** @type {any} */ (window).__stores.diagnostics?.entries?.().filter((/** @type {any} */ e) => e.scope === 'kit').map((/** @type {any} */ e) => e.message) ?? null
	);
	h.check(Array.isArray(logLine) && logLine.some((m) => /round\.win refused/.test(m)), '3.3 the diagnostics log (the agent\'s logs, the Debug console) says it: ' + JSON.stringify(logLine));
	const direct = await host.page.evaluate(() => /** @type {any} */ (window).__kitApi.kit.round.win('direct'));
	h.check(direct?.refused === true && /results/.test(direct?.reason ?? ''), '3.4 on the authority the call itself answers {refused: true, reason}: ' + JSON.stringify(direct));

	// ---- 4. restart: "started" pulses again ---------------------------------------------------
	const before = (await stamps(other)).started;
	await press(4);
	await h.eventually(() => stamps(other), (s) => s.started !== null && s.started !== before, '4.1 Restart: "On round start" pulses again', 10000);

	await h.finish(browser);
});
