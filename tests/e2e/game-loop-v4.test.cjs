// 21-G6 — GAME LOOP v4: the 21-G pieces COMPOSED on two peers. The phase suites own
// the mechanics (project-manifest 26, project-file 48, peer-variables 74, scene-folders
// 44, scene-presence 11); this run proves they compose: a two-scene PROJECT, a
// per-player hunt with a live leaderboard, travel BY NAME through the manifest, and an
// edit that survives the round trip.
// Run: APP_URL='https://localhost:5204/' PEER_CONFIG=... npm run e2e -- game-loop-v4
const h = require('./helpers.cjs');

const childCount = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g?.children.length ?? 0;
	});
const visibleOf = (peer, uuid) =>
	peer.page.evaluate((id) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g?.getObjectByProperty('uuid', id)?.visible ?? null;
	}, uuid);
const makeBox = (peer) =>
	peer.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		s.objectActions.deselectObject();
		return g.children[g.children.length - 1].uuid;
	});
const collect = async (peer, uuid) => {
	await peer.page.evaluate((id) => window.__stores.flowRuntime.fireObjectClick(id), uuid);
	await peer.page.waitForTimeout(900);
};
const myVar = (peer, name) =>
	peer.page.evaluate((n) => {
		let m;
		window.__stores.peerVars.peerVarsMine.subscribe((v) => (m = v))();
		return m[n] ?? 0;
	}, name);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) await p.page.waitForFunction(() => !!window.__stores?.projectManifest, { timeout: 30000 });
	await h.connect(A, B); // B approves -> B is the session host / writer

	// ---- 1. the HUNT scene: two per-player gems + a leaderboard ------------------------
	const gem1 = await makeBox(A);
	const gem2 = await makeBox(A);
	const built = await A.page.evaluate(
		({ uuids }) => window.__stores.gameRecipes.makeCollectible(uuids, { quiet: true, variable: 'gems', perPlayer: true }),
		{ uuids: [gem1, gem2] }
	);
	h.check(built.built.length === 2, 'two per-player collectibles built');
	// B (the host/writer) saves the scene into the project
	await B.page.waitForTimeout(1200);
	const hunt = await B.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Hunt'));
	h.check(!!hunt?.hash, 'the Hunt scene is in the project (published by the writer)');
	await A.page.waitForTimeout(600);

	// ---- 2. both play; each collects THEIR OWN gem -------------------------------------
	for (const p of [A, B]) await p.page.evaluate(() => window.__stores.isLocked.set(true));
	await A.page.evaluate(() => window.__stores.gameState.setGameState('playing'));
	await A.page.waitForTimeout(900);
	await collect(A, gem1);
	h.check((await visibleOf(A, gem1)) === false, "A's gem hides for A");
	h.check((await visibleOf(B, gem1)) === true, '…and STAYS for B (per-player)');
	await collect(B, gem2);
	h.check((await visibleOf(B, gem2)) === false, "B's gem hides for B");
	h.check((await visibleOf(A, gem2)) === true, '…and stays for A');
	h.check((await myVar(A, 'gems')) === 1 && (await myVar(B, 'gems')) === 1, 'each banked their OWN row');
	// the leaderboard derivation reads both rows on both screens
	const rowsOnA = await A.page.evaluate(() => window.__stores.peerVars.leaderboardRows('gems'));
	const rowsOnB = await B.page.evaluate(() => window.__stores.peerVars.leaderboardRows('gems'));
	h.check(
		rowsOnA.length === 2 && rowsOnB.length === 2 && JSON.stringify(rowsOnA.map((r) => r.value)) === JSON.stringify(rowsOnB.map((r) => r.value)),
		`the leaderboard reads BOTH players identically on both screens (${JSON.stringify(rowsOnA.map((r) => r.value))})`
	);
	for (const p of [A, B]) await p.page.evaluate(() => window.__stores.isLocked.set(null));

	// ---- 3. a LOBBY scene + travel BY NAME through the manifest ------------------------
	await B.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await B.page.waitForTimeout(900);
	await makeBox(B);
	const lobby = await B.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Lobby'));
	h.check(!!lobby?.hash, 'the Lobby scene is in the project');
	// the travel NODE in name mode, pulsed on B, moves BOTH peers to the CURRENT Hunt
	const node = await B.page.evaluate(() => {
		const s = window.__stores;
		let p;
		s.peers.subscribe((v) => (v ? (p = v) : null))();
		const mk = (type, data, x) => ({ id: crypto.randomUUID(), type, position: { x, y: 40 }, data: { label: type, type, ...data }, class: 'w-[150px]' });
		const click = mk('onclick', {}, 40);
		const travel = mk('travel', { sceneName: 'Hunt', level: '', levelName: '' }, 260);
		for (const n of [click, travel]) {
			s.nodesHandler.createFlowNode(n, s.SCENE_GRAPH);
			if (p) p.send({ type: 'nodecreate', node: s.nodesHandler.serializeNode(n), graphId: s.SCENE_GRAPH });
		}
		const edge = { id: 'e-' + click.id + '-' + travel.id + '.trigger', source: click.id, target: travel.id, targetHandle: 'trigger' };
		s.nodesHandler.createFlowEdge(edge, s.SCENE_GRAPH);
		if (p) p.send({ type: 'edgecreate', edge: s.nodesHandler.serializeEdge(edge), graphId: s.SCENE_GRAPH });
		return click.id;
	});
	await h.eventually(
		() => A.page.evaluate((id) => window.__stores.allNodes().some((n) => n.id === id), node),
		(v) => v === true,
		'premise: A holds the travel binding'
	);
	await B.page.waitForTimeout(700); // the stale-stamp settle
	await B.page.evaluate((id) => window.__stores.flowRuntime.applyNodeTrigger(id, (Date.now() % 86400000) / 1000, true), node);
	for (const p of [A, B])
		await h.eventually(
			() => p.page.evaluate(() => {
				let c;
				window.__stores.levels.currentLevel.subscribe((v) => (c = v))();
				return c?.name ?? '';
			}),
			(n) => n === 'Hunt',
			`${p === A ? 'A' : 'B'} travelled BY NAME to the manifest's Hunt pointer`,
			30000
		);
	h.check((await childCount(A)) === 2 && (await childCount(B)) === 2, 'both stand in the Hunt scene (its two gems)');

	// ---- 4. the writer edits Hunt, hops away, and the edit SURVIVES --------------------
	await makeBox(B);
	const huntHist = await B.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return m.scenes.Hunt.history.length;
	});
	await B.page.evaluate(() => window.__stores.levels.travelToScene('Lobby'));
	await h.eventually(() => childCount(B), (n) => n === 1, 'B is in the Lobby');
	await h.eventually(
		() => B.page.evaluate(() => {
			let m;
			window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
			return m.scenes.Hunt.history.length;
		}),
		(n) => n === huntHist + 1,
		'leaving Hunt auto-published the edit as a new version'
	);
	await B.page.evaluate(() => window.__stores.levels.travelToScene('Hunt'));
	await h.eventually(() => childCount(B), (n) => n === 3, 'back in Hunt: the edit SURVIVED the round trip');

	for (const p of [A, B]) {
		const errs = await h.pageErrors(p);
		h.check(errs.length === 0, `no page errors on ${p === A ? 'A' : 'B'} (${JSON.stringify(errs)})`);
	}
	await h.finish(browser);
});
