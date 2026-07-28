// AI assistant v3: flow-node behaviors + physics tools. A scripted mock endpoint
// walks the full "create a moving spider" scenario — create_objects → group →
// create_flow_nodes (pathpatrol on the GROUP graph + bounce on a leg, with local
// refs) → set_physics (static ground) → create_joints (one hinge) →
// control_simulation start → text. Asserts the graph documents + nodes exist,
// the group is flow-animated, physics userData is set, the joint def landed,
// the sim runs, all mutations were broadcast, and ONE undo (after reset)
// reverts nodes+physics+joints+objects while redo restores them WITHOUT
// restarting the sim. Plus: the physics gate (provider checkbox off → disabled
// error, mass node rejected per-item) and repair (invented `add_behavior` name
// with nodes[] args still creates).
const h = require('./helpers.cjs');

// same-origin with the app under test (worktree lanes serve on their own port)
const BASE = h.URL.replace(/\/$/, '') + '/mock-flow-ai/v1';

const simulating = (peer) =>
	peer.page.evaluate(
		() => new Promise((r) => window.__stores.physics.simulating.subscribe((s) => r(s))())
	);
const count = (peer) =>
	peer.page.evaluate(
		() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g ? g.children.length : 0))())
	);
const msgs = (peer) =>
	peer.page.evaluate(
		() => new Promise((r) => window.__stores.aiAssistant.aiMessages.subscribe((m) => r(m))())
	);
const busy = (peer) =>
	peer.page.evaluate(
		() => new Promise((r) => window.__stores.aiAssistant.aiBusy.subscribe((b) => r(b))())
	);
/** {name -> uuid} for every object in the replicated group (recursive). */
const uuidsByName = (peer) =>
	peer.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const map = {};
					g?.traverse((o) => {
						if (o !== g && o.name) map[o.name] = o.uuid;
					});
					r(map);
				})()
			)
	);
const graphsSnapshot = (peer) =>
	peer.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.flowGraphs.subscribe((all) => {
					const out = {};
					for (const [id, g] of Object.entries(all))
						out[id] = { nodes: g.nodes.map((n) => ({ id: n.id, type: n.type, data: { ...n.data } })), edges: g.edges.length };
					r(out);
				})()
			)
	);

h.run(async () => {
	const browser = await h.launch();

	// throwaway page warms the vite dep-optimizer for the lazy rapier import
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}

	const A = await h.setupPage(browser, 'A');

	// ---- scripted endpoint: one scenario step per tool round-trip -------------------
	/** Track what the client executed so the mock can address real uuids. */
	const answer = (route, message) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }]
			})
		});
	const call = (name, args) => ({
		role: 'assistant',
		content: null,
		tool_calls: [{ id: 'c-' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
	});

	let scenario = 'spider';
	await A.page.route('**/mock-flow-ai/v1/chat/completions', (route) => {
		/** @type {any} */
		let body = {};
		try {
			body = JSON.parse(route.request().postData() || '{}');
		} catch {}
		const toolMsgs = (body.messages || []).filter((m) => m.role === 'tool');
		const results = toolMsgs.map((m) => {
			try {
				return JSON.parse(m.content);
			} catch {
				return {};
			}
		});

		if (scenario === 'gated') {
			// physics tools OFF: try set_physics (must come back disabled), then a mass
			// node (must be rejected per-item), then stop.
			if (toolMsgs.length === 0) return answer(route, call('set_physics', { updates: [{ uuid: 'whatever', mode: 'static' }] }));
			if (toolMsgs.length === 1)
				return answer(route, call('create_flow_nodes', { graph: 'scene', nodes: [{ type: 'mass' }, { type: 'spin' }] }));
			return answer(route, { role: 'assistant', content: 'Gating checked.' });
		}
		if (scenario === 'repair') {
			// invented tool name carrying nodes[] args — repair must route it
			if (toolMsgs.length === 0)
				return answer(route, call('add_behavior', { graph: 'scene', nodes: [{ type: 'rotate', data: { speed: 3 } }] }));
			return answer(route, { role: 'assistant', content: 'Behavior added.' });
		}

		// ---- spider scenario ----
		const step = toolMsgs.length;
		if (step === 0)
			return answer(
				route,
				call('create_objects', {
					objects: [
						{ kind: 'primitive', primitive: 'Box', params: [8, 0.2, 8], position: [0, -0.1, 0], name: 'Ground' },
						{ kind: 'primitive', primitive: 'Box', params: [1, 0.5, 1.4], position: [0, 0.6, 0], color: '#442200', name: 'Body' },
						{ kind: 'primitive', primitive: 'Box', params: [0.15, 0.5, 0.15], position: [0.7, 0.25, 0], name: 'LegL' },
						{ kind: 'primitive', primitive: 'Box', params: [0.15, 0.5, 0.15], position: [-0.7, 0.25, 0], name: 'LegR' },
						{ kind: 'primitive', primitive: 'Box', params: [0.4, 0.4, 0.4], position: [3, 2, 0], name: 'Pebble' }
					]
				})
			);
		if (step === 1) {
			const created = results[0]?.created ?? [];
			const uuidOf = (n) => created.find((c) => c.name === n)?.uuid;
			return answer(
				route,
				call('group_objects', { name: 'Spider', memberUuids: [uuidOf('Body'), uuidOf('LegL'), uuidOf('LegR')] })
			);
		}
		if (step === 2) {
			const groupUuid = results[1]?.groupUuid;
			return answer(
				route,
				call('create_flow_nodes', {
					graph: groupUuid,
					nodes: [
						{
							ref: 'walk',
							type: 'pathpatrol',
							data: { points: [[2, 0.6, 2], [-2, 0.6, 2], [-2, 0.6, -2], [2, 0.6, -2]], speed: 1.5 }
						}
					]
				})
			);
		}
		if (step === 3) {
			const legUuid = results[0]?.created?.find((c) => c.name === 'LegL')?.uuid;
			return answer(
				route,
				call('create_flow_nodes', { graph: legUuid, nodes: [{ ref: 'b', type: 'bounce', data: { amplitude: 0.3, speed: 4 } }] })
			);
		}
		if (step === 4)
			// wired pair on the scene graph — exercises refs → edge id + edgecreate
			return answer(
				route,
				call('create_flow_nodes', {
					graph: 'scene',
					nodes: [
						{ ref: 'n', type: 'number', data: { value: 2 } },
						{ ref: 'm', type: 'math', data: { op: 'add' } }
					],
					edges: [{ from: 'n', to: 'm', toHandle: 'a' }]
				})
			);
		if (step === 5) {
			// "make it faster" — tune the pathpatrol node by its id (nodedata path)
			const groupUuid = results[1]?.groupUuid;
			const walkId = results[2]?.created?.[0]?.id;
			return answer(route, call('update_flow_nodes', { graph: groupUuid, updates: [{ id: walkId, data: { speed: 2.5 } }] }));
		}
		if (step === 6) {
			const groundUuid = results[0]?.created?.find((c) => c.name === 'Ground')?.uuid;
			return answer(route, call('set_physics', { updates: [{ uuid: groundUuid, mode: 'static' }] }));
		}
		if (step === 7) {
			const created = results[0]?.created ?? [];
			const groundUuid = created.find((c) => c.name === 'Ground')?.uuid;
			const pebbleUuid = created.find((c) => c.name === 'Pebble')?.uuid;
			return answer(route, call('create_joints', { joints: [{ kind: 'revolute', a: groundUuid, b: pebbleUuid, axis: 'y' }] }));
		}
		if (step === 8) return answer(route, call('control_simulation', { action: 'start' }));
		return answer(route, { role: 'assistant', content: 'Spider built and walking.' });
	});

	// provider: unstreamed + physics tools ON
	await A.page.evaluate((base) => {
		window.__stores.aiProviders.addAiProvider({
			preset: 'custom',
			label: 'FlowMock',
			baseUrl: base,
			apiKey: 'k',
			model: 'mock',
			stream: false,
			physicsTools: true
		});
		window.__stores.aiProviders.setAiEnabled(true);
	}, BASE);

	// capture every peer broadcast type (no peers connected — wrap send)
	await A.page.evaluate(() => {
		window.__sent = [];
		let peerRef;
		window.__stores.peers.subscribe((p) => (peerRef = p))();
		const orig = peerRef.send.bind(peerRef);
		peerRef.send = (data) => {
			window.__sent.push(data?.type);
			return orig(data);
		};
	});

	// ---- the spider scenario ---------------------------------------------------------
	const base0 = await count(A);
	await A.page.evaluate(() => window.__stores.aiAssistant.runPrompt('create a moving spider'));
	await h.eventually(() => busy(A), (b) => b === false, 'spider prompt finished', 90000);

	await h.eventually(() => count(A), (n) => n === base0 + 3, 'scene has ground + pebble + spider group (3 top-level)');
	const names = await uuidsByName(A);
	const spiderUuid = names['Spider Group']; // createGroup suffixes the /group name
	h.check(!!(names.Ground && names.Body && names.LegL && spiderUuid), 'named objects + group exist');

	const graphs = await graphsSnapshot(A);
	const groupGraph = graphs[spiderUuid];
	const walkNode = groupGraph?.nodes.find((n) => n.type === 'pathpatrol');
	h.check(!!walkNode, 'group graph has the pathpatrol node');
	h.check(walkNode?.data.points?.length === 4, 'pathpatrol points survived validation');
	h.check(walkNode?.data.speed === 2.5, 'update_flow_nodes tuned the patrol speed');
	h.check(!!graphs[names.LegL]?.nodes.some((n) => n.type === 'bounce'), 'leg graph has the bounce node');
	h.check(
		graphs.scene?.nodes.some((n) => n.type === 'number') && graphs.scene?.edges === 1,
		'scene graph got the wired number→math pair (1 edge)'
	);

	await h.eventually(
		() => A.page.evaluate((u) => window.__stores.flowRuntime.isAnimatedTarget(u), spiderUuid),
		(v) => v === true,
		'group is a live animated target (implicit owner)'
	);

	const groundPhysics = await A.page.evaluate(
		(u) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => r(g.getObjectByProperty('uuid', u)?.userData?.physics ?? null))()
			),
		names.Ground
	);
	h.check(groundPhysics?.mode === 'static', 'ground userData.physics is static');

	const joints0 = await A.page.evaluate(
		() => new Promise((r) => window.__stores.joints.sceneJoints.subscribe((j) => r(j))())
	);
	h.check(joints0.length === 1 && joints0[0].kind === 'revolute', 'one revolute joint def in sceneJoints');

	await h.eventually(() => simulating(A), (s) => s === true, 'simulation is running', 30000);

	const sent = await A.page.evaluate(() => window.__sent);
	for (const type of ['create', 'group', 'graphcreate', 'nodecreate', 'edgecreate', 'nodedata', 'objectParameters', 'jointcreate', 'simulate']) {
		h.check(sent.includes(type), 'broadcast captured: ' + type);
	}

	let list = await msgs(A);
	h.check(!list.some((m) => m.role === 'error'), 'no tool errors in the spider run');
	h.check(
		list.some((m) => m.role === 'tool-status' && /behavior node/.test(m.content)),
		'transcript labels the flow-node calls'
	);

	// ---- one undo reverts everything (after reset), redo restores without sim -------
	await A.page.evaluate(() => window.__stores.physics.resetSimulation());
	await h.eventually(() => simulating(A), (s) => s === false, 'simulation reset/stopped');
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => count(A), (n) => n === base0, 'one undo removed all spider objects');
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.joints.sceneJoints.subscribe((j) => r(j.length))())),
		(n) => n === 0,
		'undo removed the joint def'
	);
	const graphsAfterUndo = await graphsSnapshot(A);
	h.check(!graphsAfterUndo[spiderUuid], 'undo removed the group graph document');

	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => count(A), (n) => n === base0 + 3, 'redo restored the spider');
	const graphsAfterRedo = await graphsSnapshot(A);
	h.check(
		!!graphsAfterRedo[spiderUuid]?.nodes.some((n) => n.type === 'pathpatrol'),
		'redo restored the pathpatrol node'
	);
	h.check((await simulating(A)) === false, 'redo did NOT restart the simulation');

	// ---- gating: physics tools OFF ---------------------------------------------------
	await A.page.evaluate(() => window.__stores.aiAssistant.resetAiConversation());
	await A.page.evaluate(() => {
		let providers;
		window.__stores.aiProviders.aiProviders.subscribe((p) => (providers = p))();
		window.__stores.aiProviders.updateAiProvider(providers[0].id, { physicsTools: false });
		window.__sent.length = 0;
	});
	scenario = 'gated';
	await A.page.evaluate(() => window.__stores.aiAssistant.runPrompt('make the ground static'));
	await h.eventually(() => busy(A), (b) => b === false, 'gated prompt finished', 60000);
	list = await msgs(A);
	h.check(
		list.some((m) => m.role === 'error' && /physics tools are disabled/i.test(m.content)),
		'set_physics returned the disabled error'
	);
	const sentGated = await A.page.evaluate(() => window.__sent);
	h.check(!sentGated.includes('objectParameters'), 'no physics broadcast while gated');
	const sceneGraph = (await graphsSnapshot(A)).scene;
	h.check(!(sceneGraph?.nodes ?? []).some((n) => n.type === 'mass'), 'mass node rejected while gated');
	h.check((sceneGraph?.nodes ?? []).some((n) => n.type === 'spin'), 'non-physics node in the same call still created');

	// ---- repair: invented add_behavior name with nodes[] args -------------------------
	await A.page.evaluate(() => window.__stores.aiAssistant.resetAiConversation());
	scenario = 'repair';
	await A.page.evaluate(() => window.__stores.aiAssistant.runPrompt('spin something'));
	await h.eventually(() => busy(A), (b) => b === false, 'repair prompt finished', 60000);
	const sceneAfter = (await graphsSnapshot(A)).scene;
	h.check(
		(sceneAfter?.nodes ?? []).some((n) => n.type === 'spin' && n.data.speed === 3),
		'invented add_behavior (alias) with rotate→spin node created'
	);
	list = await msgs(A);
	h.check(!list.some((m) => m.role === 'error' && /unknown tool/.test(m.content)), 'no unknown-tool error for the repaired call');

	await h.finish(browser);
});
