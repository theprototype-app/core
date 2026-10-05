// 36 U11 / contract N1: node GROUPS. A group is a VIEW: its members stay in the graph and
// every wire stays a real wire, so the runtime never notices; the editor draws the members
// as one collapsed card whose sockets are the wires crossing its boundary.
//
// Covered: old graphs load unchanged (hash + DOM), Ctrl+G and its IO routing, a wire drawn
// onto a group socket becoming the real inner wire, exposing a socket from inside (＋),
// renaming a socket, enter (double-click / Tab) / leave (Esc / Tab / breadcrumb), nested
// groups, ungroup (Ctrl+Shift+G), copy/paste of a group, undo/redo of all of it, a save
// round-trip, and replication to a second peer.
//
// Counterfactuals (broken by hand once, the named check went red):
//   · graphView returning every node visible  -> "the members are hidden at the top level"
//   · realConnection returning the connection untouched -> "the wire lands on the inner socket"
//   · commitDelete without {contents:false} in ungroup -> "ungroup keeps every member"
const h = require('./helpers.cjs');

const graph = (page) =>
	page.evaluate(() => {
		let ns;
		let es;
		window.__stores.flowNodes.subscribe((v) => (ns = v))();
		window.__stores.flowEdges.subscribe((v) => (es = v))();
		return {
			nodes: ns.map((n) => ({ id: n.id, type: n.type, x: n.position.x, y: n.position.y, data: n.data })),
			edges: es.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? null, target: e.target, targetHandle: e.targetHandle ?? null }))
		};
	});
const select = (page, ids) =>
	page.evaluate((ids) => window.__stores.flowNodes.update((ns) => ns.map((n) => ({ ...n, selected: ids.includes(n.id) }))), ids);
const drawn = (page) =>
	page.evaluate(() => ({
		nodes: [...document.querySelectorAll('.svelteFlow .svelte-flow__node')].map((n) => n.getAttribute('data-id')),
		proxies: document.querySelectorAll('.svelteFlow .svelte-flow__edge.tp-proxy-edge').length,
		edges: document.querySelectorAll('.svelteFlow .svelte-flow__edge').length,
		crumbs: document.querySelector('#flow-group-crumbs')?.textContent?.replace(/\s+/g, ' ').trim() ?? null
	}));
async function focusNodes(page) {
	const pane = await page.locator('.svelteFlow .svelte-flow__pane').boundingBox();
	await page.mouse.click(pane.x + 30, pane.y + 30);
	await page.waitForTimeout(150);
}
/** drag from one handle to another with the real mouse */
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
const handle = (node, id) => `.svelteFlow .svelte-flow__handle[data-nodeid="${node}"]` + (id === null ? ':not([data-handleid])' : `[data-handleid="${id}"]`);
const groupOf = (g) => g.nodes.find((n) => n.type === 'group');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const p = A.page;

	// --- 1. an OLD graph (no groups, no notes) loads exactly as stored -----------------
	const OLD = {
		scene: {
			nodes: [
				{ id: 'src', type: 'number', position: { x: 0, y: 0 }, data: { type: 'number', value: 3, label: 'src' }, class: 'w-[150px]' },
				{ id: 'm1', type: 'math', position: { x: 260, y: 0 }, data: { type: 'math', op: 'add', label: 'm1' }, class: 'w-[150px]' },
				{ id: 'm2', type: 'math', position: { x: 520, y: 0 }, data: { type: 'math', op: 'add', label: 'm2' }, class: 'w-[150px]' },
				{ id: 'sink', type: 'math', position: { x: 780, y: 0 }, data: { type: 'math', op: 'add', label: 'sink' }, class: 'w-[150px]' },
				{ id: 'free', type: 'number', position: { x: 260, y: 240 }, data: { type: 'number', value: 5, label: 'free' }, class: 'w-[150px]' }
			],
			edges: [
				{ id: 'e-src-m1.a', source: 'src', target: 'm1', targetHandle: 'a' },
				{ id: 'e-m1-m2.a', source: 'm1', target: 'm2', targetHandle: 'a' },
				{ id: 'e-m2-sink.a', source: 'm2', target: 'sink', targetHandle: 'a' }
			]
		}
	};
	const hash0 = await p.evaluate((doc) => {
		window.__stores.restoreGraphs(JSON.parse(JSON.stringify(doc)));
		return window.__stores.nodesHandler.graphHash();
	}, OLD);
	await p.locator('p[title="Node editor (N)"]').click();
	await p.waitForTimeout(1200);
	let d = await drawn(p);
	h.check(d.nodes.length === 5 && d.edges === 3 && d.proxies === 0, `an old graph draws every node and wire as stored (${d.nodes.length}/${d.edges})`);
	h.check((await p.evaluate(() => window.__stores.nodesHandler.graphHash())) === hash0, 'opening the editor on an old graph writes nothing (hash unchanged)');
	await p.evaluate((id) => window.__stores.nodesHandler.sendNodes(id), B.id);
	await h.eventually(() => graph(B.page), (g) => g.nodes.length === 5, 'the peer holds the graph');

	// --- 2. Ctrl+G: the members collapse into one card whose sockets are the crossings ----
	await focusNodes(p);
	await select(p, ['m1', 'm2']);
	await p.keyboard.press('Control+g');
	await p.waitForTimeout(600);
	let g = await graph(p);
	let G = groupOf(g);
	h.check(!!G && JSON.stringify(G.data.children) === JSON.stringify(['m1', 'm2']), 'Ctrl+G makes a group holding the selection');
	h.check(G?.data.inputs.length === 1 && G.data.inputs[0].key === 'm1|a' && JSON.stringify(G.data.inputs[0].to) === JSON.stringify(['m1', 'a']), 'the wire INTO the group is its input socket (to: [m1, a])');
	h.check(G?.data.outputs.length === 1 && G.data.outputs[0].key === 'm2|', 'the wire OUT of the group is its output socket');
	h.check(g.edges.length === 3 && g.edges.every((e) => ['e-src-m1.a', 'e-m1-m2.a', 'e-m2-sink.a'].includes(e.id)), 'every real wire is untouched (grouping changes nothing the graph does)');
	d = await drawn(p);
	h.check(!d.nodes.includes('m1') && !d.nodes.includes('m2') && d.nodes.includes(G.id), 'the members are hidden at the top level; the group card stands for them');
	h.check(d.proxies === 2, `the two crossing wires are drawn to the group's sockets (${d.proxies})`);
	const runtime = await p.evaluate(() => {
		const r = window.__stores.runtimeGraph(window.__stores.allNodes(), window.__stores.allEdges());
		return { nodes: r.nodes.map((n) => n.id).sort(), edges: r.edges.length };
	});
	h.check(JSON.stringify(runtime.nodes) === JSON.stringify(['free', 'm1', 'm2', 'sink', 'src']) && runtime.edges === 3, 'the runtime evaluates the same nodes and wires as before (the group is not one of them)');
	await h.eventually(() => graph(B.page), (gb) => !!groupOf(gb) && groupOf(gb).data.children.length === 2, 'the group replicates to the peer');

	// --- 3. enter (double-click), the boundary cards, the breadcrumb; leave (Esc) --------
	await p.locator(`.svelteFlow .svelte-flow__node[data-id="${G.id}"] .tp-group-node`).dblclick();
	await p.waitForTimeout(800);
	d = await drawn(p);
	h.check(d.nodes.includes('m1') && d.nodes.includes('m2') && !d.nodes.includes('src') && !d.nodes.includes(G.id), 'double-click opens the group: only its members are drawn');
	h.check(d.nodes.includes('__group_in') && d.nodes.includes('__group_out'), 'inside, two boundary cards stand for the outside');
	h.check(d.crumbs?.includes('Top') && d.crumbs?.includes('Group'), `a breadcrumb shows where you are (${d.crumbs})`);

	// expose m1.b from inside: drag its input onto "Group inputs ＋"
	const exposed = await wire(p, handle('m1', 'b'), handle('__group_in', 'i|+'));
	g = await graph(p);
	G = groupOf(g);
	h.check(exposed && G.data.inputs.some((i) => i.key === 'm1|b'), 'dragging an inner socket onto ＋ exposes it as a group input');
	await p.keyboard.press('Escape');
	await p.waitForTimeout(600);
	d = await drawn(p);
	h.check(d.crumbs === null && d.nodes.includes(G.id) && !d.nodes.includes('m1'), 'Esc leaves the group');

	// --- 4. a wire drawn onto a group socket is the real wire to the inner socket --------
	await p.keyboard.press('a'); // frame all: leaving framed the group alone, `free` may be off-pane
	await p.waitForTimeout(500);
	await wire(p, handle('free', null), handle(G.id, 'i|m1|b'));
	g = await graph(p);
	h.check(g.edges.some((e) => e.source === 'free' && e.target === 'm1' && e.targetHandle === 'b'), 'a wire dropped on the group socket lands on the inner socket (free -> m1.b)');
	d = await drawn(p);
	h.check(d.proxies === 3, `…and is drawn to the group card (${d.proxies} proxies)`);
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(500);
	h.check(!(await graph(p)).edges.some((e) => e.source === 'free'), 'undo removes that wire');
	await p.keyboard.press('Control+y');
	await p.waitForTimeout(500);
	h.check((await graph(p)).edges.some((e) => e.source === 'free' && e.target === 'm1'), 'redo puts it back');

	// --- 5. rename a socket in the properties panel ------------------------------------
	await select(p, [G.id]);
	await p.waitForTimeout(200);
	if (!(await p.locator('#flow-props').count())) await p.locator('#flow-props-toggle').click();
	await p.locator('#flow-tab-settings').click();
	const firstSocket = p.locator('.group-socket-input[data-list="inputs"]').first();
	await firstSocket.fill('Power');
	await firstSocket.press('Enter');
	await firstSocket.blur();
	await p.waitForTimeout(400);
	h.check(groupOf(await graph(p)).data.inputs[0].name === 'Power', 'a socket can be renamed');
	h.check(await p.locator(`.svelte-flow__node[data-id="${G.id}"]`).getByText('Power').count() > 0, 'the card shows the new socket name');
	await p.locator('#flow-group-name').fill('Adder');
	await p.locator('#flow-group-name').press('Enter');
	await p.waitForTimeout(300);
	h.check(groupOf(await graph(p)).data.label === 'Adder', 'the group can be renamed');
	await focusNodes(p);
	await p.keyboard.press('Control+z');
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(400);
	G = groupOf(await graph(p));
	h.check(G.data.inputs[0].name === 'a' && G.data.label === 'Group', 'undo restores both names');
	// a crossing wire keeps the renamed socket's name across a reconcile
	await p.keyboard.press('Control+y');
	await p.waitForTimeout(400);

	// --- 6. Tab enters / leaves; a NESTED group inside ----------------------------------
	await select(p, [G.id]);
	await p.keyboard.press('Tab');
	await p.waitForTimeout(700);
	h.check((await drawn(p)).nodes.includes('m2'), 'Tab enters the selected group');
	await select(p, ['m2']);
	await p.keyboard.press('Control+g');
	await p.waitForTimeout(600);
	g = await graph(p);
	const inner = g.nodes.find((n) => n.type === 'group' && n.id !== G.id);
	const outer = g.nodes.find((n) => n.id === G.id);
	h.check(!!inner && JSON.stringify(inner.data.children) === JSON.stringify(['m2']), 'grouping inside a group makes a NESTED group');
	h.check(outer.data.children.includes(inner.id) && !outer.data.children.includes('m2'), 'the nested group takes its member\'s place in the outer group');
	h.check(outer.data.outputs.some((o) => o.key === 'm2|'), 'the outer group\'s output still names the DEEP endpoint (m2)');
	await select(p, [inner.id]);
	await p.keyboard.press('Tab');
	await p.waitForTimeout(700);
	d = await drawn(p);
	h.check(d.crumbs && (d.crumbs.match(/⧉/g) ?? []).length === 2, `two levels deep, the breadcrumb shows both (${d.crumbs})`);
	await p.locator('#flow-group-crumbs button', { hasText: 'Top' }).click();
	await p.waitForTimeout(600);
	d = await drawn(p);
	h.check(d.crumbs === null && d.nodes.includes(G.id) && !d.nodes.includes(inner.id), 'the breadcrumb\'s Top goes straight back out');
	h.check(d.proxies >= 2, 'the wires still route to the outer group at the top');

	// --- 7. copy / paste a group (members + inner wires, fresh ids) ---------------------
	await focusNodes(p);
	await select(p, [G.id]);
	await p.keyboard.press('Control+c');
	const pane = await p.locator('.svelteFlow .svelte-flow__pane').boundingBox();
	await p.mouse.move(pane.x + pane.width - 260, pane.y + pane.height - 140);
	await p.keyboard.press('Control+v');
	await p.waitForTimeout(700);
	g = await graph(p);
	const groups = g.nodes.filter((n) => n.type === 'group');
	h.check(groups.length === 4, `pasting a group copies it AND its nested group (${groups.length} groups)`);
	const copyOuter = groups.find((n) => n.id !== G.id && n.id !== inner.id && n.data.children.some((c) => groups.some((x) => x.id === c)));
	h.check(!!copyOuter && !copyOuter.data.children.includes('m1') && copyOuter.data.children.length === 2, 'the copy has its own members (fresh ids)');
	const copyMembers = new Set(copyOuter ? copyOuter.data.children : []);
	h.check(g.edges.some((e) => copyMembers.has(e.source) || copyMembers.has(e.target)), 'the wire between the copied members came along');
	h.check(!g.edges.some((e) => e.source === 'src' && copyMembers.has(e.target)), 'wires from OUTSIDE the copied group did not');
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(500);
	h.check((await graph(p)).nodes.filter((n) => n.type === 'group').length === 2, 'undo removes the pasted group in one step');

	// --- 8. ungroup (Ctrl+Shift+G): members stay where they are ---------------------------
	await select(p, [G.id]);
	await p.keyboard.press('Control+Shift+G');
	await p.waitForTimeout(600);
	g = await graph(p);
	h.check(!g.nodes.some((n) => n.id === G.id) && ['m1', 'src', 'sink', 'free'].every((id) => g.nodes.some((n) => n.id === id)), 'ungroup removes the group and keeps every member');
	h.check(g.nodes.find((n) => n.id === 'm1').x === 260, 'the members did not move');
	d = await drawn(p);
	h.check(d.nodes.includes('m1') && d.nodes.includes(inner.id), 'the former members are drawn at the top again (the nested group with them)');
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(600);
	g = await graph(p);
	h.check(g.nodes.some((n) => n.id === G.id) && !(await drawn(p)).nodes.includes('m1'), 'undo regroups');
	await h.eventually(() => graph(B.page), (gb) => gb.nodes.some((n) => n.id === G.id) && gb.nodes.some((n) => n.id === inner.id), 'the peer follows the ungroup/undo');

	// --- 9. the peer can open it too, and its edits come back ------------------------------
	const pb = B.page;
	await pb.locator('p[title="Node editor (N)"]').click();
	await pb.waitForTimeout(1200);
	const db = await drawn(pb);
	h.check(db.nodes.includes(G.id) && !db.nodes.includes('m1') && db.proxies >= 2, 'the peer draws the group collapsed with its sockets');
	await pb.evaluate((id) => window.__stores.nodesHandler.setNodeData(id, { label: 'From B' }), G.id);
	await h.eventually(() => graph(p), (ga) => groupOf(ga) && ga.nodes.find((n) => n.id === G.id).data.label === 'From B', 'a rename on the peer reaches us');

	// --- 10. a save round-trip keeps the groups byte for byte ----------------------------
	const rt = await p.evaluate(() => {
		const S = window.__stores;
		const before = S.nodesHandler.graphHash();
		const doc = S.flowGraphsCtl.serializeGraphs(S.nodesHandler.serializeNode, S.nodesHandler.serializeEdge);
		S.restoreGraphs(JSON.parse(JSON.stringify(doc)));
		return { before, after: S.nodesHandler.graphHash(), groups: doc.scene.nodes.filter((n) => n.type === 'group').length };
	});
	h.check(rt.before === rt.after && rt.groups === 2, `groups survive a save/load round-trip (hash ${rt.before} == ${rt.after})`);

	await p.screenshot({ path: '/home/deck/.code/lanes-30/after-36/36-node-ux/02-groups.png' });
	await h.finish(browser);
});
