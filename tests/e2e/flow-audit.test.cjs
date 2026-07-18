// Roadmap #9 B4.1: flow audit correctness fixes — handle-qualified edge ids (the
// a+b divergence bug) and distance/proximity accepting wired vector3 literals.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const r = await A.page.evaluate(() => {
		const s = window.__stores;
		// a number feeding BOTH a and b of one math node — ids must differ now
		s.flowNodes.set([
			{ id: 'n1', type: 'number', position: { x: 0, y: 0 }, data: { value: 2, step: 1 } },
			{ id: 'm1', type: 'math', position: { x: 200, y: 0 }, data: { op: 'add', a: 0, b: 0 } },
			{ id: 'v1', type: 'vector3', position: { x: 0, y: 100 }, data: { x: 3, y: 0, z: 4 } },
			{ id: 'd1', type: 'distance', position: { x: 200, y: 100 }, data: {} },
			{ id: 'v2', type: 'vector3', position: { x: 0, y: 200 }, data: { x: 0, y: 0, z: 0 } }
		]);
		const mk = (src, sh, tgt, th) => ({
			id: `e-${src}${sh ? '.' + sh : ''}-${tgt}${th ? '.' + th : ''}`,
			source: src, sourceHandle: sh, target: tgt, targetHandle: th
		});
		const ea = mk('n1', null, 'm1', 'a');
		const eb = mk('n1', null, 'm1', 'b');
		s.flowEdges.set([ea, eb, mk('v1', null, 'd1', 'a'), mk('v2', null, 'd1', 'b')]);
		let nodes, edges;
		s.flowNodes.subscribe((x) => (nodes = x))();
		s.flowEdges.subscribe((x) => (edges = x))();
		const math = s.flowRuntime.evalNode(nodes.find((n) => n.id === 'm1'), nodes, edges, 0);
		const dist = s.flowRuntime.evalNode(nodes.find((n) => n.id === 'd1'), nodes, edges, 0);
		return { distinctIds: ea.id !== eb.id, math, dist };
	});
	h.check(r.distinctIds, 'a+b edges from one source get distinct ids (divergence fix)');
	h.check(r.math === 4, `both edges feed the math node (2+2=${r.math})`);
	h.check(Math.abs(r.dist - 5) < 1e-6, `distance accepts wired vector3 literals (3-4-5 = ${r.dist})`);

	await h.finish(browser);
});
