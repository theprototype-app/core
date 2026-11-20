// 2.0-n3c (roadmap 2.0 N3c): Convert to code / Convert back for the seven node types that have a
// reference JS (math, compare, gate, select, map range, random, HUD Text), through the real node menu,
// the node sheet and the debug hook, with a second peer, a late joiner, undo/redo and a .tpscene round trip.
//
// Per type: the node becomes a Script value node with the SAME id and the same wires (outgoing ones now
// leave its `out` socket), carrying `convertedFrom`; its value is the built-in's value; the peer holds the
// same node and the nodesync hashes agree; ONE undo puts the built-in back (and redo the script); the late
// joiner gets the same graph and value (Random's seeded number too); a saved .tpscene brings the script back
// still convertible; Convert back returns the built-in with its exact data.
//
// Counterfactuals (broken by hand once, the named check went red):
//   · convertToCode.js without the history batch (each record its own step) -> "ONE undo puts <type> back"
//   · convertCode.js planConvert keeping `sourceHandle` undefined on outgoing edges -> "the downstream
//     Math still reads 13"
//   · reference.js RANDOM_JS hashing `id + 1` -> "the converted Random reads the built-in's seeded value"
const h = require('./helpers.cjs');
const fs = require('fs');

const OUT = '/home/deck/.code/lanes-30/after-2.0/2.0-n3c/';
fs.mkdirSync(OUT, { recursive: true });

const N = (id, type, x, y, data = {}) => ({ id, type, position: { x, y }, data: { type, label: id, ...data }, class: 'w-[150px]' });
const E = (s, t, th, sh) => ({ id: 'e-' + s + (sh ? '.' + sh : '') + '-' + t + (th ? '.' + th : ''), source: s, ...(sh ? { sourceHandle: sh } : {}), target: t, ...(th ? { targetHandle: th } : {}) });

const DOC = {
	scene: {
		nodes: [
			N('n1', 'number', 0, 0, { value: 3 }),
			N('n2', 'number', 0, 180, { value: 4 }),
			N('n3', 'number', 0, 420, { value: 1 }),
			N('m', 'math', 260, 0, { op: 'mul', a: 0, b: 0 }),
			N('mx', 'math', 520, 0, { op: 'add', a: 0, b: 1 }),
			N('c', 'compare', 780, 0, { op: 'lt', a: 0, b: 0 }),
			N('g', 'gate', 1040, 0, { op: 'and', a: false, b: true }),
			N('s', 'select', 260, 420, { index: 0, a: 10, b: 20 }),
			N('r', 'maprange', 520, 420, { inMin: 0, inMax: 10, outMin: 0, outMax: 1, clamp: true, a: 0 }),
			N('rnd', 'random', 780, 420, { min: 0, max: 10, interval: 0, seed: 7, integer: false }),
			N('ht', 'hudtext', 1040, 420, { element: 'score', format: 'Score {v}', decimals: 0, value: 0 })
		],
		edges: [E('n1', 'm', 'a'), E('n2', 'm', 'b'), E('m', 'mx', 'a'), E('n1', 'c', 'a'), E('n2', 'c', 'b'), E('c', 'g', 'a'), E('n3', 's', 'index'), E('n1', 'r', 'a'), E('n1', 'ht', 'value')]
	}
};
// how each one is converted: the real node menu, the node sheet's button, or the hook (agent / script path)
const TYPES = [
	{ id: 'm', type: 'math', via: 'menu' },
	{ id: 'c', type: 'compare', via: 'sheet' },
	{ id: 'g', type: 'gate', via: 'hook' },
	{ id: 's', type: 'select', via: 'hook' },
	{ id: 'r', type: 'maprange', via: 'hook' },
	{ id: 'rnd', type: 'random', via: 'hook' },
	{ id: 'ht', type: 'hudtext', via: 'hook' }
];

const graph = (page) =>
	page.evaluate(() => {
		let ns;
		let es;
		window.__tp.test.v1.flowNodes.subscribe((v) => (ns = v))();
		window.__tp.test.v1.flowEdges.subscribe((v) => (es = v))();
		return {
			nodes: ns.map((n) => ({ id: n.id, type: n.type, data: JSON.parse(JSON.stringify(n.data ?? {})) })),
			edges: es.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? null, target: e.target, targetHandle: e.targetHandle ?? null }))
		};
	});
const hash = (page) => page.evaluate(() => window.__tp.test.v1.nodesHandler.graphHash());
/** both pages' hashes, read together (eventually's predicate is synchronous) */
const hashes = async (a, b) => [await hash(a), await hash(b)];
const agree = (/** @type {any[]} */ [x, y]) => x === y;
/** a node's reading, a script's handle map folded to its first output, booleans as 0/1 */
const value = (page, id) =>
	page.evaluate((id) => {
		let v;
		window.__tp.test.v1.flowValues.subscribe((x) => (v = x))();
		let r = v[id];
		if (r && typeof r === 'object' && r.__handles) r = r.__default;
		return typeof r === 'boolean' ? +r : r;
	}, id);
const hudText = (page, el) =>
	page.evaluate((el) => {
		let v;
		window.__tp.test.v1.hudDocs.hudRuntime.subscribe((x) => (v = x))();
		return v?.[el]?.text ?? null;
	}, el);
const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : JSON.stringify(a) === JSON.stringify(b));
const card = (id) => `.svelteFlow .svelte-flow__node[data-id="${id}"]`;
/** select one node the way the editor's selection does (a click can land on a neighbour card that grew) */
async function selectNode(page, id) {
	await page.evaluate((id) => window.__tp.test.v1.flowNodes.update((ns) => ns.map((n) => ({ ...n, selected: n.id === id }))), id);
	await page.waitForTimeout(400);
}
const scriptFor = (g, hudId) => g.nodes.find((n) => n.type === 'script' && n.data.convertedFrom?.target === hudId);
const touching = (g, id) => g.edges.filter((e) => e.source === id || e.target === id).length;
async function focusNodes(page) {
	const pane = await page.locator('.svelteFlow .svelte-flow__pane').boundingBox();
	await page.mouse.click(pane.x + pane.width - 40, pane.y + 30);
	await page.waitForTimeout(150);
}
const convertHook = (page, id, back = false) =>
	page.evaluate(([id, back]) => window.__tp.test.v1.convertToCode.convertNode(id, { back, newId: () => id + '-code' }), [id, back]);
async function convertMenu(page, id, label) {
	const item = page.locator('[role="menu"] [role="menuitem"]').filter({ hasText: label }).first();
	for (let attempt = 0; attempt < 3; attempt++) {
		await page.locator(card(id)).scrollIntoViewIfNeeded().catch(() => {});
		const box = await page.locator(card(id)).boundingBox();
		// the card's title strip: below a toolbar row, never on an input
		await page.mouse.click(box.x + box.width / 2, box.y + Math.min(10, box.height / 4), { button: 'right' });
		if (await item.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) {
			await item.click();
			await page.waitForTimeout(500);
			return;
		}
		await page.keyboard.press('Escape');
		await page.waitForTimeout(400);
	}
	await page.screenshot({ path: OUT + 'convert-menu-missing-' + id + '.png' });
	h.check(false, `the node menu of ${id} offers "${label}"`);
}
async function convertSheet(page, id) {
	await selectNode(page, id);
	if (!(await page.locator('#flow-props').isVisible().catch(() => false))) await page.locator('#flow-props-toggle, [aria-label="Show node properties"]').first().click().catch(() => {});
	await page.locator('#flow-tab-info').click();
	await page.locator('#flow-node-convert').click();
	await page.waitForTimeout(500);
}
/** every reading the suite compares, in one call */
const readings = async (page) => {
	const out = {};
	for (const id of ['m', 'mx', 'c', 'g', 's', 'r', 'rnd']) out[id] = await value(page, id);
	out.score = await hudText(page, 'score');
	return out;
};

h.run(async () => {
	const browser = await h.launch();
	const storage = { flowPropsOpen: 'true', flowPropsTab: 'info' };
	const A = await h.setupPage(browser, 'A', { storage, context: { viewport: { width: 1600, height: 1100 } } });
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const p = A.page;

	// --- 1. the built-ins and their readings ------------------------------------------------
	await p.evaluate((doc) => window.__tp.test.v1.restoreGraphs(JSON.parse(JSON.stringify(doc))), DOC);
	await p.locator('p[title="Node editor (N)"]').click();
	await p.waitForTimeout(1500);
	await p.evaluate((id) => window.__tp.test.v1.nodesHandler.sendNodes(id), B.id);
	await h.eventually(() => graph(B.page), (g) => g.nodes.length === DOC.scene.nodes.length, 'the peer holds the graph');
	await h.eventually(() => readings(p), (r) => r.m === 12 && r.mx === 13 && r.c === 1 && r.g === 1 && r.s === 20 && Math.abs(r.r - 0.3) < 1e-9 && typeof r.rnd === 'number' && r.score === 'Score 3', 'the built-ins read m 12, mx 13, c 1, g 1, s 20, r 0.3, Score 3');
	const baseline = await readings(p);
	console.log('baseline readings', JSON.stringify(baseline));
	const before = await graph(p);

	// --- 2. convert each type; undo; redo; the peer follows ----------------------------------
	for (const t of TYPES) {
		console.log(`\n=== ${t.type} (${t.via}) ===`);
		const edgesBefore = touching(before, t.id);
		if (t.via === 'menu') await convertMenu(p, t.id, 'Convert to code');
		else if (t.via === 'sheet') await convertSheet(p, t.id);
		else {
			const res = await convertHook(p, t.id);
			h.check(res?.ok === true, `${t.type}: convertNode answers ok (${JSON.stringify(res)})`);
		}
		let g = await graph(p);
		const node = g.nodes.find((n) => n.id === t.id);
		if (t.type === 'hudtext') {
			const sc = scriptFor(g, 'ht');
			h.check(node?.type === 'hudtext' && !!sc, `hudtext: the HUD Text stays and a Script computes its text (${sc?.id})`);
			h.check(sc?.data.convertedFrom?.type === 'hudtext' && /convertedFrom: hudtext/.test(sc?.data.code ?? ''), 'hudtext: the script carries the convertedFrom marker in its data and its code');
			h.check(g.edges.some((e) => e.source === sc?.id && e.sourceHandle === 'text' && e.target === 'ht' && e.targetHandle === 'format') && g.edges.some((e) => e.source === 'n1' && e.target === sc?.id && e.targetHandle === 'value'), 'hudtext: n1 now feeds the script, the script\'s text feeds the HUD Text');
		} else {
			h.check(node?.type === 'script' && node.data.convertedFrom?.type === t.type, `${t.type}: the node is a Script with convertedFrom ${t.type} (same id ${t.id})`);
			h.check(/convertedFrom: /.test(node?.data.code ?? ''), `${t.type}: the code carries the convertedFrom marker`);
			h.check(touching(g, t.id) === edgesBefore, `${t.type}: every wire is kept (${touching(g, t.id)}/${edgesBefore})`);
			h.check(g.edges.filter((e) => e.source === t.id).every((e) => e.sourceHandle === 'out'), `${t.type}: outgoing wires leave its out socket`);
		}
		await h.eventually(() => readings(p), (r) => Object.keys(baseline).every((k) => same(r[k], baseline[k])), `${t.type}: every reading is unchanged after Convert (${t.id})`, 15000);
		if (t.id === 'm') h.check(same(await value(p, 'mx'), 13), 'the downstream Math still reads 13');
		if (t.id === 'rnd') h.check(same(await value(p, 'rnd'), baseline.rnd), `the converted Random reads the built-in's seeded value (${baseline.rnd})`);
		const ha = await hash(p);
		await h.eventually(() => hash(B.page), (hb) => hb === ha, `${t.type}: the peer's nodesync hash agrees`);
		await h.eventually(() => readings(B.page), (r) => Object.keys(baseline).every((k) => same(r[k], baseline[k])), `${t.type}: the peer evaluates the same readings`, 15000);

		await focusNodes(p);
		await p.keyboard.press('Control+z');
		await p.waitForTimeout(700);
		g = await graph(p);
		const undone = t.type === 'hudtext' ? !scriptFor(g, 'ht') && touching(g, 'ht') === edgesBefore : g.nodes.find((n) => n.id === t.id)?.type === t.type && touching(g, t.id) === edgesBefore;
		h.check(undone, `ONE undo puts ${t.type} back with its wires`);
		await h.eventually(() => hashes(p, B.page), agree, `${t.type}: the peer follows the undo`);
		await p.keyboard.press('Control+Shift+z');
		await p.waitForTimeout(700);
		g = await graph(p);
		const redone = t.type === 'hudtext' ? !!scriptFor(g, 'ht') : g.nodes.find((n) => n.id === t.id)?.type === 'script';
		h.check(redone, `redo converts ${t.type} again`);
		await h.eventually(() => hashes(p, B.page), agree, `${t.type}: the peer follows the redo`);
	}
	await p.screenshot({ path: OUT + 'convert-01-all-seven.png' });
	const converted = await graph(p);
	h.check(converted.nodes.filter((n) => n.type === 'script').length === 7, 'seven Script nodes after converting all seven');
	h.check((await p.evaluate(() => [...document.querySelectorAll('.svelteFlow .svelte-flow__node')].map((n) => n.textContent).join(' '))).match(/\p{Extended_Pictographic}/u) === null, 'no emoji on any card');

	// --- 3. a late joiner ---------------------------------------------------------------------
	console.log('\n=== late joiner ===');
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	const hc = await hash(p);
	await h.eventually(() => hash(C.page), (x) => x === hc, 'the late joiner holds the same graph (nodesync hash)', 30000);
	await h.eventually(() => readings(C.page), (r) => Object.keys(baseline).every((k) => same(r[k], baseline[k])), 'the late joiner reads every value, the seeded Random included', 20000);
	await h.closePeer(C);

	// --- 4. a .tpscene round trip keeps the scripts and their convert-back -------------------
	console.log('\n=== .tpscene round trip ===');
	const trip = await p.evaluate(async () => {
		const t = window.__tp.test.v1;
		const payload = JSON.parse(JSON.stringify(t.sessions.buildSessionPayload('n3c convert')));
		t.restoreGraphs({ scene: { nodes: [], edges: [] } });
		await new Promise((r) => setTimeout(r, 300));
		await t.sessions.applySession(payload, { backup: false });
		await new Promise((r) => setTimeout(r, 1500));
		const scripts = (payload.graphs.scene?.nodes ?? []).filter((n) => n.type === 'script');
		return { minor: payload.formatMinor, scripts: scripts.length, marked: scripts.every((n) => n.data.convertedFrom), hasDefs: 'nodeDefs' in payload };
	});
	h.check(trip.minor === 3 && trip.scripts === 7 && trip.marked, `the file is formatMinor 3 and carries 7 marked scripts (${JSON.stringify(trip)})`);
	h.check(trip.hasDefs === false, 'a scene without custom nodes writes no nodeDefs key (byte-identical)');
	await h.eventually(() => readings(p), (r) => Object.keys(baseline).every((k) => same(r[k], baseline[k])), 'after the load every reading is the same', 15000);
	const loaded = await graph(p);
	h.check(JSON.stringify(loaded.nodes.map((n) => [n.id, n.type]).sort()) === JSON.stringify(converted.nodes.map((n) => [n.id, n.type]).sort()), 'the loaded graph holds the same nodes');
	await h.eventually(() => hashes(p, B.page), agree, 'the peer converges on the loaded graph');

	// --- 5. Convert back each one ---------------------------------------------------------------
	for (const t of TYPES) {
		const target = t.type === 'hudtext' ? scriptFor(await graph(p), 'ht')?.id : t.id;
		if (t.via === 'menu') await convertMenu(p, target, 'Convert back');
		else if (t.via === 'sheet') {
			await selectNode(p, target);
			await p.waitForTimeout(300);
			await p.locator('#flow-tab-info').click();
			h.check((await p.locator('#flow-node-convert').getAttribute('data-conversion')) === 'back', `${t.type}: the sheet offers Convert back`);
			await p.locator('#flow-node-convert').click();
			await p.waitForTimeout(500);
		} else h.check((await convertHook(p, target, true))?.ok === true, `${t.type}: convert back answers ok`);
		const g = await graph(p);
		const orig = DOC.scene.nodes.find((n) => n.id === t.id);
		const node = g.nodes.find((n) => n.id === t.id);
		const dataSame = Object.keys(orig.data).every((k) => JSON.stringify(node?.data[k]) === JSON.stringify(orig.data[k]));
		h.check(node?.type === t.type && dataSame, `${t.type}: Convert back returns the built-in with its exact data`);
		h.check(touching(g, t.id) === touching(before, t.id) && (t.type !== 'hudtext' || !scriptFor(g, 'ht')), `${t.type}: and its wires (${touching(g, t.id)})`);
	}
	await h.eventually(() => readings(p), (r) => Object.keys(baseline).every((k) => same(r[k], baseline[k])), 'after Convert back every reading is the same', 15000);
	const back = await graph(p);
	h.check(JSON.stringify(back.edges.map((e) => e.id).sort()) === JSON.stringify(before.edges.map((e) => e.id).sort()), 'the graph is the one we started from (edge ids)');
	await h.eventually(() => hashes(p, B.page), agree, 'the peer agrees after Convert back');
	await focusNodes(p);
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(700);
	h.check(scriptFor(await graph(p), 'ht'), 'undo of Convert back brings the HUD Text script back');
	await p.keyboard.press('Control+Shift+z');
	await p.waitForTimeout(700);

	// --- 6. an edited script cannot go back -----------------------------------------------------
	await convertHook(p, 'm');
	await p.evaluate(() => {
		const t = window.__tp.test.v1;
		let ns;
		t.flowNodes.subscribe((v) => (ns = v))();
		const n = ns.find((x) => x.id === 'm');
		t.nodesHandler.setNodeData('m', { code: n.data.code.replace('return', '// edited\n\treturn') });
	});
	await p.waitForTimeout(400);
	h.check((await convertHook(p, 'm', true))?.ok === false, 'Convert back refuses once the code was edited');
	await selectNode(p, 'm');
	await p.locator('#flow-tab-info').click();
	h.check((await p.locator('#flow-node-convert').getAttribute('data-conversion')) === 'changed' && (await p.locator('#flow-node-convert').isDisabled()), 'and the sheet shows Convert back disabled with the reason');
	await p.screenshot({ path: OUT + 'convert-02-changed.png' });

	await h.closePeer(B);
	await h.finish(browser);
});
