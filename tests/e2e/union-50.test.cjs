// 50-int — THE UNION of the roadmap-50 lanes, checked where they meet (none of them could alone):
//   U1 pop-out x Yjs: A pops its Code tab out while B edits the same Script node. The popup's editor is bound to the
//      SAME shared document (50-yjs Q1: one binding per EditorView), B's typing and caret show up INSIDE the popup,
//      A's typing in the popup reaches B, and Dock back keeps the binding (the 2 s release grace).
//   U2 pop-out x accessibility (roadmap 53): the popup follows High contrast and the UI scale set in the app while it
//      is open (the tokens hang off <html> attributes, mirrored), and it has no serious/critical axe violation.
//   U3 Yjs x accessibility: the "Editing with you" strip in the docked Code tab passes the axe gate.
// Counterfactual: on v1.41.0 there is no Pop out button and no shared binding (U1 red at its first check); 50-window
// alone has no [data-shared] editor; 50-yjs alone has no popup.
const h = require('./helpers.cjs');
const { AxeBuilder } = require('@axe-core/playwright');

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
/** serious + critical violations under `include` @param {any} page @param {string} include */
async function axeBad(page, include) {
	const res = await new AxeBuilder({ page }).withTags(TAGS).include(include).analyze();
	return res.violations.filter((/** @type {any} */ v) => v.impact === 'serious' || v.impact === 'critical').map((/** @type {any} */ v) => `${v.id}x${v.nodes.length}`);
}
/** @param {any} page */
const tabsOf = (page) =>
	page.evaluate(() => new Promise((r) => /** @type {any} */ (window).__stores.codeWorkspace.codeTabs.subscribe((/** @type {any} */ v) => r(JSON.parse(JSON.stringify(v))))()));
/** @param {any} page @param {string} id */
const tabCode = async (page, id) => (/** @type {any[]} */ (await tabsOf(page))).find((t) => t.nodeId === id)?.code ?? null;
/** @param {any} page @param {string} nodeId */
const openNodeTab = (page, nodeId) => page.evaluate((nodeId) => /** @type {any} */ (window).__stores.codeWorkspace.openCode({ source: 'script', ref: { nodeId } }), nodeId);
/** the shared editor's pane for node `id` in `page` @param {any} page @param {string} id */
async function pane(page, id) {
	const t = (/** @type {any[]} */ (await tabsOf(page))).find((t) => t.nodeId === id);
	return t ? page.locator(`[data-pane="${t.id}"]`) : null;
}
/** is `p`'s editor for node `id` bound? tab ids come from `ownerPage` (a popup has no __stores) @param {any} p @param {any} ownerPage @param {string} id */
async function shared(p, ownerPage, id, timeout = 45000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const t = (/** @type {any[]} */ (await tabsOf(ownerPage))).find((t) => t.nodeId === id);
		if (t && (await p.locator(`[data-pane="${t.id}"] [data-shared="true"]`).count())) return true;
		await p.waitForTimeout(300);
	}
	return false;
}
/** @param {any} page */
const mainWorkspaceShown = (page) => page.locator('#code-ws-dock:visible, #code-ws-window:visible').count();

const START = 'let speed = 1;\nreturn speed;';

h.run(async () => {
	const browser = await h.launch();
	const storage = { 'shared:shareNewFiles': 'never' };
	const A = await h.setupPage(browser, 'A', { storage, context: { viewport: { width: 1440, height: 900 } } });
	const B = await h.setupPage(browser, 'B', { storage });
	await h.connect(B, A);

	await A.page.evaluate(async (code) => {
		const s = /** @type {any} */ (window).__stores;
		const node = { id: 'u50', type: 'script', position: { x: 0, y: 0 }, data: { type: 'script', code }, class: 'w-[150px]' };
		s.flowNodes.update((/** @type {any[]} */ n) => [...n, node]);
		const peer = await new Promise((r) => s.peers.subscribe(r)());
		/** @type {any} */ (peer).send({ type: 'nodecreate', node });
	}, START);
	await h.eventually(
		() => B.page.evaluate(() => new Promise((r) => /** @type {any} */ (window).__stores.flowGraphs.subscribe((/** @type {any} */ all) => r(Object.values(all).some((g) => /** @type {any} */ (g).nodes.some((/** @type {any} */ n) => n.id === 'u50'))))())),
		(v) => v === true,
		'premise: the Script node reached B'
	);
	await openNodeTab(A.page, 'u50');
	await openNodeTab(B.page, 'u50');
	const t0 = Date.now();
	const bound = { A: await shared(A.page, A.page, 'u50'), B: await shared(B.page, B.page, 'u50'), ms: 0 };
	bound.ms = Date.now() - t0;
	h.check(bound.A && bound.B, `premise: both docked editors are bound to the shared document (${JSON.stringify(bound)})`);

	// ---- U3: the presence strip passes the axe gate (docked) ------------------------------------------------------
	await h.eventually(() => A.page.locator('#code-ws-presence li').count(), (n) => n >= 1, 'premise: A shows the "Editing with you" strip', 15000);
	const badStrip = await axeBad(A.page, '#code-ws-presence');
	h.check(badStrip.length === 0, `U3: the "Editing with you" strip has no serious/critical axe violation (${badStrip.join(', ') || 'none'})`);

	// ---- U1: pop out while shared -------------------------------------------------------------------------------
	const hasButton = (await A.page.locator('#code-ws-popout').count()) > 0;
	h.check(hasButton, 'U1: the shared Code tab offers Pop out (COUNTERFACTUAL: v1.41.0 has none)');
	if (!hasButton) return h.finish(browser);
	const [pop] = await Promise.all([A.page.context().waitForEvent('page', { timeout: 20000 }), A.page.locator('#code-ws-popout').first().click()]);
	await pop.waitForSelector('#code-ws-popped .cm-content', { timeout: 30000 });
	h.check(await shared(pop, A.page, 'u50'), "U1: the popup's editor is bound to the same shared document ([data-shared])");
	const paneB = await pane(B.page, 'u50');
	if (!paneB) throw new Error("B's tab vanished");
	await paneB.locator('.cm-content').click();
	await B.page.keyboard.press('Control+End');
	await B.page.keyboard.insertText('\n// from B');
	await h.eventually(() => pop.locator('#code-ws-popped .cm-content').innerText(), (t) => /\/\/ from B/.test(t), "U1: B's typing shows up in A's popped-out editor", 12000);
	await h.eventually(() => pop.locator('#code-ws-popped .cm-ySelectionCaret').count(), (n) => n >= 1, "U1: B's caret is drawn INSIDE the popup (y-codemirror's DOM adopted into the popup document)", 10000);
	const tabA = (/** @type {any[]} */ (await tabsOf(A.page))).find((t) => t.nodeId === 'u50');
	await pop.locator(`#code-ws-popped [data-pane="${tabA?.id}"] .cm-content`).click(); // the popup has no __stores: A's tab id
	await pop.keyboard.press('Control+Home');
	await pop.keyboard.insertText('// from A\n');
	await h.eventually(() => tabCode(B.page, 'u50'), (c) => typeof c === 'string' && c.startsWith('// from A\n') && c.includes('// from B'), "U1: A's typing in the popup reaches B, merged with B's", 12000);

	// ---- U2: High contrast + UI scale reach the popup; axe on the popup ---------------------------------------------
	await A.page.evaluate(() => {
		const s = /** @type {any} */ (window).__stores;
		s.themes.theme.set('contrast');
		s.uiScale.uiScale.set(150);
	});
	await pop.waitForTimeout(500);
	/** @param {any} p */
	const look = (p) =>
		p.evaluate(() => {
			const probe = document.createElement('div');
			probe.style.cssText = 'position:absolute;width:calc(var(--ui-scale, 1) * 100px);background:var(--surface-1)';
			document.body.appendChild(probe);
			const cs = getComputedStyle(probe);
			const out = { theme: document.documentElement.dataset.theme || '', width: parseFloat(cs.width), surface: cs.backgroundColor };
			probe.remove();
			return out;
		});
	const lm = await look(A.page);
	const lp = await look(pop);
	h.check(lp.theme === 'contrast', `U2: High contrast switched on in the app reaches the popup (data-theme ${lp.theme})`);
	h.check(lp.surface === lm.surface, `U2: the popup paints the High contrast surface (${lp.surface} vs app ${lm.surface})`);
	h.check(Math.abs(lp.width - 150) < 0.5 && Math.abs(lm.width - 150) < 0.5, `U2: the popup follows the 150 % UI scale (${lp.width}px probe, app ${lm.width}px)`);
	const badPop = await axeBad(pop, '#code-ws-popped');
	h.check(badPop.length === 0, `U2: the popped-out editor at 150 % in High contrast has no serious/critical axe violation (${badPop.join(', ') || 'none'})`);
	await A.page.evaluate(() => {
		const s = /** @type {any} */ (window).__stores;
		s.themes.theme.set('dark');
		s.uiScale.uiScale.set(100);
	});

	// ---- U1: dock back keeps the binding --------------------------------------------------------------------------
	await pop.locator('#code-ws-dock-back').click();
	await h.eventually(() => Promise.resolve(pop.isClosed()), (v) => v === true, 'U1: Dock back closes the code window', 10000);
	await h.eventually(() => mainWorkspaceShown(A.page), (n) => n === 1, 'U1: the workspace is back in the app', 15000);
	h.check(await shared(A.page, A.page, 'u50', 15000), 'U1: the docked editor is bound again');
	await paneB.locator('.cm-content').click();
	await B.page.keyboard.press('Control+End');
	await B.page.keyboard.insertText('\n// after dock');
	await h.eventually(() => tabCode(A.page, 'u50'), (c) => typeof c === 'string' && c.includes('// after dock') && c.startsWith('// from A\n'), "U1: after Dock back A still receives B's typing, nothing lost", 12000);
	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, `no page errors (${[...h.pageErrors(A), ...h.pageErrors(B)].slice(0, 2).join(' | ')})`);

	await h.finish(browser);
});
