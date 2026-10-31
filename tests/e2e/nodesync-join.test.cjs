// fix-agenttest item 5 — A JOIN IS NOT GRAPH DRIFT.
// The agent test's joiner logged "Node graph differs from <host> -- requesting a snapshot" right
// after every join and pulled the graphs a second time: the host's 10 s nodesync reached it before
// the handshake's own getnodes had been answered (through an approval, before it was even sent).
// nodesHandler now holds a peer's nodesync back while its first full snapshot is on its way
// (NODESYNC_HANDSHAKE_MS), and compares as before once it has arrived.
// Counterfactual on v1.47.0: 1.1 is red (the joiner asks for the snapshot it is already getting).
const h = require('./helpers.cjs');

const hashOf = (p) => p.page.evaluate(() => window.__stores.nodesHandler.graphHash());

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => {
		const S = window.__stores;
		S.commandsHandler.sceneCommand('/create box');
		let g;
		S.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		S.flowGraphsCtl.createObjectGraph(box.uuid);
		S.nodesHandler.createFlowNode({ id: 'spin1', type: 'spin', position: { x: 0, y: 0 }, data: { type: 'spin', axis: 'y', speed: 2 } }, box.uuid);
		S.nodesHandler.createFlowNode({ id: 'k1', type: 'keypress', position: { x: 0, y: 0 }, data: { key: 'KeyR' } });
	});
	const B = await h.setupPage(browser, 'B');
	const asks = [];
	B.page.on('console', (m) => /Node graph differs/.test(m.text()) && asks.push(m.text()));
	await h.connect(B, A);
	await h.eventually(async () => [await hashOf(A), await hashOf(B)], ([a, b]) => a === b, '1.0 the joiner has the host graphs', 30000);
	// three nodesync rounds after the join
	await B.page.waitForTimeout(32000);
	h.check(asks.length === 0, `1.1 the joiner asks for no second snapshot after joining (${asks.length}: ${asks[0] ?? ''})`);
	h.check((await hashOf(A)) === (await hashOf(B)), '1.2 the graphs still agree');

	// drift is still caught: change the host's graph WITHOUT telling anyone, the joiner pulls it
	await A.page.evaluate(() => {
		const S = window.__stores;
		S.flowGraphs.update((all) => {
			const scene = all.scene;
			return { ...all, scene: { ...scene, nodes: [...scene.nodes, { id: 'k2', type: 'keypress', position: { x: 80, y: 0 }, data: { key: 'KeyT' } }] } };
		});
	});
	await h.eventually(async () => [await hashOf(A), await hashOf(B)], ([a, b]) => a === b, '2.1 a real drift after the join is still pulled by nodesync', 45000);
	h.check(asks.length === 1, `2.2 ... through exactly one snapshot request (${asks.length})`);

	for (const p of [A, B]) {
		const errs = h.pageErrors(p);
		h.check(errs.length === 0, `no page errors on ${p.id}: ` + JSON.stringify(errs.slice(0, 3)));
	}
	await h.finish(browser);
});
