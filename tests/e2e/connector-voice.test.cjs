// 86 T3 — A SCRIPTED VOICE-STYLE SESSION, MEASURED. Claude in voice mode reads every tool result before it
// speaks, so a giant JSON answer is dead air. This suite plays the turns a "build me a campfire" voice chat
// makes through the connector (what can you do → status → look → build → animate → tweak → look again) and
// holds each result to a size budget, printing one `MEASURE {...}` line with every size.
//
// Read tools go through window.tpAgent.exec exactly as a relayed call does (86-b's tab runs tpAgent.exec);
// the edits go through the same executor (aiTools.executeAiTool) because a lone page is not "joined", which
// tpAgent requires before an edit — that gate is agent-api's subject, not this one's.
//
// Run: APP_URL=https://theprototype.app:5883/ npm run e2e -- connector-voice
const h = require('./helpers.cjs');

/** chars per result a voice turn can afford (Claude reads it all before speaking) */
const BUDGET = { default: 4000, list_scene: 8000 };

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { storage: { agentApi: '1' } });
	await A.page.waitForFunction(() => typeof window.tpAgent?.exec === 'function', undefined, { timeout: 60000 });

	/** @type {{step: string, tool: string, chars: number}[]} */
	const transcript = [];
	/** one turn: run, measure, keep the parsed result @param {string} step @param {string} tool @param {any} args @param {'agent'|'executor'} via */
	const turn = async (step, tool, args, via = 'agent') => {
		const text = await A.page.evaluate(
			async ({ tool, args, via }) => {
				const r = via === 'agent' ? await window.tpAgent.exec(tool, args) : await window.__stores.aiTools.executeAiTool(tool, args);
				return JSON.stringify(r);
			},
			{ tool, args, via }
		);
		transcript.push({ step, tool, chars: text.length });
		const budget = BUDGET[tool] ?? BUDGET.default;
		h.check(text.length <= budget, `${step}: ${tool} answers in ${text.length} chars (budget ${budget})`);
		return JSON.parse(text);
	};

	// ---- 1. "What can you do here?" ------------------------------------------------------------
	const help = await turn('what can you do', 'what_can_you_do', {});
	h.check(typeof help.say === 'string' && help.say.length < 300 && /build/.test(help.say), `what_can_you_do has a short spoken line (${help.say})`);
	h.check(!/[{}[\]]|uuid/i.test(help.say), 'the spoken line has no JSON or uuids');
	h.check(Array.isArray(help.tryAsking) && help.tryAsking.length >= 2, 'it suggests requests to try');
	const status = await A.page.evaluate(() => JSON.stringify(window.tpAgent.status()));
	transcript.push({ step: 'status', tool: 'status', chars: status.length });
	h.check(status.length <= BUDGET.default, `status answers in ${status.length} chars`);

	// ---- 2. look, then build a campfire in ONE call --------------------------------------------
	await turn('look first', 'list_scene', {});
	const logs = [0, 1, 2, 3, 4].map((i) => {
		const a = (i / 5) * Math.PI * 2;
		return { kind: 'primitive', primitive: 'Cylinder', name: 'Log ' + (i + 1), position: [Math.cos(a) * 0.5, 0.1, Math.sin(a) * 0.5], rotation: [Math.PI / 2, a, 0], scale: [0.15, 0.8, 0.15], color: '#6b4226' };
	});
	const built = await turn('build a campfire', 'create_objects', {
		objects: [...logs, { kind: 'primitive', primitive: 'Cone', name: 'Flame', position: [0, 0.45, 0], scale: [0.35, 0.7, 0.35], color: '#ff7a1a' }, { kind: 'light', light: 'point', name: 'Fire light', position: [0, 0.8, 0], color: '#ffb066', intensity: 3, distance: 6 }]
	}, 'executor');
	const flame = built.created?.find((/** @type {any} */ c) => c.name === 'Flame') ?? built.created?.[5];
	h.check(Array.isArray(built.created) && built.created.length === 7 && !!flame?.uuid, `the campfire is 7 objects (${JSON.stringify(built).slice(0, 160)})`);

	// ---- 3. "make the flame flicker": look the nodes up, then add them --------------------------
	const groups = await turn('which nodes exist', 'describe_node_types', {});
	h.check(!!groups.groups && Object.keys(groups.groups).length >= 5, 'describe_node_types lists the groups');
	const cards = await turn('how do pulse and blink wire', 'describe_node_types', { types: ['pulse', 'blink', 'onclick', 'latch'] });
	h.check(cards.types?.length === 4 && cards.types.every((/** @type {any} */ c) => c.doc && c.output), 'four full cards, each with a doc and an output');
	const latch = cards.types?.find((/** @type {any} */ c) => c.type === 'latch');
	h.check(['set', 'reset', 'toggle'].every((n) => latch?.inputs?.some((/** @type {any} */ i) => i.name === n)), 'latch lists set/reset/toggle as inputs');
	const flow = await turn('make the flame flicker', 'create_flow_nodes', { graph: flame?.uuid, nodes: [{ type: 'pulse' }] }, 'executor');
	h.check(!flow.error, `the flame gets a pulse node (${JSON.stringify(flow).slice(0, 160)})`);
	// D24 + T1 agree: a handle describe_node_types names is accepted, one it does not name is refused
	const wired = await turn('click to toggle the light', 'create_flow_nodes', {
		graph: 'scene',
		nodes: [{ ref: 'c', type: 'onclick' }, { ref: 'l', type: 'latch' }],
		edges: [{ from: 'c', to: 'l', toHandle: latch?.inputs?.[2]?.name ?? 'toggle' }]
	}, 'executor');
	h.check(!wired.error && !wired.partial, `an edge on a described handle lands (${JSON.stringify(wired).slice(0, 200)})`);

	// ---- 4. "make it bigger", then look again ----------------------------------------------------
	await turn('make the flame bigger', 'update_objects', { updates: [{ uuid: flame?.uuid, scale: [0.5, 1, 0.5] }] }, 'executor');
	const after = await turn('look again', 'list_scene', {});
	h.check(JSON.stringify(after).includes('Fire light'), 'the scene summary shows the campfire');

	const total = transcript.reduce((n, t) => n + t.chars, 0);
	h.check(total <= 30000, `the whole voice session reads ${total} chars of results (budget 30000)`);
	console.log('MEASURE ' + JSON.stringify({ total, turns: transcript }));
	await browser.close();
});
