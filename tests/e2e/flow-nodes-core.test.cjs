// Phase 133: flow value + logic nodes. The evaluation math is pure + tested
// directly; input-socket resolution drives a Spin speed from a Number->Math
// chain (with fallback to the node's own param when unconnected); a two-peer
// pass proves the replicated graph computes the SAME value on both peers at the
// same synced time (determinism = the netcode).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- pure evaluation of each node type ---
	const pure = await A.page.evaluate(() => {
		const R = window.__stores.flowRuntime;
		const ev = (node, nodes, edges, time) => R.evalNode(node, nodes || [], edges || [], time || 0);
		return {
			number: ev({ id: 'n', type: 'number', data: { value: 5 } }),
			toggle: ev({ id: 't', type: 'toggle', data: { on: true } }),
			vector3: ev({ id: 'v', type: 'vector3', data: { x: 1, y: 2, z: 3 } }),
			timeSin: ev({ id: 'ts', type: 'time', data: { mode: 'sin', rate: 1 } }, [], [], Math.PI / 2),
			timeRaw: ev({ id: 'tr', type: 'time', data: { mode: 't' } }, [], [], 42),
			timeSaw: ev({ id: 'tw', type: 'time', data: { mode: 'saw', rate: 1 } }, [], [], 2.5),
			mathMul: ev({ id: 'm', type: 'math', data: { op: 'mul', a: 3, b: 4 } }),
			mathMod: ev({ id: 'm2', type: 'math', data: { op: 'mod', a: 7, b: 3 } }),
			cmpGt: ev({ id: 'c', type: 'compare', data: { op: 'gt', a: 5, b: 3 } }),
			cmpEq: ev({ id: 'c2', type: 'compare', data: { op: 'eq', a: 2, b: 2 } }),
			gateXor: ev({ id: 'g', type: 'gate', data: { op: 'xor', a: true, b: false } }),
			gateNot: ev({ id: 'g2', type: 'gate', data: { op: 'not', a: true } }),
			// Random is seeded by node id -> stable across calls, differs by id
			rand1: ev({ id: 'seedX', type: 'random', data: { min: 0, max: 10 } }, [], [], 3),
			rand1b: ev({ id: 'seedX', type: 'random', data: { min: 0, max: 10 } }, [], [], 3),
			rand2: ev({ id: 'seedY', type: 'random', data: { min: 0, max: 10 } }, [], [], 3)
		};
	});
	h.check(pure.number === 5, 'Number outputs its value');
	h.check(pure.toggle === true, 'Toggle outputs a boolean');
	h.check(JSON.stringify(pure.vector3) === '[1,2,3]', 'Vector3 outputs [x,y,z]');
	h.check(Math.abs(pure.timeSin - 1) < 1e-6, 'Time sin(t) at pi/2 = 1');
	h.check(pure.timeRaw === 42, 'Time t-mode returns the raw clock');
	h.check(Math.abs(pure.timeSaw - 0.5) < 1e-6, 'Time saw wraps to 0..1');
	h.check(pure.mathMul === 12 && pure.mathMod === 1, 'Math mul/mod compute');
	h.check(pure.cmpGt === true && pure.cmpEq === true, 'Compare returns booleans');
	h.check(pure.gateXor === true && pure.gateNot === false, 'Gate xor/not compute');
	h.check(
		pure.rand1 === pure.rand1b && pure.rand1 >= 0 && pure.rand1 <= 10 && pure.rand1 !== pure.rand2,
		'Random is seeded (stable per id, differs by id)'
	);

	// --- input-socket resolution: Number x Number -> Math -> Spin.speed ---
	const chain = await A.page.evaluate(() => {
		const R = window.__stores.flowRuntime;
		const nodes = [
			{ id: 'num', type: 'number', data: { value: 10 } },
			{ id: 'num2', type: 'number', data: { value: 3 } },
			{ id: 'mth', type: 'math', data: { op: 'mul' } },
			{ id: 'spn', type: 'spin', data: { axis: 'y', speed: 1 } }
		];
		const edges = [
			{ id: 'e1', source: 'num', target: 'mth', targetHandle: 'a' },
			{ id: 'e2', source: 'num2', target: 'mth', targetHandle: 'b' },
			{ id: 'e3', source: 'mth', target: 'spn', targetHandle: 'speed' }
		];
		const mathOut = R.evalNode(nodes[2], nodes, edges, 0);
		const wired = R.resolveInputs(nodes[3], nodes, edges, 0).speed;
		// fallback: drop the Math->Spin edge, Spin keeps its own param
		const unwired = R.resolveInputs(nodes[3], nodes, edges.slice(0, 2), 0).speed;
		return { mathOut, wired, unwired };
	});
	h.check(chain.mathOut === 30, 'Math resolves its wired inputs (10 x 3 = 30)');
	h.check(chain.wired === 30, 'the Spin speed handle reads the Math output (30)');
	h.check(chain.unwired === 1, 'an unconnected handle falls back to the node param (1)');

	// --- two-peer: the replicated graph computes the SAME value on both ---
	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);

	await A.page.evaluate(() => {
		const nodes = [
			{ id: 'p-num', type: 'number', position: { x: 0, y: 0 }, data: { type: 'number', value: 6 } },
			{ id: 'p-num2', type: 'number', position: { x: 0, y: 80 }, data: { type: 'number', value: 7 } },
			{ id: 'p-mth', type: 'math', position: { x: 200, y: 40 }, data: { type: 'math', op: 'mul' } }
		];
		const edges = [
			{ id: 'pe1', source: 'p-num', target: 'p-mth', targetHandle: 'a' },
			{ id: 'pe2', source: 'p-num2', target: 'p-mth', targetHandle: 'b' }
		];
		window.__stores.flowNodes.set(nodes);
		window.__stores.flowEdges.set(edges);
		let peer;
		window.__stores.peers.subscribe((p) => (peer = p))();
		// replicate through the normal node/edge create broadcasts
		nodes.forEach((node) => peer.send({ type: 'nodecreate', node }));
		edges.forEach((edge) => peer.send({ type: 'edgecreate', edge }));
	});

	await B.page.waitForTimeout(2500);

	const parity = await B.page.evaluate(() => {
		const R = window.__stores.flowRuntime;
		let nodes, edges;
		window.__stores.flowNodes.subscribe((v) => (nodes = v))();
		window.__stores.flowEdges.subscribe((v) => (edges = v))();
		const math = nodes.find((n) => n.id === 'p-mth');
		return {
			gotGraph: nodes.length,
			value: math ? R.evalNode(math, nodes, edges, 100) : null
		};
	});
	const aValue = await A.page.evaluate(() => {
		const R = window.__stores.flowRuntime;
		let nodes, edges;
		window.__stores.flowNodes.subscribe((v) => (nodes = v))();
		window.__stores.flowEdges.subscribe((v) => (edges = v))();
		return R.evalNode(nodes.find((n) => n.id === 'p-mth'), nodes, edges, 100);
	});
	h.check(parity.gotGraph >= 3, `peer B received the replicated graph (${parity.gotGraph} nodes)`);
	h.check(aValue === 42 && parity.value === 42, `both peers compute the same value at t=100 (A ${aValue} / B ${parity.value})`);

	await h.finish(browser);
});
