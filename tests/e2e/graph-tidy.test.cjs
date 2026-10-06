// 36 S4 + S8 (36-fb-graphs) — TIDY GRAPH: the node editor's own command, on two peers.
//
// A messy graph (cards on top of each other, a wire running through a card) is tidied from the
// Controls button, the right-click menu and the L key; the result lints clean on the measured
// cards; ONE Ctrl+Z puts every card back and one redo re-applies it; the peer sees the tidy
// (one nodemove per card, no new message type); Shift+L ("fix overlaps and crossings") keeps
// every card that breaks no rule where it was.
//
// The lint itself is proven red first (§1: the messy graph lints dirty on the measured cards).
const h = require('./helpers.cjs');

const N = (id, x, y, type = 'number', data = {}) => ({ id, type, position: { x, y }, data: { type, label: id, ...data }, class: 'w-[150px]' });
const E = (s, t, th = 'a') => ({ id: `e-${s}-${t}.${th}`, source: s, target: t, targetHandle: th });
// a chain whose middle card sits ON the wire from the first to the last, plus a pile-up
const MESSY = {
	scene: {
		nodes: [
			N('src', 0, 0),
			N('m1', 300, 0, 'math', { op: 'add' }),
			N('m2', 300, 30, 'math', { op: 'add' }),
			N('m3', 320, 60, 'math', { op: 'add' }),
			N('sink', 600, 0, 'math', { op: 'add' }),
			N('mid', 300, 300),
			N('far', 900, 600, 'math', { op: 'add' })
		],
		edges: [E('src', 'm1'), E('m1', 'm2'), E('m2', 'm3'), E('m3', 'sink'), E('src', 'far', 'b'), E('mid', 'far', 'a')]
	}
};

const positions = (page) =>
	page.evaluate(() => {
		let g;
		window.__stores.flowGraphs.subscribe((v) => (g = v))();
		return Object.fromEntries(g.scene.nodes.map((n) => [n.id, [Math.round(n.position.x), Math.round(n.position.y)]]));
	});
const lint = (page) => page.evaluate(() => window.__flowTidy.lint());
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const ctx = { context: { viewport: { width: 1600, height: 1000 } }, storage: { flowDockHeight: '760' } };
	const A = await h.setupPage(browser, 'A', ctx);
	const B = await h.setupPage(browser, 'B', ctx);
	await h.connect(B, A);
	const p = A.page;
	await p.evaluate((doc) => window.__stores.restoreGraphs(JSON.parse(JSON.stringify(doc))), MESSY);
	await p.evaluate((id) => window.__stores.nodesHandler.sendNodes(id), B.id);
	await h.eventually(() => positions(B.page), (g) => Object.keys(g).length === 7, 'the peer holds the messy graph');
	await p.locator('p[title="Node editor (N)"]').click();
	await p.waitForTimeout(1500);

	// --- 1. the lint sees the mess on the MEASURED cards --------------------------------------
	const before = await lint(p);
	const pos0 = await positions(p);
	h.check(before.overlaps.length >= 2 && before.wireHits.length >= 1, `the messy graph lints dirty (${before.overlaps.length} overlaps, ${before.wireHits.length} wires through cards)`);

	// --- 2. the Controls button tidies it --------------------------------------------------------
	h.check(await p.locator('#flow-tidy').isVisible(), 'a Tidy graph button sits in the node editor controls');
	await p.locator('#flow-tidy').click();
	await p.waitForTimeout(900);
	const after = await lint(p);
	const pos1 = await positions(p);
	h.check(after.ok, `after Tidy nothing overlaps and no wire crosses a card (${JSON.stringify({ o: after.overlaps.length, w: after.wireHits.length })})`);
	h.check(pos1.src[0] < pos1.m1[0] && pos1.m1[0] < pos1.m2[0] && pos1.m2[0] < pos1.m3[0] && pos1.m3[0] < pos1.sink[0], 'the chain reads left to right');
	const toast = await p.evaluate(() => document.body.innerText.match(/Tidied: \d+ cards? moved[^\n]*/)?.[0] ?? '');
	h.check(/nothing overlaps/.test(toast), `a toast says what changed (${toast})`);

	// --- 3. the peer sees it (S8) -----------------------------------------------------------------
	await h.eventually(() => positions(B.page), (g) => same(g, pos1), 'the peer sees every card where the tidy put it', 8000);

	// --- 4. ONE undo puts it all back, one redo re-applies ---------------------------------------
	await p.locator('.svelteFlow .svelte-flow__pane').click({ position: { x: 20, y: 20 } });
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(700);
	h.check(same(await positions(p), pos0), 'ONE Ctrl+Z puts every card back');
	await h.eventually(() => positions(B.page), (g) => same(g, pos0), 'the undo reaches the peer too', 8000);
	await p.keyboard.press('Control+Shift+z');
	await p.waitForTimeout(700);
	const redo = await positions(p);
	if (!same(redo, pos1)) await p.keyboard.press('Control+y'), await p.waitForTimeout(700);
	h.check(same(await positions(p), pos1), 'one redo re-applies the tidy');

	// --- 5. the L key and the menu ---------------------------------------------------------------
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(600);
	await p.keyboard.press('l');
	await p.waitForTimeout(900);
	h.check(same(await positions(p), pos1), 'L tidies the same way (deterministic)');
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(600);
	const pane = await p.locator('.svelteFlow .svelte-flow__pane').boundingBox();
	await p.mouse.click(pane.x + 30, pane.y + pane.height - 140, { button: 'right' });
	await p.waitForTimeout(400);
	const item = p.locator('[role=menuitem]', { hasText: 'Tidy graph' }).first();
	h.check(await item.isVisible(), 'the pane menu offers Tidy graph');
	await p.keyboard.press('Escape');

	// --- 6. Shift+L keeps what breaks no rule -----------------------------------------------------
	await p.waitForTimeout(300);
	await p.locator('.svelteFlow .svelte-flow__pane').click({ position: { x: 20, y: 20 } });
	await p.keyboard.press('Shift+l');
	await p.waitForTimeout(900);
	const pos2 = await positions(p);
	const kept = ['src', 'sink', 'mid', 'far'].filter((id) => same(pos2[id], pos0[id]));
	h.check((await lint(p)).ok, 'Shift+L leaves the graph clean');
	h.check(kept.length >= 3, `...and keeps the cards that broke no rule where they were (${kept.join(', ')})`);

	await h.finish(browser);
});
