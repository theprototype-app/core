// showhide-v8 §4 — FLOW CODE IS A TAB OF THE CODE WINDOW (the Flow code panel is gone), and §2 — CODE'S SIDEBARS
// HANG FROM EDGE HANDLES, with a per-window lock.
//
//   1. Code's file tree lists a "flow code" entry under each graph, beside graph.json; the header has no
//      Graph JSON button any more, and nothing of the old Flow code panel is in the page
//   2. every old way in (the open store, Alt+F) opens Code on a flow code tab, and the old store closes itself
//   3. the tab is the compact graph text; editing a param + Save (Ctrl+S's button) changes the graph
//   4. a bad line is reported with its line number and the graph is left alone
//   5. the edge handles hide / show the sidebars; locked (the handle's menu seam), a press changes nothing —
//      the counterfactual is the same press unlocked, which does
//
// Run: APP_URL=https://theprototype.app:6995/ npm run e2e -- code-flow-text
const h = require('./helpers.cjs');

const S = (page, fn, arg) => page.evaluate(fn, arg);
const read = (page, path) =>
	page.evaluate((p) => {
		const [mod, name] = p.split('.');
		const st = name ? window.__stores[mod][name] : window.__stores[mod];
		let v;
		st.subscribe((x) => (v = x))();
		return v;
	}, path);
const activeTab = (page) =>
	page.evaluate(() => {
		const m = window.__stores.codeWorkspace;
		let tabs, id;
		m.codeTabs.subscribe((v) => (tabs = v))();
		m.activeCodeTab.subscribe((v) => (id = v))();
		const t = tabs.find((x) => x.id === id);
		return t ? { id: t.id, kind: t.kind, format: t.format ?? 'json', title: t.title, code: t.code, error: t.error ?? null } : null;
	});
const graphNodes = (page) =>
	page.evaluate(() => {
		let v;
		window.__stores.flowNodes.subscribe((x) => (v = x))();
		return v.map((n) => ({ id: n.id, value: n.data?.value }));
	});
/** replace the active tab's text the way a person pasting would */
async function setEditor(page, id, text) {
	await page.locator(`[data-pane="${id}"] .cm-content`).click();
	await page.keyboard.press('Control+A');
	await page.keyboard.insertText(text);
	await page.waitForTimeout(300);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1600, height: 900 } } });
	const page = A.page;

	await S(page, () => {
		const nodes = [
			{ id: 'n1', type: 'number', position: { x: 10, y: 20 }, data: { label: 'Number', type: 'number', value: 3 }, class: 'w-[150px]' },
			{ id: 'vis', type: 'visibility', position: { x: 240, y: 20 }, data: { label: 'Visibility', type: 'visibility', on: true }, class: 'w-[150px]' }
		];
		window.__stores.flowNodes.set(nodes);
		window.__stores.flowEdges.set([{ id: 'e-n1-vis.on', source: 'n1', target: 'vis', targetHandle: 'on' }]);
	});

	// --- 2: the old open store redirects ---
	await S(page, () => window.__stores.flowCodeClose.set(false));
	await page.waitForFunction(() => document.querySelector('.code-ws .cm-content'), null, { timeout: 20000 });
	await page.waitForTimeout(500);
	let tab = await activeTab(page);
	h.check(!!tab && tab.kind === 'graph' && tab.format === 'text', `2.1 opening the old Flow code store opens a Code flow code tab (${JSON.stringify(tab && { kind: tab.kind, format: tab.format })})`);
	h.check(!!tab && /flow code/i.test(tab.title), `2.2 ...titled "flow code" (${tab?.title})`);
	h.check((await read(page, 'flowCodeClose')) === true, '2.3 the old store closes itself again');
	h.check((await read(page, 'codeWorkspaceClose')) === false, '2.4 the Code window is open');

	// --- 1: the tree entry, no Graph JSON button, no old panel ---
	const dom = await S(page, () => ({
		graphBtn: !!document.getElementById('code-ws-open-graph'),
		oldDock: !!document.getElementById('flow-code-dock'),
		oldWin: !!document.getElementById('flow-code-window'),
		leaf: !!document.querySelector('#code-ws-project [data-tree-key="ft:scene"]'),
		json: !!document.querySelector('#code-ws-project [data-tree-key="g:scene"]')
	}));
	h.check(!dom.graphBtn, '1.1 the header has no Graph JSON button');
	h.check(!dom.oldDock && !dom.oldWin, '1.2 nothing of the old Flow code panel is in the page');
	h.check(dom.leaf && dom.json, `1.3 the tree lists flow code beside graph.json (${JSON.stringify(dom)})`);

	// --- 3: the text, edited and saved ---
	h.check(/n1 = number/.test(tab.code) && /n1 -> vis\.on|n1\.\w+ -> vis\.on/.test(tab.code), `3.1 seeded with the compact graph text (${tab.code.split('\n').slice(0, 3).join(' | ')})`);
	const edited = tab.code.replace(/value:\s*3\b/, 'value: 7');
	h.check(edited !== tab.code, '3.2 (setup) the param line was found to edit');
	await setEditor(page, tab.id, edited);
	// the editor hands its text to the tab store on its own beat: Save applies what the STORE holds, so wait for it
	for (let i = 0; i < 20 && !/value:\s*7/.test((await activeTab(page))?.code ?? ''); i++) await page.waitForTimeout(150);
	await page.locator('#code-ws-save').click();
	// the apply loads graphJsonApply lazily: on a cold dev server the first import takes seconds, so poll
	let after = await graphNodes(page);
	for (let i = 0; i < 40 && after.find((n) => n.id === 'n1')?.value !== 7; i++) {
		await page.waitForTimeout(250);
		after = await graphNodes(page);
	}
	const saw = await activeTab(page);
	const focusAt = await S(page, () => (document.activeElement?.id || document.activeElement?.className || '').toString().slice(0, 60));
	h.check(after.find((n) => n.id === 'n1')?.value === 7, `3.3 Save applied the text to the graph (${JSON.stringify(after)}; tab has 7: ${/value:\s*7/.test(saw?.code ?? '')}; err ${JSON.stringify(saw?.error)}; focus ${focusAt})`);
	tab = await activeTab(page);
	h.check(!tab.error, '3.4 no error on a good save');

	// --- 4: a bad line ---
	await setEditor(page, tab.id, tab.code + '\nthis is not a node line ((');
	await page.locator('#code-ws-save').click();
	await page.waitForTimeout(500);
	tab = await activeTab(page);
	const still = await graphNodes(page);
	h.check(!!tab.error && tab.error.line > 1, `4.1 a bad line is reported with its line (${JSON.stringify(tab.error)})`);
	h.check(still.length === 2 && still.find((n) => n.id === 'n1')?.value === 7, '4.2 ...and the graph is left alone');

	// --- 2b: Alt+F also lands on the flow code tab (the shortcut, after the JSON tab was made active) ---
	await S(page, () => window.__stores.codeWorkspace.openCode({ source: 'graph', ref: { graphId: 'scene' } }));
	await page.waitForTimeout(400);
	h.check((await activeTab(page))?.format === 'json', '2.5 (setup) graph.json is the active tab');
	// leave the Code pane's key scope (a press there keeps global shortcuts away, keyScope) with a press on the open
	// viewport, clear of the column handles
	// (a fixed point can land inside the Code window, depending on where it opened): find one the 3D canvas owns
	const free = await S(page, () => {
		for (let y = 120; y < innerHeight - 80; y += 40)
			for (let x = 120; x < innerWidth - 120; x += 40) {
				const el = document.elementFromPoint(x, y);
				if (el?.tagName === 'CANVAS' && !el.closest('[data-key-scope]')) return { x, y };
			}
		return null;
	});
	h.check(!!free, `2.5b (premise) an open spot of the 3D view to press (${JSON.stringify(free)})`);
	await page.mouse.click(free?.x ?? 800, free?.y ?? 200);
	await page.keyboard.press('Alt+f');
	let fmt = null;
	for (let i = 0; i < 24 && fmt !== 'text'; i++) {
		await page.waitForTimeout(250);
		fmt = (await activeTab(page))?.format;
	}
	const focus26 = await S(page, () => (document.activeElement?.id || document.activeElement?.tagName || '').toString().slice(0, 40));
	h.check(fmt === 'text', `2.6 Alt+F raises the flow code tab (${fmt}; focus ${focus26})`);

	// --- 5: the edge handles + the lock ---
	const leftOpen = () => page.evaluate(() => !!document.querySelector('.code-ws .code-side-left'));
	const handle = page.locator('#code-ws-toggle-left').first();
	h.check((await handle.count()) === 1, '5.1 the files sidebar has an edge handle');
	const before = await leftOpen();
	await handle.click();
	await page.waitForTimeout(300);
	h.check((await leftOpen()) === !before, `5.2 unlocked, a press toggles the sidebar (counterfactual for 5.4) (${before} -> ${!before})`);
	await S(page, () => window.__stores.paneLocks.togglePaneLock('code', true));
	await page.waitForTimeout(200);
	const lockedState = await leftOpen();
	await handle.click();
	await page.waitForTimeout(300);
	h.check((await leftOpen()) === lockedState, '5.3 locked, a press changes nothing');
	h.check((await handle.getAttribute('aria-label'))?.includes('locked'), '5.4 ...and the handle says the sidebars are locked');
	await S(page, () => window.__stores.paneLocks.togglePaneLock('code', false));

	await h.finish(browser);
});
