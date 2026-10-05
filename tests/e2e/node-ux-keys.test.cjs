// 36 U11 + I3: the node editor's keymap is SCOPED — a key fires in the panel that has focus
// (the last pointer press). Every node-editor shortcut has a check here, plus the C fix
// (chat only from the viewport), the fly keys standing down in the node editor, and the `?`
// cheat sheet generated from the registry.
//
// Counterfactuals (each guard was broken by hand once and the named check went red):
//   · keyScope.pickForScope returning the first matching row → "C in the node editor" red
//   · editorNavigation without its viewportHasKeys gate → "A in the node editor flies" red
//   · Nodes.svelte without installNodeActions → every per-shortcut check red
const h = require('./helpers.cjs');

/** @param {any} page */
const graph = (page) =>
	page.evaluate(() => {
		let ns;
		let es;
		window.__stores.flowNodes.subscribe((v) => (ns = v))();
		window.__stores.flowEdges.subscribe((v) => (es = v))();
		return {
			nodes: ns.map((n) => ({ id: n.id, type: n.type, x: n.position.x, y: n.position.y, sel: !!n.selected, data: n.data })),
			edges: es.map((e) => ({ id: e.id, source: e.source, target: e.target, targetHandle: e.targetHandle ?? null }))
		};
	});
/** @param {any} page @param {string[]} ids */
const select = (page, ids) =>
	page.evaluate((ids) => {
		window.__stores.flowNodes.update((ns) => ns.map((n) => ({ ...n, selected: ids.includes(n.id) })));
	}, ids);
const read = (page, store) => page.evaluate((s) => new Promise((r) => window.__stores[s].subscribe((v) => r(v))()), store);
/** a real press on an EMPTY spot of the node pane (gives the node editor the keyboard) */
async function focusNodes(page) {
	const pane = await page.locator('.svelteFlow .svelte-flow__pane').boundingBox();
	await page.mouse.click(pane.x + 30, pane.y + 30);
	await page.waitForTimeout(150);
}
/** a real press on the 3D viewport, well clear of the dock and the chrome */
async function focusViewport(page) {
	const box = await page.locator('canvas').last().boundingBox();
	await page.mouse.click(box.x + box.width * 0.15, box.y + 140);
	await page.waitForTimeout(150);
}
const viewportOf = (page) => page.evaluate(() => document.querySelector('.svelte-flow__viewport')?.getAttribute('style') ?? '');
const camPos = (page) =>
	page.evaluate(() => {
		let c;
		window.__stores.globalCamera.subscribe((v) => (c = v))();
		const p = c?.current?.position ?? c?.position;
		return p ? [p.x, p.y, p.z].map((v) => +v.toFixed(3)) : null;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const p = A.page;

	await p.locator('p[title="Node editor (N)"]').click();
	await p.waitForTimeout(800);
	const seed = () =>
		p.evaluate(() => {
			const mk = (id, x, y) => ({ id, type: 'number', position: { x, y }, data: { type: 'number', value: 1, label: id }, class: 'w-[150px]' });
			// n2 is a Math node: it HAS an `a` input, so the n1 -> n2.a wire really draws
			const math = { id: 'n2', type: 'math', position: { x: 260, y: 40 }, data: { type: 'math', op: 'add', label: 'n2' }, class: 'w-[150px]' };
			window.__stores.flowNodes.set([mk('n1', 0, 0), math, mk('n3', 520, 120), mk('n4', 260, 260)]);
			window.__stores.flowEdges.set([{ id: 'e-n1-n2.a', source: 'n1', target: 'n2', targetHandle: 'a' }]);
		});
	await seed();
	await p.waitForTimeout(600);

	// --- 1. scope: the press decides who owns the keyboard --------------------------
	await focusNodes(p);
	h.check((await p.evaluate(() => window.__stores.keyScope.lastScope())) === 'nodes', 'a press on the node pane gives it the keyboard');
	const chat0 = await read(p, 'chatHidden');
	await p.keyboard.press('c');
	await p.waitForTimeout(200);
	h.check((await read(p, 'chatHidden')) === chat0, 'C in the node editor does NOT toggle chat');
	await focusViewport(p);
	h.check((await p.evaluate(() => window.__stores.keyScope.lastScope())) === 'viewport', 'a press on the 3D viewport gives it the keyboard');
	await p.keyboard.press('c');
	await p.waitForTimeout(200);
	h.check((await read(p, 'chatHidden')) !== chat0, 'C in the viewport toggles chat');
	await p.keyboard.press('c'); // put it back
	// a text field never reaches the registry, whichever pane it sits in
	await p.locator('.svelteFlow .svelte-flow__node[data-id="n1"] input').first().click();
	const chat1 = await read(p, 'chatHidden');
	await p.keyboard.press('c');
	await p.waitForTimeout(150);
	h.check((await read(p, 'chatHidden')) === chat1, 'C typed into a node field does not toggle chat');
	await p.keyboard.press('Escape');

	// the viewport's F (focus object) and A (fly left) stand down in the node editor
	await focusNodes(p);
	await p.evaluate(() => {
		const row = window.__stores.shortcutsRegistry.shortcuts.find((s) => s.id === 'camera.focus');
		window.__focusCalls = 0;
		row.__orig = row.action;
		row.action = () => window.__focusCalls++;
	});
	await p.keyboard.press('f');
	await p.waitForTimeout(200);
	h.check((await p.evaluate(() => window.__focusCalls)) === 0, 'F in the node editor does not focus the 3D object');
	const cam0 = await camPos(p);
	await p.keyboard.down('a');
	await p.waitForTimeout(400);
	await p.keyboard.up('a');
	const cam1 = await camPos(p);
	h.check(cam0 && JSON.stringify(cam0) === JSON.stringify(cam1), `A in the node editor does not fly the camera (${JSON.stringify(cam0)} -> ${JSON.stringify(cam1)})`);
	await focusViewport(p);
	await p.keyboard.press('f');
	await p.waitForTimeout(200);
	h.check((await p.evaluate(() => window.__focusCalls)) === 1, 'F in the viewport still focuses the object');
	await p.evaluate(() => {
		const row = window.__stores.shortcutsRegistry.shortcuts.find((s) => s.id === 'camera.focus');
		row.action = row.__orig;
	});

	// --- 2. framing: F (selection), A and Home (all) — the pane's viewport moves --------
	await focusNodes(p);
	await p.evaluate(() => window.__flowViewport?.setViewport({ x: 900, y: 600, zoom: 0.5 }));
	await p.waitForTimeout(200);
	await select(p, ['n3']);
	let v0 = await viewportOf(p);
	await p.keyboard.press('f');
	await p.waitForTimeout(500);
	h.check((await viewportOf(p)) !== v0, 'F frames the selected node');
	const n3 = await p.locator('.svelte-flow__node[data-id="n3"]').boundingBox();
	const paneBox = await p.locator('.svelteFlow .svelte-flow__pane').boundingBox();
	h.check(
		n3 && n3.x > paneBox.x && n3.x + n3.width < paneBox.x + paneBox.width && n3.y > paneBox.y && n3.y + n3.height < paneBox.y + paneBox.height - 90,
		'the framed node lands inside the pane, clear of the minimap strip'
	);
	for (const key of ['a', 'Home']) {
		await p.evaluate(() => window.__flowViewport?.setViewport({ x: 900, y: 600, zoom: 0.5 }));
		await p.waitForTimeout(150);
		v0 = await viewportOf(p);
		await p.keyboard.press(key);
		await p.waitForTimeout(500);
		h.check((await viewportOf(p)) !== v0, `${key} frames all nodes`);
	}

	// --- 3. selection + clipboard -------------------------------------------------------
	await select(p, []);
	await p.keyboard.press('Control+a');
	await p.waitForTimeout(200);
	h.check((await graph(p)).nodes.every((n) => n.sel), 'Ctrl+A selects every node');

	await select(p, ['n1', 'n2']);
	await p.keyboard.press('Control+d');
	await p.waitForTimeout(400);
	let g = await graph(p);
	const copies = g.nodes.filter((n) => !['n1', 'n2', 'n3', 'n4'].includes(n.id));
	h.check(copies.length === 2, `Ctrl+D duplicates the selection (${copies.length})`);
	h.check(
		g.edges.some((e) => copies.some((c) => c.id === e.source) && copies.some((c) => c.id === e.target)),
		'the wire BETWEEN the duplicated nodes is duplicated too'
	);
	h.check(copies.every((c) => c.sel) && !g.nodes.find((n) => n.id === 'n1').sel, 'the copies become the selection');
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(400);
	h.check((await graph(p)).nodes.length === 4, 'Ctrl+Z undoes the duplicate');
	await p.keyboard.press('Control+y');
	await p.waitForTimeout(400);
	h.check((await graph(p)).nodes.length === 6, 'Ctrl+Y redoes it');
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(400);

	await select(p, ['n4']);
	await p.keyboard.press('Control+c');
	await p.waitForTimeout(150);
	const paneB = await p.locator('.svelteFlow .svelte-flow__pane').boundingBox();
	await p.mouse.move(paneB.x + paneB.width - 300, paneB.y + 60);
	await p.keyboard.press('Control+v');
	await p.waitForTimeout(400);
	g = await graph(p);
	h.check(g.nodes.length === 5, `Ctrl+V pastes (${g.nodes.length} nodes)`);
	const pasted = g.nodes.find((n) => !['n1', 'n2', 'n3', 'n4'].includes(n.id));
	h.check(pasted && pasted.data.value === 1, 'the pasted node keeps its data');
	await select(p, [pasted.id]);
	await p.keyboard.press('Control+x');
	await p.waitForTimeout(300);
	h.check((await graph(p)).nodes.length === 4, 'Ctrl+X cuts');

	// --- 4. delete: Delete / X / Backspace, never the 3D objects -------------------------
	for (const key of ['Delete', 'x', 'Backspace']) {
		await p.evaluate(() => window.__stores.flowNodes.update((ns) => [...ns, { id: 'tmp', type: 'number', position: { x: 0, y: 400 }, data: { type: 'number', value: 2 }, class: 'w-[150px]' }]));
		await p.waitForTimeout(200);
		await select(p, ['tmp']);
		await p.keyboard.press(key);
		await p.waitForTimeout(300);
		h.check(!(await graph(p)).nodes.some((n) => n.id === 'tmp'), `${key} deletes the selected node`);
	}
	await select(p, ['n2']);
	await p.keyboard.press('Delete');
	await p.waitForTimeout(300);
	g = await graph(p);
	h.check(!g.nodes.some((n) => n.id === 'n2') && !g.edges.some((e) => e.target === 'n2'), 'deleting a node takes its wires');
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(400);
	g = await graph(p);
	h.check(g.nodes.some((n) => n.id === 'n2') && g.edges.some((e) => e.id === 'e-n1-n2.a'), 'undo brings the node AND its wire back');

	// --- 5. add at cursor: Shift+A and Space open the node search at the pointer ---------
	for (const key of ['Shift+A', 'Space']) {
		await p.mouse.move(paneB.x + 200, paneB.y + 120);
		await p.keyboard.press(key);
		await p.waitForTimeout(400);
		const menu = await p.evaluate(() => {
			const m = document.querySelector('[role="menu"]');
			const input = m?.querySelector('input');
			return { open: !!m, focused: document.activeElement === input };
		});
		h.check(menu.open, `${key} opens the add-node menu at the cursor`);
		await p.keyboard.type('number');
		await p.waitForTimeout(200);
		await p.keyboard.press('Enter');
		await p.waitForTimeout(400);
	}
	g = await graph(p);
	h.check(g.nodes.length === 6, `searching + Enter adds the node (${g.nodes.length})`);

	// --- 6. mute (M) / collapse (H) — data on the node, and the runtime skips a muted node -
	await select(p, ['n1']);
	await p.keyboard.press('m');
	await p.waitForTimeout(300);
	h.check((await graph(p)).nodes.find((n) => n.id === 'n1').data.muted === true, 'M mutes the selected node');
	const live = await p.evaluate(() => {
		const { runtimeGraph, allNodes, allEdges } = window.__stores;
		const r = runtimeGraph(allNodes(), allEdges());
		return { node: r.nodes.some((n) => n.id === 'n1'), edge: r.edges.some((e) => e.source === 'n1') };
	});
	h.check(!live.node && !live.edge, 'the runtime does not evaluate a muted node or its wires');
	h.check(
		await p.evaluate(() => getComputedStyle(document.querySelector('.svelte-flow__node[data-id="n1"] .node-card')).opacity < 0.6),
		'a muted card is drawn faded'
	);
	await p.keyboard.press('m');
	await p.waitForTimeout(300);
	h.check((await graph(p)).nodes.find((n) => n.id === 'n1').data.muted === false, 'M again unmutes');
	const tall0 = (await p.locator('.svelte-flow__node[data-id="n1"]').boundingBox()).height;
	await p.keyboard.press('h');
	await p.waitForTimeout(400);
	const tall1 = (await p.locator('.svelte-flow__node[data-id="n1"]').boundingBox()).height;
	h.check((await graph(p)).nodes.find((n) => n.id === 'n1').data.collapsed === true && tall1 < tall0, `H collapses the card (${tall0} -> ${tall1})`);
	const wire = await p.evaluate(() => {
		const path = document.querySelector('.svelte-flow__edge path.svelte-flow__edge-path');
		const r = path?.getBoundingClientRect();
		return r ? r.width + r.height : 0;
	});
	h.check(wire > 10, `a collapsed card keeps its wires (${wire.toFixed?.(0)})`);
	await p.keyboard.press('h');
	await p.waitForTimeout(300);

	// --- 7. align (Q/E), distribute (Shift+Q/E), nudge (arrows) ---------------------------
	await select(p, ['n1', 'n2', 'n3']);
	await p.keyboard.press('q');
	await p.waitForTimeout(300);
	g = await graph(p);
	const xs = ['n1', 'n2', 'n3'].map((id) => g.nodes.find((n) => n.id === id).x);
	h.check(xs.every((x) => x === xs[0]), `Q aligns the selection into a column (${xs})`);
	await p.keyboard.press('e');
	await p.waitForTimeout(300);
	g = await graph(p);
	const ys = ['n1', 'n2', 'n3'].map((id) => g.nodes.find((n) => n.id === id).y);
	h.check(ys.every((y) => y === ys[0]), `E aligns it into a row (${ys})`);
	await p.keyboard.press('Control+z');
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(400);
	g = await graph(p);
	h.check(g.nodes.find((n) => n.id === 'n3').x === 520 && g.nodes.find((n) => n.id === 'n3').y === 120, 'undo puts aligned nodes back');
	await p.keyboard.press('Shift+E');
	await p.waitForTimeout(300);
	g = await graph(p);
	const sorted = ['n1', 'n2', 'n3'].map((id) => g.nodes.find((n) => n.id === id)).sort((a, b) => a.x - b.x);
	h.check(Math.abs(sorted[1].x - sorted[0].x - (sorted[2].x - sorted[1].x)) <= 2, 'Shift+E distributes evenly left to right');
	await p.keyboard.press('Shift+Q');
	await p.waitForTimeout(300);
	g = await graph(p);
	const sv = ['n1', 'n2', 'n3'].map((id) => g.nodes.find((n) => n.id === id)).sort((a, b) => a.y - b.y);
	h.check(sv[0].y <= sv[1].y && sv[1].y <= sv[2].y, 'Shift+Q distributes top to bottom');
	await select(p, ['n4']);
	const before = (await graph(p)).nodes.find((n) => n.id === 'n4');
	await p.keyboard.press('ArrowRight');
	await p.keyboard.press('ArrowDown');
	await p.keyboard.press('Shift+ArrowLeft');
	await p.waitForTimeout(300);
	const after = (await graph(p)).nodes.find((n) => n.id === 'n4');
	h.check(after.x === before.x + 25 - 125 && after.y === before.y + 25, `arrows nudge by the grid step, Shift ×5 (${before.x},${before.y} -> ${after.x},${after.y})`);

	// --- 8. the cheat sheet: generated from the registry, the focused scope first -------
	await p.keyboard.press('?');
	await p.waitForTimeout(300);
	const sheet = await p.evaluate(() => {
		const titles = [...document.querySelectorAll('#shortcut-sheet section')].map((s) => s.getAttribute('data-scope'));
		const reg = window.__stores.shortcutsRegistry.shortcuts;
		const rows = [...document.querySelectorAll('#shortcut-sheet [data-shortcut-id]')].map((r) => r.getAttribute('data-shortcut-id'));
		return { titles, missing: reg.filter((s) => !rows.includes(s.id)).map((s) => s.id), total: rows.length };
	});
	h.check(sheet.titles[0] === 'nodes', `? opens the sheet with the node editor first (${sheet.titles.join(',')})`);
	h.check(sheet.missing.length === 0 && sheet.total > 60, `the sheet lists every registry row (${sheet.total}; missing ${sheet.missing.join(',') || 'none'})`);
	// generated, not written: a row rebound right now shows its new key on the next open
	await p.keyboard.press('Escape');
	await p.evaluate(() => window.__stores.shortcutsRegistry.setOverride('nodes.mute', 'Alt+M'));
	await p.keyboard.press('?');
	await p.waitForTimeout(300);
	const muteKeys = await p.evaluate(() => document.querySelector('#shortcut-sheet [data-shortcut-id="nodes.mute"] .sheet-keys')?.textContent);
	h.check(muteKeys?.includes('Alt') && muteKeys?.includes('M'), `the sheet follows a rebind (${muteKeys})`);
	await p.locator('#shortcut-sheet-filter').fill('group');
	await p.waitForTimeout(200);
	const filtered = await p.evaluate(() => [...document.querySelectorAll('#shortcut-sheet [data-shortcut-id]')].map((r) => r.textContent.toLowerCase()));
	h.check(filtered.length > 0 && filtered.length < 12 && filtered.every((t) => t.includes('group')), `the filter narrows the sheet (${filtered.length})`);
	await p.keyboard.press('Escape');
	await p.waitForTimeout(200);
	h.check(!(await p.locator('#shortcut-sheet').count()), 'Esc closes the sheet');
	await p.evaluate(() => window.__stores.shortcutsRegistry.resetShortcut('nodes.mute'));
	await focusViewport(p);
	await p.keyboard.press('?');
	await p.waitForTimeout(300);
	h.check((await p.evaluate(() => document.querySelector('#shortcut-sheet section')?.getAttribute('data-scope'))) === 'viewport', 'from the viewport the sheet opens on the viewport scope');
	await p.keyboard.press('Escape');

	await p.screenshot({ path: '/home/deck/.code/lanes-30/after-36/36-node-ux/01-keys-end.png' });
	await h.finish(browser);
});
