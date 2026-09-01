// DEVX #18 — A HANDSHAKE REPLY FOR THE FLOW TRIGGER LOG.
//
// THE BUG, as the collectible module filed it: a peer that joins mid-round sees every
// collected object back on the table, doors re-opened, one-shot events re-armed. Every
// stateful flow node derives from `flowTriggers`, and `sendHandshake` requested full
// state for ten domains and nothing for the log — so a joiner started with an empty map
// and every round-scoped read answered "never happened".
//
// The suite is built around the two halves that pull in opposite directions, because
// getting one right and the other wrong is the whole risk in this change:
//
//   sections 1-3   arriving history CHANGES WHAT NODES READ. A latch reads SET, the gem
//                  is hidden for the joiner, a Counter arrives at its value, a Once is
//                  still spent — and nothing double-counts.
//   section 5      arriving history FIRES NOTHING. A Travel node does not travel, a Set
//                  Game State does not restart the round, a Spawn node does not spawn, a
//                  HUD screen does not flip. Each negative is followed by a LIVE pulse
//                  through the same node, so a refusal can never be confused with a
//                  graph that was never wired.
//
// Section 5 also deliberately reproduces the ONE case the pre-existing `actionSeenAt`
// cutoff cannot catch, which is why the history EPOCH exists: a peer whose nodes were
// first seen a while ago (it loaded the scene and sat in the editor) receiving stamps
// that are NEWER than that cutoff. The suite delivers history stamped `now` for exactly
// that reason — with the epoch removed, every negative in section 5 goes red.
//
// TIMING: `h.GPU_ARGS`. A software-rendered page runs at ~2.5 fps, and half of this file
// measures a per-frame runtime reacting (or not reacting) inside a second or two.
//
// Run: APP_URL='https://localhost:5186/' PEER_CONFIG='{"mode":"custom","custom":
//      {"host":"peerjs.theprototype.app","port":443,"path":"/peerjs","secure":true}}'
//      npm run e2e -- trigger-log-sync
const h = require('./helpers.cjs');

// ---- reading the world -----------------------------------------------------------

const store = (peer, name) =>
	peer.page.evaluate((n) => {
		let v;
		window.__stores[n].subscribe((x) => (v = x))();
		return v;
	}, name);

/** The trigger log itself — the thing this whole batch replicates. */
const triggersOf = (peer) => store(peer, 'flowTriggers');

const entryOf = async (peer, id) => (await triggersOf(peer))[id] ?? null;

const countOf = async (peer, id) => (await entryOf(peer, id))?.count ?? null;

const valueOf = (peer, id) =>
	peer.page.evaluate((nid) => {
		let v;
		window.__stores.flowValues.subscribe((x) => (v = x))();
		return v[nid];
	}, id);

const visibleOf = (peer, uuids) =>
	peer.page.evaluate((ids) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return ids.map((id) => group?.getObjectByProperty('uuid', id)?.visible ?? null);
	}, uuids);

const varOf = (peer, name) => peer.page.evaluate((n) => window.__stores.gameState.gameVar(n, 0), name);

const gstate = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.gameState.gameState.subscribe((v) => (g = v))();
		return { state: g.state, round: g.round, startedAt: g.startedAt };
	});

const graphIds = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.flowGraphs.subscribe((v) => (g = v))();
		return (g.scene?.nodes ?? []).map((/** @type {any} */ n) => n.id);
	});

/** The THREE-state play store, written exactly as Controls writes it. */
const setPlay = (peer, state) => peer.page.evaluate((s) => window.__stores.isLocked.set(s), state);

/** Fire an event node the way a click does — one shared synced stamp, replicated. */
const pulse = (peer, id, replicate = true) =>
	peer.page.evaluate(
		({ id, replicate }) =>
			window.__stores.flowRuntime.applyNodeTrigger(id, (Date.now() % 86400000) / 1000, replicate),
		{ id, replicate }
	);

const collect = async (peer, uuid, settle = 700) => {
	await peer.page.evaluate((id) => window.__stores.flowRuntime.fireObjectClick(id), uuid);
	await peer.page.waitForTimeout(settle);
};

const syncedNow = (peer) => peer.page.evaluate(() => (Date.now() % 86400000) / 1000);

// ---- building graphs -------------------------------------------------------------

const node = (id, type, data, x = 0, y = 0) => ({
	id,
	type,
	position: { x, y },
	data: { type, ...(data ?? {}) },
	class: 'w-[150px]'
});

// the CANONICAL edge id — anything else does not survive a nodesync reconcile
const edge = (source, target, targetHandle) => ({
	id: 'e-' + source + '-' + target + (targetHandle ? '.' + targetHandle : ''),
	source,
	target,
	...(targetHandle ? { targetHandle } : {})
});

/**
 * APPEND nodes/edges to the scene graph and broadcast them the way the editor does.
 * Append rather than replace, because `makeCollectibleChains` has already written its
 * own seven nodes in and a `flowGraphs.update` that replaces `scene` would drop them.
 * Writes BOTH stores — flowGraphs is what the runtime reads, flowNodes is the active
 * graph's editor view, and the mirror runs both ways.
 */
const addNodes = (peer, nodes, edges) =>
	peer.page.evaluate(
		([nodes, edges]) => {
			const s = window.__stores;
			let next = { nodes: [], edges: [] };
			s.flowGraphs.update((graphs) => {
				const g = graphs.scene ?? { nodes: [], edges: [] };
				next = { nodes: [...g.nodes, ...nodes], edges: [...g.edges, ...edges] };
				return { ...graphs, scene: next };
			});
			s.flowNodes.set(next.nodes);
			s.flowEdges.set(next.edges);
			let peer = null;
			s.peers.subscribe((p) => (peer = p))();
			nodes.forEach((n) => peer?.send({ type: 'nodecreate', node: n }));
			edges.forEach((e) => peer?.send({ type: 'edgecreate', edge: e }));
		},
		[nodes, edges]
	);

/** A clean slate has to be cleaned on EVERY peer — `clearGraphs()` does not broadcast,
 * and nodesync's hash compare then has the emptier peer PULL the graph back. The trigger
 * log is wiped too: it outlives the nodes by design, so a stale entry would be adopted
 * by a re-used id. */
const wipe = async (peers) => {
	for (const p of peers)
		await p.page.evaluate(() => {
			window.__stores.clearGraphs();
			window.__stores.flowTriggers.set({});
			window.__stores.gameState.clearGameState();
			window.__stores.isLocked.set(null);
		});
	await peers[0].page.waitForTimeout(900);
};

const makeBox = (peer) =>
	peer.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		const uuid = group.children[group.children.length - 1].uuid;
		// creating SELECTS, and the flow editor's scope follows the selection
		s.objectActions.deselectObject();
		s.setActiveGraph(s.SCENE_GRAPH);
		return uuid;
	});

/** Walk the collectible chain back from its Object Selector — the fixture returns
 * uuids, and every assertion needs the node ids. */
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
		const sel = nodes.find((n) => n.type === 'objectselector' && n.data?.selected === id);
		if (!sel) return null;
		const vis = back(sel.id, null);
		const gate = back(vis?.id, 'on');
		const latch = back(gate?.id, 'a');
		const click = back(latch?.id, 'set');
		return { selector: sel.id, vis: vis?.id ?? null, latch: latch?.id ?? null, click: click?.id ?? null };
	}, uuid);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	// rapier is a lazy wasm import — warm it on a throwaway page or section 5's
	// simulation start pays the download inside the section that measures it
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}

	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B])
		await p.page.waitForFunction(() => !!window.__stores?.triggerSync && !!window.__stores?.nodesHandler, {
			timeout: 30000
		});
	h.check(true, 'premise: both peers expose the triggerSync seam');
	// connect FIRST: a peer cannot approve a connection request while in play mode
	await h.connect(A, B);

	// =====================================================================
	// 1. build the world on A and fire it, with B live beside it
	// =====================================================================
	console.log('\n=== 1. a round is played on A (B live) ===');
	await wipe([A, B]);
	const gem = await makeBox(A);
	const built = await h.makeCollectibleChains(A, [gem]);
	h.check(built.built.length === 1, `premise: the collectible fixture built one chain (${built.built.length})`);
	const chain = await chainOf(A, gem);
	h.check(!!chain?.latch && !!chain?.click, 'premise: its chain is readable from the Object Selector back');

	// the three chains whose STATE a stamp alone cannot express — a Counter's value, a
	// Once's spent flag, and the two DERIVED pushes (once/delay) that a joiner could
	// double-count if the derived bridge treated arriving history as new
	await addNodes(
		A,
		[
			node('t-click', 'onclick', {}, 0, 400),
			node('t-count', 'counter', { step: 1, op: 'up' }, 220, 400),
			node('t-dclick', 'onclick', {}, 0, 560),
			node('t-delay', 'delay', { seconds: 1, pulse: 0.5 }, 220, 560),
			node('t-dcount', 'counter', { step: 1, op: 'up' }, 440, 560),
			node('t-oclick', 'onclick', {}, 0, 720),
			node('t-once', 'once', { pulse: 0.3 }, 220, 720),
			node('t-ocount', 'counter', { step: 1, op: 'up' }, 440, 720)
		],
		[
			edge('t-click', 't-count', 'trigger'),
			edge('t-dclick', 't-delay', 'trigger'),
			edge('t-delay', 't-dcount', 'pulse'),
			edge('t-oclick', 't-once', 'trigger'),
			edge('t-once', 't-ocount', 'pulse')
		]
	);
	await A.page.waitForTimeout(900);
	const idsB = await graphIds(B);
	h.check(
		idsB.includes('t-count') && idsB.includes('t-delay') && idsB.includes(chain.latch),
		`premise: B holds the whole graph (${idsB.length} scene nodes)`
	);
	// the stale-stamp guard records a node's first-seen at TICK time, so a pulse minted
	// in the gap between the nodes landing and the peer's next tick is refused (the
	// documented 4ms race). A human press comes seconds after wiring; so does this one.
	await A.page.waitForTimeout(700);

	await setPlay(A, true);
	await A.page.waitForTimeout(600);
	h.check((await visibleOf(A, [gem]))[0] === true, 'premise: the gem is visible when play starts');
	await collect(A, gem);
	h.check((await visibleOf(A, [gem]))[0] === false, 'A collects the gem — hidden while playing');
	h.check((await varOf(A, 'gems')) === 1, `and banks 1 (${await varOf(A, 'gems')})`);
	h.check((await valueOf(A, chain.latch)) === true, 'premise: A\'s Latch is SET, which is what holds it hidden');

	await pulse(A, 't-click');
	await pulse(A, 't-click');
	await pulse(A, 't-click');
	await A.page.waitForTimeout(500);
	h.check((await countOf(A, 't-count')) === 3, `a Counter reaches 3 on A (${await countOf(A, 't-count')})`);

	await pulse(A, 't-oclick');
	await pulse(A, 't-oclick');
	await A.page.waitForTimeout(800);
	h.check((await countOf(A, 't-once')) === 1, `the Once froze at 1 on A (${await countOf(A, 't-once')})`);
	h.check(
		(await countOf(A, 't-ocount')) === 1,
		`and its DERIVED push counted exactly once despite two clicks (${await countOf(A, 't-ocount')})`
	);

	await pulse(A, 't-dclick');
	await A.page.waitForTimeout(1900); // past the 1s delay
	h.check((await countOf(A, 't-dcount')) === 1, `the Delay's derived push landed on A (${await countOf(A, 't-dcount')})`);

	// live replication is the premise every late-joiner check below stands on
	h.check((await countOf(B, 't-count')) === 3, `premise: B saw the live pulses (counter ${await countOf(B, 't-count')})`);
	h.check((await valueOf(B, chain.latch)) === true, 'premise: B\'s Latch is SET too');

	const logA = await triggersOf(A);
	const stampedIds = Object.keys(logA).length;
	h.check(stampedIds >= 6, `premise: A's trigger log holds the round (${stampedIds} entries)`);

	// =====================================================================
	// 2. THE HEADLINE — a peer joining mid-round sees a collected world
	// =====================================================================
	console.log('\n=== 2. the late joiner ===');
	// A must LEAVE play before anyone can join it: the Approve button renders and the
	// click times out under a pointer lock (the documented trap). The round's SHARED
	// state is untouched by one peer's Esc, which is the whole point of section 1.
	await setPlay(A, null);
	await A.page.waitForTimeout(700);
	const C = await h.setupPage(browser, 'C');
	await C.page.waitForFunction(() => !!window.__stores?.triggerSync, { timeout: 30000 });
	// a connected peer's pill has no dial input, so the NEWCOMER dials
	await h.connect(C, A);

	await h.eventually(
		() => C.page.evaluate((id) => {
			let group;
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			return !!group?.getObjectByProperty('uuid', id);
		}, gem),
		(/** @type {boolean} */ ok) => ok === true,
		'premise: C received the gem object'
	);
	await h.eventually(
		() => graphIds(C),
		(/** @type {string[]} */ ids) => ids.includes(chain.latch) && ids.includes('t-count'),
		'premise: C received the whole flow graph'
	);
	await C.page.waitForTimeout(1200);

	const logC = await triggersOf(C);
	h.check(
		!!logC[chain.click],
		`THE REPLY LANDED: C holds the click's trigger entry (${JSON.stringify(logC[chain.click])})`
	);
	h.check(
		Math.abs((logC[chain.click]?.lastT ?? 0) - (logA[chain.click]?.lastT ?? -1)) < 0.001,
		'and it carries the SAME shared stamp A recorded — the log is not re-derived, it is delivered'
	);
	h.check(
		(await valueOf(C, chain.latch)) === true,
		`C's Latch reads SET from history it never witnessed (${await valueOf(C, chain.latch)})`
	);

	await setPlay(C, true);
	await C.page.waitForTimeout(900);
	h.check(
		(await visibleOf(C, [gem]))[0] === false,
		`THE BUG IS DEAD: the gem is HIDDEN for the joiner (visible=${(await visibleOf(C, [gem]))[0]})`
	);
	h.check((await varOf(C, 'gems')) === 1, `and the score it joins into is 1, not 2 (${await varOf(C, 'gems')})`);

	// ---- the state a stamp alone cannot express ---------------------------------
	h.check((await countOf(C, 't-count')) === 3, `the Counter's VALUE arrived: 3 (${await countOf(C, 't-count')})`);
	h.check(
		(await countOf(C, 't-once')) === 1,
		`the Once is still spent for the joiner (count ${await countOf(C, 't-once')})`
	);
	h.check(
		(await countOf(C, 't-ocount')) === 1,
		`and its downstream Counter did NOT double-count: 1 (${await countOf(C, 't-ocount')}) — the derived bridge treats a past moment as history`
	);
	h.check(
		(await countOf(C, 't-dcount')) === 1,
		`the Delay's downstream Counter did NOT double-count either: 1 (${await countOf(C, 't-dcount')})`
	);
	// ...and it stays that way: the derived bridge is re-evaluated every tick, so a
	// missing dedupe seed would keep bumping rather than bumping once
	await C.page.waitForTimeout(1800);
	h.check(
		(await countOf(C, 't-ocount')) === 1 && (await countOf(C, 't-dcount')) === 1,
		`...and they hold after two more seconds of ticking (${await countOf(C, 't-ocount')}/${await countOf(C, 't-dcount')})`
	);
	h.check(
		(await countOf(C, 't-count')) === 3,
		`the Counter is not re-bumped by its own arriving stamp either (${await countOf(C, 't-count')})`
	);
	await setPlay(C, null);

	// a LIVE pulse after the join still works — history must not have poisoned the edge
	await pulse(A, 't-click');
	await A.page.waitForTimeout(900);
	h.check(
		(await countOf(C, 't-count')) === 4 && (await countOf(A, 't-count')) === 4,
		`a live pulse after the join still counts on both peers (A ${await countOf(A, 't-count')} / C ${await countOf(C, 't-count')})`
	);

	// =====================================================================
	// 3. the MERGE rule, driven directly — both directions
	// =====================================================================
	console.log('\n=== 3. the merge ===');
	// driven on B, not C: this section REPLACES the whole log with a controlled fixture,
	// and section 4 needs C's real one intact (the first version of this suite drove it on
	// C and read 0 -> 0, a check that could not fail)
	const merge = await B.page.evaluate(() => {
		const s = window.__stores;
		const read = () => {
			let v;
			s.flowTriggers.subscribe((x) => (v = x))();
			return v;
		};
		// a controlled log, on ids no graph holds, so nothing can act on any of it
		s.flowTriggers.set({
			'm-mine-newer': { count: 9, lastT: 500 },
			'm-theirs-newer': { count: 9, lastT: 400 },
			'm-tie': { count: 9, lastT: 450 },
			'm-only-mine': { count: 4, lastT: 100 }
		});
		s.triggerSync.applyRemoteTriggers({
			type: 'triggers',
			triggers: {
				'm-mine-newer': { count: 1, lastT: 400 },
				'm-theirs-newer': { count: 1, lastT: 500 },
				'm-tie': { count: 1, lastT: 450 },
				'm-only-theirs': { count: 7, lastT: 300 },
				'm-junk': { count: 1 } // no lastT at all
			}
		});
		return read();
	});
	h.check(
		merge['m-mine-newer']?.lastT === 500 && merge['m-mine-newer']?.count === 9,
		`joiner-newer: OUR entry survives, whole (${JSON.stringify(merge['m-mine-newer'])})`
	);
	h.check(
		merge['m-theirs-newer']?.lastT === 500 && merge['m-theirs-newer']?.count === 1,
		`host-newer: THEIRS wins, and the count travels WITH the stamp — 9 -> 1 (${JSON.stringify(merge['m-theirs-newer'])})`
	);
	h.check(
		merge['m-tie']?.lastT === 450 && merge['m-tie']?.count === 9,
		`a TIE keeps ours — a snapshot has no ordering argument to make (${JSON.stringify(merge['m-tie'])})`
	);
	h.check(
		merge['m-only-mine']?.count === 4,
		'an entry only WE hold is never dropped — a merge, not a replace (our own clicks between dialling and the reply)'
	);
	h.check(merge['m-only-theirs']?.count === 7, 'an entry only THEY hold arrives whole');
	h.check(merge['m-junk'] === undefined, 'an entry with no numeric stamp is refused rather than stored malformed');

	// the payload prunes to LIVE nodes: an id for a node nobody has is unusable, and the
	// prune is what bounds the message by the graph instead of by session history
	const payload = await A.page.evaluate(() => {
		const s = window.__stores;
		s.flowTriggers.update((m) => ({ ...m, 'ghost-of-a-deleted-node': { count: 3, lastT: 12 } }));
		const p = s.triggerSync.triggerLogPayload();
		return { ids: Object.keys(p.triggers), debug: s.triggerSync.triggerSyncDebug() };
	});
	h.check(payload.ids.includes('t-count'), 'the payload carries a live node');
	h.check(
		!payload.ids.includes('ghost-of-a-deleted-node'),
		'and PRUNES an id no graph holds — the log outlives its nodes, the payload does not'
	);
	h.check(
		payload.debug.bytes < 20000,
		`SIZE: a played round's whole log is ${payload.debug.bytes} bytes over ${payload.debug.entries} entries — a plain object, nowhere near the binarypack array trap`
	);

	// =====================================================================
	// 4. a joiner's own clicks are not lost to the reply
	// =====================================================================
	console.log('\n=== 4. a joiner keeps its own pulses ===');
	// C pulses LOCALLY (replicate: false), then receives a reply that predates it — the
	// merge must not roll its own newer entry back
	const beforeOwn = await countOf(C, 't-count');
	await pulse(C, 't-click', false);
	await C.page.waitForTimeout(500);
	const ownBefore = await countOf(C, 't-count');
	h.check(
		ownBefore === beforeOwn + 1,
		`premise: C's own local pulse advanced its Counter (${beforeOwn} -> ${ownBefore})`
	);
	await C.page.evaluate(
		(log) => window.__stores.triggerSync.applyRemoteTriggers({ type: 'triggers', triggers: log }),
		logA
	);
	await C.page.waitForTimeout(400);
	h.check(
		(await countOf(C, 't-count')) === ownBefore,
		`a reply carrying OLDER stamps cannot roll back the joiner's own pulse (${ownBefore} -> ${await countOf(C, 't-count')})`
	);

	// =====================================================================
	// 5. THE CRITICAL NEGATIVE — arriving history fires NOTHING
	// =====================================================================
	console.log('\n=== 5. arriving history fires nothing ===');
	await wipe([A, B, C]);

	// ---- 5a. Set Game State / Spawn / HUD screen -------------------------------
	const template = await makeBox(A);
	await addNodes(
		A,
		[
			node('n-click', 'onclick', {}, 0, 0),
			node('n-state', 'setgamestate', { state: 'playing' }, 240, 0),
			node('n-spawn', 'spawn', { x: 0, y: 4, z: 0, count: 1, maxAlive: 8, interval: 0, spread: 0 }, 240, 120),
			node('n-sel', 'objectselector', { selected: template }, 460, 120),
			node('n-screen', 'hudscreen', { action: 'show', screen: 'menu' }, 240, 240)
		],
		[
			edge('n-click', 'n-state', 'trigger'),
			edge('n-click', 'n-spawn', 'trigger'),
			edge('n-spawn', 'n-sel'),
			edge('n-click', 'n-screen', 'trigger')
		]
	);
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.physics.physicsDebug().length),
		(/** @type {number} */ n) => n > 0,
		'premise: a simulation is running, so a Spawn node CAN spawn'
	);
	// THE SHAPE THE EPOCH EXISTS FOR: let the nodes tick for a while first, so their
	// `actionSeenAt` cutoffs are OLD. History stamped `now` is then NEWER than every
	// cutoff — exactly a peer that loaded the scene, sat in the editor, and dialled.
	await A.page.waitForTimeout(2500);
	const seenBefore = await A.page.evaluate(() => window.__stores.flowRuntime.triggerHistoryEpoch());
	h.check(seenBefore === 0 || seenBefore > 0, `premise: the history epoch is readable (${seenBefore})`);

	const baseState = await gstate(A);
	const baseTransient = await A.page.evaluate(() => window.__stores.transientObjects.transientUuids().length);
	const baseScreens = await A.page.evaluate(() => {
		let v;
		window.__stores.hudDocs.hudScreenOverride.subscribe((x) => (v = x))();
		return JSON.stringify(v);
	});
	h.check(baseState.state !== 'playing', `premise: the game is not playing (${baseState.state})`);
	h.check(baseTransient === 0, `premise: nothing has been spawned (${baseTransient})`);

	// half a second ago: comfortably OLDER than the epoch the reply is about to mark, and
	// comfortably NEWER than the ~2.5s-old `actionSeenAt` cutoffs — so only the epoch can
	// refuse it. (Stamping it at exactly `now` would decide the test on a few ms of CDP
	// round trip, which is asserting the scheduler.)
	const now = (await syncedNow(A)) - 0.5;
	await A.page.evaluate(
		(t) =>
			window.__stores.triggerSync.applyRemoteTriggers({
				type: 'triggers',
				triggers: { 'n-click': { count: 1, lastT: t } }
			}),
		now
	);
	await A.page.waitForTimeout(2000); // many ticks — a per-frame family would have acted

	const afterState = await gstate(A);
	h.check(
		afterState.state === baseState.state && afterState.round === baseState.round,
		`arriving history does NOT change the game state (${baseState.state} -> ${afterState.state})`
	);
	h.check(
		(await A.page.evaluate(() => window.__stores.transientObjects.transientUuids().length)) === 0,
		'arriving history does NOT spawn'
	);
	h.check(
		(await A.page.evaluate(() => {
			let v;
			window.__stores.hudDocs.hudScreenOverride.subscribe((x) => (v = x))();
			return JSON.stringify(v);
		})) === baseScreens,
		'arriving history does NOT flip a HUD screen'
	);
	h.check(
		(await A.page.evaluate(() => window.__stores.flowRuntime.triggerHistoryEpoch())) > 0,
		'premise: the epoch was marked by the reply — that is the only thing refusing the three above'
	);

	// ---- THE POSITIVE CONTROL, without which all three pass vacuously ----------
	await pulse(A, 'n-click');
	await A.page.waitForTimeout(1600);
	h.check((await gstate(A)).state === 'playing', `a LIVE pulse through the same node DOES set the game state (${(await gstate(A)).state})`);
	h.check(
		(await A.page.evaluate(() => window.__stores.transientObjects.transientUuids().length)) === 1,
		'...and DOES spawn'
	);
	h.check(
		(await A.page.evaluate(() => {
			let v;
			window.__stores.hudDocs.hudScreenOverride.subscribe((x) => (v = x))();
			return JSON.stringify(v);
		})) !== baseScreens,
		'...and DOES flip the HUD screen. Every refusal above was a refusal, not a dead wire.'
	);
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await A.page.waitForTimeout(600);

	// ---- 5b. Travel: the one that would replace the whole scene ----------------
	console.log('\n--- 5b. travel ---');
	await wipe([A, B, C]);
	const level = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 1200));
		s.objectActions.deselectObject();
		const saved = await s.levels.saveSceneAsLevel('TriggerLogArena');
		return saved?.hash ?? saved ?? null;
	});
	h.check(!!level, `premise: a real scene asset exists to travel to (${String(level).slice(0, 12)})`);
	await A.page.evaluate(() => window.__stores.levels.currentLevel.set(null));
	await addNodes(
		A,
		[node('v-click', 'onclick', {}, 0, 0), node('v-travel', 'travel', { level, levelName: 'TriggerLogArena' }, 240, 0)],
		[edge('v-click', 'v-travel', 'trigger')]
	);
	await A.page.waitForTimeout(2500); // the node's cutoff goes stale, as in 5a

	await A.page.evaluate(
		(t) =>
			window.__stores.triggerSync.applyRemoteTriggers({
				type: 'triggers',
				triggers: { 'v-click': { count: 1, lastT: t } }
			}),
		(await syncedNow(A)) - 0.5
	);
	await A.page.waitForTimeout(2500);
	const travelledOnHistory = await A.page.evaluate(() => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v;
	});
	h.check(travelledOnHistory === null, `arriving history does NOT travel (currentLevel=${JSON.stringify(travelledOnHistory)})`);
	h.check((await graphIds(A)).includes('v-travel'), 'premise: the Travel node is still there to have fired');

	// LOCAL on purpose: travel replaces the whole scene, and having B and C follow us into
	// a level whose bytes they would have to pull adds nothing to what is under test here
	await pulse(A, 'v-click', false);
	await h.eventually(
		() =>
			A.page.evaluate(() => {
				let v;
				window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
				return v?.name ?? null;
			}),
		(/** @type {string|null} */ name) => name === 'TriggerLogArena',
		'a LIVE pulse through the same node DOES travel — so the refusal above was real',
		25000
	);

	const errs = [...h.pageErrors(A), ...h.pageErrors(B), ...h.pageErrors(C)];
	h.check(errs.length === 0, `no page errors on any peer (${JSON.stringify(errs.slice(0, 2))})`);

	await h.finish(browser);
});
