// 37 (R6): variadic Math / Gate (typed N inputs, add/remove sockets) and the Switcher as an N-way
// MULTIPLEXER, through the real node editor, undo, N1 groups, a save round trip and a second peer.
//
// Covered: an old two-input Math/Switcher evaluates exactly as before; "+ input" grows sockets you
// can wire with the real mouse; a foldable op folds every wired socket (and a non-folding op greys
// the extras out); "−" removes a socket and MOVES the wires after it (one undo step, replicated);
// Gate AND/OR/XOR over five inputs; a group around a variadic node exposes typed sockets and drops
// the entry of a removed one; copy/paste and save keep the sockets; the multiplexer passes the
// selected item's input, a wired index overrides the radio, removing an item keeps the wires on
// their values, a type change drops the wires the new type refuses; the unnamed output is still
// the index.
//
// Counterfactuals (broken by hand once, the named check went red):
//   · flowRuntime `math` without the fold line            -> "four wired inputs fold to 10"
//   · socketRemovalPlan with no createEdges (wires dropped) -> "removing b moves c and d down"
//   · computeGroupIO without the socketExists filter       -> "the group drops the removed socket"
//   · flowRuntime `switcher` returning the plain index      -> "the multiplexer passes item 1"
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
	await page.mouse.click(pane.x + 20, pane.y + pane.height - 20);
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

	// --- 1. the old two-input shapes evaluate exactly as before ---------------------------
	const DOC = {
		scene: {
			nodes: [
				N('n1', 'number', 0, 0, { value: 1 }),
				N('n2', 'number', 0, 110, { value: 2 }),
				N('n3', 'number', 0, 220, { value: 3 }),
				N('n4', 'number', 0, 330, { value: 4 }),
				N('m', 'math', 300, 60, { op: 'add', a: 0, b: 0 }),
				N('sw0', 'switcher', 300, 420, { items: ['cube', 'pyramid'], index: 1, shape: 'pyramid' }),
				N('m0', 'math', 560, 420, { op: 'add', b: 0 })
			],
			edges: [E('n1', 'm', 'a'), E('n2', 'm', 'b'), E('sw0', 'm0', 'a')]
		}
	};
	await p.evaluate((doc) => window.__stores.restoreGraphs(JSON.parse(JSON.stringify(doc))), DOC);
	await p.locator('p[title="Node editor (N)"]').click();
	await p.waitForTimeout(1500);
	await p.evaluate((id) => window.__stores.nodesHandler.sendNodes(id), B.id);
	await h.eventually(() => graph(B.page), (g) => g.nodes.length === 7, 'the peer holds the graph');
	await h.eventually(() => value(p, 'm'), (v) => v === 3, 'a saved two-input Math still reads a + b (3)');
	await h.eventually(() => value(p, 'm0'), (v) => v === 1, 'a saved Switcher wired by its unnamed output still feeds its INDEX (1)');
	h.check((await value(p, 'sw0')) === 1, 'a Switcher with nothing wired into it is still a plain number (no handle map)');

	// --- 2. "+ input" grows sockets you wire with the real mouse; add folds them -----------
	await p.locator(card('m') + ' .variadic-add').click();
	await p.waitForTimeout(300);
	await p.locator(card('m') + ' .variadic-add').click();
	await p.waitForTimeout(500);
	let g = await graph(p);
	h.check(g.nodes.find((n) => n.id === 'm').data.sockets === 4, '"+ input" twice gives the Math node four sockets');
	h.check((await p.locator(handle('m', 'c')).count()) === 1 && (await p.locator(handle('m', 'd')).count()) === 1, 'the new sockets c and d are drawn as handles');
	await wire(p, handle('n3', null), handle('m', 'c'));
	await wire(p, handle('n4', null), handle('m', 'd'));
	g = await graph(p);
	h.check(into(g, 'm') === 'n1>a n2>b n3>c n4>d', `the real mouse wires into c and d (${into(g, 'm')})`);
	await h.eventually(() => value(p, 'm'), (v) => v === 10, 'four wired inputs fold to 10 (1 + 2 + 3 + 4)');
	await h.eventually(() => graph(B.page), (gb) => gb.nodes.find((n) => n.id === 'm')?.data.sockets === 4 && into(gb, 'm') === 'n1>a n2>b n3>c n4>d', 'the peer gets the sockets and the wires');
	await h.eventually(() => value(B.page, 'm'), (v) => v === 10, 'and evaluates the same fold on its own (10)');
	await p.evaluate(() => window.__stores.nodesHandler.setNodeData('m', { op: 'mul' }));
	await h.eventually(() => value(p, 'm'), (v) => v === 24, 'mul folds too (24)');
	await p.evaluate(() => window.__stores.nodesHandler.setNodeData('m', { op: 'pow' }));
	await h.eventually(() => value(p, 'm'), (v) => v === 1, 'a non-folding op (pow) reads a and b only (1² = 1)');
	h.check((await p.locator(card('m') + ' [data-socket="c"].opacity-50').count()) === 1, 'and the card greys out the sockets it does not read');
	await p.evaluate(() => window.__stores.nodesHandler.setNodeData('m', { op: 'add' }));
	await h.eventually(() => value(p, 'm'), (v) => v === 10, 'back to add (10)');
	await p.screenshot({ path: OUT + '01-math-four-inputs.png' });

	// --- 3. "−" removes a socket and MOVES the wires after it (one undo step) -------------
	await p.locator(card('m') + ' [data-socket="b"] .variadic-remove').click();
	await p.waitForTimeout(600);
	g = await graph(p);
	h.check(g.nodes.find((n) => n.id === 'm').data.sockets === 3, 'removing b leaves three sockets');
	h.check(into(g, 'm') === 'n1>a n3>b n4>c', `removing b moves c and d down one name (${into(g, 'm')})`);
	h.check(g.edges.filter((e) => e.target === 'm').every((e) => e.id === 'e-' + e.source + '-m.' + e.targetHandle), 'the moved wires carry canonical ids (peer dedupe)');
	await h.eventually(() => value(p, 'm'), (v) => v === 8, 'the fold follows the values, not the names (1 + 3 + 4 = 8)');
	await h.eventually(() => graph(B.page), (gb) => gb.nodes.find((n) => n.id === 'm')?.data.sockets === 3 && into(gb, 'm') === 'n1>a n3>b n4>c', 'the removal replicates (sockets + moved wires)');
	await focusNodes(p);
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(700);
	g = await graph(p);
	h.check(g.nodes.find((n) => n.id === 'm').data.sockets === 4 && into(g, 'm') === 'n1>a n2>b n3>c n4>d', `ONE undo puts the socket and every wire back (${into(g, 'm')})`);
	await h.eventually(() => value(p, 'm'), (v) => v === 10, 'and the value with them (10)');
	await h.eventually(() => graph(B.page), (gb) => into(gb, 'm') === 'n1>a n2>b n3>c n4>d', 'the peer follows the undo');
	await p.keyboard.press('Control+Shift+z');
	await p.waitForTimeout(600);
	h.check(into(await graph(p), 'm') === 'n1>a n3>b n4>c', 'redo removes it again');
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(600);

	// --- 4. Gate over five inputs: AND / OR / XOR ------------------------------------------
	const GATE = {
		scene: {
			nodes: [
				...[0, 1, 2, 3, 4].map((i) => N('t' + i, 'toggle', 0, i * 90, { on: i === 0 })),
				N('g', 'gate', 300, 120, { op: 'or', sockets: 5 })
			],
			edges: [0, 1, 2, 3, 4].map((i) => E('t' + i, 'g', 'abcde'[i]))
		}
	};
	await p.evaluate((doc) => window.__stores.restoreGraphs(JSON.parse(JSON.stringify(doc))), GATE);
	await p.evaluate((id) => window.__stores.nodesHandler.sendNodes(id), B.id);
	await p.waitForTimeout(900);
	await h.eventually(() => value(p, 'g'), (v) => v === true, 'OR over five: one true input is enough');
	await p.evaluate(() => window.__stores.nodesHandler.setNodeData('g', { op: 'and' }));
	await h.eventually(() => value(p, 'g'), (v) => v === false, 'AND over five: one true is not');
	await p.evaluate(() => ['t1', 't2', 't3', 't4'].forEach((id) => window.__stores.nodesHandler.setNodeData(id, { on: true })));
	await h.eventually(() => value(p, 'g'), (v) => v === true, 'AND over five: all five true');
	await p.evaluate(() => window.__stores.nodesHandler.setNodeData('g', { op: 'xor' }));
	await h.eventually(() => value(p, 'g'), (v) => v === true, 'XOR over five trues = odd parity = true');
	await p.evaluate(() => window.__stores.nodesHandler.setNodeData('t4', { on: false }));
	await h.eventually(() => value(p, 'g'), (v) => v === false, 'XOR over four trues = false');
	const socketTypes = await p.evaluate(() =>
		['a', 'c', 'e'].map((k) => document.querySelector(`.svelte-flow__handle[data-nodeid="g"][data-handleid="${k}"]`)?.getAttribute('style') ?? '')
	);
	h.check(socketTypes.every((s) => s.includes('#f472b6')), 'every gate socket, the extras included, is painted boolean pink');

	// --- 5. N1 groups: typed sockets, a removed socket's entry goes, ungroup, paste ----------
	await focusNodes(p);
	await select(p, ['g']);
	await p.keyboard.press('Control+g');
	await p.waitForTimeout(700);
	g = await graph(p);
	let G = g.nodes.find((n) => n.type === 'group');
	h.check(G?.data.inputs.length === 5 && G.data.inputs.every((io) => io.type === 'boolean'), `a group around the five-input gate exposes five BOOLEAN sockets (${G?.data.inputs.map((io) => io.type).join(',')})`);
	await h.eventually(() => value(p, 'g'), (v) => v === false, 'grouping changes nothing the gate computes');
	await p.locator(card(G.id) + ' .tp-group-node').dblclick();
	await p.waitForTimeout(800);
	await p.locator(card('g') + ' [data-socket="e"] .variadic-remove').click();
	await p.waitForTimeout(800);
	g = await graph(p);
	G = g.nodes.find((n) => n.type === 'group');
	h.check(g.nodes.find((n) => n.id === 'g').data.sockets === 4 && !g.edges.some((e) => e.target === 'g' && e.targetHandle === 'e'), 'removing e inside the group removes the socket and its wire');
	h.check(G.data.inputs.length === 4 && !G.data.inputs.some((io) => io.key === 'g|e'), `the group drops the removed socket (${G.data.inputs.map((io) => io.key).join(' ')})`);
	await h.eventually(() => graph(B.page), (gb) => gb.nodes.find((n) => n.type === 'group')?.data.inputs.length === 4, 'the peer\'s group follows');
	await p.keyboard.press('Escape');
	await p.waitForTimeout(500);
	await p.screenshot({ path: OUT + '02-gate-group.png' });
	// copy / paste the group: the pasted gate keeps its socket count and its inner shape
	await focusNodes(p);
	await select(p, [G.id]);
	await p.keyboard.press('Control+c');
	const pane = await p.locator('.svelteFlow .svelte-flow__pane').boundingBox();
	await p.mouse.move(pane.x + pane.width - 220, pane.y + pane.height - 160);
	await p.keyboard.press('Control+v');
	await p.waitForTimeout(800);
	g = await graph(p);
	const pasted = g.nodes.filter((n) => n.type === 'gate' && n.id !== 'g');
	h.check(pasted.length === 1 && pasted[0].data.sockets === 4 && pasted[0].data.op === 'xor', 'a pasted group carries the variadic gate with its four sockets');
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(500);
	await select(p, [G.id]);
	await p.keyboard.press('Control+Shift+G');
	await p.waitForTimeout(700);
	g = await graph(p);
	h.check(!g.nodes.some((n) => n.type === 'group') && g.nodes.find((n) => n.id === 'g').data.sockets === 4 && into(g, 'g') === 't0>a t1>b t2>c t3>d', 'ungroup leaves the gate, its four sockets and its wires');
	const rt = await p.evaluate(() => {
		const S = window.__stores;
		const before = S.nodesHandler.graphHash();
		const doc = S.flowGraphsCtl.serializeGraphs(S.nodesHandler.serializeNode, S.nodesHandler.serializeEdge);
		S.restoreGraphs(JSON.parse(JSON.stringify(doc)));
		return { before, after: S.nodesHandler.graphHash(), sockets: doc.scene.nodes.find((n) => n.id === 'g').data.sockets };
	});
	h.check(rt.before === rt.after && rt.sockets === 4, 'the socket count survives a save/load round trip (hash unchanged)');

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
