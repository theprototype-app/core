// 54i row n — ONE PRESS TOGGLES A SHARED VARIABLE ONCE, WITH 2 AND WITH 3 PEERS.
// Owner's take (1.51, ad video): a toggle reading/writing a shared variable double-fires with several peers, while
// set-value buttons work. fix-agenttest item 10 (1.48.1, suite click-once) made a shared Set Variable go to ONE
// writer, the kit authority, which applies each event once. This suite drives the toggles a person or an agent builds
// — Set t = NOT Get t off an On Click, the same off a HUD button, Add 1 (a counter whose parity is the toggle) and a
// Latch's value written into a variable — with two peers, then three, pressing on every peer in turn; and then the
// case 1.48.1 did not cover: peers that DISAGREE about who the authority is (a stale physics initiator, a partial
// mesh, a roster not caught up), where each of them used to apply the press itself.
const h = require('./helpers.cjs');

const GRAPH = {
	nodes: [
		{ id: 'click', type: 'onclick', data: {} },
		{ id: 'selBox', type: 'objectselector', data: {} },
		{ id: 'vis', type: 'visibility', data: { on: true } },
		{ id: 'getT', type: 'getvariable', data: { name: 't', fallback: 0 } },
		{ id: 'notT', type: 'gate', data: { op: 'not' } },
		{ id: 'setT', type: 'setvariable', data: { name: 't', op: 'set', value: 0, scope: 'shared' } },
		{ id: 'addK', type: 'setvariable', data: { name: 'k', op: 'add', value: 1, scope: 'shared' } },
		{ id: 'latch1', type: 'latch', data: { initial: false } },
		{ id: 'setU', type: 'setvariable', data: { name: 'u', op: 'set', value: 0, scope: 'shared' } },
		{ id: 'hudBtn', type: 'hudbutton', data: { element: 'toggle-btn' } },
		{ id: 'getH', type: 'getvariable', data: { name: 'hv', fallback: 0 } },
		{ id: 'notH', type: 'gate', data: { op: 'not' } },
		{ id: 'setH', type: 'setvariable', data: { name: 'hv', op: 'set', value: 0, scope: 'shared' } }
	],
	edges: [
		['click', 'vis', 'on'],
		['vis', 'selBox', null],
		['getT', 'notT', 'a'],
		['notT', 'setT', 'value'],
		['click', 'setT', 'trigger'],
		['click', 'addK', 'trigger'],
		['click', 'latch1', 'toggle'],
		['latch1', 'setU', 'value'],
		['click', 'setU', 'trigger'],
		['getH', 'notH', 'a'],
		['notH', 'setH', 'value'],
		['hudBtn', 'setH', 'trigger']
	]
};

const read = (p) =>
	p.page.evaluate(() => {
		let g;
		window.__stores.gameState.gameState.subscribe((v) => (g = v))();
		const v = g?.vars ?? {};
		return { t: Number(v.t) || 0, k: Number(v.k) || 0, u: Number(v.u) || 0, hv: Number(v.hv) || 0 };
	});
const links = (p) => p.page.evaluate(() => { let pr; window.__stores.peers.subscribe((v) => (pr = v))(); return pr?.openedPeers?.size ?? 0; });
const authority = (p) => p.page.evaluate(() => window.__stores.kit?.kitAuthorityId?.() ?? null);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(({ nodes, edges }) => {
		const S = window.__stores;
		S.commandsHandler.sceneCommand('/create box');
		let g;
		S.objectsGroup.subscribe((x) => (g = x))();
		const box = g.children[g.children.length - 1];
		box.name = 'Toggle';
		S.objectActions.deselectObject();
		nodes.forEach((n, i) => {
			const data = n.id === 'selBox' ? { selected: box.uuid } : n.data;
			S.nodesHandler.createFlowNode({ id: n.id, type: n.type, position: { x: (i % 4) * 200, y: Math.floor(i / 4) * 140 }, data: { type: n.type, ...data } });
		});
		for (const [source, target, targetHandle] of edges)
			S.nodesHandler.createFlowEdge({ id: 'e-' + source + '-' + target + (targetHandle ? '.' + targetHandle : ''), source, target, ...(targetHandle ? { targetHandle } : {}) });
		window.__button = box.uuid;
	}, GRAPH);
	const button = await A.page.evaluate(() => window.__button);
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	let presses = 0;
	/** one press on `who`, by click and by the HUD button, then every peer in `peers` must hold one press's worth */
	const press = async (peers, who, label) => {
		presses++;
		await who.page.evaluate((u) => {
			window.__stores.flowRuntime.fireObjectClick(u);
			window.__stores.flowRuntime.fireHudButton('toggle-btn');
		}, button);
		const want = { t: presses % 2, k: presses, u: presses % 2, hv: presses % 2 };
		const ok = (s) => Object.entries(want).every(([k, v]) => s[k] === v);
		await h.eventually(() => Promise.all(peers.map(read)), (all) => all.every(ok), `${label}: every peer settles`, 20000).catch(() => {});
		await A.page.waitForTimeout(3000); // a late second write lands within this
		const seen = await Promise.all(peers.map(read));
		console.log(`  ${label} (press ${presses} on ${who.id}, want ${JSON.stringify(want)}): ` + JSON.stringify(Object.fromEntries(peers.map((p, i) => [p.id, seen[i]]))));
		for (const [i, p] of peers.entries()) {
			const s = seen[i];
			h.check(s.t === want.t, `${label}: ${p.id}: Set t = NOT Get t toggled once (t = ${s.t})`);
			h.check(s.hv === want.hv, `${label}: ${p.id}: the HUD button's toggle toggled once (hv = ${s.hv})`);
			h.check(s.k === want.k, `${label}: ${p.id}: Add 1 counted the press once (k = ${s.k})`);
			h.check(s.u === want.u, `${label}: ${p.id}: the Latch value written once (u = ${s.u})`);
		}
	};

	// ---- 1. two peers
	await h.eventually(() => Promise.all([A, B].map(links)), (n) => n.every((v) => v === 1), 'premise: A and B are linked', 30000);
	await h.eventually(() => Promise.all([A, B].map((p) => p.page.evaluate(() => window.__stores.nodesHandler.graphHash()))), (hs) => hs[0] === hs[1], 'premise: B holds the graph', 30000);
	console.log('  authority as A, B see it: ' + JSON.stringify(await Promise.all([A, B].map(authority))));
	await press([A, B], A, '2 peers, A');
	await press([A, B], B, '2 peers, B');

	// ---- 2. the two peers disagree about the authority (each believes the OTHER decides — a stale initiator)
	const ids = { A: A.id, B: B.id };
	await A.page.evaluate((other) => window.__stores.physics.remoteSimulating?.set(other), ids.B);
	await B.page.evaluate((other) => window.__stores.physics.remoteSimulating?.set(other), ids.A);
	const split = await Promise.all([A, B].map(authority));
	console.log('  authority after the stale initiators (A, B): ' + JSON.stringify(split));
	h.check(split[0] === ids.B && split[1] === ids.A, 'premise: A and B each believe the other is the authority');
	await press([A, B], A, '2 peers disagreeing, A');
	await press([A, B], B, '2 peers disagreeing, B');
	await A.page.evaluate(() => window.__stores.physics.remoteSimulating?.set(null));
	await B.page.evaluate(() => window.__stores.physics.remoteSimulating?.set(null));

	// ---- 3. three peers
	const C = await h.setupPageQuiet(browser, 'C', [A, B]);
	await h.connect(C, A);
	const peers = [A, B, C];
	await h.eventually(() => Promise.all(peers.map((p) => p.page.evaluate(() => window.__stores.nodesHandler.graphHash()))), (hs) => hs.every((x) => x === hs[0]), 'premise: all three hold the graph', 60000);
	await h.eventually(() => Promise.all(peers.map(read)), (all) => all.every((s) => s.k === presses), 'premise: C holds the variables', 30000);
	await h.eventually(() => Promise.all(peers.map(links)), (n) => n.every((v) => v === 2), 'premise: a full mesh', 90000);
	console.log('  links per peer (A, B, C): ' + JSON.stringify(await Promise.all(peers.map(links))));
	console.log('  authority as A, B, C see it: ' + JSON.stringify(await Promise.all(peers.map(authority))));
	for (const who of peers) await press(peers, who, '3 peers, ' + who.id);

	for (const p of peers) {
		const errs = h.pageErrors(p);
		h.check(errs.length === 0, `no page errors on ${p.id}: ` + JSON.stringify(errs.slice(0, 3)));
	}
	await h.finish(browser);
});
