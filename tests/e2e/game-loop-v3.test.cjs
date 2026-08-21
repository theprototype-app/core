// 21-F6 — GAME LOOP v3, the acceptance run for the whole roadmap: two LEVELS, a
// per-group collectible variable, travel that carries the campaign, a rejoin
// mid-round, the admin reset, the debug element, and the minimap colour symmetry —
// every piece driven the way a user's game would drive it, on two real peers.
//
// TIMING: h.GPU_ARGS (travel loads scenes; the debug sampler is timed).
// Run: APP_URL='https://localhost:5204/' PEER_CONFIG=... npm run e2e -- game-loop-v3
const h = require('./helpers.cjs');

const childUuids = (peer) =>
	peer.page.evaluate(() => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return (group?.children ?? []).map((c) => c.uuid).sort();
	});
const visibleOf = (peer, uuids) =>
	peer.page.evaluate((ids) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return ids.map((id) => group?.getObjectByProperty('uuid', id)?.visible ?? null);
	}, uuids);
const gstate = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.gameState.gameState.subscribe((v) => (g = v))();
		return g;
	});
const counts = (peer, variable) =>
	peer.page.evaluate((v) => window.__stores.flowRuntime.collectibleCountsFor(v), variable);
const collect = async (peer, uuid, settle = 900) => {
	await peer.page.evaluate((id) => window.__stores.flowRuntime.fireObjectClick(id), uuid);
	await peer.page.waitForTimeout(settle);
};
const setPlay = async (peer, v) => {
	await peer.page.evaluate((x) => window.__stores.isLocked.set(x), v);
	await peer.page.waitForTimeout(700);
};
const makeBoxes = (peer, count) =>
	peer.page.evaluate(async (n) => {
		const s = window.__stores;
		const uuids = [];
		for (let i = 0; i < n; i++) {
			s.commandsHandler.sceneCommand('/create box');
			await new Promise((r) => setTimeout(r, 1100));
			let group;
			s.objectsGroup.subscribe((v) => (group = v))();
			uuids.push(group.children[group.children.length - 1].uuid);
		}
		s.objectActions.deselectObject();
		return uuids;
	}, count);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) await p.page.waitForFunction(() => !!window.__stores?.levels, { timeout: 30000 });
	await h.connect(A, B); // A dials, B approves -> B is the session host / admin

	// =====================================================================
	// 1. AUTHOR LEVEL TWO first: one gem counting into "gems", saved as an asset
	// =====================================================================
	const [l2gem] = await makeBoxes(A, 1);
	await A.page.evaluate((uuid) => window.__stores.gameRecipes.makeCollectible([uuid], { quiet: true }), l2gem);
	const levelTwo = await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Level Two'));
	h.check(!!levelTwo?.hash, 'Level Two saved — its collectible chain rides the level graph');

	// =====================================================================
	// 2. AUTHOR LEVEL ONE live: a GROUP of two crystals + the travel binding
	// =====================================================================
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await A.page.waitForTimeout(900);
	const crystals = await makeBoxes(A, 2);
	const groupUuid = await A.page.evaluate((ids) => {
		const s = window.__stores;
		s.objectActions.applySelectionSet(ids);
		const uuid = s.objectActions.groupSelection();
		s.objectActions.deselectObject();
		return uuid;
	}, crystals);
	h.check(!!groupUuid, 'premise: the two crystals are one Group');
	const built = await A.page.evaluate(
		({ group, variable }) => window.__stores.gameRecipes.makeCollectible([group], { quiet: true, variable }),
		{ group: groupUuid, variable: 'crystals' }
	);
	h.check(
		built.built.length === 2 && built.entries === 1,
		`the GROUP recipe: every child mesh a collectible, ONE undo entry (${built.built.length} built, ${built.entries} entries)`
	);
	// the travel binding: a click that moves everyone to Level Two
	const travel = await A.page.evaluate(({ hash }) => {
		const s = window.__stores;
		let p;
		s.peers.subscribe((v) => (p = v))();
		const mk = (type, data, x) => ({ id: crypto.randomUUID(), type, position: { x, y: 600 }, data: { label: type, type, ...data }, class: 'w-[150px]' });
		const click = mk('onclick', {}, 40);
		const node = mk('travel', { level: hash, levelName: 'Level Two' }, 260);
		for (const n of [click, node]) {
			s.nodesHandler.createFlowNode(n, s.SCENE_GRAPH);
			if (p) p.send({ type: 'nodecreate', node: s.nodesHandler.serializeNode(n), graphId: s.SCENE_GRAPH });
		}
		const edge = { id: 'e-' + click.id + '-' + node.id + '.trigger', source: click.id, target: node.id, targetHandle: 'trigger' };
		s.nodesHandler.createFlowEdge(edge, s.SCENE_GRAPH);
		if (p) p.send({ type: 'edgecreate', edge: s.nodesHandler.serializeEdge(edge), graphId: s.SCENE_GRAPH });
		return { click: click.id };
	}, { hash: levelTwo.hash });
	await h.eventually(
		() => B.page.evaluate(() => window.__stores.allNodes().length),
		(n) => n >= 16,
		'premise: the peer holds level one\'s whole graph (two chains + the travel binding)'
	);

	// =====================================================================
	// 3. ROUND ONE: both play, collect a crystal, the counts and the debug agree
	// =====================================================================
	await A.page.evaluate(() => window.__stores.gameState.setGameState('playing'));
	for (const p of [A, B]) await setPlay(p, true);
	await A.page.waitForTimeout(700);
	const before = await counts(A, 'crystals');
	h.check(before.total === 2 && before.left === 2, `premise: 2 crystals on the table (${JSON.stringify(before)})`);

	await collect(A, crystals[0]);
	h.check((await visibleOf(A, [crystals[0]]))[0] === false, 'collected: hidden for the collector');
	await h.eventually(
		() => visibleOf(B, [crystals[0]]),
		(v) => v[0] === false,
		'and hidden for the peer, from the same replicated stamp'
	);
	const after = await counts(B, 'crystals');
	h.check(after.collected === 1 && after.left === 1, `the peer DERIVES the same counts (${JSON.stringify(after)})`);

	// the debug element reads the same truth
	await A.page.evaluate(() => {
		window.__stores.hudDocs.setHudDocFor('scene', {
			screens: [{ id: 'main', name: 'Main', elements: [
				{ id: 'dbg', kind: 'debug', anchor: 'top-left', x: 12, y: 12, w: 280, h: 26, compact: false, variable: 'crystals' },
				{ id: 'map', kind: 'minimap', anchor: 'bottom-right', x: 12, y: 12, w: 160, h: 160, showFacing: true }
			] }],
			active: 'main'
		});
	});
	await A.page.waitForTimeout(1400);
	const pill = await A.page.evaluate(() => document.querySelector('.hud-debug')?.textContent ?? '');
	h.check(pill.includes('playing') && pill.includes('1/2 left'), `the debug element reads the live game (${pill.split('level:')[0].trim()})`);
	h.check((pill.match(/playing/g) || []).length >= 2, 'and shows both players in play mode');

	// =====================================================================
	// 4. MINIMAP SYMMETRY: A's colour for B is B's own peerColor, on BOTH screens
	// =====================================================================
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.hudMinimap.lastMinimapFrame().peers.length),
		(n) => n >= 1,
		'premise: the minimap plots the peer'
	);
	const symmetric = await A.page.evaluate((bid) => {
		const frame = window.__stores.hudMinimap.lastMinimapFrame();
		const dot = frame.peers.find((p) => p.id === bid);
		return { dot: dot?.color ?? null, rule: window.__stores.lockControl.peerColor(bid) };
	}, B.id);
	const bOwn = await B.page.evaluate((bid) => window.__stores.lockControl.peerColor(bid), B.id);
	h.check(
		!!symmetric.dot && symmetric.dot === symmetric.rule && symmetric.rule === bOwn,
		`ONE colour rule on every screen: A draws B as ${symmetric.dot}, B computes ${bOwn}`
	);

	// =====================================================================
	// 5. TRAVEL: the campaign carries, level two's collectibles are FRESH
	// =====================================================================
	const roundBefore = (await gstate(A)).round;
	await A.page.waitForTimeout(700); // past the stale-stamp cutoff for the fresh binding
	await A.page.evaluate((id) => window.__stores.flowRuntime.applyNodeTrigger(id, (Date.now() % 86400000) / 1000, true), travel.click);
	for (const p of [A, B])
		await h.eventually(
			() => childUuids(p),
			(ids) => ids.includes(l2gem),
			`${p === A ? 'A' : 'B'} landed in Level Two`,
			30000
		);
	const carried = await gstate(B);
	h.check(
		carried.state === 'playing' && carried.round === roundBefore && Number(carried.vars.crystals ?? 0) >= 1,
		`the campaign CARRIED: still playing, round ${carried.round}, crystals ${carried.vars.crystals}`
	);
	h.check((await visibleOf(A, [l2gem]))[0] === true, "level two's gem is FRESH — its latches live in the level's own graph");
	const l2counts = await counts(A, 'gems');
	h.check(l2counts.total === 1 && l2counts.left === 1, `and its counts read from the new graph (${JSON.stringify(l2counts)})`);

	await collect(B, l2gem);
	await h.eventually(() => visibleOf(A, [l2gem]), (v) => v[0] === false, 'B collects in level two, A sees it');

	// =====================================================================
	// 6. REJOIN MID-ROUND: leaving play changes nothing shared
	// =====================================================================
	await setPlay(B, false); // the transient Controls writes on a real exit
	await setPlay(B, null);
	h.check((await gstate(B)).state === 'playing', "B's own Esc changed nothing shared");
	await setPlay(B, true);
	h.check((await visibleOf(B, [l2gem]))[0] === false, 'rejoining mid-round, collected stays collected');

	// =====================================================================
	// 7. ADMIN RESET: gated to the host, and the world comes back
	// =====================================================================
	const refused = await A.page.evaluate(() => window.__stores.gamePresence.requestResetGame());
	h.check(refused.ok === false && !!refused.reason, `the non-host is refused with the reason (${refused.reason})`);
	const granted = await B.page.evaluate(() => window.__stores.gamePresence.requestResetGame());
	h.check(granted.ok === true, 'the session host resets');
	await h.eventually(() => gstate(A), (g) => g.state === 'menu', 'the reset replicated');
	for (const p of [A, B]) await setPlay(p, null);
	await h.eventually(
		() => visibleOf(A, [l2gem]),
		(v) => v[0] === true,
		'outside the round the gem renders again — the recipe visibility stands down'
	);

	for (const p of [A, B]) {
		const errs = await h.pageErrors(p);
		h.check(errs.length === 0, `no page errors on ${p === A ? 'A' : 'B'} (${JSON.stringify(errs)})`);
	}
	await h.finish(browser);
});
