// 36 F10 (36-fb-graphs) — WHERE THE NODE EDITOR OPENS.
//
// The user's report (1.25 feedback): opening the node editor on a template showed some other
// corner of the canvas. Reproduced on 1.23.0: with the editor open, loading a second scene kept
// the first scene's pan and zoom (Target Toss opened on Mini Golf's view, cut off at the right) —
// the pane fitted ONCE, at mount. Now every open (mount, graph switch, scene load) shows the
// graph's saved view (where a hand left it) or frames every node; the setting "Node editor opens"
// can force framed.
//
// Covered: a scene loaded with the editor open is framed (THE REPORT); a pan by hand is
// remembered across a graph switch and a close/reopen; it rides the scene file and a fresh page
// opens on it; a file without views (a template) opens framed; a programmatic frame (A) records
// nothing; 'framed' ignores a saved view; the Settings row + its search keyword.
//
// Counterfactuals:
//   · §2 is the report itself, reproduced on unmodified 1.23.0 before the fix: with the editor
//     open, loading a second scene kept the first scene's viewport (Target Toss cut off on the
//     right; lanes-30/after-36/36-fb-graphs: the seq probe)
//   · §6 caught a real bug in this lane's first version: a plain click on the pane (no travel)
//     ends an xyflow move too and was remembered as "where it was left" — now a gesture that
//     goes nowhere records nothing
const h = require('./helpers.cjs');

const W = 1920;
const H = 1080;

/** a row of `n` number nodes starting at (x0, y0), `gap` apart */
function row(prefix, n, x0, y0, gap = 260) {
	const nodes = [];
	for (let i = 0; i < n; i++)
		nodes.push({ id: prefix + i, type: 'number', position: { x: x0 + i * gap, y: y0 }, data: { type: 'number', value: i, label: prefix + i }, class: 'w-[150px]' });
	return { nodes, edges: [] };
}

/** a scene payload built by the app itself from these graphs (+ optional views) */
const payloadOf = (page, graphs, name) =>
	page.evaluate(
		({ graphs, name }) => {
			const s = window.__stores;
			s.restoreGraphs(JSON.parse(JSON.stringify(graphs)));
			return JSON.parse(JSON.stringify(s.sessions.buildSessionPayload(name)));
		},
		{ graphs, name }
	);
const load = (page, payload) =>
	page.evaluate(async (payload) => {
		await window.__stores.sessions.applySession(payload, { backup: false });
	}, payload);

/** where the visible nodes sit relative to the pane */
const placement = (page) =>
	page.evaluate(() => {
		const pane = document.querySelector('.svelteFlow')?.getBoundingClientRect();
		const els = [...document.querySelectorAll('.svelteFlow .svelte-flow__node')].filter((n) => n.offsetParent !== null && getComputedStyle(n).visibility !== 'hidden');
		const rects = els.map((n) => n.getBoundingClientRect());
		if (!pane || !rects.length) return { count: rects.length, inside: 0 };
		const inside = rects.filter((b) => b.left >= pane.left - 1 && b.right <= pane.right + 1 && b.top >= pane.top - 1 && b.bottom <= pane.bottom + 1).length;
		const minX = Math.min(...rects.map((b) => b.left));
		const maxX = Math.max(...rects.map((b) => b.right));
		const minY = Math.min(...rects.map((b) => b.top));
		const maxY = Math.max(...rects.map((b) => b.bottom));
		const t = document.querySelector('.svelteFlow .svelte-flow__viewport')?.style.transform ?? '';
		const m = t.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/);
		return {
			count: rects.length,
			inside,
			ids: els.map((n) => n.getAttribute('data-id')),
			dx: (minX + maxX) / 2 - (pane.left + pane.width / 2),
			dy: (minY + maxY) / 2 - (pane.top + pane.height / 2),
			pane: { w: pane.width, h: pane.height },
			vp: m ? { x: +m[1], y: +m[2], zoom: +m[3] } : null
		};
	});
const framed = (p) => p.count > 0 && p.inside === p.count && Math.abs(p.dx) < p.pane.w * 0.12 && Math.abs(p.dy) < p.pane.h * 0.15;
const settle = (page, ms = 900) => page.waitForTimeout(ms);
const editorOpen = (page) => page.evaluate(() => !!document.querySelector('.svelteFlow .svelte-flow__pane'));
async function ensureEditor(page) {
	await settle(page, 1000);
	if (!(await editorOpen(page))) await toggleEditor(page);
}
async function toggleEditor(page) {
	await page.locator('p[title="Node editor (N)"]').click();
	await settle(page, 1400);
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: W, height: H } }, storage: { flowDockHeight: '860' } });
	const p = A.page;

	// --- 1. a scene loaded BEFORE the editor opens: framed on open ---------------------------
	const sceneA = await payloadOf(p, { scene: row('a', 3, 0, 0) }, 'Scene A');
	const sceneB = await payloadOf(p, { scene: row('b', 4, 6000, 4200, 300) }, 'Scene B');
	h.check(!sceneA.flowViews && !sceneB.flowViews, 'a scene nobody panned saves NO flowViews field (a template stays byte-identical)');
	await load(p, sceneA);
	await toggleEditor(p);
	h.check(await editorOpen(p), 'the node editor is open');
	let pl = await placement(p);
	h.check(framed(pl) && pl.ids.every((id) => id.startsWith('a')), `opening the editor frames scene A (${pl.inside}/${pl.count} inside, off-centre ${Math.round(pl.dx)},${Math.round(pl.dy)})`);

	// --- 2. THE REPORT: with the editor open, load ANOTHER scene ------------------------------
	await load(p, sceneB);
	await settle(p, 1500);
	pl = await placement(p);
	h.check(pl.ids.every((id) => id.startsWith('b')) && pl.count === 4, `the editor shows scene B's graph (${pl.count} nodes)`);
	h.check(framed(pl), `§2 the SECOND scene opens framed — not on scene A's view (${pl.inside}/${pl.count} inside, off-centre ${Math.round(pl.dx)},${Math.round(pl.dy)})`);

	// --- 3. a pan by hand is remembered: graph switch, close/reopen ----------------------------
	const pane = await p.locator('.svelteFlow').boundingBox();
	const from = { x: pane.x + 120, y: pane.y + 150 };
	await p.mouse.move(from.x, from.y);
	await p.mouse.down();
	await p.mouse.move(from.x + 180, from.y + 60, { steps: 8 });
	await p.mouse.move(from.x + 360, from.y + 120, { steps: 8 });
	await p.mouse.up();
	await settle(p, 600);
	const panned = await placement(p);
	h.check(Math.abs(panned.vp.x - pl.vp.x - 360) < 6 && Math.abs(panned.vp.y - pl.vp.y - 120) < 6, `a left drag on the pane pans it (moved ${Math.round(panned.vp.x - pl.vp.x)},${Math.round(panned.vp.y - pl.vp.y)})`);
	const saved = await p.evaluate(() => window.__stores.flowView.savedView('scene'));
	h.check(!!saved, 'the pan is remembered as the graph\'s view');
	// another graph (selecting an object switches the editor to its flow) and back
	const objUuid = await p.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		return g.children[g.children.length - 1].uuid;
	});
	await settle(p, 600);
	await p.evaluate((id) => window.__stores.objectActions.selectObject(id), objUuid);
	await settle(p, 600);
	// the object's flow, written through BOTH mirrors (flowGraphs = document, flowNodes = view)
	await p.evaluate((uuid) => {
		const s = window.__stores;
		const node = { id: 'o0', type: 'number', position: { x: -900, y: -900 }, data: { type: 'number', value: 1, label: 'o0' }, class: 'w-[150px]' };
		s.flowGraphs.update((all) => ({ ...all, [uuid]: { nodes: [node], edges: [] } }));
		s.flowNodes.set([node]);
	}, objUuid);
	await settle(p, 1200);
	pl = await placement(p);
	if (!pl.count) {
		console.log('DEBUG obj', JSON.stringify(await p.evaluate((id) => { let g; window.__stores.flowGraphs.subscribe((v) => (g = v))(); let fn; window.__stores.flowNodes.subscribe((v) => (fn = v))(); return { doc: g[id]?.nodes?.length, view: fn.length, empty: !!document.querySelector('#flow-empty-state'), dom: document.querySelectorAll('.svelteFlow .svelte-flow__node').length }; }, objUuid)));
		await p.screenshot({ path: '/tmp/claude-1000/-home-deck--code-theprototype-app/2840b79f-dd47-4214-aff4-10a6d40d0f85/scratchpad/shots/dbg-obj.png' });
	}
	h.check((await p.evaluate(() => new Promise((r) => window.__stores.activeGraphId.subscribe(r)()))) === objUuid, 'selecting the object switches the editor to its flow');
	h.check(pl.ids?.includes('o0') && framed(pl), `that graph opens framed (${pl.inside}/${pl.count}, off-centre ${Math.round(pl.dx)},${Math.round(pl.dy)})`);
	await p.evaluate(() => window.__stores.objectActions.deselectObject());
	await settle(p, 1200);
	pl = await placement(p);
	h.check(Math.abs(pl.vp.x - panned.vp.x) < 3 && Math.abs(pl.vp.y - panned.vp.y) < 3 && Math.abs(pl.vp.zoom - panned.vp.zoom) < 0.005, `switching back opens Main where it was left (${pl.vp.x},${pl.vp.y} vs ${panned.vp.x},${panned.vp.y})`);
	await toggleEditor(p);
	h.check(!(await editorOpen(p)), 'the editor closed');
	await toggleEditor(p);
	pl = await placement(p);
	h.check(Math.abs(pl.vp.x - panned.vp.x) < 3 && Math.abs(pl.vp.y - panned.vp.y) < 3, `closing and reopening the editor keeps where it was left (${pl.vp.x},${pl.vp.y})`);

	// --- 4. the view rides the scene file; a fresh page opens on it ----------------------------
	const withView = await p.evaluate(() => JSON.parse(JSON.stringify(window.__stores.sessions.buildSessionPayload('Scene B (panned)'))));
	h.check(!!withView.flowViews?.scene && Object.keys(withView.flowViews).length === 1, `the saved scene carries flowViews for Main only (${JSON.stringify(withView.flowViews)})`);
	const B2 = await h.setupPage(browser, 'B', { context: { viewport: { width: W, height: H } }, storage: { flowDockHeight: '860' } });
	await load(B2.page, withView);
	await ensureEditor(B2.page); // the file's workspace may already have opened it
	const plB = await placement(B2.page);
	if (!plB.vp) await B2.page.screenshot({ path: '/tmp/claude-1000/-home-deck--code-theprototype-app/2840b79f-dd47-4214-aff4-10a6d40d0f85/scratchpad/shots/dbg-b2.png' });
	if (!plB.vp) console.log('DEBUG B2 placement', JSON.stringify(plB), await B2.page.evaluate(() => ({ open: !!document.querySelector('.svelteFlow'), active: document.querySelector('.svelteFlow') ? 1 : 0, n: window.__stores.allNodes().length })));
	h.check(Math.abs(plB.vp.x - panned.vp.x) < 3 && Math.abs(plB.vp.y - panned.vp.y) < 3 && Math.abs(plB.vp.zoom - panned.vp.zoom) < 0.005, `a fresh page opens the file on the creator's view (${plB.vp.x},${plB.vp.y} vs ${panned.vp.x},${panned.vp.y})`);
	// a different pane size keeps the same flow point in the middle (the view is a centre)
	await B2.page.setViewportSize({ width: 1280, height: 900 });
	await B2.page.evaluate(() => window.__stores.flowView.loadFlowViews(window.__stores.flowView.flowViewsSnapshot()));
	await settle(B2.page, 1200);
	const centre = await B2.page.evaluate(() => {
		const el = document.querySelector('.svelteFlow');
		const t = document.querySelector('.svelteFlow .svelte-flow__viewport').style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/);
		return { x: (el.clientWidth / 2 - +t[1]) / +t[3], y: (el.clientHeight / 2 - +t[2]) / +t[3] };
	});
	h.check(Math.abs(centre.x - saved.x) < 2 && Math.abs(centre.y - saved.y) < 2, `on a smaller window the same flow point is centred (${Math.round(centre.x)},${Math.round(centre.y)} vs ${Math.round(saved.x)},${Math.round(saved.y)})`);
	await B2.ctx.close();

	// a file without the field (every template) opens framed even after a pan this session
	await load(p, sceneB);
	await settle(p, 1500);
	pl = await placement(p);
	h.check(framed(pl), `a template (no flowViews) opens framed, the session's pan forgotten (${pl.inside}/${pl.count}, off-centre ${Math.round(pl.dx)},${Math.round(pl.dy)})`);

	// --- 5. setting 'framed' ignores a saved view ----------------------------------------------
	await load(p, withView);
	await settle(p, 1500);
	pl = await placement(p);
	h.check(Math.abs(pl.vp.x - panned.vp.x) < 3, 'with the default setting the panned file opens where it was left');
	await p.evaluate(() => window.__stores.flowView.nodeEditorOpens.set('framed'));
	await load(p, withView);
	await settle(p, 1500);
	pl = await placement(p);
	h.check(framed(pl), `with "Framed" the same file opens framed (${pl.inside}/${pl.count}, off-centre ${Math.round(pl.dx)},${Math.round(pl.dy)})`);
	h.check((await p.evaluate(() => localStorage.getItem('flow:opens'))) === 'framed', 'the setting is persisted');
	await p.evaluate(() => window.__stores.flowView.nodeEditorOpens.set('left'));

	// --- 6. a programmatic frame (A) is not "where it was left" --------------------------------
	await load(p, sceneA);
	await settle(p, 1500);
	await p.locator('.svelteFlow .svelte-flow__pane').click({ position: { x: 40, y: 40 } });
	await p.keyboard.press('a');
	await settle(p, 800);
	h.check((await p.evaluate(() => window.__stores.flowView.savedView('scene'))) === null, '§6 pressing A records nothing (a file saved now has no flowViews)');

	// --- 7. the Settings row + its search keyword ----------------------------------------------
	await p.evaluate(() => window.__stores.settingsOpen.set(true));
	await p.waitForSelector('#settings-search', { timeout: 10000 });
	await p.fill('#settings-search', 'framed');
	await settle(p, 700);
	const rows = await p.evaluate(() =>
		[...document.querySelectorAll('.setting-row')].filter((r) => r.offsetParent !== null).map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160))
	);
	h.check(rows.some((r) => /Node editor opens/.test(r)) && rows.length <= 3, `Settings search "framed" finds "Node editor opens" (${JSON.stringify(rows)})`);
	h.check(await p.locator('#flow-opens').isVisible(), 'the row has its selector');

	await h.finish(browser);
});
