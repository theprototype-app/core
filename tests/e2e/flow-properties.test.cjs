// Phase 166: the Flow properties sidebar (right, collapses like the palette).
// Graph props (edge style, minimap, background, grid snap) change the flow live;
// a selected node's props (rename) replicate; open/collapse persists.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(500);
	// two nodes + a bezier edge for the edge-style check
	await A.page.evaluate(() => {
		window.__stores.flowNodes.set([
			{ id: 'p-a', type: 'number', position: { x: 60, y: 80 }, data: { type: 'number', value: 1 }, class: 'w-[150px]' },
			{ id: 'p-b', type: 'spin', position: { x: 340, y: 80 }, data: { type: 'spin', label: 'Spin', axis: 'y', speed: 1 }, class: 'w-[150px]' }
		]);
		window.__stores.flowEdges.set([{ id: 'p-e', source: 'p-a', target: 'p-b', targetHandle: 'speed', type: 'bezier' }]);
	});
	await A.page.waitForTimeout(500);

	// --- open the properties panel + persist ---
	await A.page.locator('#flow-props-toggle').click();
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('#flow-props').isVisible(), 'the properties panel opens');
	h.check(
		(await A.page.evaluate(() => localStorage.getItem('flowPropsOpen'))) === 'true',
		'the open state persists'
	);

	// --- minimap toggle hides the minimap ---
	const miniBefore = await A.page.locator('.svelte-flow__minimap').count();
	await A.page.locator('#flow-minimap-toggle').click();
	await A.page.waitForTimeout(300);
	const miniAfter = await A.page.locator('.svelte-flow__minimap').count();
	h.check(miniBefore === 1 && miniAfter === 0, 'the minimap toggle hides the minimap');

	// --- edge style: switch to Straight -> the edge path is no longer a cubic ---
	const edgeBefore = await A.page.evaluate(() => document.querySelector('.svelte-flow__edge-path')?.getAttribute('d') || '');
	await A.page.evaluate(() => document.querySelector('#flow-edge-style').click()); // open the themed popup
	await A.page.waitForTimeout(200);
	await A.page.evaluate(() => {
		const opt = [...document.querySelectorAll('.ts-list .ts-opt')].find((o) => o.textContent.trim() === 'Straight');
		opt && opt.click();
	});
	await A.page.waitForTimeout(300);
	const edgeAfter = await A.page.evaluate(() => document.querySelector('.svelte-flow__edge-path')?.getAttribute('d') || '');
	h.check(/C/.test(edgeBefore) && !/C/.test(edgeAfter), 'switching edge style restyles the existing edge (bezier -> straight)');

	// --- selecting a node swaps the panel to its props; rename replicates ---
	const renamed = await A.page.evaluate(() => {
		window.__stores.flowNodes.update((ns) => ns.map((n) => ({ ...n, selected: n.id === 'p-b' })));
		return new Promise((resolve) =>
			setTimeout(() => {
				const input = document.querySelector('#flow-node-name');
				if (!input) return resolve({ present: false });
				const captured = []; let original;
				window.__stores.peers.subscribe((p) => (original = p))();
				window.__stores.peers.set({ ...(original ?? {}), peer: { id: 'me' }, send: (m) => captured.push(m) });
				input.value = 'Spinner';
				input.dispatchEvent(new Event('change', { bubbles: true }));
				window.__stores.peers.set(original);
				let ns; window.__stores.flowNodes.subscribe((v) => (ns = v))();
				const node = ns.find((n) => n.id === 'p-b');
				resolve({ present: true, label: node.data.label, sent: captured.some((m) => m.type === 'nodedata') });
			}, 200)
		);
	});
	h.check(renamed.present, 'selecting a node shows its properties (rename field)');
	h.check(renamed.label === 'Spinner' && renamed.sent, 'renaming updates the node + replicates');

	await h.finish(browser);
});
