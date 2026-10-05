// 36 (DEVX #10) — api.flow.seedGraph: a module seeds a WIRED example graph on load, absent-only.
//
//   1. first load: the nodes + wire appear on A (marked `data.seed = '<module>:<key>'`) and on B,
//      and the wire works (Number 5 → Math.a → 5 on B)
//   2. unload + load again: nothing is added twice (the seed mark is found)
//   3. a scene that already USES the module (one of its node types, no seed mark) is left alone
//
// Run: APP_URL=https://theprototype.app:5329/ npm run e2e -- module-seed-graph
const h = require('./helpers.cjs');

const MODULE = (key) => `({
	id: 'seedtest',
	name: 'Seed test',
	version: '1.0.0',
	register(api) {
		api.registerNodeGroup({ group: 'Seed test', items: [{ type: 'seedthing', label: 'Seed thing', defaults: {} }] });
		window.__seedResult = api.flow.seedGraph({
			key: '${key}',
			nodes: [
				{ type: 'number', x: 0, y: 0, data: { value: 5 } },
				{ type: 'math', x: 220, y: 0, data: { op: 'add', a: 0, b: 0 } }
			],
			edges: [{ from: 0, to: 1, handle: 'a' }]
		});
	}
})`;
const load = (peer, key) =>
	peer.page.evaluate((src) => {
		const mod = (0, eval)(src);
		window.__stores.moduleSDK.initModules([mod]);
		return window.__seedResult;
	}, MODULE(key));
const unload = (peer) => peer.page.evaluate(() => window.__stores.moduleSDK.unloadModule('seedtest'));
const seeded = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.flowGraphs.subscribe((v) => (g = v))();
		return {
			nodes: g.scene.nodes.filter((n) => n.data?.seed === 'seedtest:demo').map((n) => ({ id: n.id, type: n.type })),
			edges: g.scene.edges.length
		};
	});
const valueOf = (peer, id) => peer.page.evaluate((id) => new Promise((r) => window.__stores.flowValues.subscribe((v) => r(v[id] ?? null))()), id);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const ids = await load(A, 'demo');
	h.check(Array.isArray(ids) && ids.length === 2, `first load seeds two nodes (${JSON.stringify(ids)})`);
	await h.eventually(() => seeded(B), (s) => s.nodes.length === 2 && s.edges >= 1, 'B receives the seeded nodes and the wire', 5000);
	const math = (await seeded(B)).nodes.find((n) => n.type === 'math')?.id;
	await h.eventually(() => valueOf(B, math), (v) => v === 5, 'the wire works on B (Number 5 → Math.a = 5)', 5000);

	await unload(A);
	const again = await load(A, 'demo');
	h.check(Array.isArray(again) && again.length === 0, 'unload + load again seeds nothing (the mark is found)');
	h.check((await seeded(A)).nodes.length === 2, 'still exactly two seeded nodes');

	// a scene already using the module: one of its types, no seed mark → left alone
	await unload(A);
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowNodes.set([{ id: 'own', type: 'seedthing', position: { x: 0, y: 0 }, data: { type: 'seedthing', label: 'Seed thing' } }]);
		s.flowEdges.set([]);
	});
	await A.page.waitForTimeout(300);
	const fresh = await load(A, 'other');
	h.check(Array.isArray(fresh) && fresh.length === 0, "a graph that already uses the module's node types is the user's — nothing seeded");

	await h.finish(browser);
});
