// 50 Y1 + Y2 — SHARED TEXT IN THE CODE TAB (Yjs over the room's data channels), three peers.
//   1 A and B open the same Script node; both type in ONE line at once; both keep their text
//     (v1.41.0: two separate buffers — A's Ctrl+S writes only A's edit, last writer wins)
//   2 the other person's cursor and selection, in their colour, named for a screen reader
//   3 saving is unchanged: Ctrl+S writes plain text to the node on every peer; B's tab is clean
//   4 a late joiner (C) gets the CURRENT text, unsaved edits included
//   5 a viewer's editor is read-only (C demoted): its keys change nothing anywhere
// Y2 (Explorer text documents) is shared-text-doc — split for the runner's 8-minute cap.
const h = require('./helpers.cjs');

const SHOTS = process.env.YJS_SHOTS || '';
const shot = async (page, name) => SHOTS && page.screenshot({ path: SHOTS + '/' + name });

const tabsOf = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.codeWorkspace.codeTabs.subscribe((v) => r(JSON.parse(JSON.stringify(v))))()));
const activeId = (page) => page.evaluate(() => new Promise((r) => window.__stores.codeWorkspace.activeCodeTab.subscribe(r)()));
const nodeCode = (page, id) =>
	page.evaluate(
		(id) =>
			new Promise((r) =>
				window.__stores.flowGraphs.subscribe((all) => {
					for (const g of Object.values(all)) {
						const n = g.nodes.find((x) => x.id === id);
						if (n) return r(n.data?.code ?? null);
					}
					r(null);
				})()
			),
		id
	);
const tabFor = async (page, pred) => (await tabsOf(page)).find(pred) ?? null;
/** the CodeMirror content of the tab matching `pred` */
const paneOf = async (page, pred) => {
	const t = await tabFor(page, pred);
	return t ? page.locator(`[data-pane="${t.id}"]`) : null;
};
const openNodeTab = (page, nodeId) =>
	page.evaluate((nodeId) => window.__stores.codeWorkspace.openCode({ source: 'script', ref: { nodeId } }), nodeId);
/** wait until the tab's editor is bound to the shared document (or time out and let the checks say so) */
async function waitShared(page, pred, label, timeout = 45000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const pane = await paneOf(page, pred);
		if (pane && (await pane.locator('[data-shared="true"]').count())) return true;
		await page.waitForTimeout(300);
	}
	console.log('  (' + label + ': the editor never reported a shared binding)');
	return false;
}
async function caretTo(page, pane, keys) {
	await pane.locator('.cm-content').click();
	for (const k of keys) await page.keyboard.press(k);
}

const LINE1 = 'let speed = 1;';
const START = LINE1 + '\nreturn speed;';
const MERGED = 'let maxspeed = 10;\nreturn speed;';

h.run(async () => {
	const browser = await h.launch();
	const storage = { 'shared:shareNewFiles': 'never' };
	const A = await h.setupPage(browser, 'A', { storage });
	const B = await h.setupPage(browser, 'B', { storage });
	await h.connect(B, A);

	// ---------------------------------------------------------------- the node both edit
	await A.page.evaluate(async (code) => {
		const node = { id: 'yjs1', type: 'script', position: { x: 0, y: 0 }, data: { type: 'script', code }, class: 'w-[150px]' };
		window.__stores.flowNodes.update((n) => [...n, node]);
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		peer.send({ type: 'nodecreate', node });
	}, START);
	await h.eventually(() => nodeCode(B.page, 'yjs1'), (c) => c === START, 'premise: the Script node reached B');

	// ---------------------------------------------------------------- 1 both type in ONE line
	await openNodeTab(A.page, 'yjs1');
	await openNodeTab(B.page, 'yjs1');
	const isNode = (t) => t.nodeId === 'yjs1';
	const aShared = await waitShared(A.page, isNode, 'A');
	const bShared = await waitShared(B.page, isNode, 'B');
	h.check(aShared && bShared, 'both editors bind the node to ONE shared document');
	const paneA = await paneOf(A.page, isNode);
	const paneB = await paneOf(B.page, isNode);
	await caretTo(A.page, paneA, ['Control+Home', 'End', 'ArrowLeft']); // before ';'
	await caretTo(B.page, paneB, ['Control+Home', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight']); // after 'let '
	await Promise.all([A.page.keyboard.insertText('0'), B.page.keyboard.insertText('max')]);
	await h.eventually(
		async () => [(await tabFor(A.page, isNode))?.code, (await tabFor(B.page, isNode))?.code],
		([a, b]) => a === MERGED && b === MERGED,
		'two people typing in one line both keep their text, on both peers ("let maxspeed = 10;")',
		12000
	);
	await shot(A.page, '01-same-line-merge-A.png');

	// ---------------------------------------------------------------- 2 cursor + selection
	const bId = B.id;
	await h.eventually(
		() => A.page.evaluate((id) => document.querySelector(`#code-ws-presence li[data-peer="${id}"]`)?.getAttribute('aria-label') ?? '', bId),
		(label) => /is on line 1/.test(label),
		"A's Code tab names B and B's line for a screen reader (presence strip)",
		10000
	);
	const caret = await paneA.locator('.cm-ySelectionCaret').count();
	h.check(caret >= 1, "B's caret is drawn in A's editor");
	const colours = await A.page.evaluate((id) => {
		const dot = document.querySelector(`#code-ws-presence li[data-peer="${id}"] .code-presence-dot`);
		const caretEl = document.querySelector('.cm-ySelectionCaret');
		return { dot: dot ? getComputedStyle(dot).backgroundColor : '', caret: caretEl ? getComputedStyle(caretEl).backgroundColor : '' };
	}, bId);
	h.check(!!colours.caret && colours.caret === colours.dot, "the caret wears B's colour, the same as B's chip (" + colours.caret + ')');
	await caretTo(B.page, paneB, ['Control+End', 'Home', 'Shift+End']); // select "return speed;"
	await h.eventually(
		() => A.page.evaluate((id) => document.querySelector(`#code-ws-presence li[data-peer="${id}"]`)?.getAttribute('aria-label') ?? '', bId),
		(label) => /line 2, 13 characters selected/.test(label),
		"B's selection reaches A (line 2, 13 characters)",
		10000
	);
	h.check((await paneA.locator('.cm-ySelection').count()) >= 1, "B's selection is highlighted in A's editor");
	await shot(A.page, '02-peer-caret-selection-A.png');

	// ---------------------------------------------------------------- 3 saving is unchanged
	await paneA.locator('.cm-content').click();
	await A.page.keyboard.press('Control+S');
	await h.eventually(
		async () => [await nodeCode(A.page, 'yjs1'), await nodeCode(B.page, 'yjs1')],
		([a, b]) => a === MERGED && b === MERGED,
		"A's Ctrl+S writes the MERGED text to the node on both peers (v1.41.0: only A's own edit)",
		12000
	);
	h.check(typeof (await nodeCode(B.page, 'yjs1')) === 'string', 'the saved source is plain text');
	await h.eventually(
		async () => {
			const t = await tabFor(B.page, isNode);
			return t && { clean: t.code === t.saved, stale: !!t.stale };
		},
		(v) => !!v && v.clean && !v.stale,
		"B's tab reads A's save as a save of the shared buffer: clean, not stale",
		10000
	);

	// ---------------------------------------------------------------- 4 a late joiner
	const UNSAVED = '\n// unsaved, typed by B';
	await caretTo(B.page, paneB, ['Control+End']);
	await B.page.keyboard.insertText(UNSAVED);
	await h.eventually(async () => (await tabFor(A.page, isNode))?.code, (c) => c === MERGED + UNSAVED, "B's unsaved line reaches A", 10000);
	const C = await h.setupPageQuiet(browser, 'C', [A, B], { storage });
	await h.connect(C, A);
	await h.eventually(() => nodeCode(C.page, 'yjs1'), (c) => c === MERGED, 'premise: the late joiner holds the node (its SAVED code)', 20000);
	await openNodeTab(C.page, 'yjs1');
	await waitShared(C.page, isNode, 'C', 60000);
	await h.eventually(
		async () => (await tabFor(C.page, isNode))?.code,
		(c) => c === MERGED + UNSAVED,
		'a late joiner opening the tab gets the CURRENT text, unsaved edits included',
		15000
	);
	const cTab = await tabFor(C.page, isNode);
	h.check(!!cTab && cTab.saved === MERGED && cTab.code !== cTab.saved, "the late joiner's tab says there are unsaved edits (its saved text is the node's)");

	// ---------------------------------------------------------------- 5 a viewer is read-only
	await C.page.evaluate(() => {
		const w = window.__stores;
		w.cloudHooks.rolesInfo.set({ myId: 'c', myRole: 'viewer', amAdmin: false, order: ['viewer', 'editor', 'admin'], roleOf: () => 'viewer', setRole: () => {} });
	});
	const paneC = await paneOf(C.page, isNode);
	await C.page.waitForTimeout(400);
	h.check((await paneC.locator('[data-readonly="true"]').count()) === 1, "a viewer's editor is marked read-only");
	await caretTo(C.page, paneC, ['Control+Home']);
	await C.page.keyboard.insertText('VIEWER');
	await C.page.waitForTimeout(1200);
	const afterViewer = [(await tabFor(C.page, isNode))?.code, (await tabFor(A.page, isNode))?.code];
	h.check(afterViewer.every((c) => c === MERGED + UNSAVED), "a viewer's keys change nothing — on its own screen or anyone else's");
	await C.page.evaluate(() => window.__stores.cloudHooks.rolesInfo.set(null));

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0 && h.pageErrors(C).length === 0, 'no page errors on any peer');
	await h.finish(browser);
});
