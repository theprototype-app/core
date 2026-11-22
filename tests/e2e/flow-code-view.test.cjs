// 2.0 N1 + N2 — THE NODE REGISTRY IN THE APP, AND THE READ-ONLY CODE VIEW (flag codeView).
//
//   1. registry parity: the palette the app built IS the definitions (148 core types, in family order),
//      and every core type renders its own card (never the "module that isn't installed" card)
//   2. the flag is ON by default (1.71); switched OFF: no Code tab, and the agent's answers carry no `code`
//   3. flag ON: the Code tab opens on each bundled template's scene graph — one line per node, the same
//      text the generator prints; the agent's list_scene {flow} and describe_node_types carry `code`
//   4. jump both ways: a node's line selects (and frames) the node; selecting a card marks its line
//   5. phone: the Code tab is a sheet that fits a 390 px wide screen
//   6. a LATE JOINER's code view matches the host's, line for line
//
// Run: APP_URL=https://theprototype.app:7050/ node tests/e2e/flow-code-view.test.cjs   (ONLY=1,3,… to pick rows)
const h = require('./helpers.cjs');

const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = (row) => !ONLY.length || ONLY.includes(String(row));
const UNKNOWN_CARD = "comes from a module that isn't installed";

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const v1 = (page, fn, arg) => page.evaluate(fn, arg);

	const openEditor = async (page) => {
		if (!(await page.locator('.svelte-flow').count())) await page.locator('p[title="Node editor (N)"]').click();
		await page.waitForSelector('.svelte-flow', { timeout: 20000 });
		if (!(await page.locator('#flow-props').count())) await page.evaluate(() => document.querySelector('#flow-props-toggle').click());
		await page.waitForSelector('#flow-props', { timeout: 10000 });
	};
	/** put a graph in the scene document, replicated like any flow load (local here: section 1 needs no peer) */
	const setSceneGraph = (page, graph) =>
		page.evaluate((g) => {
			const s = window.__stores;
			s.setActiveGraph?.('scene');
			s.flowGraphs.update((all) => ({ ...all, scene: g }));
			s.flowNodes.set(g.nodes);
			s.flowEdges.set(g.edges);
		}, graph);
	const loadTemplate = (page, slug) =>
		page.evaluate(async (sl) => {
			const res = await fetch('/templates/' + sl + '/scene.tpscene');
			const bytes = await res.arrayBuffer();
			const sessions = window.__tp.test.v1.sessions;
			const payload = await sessions.importSessionZip(bytes);
			await sessions.applySession(payload, { backup: false, quiet: true });
			return true;
		}, slug);
	const sceneGraph = (page) =>
		page.evaluate(() => {
			let g;
			window.__stores.flowGraphs.subscribe((v) => (g = v))();
			return JSON.parse(JSON.stringify(g.scene ?? { nodes: [], edges: [] }));
		});
	const paneText = (page) => page.evaluate(() => [...document.querySelectorAll('#flow-code-lines li')].map((li) => li.textContent.replace(/^\d+/, '').trim()).join('\n'));

	// ---- 1. registry parity --------------------------------------------------------------------------------
	if (want(1)) {
		console.log('\n=== 1. registry parity ===');
		const reg = await v1(A.page, () => {
			const r = window.__tp.test.v1.nodeRegistry;
			const cat = window.__tp.test.v1.nodeCatalog.nodeCatalog;
			const core = r.NODE_FAMILIES.map((f) => ({ group: f.group, types: f.nodes.map((n) => n.type) }));
			return {
				types: r.coreNodeTypes(),
				errors: r.coreRegistryErrors(),
				same: JSON.stringify(cat.slice(0, core.length).map((g) => ({ group: g.group, types: g.items.map((i) => i.type) }))) === JSON.stringify(core)
			};
		});
		h.check(reg.types.length === 148 && reg.errors.length === 0, `148 core node types, one whole definition each (${reg.types.length}, errors ${JSON.stringify(reg.errors)})`);
		h.check(reg.same, 'the palette the app built is the definitions, in family order');
		await openEditor(A.page);
		const nodes = reg.types.map((type, i) => ({ id: 'p' + i, type, position: { x: (i % 12) * 260, y: Math.floor(i / 12) * 260 }, data: { type } }));
		await setSceneGraph(A.page, { nodes, edges: [] });
		await h.eventually(() => A.page.locator('.svelte-flow__node').count(), (n) => n === nodes.length, `all ${nodes.length} cards render`, 30000);
		const unknown = await A.page.evaluate((marker) => [...document.querySelectorAll('.svelte-flow__node')].filter((el) => el.textContent.includes(marker)).map((el) => el.getAttribute('data-id')), UNKNOWN_CARD);
		h.check(unknown.length === 0, `every core type has its own card, none falls to the unknown card (${JSON.stringify(unknown)})`);
		h.check(h.pageErrors(A).length === 0, `no page errors while every card rendered (${JSON.stringify(h.pageErrors(A).slice(0, 3))})`);
		await setSceneGraph(A.page, { nodes: [], edges: [] });
	}

	// ---- 2. flag off -------------------------------------------------------------------------------------------
	if (want(2)) {
		console.log('\n=== 2. on by default; switched off ===');
		h.check((await v1(A.page, () => window.__tp.test.v1.codeView.codeViewOn())) === true, 'codeView ships on (1.71)');
		await v1(A.page, () => window.__tp.test.v1.codeView.codeViewFlag.set(false));
		h.check((await v1(A.page, () => localStorage.getItem('flag:codeView'))) === '0', 'switching it off is remembered (flag:codeView = 0)');
		await openEditor(A.page);
		h.check((await A.page.locator('#flow-tab-code').count()) === 0, 'no Code tab with the flag off');
		await loadTemplate(A.page, 'starter-recipes');
		const r = await v1(A.page, async () => {
			const t = window.__tp.test.v1.aiTools;
			return { list: await t.executeAiTool('list_scene', { flow: 'scene' }), desc: await t.executeAiTool('describe_node_types', { types: ['latch'] }) };
		});
		h.check(r.list && !('code' in r.list) && !('code' in (r.desc?.types?.[0] ?? {})), 'the agent answers carry no code (contract 1.9 shape)');
	}

	// ---- 3. flag on: the Code tab on every template, and the agent ----------------------------------------------
	if (want(3)) {
		console.log('\n=== 3. flag on: the Code tab on the templates ===');
		await v1(A.page, () => window.__tp.test.v1.codeView.codeViewFlag.set(true));
		await openEditor(A.page);
		await A.page.locator('#flow-tab-code').click();
		await A.page.waitForSelector('#flow-code', { timeout: 10000 });
		const slugs = await v1(A.page, async () => (await (await fetch('/templates/index.json')).json()).templates.map((t) => t.slug));
		h.check(slugs.length >= 5, `the bundled templates (${slugs.join(', ')})`);
		// the tab shows the graph the canvas shows (the editor's active graph: the scene, or the selected object's flow)
		const shownGraph = (page) =>
			page.evaluate(() => {
				let all, active;
				window.__stores.flowGraphs.subscribe((v) => (all = v))();
				window.__stores.activeGraphId.subscribe((v) => (active = v))();
				const id = document.querySelector('#flow-code')?.getAttribute('data-graph-id');
				return { id, active, graph: JSON.parse(JSON.stringify(all[id] ?? { nodes: [], edges: [] })) };
			});
		const norm = (t) => String(t ?? '').replace(/\n$/, '').split('\n').map((l) => l.trim()).join('\n');
		for (const slug of slugs) {
			await loadTemplate(A.page, slug);
			await A.page.waitForTimeout(600);
			const { id, active, graph } = await shownGraph(A.page);
			h.check(id === active, `${slug}: the tab shows the canvas's graph (${id} / ${active})`);
			const logic = graph.nodes.filter((n) => n.type !== 'group' && n.type !== 'note');
			await h.eventually(() => A.page.locator('#flow-code-lines [data-node-id]').count(), (n) => n === logic.length, `${slug}: one line per node (${logic.length})`, 15000);
			const expected = await v1(A.page, (gid) => window.__tp.test.v1.flowCode.codeForGraphId(gid), id);
			const shown = await paneText(A.page);
			const wantText = norm(expected);
			h.check(shown === wantText, `${slug}: the tab shows the generator's text${shown === wantText ? '' : ' — DIFF:\n' + shown.slice(0, 300) + '\n---\n' + wantText.slice(0, 300)}`);
		}
		await loadTemplate(A.page, 'starter-recipes');
		await A.page.waitForTimeout(600);
		const { id: gid } = await shownGraph(A.page);
		const r = await v1(A.page, async (g) => {
			const t = window.__tp.test.v1.aiTools;
			return { list: await t.executeAiTool('list_scene', { flow: g }), desc: await t.executeAiTool('describe_node_types', { types: ['latch'] }) };
		}, gid);
		h.check(typeof r.list?.code === 'string' && r.list.code.includes('export default flow('), `list_scene {flow} carries the graph as code (${gid})`);
		h.check(norm(r.list?.code) === (await paneText(A.page)), 'the agent reads exactly what the Code tab shows');
		h.check(/^latch\(\{.*\}, \{ set: event/.test(r.desc?.types?.[0]?.code ?? ''), `describe_node_types cards carry their code shape (${r.desc?.types?.[0]?.code})`);
	}

	// ---- 4. jump both ways ------------------------------------------------------------------------------------
	if (want(4)) {
		console.log('\n=== 4. line -> node, node -> line ===');
		await v1(A.page, () => window.__tp.test.v1.codeView.codeViewFlag.set(true));
		await openEditor(A.page);
		const graph = {
			nodes: [
				{ id: 'j1', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', label: 'Press' } },
				{ id: 'j2', type: 'latch', position: { x: 300, y: 0 }, data: { type: 'latch' } },
				{ id: 'j3', type: 'visibility', position: { x: 600, y: 0 }, data: { type: 'visibility' } }
			],
			edges: [
				{ id: 'e-j1-j2.set', source: 'j1', target: 'j2', targetHandle: 'set' },
				{ id: 'e-j2-j3.on', source: 'j2', target: 'j3', targetHandle: 'on' }
			]
		};
		await setSceneGraph(A.page, graph);
		if (!(await A.page.locator('#flow-code').count())) await A.page.locator('#flow-tab-code').click();
		await h.eventually(() => A.page.locator('#flow-code-lines [data-node-id]').count(), (n) => n === 3, 'the three nodes are three lines', 10000);
		await A.page.locator('#flow-code-lines [data-node-id="j2"] button').click();
		await h.eventually(() => A.page.locator('.svelte-flow__node.selected').evaluateAll((els) => els.map((e) => e.getAttribute('data-id'))), (ids) => ids.length === 1 && ids[0] === 'j2', "pressing the latch's line selects the latch", 10000);
		h.check((await A.page.locator('#flow-code-lines [data-node-id="j2"] button').getAttribute('aria-current')) === 'true', 'and its line is marked');
		// the wide Code panel covers the canvas's right side (the latch is framed in the middle), so press the
		// card to its LEFT, the one a user can see
		const free = await A.page.evaluate(() => {
			const el = document.querySelector('.svelte-flow__node[data-id="j1"]');
			const r = el.getBoundingClientRect();
			const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
			return !!hit && el.contains(hit);
		});
		h.check(free, 'premise: the onclick card is visible beside the Code panel');
		await A.page.locator('.svelte-flow__node[data-id="j1"]').click();
		await h.eventually(() => A.page.locator('#flow-code-lines [aria-current="true"]').evaluateAll((els) => els.map((e) => e.closest('li').getAttribute('data-node-id'))), (ids) => ids.length === 1 && ids[0] === 'j1', 'selecting a card marks its line', 10000);
		await A.page.locator('#flow-code-copy').click();
		h.check(true, 'Copy is pressable (the clipboard is the browser\'s)');
	}

	// ---- 5. phone: a sheet that fits --------------------------------------------------------------------------
	if (want(5)) {
		console.log('\n=== 5. phone width ===');
		const before = A.page.viewportSize();
		await A.page.setViewportSize({ width: 390, height: 844 });
		await A.page.waitForTimeout(800);
		// the editor is still open from section 4; on a phone its side panel is a full-width sheet that
		// covers the canvas (the canvas is hidden on purpose), so wait for the sheet, not the canvas
		if (!(await A.page.locator('.svelte-flow').count())) await openEditor(A.page);
		if (!(await A.page.locator('#flow-props').count())) await A.page.evaluate(() => document.querySelector('#flow-props-toggle').click());
		await A.page.waitForSelector('#flow-props', { timeout: 10000 });
		if (!(await A.page.locator('#flow-code').count())) await A.page.locator('#flow-tab-code').click();
		await A.page.waitForSelector('#flow-code', { timeout: 10000 });
		const box = await A.page.locator('#flow-props').boundingBox();
		h.check(!!box && box.width <= 390 && box.width >= 300, `the Code sheet fits a 390 px screen (${box && Math.round(box.width)} px wide)`);
		const scroll = await A.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
		h.check(scroll, 'and the page does not scroll sideways (long lines scroll inside the sheet)');
		if (before) await A.page.setViewportSize(before);
	}

	// ---- 6. a late joiner reads the same code -----------------------------------------------------------------
	if (want(6)) {
		console.log('\n=== 6. late joiner ===');
		await v1(A.page, () => window.__tp.test.v1.codeView.codeViewFlag.set(true));
		await loadTemplate(A.page, 'starter-recipes');
		const hostGraph = await sceneGraph(A.page);
		h.check(hostGraph.nodes.length > 0, `premise: the host holds a graph (${hostGraph.nodes.length} nodes)`);
		const B = await h.setupPageQuiet(browser, 'B', [A], { storage: { 'flag:codeView': '1' } });
		await h.connect(B, A);
		await h.eventually(() => sceneGraph(B.page), (g) => g.nodes.length === hostGraph.nodes.length, 'B receives the graph', 60000);
		// every graph document (the scene's and each object's), as code, on both peers
		const allCode = (page) =>
			page.evaluate(() => {
				let all;
				window.__stores.flowGraphs.subscribe((v) => (all = v))();
				const fc = window.__tp.test.v1.flowCode;
				return Object.fromEntries(Object.keys(all).sort().map((id) => [id, fc.codeForGraphId(id)]));
			});
		const codeA = await allCode(A.page);
		h.check(Object.keys(codeA).length > 1, `premise: the host holds several graphs (${Object.keys(codeA).length})`);
		await h.eventually(() => allCode(B.page), (c) => JSON.stringify(c) === JSON.stringify(codeA), "the late joiner's code is the host's for every graph, line for line", 30000);
		{
			// a red here says WHICH graph and line differ (the check above prints only B's side)
			const codeB = await allCode(B.page);
			for (const id of new Set([...Object.keys(codeA), ...Object.keys(codeB)])) {
				if (codeA[id] === codeB[id]) continue;
				const a = String(codeA[id] ?? '<none>').split('\n'), b = String(codeB[id] ?? '<none>').split('\n');
				const i = a.findIndex((l, k) => l !== b[k]);
				console.log(`  differs: ${id} line ${i + 1}\n    A: ${a[i] ?? '<end>'}\n    B: ${b[i] ?? '<end>'}`);
				const probe = (page) => page.evaluate((u) => {
					let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
					const o = g?.getObjectByProperty?.('uuid', u);
					return o ? `${o.type} name=${JSON.stringify(o.name)} parent=${o.parent?.type}` : 'NOT IN objectsGroup';
				}, id);
				console.log(`    object on A: ${await probe(A.page)}\n    object on B: ${await probe(B.page)}`);
			}
			const names = (page) => page.evaluate(() => {
				let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
				const out = []; g?.traverse?.((o) => { if (o !== g && o.isMesh) out.push(o.name || o.type); });
				return out.sort().join(', ');
			});
			if (JSON.stringify(codeA) !== JSON.stringify(codeB)) console.log(`    meshes on A: ${await names(A.page)}\n    meshes on B: ${await names(B.page)}`);
		}
		await openEditor(B.page);
		await B.page.locator('#flow-tab-code').click();
		await B.page.waitForSelector('#flow-code', { timeout: 10000 });
		const bId = await B.page.evaluate(() => document.querySelector('#flow-code').getAttribute('data-graph-id'));
		const want6 = String(codeA[bId] ?? '').replace(/\n$/, '').split('\n').map((l) => l.trim()).join('\n');
		await h.eventually(() => paneText(B.page), (t) => t === want6, `B's Code tab shows the host's code for the graph it shows (${bId})`, 15000);
	}

	await h.finish(browser);
});
