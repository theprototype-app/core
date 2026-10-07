// 37 (R6): variadic Math / Gate (typed N inputs, add/remove sockets) and the Switcher as an N-way
// MULTIPLEXER, through the real node editor, undo, N1 groups, a save round trip and a second peer.
//
// Covered: an old two-input Math/Switcher evaluates exactly as before; "+ input" grows sockets you
// can wire with the real mouse; a foldable op folds every wired socket (and a non-folding op greys
// the extras out); "−" removes a socket and MOVES the wires after it (one undo step, replicated);
// Gate AND/OR/XOR over five inputs; a group around a variadic node exposes typed sockets and drops
// the entry of a removed one; copy/paste and save keep the sockets. The Switcher multiplexer is
// switcher-mux.test.cjs (one suite ran past the runner's 8-minute cap).
//
// Counterfactuals (broken by hand once, the named check went red):
//   · flowRuntime `math` without the fold line            -> "four wired inputs fold to 10"
//   · socketRemovalPlan with no createEdges (wires dropped) -> "removing b moves c and d down"
//   · computeGroupIO without the socketExists filter       -> "the group drops the removed socket"
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
	// one write per step, each confirmed: a burst of setNodeData writes in one task does not all land
	// (the documented write-chain cost), which read here as "AND over five is still false"
	for (const id of ['t1', 't2', 't3', 't4']) {
		await p.evaluate((id) => window.__stores.nodesHandler.setNodeData(id, { on: true }), id);
		await h.eventually(() => graph(p), (gr) => gr.nodes.find((n) => n.id === id)?.data.on === true, `toggle ${id} is on`);
	}
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

	await h.finish(browser);
});
