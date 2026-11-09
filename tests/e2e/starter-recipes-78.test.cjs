// 78 F27 — STARTER RECIPES. Each recipe goes into an empty scene's object with one click, then
// works in Play, on both peers:
//   §1 the node search lists "Recipes ▸ …" (greyed with a reason on the scene graph); clicking
//      Bell on a selected object inserts its nodes into the object's own flow, ONE undo step.
//   §2 Door (click): a click opens it a quarter turn on A and B; a second click closes it.
//   §3 Door (walk up): the player entering its zone opens it on both peers, leaving closes it.
//   §4 Bell: a click swings it (A and B), and the swing settles.
//   §6 85 Q2/Q7: the mouse in Interact lights an unwired Highlight (one hover source).
//   §5 Guard: it walks its closed route (A and B agree on its place); a player within 4 m gets
//      "Spotted!" in the announce log.
//
//   APP_URL=https://theprototype.app:5800/ node tests/e2e/starter-recipes-78.test.cjs
const h = require('./helpers.cjs');

const S = (page, fn, arg) => page.evaluate(fn, arg);
const graphOf = (page, id) =>
	S(page, (id) => new Promise((r) => window.__stores.flowGraphs.subscribe((g) => r(JSON.parse(JSON.stringify(g[id] ?? { nodes: [], edges: [] }))))()), id);
const pose = (page, uuid) =>
	S(page, (uuid) => {
		/** @type {any} */ let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', uuid);
		return o ? { p: o.position.toArray(), r: [o.rotation.x, o.rotation.y, o.rotation.z] } : null;
	}, uuid);
const near = (a, b, eps) => Math.abs(a - b) <= eps;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const p = A.page;

	/** a box named `name` at `pos`, replicated @param {string} name @param {number[]} pos */
	const box = (name, pos) =>
		S(p, async ([name, pos]) => {
			const st = window.__stores;
			st.commandsHandler.sceneCommand('/create box');
			const g = await new Promise((r) => st.objectsGroup.subscribe(r)());
			const o = g.children[g.children.length - 1];
			o.position.set(pos[0], pos[1], pos[2]);
			o.updateMatrixWorld(true);
			st.objectActions.renameObject(o.uuid, name);
			let peer;
			st.peers.subscribe((v) => (peer = v))();
			peer?.send({ type: 'move', uuid: o.uuid, pos: o.position.toArray(), rot: [0, 0, 0], scale: o.scale.toArray() });
			return o.uuid;
		}, [name, pos]);

	// --- §1 the menu ---------------------------------------------------------------------------
	console.log('\n=== §1 the Recipes menu ===');
	const bell = await box('Bell', [0, 1, -4]);
	await S(p, () => window.__stores.objectActions.applySelectionSet([]));
	await p.locator('p[title="Node editor (N)"]').click();
	await p.waitForTimeout(1200);
	const pane = await p.locator('.svelteFlow .svelte-flow__pane').boundingBox();
	await p.mouse.click(pane.x + pane.width * 0.6, pane.y + pane.height * 0.5, { button: 'right' });
	await p.keyboard.type('recipes bell');
	await p.waitForTimeout(400);
	const row = p.locator('[role="menu"] .ctx-match', { hasText: 'Bell' }).first();
	await row.waitFor({ timeout: 5000 });
	const off = await row.evaluate((el) => el.closest('[role="menuitem"]')?.getAttribute('aria-disabled') ?? el.getAttribute('aria-disabled'));
	h.check(off === 'true', `§1 on the scene graph the recipe is greyed (aria-disabled=${off})`);
	await p.keyboard.press('Escape');
	await p.keyboard.press('Escape');
	await p.keyboard.press('Escape');
	await S(p, (u) => window.__stores.objectActions.applySelectionSet([u]), bell);
	await p.waitForTimeout(800);
	await p.mouse.click(pane.x + pane.width * 0.6, pane.y + pane.height * 0.5, { button: 'right' });
	await p.keyboard.type('recipes bell');
	await p.waitForTimeout(400);
	await p.locator('[role="menu"] .ctx-match', { hasText: 'Bell' }).first().click();
	await h.eventually(() => graphOf(p, bell), (g) => g.nodes.some((n) => n.type === 'hoveranimate') && g.edges.length === 3, '§1 Bell inserts its nodes into the bell\'s own flow');
	await h.eventually(() => graphOf(B.page, bell), (g) => g.nodes.some((n) => n.type === 'hoveranimate'), '§1 the peer gets the recipe');
	await S(p, () => window.__stores.history.undo());
	await h.eventually(() => graphOf(p, bell), (g) => g.nodes.length === 0, '§1 one undo takes the whole recipe back');
	await S(p, () => window.__stores.history.redo());
	await h.eventually(() => graphOf(p, bell), (g) => g.nodes.length === 4, '§1 redo puts it back');

	// --- the other recipes through the same function ------------------------------------------
	const door = await box('Door', [4, 1, -4]);
	const gate = await box('Gate', [8, 1, -4]);
	const guard = await box('Guard', [-8, 0.5, 0]);
	const ins = (id, uuid) => S(p, ([id, uuid]) => window.__stores.starterRecipes.insertStarterRecipe(id, uuid), [id, uuid]);
	const rDoor = await ins('door', door);
	const rGate = await ins('door-walk', gate);
	const rGuard = await ins('guard', guard);
	h.check(rDoor.ok && rGate.ok && rGuard.ok, `the door, walk-up door and guard recipes insert (${[rDoor, rGate, rGuard].map((r) => r.ok || r.error).join(', ')})`);
	const zone = rGate.made?.[0];
	h.check(!!zone && !!rGuard.made?.[0], '§3/§5 the walk-up door made its zone and the guard its route');
	await h.eventually(() => graphOf(B.page, guard), (g) => g.nodes.some((n) => n.type === 'pathpatrol'), 'the peer holds the guard recipe');
	const zoneSensor = await S(p, (u) => {
		/** @type {any} */ let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.getObjectByProperty('uuid', u)?.userData?.physics?.sensor === true;
	}, zone);
	h.check(zoneSensor, '§3 the zone is a sensor');

	// Play on both
	for (const x of [A, B]) await S(x.page, () => window.__stores.isLocked.set(true));
	await p.waitForTimeout(800);

	// --- §2 door (click) -----------------------------------------------------------------------
	console.log('\n=== §2 Door (click) ===');
	const d0 = (await pose(p, door)).r[1];
	await S(p, (u) => window.__stores.flowRuntime.fireObjectClick(u), door);
	for (const x of [A, B]) await h.eventually(() => pose(x.page, door), (q) => q && near(q.r[1], d0 + Math.PI / 2, 0.05), `§2 the door opens a quarter turn on ${x === A ? 'A' : 'B'}`);
	await S(p, (u) => window.__stores.flowRuntime.fireObjectClick(u), door);
	for (const x of [A, B]) await h.eventually(() => pose(x.page, door), (q) => q && near(q.r[1], d0, 0.05), `§2 a second click closes it on ${x === A ? 'A' : 'B'}`);

	// --- §3 door (walk up) ---------------------------------------------------------------------
	console.log('\n=== §3 Door (walk up) ===');
	const g0 = (await pose(p, gate)).r[1];
	await S(p, (z) => window.__stores.flowRuntime.fireObjectEnter(z, 'player'), zone);
	for (const x of [A, B]) await h.eventually(() => pose(x.page, gate), (q) => q && near(q.r[1], g0 + Math.PI / 2, 0.05), `§3 walking into the zone opens the gate on ${x === A ? 'A' : 'B'}`);
	await S(p, (z) => window.__stores.flowRuntime.fireObjectExit(z, 'player'), zone);
	for (const x of [A, B]) await h.eventually(() => pose(x.page, gate), (q) => q && near(q.r[1], g0, 0.05), `§3 walking out closes it on ${x === A ? 'A' : 'B'}`);

	// --- §4 bell -------------------------------------------------------------------------------
	console.log('\n=== §4 Bell ===');
	await S(p, (u) => window.__stores.flowRuntime.fireObjectClick(u), bell);
	for (const x of [A, B]) {
		let peak = 0;
		for (let i = 0; i < 12; i++) {
			const q = await pose(x.page, bell);
			peak = Math.max(peak, Math.abs(q?.r[2] ?? 0));
			await x.page.waitForTimeout(100);
		}
		h.check(peak > 0.05, `§4 the bell swings on ${x === A ? 'A' : 'B'} (peak ${peak.toFixed(3)} rad)`);
	}
	await h.eventually(() => pose(p, bell), (q) => q && Math.abs(q.r[2]) < 0.01, '§4 the swing settles', 15000);

	// --- §5 guard ------------------------------------------------------------------------------
	console.log('\n=== §5 Guard ===');
	const q1 = await pose(p, guard);
	await p.waitForTimeout(1500);
	const q2 = await pose(p, guard);
	const moved = Math.hypot(q2.p[0] - q1.p[0], q2.p[2] - q1.p[2]);
	h.check(moved > 0.5, `§5 the guard walks its route (${moved.toFixed(2)} m in 1.5 s)`);
	const onRoute = Math.max(Math.abs(q2.p[0] + 8), Math.abs(q2.p[2])) ;
	h.check(near(onRoute, 3, 0.4), `§5 it stays on its square route around where it stood (${onRoute.toFixed(2)} m out)`);
	const both = await Promise.all([A, B].map((x) => S(x.page, (u) => {
		const f = window.__stores.flowRuntime;
		/** @type {any} */ let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		return { p: o.position.toArray(), t: f.effectClockNow() };
	}, guard)));
	const drift = Math.hypot(both[0].p[0] - both[1].p[0], both[0].p[2] - both[1].p[2]);
	const dt = Math.abs(both[0].t - both[1].t);
	h.check(drift <= 1.2 * dt + 0.25, `§5 A and B agree on the guard (${drift.toFixed(2)} m apart, ${dt.toFixed(2)} s between samples)`);
	// a player walks up: the camera (Play's eye) next to the guard
	await S(p, () => window.__stores.gameAnnounce.clearAnnounceLog());
	await S(p, (u) => {
		/** @type {any} */ let g, cam;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		window.__stores.globalCamera.subscribe((v) => (cam = v))();
		const o = g.getObjectByProperty('uuid', u);
		cam.position.set(o.position.x + 1.5, 1.7, o.position.z + 1.5);
		cam.updateMatrixWorld(true);
	}, guard);
	await h.eventually(
		() => S(p, () => new Promise((r) => window.__stores.gameAnnounce.announceLog.subscribe((rows) => r(rows.map((x) => x.text)))())),
		(rows) => rows.some((t) => /Spotted!/.test(t)),
		'§5 a player within 4 m is spotted'
	);

	for (const x of [A, B]) await S(x.page, () => window.__stores.isLocked.set(null));

	// --- §6 85 Q2/Q7 rewire: the mouse in Interact lights an unwired Highlight ------------------
	console.log('\n=== §6 Highlight under the mouse ===');
	const lamp = await box('Lamp', [0, 1, 2]);
	await S(p, ([u]) => {
		const st = window.__stores;
		st.restoreGraphs({ [u]: { nodes: [{ id: 'hl', type: 'highlight', position: { x: 0, y: 0 }, data: { type: 'highlight', label: 'Highlight', color: '#ffd54a', strength: 0.6, fade: 0.15 } }], edges: [] } });
		st.objectActions.applySelectionSet([]);
		st.editorMode.set('interact');
	}, [lamp]);
	await p.waitForTimeout(600);
	const at = await h.projectPoint(p, [0, 1, 2]);
	await p.mouse.move(at.x, at.y, { steps: 4 });
	await h.eventually(() => S(p, () => window.__stores.hoverState.hoverDebug().pointer ?? null), (v) => v === lamp, '§6 the mouse over the lamp is this person\'s pointer hover');
	await h.eventually(
		() => S(p, (u) => {
			/** @type {any} */ let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const m = g.getObjectByProperty('uuid', u)?.material;
			return m?.emissive ? m.emissive.r + m.emissive.g + m.emissive.b : 0;
		}, lamp),
		(v) => v > 0.05,
		'§6 the unwired Highlight glows under the mouse'
	);
	await S(p, () => window.__stores.editorMode.set('edit'));
	await browser.close();
});
