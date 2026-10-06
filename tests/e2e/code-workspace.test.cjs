// 36-code (plan 75.6 + U10's code half + B6): THE CODE WORKSPACE on two peers.
//   1 a .js file opens from the Explorer as a tab; typing marks it dirty; Ctrl+S writes it back
//   2 "Edit code" on a Script node opens its tab; Ctrl+S reloads the node on BOTH peers
//   3 Save as file binds the node (src + hash) and the bytes reach the peer's Explorer
//   4 two nodes bound to one file: saving the file hot-reloads both, on both peers
//   5 a parse error never applies: tab + node badges, the nodes keep the old code
//   6 go-to-node from the tab; the old scriptEditorOpen seam still opens a tab
//   7 a dirty tab whose source changes elsewhere goes stale (Load theirs / Keep mine)
//   8 a module's source opens READ-ONLY; "Make editable copy" appears with a fork hook and opens its result
//   9 B6: the graph as JSON — an edit applies on both peers as one undo step; invalid JSON never applies
const h = require('./helpers.cjs');

const S = (page, fn, arg) => page.evaluate(fn, arg);
// evidence screenshots for the lane's status page: CW_SHOTS=<dir>
const SHOTS = process.env.CW_SHOTS || '';
const shot = async (page, name) => SHOTS && page.screenshot({ path: SHOTS + '/' + name });

/** a store's current value */
const read = (page, path) =>
	page.evaluate(
		(path) =>
			new Promise((r) => {
				const parts = path.split('.');
				let obj = window.__stores;
				for (const p of parts) obj = obj[p];
				obj.subscribe((v) => r(JSON.parse(JSON.stringify(v ?? null))))();
			}),
		path
	);

const nodeData = (page, id) =>
	page.evaluate(
		(id) =>
			new Promise((r) =>
				window.__stores.flowGraphs.subscribe((all) => {
					for (const g of Object.values(all)) {
						const n = g.nodes.find((x) => x.id === id);
						if (n) return r(JSON.parse(JSON.stringify(n.data)));
					}
					r(null);
				})()
			),
		id
	);

const objX = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					r(o ? o.position.x : null);
				})()
			),
		uuid
	);

/** poll (in node) until the workspace's tabs satisfy `pred(tabs)`; the last read is returned */
async function waitTabs(page, pred, timeout = 45000) {
	const t0 = Date.now();
	let tabs = [];
	while (Date.now() - t0 < timeout) {
		tabs = await read(page, 'codeWorkspace.codeTabs').catch(() => []);
		const pane = await page.locator('[data-pane] .cm-content').count().catch(() => 0);
		if (pred(tabs, pane)) return tabs;
		await page.waitForTimeout(500);
	}
	if (SHOTS) await page.screenshot({ path: SHOTS + '/zz-wait-timeout.png' });
	console.log('waitTabs timed out; tabs=' + JSON.stringify(tabs.map((t) => [t.kind, t.title])));
	return tabs;
}

/** the active tab's pane, and real typing into its CodeMirror */
async function typeInActive(page, text) {
	const id = await read(page, 'codeWorkspace.activeCodeTab');
	const content = page.locator(`[data-pane="${id}"] .cm-content`);
	await content.click();
	await page.keyboard.press('Control+A');
	await page.keyboard.insertText(text);
	return id;
}

h.run(async () => {
	const browser = await h.launch();
	// the share-ask strip slides the grid down under a double-click; this suite is not about it
	const storage = { 'shared:shareNewFiles': 'never' };
	const A = await h.setupPage(browser, 'A', { storage });
	const B = await h.setupPage(browser, 'B', { storage });
	await h.connect(B, A);

	// ---------------------------------------------------------------- 1 Explorer round-trip
	const itemId = await S(A.page, async () => {
		const ex = window.__stores.explorer;
		await ex.loadExplorer();
		const bytes = new TextEncoder().encode('// a file\nreturn { out: inputs.a + 1 };\n').buffer;
		const item = await ex.addItemFromBytes(bytes, 'adder.js', null);
		return item.id;
	});
	await S(A.page, () => {
		window.__stores.explorerClose.set(false);
		window.__stores.bottomDock.bottomDockActive.set('explorer');
	});
	await A.page.waitForTimeout(1200);
	await A.page.locator('.explorer-card', { hasText: 'adder.js' }).first().dblclick();
	await waitTabs(A.page, (tabs, pane) => tabs.length === 1 && pane > 0, 60000);
	let tabs = await read(A.page, 'codeWorkspace.codeTabs');
	h.check(tabs.length === 1 && tabs[0].kind === 'file' && tabs[0].itemId === itemId, 'double-clicking a .js file opens a FILE tab in the code workspace');
	h.check(await A.page.locator('#code-ws-dock, #code-ws-window').first().isVisible(), 'the workspace is on screen');
	h.check(tabs[0].code.includes('inputs.a + 1'), 'the tab holds the file text');
	const hash0 = tabs[0].hash;
	await typeInActive(A.page, '// edited\nreturn { out: inputs.a + 2 };\n');
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('.code-tab[data-dirty="true"] .code-tab-dirty').count() === 1, 'typing marks the tab dirty (the ● marker)');
	await A.page.keyboard.press('Control+S');
	await A.page.waitForTimeout(1200);
	tabs = await waitTabs(A.page, (t) => t[0] && t[0].code === t[0].saved, 15000);
	const item1 = await S(A.page, async (id) => {
		const ex = window.__stores.explorer;
		const it = ex.itemById(id);
		return { hash: it.hash, text: await (await ex.itemBlob(id)).text() };
	}, itemId);
	h.check(item1.text.includes('inputs.a + 2') && item1.hash !== hash0, 'Ctrl+S writes the file back (new bytes, new hash, same item)');
	h.check(tabs[0].hash === item1.hash && tabs[0].code === tabs[0].saved, 'the tab is clean and tracks the new hash');
	h.check(await A.page.locator('.code-tab[data-dirty="true"]').count() === 0, 'the dirty marker clears');

	// ---------------------------------------------------------------- 2 a Script node's tab
	const uuid = await S(A.page, () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		return new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children[g.children.length - 1].uuid))());
	});
	await A.page.waitForTimeout(800);
	await S(A.page, async (uuid) => {
		const nodes = [
			{ id: 'cw1', type: 'script', position: { x: 0, y: 0 }, data: { type: 'script', code: 'object.position.x = 1;' }, class: 'w-[150px]' },
			{ id: 'cw2', type: 'script', position: { x: 0, y: 160 }, data: { type: 'script', code: '// second' }, class: 'w-[150px]' },
			{ id: 'cwsel', type: 'objectselector', position: { x: 300, y: 0 }, data: { type: 'objectselector', selected: uuid }, class: 'w-[150px]' }
		];
		const edge = { id: 'e-cw1-cwsel', source: 'cw1', target: 'cwsel' };
		const { createFlowNode, createFlowEdge } = await import('/src/lib/nodesHandler.js');
		window.__stores.flowNodes.update((n) => [...n, ...nodes]);
		window.__stores.flowEdges.update((e) => [...e, edge]);
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		nodes.forEach((node) => peer.send({ type: 'nodecreate', node }));
		peer.send({ type: 'edgecreate', edge });
	}, uuid);
	await A.page.waitForTimeout(2500);
	h.check(Math.abs((await objX(B.page, uuid)) - 1) < 0.01, 'premise: the inline script runs on B (x = 1)');
	await S(A.page, () => {
		// the editor's scope follows the selection, and /create selects the box (21-E)
		window.__stores.objectActions.deselectObject();
		window.__stores.flowGraphClose.set(false);
		window.__stores.bottomDock.bottomDockActive.set('flow');
	});
	await A.page.waitForTimeout(1200);
	await A.page
		.locator('.svelte-flow__node[data-id="cw1"] button', { hasText: 'Edit code' })
		.click()
		.catch(async (e) => {
			if (SHOTS) await A.page.screenshot({ path: SHOTS + '/zz-edit-code.png' });
			console.log('state', JSON.stringify(await S(A.page, () => ({ active: window.__stores.activeGraphId && null, sel: null }))));
			throw e;
		});
	await waitTabs(A.page, (tabs) => tabs.some((t) => t.nodeId === 'cw1'));
	await A.page.waitForTimeout(600);
	let active = await read(A.page, 'codeWorkspace.activeCodeTab');
	tabs = await read(A.page, 'codeWorkspace.codeTabs');
	let tab = tabs.find((t) => t.id === active);
	h.check(tab?.kind === 'node' && tab.nodeId === 'cw1', 'go-to-code: "Edit code" on the node opens its tab');
	h.check(await A.page.locator('#script-sockets #script-upgrade-v2').isVisible(), "the node tab carries the Script node's sockets editor");
	await shot(A.page, '01-workspace-node-tab.png');
	await typeInActive(A.page, 'object.position.x = 2.5;');
	await A.page.waitForTimeout(500);
	h.check((await nodeData(B.page, 'cw1')).code === 'object.position.x = 1;', 'nothing applies before Ctrl+S (live apply is off by default)');
	await A.page.keyboard.press('Control+S');
	await A.page.waitForTimeout(2500);
	h.check((await nodeData(B.page, 'cw1')).code === 'object.position.x = 2.5;', 'Ctrl+S replicates the node code to B');
	h.check(Math.abs((await objX(B.page, uuid)) - 2.5) < 0.01, 'and B runs it (x = 2.5)');

	// ---------------------------------------------------------------- 3 Save as file -> bound
	await A.page.locator('#code-ws-to-file').click();
	await A.page.waitForTimeout(2000);
	const ref = (await nodeData(A.page, 'cw1')).src;
	h.check(ref?.kind === 'asset' && !!ref.hash && /\.js$/.test(ref.name), 'Save as file binds the node (G1 src {kind: asset, hash, name})');
	tabs = await read(A.page, 'codeWorkspace.codeTabs');
	active = await read(A.page, 'codeWorkspace.activeCodeTab');
	tab = tabs.find((t) => t.id === active);
	h.check(tab?.kind === 'file' && tab.hash === ref.hash, 'the tab became the FILE tab');
	h.check((await nodeData(B.page, 'cw1')).src?.hash === ref.hash, 'B sees the binding');
	await h.eventually(
		() => S(B.page, (hash) => !!window.__stores.explorer.itemByHash(hash), ref.hash),
		(v) => v === true,
		"the file's bytes reach B's Explorer (assetShare push)",
		15000
	);
	h.check(await A.page.locator('.svelte-flow__node[data-id="cw1"] .script-file').count() === 1, 'the node card names its file');

	// ---------------------------------------------------------------- 4 two nodes, one file
	await S(A.page, async (hash) => {
		await window.__stores.scriptAssets.bindScriptNode('cw2', undefined, { hash });
	}, ref.hash);
	await A.page.waitForTimeout(1500);
	h.check((await nodeData(B.page, 'cw2')).code === 'object.position.x = 2.5;', 'binding a second node gives it the file text (on B too)');
	await typeInActive(A.page, 'object.position.x = 4;');
	await A.page.keyboard.press('Control+S');
	await A.page.waitForTimeout(2500);
	await h.eventually(
		() => Promise.all([nodeData(A.page, 'cw1'), nodeData(A.page, 'cw2')]),
		([x, y]) => x.code === 'object.position.x = 4;' && y.code === x.code,
		'saving the file hot-reloads BOTH bound nodes on A',
		10000
	);
	const [a1] = await Promise.all([nodeData(A.page, 'cw1')]);
	await h.eventually(
		() => Promise.all([nodeData(B.page, 'cw1'), nodeData(B.page, 'cw2')]),
		([x, y]) => x.code === a1.code && y.code === a1.code,
		'and on B',
		15000
	);
	const [b1, b2] = await Promise.all([nodeData(B.page, 'cw1'), nodeData(B.page, 'cw2')]);
	h.check(a1.src.hash !== ref.hash && b2.src.hash === a1.src.hash && b2.src.from === ref.hash, 'the hash bumped everywhere, with its lineage (from)');
	await h.eventually(() => objX(B.page, uuid), (x) => Math.abs(x - 4) < 0.01, 'B runs the new file (x = 4)', 10000);
	await h.eventually(
		() => S(B.page, (hash) => !!window.__stores.explorer.itemByHash(hash), a1.src.hash),
		(v) => v === true,
		"B's copy of the file follows the bump",
		8000
	);
	const undone = await S(A.page, () => (window.__stores.history.undo(), true));
	await A.page.waitForTimeout(1500);
	const [u1, u2] = await Promise.all([nodeData(B.page, 'cw1'), nodeData(B.page, 'cw2')]);
	h.check(undone && u1.code === 'object.position.x = 2.5;' && u2.code === u1.code, 'ONE undo puts both nodes back (on B too)');
	await S(A.page, () => window.__stores.history.redo());
	await A.page.waitForTimeout(1200);
	h.check((await nodeData(B.page, 'cw1')).code === 'object.position.x = 4;', 'redo re-applies it');

	// ---------------------------------------------------------------- 5 parse error never applies
	await typeInActive(A.page, 'object.position.x = ;');
	await A.page.keyboard.press('Control+S');
	await A.page.waitForTimeout(1200);
	h.check(await A.page.locator('.code-tab[data-error="true"] .code-tab-bad').count() >= 1, 'a parse error badges the TAB');
	h.check(await A.page.locator('#code-ws-error').isVisible(), 'and says why (the error banner)');
	await shot(A.page, '02-parse-error.png');
	if (SHOTS) {
		await S(A.page, () => window.__stores.themes.theme.set('light'));
		await A.page.waitForTimeout(500);
		await shot(A.page, '03-parse-error-light.png');
		await S(A.page, () => window.__stores.themes.theme.set('dark'));
	}
	h.check((await A.page.locator('#code-ws-error').textContent()).includes('line 1'), 'naming the line');
	h.check(await A.page.locator('.svelte-flow__node[data-id="cw1"] .script-pending').count() === 1 && (await A.page.locator('.svelte-flow__node[data-id="cw2"] .script-pending').count()) === 1, 'and badges every bound NODE');
	h.check((await nodeData(B.page, 'cw1')).code === 'object.position.x = 4;', 'the broken code reached nobody (B keeps the last good version)');
	h.check(Math.abs((await objX(B.page, uuid)) - 4) < 0.01, 'and B still runs it');
	h.check(await A.page.locator('.code-tab[data-dirty="true"]').count() === 1, 'the buffer stays dirty — nothing is lost');
	h.check(await A.page.locator('[data-pane] .cm-lint-marker-error, [data-pane] .cm-lintRange-error').count() >= 1, 'the editor marks the error line');
	await typeInActive(A.page, 'object.position.x = 3;');
	await A.page.keyboard.press('Control+S');
	await A.page.waitForTimeout(1500);
	// (cw2 has no target object, so the RUNTIME may badge it — that badge is right; the pending one must go)
	await h.eventually(
		async () => ({ pending: await A.page.locator('.script-pending').count(), tab: (await read(A.page, 'codeWorkspace.codeTabs')).find((t) => t.kind === 'file')?.error ?? null }),
		(v) => v.pending === 0 && v.tab === null,
		'a good save clears the tab error and the nodes\' "not applied" badges',
		10000
	);

	// ---------------------------------------------------------------- 6 go-to-node + the old seam
	await S(A.page, () => window.__stores.flowGraphClose.set(true));
	await A.page.waitForTimeout(400);
	await A.page.locator('#code-ws-goto').click();
	await A.page.waitForTimeout(400);
	const menuRows = await A.page.locator('[role="menuitem"]').count();
	console.log('go-to menu rows: ' + menuRows);
	if (menuRows) await A.page.locator('[role="menuitem"]').first().click();
	await h.eventually(() => read(A.page, 'flowGraphClose'), (v) => v === false, 'go-to-node opens the Node editor', 8000);
	if (SHOTS && (await read(A.page, 'flowGraphClose')) !== false) await A.page.screenshot({ path: SHOTS + '/zz-goto.png' });
	h.check((await read(A.page, 'activeGraphId')) === 'scene', 'on the node graph');
	await S(A.page, () => window.__stores.scriptEditorOpen.set('cw2'));
	await A.page.waitForTimeout(800);
	active = await read(A.page, 'codeWorkspace.activeCodeTab');
	tabs = await read(A.page, 'codeWorkspace.codeTabs');
	h.check(tabs.find((t) => t.id === active)?.kind === 'file' && tabs.filter((t) => t.kind === 'file' && t.hash === tabs.find((x) => x.id === active).hash).length === 1, 'scriptEditorOpen on a node bound to an OPEN file raises that one tab (no duplicate)');

	// ---------------------------------------------------------------- 7 stale
	await typeInActive(A.page, 'object.position.x = 9; // mine');
	await S(B.page, async () => {
		const { setNodeData } = await import('/src/lib/nodesHandler.js');
		setNodeData('cw1', { code: 'object.position.x = 7; // theirs' }, 'scene');
	});
	await A.page.waitForTimeout(1500);
	h.check(await A.page.locator('#code-ws-stale').isVisible(), 'a dirty tab whose source changed elsewhere is marked stale');
	active = await read(A.page, 'codeWorkspace.activeCodeTab');
	h.check((await read(A.page, 'codeWorkspace.codeTabs')).find((t) => t.id === active).code.includes('// mine'), 'and keeps your text');
	await A.page.locator('#code-ws-stale button', { hasText: 'Load theirs' }).click();
	await A.page.waitForTimeout(300);
	h.check((await read(A.page, 'codeWorkspace.codeTabs')).find((t) => t.id === active).code.includes('// theirs'), 'Load theirs takes the other edit');

	// ---------------------------------------------------------------- 8 module source, read-only + fork hook
	await S(A.page, () =>
		window.__stores.codeWorkspace.openCode({ source: 'module', ref: { moduleId: 'demo', name: 'spin.js', code: 'export default behaviour({});\n' } })
	);
	await A.page.waitForTimeout(800);
	active = await read(A.page, 'codeWorkspace.activeCodeTab');
	tab = (await read(A.page, 'codeWorkspace.codeTabs')).find((t) => t.id === active);
	h.check(tab?.kind === 'module' && tab.readOnly === true, 'a module source opens READ-ONLY');
	h.check((await A.page.locator(`[data-pane="${active}"] .cm-content`).getAttribute('contenteditable')) === 'false', 'its editor refuses typing');
	// 36-fb-code (F6): a module file is always copyable — with no hook the default puts a copy in the Library
	h.check(await A.page.locator('#code-ws-fork').isVisible(), '"Make editable copy" is offered without a hook too (the Library copy)');
	await S(A.page, () => {
		window.__forked = null;
		window.__offFork = window.__stores.codeWorkspace.registerCodeSource('module', {
			fork: async (ref, code) => {
				window.__forked = { ref, code };
				return { source: 'script', ref: { nodeId: 'cw2' } };
			}
		});
		window.__stores.codeWorkspace.codeTabs.update((l) => l); // repaint
	});
	await A.page.locator('.code-tab[data-kind="file"]').first().click();
	await A.page.locator('.code-tab[data-kind="module"]').first().click();
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('#code-ws-fork').isVisible(), 'with a fork hook registered the button stays (the hook wins)');
	await A.page.locator('#code-ws-fork').click();
	await A.page.waitForTimeout(800);
	const forked = await S(A.page, () => window.__forked);
	h.check(forked?.ref?.moduleId === 'demo' && forked.code.includes('behaviour'), 'the hook receives the module ref and its source');
	active = await read(A.page, 'codeWorkspace.activeCodeTab');
	h.check((await read(A.page, 'codeWorkspace.codeTabs')).find((t) => t.id === active)?.kind === 'file', 'and the tab it returns is opened');
	await S(A.page, () => window.__offFork());

	// ---------------------------------------------------------------- 9 B6 graph JSON
	await S(A.page, () => window.__stores.codeWorkspace.openCode({ source: 'graph', ref: { graphId: 'scene' } }));
	await A.page.waitForTimeout(800);
	active = await read(A.page, 'codeWorkspace.activeCodeTab');
	tab = (await read(A.page, 'codeWorkspace.codeTabs')).find((t) => t.id === active);
	const doc = JSON.parse(tab.code);
	h.check(tab.kind === 'graph' && doc.nodes.some((n) => n.id === 'cw1'), 'the scene graph opens as JSON');
	await shot(A.page, '04-graph-json.png');
	// invalid first
	await S(A.page, (id) => window.__stores.codeWorkspace.setTabCode(id, '{"nodes": ['), active);
	await A.page.keyboard.press('Control+S');
	await A.page.locator(`[data-pane="${active}"] .cm-content`).click();
	await A.page.keyboard.press('Control+S');
	await A.page.waitForTimeout(800);
	h.check(await A.page.locator('#code-ws-error').isVisible(), 'invalid JSON is refused with an error');
	h.check(!!(await nodeData(A.page, 'cw2')), 'and applies nothing');
	// a real edit: drop cw2, rename cw1's label, move cwsel
	doc.nodes = doc.nodes.filter((n) => n.id !== 'cw2');
	doc.nodes.find((n) => n.id === 'cw1').data.label = 'From JSON';
	doc.nodes.find((n) => n.id === 'cwsel').position = { x: 512, y: 64 };
	await S(A.page, ([id, text]) => window.__stores.codeWorkspace.setTabCode(id, text), [active, JSON.stringify(doc, null, 2)]);
	await A.page.locator(`[data-pane="${active}"] .cm-content`).click();
	await A.page.keyboard.press('Control+S');
	await A.page.waitForTimeout(1500);
	await h.eventually(
		async () => [await nodeData(A.page, 'cw2'), await nodeData(B.page, 'cw2')],
		([a, b]) => a === null && b === null,
		'Ctrl+S applies the JSON: the removed node is gone on A and B',
		10000
	);
	h.check((await nodeData(B.page, 'cw1')).label === 'From JSON', 'an edited field reaches B');
	const pos = await S(B.page, () => new Promise((r) => window.__stores.flowGraphs.subscribe((g) => r(g.scene.nodes.find((n) => n.id === 'cwsel')?.position))()));
	h.check(pos?.x === 512 && pos?.y === 64, 'a moved node moves on B');
	await S(A.page, () => window.__stores.history.undo());
	await A.page.waitForTimeout(2000);
	h.check(!!(await nodeData(B.page, 'cw2')) && (await nodeData(B.page, 'cw1')).label !== 'From JSON', 'ONE undo restores the graph on both peers');

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, 'no page errors on either peer');
	await h.finish(browser);
});
