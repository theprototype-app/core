// 36-fb-code (F5-F9): THE CODE WORKSPACE'S SIDEBARS, TAB STRIP AND THE PLAYER NODE'S CODE, on the
// real Mini Golf scene and two peers.
//   1 F5  the Player node (a Character Controller, inside a collapsed group) opens its code on
//         double-click; Ctrl+S saves it on both peers, the runtime runs it (speed x3), one undo
//         reverts; "Engine source" shows the core file read-only; a node with no code still
//         opens nothing
//   2 F8  many tabs: the strip overflows, the wheel scrolls it, a thin scrollbar shows, the
//         active tab is scrolled into view, a real-mouse drag reorders, a click still activates
//   3 F6  left sidebar: Open editors in strip order (drag there reorders the strip too), the
//         separator, the Project tree (Graphs / Script files / Module sources), search, a
//         read-only module file + "Make editable copy", Ctrl+B collapses, the width persists
//   4 F7  right sidebar: Outline jumps to a handler, Problems lists a typed syntax error (badge),
//         Bound nodes selects the node in the editor, Ctrl+Shift+F finds across files and a hit
//         opens at its line; Ctrl+Alt+B collapses
//   6 S8  undo/redo of saved code edits on two peers, a peer's edit in an open tab
//     S7  closing with unsaved code asks (✕ and beforeunload), Ctrl+P quick open, Ctrl+Shift+O symbol
//     S12 keyboard: tab strip ←/→ + Delete (one tab stop), Open editors ↓, Project tree ↓ ←/→, tool tabs
//   5 F9  floating: the same chrome in the window, tabs clickable there, narrow = overlays;
//         screenshots dark + light (CS_SHOTS=<dir>)
// Scene: MINIGOLF_TPSCENE (else the sibling scenes checkout). Skips, never fails, without one.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const TPSCENE = [process.env.MINIGOLF_TPSCENE, path.resolve(__dirname, '../../../scenes/games/mini-golf/scene.tpscene')]
	.filter(Boolean)
	.find((p) => fs.existsSync(p));
const SHOTS = process.env.CS_SHOTS || '';
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name) });

const S = (page, fn, arg) => page.evaluate(fn, arg);
/** a store under window.__stores, by dotted path */
const read = (page, p) =>
	page.evaluate((p) => {
		let obj = window.__stores;
		for (const k of p.split('.')) obj = obj[k];
		let v;
		obj.subscribe((x) => (v = x))();
		return JSON.parse(JSON.stringify(v ?? null));
	}, p);
const tabs = (page) => read(page, 'codeWorkspace.codeTabs');
const tabIds = async (page) => (await tabs(page)).map((t) => t.id);
const nodeData = (page, id) =>
	page.evaluate((id) => {
		let g;
		window.__stores.flowGraphs.subscribe((v) => (g = v))();
		for (const doc of Object.values(g)) {
			const n = doc.nodes.find((x) => x.id === id);
			if (n) return JSON.parse(JSON.stringify(n.data));
		}
		return null;
	}, id);
async function waitFor(fn, pred, ms = 15000) {
	const end = Date.now() + ms;
	let v;
	while (Date.now() < end) {
		v = await fn().catch(() => undefined);
		if (pred(v)) return v;
		await new Promise((r) => setTimeout(r, 250));
	}
	return v;
}

async function loadGolf(page) {
	await page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, Array.from(fs.readFileSync(TPSCENE)));
	await page.waitForTimeout(2500);
}

h.run(async () => {
	if (!TPSCENE) {
		console.log('SKIP: no authored games/mini-golf/scene.tpscene (set MINIGOLF_TPSCENE)');
		return;
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const storage = { 'shared:shareNewFiles': 'never' };
	const A = await h.setupPage(browser, 'A', { storage, context: { viewport: { width: 1400, height: 900 } } });
	const B = await h.setupPage(browser, 'B', { storage });
	await h.connect(B, A);
	const page = A.page;
	await loadGolf(page);
	await waitFor(() => nodeData(B.page, 'body'), (d) => !!d, 30000);

	// ------------------------------------------------------------ 1 F5 the Player node's code
	await page.locator('p[title="Node editor (N)"]').click();
	await page.waitForTimeout(1200);
	await S(page, () => window.__stores.bottomDock.dockHeight.set(560));
	const center = (id) =>
		S(page, (id) => {
			let ns;
			window.__stores.flowNodes.subscribe((v) => (ns = v))();
			const n = ns.find((x) => x.id === id);
			window.__flowViewport?.setViewport({ x: -n.position.x + 300, y: -n.position.y + 120, zoom: 1 });
		}, id);
	const group = await S(page, () => {
		let ns;
		window.__stores.flowNodes.subscribe((v) => (ns = v))();
		return ns.find((n) => (n.data?.children ?? []).includes('body'))?.id ?? null;
	});
	h.check(!!group, 'premise: the Player sits inside a group (' + group + ')');
	await center(group);
	await page.waitForTimeout(600);
	const gb = await page.locator(`.svelte-flow__node[data-id="${group}"]`).boundingBox();
	await page.mouse.dblclick(gb.x + gb.width / 2, gb.y + 10);
	await page.waitForTimeout(1200);
	await center('body');
	await page.waitForTimeout(800);
	const pb = await page.locator('.svelte-flow__node[data-id="body"]').boundingBox();
	await page.mouse.dblclick(pb.x + pb.width / 2, pb.y + 8);
	let list = await waitFor(() => tabs(page), (t) => t?.length === 1);
	const playerTab = list?.[0];
	h.check(playerTab?.kind === 'node' && playerTab?.nodeType === 'charcontroller' && playerTab?.nodeId === 'body', 'F5: double-click on "Player: walk" opens its code in the workspace');
	h.check(/Player — this Character Controller's code/.test(playerTab?.code ?? ''), 'F5: an unsaved Player shows the template');
	await page.locator('#code-ws-dock').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
	h.check(await page.locator('#code-ws-builtin-help').isVisible().catch(() => false), 'F5: the tab says what the code receives and returns');
	await shot(page, '10-after-player-code-dark.png');
	const speedBefore = (await read(page, 'charController.charControl'))?.speed ?? null;
	// type a real change and save it
	const content = page.locator(`[data-pane="${playerTab.id}"] .cm-content`);
	await content.click();
	await page.keyboard.press('Control+A');
	await page.keyboard.insertText('// run three times as fast\nreturn { speed: settings.speed * 3 };\n');
	await page.keyboard.press('Control+S');
	const saved = await waitFor(() => nodeData(page, 'body'), (d) => /settings\.speed \* 3/.test(d?.code ?? ''));
	h.check(!!saved, 'F5: Ctrl+S writes the code onto the node');
	h.check(!!(await waitFor(() => nodeData(B.page, 'body'), (d) => /settings\.speed \* 3/.test(d?.code ?? ''))), 'F5: the code reaches the other peer');
	const ctl = await waitFor(() => read(page, 'charController.charControl'), (c) => c && Math.abs(c.speed - 0.18) < 1e-6, 6000);
	h.check(!!ctl, 'F5: the runtime runs it — the walker speed is 0.06 x 3 = 0.18 (was ' + speedBefore + ', now ' + ctl?.speed + ')');
	const ctlB = await waitFor(() => read(B.page, 'charController.charControl'), (c) => c && Math.abs(c.speed - 0.18) < 1e-6, 6000);
	h.check(!!ctlB, 'F5: the other peer runs the same code (speed ' + ctlB?.speed + ')');
	await S(page, () => window.__stores.history.undo());
	const undone = await waitFor(() => nodeData(B.page, 'body'), (d) => !d?.code);
	h.check(!!undone, 'F5: one undo removes the code on both peers');
	const back = await waitFor(() => read(page, 'charController.charControl'), (c) => c && Math.abs(c.speed - 0.06) < 1e-6, 6000);
	h.check(!!back, 'F5: …and the card\'s own speed is back (0.06)');
	// a broken return is a badge, not a silent no-op
	await S(page, (id) => window.__stores.codeWorkspace.setTabCode(id, 'return { sped: 1 };'), playerTab.id);
	await S(page, (id) => window.__stores.codeWorkspace.saveCodeTab(id), playerTab.id);
	const badge = await waitFor(() => read(page, 'scriptErrors'), (e) => /unknown key "sped"/.test(e?.body ?? ''), 6000);
	h.check(!!badge, 'F5: an unknown returned key shows on the node\'s error badge');
	await S(page, () => window.__stores.history.undo());
	h.check(!!(await waitFor(() => read(page, 'scriptErrors'), (e) => !e?.body, 6000)), 'F5: undoing the bad code clears the badge (no stale error)');
	// Engine source: the core file, read-only
	await S(page, (id) => window.__stores.codeWorkspace.activeCodeTab.set(id), playerTab.id);
	await page.locator('#code-ws-engine').click();
	list = await waitFor(() => tabs(page), (t) => t?.some((x) => x.kind === 'module' && x.name === 'charController.js'));
	const engine = list?.find((x) => x.kind === 'module');
	h.check(!!engine?.readOnly && /KinematicCharacterController|charControl/.test(engine?.code ?? ''), 'F5: "Engine source" opens the core walker code read-only');
	h.check((await page.locator('#code-ws-fork').count()) === 0, 'F5: the engine source offers no copy (nothing could run it)');
	// counterfactual: a node with no code still opens nothing
	const plain = await S(page, () => {
		let ns;
		window.__stores.flowNodes.subscribe((v) => (ns = v))();
		return ns.find((n) => n.type === 'spin' && !n.hidden)?.id ?? null;
	});
	if (plain) {
		const before = (await tabs(page)).length;
		await S(page, async (id) => {
			let ns;
			window.__stores.flowNodes.subscribe((v) => (ns = v))();
			const n = ns.find((x) => x.id === id);
			const { nodeHasCode } = await import('/src/lib/graphContract.js');
			window.__plainHasCode = nodeHasCode(n);
		}, plain);
		h.check((await S(page, () => window.__plainHasCode)) === false && (await tabs(page)).length === before, 'F5 counterfactual: a Spin node has no code to open');
	}

	// ------------------------------------------------------------ 2 F8 the tab strip
	const many = await S(page, async () => {
		const ids = [];
		const nodes = [];
		for (let i = 0; i < 12; i++) {
			const id = 'cs-tab-' + i;
			ids.push(id);
			nodes.push({ id, type: 'script', position: { x: 4000 + i * 10, y: 4000 }, data: { type: 'script', label: 'Script number ' + (i + 1), code: '// script ' + (i + 1) + '\nobject.position.y = ' + i + ';' }, class: 'w-[150px]' });
		}
		window.__stores.flowNodes.update((n) => [...n, ...nodes]);
		await new Promise((r) => setTimeout(r, 300));
		for (const id of ids) await window.__stores.codeWorkspace.openCode({ source: 'script', ref: { nodeId: id, graphId: 'scene' } });
		return ids;
	});
	await page.waitForTimeout(800);
	const strip = page.locator('#code-ws-tabs');
	const sm = await strip.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, sl: el.scrollLeft, sbw: getComputedStyle(el).scrollbarWidth, ox: getComputedStyle(el).overflowX }));
	h.check(sm.sw > sm.cw, 'F8: with ' + (await tabs(page)).length + ' tabs the strip overflows (' + sm.sw + ' > ' + sm.cw + ')');
	h.check(sm.sbw === 'thin' && sm.ox === 'auto', 'F8: the strip shows a THIN scrollbar (scrollbar-width ' + sm.sbw + ')');
	const inView = () =>
		strip.evaluate((el) => {
			let active;
			window.__stores.codeWorkspace.activeCodeTab.subscribe((v) => (active = v))();
			const tab = el.querySelector(`[data-tab-id="${active}"]`);
			const a = el.getBoundingClientRect();
			const b = tab?.getBoundingClientRect();
			return !!b && b.left >= a.left - 1 && b.right <= a.right + 1;
		});
	h.check(await inView(), 'F8: the active (last opened) tab is scrolled into view');
	await strip.evaluate((el) => (el.scrollLeft = 0));
	const sb = await strip.boundingBox();
	await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
	await page.mouse.wheel(0, 240);
	await page.waitForTimeout(300);
	const sl = await strip.evaluate((el) => el.scrollLeft);
	h.check(sl > 50, 'F8: the mouse wheel scrolls the strip sideways (scrollLeft ' + sl + ')');
	// reopening the FIRST tab scrolls back to it
	const firstId = (await tabs(page)).find((t) => t.nodeId === many[0]).id;
	await S(page, (id) => window.__stores.codeWorkspace.activeCodeTab.set(id), firstId);
	await page.waitForTimeout(400);
	h.check(await inView(), 'F8: activating a scrolled-away tab scrolls it into view');
	// a real-mouse drag reorders; a plain click still activates
	await strip.evaluate((el) => (el.scrollLeft = 0));
	await page.waitForTimeout(200);
	const order0 = await tabIds(page);
	const t0 = await page.locator(`.code-tab[data-tab-id="${order0[0]}"]`).boundingBox();
	const t2 = await page.locator(`.code-tab[data-tab-id="${order0[2]}"]`).boundingBox();
	await page.mouse.move(t0.x + 20, t0.y + t0.height / 2);
	await page.mouse.down();
	for (let i = 1; i <= 8; i++) await page.mouse.move(t0.x + 20 + ((t2.x + t2.width * 0.8 - t0.x - 20) * i) / 8, t0.y + t0.height / 2);
	const marked = await page.locator('.code-tab[data-drop]').count();
	await page.mouse.up();
	await page.waitForTimeout(300);
	const order1 = await tabIds(page);
	h.check(marked === 1, 'F8: while dragging, one drop line marks the gap');
	h.check(order1.indexOf(order0[0]) === 2 && order1[0] === order0[1], 'F8: dragging the first tab past the third reorders the tabs (' + order1.slice(0, 3).map((i) => order0.indexOf(i)).join(',') + ')');
	const t3 = await page.locator(`.code-tab[data-tab-id="${order1[3]}"]`).boundingBox();
	await page.mouse.click(t3.x + 20, t3.y + t3.height / 2);
	await page.waitForTimeout(200);
	h.check((await read(page, 'codeWorkspace.activeCodeTab')) === order1[3], 'F8: a click without travel still activates the tab');
	await shot(page, '11-after-tab-strip-dark.png');

	// ------------------------------------------------------------ 3 F6 the left sidebar
	h.check(await page.locator('#code-ws-left').isVisible(), 'F6: the left sidebar is open by default');
	const openRows = await page.locator('#code-ws-open-editors [data-open-tab]').evaluateAll((els) => els.map((e) => e.getAttribute('data-open-tab')));
	h.check(JSON.stringify(openRows) === JSON.stringify(order1), 'F6: Open editors lists the tabs in the strip\'s order');
	// drag the LAST open-editor row to the top: the strip follows
	await page.locator('#code-ws-open-editors').evaluate((el) => (el.scrollTop = el.scrollHeight));
	const lastRow = await page.locator(`#code-ws-open-editors [data-open-tab="${order1[order1.length - 1]}"]`).boundingBox();
	await page.locator('#code-ws-open-editors').evaluate((el) => (el.scrollTop = 0));
	await page.locator('#code-ws-open-editors').evaluate((el) => (el.scrollTop = el.scrollHeight));
	const firstRowBox = await page.locator(`#code-ws-open-editors [data-open-tab="${order1[1]}"]`).boundingBox();
	if (lastRow && firstRowBox) {
		await page.mouse.move(lastRow.x + 30, lastRow.y + lastRow.height / 2);
		await page.mouse.down();
		for (let i = 1; i <= 10; i++) await page.mouse.move(lastRow.x + 30, lastRow.y + lastRow.height / 2 + ((firstRowBox.y + 2 - lastRow.y - lastRow.height / 2) * i) / 10);
		await page.mouse.up();
		await page.waitForTimeout(300);
	}
	const order2 = await tabIds(page);
	h.check(order2.indexOf(order1[order1.length - 1]) < order1.length - 1, 'F6: dragging in Open editors moves the tab (now at ' + order2.indexOf(order1[order1.length - 1]) + ')');
	const stripOrder = await page.locator('#code-ws-tabs .code-tab').evaluateAll((els) => els.map((e) => e.getAttribute('data-tab-id')));
	h.check(JSON.stringify(stripOrder) === JSON.stringify(order2), 'F6: …and the tab strip shows the same order');
	// the separator
	const split0 = await read(page, 'codeSidebars.codeLeftSplit');
	const sep = await page.locator('#code-ws-left-split').boundingBox();
	await page.mouse.move(sep.x + sep.width / 2, sep.y + 2);
	await page.mouse.down();
	await page.mouse.move(sep.x + sep.width / 2, sep.y + 60, { steps: 6 });
	await page.mouse.up();
	const split1 = await read(page, 'codeSidebars.codeLeftSplit');
	h.check(split1 > split0 + 0.05, 'F6: dragging the separator gives Open editors more room (' + split0.toFixed(2) + ' -> ' + split1.toFixed(2) + ')');
	// the Project tree
	const project = page.locator('#code-ws-project');
	const groups = await project.locator('.cs-group').evaluateAll((els) => els.map((e) => e.textContent.trim()));
	h.check(groups.some((g) => g.startsWith('Graphs')) && groups.some((g) => g.startsWith('Script files')) && groups.some((g) => g.startsWith('Module sources')), 'F6: Project groups Graphs / Script files / Module sources (' + groups.length + ' groups)');
	h.check((await project.locator('[data-tree-key="n:scene:body"]').count()) === 1, 'F6: the Player\'s code is listed under the Main graph');
	h.check((await project.locator('[data-tree-key="n:scene:rules"]').count()) === 1, 'F6: so are the behaviour (Golf rules) and the scripts');
	await page.locator('#code-ws-project-search').fill('player');
	await page.waitForTimeout(200);
	const leaves = await project.locator('.cs-leaf').evaluateAll((els) => els.map((e) => e.getAttribute('data-tree-key')));
	h.check(leaves.length === 1 && leaves[0] === 'n:scene:body', 'F6: searching "player" leaves only the Player (' + leaves.join(',') + ')');
	await page.locator('#code-ws-project-search').fill('');
	// a read-only module source and its editable copy
	// module folders start collapsed: open the first one
	await project.locator('[data-tree-key^="mod:"]').first().click();
	await page.waitForTimeout(600);
	const kitKey = await project.locator('[data-tree-key^="m:"]').first().getAttribute('data-tree-key', { timeout: 8000 }).catch(() => null);
	h.check(!!kitKey, 'F6: a module source the game uses is listed (' + kitKey + ')');
	await project.locator(`[data-tree-key="${kitKey}"]`).click();
	list = await waitFor(() => tabs(page), (t) => t?.some((x) => x.kind === 'module' && 'm:' + x.moduleId + '/' + x.name === kitKey));
	const modTab = list?.find((x) => x.kind === 'module' && 'm:' + x.moduleId + '/' + x.name === kitKey);
	h.check(!!modTab?.readOnly, 'F6: clicking it opens it READ-ONLY');
	h.check((await project.locator(`.cs-on [data-tree-key="${kitKey}"]`).count()) === 1, 'F6: the tree marks the source the active tab shows');
	const itemsBefore = await S(page, () => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return v.length;
	});
	await page.locator('#code-ws-fork').click();
	list = await waitFor(() => tabs(page), (t) => t?.some((x) => x.kind === 'file' && /\(copy\)\.js$/.test(x.title)));
	const copy = list?.find((x) => x.kind === 'file' && /\(copy\)\.js$/.test(x.title));
	h.check(!!copy && !copy.readOnly && copy.code === modTab.code, '"Make editable copy" opens an EDITABLE file with the module\'s text (' + copy?.title + ')');
	const itemsAfter = await S(page, () => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return v.length;
	});
	h.check(itemsAfter === itemsBefore + 1, 'F6: …stored in the Library (' + itemsBefore + ' -> ' + itemsAfter + ' items)');
	h.check((await project.locator(`[data-tree-key="f:${copy.itemId}"]`).count()) === 1, 'F6: …and listed under Script files');
	// collapse + width persistence
	await page.locator('#code-ws-tabs').click({ position: { x: 4, y: 4 } }).catch(() => {});
	await page.keyboard.press('Control+b');
	await page.waitForTimeout(200);
	h.check((await page.locator('#code-ws-left').count()) === 0 && (await read(page, 'codeSidebars.codeLeftOpen')) === false, 'F6: Ctrl+B collapses the left sidebar');
	await page.locator('#code-ws-toggle-left').click();
	await page.waitForTimeout(200);
	h.check(await page.locator('#code-ws-left').isVisible(), 'F6: the header toggle brings it back');
	const lg = await page.locator('.code-side-grip-l').boundingBox();
	const w0 = await read(page, 'codeSidebars.codeLeftWidth');
	await page.mouse.move(lg.x + 3, lg.y + 40);
	await page.mouse.down();
	await page.mouse.move(lg.x + 63, lg.y + 40, { steps: 6 });
	await page.mouse.up();
	const w1 = await read(page, 'codeSidebars.codeLeftWidth');
	h.check(w1 >= w0 + 50, 'F6: dragging its edge widens it (' + w0 + ' -> ' + w1 + ')');
	h.check((await S(page, () => localStorage.getItem('code:leftWidth'))) === String(w1), 'F6: the width is remembered');

	// ------------------------------------------------------------ 4 F7 the right sidebar
	h.check(await page.locator('#code-ws-right').isVisible(), 'F7: the right sidebar is open by default');
	await S(page, () => window.__stores.codeWorkspace.openCode({ source: 'behaviour', ref: { nodeId: 'rules', graphId: 'scene' } }));
	await page.locator('#code-ws-right [data-panel="outline"]').click();
	const handlers = await waitFor(() => page.locator('#code-ws-outline [data-outline="handler"]').count(), (n) => n > 0);
	h.check(handlers > 0, 'F7: Outline lists the Golf rules behaviour\'s handlers (' + handlers + ')');
	const params = await page.locator('#code-ws-outline [data-outline="param"]').count();
	h.check(params > 0, 'F7: …and its params (' + params + ')');
	const hRow = page.locator('#code-ws-outline [data-outline="handler"]').last();
	const hLine = Number(await hRow.getAttribute('data-line'));
	await hRow.click();
	const reveal = await waitFor(() => read(page, 'codeWorkspace.codeRevealLine'), (r) => r?.line === hLine);
	h.check(!!reveal, 'F7: clicking a handler jumps the editor to its line (' + hLine + ')');
	const cursorLine = await waitFor(
		() => page.evaluate(() => document.querySelector('.code-pane:not(.hidden) .cm-activeLineGutter')?.textContent?.trim() ?? ''),
		(t) => Number(t) === hLine,
		4000
	);
	h.check(Number(cursorLine) === hLine, 'F7: …the cursor is on that line (' + cursorLine + ')');
	await shot(page, '12-after-outline-dark.png');
	// Problems: a syntax error typed into a script tab, unsaved
	const scriptTab = (await tabs(page)).find((t) => t.nodeId === many[3]);
	await S(page, (id) => window.__stores.codeWorkspace.setTabCode(id, 'const a = ;\nreturn {'), scriptTab.id);
	await page.locator('#code-ws-right [data-panel="problems"]').click();
	const errs = await waitFor(() => page.locator(`#code-ws-problems .rs-problem[data-severity="error"][data-tab="${scriptTab.id}"]`).count(), (n) => n > 0);
	h.check(errs > 0, 'F7: Problems lists the syntax error of an open, unsaved file');
	const badgeN = Number(await page.locator('#code-ws-right [data-panel="problems"] .rs-badge').getAttribute('data-count'));
	h.check(badgeN >= 1, 'F7: the Problems tab carries a count badge (' + badgeN + ')');
	await S(page, (id) => window.__stores.codeWorkspace.setTabCode(id, 'const x = Math.random();\nobject.position.y = x;'), scriptTab.id);
	const warns = await waitFor(() => page.locator(`#code-ws-problems .rs-problem[data-severity="warning"][data-tab="${scriptTab.id}"]`).count(), (n) => n > 0);
	h.check(warns > 0, 'F7: …and lint advice (Math.random breaks peer sync) as a warning');
	await page.locator(`#code-ws-problems .rs-problem[data-tab="${scriptTab.id}"]`).first().click();
	h.check((await read(page, 'codeWorkspace.activeCodeTab')) === scriptTab.id, 'F7: clicking a problem opens its file');
	await shot(page, '13-after-problems-dark.png');
	await S(page, (id) => window.__stores.codeWorkspace.reloadCodeTab(id), scriptTab.id);
	// Bound nodes: the Player tab -> the node, selected inside its group
	await S(page, (id) => window.__stores.codeWorkspace.activeCodeTab.set(id), playerTab.id);
	await page.locator('#code-ws-right [data-panel="bound"]').click();
	h.check((await page.locator('#code-ws-bound [data-bound-node="body"]').count()) === 1, 'F7: Bound nodes names the node the Player tab edits');
	// leave the group first, so the click has to enter it
	await S(page, () => window.__stores.flowNodes.update((ns) => ns.map((n) => ({ ...n, selected: false }))));
	await page.keyboard.press('Escape');
	await page.locator('#code-ws-bound [data-bound-node="body"]').click();
	const sel = await waitFor(
		() => S(page, () => {
			let ns;
			window.__stores.flowNodes.subscribe((v) => (ns = v))();
			return ns.filter((n) => n.selected).map((n) => n.id);
		}),
		(s) => Array.isArray(s) && s.length === 1 && s[0] === 'body',
		6000
	);
	h.check(Array.isArray(sel) && sel[0] === 'body', 'F7: clicking it SELECTS the node in the Node editor (' + JSON.stringify(sel) + ')');
	h.check(await page.locator('.svelte-flow__node[data-id="body"]').isVisible(), 'F7: …entering its group so it is on screen');
	// going to the node showed the Node editor in the dock; bring the Code tab back
	await S(page, () => window.__stores.bottomDock.activateDock('code'));
	await page.waitForTimeout(500);
	// Find in files: Ctrl+Shift+F, a word from the behaviour, a hit opens at its line
	await page.locator(`[data-pane="${playerTab.id}"] .cm-content`).click();
	await page.keyboard.press('Control+Shift+F');
	await page.waitForTimeout(300);
	h.check((await read(page, 'codeSidebars.codeRightPanel')) === 'find' && (await page.evaluate(() => document.activeElement?.id)) === 'code-ws-find', 'F7: Ctrl+Shift+F opens Find with its box focused');
	await page.keyboard.insertText('shots');
	const total = await waitFor(() => page.locator('#code-ws-find-summary').getAttribute('data-total').then(Number), (n) => n > 0, 10000);
	h.check(total > 0, 'F7: Find in files finds "shots" (' + total + ' results)');
	const hit = page.locator('#code-ws-find-results .rs-hit').first();
	const hitLine = Number(await hit.getAttribute('data-line'));
	const hitKey = await hit.getAttribute('data-hit-key');
	await hit.click();
	const hr = await waitFor(() => read(page, 'codeWorkspace.codeRevealLine'), (r) => r?.line === hitLine);
	h.check(!!hr, 'F7: a hit opens its file at line ' + hitLine + ' (' + hitKey + ')');
	await page.locator('#code-ws-find').fill('kinematiccharactercontroller');
	await page.locator('#code-ws-find-modules').click();
	await page.waitForTimeout(800);
	const without = Number(await page.locator('#code-ws-find-summary').getAttribute('data-total'));
	await page.locator('#code-ws-find-modules').click();
	await waitFor(() => page.locator('#code-ws-find-summary').getAttribute('data-total').then(Number), (n) => n > without, 8000);
	await shot(page, '14-after-find-dark.png');
	await page.locator(`[data-pane="${playerTab.id}"] .cm-content`).click().catch(() => {});
	await page.keyboard.press('Control+Alt+b');
	await page.waitForTimeout(200);
	h.check((await page.locator('#code-ws-right').count()) === 0, 'F7: Ctrl+Alt+B collapses the right sidebar');
	await page.keyboard.press('Control+Alt+b');
	await page.waitForTimeout(200);

	// ------------------------------------------------------------ 6 S8 undo/redo + peers · S7 guard + quick picks · S12 keys
	const undoNode = { id: 'cs-undo', type: 'script', position: { x: 4200, y: 4300 }, data: { type: 'script', label: 'Undo me', code: 'object.position.y = 1;' }, class: 'w-[150px]' };
	await S(page, (node) => {
		window.__stores.flowNodes.update((n) => [...n, node]);
		let p;
		window.__stores.peers.subscribe((v) => (p = v))();
		p.send({ type: 'nodecreate', node });
	}, undoNode);
	h.check(!!(await waitFor(() => nodeData(B.page, 'cs-undo'), (d) => !!d)), 'S8 premise: the peer holds the script node');
	const uTab = await S(page, () => window.__stores.codeWorkspace.openCode({ source: 'script', ref: { nodeId: 'cs-undo', graphId: 'scene' } }));
	await page.waitForTimeout(500);
	const typeInto = async (tabId, text) => {
		await page.locator(`[data-pane="${tabId}"] .cm-content`).click();
		await page.keyboard.press('Control+A');
		await page.keyboard.insertText(text);
	};
	await typeInto(uTab, 'object.position.y = 2;');
	await page.keyboard.press('Control+S');
	h.check(!!(await waitFor(() => nodeData(B.page, 'cs-undo'), (d) => /= 2;/.test(d?.code ?? ''))), 'S8: a typed + saved edit reaches the peer');
	await typeInto(uTab, 'object.position.y = 3;');
	await page.keyboard.press('Control+S');
	h.check(!!(await waitFor(() => nodeData(B.page, 'cs-undo'), (d) => /= 3;/.test(d?.code ?? ''))), 'S8: a second save reaches the peer');
	await S(page, () => window.__stores.history.undo());
	h.check(!!(await waitFor(() => nodeData(B.page, 'cs-undo'), (d) => /= 2;/.test(d?.code ?? ''))), 'S8: undo steps back ONE save, on the peer too (= 2)');
	const tabAfterUndo = await waitFor(() => tabs(page), (t) => /= 2;/.test(t.find((x) => x.id === uTab)?.code ?? ''));
	h.check(!!tabAfterUndo && !(tabAfterUndo.find((x) => x.id === uTab)?.stale), 'S8: …and the open tab follows the undo (clean, not stale)');
	await S(page, () => window.__stores.history.undo());
	h.check(!!(await waitFor(() => nodeData(B.page, 'cs-undo'), (d) => /= 1;/.test(d?.code ?? ''))), 'S8: a second undo restores the original (= 1) everywhere');
	await S(page, () => window.__stores.history.redo());
	await S(page, () => window.__stores.history.redo());
	h.check(!!(await waitFor(() => nodeData(B.page, 'cs-undo'), (d) => /= 3;/.test(d?.code ?? ''))), 'S8: two redos bring back the last save on the peer (= 3)');
	h.check(!!(await waitFor(() => tabs(page), (t) => /= 3;/.test(t.find((x) => x.id === uTab)?.code ?? ''))), 'S8: …and in the tab');
	// a peer's edit while our tab is clean: the tab follows
	await B.page.evaluate(() => window.__stores.nodesHandler.setNodeData('cs-undo', { code: 'object.position.y = 4; // from B' }, 'scene'));
	h.check(!!(await waitFor(() => tabs(page), (t) => /from B/.test(t.find((x) => x.id === uTab)?.code ?? ''))), 'S8: a peer\'s edit shows up in the open (clean) tab');

	// S7: closing the workspace with unsaved code asks
	await S(page, (id) => window.__stores.codeWorkspace.setTabCode(id, 'object.position.y = 5;'), uTab);
	const beforeUnload = await S(page, () => {
		const ev = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(ev);
		return ev.defaultPrevented;
	});
	h.check(beforeUnload === true, 'S7: leaving the page with unsaved code asks (beforeunload)');
	await page.locator('#code-ws-close').click();
	await page.waitForTimeout(300);
	h.check(await page.locator('#code-ws-confirm-all').isVisible(), 'S7: ✕ with an unsaved file asks Save all / Don\'t save / Cancel');
	await page.locator('#code-ws-confirm-all-cancel').click();
	h.check((await read(page, 'codeWorkspaceClose')) === false && (await page.locator('#code-ws-confirm-all').count()) === 0, 'S7: Cancel keeps the workspace open');
	await page.locator('#code-ws-close').click();
	await page.locator('#code-ws-confirm-all-save').click();
	await page.waitForTimeout(500);
	h.check((await read(page, 'codeWorkspaceClose')) === true, 'S7: Save all closes it');
	h.check(!!(await waitFor(() => nodeData(B.page, 'cs-undo'), (d) => /= 5;/.test(d?.code ?? ''))), 'S7: …having saved the file (the peer has it)');
	await S(page, () => window.__stores.codeWorkspace.openCode({ source: 'script', ref: { nodeId: 'cs-undo', graphId: 'scene' } }));
	await page.waitForTimeout(600);
	await S(page, (id) => window.__stores.codeWorkspace.setTabCode(id, 'object.position.y = ;'), uTab);
	await page.locator('#code-ws-close').click();
	await page.locator('#code-ws-confirm-all-save').click();
	await page.waitForTimeout(500);
	h.check((await read(page, 'codeWorkspaceClose')) === false && /could not be saved/.test(await page.locator('#code-ws-confirm-all').innerText()), 'S7: code that does not check is not saved — the dialog stays and says why');
	await page.locator('#code-ws-confirm-all-discard').click();
	await page.waitForTimeout(400);
	h.check((await read(page, 'codeWorkspaceClose')) === true && (await read(page, 'codeWorkspace.codeTabs')).every((t) => t.code === t.saved || t.readOnly), 'S7: Don\'t save closes and throws the edits away');
	await S(page, () => window.__stores.codeWorkspace.openCode({ source: 'script', ref: { nodeId: 'cs-undo', graphId: 'scene' } }));
	await page.waitForTimeout(600);
	h.check((await S(page, () => {
		const ev = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(ev);
		return ev.defaultPrevented;
	})) === false, 'S7 counterfactual: with nothing unsaved, leaving the page does not ask');

	// S7: Ctrl+P quick open, Ctrl+Shift+O go to symbol
	await page.locator(`[data-pane="${uTab}"] .cm-content`).click();
	await page.keyboard.press('Control+p');
	await page.waitForTimeout(300);
	h.check(await page.locator('#code-ws-quick-open').isVisible(), 'S7: Ctrl+P opens quick open');
	await page.keyboard.insertText('playwalk');
	await page.waitForTimeout(200);
	const firstOpt = await page.locator('#code-ws-quick-open [role="option"]').first().getAttribute('data-key');
	h.check(firstOpt === 'n:scene:body', 'S7: "playwalk" ranks the Player first (' + firstOpt + ')');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(400);
	const activeNow = await read(page, 'codeWorkspace.activeCodeTab');
	h.check((await tabs(page)).find((t) => t.id === activeNow)?.nodeId === 'body' && (await page.locator('#code-ws-quick-open').count()) === 0, 'S7: Enter opens it and closes the picker');
	const rulesTab = await S(page, () => window.__stores.codeWorkspace.openCode({ source: 'behaviour', ref: { nodeId: 'rules', graphId: 'scene' } }));
	await page.waitForTimeout(400);
	await page.locator(`[data-pane="${rulesTab}"] .cm-content`).click();
	await page.keyboard.press('Control+Shift+O');
	await page.waitForTimeout(300);
	h.check(await page.locator('#code-ws-quick-symbol').isVisible(), 'S7: Ctrl+Shift+O lists the file\'s symbols');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	const symDetail = await page.locator('#code-ws-quick-symbol [aria-selected="true"] .qp-detail').innerText();
	const symLine = Number(/line (\d+)/.exec(symDetail)?.[1]);
	await page.keyboard.press('Enter');
	h.check(!!(await waitFor(() => read(page, 'codeWorkspace.codeRevealLine'), (r) => r?.tabId === rulesTab && r?.line === symLine)), 'S7: ↓↓ Enter jumps to that symbol\'s line (' + symLine + ')');
	await page.keyboard.press('Escape');

	// S12: the keyboard reaches everything
	const stripIds = await tabIds(page);
	const focusTab = stripIds[1];
	await S(page, (id) => window.__stores.codeWorkspace.activeCodeTab.set(id), focusTab);
	await page.waitForTimeout(200);
	await page.locator(`.code-tab[data-tab-id="${focusTab}"]`).focus();
	await page.keyboard.press('ArrowRight');
	await page.waitForTimeout(200);
	h.check((await read(page, 'codeWorkspace.activeCodeTab')) === stripIds[2] && (await page.evaluate(() => document.activeElement?.getAttribute('data-tab-id'))) === stripIds[2], 'S12: → in the tab strip moves to (and activates) the next tab');
	h.check((await page.locator('.code-tab[tabindex="0"]').count()) === 1, 'S12: the strip is ONE tab stop (roving tabindex)');
	const before12 = (await tabIds(page)).length;
	await page.keyboard.press('Delete');
	await page.waitForTimeout(300);
	h.check((await tabIds(page)).length === before12 - 1, 'S12: Delete closes the focused (clean) tab');
	await page.locator('#code-ws-open-editors .cs-open .cs-leaf[tabindex="0"]').focus();
	const r0 = await page.evaluate(() => document.activeElement?.closest('[data-open-tab]')?.getAttribute('data-open-tab'));
	await page.keyboard.press('ArrowDown');
	const r1 = await page.evaluate(() => document.activeElement?.closest('[data-open-tab]')?.getAttribute('data-open-tab'));
	h.check(!!r0 && !!r1 && r0 !== r1, 'S12: ↓ moves through Open editors');
	const firstTree = page.locator('#code-ws-project button[data-tree-key]').first();
	await firstTree.focus();
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	const onKey = await page.evaluate(() => document.activeElement?.getAttribute('data-tree-key'));
	h.check(!!onKey && onKey !== (await firstTree.getAttribute('data-tree-key')), 'S12: ↓ moves through the Project tree (' + onKey + ')');
	const modGroup = page.locator('#code-ws-project button[data-tree-key^="mod:"]').last();
	await modGroup.focus();
	const wasOpen = (await modGroup.getAttribute('aria-expanded')) === 'true';
	await page.keyboard.press(wasOpen ? 'ArrowLeft' : 'ArrowRight');
	await page.waitForTimeout(300);
	h.check(((await modGroup.getAttribute('aria-expanded')) === 'true') !== wasOpen, 'S12: ←/→ close and open a folder (aria-expanded flips)');
	h.check((await page.locator('#code-ws-project [role="treeitem"][aria-level]').count()) > 3, 'S12: tree rows are treeitems with aria-level');
	await page.locator('#code-ws-right .rs-tab[tabindex="0"]').focus();
	const p0 = await read(page, 'codeSidebars.codeRightPanel');
	await page.keyboard.press('ArrowRight');
	const p1 = await read(page, 'codeSidebars.codeRightPanel');
	h.check(p0 !== p1 && (await page.evaluate(() => document.activeElement?.getAttribute('role'))) === 'tab', 'S12: → switches the right sidebar\'s panel (' + p0 + ' -> ' + p1 + ')');
	h.check((await page.locator('#code-ws-rpanel[role="tabpanel"]').count()) === 1, 'S12: the panel is a labelled tabpanel');

	// ------------------------------------------------------------ 5 F9 floating + themes
	await S(page, () => window.__stores.themes.theme.set('light'));
	await page.waitForTimeout(500);
	await shot(page, '15-after-workspace-light.png');
	const lightBg = await page.locator('#code-ws-left').evaluate((el) => getComputedStyle(el).backgroundColor);
	h.check(/rgb\((2[0-5]\d|1[89]\d), /.test(lightBg), 'F9: the sidebars follow the light theme (' + lightBg + ')');
	await S(page, () => window.__stores.themes.theme.set('dark'));
	await page.waitForTimeout(300);
	await page.locator('#code-ws-dock button[title="Undock into a floating window"]').click();
	await page.waitForTimeout(800);
	h.check(await page.locator('#code-ws-window #code-ws-left').isVisible() && (await page.locator('#code-ws-window #code-ws-right').count()) === 1, 'F9: floating, the window has both sidebars');
	const ftabs = await tabIds(page);
	const ft = await page.locator(`#code-ws-window .code-tab[data-tab-id="${ftabs[1]}"]`).boundingBox();
	await page.mouse.click(ft.x + 20, ft.y + ft.height / 2);
	await page.waitForTimeout(200);
	h.check((await read(page, 'codeWorkspace.activeCodeTab')) === ftabs[1], 'F9: floating, a tab click activates it (the strip is outside the drag handle)');
	await shot(page, '16-after-floating-dark.png');
	await S(page, () => window.__stores.themes.theme.set('light'));
	await page.waitForTimeout(400);
	await shot(page, '17-after-floating-light.png');
	await S(page, () => window.__stores.themes.theme.set('dark'));
	// narrow: the sidebars overlay the editor instead of squeezing it
	const win = page.locator('#code-ws-window');
	const wb = await win.boundingBox();
	const grip = await win.locator('.resize-cue').boundingBox();
	await page.mouse.move(grip.x + 4, grip.y + 4);
	await page.mouse.down();
	await page.mouse.move(grip.x + 4 - (wb.width - 480), grip.y + 4, { steps: 8 });
	await page.mouse.up();
	await page.waitForTimeout(400);
	h.check((await page.locator('#code-ws-window .code-main.code-narrow').count()) === 1, 'F9: a narrow window switches the sidebars to overlays');
	h.check((await page.locator('#code-ws-window #code-ws-left').count()) === 0, 'F9: …closed until asked for');
	await page.locator('#code-ws-window #code-ws-toggle-left').click();
	await page.waitForTimeout(300);
	const ov = await page.locator('#code-ws-window .code-side-left').evaluate((el) => getComputedStyle(el).position);
	h.check(ov === 'absolute', 'F9: …and the toggle opens one as an overlay');
	await shot(page, '18-after-floating-narrow-dark.png');
	await page.locator('#code-ws-window button[title="Dock to the bottom"]').click();
	await page.waitForTimeout(400);

	await h.finish(browser);
});
