// Roadmap #9 B4.5: custom-node input sockets + deterministic edge pruning — a
// def's range params get target sockets (they were unwirable); editing the def
// to remove a param prunes edges into the gone socket (applier-side invariant,
// drift-heal safe).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => {
		const s = window.__stores;
		s.customNodes.applyNodeDef({
			id: 'def1', name: 'MyNode', code: 'return (a??0)',
			params: [
				{ key: 'speed', kind: 'range', min: 0, max: 10, step: 1 },
				{ key: 'size', kind: 'range', min: 0, max: 5, step: 1 }
			]
		});
		s.flowNodes.set([
			{ id: 'n1', type: 'number', position: { x: 0, y: 0 }, data: { type: 'number', label: 'Number', value: 3 } },
			{ id: 'cn1', type: 'customnode', position: { x: 220, y: 0 }, data: { type: 'customnode', defId: 'def1', speed: 1, size: 2 } }
		]);
		s.flowEdges.set([
			{ id: 'e-n1-cn1.speed', source: 'n1', target: 'cn1', targetHandle: 'speed' },
			{ id: 'e-n1-cn1.size', source: 'n1', target: 'cn1', targetHandle: 'size' }
		]);
	});
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(1200);

	const sockets = await A.page.evaluate(() =>
		document.querySelectorAll('[data-id="cn1"] .svelte-flow__handle[data-handleid]').length
	);
	h.check(sockets === 2, `custom node renders a target socket per range param (${sockets})`);

	// edit the def: remove 'size' -> its socket disappears + the edge prunes
	const pruned = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.customNodes.applyNodeDef({
			id: 'def1', name: 'MyNode', code: 'return (a??0)',
			params: [{ key: 'speed', kind: 'range', min: 0, max: 10, step: 1 }]
		});
		await new Promise((r) => setTimeout(r, 500));
		let edges;
		s.flowEdges.subscribe((x) => (edges = x))();
		return {
			edges: edges.map((e) => e.targetHandle),
			handles: document.querySelectorAll('[data-id="cn1"] .svelte-flow__handle[data-handleid]').length
		};
	});
	h.check(pruned.edges.length === 1 && pruned.edges[0] === 'speed', `the removed param's edge is pruned (${pruned.edges.join(',')})`);
	h.check(pruned.handles === 1, `the removed param's socket is gone (${pruned.handles})`);

	// snapshot post-pass: a stale snapshot cannot resurrect the dangling edge
	const healed = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.nodesHandler.applyNodesSnapshot(
			[],
			[{ id: 'e-n1-cn1.size', source: 'n1', target: 'cn1', targetHandle: 'size' }]
		);
		await new Promise((r) => setTimeout(r, 300));
		let edges;
		s.flowEdges.subscribe((x) => (edges = x))();
		return edges.map((e) => e.targetHandle);
	});
	h.check(!healed.includes('size'), `a stale snapshot cannot resurrect the pruned edge (${healed.join(',')})`);

	await h.finish(browser);
});
