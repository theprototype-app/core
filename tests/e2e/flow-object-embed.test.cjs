// Roadmap #13 H5 — object flows embedded in the scene graph.
//   - Flow Input/Output nodes inside an object flow DECLARE its sockets
//   - an Object Flow node in the SCENE graph carries those sockets: scene values
//     inject into the flow's Flow Inputs; Flow Output values surface back
//     (round-trip probed through a scene-side Math node reading the embed output)
//   - the implicit-owner rule composes: a spin inside the flow reads the
//     injected input as its speed
//   - context-menu style embed (addObjectFlowToScene) + embed-once rule
//   - deleting the flow removes its embedded node + edges
//   - interface rename prunes stale embed edges (deterministic invariant)
const h = require('./helpers.cjs');

const sceneGraph = (peer) =>
	peer.page.evaluate(() => new Promise((r) => window.__stores.flowGraphs.subscribe((g) => r({
		nodes: g.scene.nodes.map((n) => ({ id: n.id, type: n.type })),
		edges: g.scene.edges.map((e) => ({ id: e.id, source: e.source, target: e.target }))
	}))()));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- scaffold: box + object flow with a declared interface ----------------
	const uuid = await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		window.__stores.flowGraphsCtl.createObjectGraph(box.uuid);
		const nh = window.__stores.nodesHandler;
		// interface: input 'speed' -> spin.speed AND -> output 'echo'
		nh.createFlowNode({ id: 'fi-speed', type: 'flowinput', position: { x: 0, y: 0 }, data: { type: 'flowinput', name: 'speed', vtype: 'number', fallback: 1 } }, box.uuid);
		nh.createFlowNode({ id: 'spin-emb', type: 'spin', position: { x: 200, y: 0 }, data: { type: 'spin', axis: 'y', speed: 1 } }, box.uuid);
		nh.createFlowNode({ id: 'fo-echo', type: 'flowoutput', position: { x: 200, y: 120 }, data: { type: 'flowoutput', name: 'echo' } }, box.uuid);
		nh.createFlowEdge({ id: 'e-fi-spin', source: 'fi-speed', target: 'spin-emb', targetHandle: 'speed' }, box.uuid);
		nh.createFlowEdge({ id: 'e-fi-echo', source: 'fi-speed', target: 'fo-echo', targetHandle: 'value' }, box.uuid);
		return box.uuid;
	});
	await A.page.waitForTimeout(400);

	// --- embed via the context-menu helper ------------------------------------
	const added = await A.page.evaluate((id) => window.__stores.objectFlow.addObjectFlowToScene(id, 'Box'), uuid);
	h.check(added === true, 'addObjectFlowToScene embeds the flow into the scene graph');
	const addedTwice = await A.page.evaluate((id) => window.__stores.objectFlow.addObjectFlowToScene(id, 'Box'), uuid);
	h.check(addedTwice === false, 'a flow embeds only once per graph (v1)');

	// --- wire scene values through the embed -----------------------------------
	await A.page.evaluate(async (id) => {
		const nh = window.__stores.nodesHandler;
		let graphs; window.__stores.flowGraphs.subscribe((g) => (graphs = g))();
		const embed = graphs.scene.nodes.find((n) => n.type === 'objectflow' && n.data.flowUuid === id);
		// scene: number 7 -> embed.speed ; embed.echo -> math(+0) probe
		nh.createFlowNode({ id: 'num-7', type: 'number', position: { x: 0, y: 0 }, data: { type: 'number', value: 7 } }, 'scene');
		nh.createFlowNode({ id: 'probe', type: 'math', position: { x: 400, y: 0 }, data: { type: 'math', op: 'add', a: 0, b: 0 } }, 'scene');
		nh.createFlowEdge({ id: 'e-num-embed', source: 'num-7', target: embed.id, targetHandle: 'speed' }, 'scene');
		nh.createFlowEdge({ id: 'e-embed-probe', source: embed.id, sourceHandle: 'echo', target: 'probe', targetHandle: 'a' }, 'scene');
	}, uuid);

	// the probe math node should read 7 (scene -> flow input -> flow output -> scene)
	await h.eventually(
		() =>
			A.page.evaluate(
				() => new Promise((r) => window.__stores.flowValues.subscribe((v) => r(v['probe']))())
			),
		(v) => v === 7,
		'scene value round-trips: injected input surfaces on the embed output (7)'
	);
	// and the spin inside the flow drives the OWNER object (implicit rule intact)
	await h.eventually(
		() => A.page.evaluate((id) => window.__stores.flowRuntime.isAnimatedTarget(id), uuid),
		(v) => v === true,
		'the flow’s spin animates the owner with the injected speed'
	);

	// --- interface change prunes stale embed edges ----------------------------
	await A.page.evaluate((id) => {
		window.__stores.nodesHandler.updateFlowNodeData('fi-speed', { name: 'velocity' }, id);
	}, uuid);
	await A.page.waitForTimeout(500);
	const afterRename = await sceneGraph(A);
	h.check(
		!afterRename.edges.some((e) => e.id === 'e-num-embed'),
		'renaming the Flow Input prunes the scene edge into the old socket'
	);

	// --- deleting the flow removes the embedded node ---------------------------
	await A.page.evaluate((id) => window.__stores.flowGraphsCtl.deleteObjectGraph(id), uuid);
	await A.page.waitForTimeout(400);
	const afterDelete = await sceneGraph(A);
	h.check(!afterDelete.nodes.some((n) => n.type === 'objectflow'), 'deleting the flow removes its embedded node');
	h.check(!afterDelete.edges.some((e) => e.id === 'e-embed-probe'), 'and its remaining edges');

	await h.finish(browser);
});
