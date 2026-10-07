// 36 B7: the node MANAGER (switch node types off on this device) and the `.tpnode` file
// (save a group on its own, import it into another graph — by menu or by dropping the file).
//
// Counterfactual (broken by hand once, the named check went red):
//   · Sidebar without enabledCatalog -> "a switched-off type leaves the palette"
const h = require('./helpers.cjs');
const fs = require('fs');

const graph = (page) =>
	page.evaluate(() => {
		let ns;
		let es;
		window.__stores.flowNodes.subscribe((v) => (ns = v))();
		window.__stores.flowEdges.subscribe((v) => (es = v))();
		return { nodes: ns.map((n) => ({ id: n.id, type: n.type, data: n.data })), edges: es.map((e) => ({ source: e.source, target: e.target })) };
	});
const select = (page, ids) =>
	page.evaluate((ids) => window.__stores.flowNodes.update((ns) => ns.map((n) => ({ ...n, selected: ids.includes(n.id) }))), ids);
const paletteHas = (page, label) =>
	page.evaluate((label) => [...document.querySelectorAll('aside [role="listitem"]')].some((el) => el.textContent.trim() === label), label);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const p = A.page;
	await p.locator('p[title="Node editor (N)"]').click();
	await p.waitForTimeout(800);
	await p.evaluate(() => {
		const mk = (id, x, type = 'number') => ({ id, type, position: { x, y: 0 }, data: { type, value: 2, label: id, ...(type === 'math' ? { op: 'add' } : {}) }, class: 'w-[150px]' });
		window.__stores.flowNodes.set([mk('a', 0), mk('b', 240, 'math'), mk('c', 480, 'math')]);
		window.__stores.flowEdges.set([{ id: 'e-a-b.a', source: 'a', target: 'b', targetHandle: 'a' }, { id: 'e-b-c.a', source: 'b', target: 'c', targetHandle: 'a' }]);
	});
	await p.waitForTimeout(600);

	// --- 1. the node manager -----------------------------------------------------------
	h.check(await paletteHas(p, 'Number'), 'the palette lists Number to begin with');
	await p.evaluate(() => {
		window.__stores.settingsSection.set('nodetypes');
		window.__stores.settingsOpen.set(true);
	});
	await p.waitForTimeout(800);
	h.check(await p.locator('#node-types-section').isVisible(), 'Settings ▸ Node types lists the node types');
	// 37-settings: one sub-page per group, and the filter lists matching types inline
	await p.locator('#node-types-filter').fill('Number');
	await p.waitForTimeout(300);
	h.check((await p.locator('[data-node-type="number"]').first().textContent()).includes('in use'), 'a type in use says so');
	await p.locator('[data-node-type="number"] [data-nt="type-toggle"]').first().click();
	await p.waitForTimeout(300);
	h.check((await p.evaluate(() => localStorage.getItem('disabledNodeTypes'))) === '["number"]', 'switching a type off is remembered on this device');
	await p.evaluate(() => window.__stores.settingsOpen.set(false));
	await p.waitForTimeout(500);
	h.check(!(await paletteHas(p, 'Number')), 'a switched-off type leaves the palette');
	const pane = await p.locator('.svelteFlow .svelte-flow__pane').boundingBox();
	await p.mouse.click(pane.x + 40, pane.y + 40);
	await p.mouse.move(pane.x + 200, pane.y + 100);
	await p.keyboard.press('Shift+A');
	await p.waitForTimeout(300);
	await p.keyboard.type('Number');
	await p.waitForTimeout(300);
	const found = await p.evaluate(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((r) => r.textContent.trim()).filter((t) => /▸ Number$|^Number$/.test(t)));
	h.check(found.length === 0, `…and the node search (${JSON.stringify(found)})`);
	await p.keyboard.press('Escape');
	await p.keyboard.press('Escape');
	const live = await p.evaluate(() => window.__stores.runtimeGraph(window.__stores.allNodes(), window.__stores.allEdges()).nodes.some((n) => n.id === 'a'));
	h.check(live && (await p.locator('.svelte-flow__node[data-id="a"]').count()) === 1, 'a Number node already in the graph keeps working');
	await p.evaluate(() => {
		window.__stores.settingsSection.set('nodetypes');
		window.__stores.settingsOpen.set(true);
	});
	await p.waitForTimeout(600);
	// "Turn all on" is the footer's "Reset Node types to defaults" now (it asks first)
	await p.locator('#settings-reset-category').click();
	await p.locator('#confirm-dialog-ok').click();
	await p.waitForTimeout(200);
	await p.evaluate(() => window.__stores.settingsOpen.set(false));
	await p.waitForTimeout(400);
	h.check((await paletteHas(p, 'Number')) && !(await p.evaluate(() => localStorage.getItem('disabledNodeTypes'))), 'Turn all on brings it back');

	// --- 2. export a group as a .tpnode file ---------------------------------------------
	await p.mouse.click(pane.x + 40, pane.y + 40);
	await select(p, ['a', 'b']);
	await p.keyboard.press('Control+g');
	await p.waitForTimeout(500);
	const G = (await graph(p)).nodes.find((n) => n.type === 'group');
	await p.evaluate((id) => window.__stores.nodesHandler.setNodeData(id, { label: 'Doubler' }), G.id);
	await p.waitForTimeout(300);
	await p.keyboard.press('a'); // frame all: the new card can sit under the scope chip at the pane top
	await p.waitForTimeout(500);
	const gb = await p.locator(`.svelte-flow__node[data-id="${G.id}"]`).boundingBox();
	await p.mouse.click(gb.x + gb.width / 2, gb.y + gb.height / 2, { button: 'right' });
	await p.waitForTimeout(300);
	console.log('group menu: ' + JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((r) => r.textContent.trim()))));
	const [download] = await Promise.all([
		p.waitForEvent('download', { timeout: 10000 }),
		p.locator('[role="menu"] [role="menuitem"]', { hasText: /^\s*Export group/ }).first().click()
	]);
	const file = '/tmp/claude-1000/node-ux-' + Date.now() + '.tpnode';
	await download.saveAs(file);
	const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
	h.check(download.suggestedFilename() === 'Doubler.tpnode', `the file is named after the group (${download.suggestedFilename()})`);
	h.check(doc.tpnode === 1 && doc.nodes.length === 3 && doc.edges.length === 1, `it holds the group, its members and the inner wire (${doc.nodes.length} nodes, ${doc.edges.length} wires)`);

	// --- 3. import it (menu file picker) ------------------------------------------------
	await p.locator('#flow-tpnode-input').setInputFiles(file);
	await p.waitForTimeout(600);
	let g = await graph(p);
	const groups = g.nodes.filter((n) => n.type === 'group');
	h.check(groups.length === 2 && groups.some((x) => x.id !== G.id && x.data.label === 'Doubler'), 'importing adds a second copy of the group');
	const copy = groups.find((x) => x.id !== G.id);
	h.check(copy.data.children.every((c) => !['a', 'b'].includes(c)) && g.nodes.length === 7, 'with its own fresh members');
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(400);
	h.check((await graph(p)).nodes.length === 4, 'one undo removes the whole import');

	// --- 4. a wrong file is refused, nothing added ---------------------------------------
	const bad = '/tmp/claude-1000/node-ux-bad-' + Date.now() + '.tpnode';
	fs.writeFileSync(bad, JSON.stringify({ hello: 'world' }));
	await p.locator('#flow-tpnode-input').setInputFiles(bad);
	await p.waitForTimeout(500);
	h.check((await graph(p)).nodes.length === 4, 'a file that is not a node group adds nothing');
	h.check(await p.getByText('is not a node group').count() > 0, '…and says why');

	// --- 5. drop the file onto the canvas -------------------------------------------------
	const text = fs.readFileSync(file, 'utf8');
	await p.evaluate(
		({ text, x, y }) => {
			const dt = new DataTransfer();
			dt.items.add(new File([text], 'Doubler.tpnode', { type: 'application/json' }));
			const target = document.querySelector('.svelteFlow .svelte-flow');
			for (const type of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }));
		},
		{ text, x: pane.x + pane.width - 250, y: pane.y + 120 }
	);
	await p.waitForTimeout(800);
	g = await graph(p);
	h.check(g.nodes.filter((n) => n.type === 'group').length === 2, 'dropping a .tpnode file on the canvas imports it');
	fs.rmSync(file, { force: true });
	fs.rmSync(bad, { force: true });

	await h.finish(browser);
});
