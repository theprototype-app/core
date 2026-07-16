// Roadmap #9 B4.6: the audit's loop-closer nodes — Map Range (remap + clamp)
// and Select (pick a/b by a wired index; pairs with switcher-as-number).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const r = await A.page.evaluate(() => {
		const f = window.__stores.flowRuntime.evalNode;
		const nodes = [
			{ id: 'sw', type: 'switcher', data: { items: ['x', 'y'], index: 1 } },
			{ id: 'sel', type: 'select', data: { index: 0, a: 10, b: 20 } },
			{ id: 'mr', type: 'maprange', data: { inMin: 0, inMax: 10, outMin: 0, outMax: 1, clamp: true, a: 25 } }
		];
		const edges = [{ id: 'e-sw-sel.index', source: 'sw', target: 'sel', targetHandle: 'index' }];
		return {
			mapMid: f({ id: 't1', type: 'maprange', data: { inMin: 0, inMax: 10, outMin: 0, outMax: 100, clamp: true, a: 5 } }, [], [], 0),
			mapClamped: f(nodes.find((n) => n.id === 'mr'), nodes, edges, 0),
			mapUnclamped: f({ id: 't2', type: 'maprange', data: { inMin: 0, inMax: 10, outMin: 0, outMax: 1, clamp: false, a: 25 } }, [], [], 0),
			selWired: f(nodes.find((n) => n.id === 'sel'), nodes, edges, 0), // switcher index 1 -> b
			selManual: f({ id: 't3', type: 'select', data: { index: 0, a: 10, b: 20 } }, [], [], 0),
			inCatalog: !!window.__stores.flowNodes // trivial handle to keep evaluate shape
		};
	});
	h.check(r.mapMid === 50, `maprange remaps 5 in [0,10] to 50 in [0,100] (${r.mapMid})`);
	h.check(r.mapClamped === 1, `maprange clamps out-of-range input (${r.mapClamped})`);
	h.check(Math.abs(r.mapUnclamped - 2.5) < 1e-9, `clamp off extrapolates (${r.mapUnclamped})`);
	h.check(r.selWired === 20, `select follows a WIRED switcher index (${r.selWired})`);
	h.check(r.selManual === 10, `select manual index 0 picks a (${r.selManual})`);

	// both render as cards with typed sockets
	await A.page.evaluate(() => {
		window.__stores.flowNodes.set([
			{ id: 'm1', type: 'maprange', position: { x: 0, y: 0 }, data: { type: 'maprange', label: 'Map Range', inMin: 0, inMax: 1, outMin: 0, outMax: 1, clamp: true, a: 0 } },
			{ id: 's1', type: 'select', position: { x: 240, y: 0 }, data: { type: 'select', label: 'Select', index: 0, a: 0, b: 0 } }
		]);
		window.__stores.flowEdges.set([]);
	});
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(1200);
	const dom = await A.page.evaluate(() => ({
		mr: !!document.querySelector('[data-id="m1"]'),
		selHandles: document.querySelectorAll('[data-id="s1"] .svelte-flow__handle').length
	}));
	h.check(dom.mr, 'Map Range card renders');
	h.check(dom.selHandles === 4, `Select has 3 inputs + 1 output (${dom.selHandles})`);

	await h.finish(browser);
});
