// 78-wire: wiring takes seconds and wrong wiring is visible (roadmap 78 F1 F5 F6 F7 F24).
//
//   §1 F24  a REVERSED Object Selector -> On Click wire (agents and pasted graphs make it): the
//           click never fires; the wire draws dashed red with a chip whose tooltip says why;
//           Reverse fixes it as ONE undo step, replicated — and the click fires afterwards.
//   §2 F1   drag a wire from On Click into empty space: the filtered node search opens at the
//           drop point (exact fits, then coercions, "Show all nodes" last), axe serious-only gate
//           on the menu; a pick adds node + wire as ONE undo step, replicated; Show all lists the rest.
//   §3 F7   live state on the cards: a counter's count, a trigger's last pulse.
//   §4 F5   the capture stack: waypoint placing, then Measure on top — the banner names the top
//           and what is still armed, the TOP owns the next click, Esc pops ONE layer at a time.
//   §5 F6   Animate in editor: off rests a spinning object at its authored pose (and its card
//           says so), on it spins again.
//   §6 F1   Tab opens the same search from the selected node; a TOUCH drag into space opens it too.
//
// Counterfactuals: §1 "the click never fires before Reverse" is the bug itself (fireObjectClick
// returns 0 on the reversed wire on 1.63.0 too); §4 "one Esc leaves the waypoints armed" is red
// with the stack's Esc listener removed (both tools answer the same Esc).
const h = require('./helpers.cjs');
const { AxeBuilder } = require('@axe-core/playwright');

const S = (page, fn, arg) => page.evaluate(fn, arg);
const read = (page, path) =>
	S(page, (path) => new Promise((r) => path.split('.').reduce((o, k) => o[k], window.__stores).subscribe((v) => r(v))()), path);
const graph = (page, id = 'scene') =>
	S(page, (id) => new Promise((r) => window.__stores.flowGraphs.subscribe((g) => r(JSON.parse(JSON.stringify(g[id] ?? { nodes: [], edges: [] }))))()), id);
const edgeIds = (g) => g.edges.map((e) => e.id).sort();
const handle = (node, kind) => `.svelteFlow .svelte-flow__handle.${kind}[data-nodeid="${node}"]`;
const menuRows = async (page) => (await page.locator('[role="menu"] .ctx-match').allTextContents()).map((t) => t.replace(/\s*▸\s*/g, ' ▸ ').replace(/\s+/g, ' ').trim());

// screenshots, both themes (WIRE_SHOTS=<dir>) — the evidence folder's dark + light pair
const SHOTS = process.env.WIRE_SHOTS || '';
async function shotPair(page, name) {
	if (!SHOTS) return;
	const path = require('path');
	await page.screenshot({ path: path.join(SHOTS, `${name}-dark.png`) });
	await page.evaluate(() => window.__stores.themes.theme.set('light'));
	await page.waitForTimeout(400);
	await page.screenshot({ path: path.join(SHOTS, `${name}-light.png`) });
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));
	await page.waitForTimeout(300);
}

/** an empty spot of the node pane (nothing drawn under it), in screen px */
async function emptyPaneSpot(page, fx = 0.72, fy = 0.7) {
	return S(
		page,
		([fx, fy]) => {
			const pane = document.querySelector('.svelteFlow .svelte-flow__pane');
			const r = pane.getBoundingClientRect();
			for (let dy = 0; dy < 6; dy++)
				for (let dx = 0; dx < 6; dx++) {
					const x = r.left + r.width * Math.min(0.92, fx + dx * 0.03);
					const y = r.top + r.height * Math.min(0.9, fy - dy * 0.06);
					if (document.elementFromPoint(x, y)?.classList.contains('svelte-flow__pane')) return { x, y };
				}
			return null;
		},
		[fx, fy]
	);
}

/** Esc unwinds a search menu one step at a time (query, search, menu): press until it is gone */
async function closeMenu(page) {
	for (let i = 0; i < 4 && (await page.locator('.ctx-scroll').count()); i++) {
		await page.keyboard.press('Escape');
		await page.waitForTimeout(200);
	}
}

/** drag a wire from a handle to a screen point with the real mouse */
async function dragWire(page, fromSel, to) {
	const a = await page.locator(fromSel).first().boundingBox();
	if (!a || !to) return false;
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
	await page.mouse.down();
	await page.mouse.move((a.x + to.x) / 2, (a.y + to.y) / 2, { steps: 6 });
	await page.mouse.move(to.x, to.y, { steps: 6 });
	await page.mouse.up();
	return true;
}

/** a ground spot that lands on the 3D canvas (not under the docked editor) */
async function groundSpot(page, dx) {
	for (const z of [3, 2, 0, -2]) {
		const p = await h.projectPoint(page, [dx, 0, z]);
		const hit = await S(page, ({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? 'none', p);
		if (hit === 'CANVAS') return p;
		console.log(`  (ground ${dx},${z} is under a ${hit})`);
	}
	return null;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const p = A.page;

	// two boxes: `box` is what the selector names, `spinner` carries a Spin in its own flow
	const ids = await S(p, async () => {
		const st = window.__stores;
		st.commandsHandler.sceneCommand('/create box');
		st.commandsHandler.sceneCommand('/create box');
		const g = await new Promise((r) => st.objectsGroup.subscribe(r)());
		const [box, spinner] = g.children.slice(-2);
		spinner.position.x = 3;
		st.objectActions.applySelectionSet([]);
		return { box: box.uuid, spinner: spinner.uuid };
	});
	await p.waitForTimeout(400);
	const DOC = {
		scene: {
			nodes: [
				{ id: 'click', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', label: 'On Click' }, class: 'w-[150px]' },
				{ id: 'sel', type: 'objectselector', position: { x: 320, y: 0 }, data: { type: 'objectselector', label: 'Box', selected: ids.box }, class: 'w-[150px]' },
				{ id: 'cnt', type: 'counter', position: { x: 320, y: 220 }, data: { type: 'counter', label: 'Clicks' }, class: 'w-[150px]' }
			],
			// the BUG shape: the selector wired INTO the trigger; and the counter fed by the click
			edges: [
				{ id: 'e-sel-click', source: 'sel', target: 'click' },
				{ id: 'e-click-cnt.pulse', source: 'click', target: 'cnt', targetHandle: 'pulse' }
			]
		}
	};
	await S(p, (doc) => window.__stores.restoreGraphs(JSON.parse(JSON.stringify(doc))), DOC);
	await S(p, (id) => window.__stores.nodesHandler.sendNodes(id), B.id);
	await h.eventually(() => graph(B.page), (g) => g.nodes.length === 3, 'the peer holds the graph');
	await p.locator('p[title="Node editor (N)"]').click();
	await p.waitForTimeout(1200);

	// --- §1 F24 ------------------------------------------------------------------------------
	console.log('\n=== §1 F24 reversed trigger wire ===');
	const firedBefore = await S(p, (uuid) => window.__stores.flowRuntime.fireObjectClick(uuid), ids.box);
	h.check(firedBefore === 0, `§1 the reversed wire: a click on the box reaches no On Click (${firedBefore})`);
	const lint = await S(p, () => new Promise((r) => window.__stores.flowGraphs.subscribe((g) => r(window.__stores.flowLint.lintFlowGraph(g.scene.nodes, g.scene.edges)))()));
	h.check(lint.length === 1 && lint[0].edgeId === 'e-sel-click' && lint[0].code === 'reversed-trigger', `§1 the lint (the agents' function) names the wire (${JSON.stringify(lint.map((f) => f.edgeId))})`);
	const chip = p.locator('.flow-lint-chip[data-edge-id="e-sel-click"]');
	await chip.waitFor({ timeout: 8000 });
	const tip = await chip.getAttribute('title');
	h.check(/Backwards wire/.test(tip ?? '') && /On Click never fires/.test(tip ?? ''), `§1 the chip's tooltip says what is wrong ("${tip}")`);
	h.check(/Wire warning/.test((await chip.getAttribute('aria-label')) ?? ''), '§1 the chip has an accessible name');
	const dash = await S(p, () => {
		// xyflow cannot draw a wire INTO On Click (no input socket), so the lint draws it itself
		const path = document.querySelector('.svelteFlow .flow-lint-wire[data-edge-id="e-sel-click"] path');
		const cs = path ? getComputedStyle(path) : null;
		return cs ? { dash: cs.strokeDasharray, stroke: cs.stroke } : null;
	});
	h.check(!!dash && dash.dash !== 'none' && /6/.test(dash.dash), `§1 the flagged wire draws dashed (${JSON.stringify(dash)})`);
	const okDash = await S(p, () => {
		const path = document.querySelector('.svelteFlow .svelte-flow__edge[data-id="e-click-cnt.pulse"] .svelte-flow__edge-path');
		return path ? getComputedStyle(path).strokeDasharray : null;
	});
	h.check(okDash === 'none', `§1 a correct wire stays solid (${okDash})`);
	await shotPair(p, 'f24-backwards-wire');
	await chip.click();
	const reverseRow = p.locator('[role="menu"] [role="menuitem"]', { hasText: 'Reverse wire' }).first();
	await reverseRow.waitFor({ timeout: 5000 });
	await reverseRow.click();
	await p.waitForTimeout(500);
	let g = await graph(p);
	h.check(edgeIds(g).includes('e-click-sel') && !edgeIds(g).includes('e-sel-click'), `§1 Reverse turns the wire round (${edgeIds(g).join(',')})`);
	h.check((await p.locator('.flow-lint-chip').count()) === 0, '§1 the warning is gone');
	const firedAfter = await S(p, (uuid) => window.__stores.flowRuntime.fireObjectClick(uuid), ids.box);
	h.check(firedAfter === 1, `§1 after Reverse the click on the box fires the On Click (${firedAfter})`);
	await h.eventually(() => graph(B.page), (gb) => edgeIds(gb).includes('e-click-sel') && !edgeIds(gb).includes('e-sel-click'), '§1 the reversed wire replicates');
	const pane0 = await p.locator('.svelteFlow .svelte-flow__pane').boundingBox();
	await p.mouse.click(pane0.x + 12, pane0.y + 12);
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(500);
	g = await graph(p);
	h.check(edgeIds(g).includes('e-sel-click') && !edgeIds(g).includes('e-click-sel'), `§1 ONE undo brings the reversed wire back whole (${edgeIds(g).join(',')})`);
	await p.keyboard.press('Control+y');
	await p.waitForTimeout(500);
	g = await graph(p);
	h.check(edgeIds(g).includes('e-click-sel') && !edgeIds(g).includes('e-sel-click'), '§1 redo reverses it again');

	// --- §2 F1 drag a wire into space ---------------------------------------------------------
	console.log('\n=== §2 F1 drag-to-search ===');
	let drop = await emptyPaneSpot(p);
	h.check(!!drop, `§2 found an empty spot of the pane (${JSON.stringify(drop)})`);
	await dragWire(p, handle('click', 'source'), drop);
	const menu = p.locator('[role="menu"]');
	await menu.waitFor({ timeout: 5000 });
	const box = await menu.boundingBox();
	h.check(!!box && Math.abs(box.x - drop.x) < 60 && Math.abs(box.y - drop.y) < 400, `§2 the search opens at the drop point (menu ${box && Math.round(box.x)},${box && Math.round(box.y)} vs ${Math.round(drop.x)},${Math.round(drop.y)})`);
	const header = (await p.locator('[role="menu"] .ctx-header').first().textContent())?.replace(/\s+/g, ' ').trim();
	h.check(/Wire from On Click/.test(header ?? '') && /event/.test(header ?? ''), `§2 the header names the wire's socket and type ("${header}")`);
	let rows = await menuRows(p);
	const firstConv = rows.findIndex((t) => t.startsWith('Converts'));
	h.check(rows.length > 10 && rows[0].startsWith('Fits'), `§2 exact fits lead (${rows.slice(0, 3).join(' | ')})`);
	h.check(firstConv > 0 && rows.slice(0, firstConv).every((t) => t.startsWith('Fits')) && rows.slice(firstConv, -1).every((t) => t.startsWith('Converts')), `§2 exact, then coercions — never interleaved (first coercion at ${firstConv} of ${rows.length})`);
	h.check(rows[rows.length - 1].trim() === 'Show all nodes', `§2 "Show all nodes" closes the list ("${rows[rows.length - 1]}")`);
	h.check(rows.some((t) => /Counter · pulse/.test(t)) && rows.some((t) => /Counter · reset/.test(t)), '§2 several fitting sockets on one node = one row each');
	await shotPair(p, 'f1-wire-search');
	h.check(rows.some((t) => t === 'Converts ▸ Object Selector'), '§2 the right way round is offered: On Click feeds an Object Selector');
	h.check(!rows.some((t) => /▸ On Click$/.test(t)), '§2 a node with no input (On Click) is not offered');
	// axe: serious / critical only, on the open search menu
	const ax = await new AxeBuilder({ page: p }).include('.ctx-scroll').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
	for (const v of ax.violations) console.log(`  [axe] ${v.impact} ${v.id} (${v.nodes.length}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary ?? '').replace(/\s+/g, ' ')).join(' | ')}`);
	const gated = ax.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
	h.check(gated.length === 0, `§2 axe: no serious/critical violations in the search menu (${gated.map((v) => v.id).join(', ') || 'none'})`);
	// type to filter: the exact fit leads inside its match rank
	await p.keyboard.type('counter');
	await p.waitForTimeout(250);
	rows = await menuRows(p);
	h.check(/Fits ▸ Counter · pulse/.test(rows[0] ?? ''), `§2 typing filters and the exact fit leads ("${rows[0]}")`);
	h.check(rows[rows.length - 1].trim() === 'Show all nodes', '§2 the way out stays under a filtered list');
	const before = await graph(p);
	await p.keyboard.press('Enter');
	await p.waitForTimeout(600);
	g = await graph(p);
	const added = g.nodes.find((n) => n.type === 'counter' && !before.nodes.some((b) => b.id === n.id));
	const wireIn = added && g.edges.find((e) => e.source === 'click' && e.target === added.id && e.targetHandle === 'pulse');
	h.check(!!added && !!wireIn, `§2 the pick adds a Counter wired On Click -> pulse (${added?.id ?? 'none'})`);
	const cardBox = added ? await p.locator(`.svelteFlow .svelte-flow__node[data-id="${added.id}"]`).boundingBox() : null;
	h.check(!!cardBox && Math.abs(cardBox.x - drop.x) < 40 && Math.abs(cardBox.y + 20 - drop.y) < 60, `§2 the node lands at the drop point (${cardBox && Math.round(cardBox.x)},${cardBox && Math.round(cardBox.y)})`);
	await h.eventually(() => graph(B.page), (gb) => !!added && gb.nodes.some((n) => n.id === added.id) && gb.edges.some((e) => e.target === added.id), '§2 node and wire replicate');
	await p.mouse.click(pane0.x + 12, pane0.y + 12);
	await p.keyboard.press('Control+z');
	await p.waitForTimeout(500);
	g = await graph(p);
	h.check(!g.nodes.some((n) => n.id === added?.id) && !g.edges.some((e) => e.target === added?.id), '§2 ONE undo removes node AND wire');
	await p.keyboard.press('Control+y');
	await p.waitForTimeout(500);
	g = await graph(p);
	h.check(g.nodes.some((n) => n.id === added?.id) && g.edges.some((e) => e.target === added?.id), '§2 redo brings both back');
	// Show all
	drop = await emptyPaneSpot(p, 0.6, 0.45);
	await dragWire(p, handle('click', 'source'), drop);
	await menu.waitFor({ timeout: 5000 });
	await p.locator('[role="menu"] .ctx-match', { hasText: 'Show all nodes' }).click();
	await p.waitForTimeout(300);
	rows = await menuRows(p);
	console.log(`  (show all: ${rows.length} rows, last ${rows.slice(-2).join(' | ')})`);
	h.check((await menu.isVisible()) && rows.some((t) => t === 'All nodes ▸ On Click'), `§2 Show all keeps the menu open and lists the rest (${rows.filter((t) => t.startsWith('All')).length} more)`);
	await closeMenu(p);
	h.check((await p.locator('.ctx-scroll').count()) === 0, '§2 Esc (step by step) closes the search');
	await p.waitForTimeout(300);

	// --- §3 F7 live state on the cards --------------------------------------------------------
	console.log('\n=== §3 F7 live card state ===');
	await S(p, (uuid) => window.__stores.flowRuntime.fireObjectClick(uuid), ids.box);
	const live = (id) => p.locator(`.flow-live-state[data-node-id="${id}"]`).textContent().catch(() => null);
	await h.eventually(() => live('cnt'), (t) => /^count [1-9]/.test(t ?? ''), '§3 the counter card shows its count');
	await h.eventually(() => live('click'), (t) => /fired/.test(t ?? ''), '§3 the On Click card shows its last pulse');

	// --- §4 F5 the capture stack --------------------------------------------------------------
	console.log('\n=== §4 F5 capture stack ===');
	await S(p, (uuid) => {
		const st = window.__stores;
		st.flowGraphsCtl.createObjectGraph(uuid);
		st.nodesHandler.createFlowNode({ id: 'pp1', type: 'pathpatrol', position: { x: 40, y: 40 }, data: { type: 'pathpatrol', points: [], speed: 2, mode: 'loop' } }, uuid);
		st.objectActions.selectObject(uuid);
	}, ids.box);
	await p.waitForTimeout(800);
	await S(p, () => window.__stores.pathCapture.togglePathCapture('pp1'));
	await p.waitForTimeout(300);
	await h.eventually(() => live('pp1'), (t) => t === 'placing points', '§3/F7 the capturing Path patrol card says so');
	const banner = p.locator('#capture-banner');
	h.check((await banner.getAttribute('data-capture')) === 'path', '§4 the banner names the armed capture (waypoints)');
	// the docked node editor covers the lower viewport: close it for the viewport clicks
	await p.locator('p[title="Node editor (N)"]').click();
	await p.waitForTimeout(800);
	const pts = async () => (await graph(p, ids.box)).nodes.find((n) => n.id === 'pp1')?.data.points?.length ?? -1;
	const spot1 = await groundSpot(p, -1.5);
	h.check(!!spot1, '§4 a ground spot on the canvas');
	await p.mouse.click(spot1.x, spot1.y);
	await p.waitForTimeout(300);
	h.check((await pts()) === 1, '§4 with only waypoints armed, a ground click adds a waypoint');
	await S(p, () => window.__stores.measure.startMeasure());
	await p.waitForTimeout(300);
	h.check((await banner.getAttribute('data-capture')) === 'measure' && (await banner.getAttribute('data-depth')) === '2', '§4 Measure on top: the banner names it and counts 2 armed');
	h.check(/then placing waypoints/.test((await p.locator('#capture-banner-below').textContent()) ?? ''), '§4 the banner says what is still armed underneath');
	await shotPair(p, 'f5-capture-banner');
	const spot2 = await groundSpot(p, 1.5);
	await p.mouse.click(spot2.x, spot2.y);
	await p.waitForTimeout(300);
	const mPoints = await S(p, () => new Promise((r) => window.__stores.measure.measurement.subscribe((m) => r(m?.points?.length ?? 0))()));
	h.check((await pts()) === 1 && mPoints === 1, `§4 the TOP capture owns the click: a measure point, no waypoint (waypoints ${await pts()}, measure ${mPoints})`);
	await p.keyboard.press('Escape');
	await p.waitForTimeout(300);
	h.check((await read(p, 'measure.measureMode')) === false, '§4 Esc leaves Measure (the top)');
	h.check((await read(p, 'pathCapture.pathCaptureNode')) === 'pp1', '§4 …and ONE Esc leaves the waypoints armed');
	h.check((await banner.getAttribute('data-capture')) === 'path', '§4 the banner is back on the waypoints');
	await p.keyboard.press('Escape');
	await p.waitForTimeout(300);
	h.check((await read(p, 'pathCapture.pathCaptureNode')) === null, '§4 the next Esc ends waypoint placing');
	h.check((await banner.count()) === 0, '§4 nothing armed: no banner');

	// --- §5 F6 Animate in editor -------------------------------------------------------------
	console.log('\n=== §5 F6 Animate in editor ===');
	await p.locator('p[title="Node editor (N)"]').click();
	await p.waitForTimeout(1000);
	await S(p, (uuid) => {
		const st = window.__stores;
		st.flowGraphsCtl.createObjectGraph(uuid);
		st.nodesHandler.createFlowNode({ id: 'sp1', type: 'spin', position: { x: 40, y: 40 }, data: { type: 'spin', speed: 2 } }, uuid);
		st.objectActions.selectObject(uuid);
	}, ids.spinner);
	await p.waitForTimeout(900);
	const quat = () => S(p, (uuid) => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.getObjectByProperty('uuid', uuid).quaternion.toArray()))()), ids.spinner);
	const moved = (a, b) => a.some((v, i) => Math.abs(v - b[i]) > 1e-4);
	let q1 = await quat();
	await p.waitForTimeout(400);
	let q2 = await quat();
	h.check(moved(q1, q2), '§5 on (the default): the Spin turns the object in the editor');
	await p.locator('#flow-animate-edit').click();
	await p.waitForTimeout(400);
	q1 = await quat();
	await p.waitForTimeout(400);
	q2 = await quat();
	h.check(!moved(q1, q2) && Math.abs(q1[3]) > 0.9999, `§5 off: the object rests at its authored pose (${q1.map((v) => v.toFixed(3)).join(',')})`);
	h.check((await p.locator('#flow-animate-edit').getAttribute('aria-pressed')) === 'false', '§5 the control says it is off (aria-pressed)');
	await h.eventually(() => live('sp1'), (t) => t === 'resting until Play', '§5 the Spin card says it rests until Play');
	h.check((await S(p, () => window.__stores.safeStorage?.getItem?.('flow:animateInEditor') ?? localStorage.getItem('flow:animateInEditor'))) === 'false', '§5 the choice is remembered (local)');
	await p.locator('#flow-animate-edit').click();
	await p.waitForTimeout(300);
	q1 = await quat();
	await p.waitForTimeout(400);
	q2 = await quat();
	h.check(moved(q1, q2), '§5 on again: it spins');

	// --- §6 F1 Tab + touch -------------------------------------------------------------------
	console.log('\n=== §6 F1 Tab and touch ===');
	await S(p, () => window.__stores.objectActions.applySelectionSet([]));
	await p.waitForTimeout(800);
	await S(p, () => window.__stores.flowNodes.update((ns) => ns.map((n) => ({ ...n, selected: n.id === 'click' }))));
	const paneT = await p.locator('.svelteFlow .svelte-flow__pane').boundingBox();
	await p.mouse.move(paneT.x + paneT.width * 0.6, paneT.y + paneT.height * 0.5);
	await S(p, () => window.__stores.flowNodes.update((ns) => ns.map((n) => ({ ...n, selected: n.id === 'click' }))));
	await p.evaluate(() => document.activeElement?.blur?.());
	await p.keyboard.press('Tab');
	await p.waitForTimeout(400);
	const tabHeader = await p.locator('[role="menu"] .ctx-header').first().textContent().catch(() => null);
	h.check(/Wire from On Click/.test(tabHeader ?? ''), `§6 Tab with one node selected opens the same search from its output ("${tabHeader?.trim()}")`);
	await closeMenu(p);
	await p.waitForTimeout(300);
	// touch: a finger drags the wire from On Click into space
	const cdp = await p.context().newCDPSession(p);
	await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
	const hb = await p.locator(handle('click', 'source')).first().boundingBox();
	const tdrop = await emptyPaneSpot(p, 0.55, 0.8);
	const from = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
	for (let i = 1; i <= 10; i++)
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + ((tdrop.x - from.x) * i) / 10, y: from.y + ((tdrop.y - from.y) * i) / 10, id: 1 }] });
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await p.waitForTimeout(500);
	const touchHeader = await p.locator('[role="menu"] .ctx-header').first().textContent().catch(() => null);
	h.check(/Wire from On Click/.test(touchHeader ?? ''), `§6 a touch drag into space opens the same search ("${touchHeader?.trim()}")`);
	const nBefore = (await graph(p)).nodes.length;
	await p.locator('[role="menu"] .ctx-match', { hasText: 'Latch · set' }).first().click();
	await p.waitForTimeout(500);
	g = await graph(p);
	const latch = g.nodes.find((n) => n.type === 'latch');
	h.check(g.nodes.length === nBefore + 1 && !!latch && g.edges.some((e) => e.source === 'click' && e.target === latch.id && e.targetHandle === 'set'), '§6 the touch pick adds a Latch wired to set');
	await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });

	const errs = h.pageErrors(A);
	h.check(errs.length === 0, `no page errors (${errs.slice(0, 3).join(' | ')})`);
	await h.finish(browser);
});
