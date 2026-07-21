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

	// --- a WIRED param renders the live incoming value, not its slider ---------
	await A.page.evaluate((id) => {
		window.__stores.flowGraphClose.set(false);
		window.__stores.objectActions.selectObject(id); // editor shows the object flow
	}, uuid);
	await A.page.waitForTimeout(700);
	h.check(
		(await A.page.locator('[data-id="spin-emb"] .wired-value').count()) === 1,
		'a wired param shows the live value readout'
	);
	h.check(
		(await A.page.locator('[data-id="spin-emb"] input[type="range"]').count()) === 0,
		'the wired param slider is replaced'
	);
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.waitForTimeout(400);

	// --- double-clicking the embed node opens the object's flow ----------------
	await A.page.evaluate(async (id) => {
		window.__stores.flowGraphClose.set(false);
		// park the embed node in an unobstructed spot for the real dblclick
		let graphs; window.__stores.flowGraphs.subscribe((g) => (graphs = g))();
		const embed = graphs.scene.nodes.find((n) => n.type === 'objectflow' && n.data.flowUuid === id);
		window.__stores.nodesHandler.moveFlowNode(embed.id, { x: 620, y: 260 }, 'scene');
	}, uuid);
	await A.page.waitForTimeout(600);
	await A.page.locator('.svelte-flow__node').filter({ hasText: 'double-click to open' }).first().dblclick();
	await A.page.waitForTimeout(500);
	const scopeAfterDbl = await A.page.evaluate(
		() => new Promise((r) => window.__stores.activeGraphId.subscribe((v) => r(v))())
	);
	h.check(scopeAfterDbl === uuid, 'double-clicking the embed node opens the object flow');
	// back to the scene graph for the remaining checks
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.waitForTimeout(400);

	// --- single-connection inputs: a new wire replaces the old -----------------
	const singleRules = await A.page.evaluate(() => {
		const fs = window.__stores.flowSockets;
		const nodes = [
			{ id: 'n1', type: 'number', data: {} },
			{ id: 'n2', type: 'number', data: {} },
			{ id: 'sp', type: 'spin', data: {} },
			{ id: 'sel', type: 'objectselector', data: {} },
			{ id: 'cnt', type: 'counter', data: {} },
			{ id: 'oc1', type: 'onclick', data: {} }
		];
		const edges = [
			{ id: 'e-old', source: 'n1', target: 'sp', targetHandle: 'speed' },
			{ id: 'e-fx', source: 'sp', target: 'sel' },
			{ id: 'e-ev', source: 'oc1', target: 'cnt', targetHandle: 'pulse' }
		];
		return {
			valueReplaces: fs.replaceableInputEdges({ source: 'n2', target: 'sp', targetHandle: 'speed' }, nodes, edges),
			effectKeepsMulti: fs.replaceableInputEdges({ source: 'sp', target: 'sel', targetHandle: null }, nodes, edges),
			eventKeepsMulti: fs.replaceableInputEdges({ source: 'oc1', target: 'cnt', targetHandle: 'pulse' }, nodes, edges)
		};
	});
	h.check(
		singleRules.valueReplaces.length === 1 && singleRules.valueReplaces[0] === 'e-old',
		'a value input is single-connection: the new wire replaces the old edge'
	);
	h.check(singleRules.effectKeepsMulti.length === 0, 'the effect channel keeps multi fan-in');
	h.check(singleRules.eventKeepsMulti.length === 0, 'event inputs keep multi fan-in');

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

	// --- self-embed is blocked in the picker -----------------------------------
	await A.page.evaluate(async (id) => {
		window.__stores.nodesHandler.createFlowNode(
			{ id: 'self-embed-probe', type: 'objectflow', position: { x: 500, y: 100 }, data: { type: 'objectflow', label: 'Object Flow', flowUuid: '' } },
			id
		);
		window.__stores.objectActions.selectObject(id); // view the object's own flow
	}, uuid);
	await A.page.waitForTimeout(600);
	const pickerValues = await A.page.evaluate(() =>
		[...document.querySelectorAll('[data-id="self-embed-probe"] select option')].map((o) => o.value)
	);
	h.check(!pickerValues.includes(uuid), 'the picker never offers the flow it lives in (no self-embed)');
	await A.page.evaluate((id) => {
		window.__stores.nodesHandler.deleteFlowNodes(['self-embed-probe'], id);
		window.__stores.objectActions.deselectObject();
	}, uuid);
	await A.page.waitForTimeout(400);

	// --- deleting the flow removes the embedded node ---------------------------
	await A.page.evaluate((id) => window.__stores.flowGraphsCtl.deleteObjectGraph(id), uuid);
	await A.page.waitForTimeout(400);
	const afterDelete = await sceneGraph(A);
	h.check(!afterDelete.nodes.some((n) => n.type === 'objectflow'), 'deleting the flow removes its embedded node');
	h.check(!afterDelete.edges.some((e) => e.id === 'e-embed-probe'), 'and its remaining edges');

	await h.finish(browser);
});
