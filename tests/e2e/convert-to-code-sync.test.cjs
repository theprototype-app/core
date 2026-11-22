// 2.0-n3c (planner Q7): Convert to code is netcode, so the two cases a single-author suite cannot see.
//
// 1. UNDO ON THE SECOND PEER: B converts (the convert is B's history step), B undoes and redoes; A follows each
//    step and the nodesync hashes agree after each.
// 2. A STALE SNAPSHOT: A and B hold the built-in; B converts; then a snapshot taken BEFORE the convert reaches B
//    (what a late `nodes` reply from A's older resync looks like). The merge replaces a node whose TYPE changed
//    (QUESTIONS fork 7), so B goes back to the built-in while A holds the script: the peers disagree. nodesync's
//    one-way pull (fewer nodes+edges pulls, equal counts break on peer id) must then bring BOTH to ONE type with
//    equal hashes, whichever side wins. Before the merge fix the puller kept its own type and the hashes never met.
//
// Counterfactual (broken by hand once, the named check went red):
//   · nodesHandler.mergeGraphSnapshot without the type-replace line -> "both peers end on ONE type for m"
const h = require('./helpers.cjs');

const N = (id, type, x, y, data = {}) => ({ id, type, position: { x, y }, data: { type, label: id, ...data }, class: 'w-[150px]' });
const E = (s, t, th) => ({ id: 'e-' + s + '-' + t + (th ? '.' + th : ''), source: s, target: t, ...(th ? { targetHandle: th } : {}) });
const DOC = {
	scene: {
		nodes: [N('n1', 'number', 0, 0, { value: 3 }), N('n2', 'number', 0, 160, { value: 4 }), N('m', 'math', 280, 60, { op: 'mul', a: 0, b: 0 })],
		edges: [E('n1', 'm', 'a'), E('n2', 'm', 'b')]
	}
};

const typeOf = (page, id) =>
	page.evaluate((id) => {
		let ns;
		window.__tp.test.v1.flowNodes.subscribe((v) => (ns = v))();
		return ns.find((n) => n.id === id)?.type ?? null;
	}, id);
const hash = (page) => page.evaluate(() => window.__tp.test.v1.nodesHandler.graphHash());
const state = async (A, B) => ({ a: await typeOf(A.page, 'm'), b: await typeOf(B.page, 'm'), ha: await hash(A.page), hb: await hash(B.page) });
const value = (page, id) =>
	page.evaluate((id) => {
		let v;
		window.__tp.test.v1.flowValues.subscribe((x) => (v = x))();
		const r = v[id];
		return r && typeof r === 'object' && r.__handles ? r.__default : r;
	}, id);
async function focusNodes(page) {
	const pane = await page.locator('.svelteFlow .svelte-flow__pane').boundingBox();
	await page.mouse.click(pane.x + pane.width - 40, pane.y + 30);
	await page.waitForTimeout(150);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await A.page.evaluate((doc) => window.__tp.test.v1.restoreGraphs(JSON.parse(JSON.stringify(doc))), DOC);
	await A.page.evaluate((id) => window.__tp.test.v1.nodesHandler.sendNodes(id), B.id);
	await h.eventually(() => state(A, B), (s) => s.a === 'math' && s.b === 'math' && s.ha === s.hb, 'both peers hold the built-in Math, equal hashes');
	for (const peer of [A, B]) {
		await peer.page.locator('p[title="Node editor (N)"]').click();
		await peer.page.waitForTimeout(1200);
	}

	// --- 1. the convert is B's step: B undoes and redoes it, A follows -------------------------
	console.log('\n=== 1. undo on the second peer ===');
	h.check((await B.page.evaluate(() => window.__tp.test.v1.convertToCode.convertNode('m')))?.ok === true, 'B converts m');
	await h.eventually(() => state(A, B), (s) => s.a === 'script' && s.b === 'script' && s.ha === s.hb, 'A sees B\'s script, equal hashes');
	await h.eventually(() => value(A.page, 'm'), (v) => v === 12, 'and evaluates it (12)', 15000);
	await focusNodes(B.page);
	await B.page.keyboard.press('Control+z');
	await h.eventually(() => state(A, B), (s) => s.a === 'math' && s.b === 'math' && s.ha === s.hb, 'B\'s ONE undo puts the built-in back on both peers, equal hashes');
	await B.page.keyboard.press('Control+Shift+z');
	await h.eventually(() => state(A, B), (s) => s.a === 'script' && s.b === 'script' && s.ha === s.hb, 'B\'s redo converts it again on both peers');
	await focusNodes(A.page);
	await A.page.keyboard.press('Control+z');
	await A.page.waitForTimeout(1200);
	const afterA = await state(A, B);
	h.check(afterA.a === 'script' && afterA.b === 'script' && afterA.ha === afterA.hb, `A's undo does not take back B's convert (${afterA.a}/${afterA.b})`);
	await B.page.evaluate(() => window.__tp.test.v1.convertToCode.convertNode('m', { back: true }));
	await h.eventually(() => state(A, B), (s) => s.a === 'math' && s.b === 'math' && s.ha === s.hb, 'B converts back: both on the built-in again');

	// --- 2. a stale snapshot after a convert ----------------------------------------------------
	console.log('\n=== 2. stale snapshot ===');
	const stale = await A.page.evaluate(() => {
		const t = window.__tp.test.v1;
		return JSON.parse(JSON.stringify(t.flowGraphsCtl.serializeGraphs(t.nodesHandler.serializeNode, t.nodesHandler.serializeEdge)));
	});
	h.check(stale.scene.nodes.find((n) => n.id === 'm')?.type === 'math', 'the stale snapshot holds the built-in');
	await B.page.evaluate(() => window.__tp.test.v1.convertToCode.convertNode('m'));
	await h.eventually(() => state(A, B), (s) => s.a === 'script' && s.b === 'script' && s.ha === s.hb, 'B converts again; A follows');
	// the stale reply lands on B (as A's older `nodes` answer would)
	await B.page.evaluate((stale) => window.__tp.test.v1.nodesHandler.applyNodesSnapshot([], [], stale), stale);
	const split = await state(A, B);
	console.log('after the stale snapshot:', JSON.stringify(split));
	h.check(split.b === 'math' && split.a === 'script' && split.ha !== split.hb, 'the stale snapshot puts B back on the built-in: the peers now disagree (the premise)');
	await h.eventually(() => state(A, B), (s) => s.a === s.b && s.ha === s.hb, 'nodesync heals it: both peers end on ONE type for m with equal hashes', 90000);
	const healed = await state(A, B);
	console.log('healed on:', healed.a);
	await h.eventually(async () => [await value(A.page, 'm'), await value(B.page, 'm')], ([x, y]) => x === 12 && y === 12, 'and both read 12', 20000);

	await h.closePeer(B);
	await h.finish(browser);
});
