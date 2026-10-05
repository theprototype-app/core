// 36 (G1 phases 3-5, flow-revamp 200-202) — PROPERTIES, CODE <-> NODE and the MAIN graph, on two peers.
//
//   1. the ⓘ panel renders EVERY node's property schema: a Bounce's ranges, a Math's op select, a
//      v2 Script's input values, a Behaviour's params; one commit = one replicated node edit, one
//      undo; a wired key shows the live value instead of a control
//   2. double-click opens code: Script → the Script panel, Behaviour → its view WITH the source,
//      a module's node / a Code link → the read-only Module source window (real minigolf files)
//   3. 36-code's seam: a registered opener receives the request instead
//   4. a v2 Script's sockets follow its code (typing `inputs.extra` adds the socket on both peers)
//   5. a module-bound Script is read-only until "Make editable copy": the fork re-points data.src
//      at a new Explorer asset on both peers and the editor becomes editable
//   6. the Main graph migration: loading the Mini Golf scene adds a Code link to its module on
//      Main — the peer receives it with the load, a reload adds nothing twice
//
// Run: APP_URL=https://theprototype.app:5329/ npm run e2e -- code-node
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SHOTS = process.env.SHOTS || '';
const GOLF = [
	process.env.MINIGOLF_TPSCENE,
	path.resolve(__dirname, '../../../scenes/games/mini-golf/scene.tpscene')
].filter(Boolean).find((p) => fs.existsSync(p));

const node = (id, type, data, x = 0, y = 0) => ({ id, type, position: { x, y }, data: { type, ...data }, class: 'w-[150px]' });
const edge = (source, target, targetHandle) => ({ id: 'e-' + source + '-' + target + (targetHandle ? '.' + targetHandle : ''), source, target, ...(targetHandle ? { targetHandle } : {}) });
const addGraph = (peer, nodes, edges = []) =>
	peer.page.evaluate(
		([nodes, edges]) => {
			window.__stores.flowNodes.update((n) => [...n, ...nodes]);
			window.__stores.flowEdges.update((e) => [...e, ...edges]);
			let p;
			window.__stores.peers.subscribe((v) => (p = v))();
			nodes.forEach((node) => p.send({ type: 'nodecreate', node }));
			edges.forEach((edge) => p.send({ type: 'edgecreate', edge }));
		},
		[nodes, edges]
	);
const dataOf = (peer, id) =>
	peer.page.evaluate((id) => {
		let g;
		window.__stores.flowGraphs.subscribe((v) => (g = v))();
		for (const doc of Object.values(g)) {
			const n = doc.nodes.find((x) => x.id === id);
			if (n) return JSON.parse(JSON.stringify(n.data));
		}
		return null;
	}, id);
const select = (peer, id) =>
	peer.page.evaluate((id) => window.__stores.flowNodes.update((ns) => ns.map((n) => ({ ...n, selected: n.id === id }))), id);
const storeVal = (peer, name) => peer.page.evaluate((name) => { let v; window.__stores[name].subscribe((x) => (v = x))(); return v; }, name);
const tabsOf = (peer) => peer.page.evaluate(() => { let v = []; window.__stores.codeWorkspace?.codeTabs.subscribe((x) => (v = x))(); return JSON.parse(JSON.stringify(v)); }); // 36-code: the workspace's open tabs
const dblclickNode = async (peer, id) => {
	const box = await peer.page.locator(`.svelte-flow__node[data-id="${id}"]`).boundingBox();
	if (!box) return false;
	// the card's header: never a field inside it
	await peer.page.mouse.dblclick(box.x + box.width / 2, box.y + 8);
	return true;
};
const centerOn = (peer, id) =>
	peer.page.evaluate((id) => {
		let ns;
		window.__stores.flowNodes.subscribe((v) => (ns = v))();
		const n = ns.find((x) => x.id === id);
		window.__flowViewport?.setViewport({ x: -n.position.x + 200, y: -n.position.y + 120, zoom: 1 });
	}, id);

const BEHAVIOUR = `export default behaviour({
  params: { power: { value: 7, min: 1, max: 12, step: 0.5 } },
  state: { shots: 0 },
  on: {}
});
`;

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1400, height: 900 } } });
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// open the Node editor tall, with the properties panel on its ⓘ tab
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(1200);
	await A.page.evaluate(() => window.__stores.bottomDock?.dockHeight?.set(620));
	if (!(await A.page.locator('#flow-props').count())) await A.page.locator('#flow-props-toggle').click();
	await A.page.locator('#flow-tab-info').click();

	// --- 1: properties --------------------------------------------------------------------
	await addGraph(A, [
		node('cn-num', 'number', { label: 'Number', value: 3, step: 1 }, 0, 0),
		node('cn-bounce', 'bounce', { label: 'Bounce', amplitude: 0.5, speed: 2 }, 220, 0),
		node('cn-math', 'math', { label: 'Math', op: 'add', a: 0, b: 0 }, 440, 0),
		node('cn-script', 'script', { label: 'Script', inputs: [{ name: 'power', type: 'number', value: 7 }], outputs: [{ name: 'out', type: 'number' }], code: 'return { out: inputs.power * 2 };' }, 0, 200),
		node('cn-bhv', 'behaviour', { label: 'Behaviour', name: 'Golf rules', enabled: false, code: BEHAVIOUR }, 220, 200)
	], [edge('cn-num', 'cn-bounce', 'amplitude')]);
	await A.page.waitForTimeout(800);

	await select(A, 'cn-bounce');
	await h.eventually(() => A.page.locator('#flow-node-props').count(), (n) => n === 1, 'selecting a Bounce shows its property rows', 4000);
	h.check((await A.page.locator('[data-prop-wired="amplitude"]').count()) === 1, 'the WIRED amplitude shows the live value, not a control');
	await A.page.locator('#flow-prop-speed').fill('4.5');
	await A.page.locator('#flow-prop-speed').press('Enter');
	await h.eventually(() => dataOf(B, 'cn-bounce'), (d) => d?.speed === 4.5, 'a property edit replicates (B: speed 4.5)', 4000);
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => dataOf(B, 'cn-bounce'), (d) => d?.speed === 2, 'one undo restores it on both peers (speed 2)', 4000);
	if (SHOTS) await A.page.screenshot({ path: path.join(SHOTS, '20-properties-dark.png') });

	await select(A, 'cn-math');
	await h.eventually(() => A.page.locator('#flow-prop-op').count(), (n) => n === 1, "Math's op is a select (its spec's schema)", 4000);
	await A.page.locator('#flow-prop-op').selectOption('sin');
	await h.eventually(() => dataOf(B, 'cn-math'), (d) => d?.op === 'sin', 'B: Math op = sin', 4000);

	await select(A, 'cn-script');
	await h.eventually(() => A.page.locator('#flow-prop-power').count(), (n) => n === 1, "a v2 Script's unwired input is a property", 4000);
	await A.page.locator('#flow-prop-power').fill('9');
	await A.page.locator('#flow-prop-power').press('Enter');
	await h.eventually(() => dataOf(B, 'cn-script'), (d) => d?.inputs?.[0]?.value === 9, 'B: the input value is 9 (the socket list replicated)', 4000);

	await select(A, 'cn-bhv');
	await h.eventually(() => A.page.locator('#flow-prop-power').count(), (n) => n === 1, "a Behaviour's param is a property", 4000);
	await A.page.locator('#flow-prop-power').fill('10.5');
	await A.page.locator('#flow-prop-power').press('Enter');
	await h.eventually(() => dataOf(B, 'cn-bhv'), (d) => /power:\s*\{\s*value:\s*10\.5\b/.test(d?.code ?? ''), 'B: the literal in the behaviour SOURCE is now 10.5 (one AST edit)', 4000);
	if (SHOTS) {
		await A.page.evaluate(() => window.__stores.themes.theme.set('light'));
		await A.page.waitForTimeout(400);
		await A.page.screenshot({ path: path.join(SHOTS, '21-properties-light.png') });
		await A.page.evaluate(() => window.__stores.themes.theme.set('dark'));
	}
	await select(A, '__none__');

	// --- 2: double-click opens code --------------------------------------------------------
	await centerOn(A, 'cn-script');
	await A.page.waitForTimeout(500);
	h.check(await dblclickNode(A, 'cn-script'), 'premise: the script card is on screen');
	// 36-code merged: the opener is the code workspace — the Script node opens as its tab
	await h.eventually(() => tabsOf(A), (t) => t.some((x) => x.nodeId === 'cn-script'), 'double-click a Script → its tab in the code workspace', 15000);
	await A.page.locator('#code-ws-close').click();

	await centerOn(A, 'cn-bhv');
	await A.page.waitForTimeout(400);
	await dblclickNode(A, 'cn-bhv');
	await h.eventually(() => tabsOf(A), (t) => t.some((x) => x.nodeId === 'cn-bhv' && x.kind === 'behaviour'), 'double-click a Behaviour → its source in the code workspace', 15000);
	await A.page.locator('#code-ws-close').click();

	await addGraph(A, [node('cn-ref', 'coderef', { label: 'Code link', module: 'minigolf', file: 'holes.js', title: 'Mini Golf holes' }, 440, 200)]);
	await A.page.waitForTimeout(600);
	await centerOn(A, 'cn-ref');
	await A.page.waitForTimeout(400);
	await dblclickNode(A, 'cn-ref');
	await h.eventually(() => tabsOf(A), (t) => t.some((x) => x.kind === 'module' && x.moduleId === 'minigolf' && x.name === 'holes.js'), 'double-click a Code link → the module file as a code-workspace tab', 15000);
	await h.eventually(
		() => tabsOf(A).then((t) => t.find((x) => x.name === 'holes.js')),
		(tab) => /PUTT_MAX\s*=\s*7/.test(tab?.code ?? '') && tab.readOnly === true,
		'holes.js opens on the file the link names — PUTT_MAX = 7 is readable from the graph, read-only',
		6000
	);
	if (SHOTS) await A.page.screenshot({ path: path.join(SHOTS, '22-module-source-readonly.png') });
	await A.page.locator('#code-ws-close').click();

	// a module's own node (registered by the core minigolf module) opens the same way
	const golfType = await A.page.evaluate(() => {
		let groups;
		window.__stores.moduleSDK.moduleNodeGroups.subscribe((v) => (groups = v))();
		for (const g of groups) for (const i of g.items) if (i.moduleId === 'minigolf') return i.type;
		return null;
	});
	if (golfType) {
		await addGraph(A, [node('cn-golf', golfType, { label: 'Golf node' }, 660, 200)]);
		await A.page.waitForTimeout(600);
		await centerOn(A, 'cn-golf');
		await A.page.waitForTimeout(400);
		await dblclickNode(A, 'cn-golf');
		await h.eventually(() => A.page.evaluate(() => window.__stores.codeOpen?.lastOpenCode?.()), (r) => r?.source === 'module' && r?.ref === 'minigolf', `double-click a module node (${golfType}) → its module's source`, 4000);
		await A.page.locator('#code-ws-close').click().catch(() => {});
	} else h.check(false, 'premise: the core minigolf module registered a node type');

	// --- 3: the seam ------------------------------------------------------------------------
	const routed = await A.page.evaluate(async () => {
		const c = window.__stores.codeOpen;
		const seen = [];
		const off = c.registerCodeOpener((req) => (seen.push(req), true));
		await c.openCode({ source: 'script', ref: 'cn-script' });
		off();
		let open;
		window.__stores.scriptEditorOpen.subscribe((v) => (open = v))();
		return { seen, open };
	});
	h.check(routed.seen.length === 1 && routed.seen[0].ref === 'cn-script' && !routed.open, "a registered opener (36-code's seam) gets the request; the fallback panel stays shut");

	// --- 4: sockets follow the code --------------------------------------------------------
	await A.page.evaluate(() => window.__stores.scriptEditorOpen.set('cn-script'));
	await h.eventually(() => tabsOf(A), (t) => t.some((x) => x.nodeId === 'cn-script'), 'premise: the script tab is open', 15000);
	await A.page.waitForTimeout(800);
	const paneId = await A.page.evaluate(() => new Promise((r) => window.__stores.codeWorkspace.activeCodeTab.subscribe(r)()));
	await A.page.locator(`[data-pane="${paneId}"] .cm-content`).click();
	await A.page.keyboard.press('Control+End');
	await A.page.keyboard.type('\n// later: inputs.extra');
	await A.page.waitForTimeout(300);
	// a comment adds nothing — the scanner masks it
	await A.page.keyboard.type('\nconst e = inputs.extra;');
	await A.page.keyboard.press('Control+S'); // the workspace applies on save (36-code fork #4)
	await h.eventually(() => dataOf(B, 'cn-script'), (d) => (d?.inputs ?? []).some((s) => s.name === 'extra') && d.inputs.length === 2, 'typing inputs.extra adds the socket on both peers (B)', 5000);
	await A.page.locator('#code-ws-close').click();

	// --- 5: module-bound code is read-only until forked ------------------------------------
	await addGraph(A, [node('cn-mod', 'script', { label: 'Script', inputs: [], code: 'object.rotation.y = time;', src: { kind: 'module', module: 'minigolf', file: 'spin.js' } }, 0, 400)]);
	await A.page.waitForTimeout(600);
	await A.page.evaluate(() => window.__stores.scriptEditorOpen.set('cn-mod'));
	await h.eventually(() => A.page.locator('#script-readonly').count(), (n) => n === 1, 'a module-bound script says read-only and offers Make editable copy', 15000);
	h.check((await A.page.locator('[data-readonly="true"]').count()) >= 1, 'its editor is read-only');
	await A.page.locator('#script-make-editable').click();
	await h.eventually(() => dataOf(B, 'cn-mod'), (d) => d?.src?.kind === 'asset' && /spin \(copy\)\.js/.test(d.src.name) && d.src.hash?.length > 10, 'the fork re-points data.src at a new Explorer asset (B sees it)', 6000);
	h.check((await dataOf(B, 'cn-mod'))?.code === 'object.rotation.y = time;', 'the running text is unchanged by the fork');
	h.check(
		await A.page.evaluate(() => { let items; window.__stores.explorer?.explorerItems?.subscribe((v) => (items = v))(); return (items ?? []).some((i) => /spin \(copy\)\.js/.test(i.name)); }),
		'the copy is in the Explorer library'
	);
	await h.eventually(() => A.page.locator('#script-readonly').count(), (n) => n === 0, 'the editor becomes editable after the fork', 6000);
	await A.page.locator('#code-ws-close').click();

	// --- 6: the Main graph migration -------------------------------------------------------
	if (GOLF) {
		const bytes = Array.from(fs.readFileSync(GOLF));
		const load = () =>
			A.page.evaluate(async (arr) => {
				const s = window.__stores;
				const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
				await s.sessions.applySession(payload, { backup: false });
			}, bytes);
		await load();
		const mainIds = (peer) => peer.page.evaluate(() => { let g; window.__stores.flowGraphs.subscribe((v) => (g = v))(); return g.scene.nodes.filter((n) => n.data?.main).map((n) => n.id); });
		await h.eventually(() => mainIds(A), (ids) => ids.includes('main-mod-minigolf'), 'loading the old Mini Golf scene adds a Code link to its module on Main', 8000);
		await h.eventually(() => mainIds(B), (ids) => ids.includes('main-mod-minigolf'), 'the peer receives it with the load', 8000);
		await load();
		await A.page.waitForTimeout(1500);
		h.check((await mainIds(A)).filter((id) => id === 'main-mod-minigolf').length === 1, 'a reload adds nothing twice');
		const tree = await A.page.evaluate(() => document.querySelector('#graph-tree-flow-scene')?.textContent ?? '');
		h.check(/Main/.test(tree), `the Flow list calls the scene graph Main (${tree.trim()})`);
		if (SHOTS) {
			await A.page.evaluate(() => window.__flowViewport?.fitView?.({ padding: 0.05 }));
			await A.page.waitForTimeout(600);
			await A.page.screenshot({ path: path.join(SHOTS, '23-mini-golf-main-migrated.png') });
		}
	} else console.log('SKIP 6: no mini-golf scene (set MINIGOLF_TPSCENE)');

	await h.finish(browser);
});
