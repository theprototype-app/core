// fix-agenttest item 10 — ONE CLICK ACTS ONCE.
// Reported from the agent test: "input-event graphs (onclick/onhit) run on EVERY peer, so a
// toggle/latch fires 2-3x and cancels out". Two peers and an agent page (a third app page at 4x
// CPU throttle, the agent's headless browser), ONE click on the host, then one on the agent:
// per peer, count the On Click pulses and the Latch flips, and read two SHARED variables — `n`
// (Set Variable op add 1) and `t` (Set Variable set to NOT Get Variable t, the toggle an agent
// builds when it has no toggle node).
// VERIFIED on v1.47.0 (click-once-2, before the fix): the On Click pulses once per peer and the
// Latch flips once per peer (the agent page just draws it late) — but the SHARED variables did not
// hold: a click on the agent page left n = 3 (want 2) and t = 1 (want 0, flipped twice) on every
// peer. Each peer ran Set Variable from the replicated stamp and wrote from its own current value.
// The first fix (the op to the authority alone) still lost the add in game-state: the other peer's
// Set Game State, run from the same click with a newer stamp, carried its old variables over it —
// so the game singleton's variables carry their own stamps now (gameState.mergeGameState).
// Counterfactual on v1.47.0: 2.3 and 2.4 are red.
const h = require('./helpers.cjs');

const GRAPH = {
	nodes: [
		{ id: 'click', type: 'onclick', data: {} },
		{ id: 'latch1', type: 'latch', data: { initial: false } },
		{ id: 'vis', type: 'visibility', data: { on: true } },
		{ id: 'selBox', type: 'objectselector', data: {} },
		{ id: 'addN', type: 'setvariable', data: { name: 'n', op: 'add', value: 1, scope: 'shared' } },
		{ id: 'getT', type: 'getvariable', data: { name: 't', fallback: 0 } },
		{ id: 'notT', type: 'gate', data: { op: 'not' } },
		{ id: 'setT', type: 'setvariable', data: { name: 't', op: 'set', value: 0, scope: 'shared' } }
	],
	edges: [
		['click', 'latch1', 'toggle'],
		['latch1', 'vis', 'on'],
		['vis', 'selBox', null],
		['click', 'addN', 'trigger'],
		['getT', 'notT', 'a'],
		['notT', 'setT', 'value'],
		['click', 'setT', 'trigger']
	]
};

/** watch, from boot, every pulse of `click` and every flip of `latch1` this page sees */
const watch = (p) =>
	p.page.evaluate(() => {
		const S = window.__stores;
		window.__seen = { pulses: 0, flips: 0 };
		let lastT = null;
		S.flowTriggers.subscribe((m) => {
			const t = m?.click?.lastT ?? null;
			if (t !== null && t !== lastT) {
				if (lastT !== null || window.__armed) window.__seen.pulses++;
				lastT = t;
			}
		});
		let latch = null;
		S.flowValues.subscribe((v) => {
			const now = v?.latch1;
			if (now === undefined) return;
			if (latch !== null && now !== latch) window.__seen.flips++;
			latch = now;
		});
		window.__armed = true;
	});

const read = (p) =>
	p.page.evaluate(() => {
		let g;
		window.__stores.gameState.gameState.subscribe((v) => (g = v))();
		let v;
		window.__stores.flowValues.subscribe((x) => (v = x))();
		return { ...window.__seen, latch: v?.latch1 ?? null, n: g?.vars?.n ?? 0, t: g?.vars?.t ?? 0 };
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(({ nodes, edges }) => {
		const S = window.__stores;
		S.commandsHandler.sceneCommand('/create box');
		let g;
		S.objectsGroup.subscribe((x) => (g = x))();
		const box = g.children[g.children.length - 1];
		box.name = 'Button';
		S.objectActions.deselectObject();
		nodes.forEach((n, i) => {
			const data = n.id === 'selBox' ? { selected: box.uuid } : n.data;
			S.nodesHandler.createFlowNode({ id: n.id, type: n.type, position: { x: (i % 4) * 200, y: Math.floor(i / 4) * 140 }, data: { type: n.type, ...data } });
		});
		for (const [source, target, targetHandle] of edges)
			S.nodesHandler.createFlowEdge({ id: 'e-' + source + '-' + target + (targetHandle ? '.' + targetHandle : ''), source, target, ...(targetHandle ? { targetHandle } : {}) });
		window.__button = box.uuid;
	}, GRAPH);
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const C = await h.setupPageQuiet(browser, 'agent', [A, B]); // the third page boots with the others' drawing paused
	await h.connect(C, A);
	const peers = [A, B, C];
	const button = await A.page.evaluate(() => window.__button);
	await h.eventually(
		() => Promise.all(peers.map((p) => p.page.evaluate(() => window.__stores.nodesHandler.graphHash()))),
		(hs) => hs.every((x) => x === hs[0]),
		'premise: all three peers hold the graph',
		40000
	);
	await h.eventually(
		() => Promise.all(peers.map((p) => p.page.evaluate(() => { let pr; window.__stores.peers.subscribe((v) => (pr = v))(); return pr?.openedPeers?.size ?? 0; }))),
		(n) => n.every((v) => v === 2),
		'premise: a full mesh (a guest\'s click reaches the other guest over their own link; v1.47.0 takes up to ~60 s here too)',
		90000
	);
	console.log('  links per peer (A, B, agent): ' + JSON.stringify(await Promise.all(peers.map((p) => p.page.evaluate(() => { let pr; window.__stores.peers.subscribe((v) => (pr = v))(); return pr?.openedPeers?.size ?? 0; })))));
	// the agent's headless browser runs slow: throttled from here on (the dial itself is not the subject)
	await (await C.ctx.newCDPSession(C.page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
	for (const p of peers) await watch(p);
	await A.page.waitForTimeout(1500);

	const want = (round) => ({ pulses: round, flips: round, latch: round % 2 === 1, n: round, t: round % 2 });
	const settled = (s, round) => Object.entries(want(round)).every(([k, v]) => s[k] === v);
	for (const [round, clicker] of [[1, A], [2, C]]) {
		await clicker.page.evaluate((u) => window.__stores.flowRuntime.fireObjectClick(u), button);
		// every peer reaches the one-click state (the throttled agent page draws its Latch late)...
		await h.eventually(() => Promise.all(peers.map(read)), (all) => all.every((s) => settled(s, round)), `${round}.0 every peer settles on one click's worth`, 25000).catch(() => {});
		// ...and a late second write would land within this
		await A.page.waitForTimeout(4000);
		const seen = await Promise.all(peers.map(read));
		console.log(`  round ${round} (click on ${clicker.id}): ` + JSON.stringify(Object.fromEntries(peers.map((p, i) => [p.id, seen[i]]))));
		for (const [i, p] of peers.entries()) {
			const s = seen[i];
			h.check(s.pulses === round, `${round}.1 ${p.id}: the On Click pulsed once per click (${s.pulses} after ${round})`);
			h.check(s.flips === round && s.latch === (round % 2 === 1), `${round}.2 ${p.id}: the Latch flipped once per click (${s.flips} flips, now ${s.latch})`);
			h.check(s.n === round, `${round}.3 ${p.id}: the shared add counted each click once (n = ${s.n})`);
			h.check(s.t === round % 2, `${round}.4 ${p.id}: the shared toggle flipped once per click (t = ${s.t})`);
		}
	}

	for (const p of peers) {
		const errs = h.pageErrors(p);
		h.check(errs.length === 0, `no page errors on ${p.id}: ` + JSON.stringify(errs.slice(0, 3)));
	}
	await h.finish(browser);
});
