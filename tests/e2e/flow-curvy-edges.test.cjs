// Phase 150: flow connections render as smooth bezier curves (was smoothstep).
// A rendered edge's SVG path is a single cubic ('C', no straight 'L' segments).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// open the node editor so the SvelteFlow (and its edges) mount
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(600);

	// a Number -> Spin.speed edge, typed bezier like onedgecreate now produces
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowNodes.set([
			{ id: 'ce-a', type: 'number', position: { x: 0, y: 0 }, data: { type: 'number', value: 1 }, class: 'w-[150px]' },
			{ id: 'ce-b', type: 'spin', position: { x: 320, y: 0 }, data: { type: 'spin', label: 'Spin', axis: 'y', speed: 1 }, class: 'w-[150px]' }
		]);
		s.flowEdges.set([{ id: 'ce-edge', source: 'ce-a', target: 'ce-b', targetHandle: 'speed', type: 'bezier' }]);
	});
	await A.page.waitForTimeout(900);

	const edge = await A.page.evaluate(() => {
		const paths = [...document.querySelectorAll('.svelte-flow__edge-path')];
		const d = paths.map((p) => p.getAttribute('d') || '').find((v) => v.length > 0) || '';
		return { count: paths.length, d };
	});
	h.check(edge.count >= 1, `the edge renders (${edge.count} edge path[s])`);
	h.check(/C/.test(edge.d), `the edge path is a cubic bezier curve (${edge.d.slice(0, 40)}...)`);
	h.check(!/[ ,]L|^L|\bL\d/.test(edge.d) && !/L/.test(edge.d), 'the path has no straight-line (L) segments — not smoothstep/straight');

	await h.finish(browser);
});
