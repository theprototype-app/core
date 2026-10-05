// 36 (plans 56.1 / 56.3 / 56.4 + DEVX #22) — the VALUE GRAPH runtime, on two real peers.
//
//   1. 56.1 accept: Slider -> Math(sin) -> Bounce.amplitude — both peers derive the SAME resolved
//      amplitude at the same synced time (nothing about the value is sent)
//   2. 56.1 memo: a chain of 12 "diamonds" (Math a+b with BOTH inputs from the previous node) gives
//      source × 2^12, and one tick runs about one evaluation per node — before the memo the
//      source alone ran 2^12 times per readout (counterfactual: drop the memo → evals explode)
//   3. 56.1 cycles: two Math nodes feeding each other evaluate (no hang), finite, equal on both peers
//   4. 56.3 accept: a v2 EFFECT script reads two inputs and drives a THIRD object (both peers)
//   5. 56.3 api: object(name), raycast() down onto a box, keys() refused in a value script,
//      spawn() creates ONE object for the whole session (the authority spawns, the peer receives)
//   6. DEVX #22: HUD Button -> Math.a reads the press pulse (it read undefined before)
//
// Run: APP_URL=https://theprototype.app:5329/ npm run e2e -- value-graph
const h = require('./helpers.cjs');

const node = (id, type, data, x = 0, y = 0) => ({ id, type, position: { x, y }, data: { type, ...data }, class: 'w-[150px]' });
const edge = (source, target, targetHandle, sourceHandle) => ({
	id: 'e-' + source + (sourceHandle ? '.' + sourceHandle : '') + '-' + target + (targetHandle ? '.' + targetHandle : ''),
	source,
	target,
	...(targetHandle ? { targetHandle } : {}),
	...(sourceHandle ? { sourceHandle } : {})
});
const addGraph = (peer, nodes, edges) =>
	peer.page.evaluate(
		([nodes, edges]) => {
			window.__stores.flowNodes.update((n) => [...n, ...nodes]);
			window.__stores.flowEdges.update((e) => [...e, ...edges]);
			return new Promise((resolve) => {
				window.__stores.peers.subscribe((peer) => {
					nodes.forEach((node) => peer.send({ type: 'nodecreate', node }));
					edges.forEach((edge) => peer.send({ type: 'edgecreate', edge }));
					resolve();
				})();
			});
		},
		[nodes, edges]
	);
const makeBox = (peer, name, pos) =>
	peer.page.evaluate(
		([name, pos]) => {
			const s = window.__stores;
			s.commandsHandler.sceneCommand('/create box');
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const o = g.children[g.children.length - 1];
			o.name = name;
			o.position.set(pos[0], pos[1], pos[2]);
			o.updateMatrixWorld(true);
			// names are local here (no rename message needed: the scripts look objects up by uuid)
			window.__stores.peers.subscribe((p) => p?.send({ type: 'move', uuid: o.uuid, pos, rot: [0, 0, 0], scale: [1, 1, 1] }))();
			return o.uuid;
		},
		[name, pos]
	);
/** evaluate a node's value at a FIXED synced time on this peer (the determinism probe) */
const valueAt = (peer, id, t) =>
	peer.page.evaluate(
		([id, t]) => {
			const s = window.__stores;
			const nodes = s.allNodes();
			const n = nodes.find((x) => x.id === id);
			return s.flowRuntime.evalNode(n, nodes, s.allEdges(), t, new Set(), null);
		},
		[id, t]
	);
const resolvedAt = (peer, id, t) =>
	peer.page.evaluate(
		([id, t]) => {
			const s = window.__stores;
			const nodes = s.allNodes();
			const n = nodes.find((x) => x.id === id);
			return s.flowRuntime.resolveInputs(n, nodes, s.allEdges(), t, null);
		},
		[id, t]
	);
const readValue = (peer, id) =>
	peer.page.evaluate((id) => new Promise((r) => window.__stores.flowValues.subscribe((v) => r(v[id] ?? null))()), id);
const readError = (peer, id) =>
	peer.page.evaluate((id) => new Promise((r) => window.__stores.scriptErrors.subscribe((m) => r(m[id] ?? null))()), id);
const objPos = (peer, uuid) =>
	peer.page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g?.getObjectByProperty('uuid', uuid);
		return o ? [o.position.x, o.position.y, o.position.z] : null;
	}, uuid);
const objCount = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children.length;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const bounceBox = await makeBox(A, 'Bouncer', [0, 0.5, 0]);
	const third = await makeBox(A, 'Third', [3, 0.5, 0]);
	const floor = await makeBox(A, 'Floor box', [0, 0.5, -6]);
	await A.page.waitForTimeout(1500);

	// --- 1: slider -> math(sin) -> bounce.amplitude ---------------------------------------
	await addGraph(
		A,
		[
			node('vg-slider', 'slider', { label: 'Slider', value: 1.2, min: 0, max: 3 }, 0, 0),
			node('vg-time', 'time', { label: 'Time', mode: 'linear', rate: 1 }, 0, 120),
			node('vg-sum', 'math', { label: 'Math', op: 'add', a: 0, b: 0 }, 200, 0),
			node('vg-sin', 'math', { label: 'Math', op: 'sin', a: 0, b: 1 }, 400, 0),
			node('vg-bounce', 'bounce', { label: 'Bounce', amplitude: 0.5, speed: 2 }, 600, 0),
			node('vg-sel', 'objectselector', { label: 'Object Selector', selected: bounceBox }, 800, 0)
		],
		[
			edge('vg-slider', 'vg-sum', 'a'),
			edge('vg-time', 'vg-sum', 'b'),
			edge('vg-sum', 'vg-sin', 'a'),
			edge('vg-sin', 'vg-bounce', 'amplitude'),
			edge('vg-bounce', 'vg-sel')
		]
	);
	await A.page.waitForTimeout(1500);
	const T = 12.345;
	const ampA = (await resolvedAt(A, 'vg-bounce', T))?.amplitude;
	const ampB = (await resolvedAt(B, 'vg-bounce', T))?.amplitude;
	const want = Math.sin(1.2 + T);
	h.check(Math.abs(ampA - want) < 1e-9, `A: Bounce.amplitude = sin(slider + time) at t=${T} (${ampA} vs ${want})`);
	h.check(ampA === ampB, `B derives the identical amplitude itself (${ampA} / ${ampB})`);
	const sinLive = await readValue(B, 'vg-sin');
	h.check(typeof sinLive === 'number' && Math.abs(sinLive) <= 1, `the Math(sin) card shows a live value on B (${sinLive})`);

	// --- 2: the memo -------------------------------------------------------------------
	const chain = [node('vg-d0', 'number', { label: 'Number', value: 1, step: 1 }, 0, 400)];
	const chainEdges = [];
	for (let i = 1; i <= 12; i++) {
		chain.push(node('vg-d' + i, 'math', { label: 'Math', op: 'add', a: 0, b: 0 }, i * 160, 400));
		chainEdges.push(edge('vg-d' + (i - 1), 'vg-d' + i, 'a'), edge('vg-d' + (i - 1), 'vg-d' + i, 'b'));
	}
	await addGraph(A, chain, chainEdges);
	await A.page.waitForTimeout(1200);
	const top = await readValue(A, 'vg-d12');
	h.check(top === 4096, `12 diamonds: 1 × 2^12 = ${top}`);
	h.check((await readValue(B, 'vg-d12')) === 4096, 'B computes the same 4096');
	const stats = await A.page.evaluate(() => window.__stores.flowRuntime.flowValueStats());
	h.check(stats.evals > 0 && stats.evals <= stats.nodes * 3, `one tick evaluates ~once per node (${stats.evals} evaluations over ${stats.nodes} nodes; 2^12 = 4096 for the chain alone without the memo)`);

	// --- 3: a cycle --------------------------------------------------------------------
	await addGraph(
		A,
		[
			node('vg-c1', 'math', { label: 'Math', op: 'add', a: 1, b: 1 }, 0, 600),
			node('vg-c2', 'math', { label: 'Math', op: 'add', a: 2, b: 2 }, 200, 600)
		],
		[edge('vg-c1', 'vg-c2', 'a'), edge('vg-c2', 'vg-c1', 'a')]
	);
	await A.page.waitForTimeout(1200);
	const c1A = await readValue(A, 'vg-c1');
	const c1B = await readValue(B, 'vg-c1');
	h.check(Number.isFinite(c1A) && c1A === c1B, `a two-node cycle evaluates, finite and equal on both peers (${c1A} / ${c1B})`);
	h.check((await readValue(A, 'vg-d12')) === 4096, 'the rest of the graph keeps running beside the cycle');

	// --- 4: a v2 effect script reads two inputs and drives a third object --------------
	await addGraph(
		A,
		[
			node('vg-na', 'number', { label: 'Number', value: 2, step: 1 }, 0, 800),
			node('vg-nb', 'number', { label: 'Number', value: 5, step: 1 }, 0, 900),
			node(
				'vg-eff',
				'script',
				{
					label: 'Script',
					inputs: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }],
					code: 'object.position.x = inputs.a + inputs.b;\nobject.position.z = 1;'
				},
				200,
				800
			),
			node('vg-sel3', 'objectselector', { label: 'Object Selector', selected: third }, 400, 800)
		],
		[edge('vg-na', 'vg-eff', 'a'), edge('vg-nb', 'vg-eff', 'b'), edge('vg-eff', 'vg-sel3')]
	);
	await h.eventually(() => objPos(A, third), (p) => p && Math.abs(p[0] - 7) < 1e-6, 'A: the script put Third at x = 2 + 5', 5000);
	await h.eventually(() => objPos(B, third), (p) => p && Math.abs(p[0] - 7) < 1e-6, 'B runs the same script and agrees (x = 7)', 5000);
	await A.page.evaluate(() => window.__stores.nodesHandler.setNodeData('vg-nb', { value: 10 }));
	await h.eventually(() => objPos(B, third), (p) => p && Math.abs(p[0] - 12) < 1e-6, 'a changed input reaches the third object on B (x = 12)', 5000);

	// --- 5: the api ---------------------------------------------------------------------
	await addGraph(
		A,
		[
			node(
				'vg-api',
				'script',
				{
					label: 'Script',
					inputs: [],
					outputs: [{ name: 'found', type: 'number' }, { name: 'hitY', type: 'number' }, { name: 'hit', type: 'boolean' }],
					code:
						`const o = api.object('${floor}');\n` +
						'const r = o ? api.raycast([o.position[0], 5, o.position[2]], [0, -1, 0], 20) : null;\n' +
						`return { found: o ? 1 : 0, hitY: r ? r.point[1] : -1, hit: !!r && r.uuid === '${floor}' };`
				},
				0,
				1100
			)
		],
		[]
	);
	await A.page.waitForTimeout(1200);
	const apiVal = await valueAt(A, 'vg-api', 1);
	h.check(apiVal?.__handles?.found === 1, `api.object(uuid) finds the box (${JSON.stringify(apiVal?.__handles)})`);
	h.check(apiVal?.__handles?.hit === true && Math.abs(apiVal.__handles.hitY - 1) < 0.05, `api.raycast straight down hits the box top at y≈1 (${apiVal?.__handles?.hitY})`);
	const apiB = await valueAt(B, 'vg-api', 1);
	h.check(JSON.stringify(apiB?.__handles) === JSON.stringify(apiVal?.__handles), 'B answers the same world query identically');

	await addGraph(
		A,
		[node('vg-keys', 'script', { label: 'Script', inputs: [], outputs: [{ name: 'n', type: 'number' }], code: 'return { n: api.keys().length };' }, 0, 1300)],
		[]
	);
	await h.eventually(() => readError(A, 'vg-keys'), (e) => /api\.keys\(\) is this device/.test(e ?? ''), 'keys() in a VALUE script is refused with a badge that says why', 5000);

	const before = await objCount(B);
	await addGraph(
		A,
		[
			node(
				'vg-spawn',
				'script',
				{
					label: 'Script',
					inputs: [{ name: 'go', type: 'number' }],
					code: "if (inputs.go > 0 && !data.done) { api.spawn('/create sphere'); }"
				},
				200,
				1300
			),
			node('vg-go', 'number', { label: 'Number', value: 0, step: 1 }, 0, 1400),
			node('vg-sel4', 'objectselector', { label: 'Object Selector', selected: floor }, 400, 1300)
		],
		[edge('vg-go', 'vg-spawn', 'go'), edge('vg-spawn', 'vg-sel4')]
	);
	await A.page.waitForTimeout(800);
	await A.page.evaluate(() => window.__stores.nodesHandler.setNodeData('vg-go', { value: 1 }));
	await h.eventually(() => objCount(B), (n) => n > before, 'spawn() on the authority creates an object that reaches B', 6000);
	await A.page.waitForTimeout(1000);
	await A.page.evaluate(() => window.__stores.nodesHandler.setNodeData('vg-go', { value: 0 }));
	await A.page.waitForTimeout(1500);
	await h.eventually(
		async () => [await objCount(A), await objCount(B)],
		([a, b]) => a === b,
		'both peers converge on the same objects — ONE peer spawned, the other received its creates',
		8000
	);
	const afterA = await objCount(A);
	const afterB = await objCount(B);
	// "spawn every frame" for >= 1 s: the 250 ms gap allows a handful, never ~60
	h.check(afterB - before >= 1 && afterB - before <= 12, `the per-node rate limit held while the script asked every frame (${afterB - before} spawned)`);
	const issued = async (peer) => (await peer.page.evaluate(() => window.__stores.flowRuntime.scriptSpawnStats()))['vg-spawn'] ?? 0;
	const [byA, byB] = [await issued(A), await issued(B)];
	h.check((byA > 0) !== (byB > 0) && byA + byB === afterB - before, `exactly ONE peer (the authority) issued the creates (A ${byA}, B ${byB})`);

	// --- 6: DEVX #22 — HUD Button drives a value input ---------------------------------
	await addGraph(
		A,
		[
			node('vg-hb', 'hudbutton', { label: 'HUD Button', element: 'vg-btn' }, 0, 1600),
			node('vg-hbm', 'math', { label: 'Math', op: 'add', a: 0, b: 0 }, 200, 1600)
		],
		[edge('vg-hb', 'vg-hbm', 'a')]
	);
	await A.page.waitForTimeout(800);
	const press = await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowRuntime.fireHudButton('vg-btn');
		const nodes = s.allNodes();
		let trig;
		s.flowTriggers.subscribe((v) => (trig = v))();
		const t = trig['vg-hb']?.lastT ?? 0;
		const m = nodes.find((n) => n.id === 'vg-hbm');
		return s.flowRuntime.evalNode(m, nodes, s.allEdges(), t + 0.05, new Set(), { triggers: trig, pos: () => null });
	});
	h.check(press === 1, `a HUD Button press reads as 1 on a Math input for its pulse window (${press}; undefined → 0 before)`);

	await h.finish(browser);
});
