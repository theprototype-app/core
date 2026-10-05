// 36 U11 / contract N1: NOTES (a title + a markdown description, a colour, optionally a
// FRAME around nodes that carries them) and the node editor's CONTEXT MENUS (canvas / node /
// multi-selection).
//
// Counterfactuals (broken by hand once, the named check went red):
//   · NoteNode rendering the text through {@html} instead of tokens -> "markup in a note stays text"
//   · onNodeDrag without the frame carry -> "dragging a frame carries its nodes"
//   · selectionItems without the Align submenu -> "the multi-selection menu offers Align"
const h = require('./helpers.cjs');

const graph = (page) =>
	page.evaluate(() => {
		let ns;
		let es;
		window.__stores.flowNodes.subscribe((v) => (ns = v))();
		window.__stores.flowEdges.subscribe((v) => (es = v))();
		return {
			nodes: ns.map((n) => ({ id: n.id, type: n.type, x: n.position.x, y: n.position.y, sel: !!n.selected, data: n.data })),
			edges: es.map((e) => ({ id: e.id, source: e.source, target: e.target }))
		};
	});
const select = (page, ids) =>
	page.evaluate((ids) => window.__stores.flowNodes.update((ns) => ns.map((n) => ({ ...n, selected: ids.includes(n.id) }))), ids);
async function focusNodes(page) {
	const pane = await page.locator('.svelteFlow .svelte-flow__pane').boundingBox();
	await page.mouse.click(pane.x + 30, pane.y + 30);
	await page.waitForTimeout(150);
}
const menuLabels = (page) =>
	page.evaluate(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
async function closeMenu(page) {
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
}
const box = (page, id) => page.locator(`.svelteFlow .svelte-flow__node[data-id="${id}"]`).boundingBox();

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const p = A.page;
	await p.locator('p[title="Node editor (N)"]').click();
	await p.waitForTimeout(800);
	await p.evaluate(() => {
		const mk = (id, x, y, type = 'number') => ({ id, type, position: { x, y }, data: { type, value: 1, label: id, ...(type === 'math' ? { op: 'add' } : {}) }, class: 'w-[150px]' });
		window.__stores.flowNodes.set([mk('a', 0, 0), mk('b', 220, 0, 'math'), mk('c', 440, 60), { id: 'sc', type: 'script', position: { x: 0, y: 220 }, data: { type: 'script', label: 'sc', code: 'return 1' }, class: 'w-[150px]' }]);
		window.__stores.flowEdges.set([{ id: 'e-a-b.a', source: 'a', target: 'b', targetHandle: 'a' }]);
	});
	await p.waitForTimeout(600);
	await focusNodes(p);
	await p.keyboard.press('a');
	await p.waitForTimeout(500);

	// --- 1. N adds a note at the cursor, and the properties panel opens on it -----------
	const pane = await p.locator('.svelteFlow .svelte-flow__pane').boundingBox();
	const at = { x: pane.x + pane.width * 0.62, y: pane.y + pane.height * 0.55 };
	await p.mouse.move(at.x, at.y);
	await p.keyboard.press('n');
	await p.waitForTimeout(500);
	let g = await graph(p);
	const note = g.nodes.find((n) => n.type === 'note');
	h.check(!!note && note.data.title === 'Note' && note.sel, 'N adds a selected note');
	const nb = await box(p, note.id);
	h.check(nb && Math.abs(nb.x - at.x) < 30 && Math.abs(nb.y - at.y) < 30, `…at the cursor (${nb && Math.round(nb.x)},${nb && Math.round(nb.y)} vs ${Math.round(at.x)},${Math.round(at.y)})`);
	h.check(await p.locator('#flow-note-title').isVisible(), 'the properties panel opens on the note');

	// --- 2. title + markdown description, rendered on the card -------------------------
	await p.locator('#flow-note-title').fill('Scoring');
	await p.locator('#flow-note-title').press('Enter');
	await p.locator('#flow-note-text').fill('# How it works\nA **bold** step and *more*.\n- first\n- second\n[docs](https://theprototype.app) [bad](javascript:alert(1))\n<img src=x onerror="window.__xss=1">');
	await p.locator('#flow-note-text').blur();
	await p.waitForTimeout(400);
	const card = await p.evaluate((id) => {
		const el = document.querySelector(`.svelte-flow__node[data-id="${id}"]`);
		return {
			title: el?.querySelector('.tp-note-title')?.textContent,
			h1: el?.querySelector('h1')?.textContent,
			bold: el?.querySelector('strong')?.textContent,
			items: el?.querySelectorAll('.tp-note-li').length,
			links: [...(el?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href')),
			img: el?.querySelectorAll('img').length,
			text: el?.textContent ?? ''
		};
	}, note.id);
	h.check(card.title === 'Scoring', 'the title shows on the note');
	h.check(card.h1 === 'How it works' && card.bold === 'bold' && card.items === 2, 'the description renders as markdown (heading, bold, list)');
	h.check(JSON.stringify(card.links) === JSON.stringify(['https://theprototype.app']), `only safe links become links (${JSON.stringify(card.links)})`);
	h.check(card.img === 0 && card.text.includes('<img') && !(await p.evaluate(() => window.__xss)), 'markup in a note stays text (never HTML)');

	// --- 3. colour --------------------------------------------------------------------
	await p.locator('#flow-note-colors [data-color="green"]').click();
	await p.waitForTimeout(300);
	g = await graph(p);
	h.check(g.nodes.find((n) => n.id === note.id).data.color === 'green', 'a colour swatch sets the note colour');
	h.check(await p.evaluate((id) => !!document.querySelector(`.svelte-flow__node[data-id="${id}"] .tp-note-green`), note.id), 'the card wears it');
	await focusNodes(p);
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(300);
	h.check((await graph(p)).nodes.find((n) => n.id === note.id).data.color === 'yellow', 'undo restores the colour');

	// --- 4. notes are never evaluated; a note survives a save round-trip ----------------
	const rt = await p.evaluate((id) => {
		const S = window.__stores;
		const inRuntime = S.runtimeGraph(S.allNodes(), S.allEdges()).nodes.some((n) => n.id === id);
		const before = S.nodesHandler.graphHash();
		const doc = S.flowGraphsCtl.serializeGraphs(S.nodesHandler.serializeNode, S.nodesHandler.serializeEdge);
		S.restoreGraphs(JSON.parse(JSON.stringify(doc)));
		const back = S.allNodes().find((n) => n.id === id);
		return { inRuntime, same: before === S.nodesHandler.graphHash(), title: back?.data?.title, text: back?.data?.text };
	}, note.id);
	h.check(!rt.inRuntime, 'the runtime never evaluates a note');
	h.check(rt.same && rt.title === 'Scoring' && rt.text.startsWith('# How'), 'a note round-trips through a save (hash equal, text intact)');
	await p.waitForTimeout(500);

	// --- 5. Shift+N: a FRAME around the selection, which carries it ----------------------
	await focusNodes(p);
	await p.keyboard.press('a');
	await p.waitForTimeout(400);
	await select(p, ['a', 'b']);
	await p.keyboard.press('Shift+N');
	await p.waitForTimeout(500);
	g = await graph(p);
	const frame = g.nodes.find((n) => n.type === 'note' && Array.isArray(n.data.frame));
	h.check(!!frame && JSON.stringify(frame.data.frame) === JSON.stringify(['a', 'b']), 'Shift+N frames the selection');
	const A0 = g.nodes.find((n) => n.id === 'a');
	const B0 = g.nodes.find((n) => n.id === 'b');
	h.check(frame.x < A0.x && frame.y < A0.y && frame.x + frame.data.w > B0.x + 150, 'the frame encloses its nodes');
	// drag the frame by its title: its nodes come along
	await focusNodes(p);
	await p.keyboard.press('a');
	await p.waitForTimeout(400);
	const fb = await box(p, frame.id);
	await p.mouse.move(fb.x + 40, fb.y + 10);
	await p.mouse.down();
	await p.mouse.move(fb.x + 90, fb.y + 50, { steps: 8 });
	await p.mouse.move(fb.x + 140, fb.y + 70, { steps: 8 });
	await p.mouse.up();
	await p.waitForTimeout(500);
	g = await graph(p);
	const F1 = g.nodes.find((n) => n.id === frame.id);
	const A1 = g.nodes.find((n) => n.id === 'a');
	const B1 = g.nodes.find((n) => n.id === 'b');
	const C1 = g.nodes.find((n) => n.id === 'c');
	const dxF = F1.x - frame.x;
	const dyF = F1.y - frame.y;
	h.check(Math.abs(dxF) > 20, `the frame moved (${dxF},${dyF})`);
	h.check(A1.x - A0.x === dxF && B1.y - B0.y === dyF, 'dragging a frame carries its nodes by the same amount');
	h.check(C1.x === 440 && C1.y === 60, 'a node outside the frame stays put');
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(500);
	g = await graph(p);
	h.check(g.nodes.find((n) => n.id === 'a').x === A0.x && g.nodes.find((n) => n.id === frame.id).x === frame.x, 'ONE undo puts the frame and its nodes back');
	// moving a member refits the frame around it
	await p.evaluate(() => window.__stores.flowNodes.update((ns) => ns.map((n) => ({ ...n, selected: false }))));
	await p.keyboard.press('a');
	await p.waitForTimeout(400);
	const bb = await box(p, 'b');
	await p.mouse.move(bb.x + 40, bb.y + 12);
	await p.mouse.down();
	await p.mouse.move(bb.x + 120, bb.y + 60, { steps: 10 });
	await p.mouse.up();
	await p.waitForTimeout(500);
	g = await graph(p);
	const F2 = g.nodes.find((n) => n.id === frame.id);
	const B2 = g.nodes.find((n) => n.id === 'b');
	h.check(B2.x > B0.x && F2.x + F2.data.w >= B2.x + 150 && F2.y + F2.data.h >= B2.y + 40, 'moving a framed node refits the frame around it');
	// deleting the frame leaves its nodes
	await select(p, [frame.id]);
	await p.keyboard.press('Delete');
	await p.waitForTimeout(400);
	g = await graph(p);
	h.check(!g.nodes.some((n) => n.id === frame.id) && g.nodes.some((n) => n.id === 'a') && g.nodes.some((n) => n.id === 'b'), 'deleting a frame keeps the nodes it framed');
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(400);

	// --- 6. resize a note by its corner (one undoable edit) -----------------------------
	await select(p, [note.id]);
	await p.waitForTimeout(300);
	const handleBox = await p.locator(`.svelte-flow__node[data-id="${note.id}"] .svelte-flow__resize-control.bottom.right, .svelte-flow__node[data-id="${note.id}"] .svelte-flow__resize-control.handle.bottom.right`).first().boundingBox();
	if (handleBox) {
		const w0 = (await graph(p)).nodes.find((n) => n.id === note.id).data.w;
		await p.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
		await p.mouse.down();
		await p.mouse.move(handleBox.x + 60, handleBox.y + 30, { steps: 8 });
		await p.mouse.up();
		await p.waitForTimeout(500);
		const w1 = (await graph(p)).nodes.find((n) => n.id === note.id).data.w;
		h.check(w1 > w0, `dragging the corner resizes the note (${w0} -> ${w1})`);
		await p.keyboard.press('Control+z');
		await p.waitForTimeout(400);
		h.check((await graph(p)).nodes.find((n) => n.id === note.id).data.w === w0, 'undo restores the size');
	} else h.check(false, 'a selected note shows resize handles');

	// --- 7. H collapses a note to its title ---------------------------------------------
	const h0 = (await box(p, note.id)).height;
	await p.keyboard.press('h');
	await p.waitForTimeout(400);
	const h1 = (await box(p, note.id)).height;
	h.check(h1 < h0 && h1 <= 40, `H collapses a note to its title (${Math.round(h0)} -> ${Math.round(h1)})`);
	await p.keyboard.press('h');

	// --- 8. CONTEXT MENUS: canvas / node / multi-selection ------------------------------
	await focusNodes(p);
	await p.mouse.click(pane.x + 60, pane.y + pane.height - 60, { button: 'right' });
	await p.waitForTimeout(300);
	let labels = await menuLabels(p);
	for (const want of ['Search nodes', 'Add note', 'Select all', 'Frame all'])
		h.check(labels.some((l) => l.startsWith(want)), `the canvas menu offers ${want}`);
	h.check(labels.some((l) => l.includes('Shift+A') || l.includes('Shift A')), 'canvas menu rows show their shortcut (from the registry)');
	await p.locator('[role="menu"] [role="menuitem"]', { hasText: /^\s*Add\ note/ }).first().click();
	await p.waitForTimeout(400);
	h.check((await graph(p)).nodes.filter((n) => n.type === 'note').length === 3, 'the canvas menu adds a note');

	const sb = await box(p, 'sc');
	await p.mouse.click(sb.x + 30, sb.y + 12, { button: 'right' });
	await p.waitForTimeout(300);
	labels = await menuLabels(p);
	for (const want of ['Open code', 'Group', 'Add note around', 'Duplicate', 'Copy', 'Cut', 'Mute', 'Collapse', 'Frame', 'Disconnect all', 'Delete node'])
		h.check(labels.some((l) => l.startsWith(want)), `the node menu offers ${want}`);
	h.check((await graph(p)).nodes.find((n) => n.id === 'sc').sel, 'right-clicking a node makes it the selection');
	await p.locator('[role="menu"] [role="menuitem"]', { hasText: /^\s*Open\ code/ }).first().click();
	await p.waitForTimeout(400);
	// alone, node-ux opens the Script panel; with 36-code merged the code workspace (its registered opener) takes it
	const opened = await p.evaluate(() => {
		const s = window.__stores;
		let panel = null;
		s.scriptEditorOpen.subscribe((v) => (panel = v))();
		let tabs = [];
		s.codeWorkspace?.codeTabs?.subscribe?.((v) => (tabs = v))?.();
		return { panel, ws: (tabs ?? []).some((t) => t.nodeId === 'sc') };
	});
	h.check(opened.panel === 'sc' || opened.ws, `Open code opens the script node's code (${JSON.stringify(opened)})`);
	await p.evaluate(() => window.__stores.scriptEditorOpen.set(null));
	if (opened.ws) await p.locator('#code-ws-close').click().catch(() => {});
	await p.waitForTimeout(300);

	await select(p, ['a', 'b', 'c']);
	await p.waitForTimeout(200);
	const cb = await box(p, 'c');
	await closeMenu(p);
	await p.mouse.click(cb.x + 30, cb.y + 12, { button: 'right' });
	await p.waitForTimeout(300);
	labels = await menuLabels(p);
	h.check(labels.some((l) => l.startsWith('Group 3 nodes')) && labels.some((l) => l.startsWith('Delete 3 nodes')), 'the multi-selection menu acts on the whole set');
	h.check(labels.some((l) => l.startsWith('Align')), 'the multi-selection menu offers Align');
	h.check(!labels.some((l) => l.startsWith('Open code')), 'Open code is offered only for a node that has code');
	await p.locator('[role="menu"] [role="menuitem"]', { hasText: /^\s*Align/ }).first().hover();
	await p.waitForTimeout(300);
	await p.locator('[role="menu"] [role="menuitem"]', { hasText: /^\s*Row \(top edges\)/ }).first().click();
	await p.waitForTimeout(400);
	g = await graph(p);
	const ys = ['a', 'b', 'c'].map((id) => g.nodes.find((n) => n.id === id).y);
	h.check(ys.every((y) => y === ys[0]), `Align ▸ Row lines the selection up (${ys})`);
	await closeMenu(p);
	await p.mouse.click(cb.x + 30, cb.y + 12, { button: 'right' });
	await p.waitForTimeout(300);
	await p.locator('[role="menu"] [role="menuitem"]', { hasText: /^\s*Group\ 3\ nodes/ }).first().click();
	await p.waitForTimeout(500);
	g = await graph(p);
	const grp = g.nodes.find((n) => n.type === 'group');
	h.check(!!grp && grp.data.children.length === 3, 'Group from the menu groups the selection');
	await select(p, [grp.id]);
	await closeMenu(p);
	await p.keyboard.press('a'); // frame all: a new card can sit under the scope chip at the pane top
	await p.waitForTimeout(500);
	const gb = await box(p, grp.id);
	await p.mouse.click(gb.x + gb.width / 2, gb.y + gb.height / 2, { button: 'right' });
	await p.waitForTimeout(300);
	labels = await menuLabels(p);
	h.check(labels.some((l) => l.startsWith('Open group')) && labels.some((l) => l.startsWith('Ungroup')), 'a group\'s menu offers Open group and Ungroup');
	await p.locator('[role="menu"] [role="menuitem"]', { hasText: /^\s*Ungroup/ }).first().click();
	await p.waitForTimeout(400);
	h.check(!(await graph(p)).nodes.some((n) => n.type === 'group'), 'Ungroup from the menu ungroups');

	await p.screenshot({ path: '/home/deck/.code/lanes-30/after-36/36-node-ux/03-notes.png' });
	await h.finish(browser);
});
