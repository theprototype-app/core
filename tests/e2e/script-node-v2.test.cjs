// 34 D3 — SCRIPT NODE v2: typed `inputs.*` in, `return {out}` out, linted.
//
// What it pins, on two real peers:
//   1. a v2 VALUE script computes its declared output from a wired input, and a consumer
//      reading that output through the ordinary named-input path (resolveInputs) acts on it:
//      script.show -> Visibility.on -> the box hides/shows as the wired Number crosses 5
//   2. the declaration replicates as node data and the OTHER peer derives the same value
//      itself (nothing about the value is sent)
//   3. an OBJECT input arrives as a read-only view {uuid, name, position} — dist() reads it
//   4. a v2 EFFECT (inputs, no outputs) still drives its object, with `inputs` in scope
//   5. THE LINT: a v2 script using Math.random is refused with a lint badge and never runs,
//      while the SAME code in a v1 node still runs (the compatibility line — counterfactual)
//   6. editing the sockets prunes the wires a removed socket stranded, on both peers
//
// Run: APP_URL=https://theprototype.app:5298/ npm run e2e -- script-node-v2
const h = require('./helpers.cjs');

const makeBox = (peer, at) =>
	peer.page.evaluate((pos) => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		return new Promise((resolve) =>
			window.__stores.objectsGroup.subscribe((g) => {
				const o = g.children[g.children.length - 1];
				resolve(o.uuid);
			})()
		);
	}, at);

/** add nodes + edges to the scene graph on `peer` and broadcast them (the script-nodes idiom) */
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

const node = (id, type, data, x = 0, y = 0) => ({ id, type, position: { x, y }, data: { type, ...data }, class: 'w-[150px]' });

const readValue = (peer, id) =>
	peer.page.evaluate((id) => new Promise((r) => window.__stores.flowValues.subscribe((v) => r(v[id] ?? null))()), id);
const readError = (peer, id) =>
	peer.page.evaluate((id) => new Promise((r) => window.__stores.scriptErrors.subscribe((m) => r(m[id] ?? null))()), id);
const objVisible = (peer, uuid) =>
	peer.page.evaluate(
		(uuid) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					r(o ? o.visible : null);
				})()
			),
		uuid
	);
const objPos = (peer, uuid) =>
	peer.page.evaluate(
		(uuid) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					r(o ? [o.position.x, o.position.y, o.position.z] : null);
				})()
			),
		uuid
	);
const setData = (peer, id, patch) =>
	peer.page.evaluate(([id, patch]) => window.__stores.nodesHandler.setNodeData(id, patch), [id, patch]);
const edgeIds = (peer) =>
	peer.page.evaluate(() => new Promise((r) => window.__stores.flowEdges.subscribe((e) => r(e.map((x) => x.id)))()));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const box = await makeBox(A);
	await A.page.waitForTimeout(1500);

	// --- 1 + 2: a value script feeding a consumer's named input -------------------------
	await addGraph(
		A,
		[
			node('n1', 'number', { value: 3 }),
			node('s1', 'script', {
				code: 'return { show: inputs.a > 5, twice: inputs.a * 2 };',
				inputs: [{ name: 'a', type: 'number' }],
				outputs: [
					{ name: 'show', type: 'boolean' },
					{ name: 'twice', type: 'number' }
				]
			}, 200),
			node('vis', 'visibility', { on: true }, 400),
			node('sel', 'objectselector', { selected: box }, 600)
		],
		[
			{ id: 'e-n1-s1.a', source: 'n1', target: 's1', targetHandle: 'a' },
			{ id: 'e-s1.show-vis.on', source: 's1', sourceHandle: 'show', target: 'vis', targetHandle: 'on' },
			{ id: 'e-vis-sel', source: 'vis', target: 'sel' }
		]
	);
	await h.eventually(() => readValue(A, 's1'), (v) => v?.__handles?.twice === 6 && v.__handles.show === false, 'A: the value script computes its outputs (twice = 6, show = false)');
	await h.eventually(() => objVisible(A, box), (v) => v === false, 'A: the consumer reads the script output through its named input (box hidden)');
	await h.eventually(() => readValue(B, 's1'), (v) => v?.__handles?.twice === 6, 'B: the declaration replicated and B derives the same value itself');
	await h.eventually(() => objVisible(B, box), (v) => v === false, 'B: the box is hidden on B too');
	await setData(A, 'n1', { value: 9 });
	await h.eventually(() => objVisible(A, box), (v) => v === true, 'A: the wired number crosses 5 and the box shows');
	await h.eventually(() => objVisible(B, box), (v) => v === true, 'B: same, derived on B');
	h.check(!(await readError(A, 's1')), 'no badge on a clean v2 script');

	// a value script is not an effect: it must not take over the object it never targeted
	// (with outputs it is pulled, not run per frame against an owner)
	const p0 = await objPos(A, box);
	await A.page.waitForTimeout(400);
	const p1 = await objPos(A, box);
	h.check(JSON.stringify(p0) === JSON.stringify(p1), 'a value script does not move anything');

	// --- 3: an object input arrives as a view ------------------------------------------
	await addGraph(
		A,
		[
			node('sel2', 'objectselector', { selected: box }, 0, 200),
			node('s2', 'script', {
				code: 'return { d: dist(inputs.piece, [0, 0, 0]), named: inputs.piece ? inputs.piece.uuid.length : -1 };',
				inputs: [{ name: 'piece', type: 'object' }],
				outputs: [
					{ name: 'd', type: 'number' },
					{ name: 'named', type: 'number' }
				]
			}, 200, 200)
		],
		[{ id: 'e-sel2-s2.piece', source: 'sel2', target: 's2', targetHandle: 'piece' }]
	);
	const pos = await objPos(A, box);
	const want = Math.hypot(...pos);
	await h.eventually(() => readValue(A, 's2'), (v) => v && Math.abs(v.__handles.d - want) < 1e-3 && v.__handles.named === 36, 'an object input is a view: dist(inputs.piece, origin) = the box distance, uuid readable');

	// --- 4: a v2 effect -----------------------------------------------------------------
	const box2 = await makeBox(A);
	await A.page.waitForTimeout(1200);
	await addGraph(
		A,
		[
			node('h1', 'number', { value: 2.5 }, 0, 400),
			node('s3', 'script', { code: 'object.position.y = inputs.h;', inputs: [{ name: 'h', type: 'number' }] }, 200, 400),
			node('sel3', 'objectselector', { selected: box2 }, 400, 400)
		],
		[
			{ id: 'e-h1-s3.h', source: 'h1', target: 's3', targetHandle: 'h' },
			{ id: 'e-s3-sel3', source: 's3', target: 'sel3' }
		]
	);
	await h.eventually(() => objPos(A, box2), (p) => p && Math.abs(p[1] - 2.5) < 1e-3, 'a v2 effect drives its object with inputs.h');
	await h.eventually(() => objPos(B, box2), (p) => p && Math.abs(p[1] - 2.5) < 1e-3, 'and B runs it too');

	// --- 5: the lint, with its counterfactual ------------------------------------------
	await setData(A, 's3', { code: 'object.position.y = inputs.h + Math.random();' });
	await h.eventually(() => readError(A, 's3'), (e) => typeof e === 'string' && e.startsWith('lint') && /Math\.random/.test(e), 'a v2 script using Math.random is refused with a lint badge');
	const held = await objPos(A, box2);
	await A.page.waitForTimeout(500);
	const held2 = await objPos(A, box2);
	h.check(held && held2 && held[1] === held2[1], 'the refused script does not run (the object holds still)');
	// the counterfactual: the very same code in a v1 node (no declarations) still runs
	await setData(A, 's3', { inputs: undefined, code: 'object.position.y = 1 + Math.random() * 0.001;' });
	await h.eventually(() => readError(A, 's3'), (e) => !e, 'v1: the same randomness is NOT refused (scenes that ran yesterday keep running)');
	await h.eventually(() => objPos(A, box2), (p) => p && p[1] >= 1 && p[1] < 1.01, 'v1 still drives its object');

	// --- 6: removing a socket prunes the wire it stranded, on both peers ---------------
	h.check((await edgeIds(B)).includes('e-n1-s1.a'), 'premise: B holds the wire into s1.a');
	const dropped = await A.page.evaluate(() =>
		window.__stores.scriptSockets.setScriptSockets('s1', { inputs: [{ name: 'other', type: 'number' }] })
	);
	h.check(JSON.stringify(dropped) === JSON.stringify(['e-n1-s1.a']), 'removing input `a` drops exactly its wire (' + JSON.stringify(dropped) + ')');
	await h.eventually(() => edgeIds(B), (ids) => !ids.includes('e-n1-s1.a') && ids.includes('e-s1.show-vis.on'), 'B dropped the stranded wire and kept the output wire');

	h.check(h.pageErrors(A).length === 0, 'no page errors on A');
	await h.finish(browser);
});
