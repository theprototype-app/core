// A1 (roadmap #21) — module node I/O: DEVX #9 (a module node that OUTPUTS a value and
// FIRES a trigger) + DEVX #12 (a module node learns its own id) + the 'text' param kind.
//
// Everything goes through `moduleSDK.initModules` with an inline module, which is the
// REAL api path (makeApi runs, the teardown journal records) rather than poking the
// registry — so the thing under test is the seam a community module would actually use.
//
// Run: $env:APP_URL='https://localhost:5200/'; npm run e2e -- module-node-io
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.moduleNodeIO, { timeout: 30000 });

	// ---- the test module: a value node, an event node, and two effect nodes ----
	// `score` is deliberately kept in the node's own DATA (data.base), not in a module
	// variable, because a value node must be a pure function of (data, time) — the
	// contract the api documents. A module-local counter would desync silently.
	const installModule = async (page) =>
		page.evaluate(async () => {
			window.__io = { effect4: 0, effect5: null, valueCalls: 0 };
			const s = window.__stores;
			await s.moduleSDK.initModules([
				{
					id: 'testio',
					name: 'Test module I/O',
					version: '1.0.0',
					description: 'proves the A1 seams',
					register(api) {
						// DEVX #9a — a VALUE node. Pure of (data, time); `mult` is a declared
						// input so a core Number can drive it.
						api.registerValueNode(
							'testscore',
							(data, time, ctx) => {
								window.__io.valueCalls++;
								window.__io.lastCtx = { id: ctx?.id, graphId: ctx?.graphId };
								return (Number(data.base) || 0) * (Number(data.mult) || 1);
							},
							{ vtype: 'number', inputs: { mult: 'number' } }
						);
						// DEVX #9b — an EVENT node, so a module can pulse a core Counter
						api.registerValueNode('testevent', () => 0, { vtype: 'event' });
						// a value node that declares an OBJECT input — undeclared, an object
						// output cannot reach it at all (object -> number is not a coercion)
						api.registerValueNode('testpicked', (data) => (data.who ? 1 : 0), {
							vtype: 'number',
							inputs: { who: 'object' }
						});
						// the OLD four-parameter effect shape: must stay byte-unchanged
						api.registerEffect('testold', (object, base, data, time) => {
							window.__io.effect4++;
						});
						// DEVX #12 — the additive 5th arg
						api.registerEffect(
							'testnew',
							(object, base, data, time, ctx) => {
								window.__io.effect5 = { id: ctx?.id, graphId: ctx?.graphId, arity: 5 };
							},
							{ inputs: { who: 'object' } }
						);
						api.registerNodeGroup({
							group: 'Test IO',
							items: [
								{
									type: 'testscore',
									label: 'Test Score',
									defaults: { base: 5, mult: 1, note: '' },
									params: [
										{ key: 'base', kind: 'range', min: 0, max: 100, step: 1 },
										{ key: 'note', kind: 'text', placeholder: 'a note', maxLength: 40 }
									]
								},
								{ type: 'testevent', label: 'Test Event', defaults: {} },
								{ type: 'testpicked', label: 'Test Picked', defaults: {} },
								{ type: 'testold', label: 'Test Old Effect', defaults: {} },
								{ type: 'testnew', label: 'Test New Effect', defaults: {} }
							]
						});
					}
				}
			]);
			return true;
		});
	await installModule(A.page);

	// ---- 1. the registry took the declarations -------------------------------
	const reg = await A.page.evaluate(() => {
		const io = window.__stores.moduleNodeIO;
		return {
			isValue: io.isModuleValueNode('testscore'),
			vtype: io.moduleValueTypes.testscore,
			eventType: io.moduleValueTypes.testevent,
			handles: io.moduleInputHandles('testscore'),
			effectHandles: io.moduleInputHandles('testnew'),
			// an effect node is NOT a value node, even though it declared inputs
			effectIsValue: io.isModuleValueNode('testnew')
		};
	});
	h.check(reg.isValue, 'api.registerValueNode lands in the shared registry');
	h.check(reg.vtype === 'number', `its declared output type is kept (${reg.vtype})`);
	h.check(reg.eventType === 'event', `an event node declares vtype 'event' (${reg.eventType})`);
	h.check(
		JSON.stringify(reg.handles) === '["mult"]',
		`declared inputs are kept in order (${JSON.stringify(reg.handles)})`
	);
	h.check(
		JSON.stringify(reg.effectHandles) === '["who"]',
		`registerEffect can declare inputs too (${JSON.stringify(reg.effectHandles)})`
	);
	h.check(!reg.effectIsValue, 'declaring inputs does not make an effect node a value node');

	// ---- 2. THE COUNTERFACTUAL: outputType used to answer 'effect' -----------
	// An 'effect' output may only reach an 'effect' input, so before the registry read
	// a module value could not be wired to ANYTHING. Measured both ways here.
	const sockets = await A.page.evaluate(() => {
		const s = window.__stores;
		const fs = s.flowSockets;
		const io = s.moduleNodeIO;
		const nodes = [
			{ id: 'mv', type: 'testscore', data: { type: 'testscore' } },
			{ id: 'mev', type: 'testevent', data: { type: 'testevent' } },
			{ id: 'mp', type: 'testpicked', data: { type: 'testpicked' } },
			{ id: 'mnew', type: 'testnew', data: { type: 'testnew' } },
			{ id: 'mm', type: 'math', data: { type: 'math' } },
			{ id: 'cnt', type: 'counter', data: { type: 'counter' } },
			{ id: 'os', type: 'objectselector', data: { type: 'objectselector', selected: 'x' } }
		];
		const valid = (source, target, targetHandle) =>
			fs.isValidFlowConnection({ source, target, targetHandle }, nodes);
		const before = {
			out: fs.outputType('testscore'),
			toMath: valid('mv', 'mm', 'a'),
			eventToCounter: valid('mev', 'cnt', 'pulse'),
			objectToDeclared: valid('os', 'mp', 'who'),
			objectToEffectDeclared: valid('os', 'mnew', 'who'),
			// an effect node with NO declared input still answers 'number' for a stray
			// handle, exactly as before
			inputTypeUndeclared: fs.inputType('testold', 'zzz')
		};
		// now rip the registry read's premise away: drop the declarations and re-ask
		const savedType = io.moduleValueTypes.testscore;
		const savedIn = { ...io.moduleNodeInputs.testpicked };
		delete io.moduleValueTypes.testscore;
		delete io.moduleNodeInputs.testpicked;
		const after = {
			out: fs.outputType('testscore'),
			toMath: valid('mv', 'mm', 'a'),
			objectToDeclared: valid('os', 'mp', 'who')
		};
		io.moduleValueTypes.testscore = savedType;
		io.moduleNodeInputs.testpicked = savedIn;
		return { before, after };
	});
	h.check(sockets.before.out === 'number', `a declared module output types as itself (${sockets.before.out})`);
	h.check(sockets.before.toMath, 'a module value node may be wired into Math');
	h.check(sockets.before.eventToCounter, 'a module EVENT node may be wired into a Counter');
	h.check(sockets.before.objectToDeclared, 'an Object Selector reaches a DECLARED object input');
	h.check(
		sockets.before.objectToEffectDeclared,
		'an Object Selector reaches an effect node`s declared object input'
	);
	h.check(
		sockets.before.inputTypeUndeclared === 'number',
		`an undeclared handle still answers 'number' (${sockets.before.inputTypeUndeclared})`
	);
	// the counterfactual half — without the registry read every one of the above fails
	h.check(
		sockets.after.out === 'effect',
		`COUNTERFACTUAL: with no declaration the output falls back to 'effect' (${sockets.after.out})`
	);
	h.check(!sockets.after.toMath, 'COUNTERFACTUAL: an effect output is REFUSED by Math');
	h.check(
		!sockets.after.objectToDeclared,
		'COUNTERFACTUAL: with no declared input an object wire is REFUSED (object -> number)'
	);

	// ---- 3. the value reaches a core consumer through resolveInputs ----------
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowNodes.set([
			{ id: 'ms', type: 'testscore', position: { x: 0, y: 0 }, data: { type: 'testscore', base: 7, mult: 1, note: '' } },
			{ id: 'num', type: 'number', position: { x: 0, y: 160 }, data: { type: 'number', value: 3 } },
			{ id: 'mth', type: 'math', position: { x: 260, y: 0 }, data: { type: 'math', op: 'add', a: 0, b: 100 } },
			{ id: 'ev', type: 'testevent', position: { x: 0, y: 320 }, data: { type: 'testevent' } },
			{ id: 'cn', type: 'counter', position: { x: 260, y: 320 }, data: { type: 'counter', step: 1, op: 'up' } }
		]);
		s.flowEdges.set([
			{ id: 'e-ms-mth.a', source: 'ms', target: 'mth', targetHandle: 'a' },
			{ id: 'e-num-ms.mult', source: 'num', target: 'ms', targetHandle: 'mult' },
			{ id: 'e-ev-cn.pulse', source: 'ev', target: 'cn', targetHandle: 'pulse' }
		]);
	});
	await A.page.waitForTimeout(900);

	const consumed = await A.page.evaluate(() => {
		const s = window.__stores;
		let nodes, edges;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowEdges.subscribe((v) => (edges = v))();
		const mth = nodes.find((n) => n.id === 'mth');
		const ms = nodes.find((n) => n.id === 'ms');
		return {
			// 7 * 3 (the wired mult) = 21
			value: s.flowRuntime.evalNode(ms, nodes, edges, 1, new Set(), null),
			// resolveInputs must accept the module source, or `a` keeps its own 0
			resolvedA: s.flowRuntime.resolveInputs(mth, nodes, edges, 1, null).a,
			calls: window.__io.valueCalls,
			ctx: window.__io.lastCtx
		};
	});
	h.check(consumed.value === 21, `the value node evaluates with its wired input resolved (${consumed.value})`);
	h.check(
		consumed.resolvedA === 21,
		`resolveInputs carries a module value into a core node's named input (${consumed.resolvedA})`
	);
	h.check(consumed.calls > 0, `the evaluator really ran (${consumed.calls} calls)`);
	h.check(
		consumed.ctx?.id === 'ms' && consumed.ctx?.graphId === 'scene',
		`DEVX #12: the node learns its own id and graph (${JSON.stringify(consumed.ctx)})`
	);

	// the on-card live readout comes free from the flowValues loop
	// the flowValues loop publishes ~6/s, so wait for the value rather than a fixed sleep
	let readout;
	for (let i = 0; i < 20 && readout !== 21; i++) {
		readout = await A.page.evaluate(() => {
			let v;
			window.__stores.flowValues.subscribe((x) => (v = x))();
			return v?.ms;
		});
		if (readout !== 21) await A.page.waitForTimeout(300);
	}
	h.check(readout === 21, `a module value node gets the on-card live readout for free (${readout})`);

	// ---- 4. the effect nodes: arity 4 unchanged, arity 5 gets its ctx --------
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await A.page.waitForTimeout(1500);
	const effects = await A.page.evaluate(async () => {
		const s = window.__stores;
		const read = (st) => new Promise((r) => st.subscribe((v) => r(v))());
		const group = await read(s.objectsGroup);
		let mesh = null;
		group.traverse((n) => {
			if (n.isMesh && !mesh) mesh = n;
		});
		let nodes;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowNodes.set([
			...nodes,
			{ id: 'eold', type: 'testold', position: { x: 0, y: 480 }, data: { type: 'testold' } },
			{ id: 'enew', type: 'testnew', position: { x: 0, y: 560 }, data: { type: 'testnew' } },
			{ id: 'sel', type: 'objectselector', position: { x: 300, y: 520 }, data: { type: 'objectselector', selected: mesh.uuid } }
		]);
		let edges;
		s.flowEdges.subscribe((v) => (edges = v))();
		s.flowEdges.set([
			...edges,
			{ id: 'e-eold-sel', source: 'eold', target: 'sel' },
			{ id: 'e-enew-sel', source: 'enew', target: 'sel' }
		]);
		await new Promise((r) => setTimeout(r, 900));
		return { four: window.__io.effect4, five: window.__io.effect5 };
	});
	h.check(effects.four > 0, `a FOUR-parameter module effect still runs untouched (${effects.four} frames)`);
	h.check(
		effects.five?.id === 'enew' && effects.five?.graphId === 'scene',
		`the 5th arg carries {id, graphId} (${JSON.stringify(effects.five)})`
	);

	// ---- 5. the 'text' param kind: rendered, and ONE write per commit --------
	// The node editor's scope FOLLOWS THE SELECTION, and the box created above is
	// still selected — opening the dock now would show the BOX's object graph, which
	// has no document at all, so every DOM check below would read an empty pane.
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(1600);
	const scope = await A.page.evaluate(() => {
		let id;
		window.__stores.activeGraphId.subscribe((v) => (id = v))();
		return id;
	});
	h.check(scope === 'scene', `premise: the dock is on the SCENE graph (${scope})`);
	const cardSockets = await A.page.evaluate(() => ({
		// `base` is a range param, `mult` a module-declared input with no param —
		// both must have a target socket or one of them is unwirable
		handles: [...document.querySelectorAll('[data-id="ms"] .svelte-flow__handle[data-handleid]')].map((el) =>
			el.getAttribute('data-handleid')
		),
		textInputs: document.querySelectorAll('[data-id="ms"] input[type="text"]').length
	}));
	h.check(
		cardSockets.handles.includes('base') && cardSockets.handles.includes('mult'),
		`the card renders a socket per range param AND per declared input (${JSON.stringify(cardSockets.handles)})`
	);
	h.check(cardSockets.textInputs === 1, `the 'text' param renders a text field (${cardSockets.textInputs})`);

	const typing = await A.page.evaluate(async () => {
		const sent = [];
		const s = window.__stores;
		const peer = await new Promise((r) => s.peers.subscribe((p) => r(p))());
		const real = peer.send.bind(peer);
		peer.send = (msg) => {
			if (msg?.type === 'nodedata' || msg?.type === 'node') sent.push(msg.type);
			return real(msg);
		};
		const input = document.querySelector('[data-id="ms"] input[type="text"]');
		input.focus();
		// six keystrokes' worth of `input` events: NONE of them may write
		for (const ch of 'hello!') {
			input.value += ch;
			input.dispatchEvent(new Event('input', { bubbles: true }));
		}
		await new Promise((r) => setTimeout(r, 400));
		const duringTyping = sent.length;
		// the COMMIT (change/blur) is the one write
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 400));
		const afterCommit = sent.length;
		let nodes;
		s.flowNodes.subscribe((v) => (nodes = v))();
		peer.send = real;
		return { duringTyping, afterCommit, stored: nodes.find((n) => n.id === 'ms')?.data?.note };
	});
	h.check(
		typing.duringTyping === 0,
		`six keystrokes broadcast NOTHING (${typing.duringTyping} messages) — a node edit replicates the whole node`
	);
	h.check(
		typing.afterCommit === 1,
		`the commit is exactly ONE broadcast (${typing.afterCommit})`
	);
	h.check(typing.stored === 'hello!', `the committed text is stored on the node (${JSON.stringify(typing.stored)})`);

	// ---- 6. TWO PEERS: one module trigger, one stamp, the same count ---------
	// fireNodeTrigger replicates like a click, so it must be called on ONE peer only.
	// Both peers need the module installed — a peer without it has no such node type
	// and could not have received the node in the first place.
	const B = await h.setupPage(browser, 'B');
	await B.page.waitForFunction(() => !!window.__stores?.moduleNodeIO, { timeout: 30000 });
	await installModule(B.page);
	await h.connect(A, B);

	const synced = await B.page.evaluate(() => {
		let nodes, edges;
		window.__stores.flowNodes.subscribe((v) => (nodes = v))();
		window.__stores.flowEdges.subscribe((v) => (edges = v))();
		return {
			types: nodes.map((n) => n.type).sort(),
			note: nodes.find((n) => n.id === 'ms')?.data?.note,
			base: nodes.find((n) => n.id === 'ms')?.data?.base,
			pulseEdge: edges.some((e) => e.source === 'ev' && e.target === 'cn')
		};
	});
	h.check(
		synced.types.includes('testscore') && synced.types.includes('testevent'),
		`the module nodes reached the peer (${JSON.stringify(synced.types)})`
	);
	h.check(synced.note === 'hello!', `the committed 'text' param arrived verbatim (${JSON.stringify(synced.note)})`);
	h.check(synced.base === 7, `and so did the range param beside it (${synced.base})`);
	h.check(synced.pulseEdge, 'the module-event -> Counter edge arrived too');

	// the peer computes the same value with no message of its own: a value node is
	// pure, so nothing about it is ever sent
	const peerValue = await B.page.evaluate(() => {
		const s = window.__stores;
		let nodes, edges;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowEdges.subscribe((v) => (edges = v))();
		return s.flowRuntime.evalNode(nodes.find((n) => n.id === 'ms'), nodes, edges, 1, new Set(), null);
	});
	h.check(peerValue === 21, `the peer DERIVES the same value locally (${peerValue})`);

	// fire on A only, three times
	const before = await B.page.evaluate(() => {
		let t;
		window.__stores.flowTriggers.subscribe((v) => (t = v))();
		return t?.cn?.count ?? 0;
	});
	const firedOnA = await A.page.evaluate(async () => {
		const s = window.__stores;
		let n = 0;
		for (let i = 0; i < 3; i++) {
			n = s.flowRuntime.fireModuleTrigger('testevent');
			await new Promise((r) => setTimeout(r, 250));
		}
		return n;
	});
	h.check(firedOnA === 1, `fireModuleTrigger reports the instances it pulsed (${firedOnA})`);
	await A.page.waitForTimeout(1200);
	const counts = await Promise.all(
		[A, B].map((peer) =>
			peer.page.evaluate(() => {
				let t;
				window.__stores.flowTriggers.subscribe((v) => (t = v))();
				return { count: t?.cn?.count ?? 0, stamp: t?.ev?.lastT ?? null };
			})
		)
	);
	h.check(
		counts[0].count === 3 && counts[1].count - before === 3,
		`three pulses fired on ONE peer count three on BOTH (A=${counts[0].count}, B=${counts[1].count})`
	);
	h.check(
		counts[0].stamp !== null && counts[0].stamp === counts[1].stamp,
		`and both peers hold the identical SHARED stamp (${counts[0].stamp} / ${counts[1].stamp})`
	);

	// a match predicate picks instances — the "several of one node type" case
	const matched = await A.page.evaluate(async () => {
		const s = window.__stores;
		let nodes;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowNodes.set([
			...nodes,
			{ id: 'ev2', type: 'testevent', position: { x: 0, y: 640 }, data: { type: 'testevent', tag: 'b' } }
		]);
		await new Promise((r) => setTimeout(r, 400));
		return {
			all: s.flowRuntime.fireModuleTrigger('testevent'),
			tagged: s.flowRuntime.fireModuleTrigger('testevent', (data) => data.tag === 'b')
		};
	});
	h.check(matched.all === 2, `with no match every instance fires (${matched.all})`);
	h.check(matched.tagged === 1, `a match predicate picks one instance (${matched.tagged})`);

	// ---- 7. teardown: the journal really unregisters -------------------------
	const gone = await A.page.evaluate(async () => {
		const s = window.__stores;
		await s.moduleSDK.deactivateModule('testio');
		await new Promise((r) => setTimeout(r, 400));
		const io = s.moduleNodeIO;
		return {
			value: io.isModuleValueNode('testscore'),
			types: io.moduleValueTypes.testscore ?? null,
			inputs: io.moduleInputHandles('testscore').length,
			effectInputs: io.moduleInputHandles('testnew').length,
			outputType: s.flowSockets.outputType('testscore')
		};
	});
	h.check(!gone.value, 'deactivating the module unregisters its value node');
	h.check(gone.types === null, 'and its declared output type');
	h.check(gone.inputs === 0 && gone.effectInputs === 0, 'and both nodes` declared inputs');
	h.check(gone.outputType === 'effect', `so outputType falls back again (${gone.outputType})`);

	await h.finish(browser);
});
