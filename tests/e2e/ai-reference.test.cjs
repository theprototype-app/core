// 34 D5 — THE ASSISTANT'S REFERENCE: grouped vocabulary + compact graph text, and the
// behaviour tools behind a feature-detect seam. No model is called: the suite reads what a
// model WOULD be handed (system prompt, tool schemas, the per-turn scene summary) and drives
// the executors directly.
//
// It also MEASURES the reference on a real game graph (Towers, from the 1.19 fixture) and
// prints one `MEASURE {...}` line. Run it with MEASURE_ONLY=1 against the base commit's
// src/lib/ai to get the "before" numbers (the asserts below are about the new shape, so they
// are skipped there).
//
// Run: APP_URL=https://theprototype.app:5298/ npm run e2e -- ai-reference
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const h = require('./helpers.cjs');

const GAMES = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'unit', 'fixtures', 'game-graphs.json.gz'))).toString());
const MEASURE_ONLY = process.env.MEASURE_ONLY === '1';

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- the measurement ---------------------------------------------------------------
	const measure = {};
	for (const game of ['towers', 'waves', 'stars-room']) {
		const graph = Object.values(GAMES[game])[0];
		measure[game] = await A.page.evaluate((graph) => {
			const s = window.__stores;
			s.setActiveGraph(s.SCENE_GRAPH);
			s.flowNodes.set(graph.nodes);
			s.flowEdges.set(graph.edges);
			const prompt = s.aiTools.buildSystemPrompt();
			const tools = JSON.stringify(s.aiTools.getAiTools());
			const summary = s.aiTools.summarizeScene();
			// the OLD summary shape, uncapped (it was capped at 12 nodes) — so the graph part
			// can be compared like for like
			const compact = (n) => {
				const o = {};
				for (const [k, v] of Object.entries(n.data ?? {})) {
					if (k === 'label' || k === 'type') continue;
					o[k] = typeof v === 'string' && v.length > 80 ? v.slice(0, 77) + '…' : v;
				}
				return o;
			};
			const oldFull = JSON.stringify({
				nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type, ...compact(n) })),
				edges: graph.edges.map((e) => ({ from: e.source, to: e.target, ...(e.sourceHandle ? { fromHandle: e.sourceHandle } : {}), ...(e.targetHandle ? { toHandle: e.targetHandle } : {}) }))
			});
			const flow = summary.sceneFlow;
			return {
				prompt: prompt.length,
				tools: tools.length,
				fixed: prompt.length + tools.length,
				sceneFlow: typeof flow === 'string' ? flow.length : JSON.stringify(flow ?? null).length,
				sceneFlowComplete: typeof flow === 'string' ? !flow.includes('more lines not shown') : !(flow && flow.truncatedNodes),
				nodesShown: typeof flow === 'string' ? (flow.match(/^\S+ :?= /gm) ?? []).length : (flow?.nodes?.length ?? 0),
				edgesShown: typeof flow === 'string' ? (flow.match(/ -> /g) ?? []).length : (flow?.edges?.length ?? 0),
				nodes: graph.nodes.length,
				edges: graph.edges.length,
				oldShapeFullGraph: oldFull.length
			};
		}, graph);
	}
	console.log('MEASURE ' + JSON.stringify(measure));
	if (MEASURE_ONLY) return h.finish(browser);

	// ---- 1. the reference the model is handed ------------------------------------------
	const view = await A.page.evaluate((towers) => {
		const s = window.__stores;
		s.flowNodes.set(towers.nodes);
		s.flowEdges.set(towers.edges);
		const tools = s.aiTools.getAiTools();
		const flow = tools.find((t) => t.function?.name === 'create_flow_nodes');
		const props = flow?.function?.parameters?.properties ?? {};
		const prompt = s.aiTools.buildSystemPrompt();
		return {
			hasEnum: !!props.nodes?.items?.properties?.type?.enum,
			hasText: props.text?.type === 'string',
			required: flow?.function?.parameters?.required,
			groups: (prompt.match(/^ {2}(Logic|Triggers|Input|HUD|Game): /gm) ?? []).length,
			latchOnce: (prompt.match(/\blatch\b/g) ?? []).length,
			graphText: prompt.includes('id = type "label" {params}') && prompt.includes('a.out -> b.in'),
			behaviourTools: tools.filter((t) => /behaviour/.test(t.function?.name ?? '')).length,
			sceneFlow: s.aiTools.summarizeScene().sceneFlow
		};
	}, Object.values(GAMES.towers)[0]);
	h.check(!view.hasEnum && view.hasText, 'create_flow_nodes: no 100-name type enum any more, a `text` input instead');
	h.check(JSON.stringify(view.required) === '["graph"]', 'graph is the only required arg (nodes OR text)');
	h.check(view.groups === 5, 'the vocabulary is in the prompt, grouped like the palette (' + view.groups + ' of the 5 probed groups)');
	h.check(view.graphText, 'the prompt teaches the graph text format');
	h.check(view.behaviourTools === 0, 'no behaviour host registered -> no behaviour tools offered');
	h.check(typeof view.sceneFlow === 'string' && view.sceneFlow.includes(' -> ') && /= hudbutton "/.test(view.sceneFlow), 'the scene summary carries the graph as compact text');
	// the old summary dropped every label and showed 12 nodes; the text keeps the labels (a
	// Towers button is "Level 1 button", its id "lvl1") and is still the smaller of the two
	for (const [game, m] of Object.entries(measure))
		h.check(m.sceneFlow < m.oldShapeFullGraph, game + ': the summary text, labels included, is smaller than the old JSON shape of the same whole graph (' + m.sceneFlow + ' vs ' + m.oldShapeFullGraph + ')');
	h.check(measure.towers.sceneFlowComplete, 'Towers fits the summary whole (the old shape showed 12 of its 74 nodes)');
	// a big graph is cut at the budget, but node by node WITH its outgoing wires — never a
	// wall of node lines and no wiring (the first cut of this did exactly that: 0 edges shown)
	for (const game of ['waves', 'stars-room'])
		h.check(measure[game].edgesShown > 0 && measure[game].nodesShown > 12, game + ': a cut summary still shows wires (' + measure[game].nodesShown + ' nodes, ' + measure[game].edgesShown + ' edges)');

	// ---- 2. create_flow_nodes from graph text ------------------------------------------
	const built = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.setActiveGraph(s.SCENE_GRAPH);
		s.flowNodes.set([]);
		s.flowEdges.set([]);
		await new Promise((r) => setTimeout(r, 300));
		const res = await s.aiTools.executeAiTool('create_flow_nodes', {
			graph: 'scene',
			text: 'c = onclick\nl = latch {initial: false}\nc -> l.set\nsc = script {code: "return { out: inputs.a * 2 };", inputs: [{name: "a", type: "number"}, {name: "time", type: "number"}], outputs: [{name: "out", type: "number"}]}'
		});
		await new Promise((r) => setTimeout(r, 400));
		let nodes, edges;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowEdges.subscribe((v) => (edges = v))();
		return { res, nodes: nodes.map((n) => ({ type: n.type, data: n.data, hasPos: !!n.position })), edges: edges.map((e) => ({ th: e.targetHandle, id: e.id })) };
	});
	h.check(!built.res.error && built.res.created?.length === 3, 'graph text created three nodes: ' + JSON.stringify(built.res).slice(0, 160));
	const latch = built.nodes.find((n) => n.type === 'latch');
	h.check(latch?.data.label === 'Latch' && latch.data.initial === false && latch.hasPos, 'the catalog label + defaults are laid under the line, and a position assigned');
	h.check(built.edges.length === 1 && built.edges[0].th === 'set' && /^e-.+-.+\.set$/.test(built.edges[0].id), 'the wire landed on latch.set with the canonical id');
	const sc = built.nodes.find((n) => n.type === 'script');
	h.check(JSON.stringify(sc?.data.inputs) === '[{"name":"a","type":"number"}]' && sc?.data.outputs?.[0]?.name === 'out', 'a script line carries its v2 sockets, reserved names dropped (time)');
	const badText = await A.page.evaluate(() => window.__stores.aiTools.executeAiTool('create_flow_nodes', { graph: 'scene', text: 'x = spin {speed: }' }));
	h.check(/line 1:/.test(badText.error ?? ''), 'a bad line comes back as an error naming the line: ' + badText.error);

	// ---- 3. the behaviour host, feature-detected ----------------------------------------
	const beh = await A.page.evaluate(async () => {
		const s = window.__stores;
		const store = {};
		const off = s.aiExtensions.registerBehaviourHost({
			format: 'behaviour/1',
			reference: () => 'BEHAVIOUR-FORMAT: export default behaviour({params, state, on})',
			list: () => Object.keys(store).map((name) => ({ name })),
			read: (name) => store[name] ?? null,
			create: (name, source) => ((store[name] = source), { ok: true, name }),
			edit: (name, source) => ((store[name] = source), { ok: true })
		});
		const offKit = s.aiExtensions.registerAiReference('kit', () => 'KIT-REF: kit.round.start(), kit.score.add(n)');
		const tools = s.aiTools.getAiTools().map((t) => t.function.name);
		const prompt = s.aiTools.buildSystemPrompt();
		const repaired = s.aiTools.repairToolCall('add_behaviour', {}).name;
		const refused = await s.aiTools.executeAiTool('create_behavior', { name: 'roll', source: 'export default behaviour({ on: { tick() { this.state.r = Math.random(); } } });' });
		const created = await s.aiTools.executeAiTool('create_behaviour', { name: 'reach', source: 'export default behaviour({ params: { reach: 1.2 } });' });
		const summary = s.aiTools.summarizeScene().behaviours;
		off();
		offKit();
		return {
			tools,
			prompt: prompt.includes('BEHAVIOUR-FORMAT') && prompt.includes('KIT-REF') && prompt.includes('create_behaviour'),
			repaired,
			repairedAfter: s.aiTools.repairToolCall('add_behaviour', {}).name,
			refused,
			created,
			stored: Object.keys(store),
			summary,
			toolsAfter: s.aiTools.getAiTools().filter((t) => /behaviour/.test(t.function.name)).length,
			promptAfter: s.aiTools.buildSystemPrompt().includes('KIT-REF')
		};
	});
	h.check(beh.tools.includes('create_behaviour') && beh.tools.includes('edit_behaviour'), 'a registered host makes create_behaviour / edit_behaviour appear');
	h.check(beh.prompt, "the host's reference and the kit's reference reach the system prompt");
	h.check(beh.repaired === 'create_behaviour' && beh.repairedAfter === 'create_flow_nodes', 'the behaviour aliases follow the host (with: create_behaviour, without: flow nodes as before)');
	h.check(/NOT applied/.test(beh.refused.error ?? '') && beh.refused.issues?.[0]?.rule === 'nondeterministic', 'Math.random in a behaviour is refused by the lint before apply');
	h.check(JSON.stringify(beh.stored) === '["reach"]' && beh.created.created?.[0]?.name === 'reach', 'a clean behaviour reached the host (the refused one never did)');
	h.check(beh.summary?.[0]?.name === 'reach' && typeof beh.summary[0].source === 'string', 'the scene summary lists it, short source attached');
	h.check(beh.toolsAfter === 0 && !beh.promptAfter, 'unregistering takes the tools and the reference away again');

	h.check(h.pageErrors(A).length === 0, 'no page errors');
	await h.finish(browser);
});
