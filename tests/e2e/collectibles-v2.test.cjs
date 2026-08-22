// 21-F2 — COLLECTIBLES V2: the reported bug, the reset rule, groups, respawn, variables.
//
// THE BUG THIS OPENS WITH is the reason the phase exists: a collected object stayed
// invisible after leaving play and could not be un-hidden from the object list, because
// the Visibility effect re-applies every frame and wins forever. Section 1 is the user's
// sequence, step for step, and its last two checks are the ones that would have caught
// it — "the object list can hide it" and "the object list can SHOW it again and it
// stays shown".
//
// THE TWO MECHANISMS UNDER TEST, both opt-in per node so nothing here can surprise a
// hand-built graph (sections 1e and 2e are those counterfactuals, and they matter as
// much as the positive ones):
//
//   `whilePlaying` on Visibility   the effect stands down unless I am playing AND a
//                                  round is underway — LOCAL, so my own Esc is enough
//   `perRound` on Latch / Once     a trigger stamp older than the round's `startedAt`
//                                  did not happen, so a new round (or a return to the
//                                  menu) un-collects everything with nothing sent
//
// TIMING: `h.GPU_ARGS`, because the respawn section measures a real delay and a
// SwiftShader page ticks at ~2.5 fps.
//
// Run: $env:APP_URL='https://localhost:5200/'; PEER_CONFIG=...; npm run e2e -- collectibles-v2
const h = require('./helpers.cjs');

// ---- reading the world -----------------------------------------------------------
const visibleOf = (peer, uuids) =>
	peer.page.evaluate((ids) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return ids.map((id) => group?.getObjectByProperty('uuid', id)?.visible ?? null);
	}, uuids);

const varOf = (peer, name) => peer.page.evaluate((n) => window.__stores.gameState.gameVar(n, 0), name);

const valueOf = (peer, id) =>
	peer.page.evaluate((nid) => {
		let v;
		window.__stores.flowValues.subscribe((x) => (v = x))();
		return v[nid];
	}, id);

const gstate = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.gameState.gameState.subscribe((v) => (g = v))();
		return { state: g.state, round: g.round, startedAt: g.startedAt };
	});

/** The THREE-state play store, written exactly as Controls writes it. */
const setPlay = (peer, state) => peer.page.evaluate((s) => window.__stores.isLocked.set(s), state);

const nodeCount = (peer, type) =>
	peer.page.evaluate((t) => {
		let g;
		window.__stores.flowGraphs.subscribe((v) => (g = v))();
		return (g.scene?.nodes ?? []).filter((n) => n.type === t).length;
	}, type);

/** A clean slate has to be cleaned on EVERY peer — `clearGraphs()` does not broadcast,
 * and nodesync's hash compare then has the emptier peer PULL the graph back. */
const wipe = async (peers) => {
	for (const p of peers)
		await p.page.evaluate(() => {
			window.__stores.clearGraphs();
			window.__stores.gameState.clearGameState();
			window.__stores.isLocked.set(null);
		});
	await peers[0].page.waitForTimeout(900);
};

const makeBoxes = (peer, count) =>
	peer.page.evaluate(async (n) => {
		const s = window.__stores;
		/** @type {string[]} */
		const uuids = [];
		for (let i = 0; i < n; i++) {
			s.commandsHandler.sceneCommand('/create box');
			await new Promise((r) => setTimeout(r, 1100));
			let group;
			s.objectsGroup.subscribe((v) => (group = v))();
			uuids.push(group.children[group.children.length - 1].uuid);
		}
		// creating SELECTS, and the flow editor's scope follows the selection
		s.objectActions.deselectObject();
		s.setActiveGraph(s.SCENE_GRAPH);
		return uuids;
	}, count);

// 21-G R3a MOVED THE RECIPE OUT OF CORE: `gameRecipes.makeCollectible` is gone, and the
// collectible module owns the authoring half now. What is under test here is the CHAIN
// SEMANTICS — latch/once `perRound`, visibility `whilePlaying`, setvariable scope — every
// one of which is still core and unchanged. So the builder becomes a test FIXTURE
// (`h.makeCollectibleChains`) that assembles the identical 7-node chain through the same
// replicated nodesHandler path, and every check below reads exactly as it did.
const recipe = (peer, uuids, opts = {}) => h.makeCollectibleChains(peer, uuids, opts);

/** Walk the chain the recipe built for ONE object, back from its Object Selector — the
 * recipe returns uuids, not node ids, and every assertion below needs the nodes. */
const chainOf = (peer, uuid) =>
	peer.page.evaluate((id) => {
		let g;
		window.__stores.flowGraphs.subscribe((v) => (g = v))();
		const nodes = g.scene?.nodes ?? [];
		const edges = g.scene?.edges ?? [];
		const back = (targetId, handle) => {
			const e = edges.find((x) => x.target === targetId && (handle === undefined || (x.targetHandle ?? null) === handle));
			return e ? nodes.find((n) => n.id === e.source) : null;
		};
		const forwardTo = (sourceId, type, handle) => {
			const e = edges.find(
				(x) =>
					x.source === sourceId &&
					(handle === undefined || (x.targetHandle ?? null) === handle) &&
					nodes.find((n) => n.id === x.target)?.type === type
			);
			return e ? nodes.find((n) => n.id === e.target) : null;
		};
		const sel = nodes.find((n) => n.type === 'objectselector' && n.data?.selected === id);
		if (!sel) return null;
		const vis = back(sel.id, null);
		const gate = back(vis?.id, 'on');
		const latch = back(gate?.id, 'a');
		const click = back(latch?.id, 'set');
		const once = click ? forwardTo(click.id, 'once', 'trigger') : null;
		const count = once ? forwardTo(once.id, 'setvariable', 'trigger') : null;
		// the respawn Delay hangs off the CLICK, not the Once — see the recipe's note
		const delay = click ? forwardTo(click.id, 'delay', 'trigger') : null;
		return {
			selector: sel.id,
			vis: vis?.id ?? null,
			visWhilePlaying: vis?.data?.whilePlaying ?? null,
			gate: gate?.id ?? null,
			latch: latch?.id ?? null,
			latchPerRound: latch?.data?.perRound ?? null,
			click: click?.id ?? null,
			once: once?.id ?? null,
			oncePerRound: once?.data?.perRound ?? null,
			variable: count?.data?.name ?? null,
			delay: delay?.id ?? null,
			delaySeconds: delay?.data?.seconds ?? null,
			// the respawn's two returning edges, by handle
			resetsLatch: !!edges.find((e) => e.source === delay?.id && e.target === latch?.id && e.targetHandle === 'reset'),
			rearmsOnce: !!edges.find((e) => e.source === delay?.id && e.target === once?.id && e.targetHandle === 'rearm')
		};
	}, uuid);

const collect = async (peer, uuid, settle = 700) => {
	await peer.page.evaluate((id) => window.__stores.flowRuntime.fireObjectClick(id), uuid);
	await peer.page.waitForTimeout(settle);
};

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B])
		await p.page.waitForFunction(() => !!window.__stores?.flowGraphsCtl && !!window.__stores?.nodesHandler, { timeout: 30000 });
	// connect FIRST: a peer cannot approve a connection request while in play mode
	await h.connect(A, B);

	// =====================================================================
	// 1. THE BUG, exactly as reported: collect -> Esc -> the object is back,
	//    and the object list works on it again
	// =====================================================================
	await wipe([A, B]);
	const [gem] = await makeBoxes(A, 1);
	const built1 = await recipe(A, [gem]);
	h.check(built1.built.length === 1, `premise: the recipe built one collectible (${built1.built.length})`);
	const chain = await chainOf(A, gem);
	h.check(!!chain && !!chain.latch && !!chain.once, 'premise: its chain is readable from the Object Selector back');
	h.check(
		chain.visWhilePlaying === true && chain.latchPerRound === true && chain.oncePerRound === true,
		`the recipe STAMPS what it builds — visibility.whilePlaying=${chain.visWhilePlaying}, latch.perRound=${chain.latchPerRound}, once.perRound=${chain.oncePerRound}`
	);
	h.check(chain.delay === null, 'and no respawn chain unless one was asked for');

	await setPlay(A, true);
	await A.page.waitForTimeout(600);
	h.check((await visibleOf(A, [gem]))[0] === true, 'premise: visible when play starts');

	await collect(A, gem);
	h.check((await visibleOf(A, [gem]))[0] === false, 'clicking it collects it — hidden while playing');
	h.check((await varOf(A, 'gems')) === 1, `and counts 1 (${await varOf(A, 'gems')})`);
	h.check((await valueOf(A, chain.latch)) === true, 'premise: the Latch is SET, which is what holds it hidden');

	// ---- Esc. `isLocked` is three-state, so BOTH values must open the gate -------
	await setPlay(A, false); // the instant Controls writes on exit
	await A.page.waitForTimeout(600);
	const afterEscFalse = (await visibleOf(A, [gem]))[0];
	h.check(afterEscFalse === true, `THE BUG: leaving play brings the object straight back (isLocked=false -> visible ${afterEscFalse})`);
	await setPlay(A, null); // ...and the value Controls settles on 2s later
	await A.page.waitForTimeout(600);
	h.check((await visibleOf(A, [gem]))[0] === true, 'and it stays back once the store settles to null (the three-state trap)');
	h.check(
		(await valueOf(A, chain.latch)) === true,
		'while the SHARED state is untouched — my own Esc collects nothing and un-collects nothing'
	);

	// ---- the object list, on the object the runtime just handed back -------------
	await A.page.evaluate((id) => window.__stores.objectActions.toggleObjectVisibility(id), gem);
	await A.page.waitForTimeout(800); // several ticks: a re-applying effect would win here
	h.check((await visibleOf(A, [gem]))[0] === false, 'the object list can HIDE it outside play');
	await A.page.evaluate((id) => window.__stores.objectActions.toggleObjectVisibility(id), gem);
	await A.page.waitForTimeout(800);
	h.check((await visibleOf(A, [gem]))[0] === true, 'and SHOW it again — manual visibility wins outside play');

	// ---- back into play: the collection survived (nothing shared changed) --------
	await setPlay(A, true);
	await A.page.waitForTimeout(700);
	h.check((await visibleOf(A, [gem]))[0] === false, 'entering play again hides it once more — it is still collected');
	await setPlay(A, null);
	await A.page.waitForTimeout(500);

	// ---- 1e. THE COUNTERFACTUAL: a HAND-BUILT chain is untouched ----------------
	// the same graph WITHOUT the flag must behave exactly as it did before this phase:
	// it hides the object whether or not anyone is playing.
	const hand = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		const uuid = group.children[group.children.length - 1].uuid;
		s.objectActions.deselectObject();
		s.setActiveGraph(s.SCENE_GRAPH);
		// Visibility(off) -> Object Selector, drawn by hand, no `whilePlaying`
		const mk = (type, data) => ({
			id: crypto.randomUUID(),
			type,
			position: { x: 0, y: 900 },
			data: { type, ...data },
			class: 'w-[150px]'
		});
		const vis = mk('visibility', { on: false });
		const sel = mk('objectselector', { selected: uuid });
		s.nodesHandler.createFlowNode(vis, s.SCENE_GRAPH);
		s.nodesHandler.createFlowNode(sel, s.SCENE_GRAPH);
		s.nodesHandler.createFlowEdge({ id: 'e-' + vis.id + '-' + sel.id, source: vis.id, target: sel.id }, s.SCENE_GRAPH);
		await new Promise((r) => setTimeout(r, 900));
		return uuid;
	});
	h.check(
		(await visibleOf(A, [hand]))[0] === false,
		`a hand-built Visibility chain still hides its object OUTSIDE play — the rule is opt-in (${(await visibleOf(A, [hand]))[0]})`
	);

	// =====================================================================
	// 2. THE RESET RULE: a new round un-collects, and so does the menu
	// =====================================================================
	await wipe([A, B]);
	const [g2] = await makeBoxes(A, 1);
	await recipe(A, [g2]);
	const c2 = await chainOf(A, g2);
	await setPlay(A, true);
	await A.page.evaluate(() => window.__stores.gameState.setGameState('playing'));
	await A.page.waitForTimeout(700);
	const round1 = await gstate(A);
	h.check(round1.round === 1 && round1.startedAt > 0, `premise: round 1 is underway (${JSON.stringify(round1)})`);

	await collect(A, g2);
	h.check((await visibleOf(A, [g2]))[0] === false, 'collected in round 1');
	h.check((await varOf(A, 'gems')) === 1, `counted once (${await varOf(A, 'gems')})`);

	// everyone to the menu
	await A.page.evaluate(() => window.__stores.gameState.setGameState('menu'));
	await A.page.waitForTimeout(800);
	h.check(
		(await valueOf(A, c2.latch)) === false,
		'returning to the MENU reads the Latch as un-collected — the cutoff is derived from the round, not wired'
	);
	h.check((await visibleOf(A, [g2]))[0] === true, 'so the gem is back on the table');

	// a NEW round: it must be collectible AND countable again
	await A.page.evaluate(() => window.__stores.gameState.setGameState('playing'));
	await A.page.waitForTimeout(800);
	const round2 = await gstate(A);
	h.check(round2.round === 2 && round2.startedAt > round1.startedAt, `premise: a new round bumped the stamp (${JSON.stringify(round2)})`);
	h.check((await visibleOf(A, [g2]))[0] === true, 'the gem starts round 2 visible');
	await collect(A, g2);
	h.check((await visibleOf(A, [g2]))[0] === false, 'and can be collected again');
	h.check(
		(await varOf(A, 'gems')) === 2,
		`AND COUNTS AGAIN — the Once is re-armed by the round bump, not by an edge (${await varOf(A, 'gems')})`
	);

	// ---- 2b. it converges on the PEER, which never touched a reset --------------
	await setPlay(B, true);
	await B.page.waitForTimeout(600);
	const peerRound2 = await visibleOf(B, [g2]);
	h.check(peerRound2[0] === false, `the peer derives the same collected state in round 2 (${peerRound2[0]})`);
	await A.page.evaluate(() => window.__stores.gameState.setGameState('menu'));
	await A.page.waitForTimeout(900);
	h.check(
		(await valueOf(B, c2.latch)) === false,
		'and the same reset when the round ends — both peers read one replicated stamp, nothing was sent'
	);
	await setPlay(B, null);

	// ---- 2e. THE COUNTERFACTUAL: a latch WITHOUT `perRound` ignores the round ----
	const plain = await A.page.evaluate(async () => {
		const s = window.__stores;
		const mk = (type, data) => ({
			id: crypto.randomUUID(),
			type,
			position: { x: 0, y: 1200 },
			data: { type, ...data },
			class: 'w-[150px]'
		});
		const click = mk('onclick', {});
		const latch = mk('latch', {}); // no perRound — a plain hold, in a graph with no game
		s.nodesHandler.createFlowNode(click, s.SCENE_GRAPH);
		s.nodesHandler.createFlowNode(latch, s.SCENE_GRAPH);
		s.nodesHandler.createFlowEdge(
			{ id: 'e-' + click.id + '-' + latch.id + '.set', source: click.id, target: latch.id, targetHandle: 'set' },
			s.SCENE_GRAPH
		);
		await new Promise((r) => setTimeout(r, 700));
		s.flowRuntime.applyNodeTrigger(click.id, (Date.now() % 86400000) / 1000, false);
		await new Promise((r) => setTimeout(r, 700));
		return latch.id;
	});
	h.check((await valueOf(A, plain)) === true, 'premise: a plain Latch is set by its click');
	await A.page.evaluate(() => window.__stores.gameState.setGameState('playing'));
	await A.page.waitForTimeout(900);
	h.check(
		(await valueOf(A, plain)) === true,
		'a Latch WITHOUT `perRound` keeps its state across a round bump — nobody pressing Start can surprise it'
	);
	await A.page.evaluate(() => window.__stores.gameState.setGameState('menu'));
	await setPlay(A, null);

	// =====================================================================
	// 3. REJOIN MID-ROUND: leaving play changes nothing shared
	// =====================================================================
	await wipe([A, B]);
	const [g3] = await makeBoxes(A, 1);
	await recipe(A, [g3]);
	const c3 = await chainOf(A, g3);
	await A.page.evaluate((id) => window.__stores.nodesHandler.sendNodes(id), B.id);
	const peerReady = await h.eventually(
		() =>
			B.page.evaluate((ids) => {
				let g, group;
				window.__stores.flowGraphs.subscribe((v) => (g = v))();
				window.__stores.objectsGroup.subscribe((v) => (group = v))();
				return {
					latches: (g.scene?.nodes ?? []).filter((n) => n.type === 'latch').length,
					object: !!group?.getObjectByProperty('uuid', ids)
				};
			}, g3),
		(v) => v.latches >= 1 && v.object,
		'premise: the peer holds the chain AND the box'
	);
	void peerReady;

	for (const p of [A, B]) await setPlay(p, true);
	await A.page.evaluate(() => window.__stores.gameState.setGameState('playing'));
	await A.page.waitForTimeout(900);
	h.check(
		(await visibleOf(A, [g3]))[0] === true && (await visibleOf(B, [g3]))[0] === true,
		'premise: both players see the gem'
	);

	await collect(A, g3, 1000);
	h.check((await visibleOf(A, [g3]))[0] === false, 'A collects it');
	h.check((await visibleOf(B, [g3]))[0] === false, 'and it vanishes for B too — one replicated stamp, each peer hides it itself');

	await setPlay(B, null);
	await B.page.waitForTimeout(700);
	h.check((await visibleOf(B, [g3]))[0] === true, "B leaves play and the scene comes back for B — B's Esc is B's own");
	h.check((await visibleOf(A, [g3]))[0] === false, 'while A, still playing, sees nothing change');
	h.check((await valueOf(B, c3.latch)) === true, "and B's Latch is still SET — nothing shared was touched");
	const midRound = await gstate(B);
	h.check(midRound.state === 'playing', `the round is still running for everyone (${midRound.state})`);

	await setPlay(B, true);
	await B.page.waitForTimeout(700);
	h.check((await visibleOf(B, [g3]))[0] === false, 'B re-enters and the gem is STILL COLLECTED — a rejoin keeps mid-round state');
	h.check((await varOf(B, 'gems')) === 1, `and the score is not double counted (${await varOf(B, 'gems')})`);
	for (const p of [A, B]) await setPlay(p, null);
	await A.page.evaluate(() => window.__stores.gameState.setGameState('menu'));

	// =====================================================================
	// 4. GROUPS: every child mesh, one variable, ONE undo entry
	// =====================================================================
	await wipe([A, B]);
	const members = await makeBoxes(A, 3);
	const groupUuid = await A.page.evaluate(async (ids) => {
		const s = window.__stores;
		s.objectActions.applySelectionSet(ids);
		await new Promise((r) => setTimeout(r, 500));
		s.objectActions.groupSelection();
		await new Promise((r) => setTimeout(r, 1200));
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		const made = group.children.find((c) => c.type === 'Group');
		s.objectActions.deselectObject();
		s.setActiveGraph(s.SCENE_GRAPH);
		return made?.uuid ?? null;
	}, members);
	h.check(!!groupUuid, 'premise: three boxes are in a Group');

	const groupBuild = await recipe(A, [groupUuid], { variable: 'crystals' });
	h.check(groupBuild.built.length === 3, `running the recipe on the GROUP builds one chain per child mesh (${groupBuild.built.length})`);
	h.check(groupBuild.entries === 1, `as ONE undo entry, not three (${groupBuild.entries})`);
	h.check((await nodeCount(A, 'latch')) === 3, `three latches in the graph (${await nodeCount(A, 'latch')})`);
	h.check(groupBuild.variable === 'crystals', `all sharing the group's variable "${groupBuild.variable}"`);

	const undo = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.history.undo();
		await new Promise((r) => setTimeout(r, 900));
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		const after = (g.scene?.nodes ?? []).filter((n) => n.type === 'latch').length;
		s.history.redo();
		await new Promise((r) => setTimeout(r, 900));
		s.flowGraphs.subscribe((v) => (g = v))();
		return { after, redone: (g.scene?.nodes ?? []).filter((n) => n.type === 'latch').length };
	});
	h.check(undo.after === 0, `ONE undo reverts the whole group, not one child (${undo.after} latches left)`);
	h.check(undo.redone === 3, `and redo brings all three back (${undo.redone})`);

	// a fourth member arrives and the recipe is run again
	await A.page.evaluate(async (gid) => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		const box = group.children[group.children.length - 1];
		const target = group.getObjectByProperty('uuid', gid);
		target.add(box); // fixture: the recipe reads the TREE, however a member got there
		s.objectsGroup.update((v) => v);
		s.objectActions.deselectObject();
		s.setActiveGraph(s.SCENE_GRAPH);
		await new Promise((r) => setTimeout(r, 400));
	}, groupUuid);
	const grown = await recipe(A, [groupUuid], { variable: 'crystals' });
	h.check(grown.built.length === 1, `re-running after adding a member builds only the NEW one (${grown.built.length} added)`);
	h.check(grown.skipped.length === 3, `and reports the rest skipped (${grown.skipped.length} skipped)`);
	h.check((await nodeCount(A, 'latch')) === 4, `four chains in total (${await nodeCount(A, 'latch')})`);

	// =====================================================================
	// 5. RESPAWN: a Delay in the graph, not a hidden timer
	// =====================================================================
	await wipe([A, B]);
	const [g5] = await makeBoxes(A, 1);
	await recipe(A, [g5], { respawn: 2 });
	const c5 = await chainOf(A, g5);
	h.check(!!c5.delay && c5.delaySeconds === 2, `the respawn is a real Delay node in the graph (seconds=${c5.delaySeconds})`);
	h.check(
		c5.resetsLatch && c5.rearmsOnce,
		'wired back to the Latch (reset) and the Once (rearm) — visible and editable like the rest'
	);

	// BOTH peers play here: the respawn is derived per peer from one replicated click
	// stamp, and a peer in the editor is (by this phase's own rule) not shown the game
	for (const p of [A, B]) await setPlay(p, true);
	await A.page.waitForTimeout(700);
	await collect(A, g5);
	h.check((await visibleOf(A, [g5]))[0] === false, 'collected');
	h.check((await varOf(A, 'gems')) === 1, `counted once (${await varOf(A, 'gems')})`);
	// still gone one second in: the return must be the DELAY, not a race we happened to win
	await A.page.waitForTimeout(1000);
	h.check((await visibleOf(A, [g5]))[0] === false, 'still gone a second later — it is waiting out the delay');
	await h.eventually(() => visibleOf(A, [g5]), (v) => v[0] === true, 'and it RESPAWNS after the delay', 9000);
	h.check(
		(await visibleOf(B, [g5]))[0] === true,
		`the peer's copy comes back too, off the same derived moment with nothing sent (${(await visibleOf(B, [g5]))[0]})`
	);

	// the second pickup, with its premise stated so a missed respawn cannot pass it
	const armed = (await visibleOf(A, [g5]))[0];
	await collect(A, g5);
	const afterSecond = (await visibleOf(A, [g5]))[0];
	h.check(armed === true && afterSecond === false, `the respawned gem can be collected again (${armed} -> ${afterSecond})`);
	h.check(
		(await varOf(A, 'gems')) === 2,
		`and COUNTS again — the rearm is what makes the second pickup bank (${await varOf(A, 'gems')})`
	);
	h.check((await visibleOf(B, [g5]))[0] === false, 'and it vanishes again for the peer');
	for (const p of [A, B]) await setPlay(p, null);

	// =====================================================================
	// 6. PER-VARIABLE: two collectibles, two counters, and the picker
	// =====================================================================
	await wipe([A, B]);
	const [gemBox, coinBox] = await makeBoxes(A, 2);
	await recipe(A, [gemBox], { variable: 'gems' });
	await recipe(A, [coinBox], { variable: 'coins' });
	// THE PREMISE MUST BE DETERMINISTIC: `wipe` does not broadcast, so a replicated `game`
	// singleton still in flight from an earlier section can land AFTER it — a menu-state
	// stamp with round > 0 puts the shell IN USE at the menu and changes what the counting
	// checks below MEAN (that race is what flaked this section, ~1 in 3, before the
	// push-side guard). Wait for both peers to actually READ the pristine default instead
	// of trusting the wipe's fixed sleep, and pin it as the section's premise.
	await h.eventually(
		async () => [await gstate(A), await gstate(B)],
		(v) => v.every((g) => g.state === 'menu' && g.round === 0 && g.startedAt === 0),
		'premise: the game shell reads NOT IN USE on both peers — these checks are about plain play mode',
		8000
	);
	await setPlay(A, true);
	await A.page.waitForTimeout(500);
	await collect(A, gemBox);
	await collect(A, coinBox);
	await collect(A, coinBox); // a second click on a collected one banks nothing
	h.check((await varOf(A, 'gems')) === 1, `"gems" counts only its own pickup (${await varOf(A, 'gems')})`);
	h.check((await varOf(A, 'coins')) === 1, `"coins" counts only its own (${await varOf(A, 'coins')})`);
	await setPlay(A, null);
	await A.page.waitForTimeout(400);

	// ---- the entry point LEFT CORE ----------------------------------------------
	// 21-G1 moved the recipe from the object menu into the node editor's Game category;
	// 21-G R3a moved it out of core ALTOGETHER, into the collectible module. So the
	// authoring half — the menu entry, the variable-suggestion chips, the dialog and its
	// cancel-builds-nothing rule — is the MODULE's contract now (its own suite owns it),
	// and what this suite pins is that core carries none of it any more. Everything above
	// still holds: the chain primitives are core and are what the module assembles.
	const leftCore = await A.page.evaluate(() => ({
		recipes: !!window.__stores.gameRecipes,
		dialog: !!window.__stores.recipeDialog
	}));
	h.check(
		!leftCore.recipes && !leftCore.dialog,
		`the recipe left core — it lives in the collectible module now (gameRecipes=${leftCore.recipes}, recipeDialog=${leftCore.dialog})`
	);
	h.check(
		(await A.page.locator('#collectible-variable').count()) === 0,
		'and core ships no collectible dialog to open'
	);

	// =====================================================================
	// 7. THE MENU-CLICK WART: shell in use, state=menu — a spent Once STAYS spent
	// =====================================================================
	// `roundCutoff()` is Infinity here. On the PULL side that reads every stamp as
	// retired (section 2 pins it: latches read un-collected at the menu). On the PUSH
	// side it must NOT: before the split rule, `applyNodeTrigger` read Infinity as
	// "stale, so re-arm", and every menu click on a spent `perRound` Once banked the
	// variable again, unboundedly — the real-scene bug, and the mechanism behind
	// section 6's flake.
	await wipe([A, B]);
	const [m1, m2] = await makeBoxes(A, 2);
	await recipe(A, [m1], { variable: 'menugems' });
	await recipe(A, [m2], { variable: 'menugems' });
	const cm2 = await chainOf(A, m2);
	h.check(!!cm2?.once, 'premise: the spent-gem chain is readable (its Once is addressable)');
	await setPlay(A, true);
	// an authoritative LOCAL commit — monotonic changedAt beats any in-flight stale
	// singleton, so this section cannot inherit section 6's race
	await A.page.evaluate(() => window.__stores.gameState.setGameState('playing'));
	await A.page.waitForTimeout(600);
	await collect(A, m2);
	h.check((await varOf(A, 'menugems')) === 1, `premise: m2 collected during the round (${await varOf(A, 'menugems')})`);
	await A.page.evaluate(() => window.__stores.gameState.setGameState('menu'));
	await A.page.waitForTimeout(700);
	const menuG = await gstate(A);
	h.check(
		menuG.state === 'menu' && menuG.round >= 1,
		`premise: the shell is IN USE and sitting at the menu (${JSON.stringify(menuG)})`
	);

	// the SPENT one: more clicks bank ZERO — the Once stays frozen outside a round
	await collect(A, m2);
	await collect(A, m2);
	h.check(
		(await varOf(A, 'menugems')) === 1,
		`clicking an already-SPENT gem at the menu banks ZERO — a spent Once stays spent outside a round (${await varOf(A, 'menugems')})`
	);

	// the UNCOLLECTED one: two clicks bank at most ONCE — the Once arms, freezes, and
	// the second click finds it frozen
	await collect(A, m1);
	await collect(A, m1);
	h.check(
		(await varOf(A, 'menugems')) === 2,
		`clicking an UNCOLLECTED gem at the menu banks at most once — the Once arms and freezes (${await varOf(A, 'menugems')})`
	);

	// THE COUNTERFACTUAL, in-page: deleting the Once's frozen entry is byte-for-byte the
	// write the unguarded push side used to make on every menu click (a re-arm). With it
	// made by hand, the SAME click banks again — proving the preserved entry is the only
	// thing standing between a menu click and another bank.
	await A.page.evaluate((onceId) => {
		window.__stores.flowTriggers.update((m) => {
			const next = { ...m };
			delete next[onceId];
			return next;
		});
	}, cm2.once);
	await collect(A, m2);
	h.check(
		(await varOf(A, 'menugems')) === 3,
		`counterfactual: hand-re-arming the Once (the unguarded behaviour) makes the same click bank again (${await varOf(A, 'menugems')})`
	);
	await setPlay(A, null);

	const errs = [...h.pageErrors(A), ...h.pageErrors(B)];
	h.check(errs.length === 0, `no page errors on either peer (${JSON.stringify(errs.slice(0, 2))})`);

	await h.finish(browser);
});
