// 37 (R6): the Switcher as an N-way MULTIPLEXER, through the real node editor, undo and a second
// peer: one typed input socket per item, the `value` output passes the selected item's input, a
// wired index overrides the radio, removing an item (the ⓘ ✕) keeps the wires on their values, a
// type change drops the wires the new type refuses (one undo step), the unnamed output stays the
// index. Split out of variadic-nodes.test.cjs (the runner's 8-minute cap).
//
// Counterfactual (broken by hand once, the named check went red):
//   · flowRuntime `switcher` returning the plain index -> "the multiplexer passes item 0's input"
const h = require('./helpers.cjs');

const OUT = '/home/deck/.code/lanes-30/after-37/37-nodes/';
const graph = (page) =>
	page.evaluate(() => {
		let ns;
		let es;
		window.__stores.flowNodes.subscribe((v) => (ns = v))();
		window.__stores.flowEdges.subscribe((v) => (es = v))();
		return {
			nodes: ns.map((n) => ({ id: n.id, type: n.type, data: n.data })),
			edges: es.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? null, target: e.target, targetHandle: e.targetHandle ?? null }))
		};
	});
const value = (page, id) =>
	page.evaluate((id) => {
		let v;
		window.__stores.flowValues.subscribe((x) => (v = x))();
		const r = v[id];
		return r && typeof r === 'object' && r.__handles ? { handles: r.__handles, def: r.__default } : r;
	}, id);
const select = (page, ids) =>
	page.evaluate((ids) => window.__stores.flowNodes.update((ns) => ns.map((n) => ({ ...n, selected: ids.includes(n.id) }))), ids);
const handle = (node, id) => `.svelteFlow .svelte-flow__handle[data-nodeid="${node}"]` + (id === null ? ':not([data-handleid])' : `[data-handleid="${id}"]`);
const card = (id) => `.svelteFlow .svelte-flow__node[data-id="${id}"]`;
const into = (g, target) =>
	g.edges
		.filter((e) => e.target === target)
		.map((e) => e.source + '>' + e.targetHandle)
		.sort()
		.join(' ');
async function focusNodes(page) {
	const pane = await page.locator('.svelteFlow .svelte-flow__pane').boundingBox();
	// top-right: the bottom-left corner is xyflow's zoom Controls (a click there leaves focus on a
	// button and Ctrl+Z never reaches the history shortcut) and the bottom-right is the minimap
	await page.mouse.click(pane.x + pane.width - 40, pane.y + 30);
	await page.waitForTimeout(150);
}
async function wire(page, fromSel, toSel) {
	const a = await page.locator(fromSel).first().boundingBox();
	const b = await page.locator(toSel).first().boundingBox();
	if (!a || !b) return false;
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
	await page.mouse.down();
	await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
	await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
	await page.mouse.up();
	await page.waitForTimeout(400);
	return true;
}
const N = (id, type, x, y, data = {}) => ({ id, type, position: { x, y }, data: { type, label: id, ...data }, class: 'w-[150px]' });
const E = (s, t, th, sh) => ({ id: 'e-' + s + (sh ? '.' + sh : '') + '-' + t + (th ? '.' + th : ''), source: s, ...(sh ? { sourceHandle: sh } : {}), target: t, ...(th ? { targetHandle: th } : {}) });
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const p = A.page;

	await p.locator('p[title="Node editor (N)"]').click();
	await p.waitForTimeout(1500);

	// --- 6. the Switcher multiplexer ----------------------------------------------------
	const MUX = {
		scene: {
			nodes: [
				N('v0', 'number', 0, 0, { value: 10 }),
				N('v1', 'number', 0, 110, { value: 20 }),
				N('v2', 'number', 0, 220, { value: 30 }),
				N('ix', 'number', 0, 360, { value: 2 }),
				N('s', 'switcher', 300, 60, { items: ['low', 'mid', 'high'], index: 0, shape: 'low' }),
				N('sum', 'math', 600, 60, { op: 'add', b: 0 }),
				N('idx', 'math', 600, 300, { op: 'add', b: 0 })
			],
			edges: [E('v0', 's', 'in0'), E('v1', 's', 'in1'), E('v2', 's', 'in2'), E('s', 'sum', 'a', 'value'), E('s', 'idx', 'a')]
		}
	};
	await p.evaluate((doc) => window.__stores.restoreGraphs(JSON.parse(JSON.stringify(doc))), MUX);
	await p.evaluate((id) => window.__stores.nodesHandler.sendNodes(id), B.id);
	await p.waitForTimeout(900);
	h.check((await p.locator(handle('s', 'in2')).count()) === 1 && (await p.locator(handle('s', 'value')).count()) === 1, 'the Switcher draws one input socket per item and a value output');
	await h.eventually(() => value(p, 'sum'), (v) => v === 10, 'the multiplexer passes item 0\'s input (10)');
	await p.locator(card('s') + ' input[type="radio"][value="mid"]').check();
	await h.eventually(() => value(p, 'sum'), (v) => v === 20, 'picking "mid" on the card passes item 1 (20)');
	await h.eventually(() => value(p, 'idx'), (v) => v === 1, 'the unnamed output is still the index (1)');
	await h.eventually(() => value(B.page, 'sum'), (v) => v === 20, 'the peer multiplexes the same item (20)');
	await wire(p, handle('ix', null), handle('s', 'index'));
	await h.eventually(() => value(p, 'sum'), (v) => v === 30, 'a WIRED index (2) overrides the radio (30)');
	h.check(await p.locator(card('s') + ' input[type="radio"][value="mid"]').isDisabled(), 'and the radio stands down while the index is wired');
	await p.screenshot({ path: OUT + '03-switcher-mux.png' });
	// remove item 0 from the ⓘ panel: the wires stay on their values
	await select(p, ['s']);
	if (!(await p.locator('#flow-props').isVisible().catch(() => false))) await p.locator('#flow-props-toggle').click();
	await p.locator('#flow-tab-info').click();
	await p.waitForTimeout(300);
	await p.locator('#flow-props button[title="Remove item"]').first().click();
	await p.waitForTimeout(700);
	g = await graph(p);
	const sw = g.nodes.find((n) => n.id === 's');
	h.check(JSON.stringify(sw.data.items) === '["mid","high"]', 'the ⓘ ✕ removes item 0');
	h.check(into(g, 's') === 'ix>index v1>in0 v2>in1', `its socket goes and the wires after it move down (${into(g, 's')})`);
	await h.eventually(() => value(p, 'sum'), (v) => v === 30, 'the wired index 2 clamps to the last item, still 30');
	await p.evaluate(() => window.__stores.nodesHandler.setNodeData('ix', { value: 0 }));
	await h.eventually(() => value(p, 'sum'), (v) => v === 20, 'index 0 is now "mid" (20)');
	await h.eventually(() => graph(B.page), (gb) => into(gb, 's') === 'ix>index v1>in0 v2>in1', 'the peer gets the moved wires');
	// a type change drops the wires the new type refuses, in one undo step
	const removed = await p.evaluate(() => window.__stores.variadic.setSwitcherType('s', 'object'));
	g = await graph(p);
	h.check(removed === 3 && into(g, 's') === 'ix>index' && !g.edges.some((e) => e.source === 's' && e.sourceHandle === 'value'), `"object" refuses the number wires and the value->math wire (${removed} removed)`);
	h.check(g.edges.some((e) => e.source === 's' && !e.sourceHandle && e.target === 'idx'), 'the unnamed index wire stays (it is always a number)');
	await focusNodes(p);
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(700);
	g = await graph(p);
	h.check(g.nodes.find((n) => n.id === 's').data.vtype !== 'object' && into(g, 's') === 'ix>index v1>in0 v2>in1', 'one undo restores the type and every wire');
	await h.eventually(() => value(p, 'sum'), (v) => v === 20, 'and the multiplexed value (20)');

	await h.finish(browser);
});
