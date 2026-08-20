// A6.4: a node type nothing in this app defines must SAY so, and a module installed
// after the Flow dock mounted must start rendering its own nodes.
//
// One rewrite of Nodes.svelte's `nodeTypes` fixes three bugs, and this suite pins all
// three - each with the counterfactual, because the reactivity one in particular broke
// the GOOD case (install the module, then load the scene = exactly what a game
// template does) and nothing would have noticed:
//
//   1. `get(moduleNodeGroups)` was a NON-REACTIVE init-time read
//   2. module types were spread LAST, so a module could SHADOW a core type
//   3. an unknown type fell through to xyflow's bare default card
//
// The dock is opened through the REAL opener (the Node editor button), not by setting
// a store: a feature with no entry point is invisible to a suite that supplies its own.
//
// Run: $env:APP_URL='https://localhost:5204/'; npm run e2e -- flow-unknown-node
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const peer = await h.setupPage(browser, 'unknown-node');
	const page = peer.page;
	await page.waitForFunction(() => !!window.__stores?.sessions, { timeout: 30000 });

	// ---- 0. open the Node editor the way a user does --------------------------
	await page.locator('p[title="Node editor (N)"]').click();
	await page.waitForTimeout(1400);
	h.check(
		await page.evaluate(() => !!window.__flowNodeTypes),
		'premise: the Flow pane mounted and exposes its resolved node types'
	);

	// ---- 0b. EVERY palette node has a renderer -------------------------------
	// The gap this file exists to describe has a second, quieter form: a node added to
	// `nodeCatalog` (so the palette offers it, and a user can place it) but NOT to
	// CORE_NODE_TYPES, whose fallback is the very warning card below. The user then
	// drags a CORE node out of the core palette and is told to install a module.
	// Measured once, on `setlook`. Checking the whole catalog costs the same line as
	// checking one type, and covers every node added from here on.
	const gap = await page.evaluate(() => {
		const groups = window.__stores.nodeCatalog.nodeCatalog ?? [];
		const catalog = groups.flatMap((g) => (g.items ?? []).map((n) => n.type)).filter(Boolean);
		const renderable = new Set(window.__flowNodeTypes.live());
		return { count: catalog.length, missing: catalog.filter((t) => !renderable.has(t)) };
	});
	h.check(gap.count > 40, `premise: the whole catalog was read (${gap.count} types)`);
	h.check(
		gap.missing.length === 0,
		`every catalog node type resolves to a real card: ${JSON.stringify(gap.missing)}`
	);

	// ---- 1. an unknown type gets the warning card ----------------------------
	// Seed the SCENE graph with a node whose type no core entry and no installed
	// module defines - which is what a .tpscene authored against a module produces on
	// a machine that does not have it.
	await page.evaluate(() => {
		const s = window.__stores;
		s.updateGraph(s.SCENE_GRAPH, () => ({
			nodes: [
				{ id: 'u1', type: 'dungeonspawner', position: { x: 60, y: 60 }, data: { type: 'dungeonspawner', rooms: 4 } },
				{ id: 'k1', type: 'counter', position: { x: 320, y: 60 }, data: { type: 'counter' } }
			],
			edges: []
		}));
	});
	await page.waitForTimeout(900);
	const resolved = await page.evaluate(() => ({
		unknown: window.__flowNodeTypes.unknown(),
		here: window.__flowNodeTypes.unknownHere(),
		mapped: window.__flowNodeTypes.live().includes('dungeonspawner')
	}));
	h.check(resolved.unknown.includes('dungeonspawner'), 'the unresolvable type is identified as unknown');
	h.check(resolved.mapped, 'and gets a renderer, so xyflow never falls back to its bare default card');
	h.check(resolved.here === 1, 'exactly ONE node of the visible graph is counted, not the Counter (' + resolved.here + ')');

	// the card itself: it must name the type and offer the way out
	const cardText = await page.locator('.svelte-flow__node').filter({ hasText: 'dungeonspawner' }).first().innerText();
	h.check(/dungeonspawner/.test(cardText), 'the card names the missing type: ' + JSON.stringify(cardText.slice(0, 60)));
	h.check(/module/i.test(cardText), 'and explains that it comes from a module');
	// a YELLOW header is the whole point of the NodeWrapper accent prop - assert the
	// COMPUTED colour, never the class string (the ToolboxWindow lesson: the class was
	// right the whole time while a scoped style beat it)
	const accent = await page
		.locator('.svelte-flow__node')
		.filter({ hasText: 'dungeonspawner' })
		.first()
		.locator('.node-card')
		.evaluate((el) => getComputedStyle(el).getPropertyValue('--node-accent').trim());
	h.check(/facc15|250,\s*204,\s*21/.test(accent), 'the card reads as a WARNING, not as another gray node (' + accent + ')');
	const installBtn = page.locator('.svelte-flow__node').filter({ hasText: 'dungeonspawner' }).getByText('Install module');
	h.check(await installBtn.count() === 1, 'it offers an Install action');

	// ---- 2. the topbar badge ------------------------------------------------
	const badge = page.locator('#flow-unknown-badge');
	h.check(await badge.count() === 1, 'the topbar grows a "N nodes need modules" badge');
	const badgeText = await badge.innerText();
	h.check(/1 node needs modules/.test(badgeText), 'the badge counts them: ' + JSON.stringify(badgeText.trim()));
	await badge.click();
	await page.waitForTimeout(500);
	h.check(
		await page.evaluate(() => new Promise((r) => window.__stores.modulesOpen.subscribe((v) => r(v))())),
		'and clicking it opens the Modules manager'
	);
	await page.evaluate(() => window.__stores.modulesOpen.set(false));
	await page.waitForTimeout(400);

	// ---- 3. THE COUNTERFACTUAL: a module installed AFTER the dock mounted ----
	// This is bug (1), and it is the one that broke the good case. The pane exposes
	// both the LIVE map and the snapshot it resolved at mount; with the old
	// non-reactive read the two were identical, so the new type could never appear.
	const before = await page.evaluate(() => ({
		live: window.__flowNodeTypes.live().includes('lateknob'),
		atMount: window.__flowNodeTypes.atMount.includes('lateknob')
	}));
	h.check(!before.live && !before.atMount, 'premise: nothing knows the module type yet');
	await page.evaluate(async () => {
		const s = window.__stores;
		// through initModules, so makeApi runs and the teardown journal records - the
		// real path a community module takes, not the registry directly
		await s.moduleSDK.initModules([
			{
				id: 'latemod',
				name: 'Late module',
				version: '1.0.0',
				register(api) {
					api.registerNodeGroup({
						group: 'Late module',
						items: [{ type: 'lateknob', label: 'Late knob', params: [] }]
					});
					api.registerEffect('lateknob', () => {});
				}
			}
		]);
	});
	await page.waitForTimeout(900);
	const after = await page.evaluate(() => ({
		live: window.__flowNodeTypes.live().includes('lateknob'),
		atMount: window.__flowNodeTypes.atMount.includes('lateknob'),
		unknown: window.__flowNodeTypes.unknown().includes('lateknob')
	}));
	h.check(after.live, 'the LIVE map picks the new module type up without remounting the dock');
	h.check(
		!after.atMount,
		'and the mount-time snapshot still does NOT - which is what the old non-reactive read gave every time'
	);
	h.check(!after.unknown, 'so the type is no longer treated as unknown');

	// it renders as its module card, not as the warning card
	await page.evaluate(() => {
		const s = window.__stores;
		s.updateGraph(s.SCENE_GRAPH, (g) => ({
			nodes: [
				...g.nodes,
				{ id: 'late1', type: 'lateknob', position: { x: 60, y: 240 }, data: { type: 'lateknob' } }
			],
			edges: g.edges
		}));
	});
	await page.waitForTimeout(800);
	const lateCard = await page.locator('.svelte-flow__node').filter({ hasText: 'lateknob' }).first().innerText();
	h.check(
		!/isn't installed|need.*module/i.test(lateCard),
		'a node from the just-installed module renders normally: ' + JSON.stringify(lateCard.slice(0, 50))
	);
	const stillOne = await page.evaluate(() => window.__flowNodeTypes.unknownHere());
	h.check(stillOne === 1, 'the badge count is unchanged by it (' + stillOne + ')');

	// ---- 4. a module type may NOT shadow a core one --------------------------
	// Bug (2): module types were spread LAST, so a module claiming 'counter' silently
	// replaced the core Counter card and left it unreachable with no clue why.
	const shadow = await page.evaluate(async () => {
		const s = window.__stores;
		const logs = [];
		const orig = console.log;
		console.log = (...args) => {
			logs.push(args.join(' '));
			orig(...args);
		};
		await s.moduleSDK.initModules([
			{
				id: 'shadowmod',
				name: 'Shadow module',
				version: '1.0.0',
				register(api) {
					api.registerNodeGroup({
						group: 'Shadow module',
						items: [{ type: 'counter', label: 'Not the real counter', params: [] }]
					});
					api.registerEffect('counter', () => {});
				}
			}
		]);
		await new Promise((r) => setTimeout(r, 900));
		console.log = orig;
		return { warned: logs.some((l) => /shadow core types/i.test(l)) };
	});
	h.check(shadow.warned, 'a colliding module type WARNS instead of silently winning');
	// the core Counter card must still be the one that renders
	const counterCard = await page.locator('.svelte-flow__node').filter({ hasText: 'counter' }).first().innerText();
	h.check(
		!/Not the real counter/.test(counterCard),
		'and the CORE node still renders: ' + JSON.stringify(counterCard.slice(0, 50))
	);

	// ---- 5. an unknown node round-trips a save byte-identically -------------
	// serializeNode copies `data` wholesale, which is what makes "installing the module
	// brings it back to life" a promise rather than a hope.
	const round = await page.evaluate(() => {
		const s = window.__stores;
		const payload = s.sessions.buildSessionPayload('unknown round trip');
		const saved = (payload.graphs?.[s.SCENE_GRAPH]?.nodes ?? []).find((/** @type {any} */ n) => n.id === 'u1');
		return { type: saved?.type ?? null, rooms: saved?.data?.rooms ?? null };
	});
	h.check(round.type === 'dungeonspawner', 'the unknown node is saved with its type intact');
	h.check(round.rooms === 4, 'and with its data untouched (' + round.rooms + ')');

	h.check(h.pageErrors(peer).length === 0, 'no page errors: ' + h.pageErrors(peer).join(' | '));
	await h.finish(browser);
});
