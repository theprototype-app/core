// 21-G4 — PER-PLAYER COLLECTIBLES + PEER-OWNED VARIABLES.
//
// THE MECHANISM UNDER TEST is deliberately small, and the suite is built to prove it is
// the ONLY thing that changed:
//
//   `perPlayer` on an event node  its pulse never reaches the wire, so everything
//                                 downstream (Latch, Gate, Visibility, Once, the counter)
//                                 becomes per-peer with no per-peer code anywhere
//   `scope: 'player'` on Set Var  the count lands in THIS peer's own `peervars` row,
//                                 which no other peer can write
//   `peervars` message            owner-only writer, latest-wins per peer, a late-joiner
//                                 reply on `getmodulestate`, dropped on DISCONNECT and
//                                 NOT on leaving play (the lifetime that separates it
//                                 from `playmode`)
//
// Section 3 is the counterfactual and it matters as much as the positive ones: with the
// flags off, the same recipe must replicate exactly as it did before this phase.
//
// TIMING: `h.GPU_ARGS` — the leaderboard is derived on a per-frame pass, and a
// SwiftShader page ticks at ~2.5 fps. And every trigger pulse waits ~600ms after its
// premise, because `actionSeenAt` refuses a stamp minted before the peer's next tick
// (the measured 4ms race).
//
// Run: $env:APP_URL='https://localhost:5200/'; PEER_CONFIG=...; npm run e2e -- peer-variables
const h = require('./helpers.cjs');

// ---- reading the world -----------------------------------------------------------

const pv = (peer) => peer.page.evaluate(() => window.__stores.peerVars.peerVarsDebug());

/** What `peer` believes `who` holds for `name`. The whole point of an owner-written row
 * is that this agrees on every screen. */
const rowOf = async (peer, whoId, name) => {
	const d = await pv(peer);
	return d.all[whoId]?.[name] ?? null;
};

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

const setPlay = (peer, state) => peer.page.evaluate((s) => window.__stores.isLocked.set(s), state);

const playModesOf = (peer) =>
	peer.page.evaluate(() => {
		let m;
		window.__stores.gamePresence.peerPlayModes.subscribe((v) => (m = v))();
		return m;
	});

const rowsOf = (peer, elementId) =>
	peer.page.evaluate((id) => window.__stores.flowRuntime.hudRowsOf(id), elementId);

/** A clean slate on EVERY peer — `clearGraphs()` does not broadcast, so a one-sided wipe
 * is pulled back by nodesync's hash compare. Per-player rows go too, and that clear DOES
 * broadcast (an empty row), so the peers converge on nothing. */
const wipe = async (peers) => {
	for (const p of peers)
		await p.page.evaluate(() => {
			window.__stores.clearGraphs();
			window.__stores.gameState.clearGameState();
			window.__stores.peerVars.clearPeerVars();
			window.__stores.isLocked.set(null);
		});
	await peers[0].page.waitForTimeout(1200);
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
		s.objectActions.deselectObject();
		s.setActiveGraph(s.SCENE_GRAPH);
		return uuids;
	}, count);

const recipe = (peer, uuids, opts = {}) =>
	peer.page.evaluate(
		({ uuids, opts }) => window.__stores.gameRecipes.makeCollectible(uuids, { quiet: true, ...opts }),
		{ uuids, opts }
	);

/** The chain the recipe built for ONE object, walked back from its Object Selector. */
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
		return {
			latch: latch?.id ?? null,
			click: click?.id ?? null,
			// the two flags this phase adds, and NOTHING else about the shape
			clickPerPlayer: click?.data?.perPlayer ?? null,
			latchPerRound: latch?.data?.perRound ?? null,
			visWhilePlaying: vis?.data?.whilePlaying ?? null,
			counter: count?.id ?? null,
			counterScope: count?.data?.scope ?? null,
			variable: count?.data?.name ?? null
		};
	}, uuid);

const valueOf = (peer, id) =>
	peer.page.evaluate((nid) => {
		let v;
		window.__stores.flowValues.subscribe((x) => (v = x))();
		return v[nid];
	}, id);

/** Collect, then SETTLE. 600ms is the documented `actionSeenAt` margin. */
const collect = async (peer, uuid, settle = 900) => {
	await peer.page.evaluate((id) => window.__stores.flowRuntime.fireObjectClick(id), uuid);
	await peer.page.waitForTimeout(settle);
};

/** Set this peer's nickname the way CharacterModal does — write our own roster row and
 * broadcast the whole array. A leaderboard that shows peer ids is not a scoreboard, so
 * the names have to be REAL for section 4 to mean anything. */
const setName = async (peer, name) => {
	await peer.page.evaluate((n) => {
		const s = window.__stores;
		let list, p;
		s.userdata.subscribe((v) => (list = v))();
		s.peers.subscribe((v) => (p = v))();
		for (const row of list) if (row[0] === p.peer.id) row[1] = n;
		s.userdata.set(list);
		s.userdata.update((v) => v);
		p.send({ type: 'userdata', userdata: list });
	}, name);
	await peer.page.waitForTimeout(700);
};

/** Count what actually leaves the wire, CALLING THROUGH — a spy that drops the message
 * makes delivery and loss indistinguishable. */
const spyOn = (peer) =>
	peer.page.evaluate(() => {
		let p;
		window.__stores.peers.subscribe((v) => (p = v))();
		if (p.__sent) return false;
		p.__sent = [];
		const orig = p.send.bind(p);
		p.send = (msg) => {
			try {
				p.__sent.push(msg?.type);
			} catch {}
			return orig(msg);
		};
		return true;
	});

const sentSince = (peer, type, from = 0) =>
	peer.page.evaluate(
		({ t, f }) => {
			let p;
			window.__stores.peers.subscribe((v) => (p = v))();
			return (p.__sent ?? []).slice(f).filter((x) => x === t).length;
		},
		{ t: type, f: from }
	);

const sentLength = (peer) =>
	peer.page.evaluate(() => {
		let p;
		window.__stores.peers.subscribe((v) => (p = v))();
		return (p.__sent ?? []).length;
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) await p.page.waitForFunction(() => !!window.__stores?.peerVars, { timeout: 30000 });
	// connect BEFORE anyone plays — a peer cannot approve a request while in play mode.
	// A dials, B approves, so B holds sessionHost === null and is the session writer.
	await h.connect(A, B);
	await setName(A, 'Alice');
	await setName(B, 'Bob');
	await spyOn(A);
	await spyOn(B);

	// =====================================================================
	// 1. THE CHANNEL: owner-only rows, converging on both screens
	// =====================================================================
	await wipe([A, B]);
	const base = await pv(A);
	h.check(!!base.myId && base.myId === A.id, `premise: A knows its own peer id (${base.myId})`);
	h.check(Object.keys(base.mine).length === 0, 'premise: the slate really is clean');

	const beforeSet = await sentLength(A);
	await A.page.evaluate(() => window.__stores.peerVars.setPeerVar('laps', 3));
	await A.page.waitForTimeout(1200);
	h.check((await sentSince(A, 'peervars', beforeSet)) === 1, 'setting a per-player value sends exactly ONE peervars message');
	h.check((await rowOf(A, A.id, 'laps')) === 3, 'A holds its own row');
	h.check((await rowOf(B, A.id, 'laps')) === 3, `and B holds A's row, keyed by A's id (${await rowOf(B, A.id, 'laps')})`);

	// the same value again must not put anything on the wire — a per-frame graph could
	// otherwise broadcast this sixty times a second
	const beforeSame = await sentLength(A);
	await A.page.evaluate(() => window.__stores.peerVars.setPeerVar('laps', 3));
	await A.page.waitForTimeout(500);
	h.check((await sentSince(A, 'peervars', beforeSame)) === 0, 'writing the SAME value sends nothing');

	await B.page.evaluate(() => window.__stores.peerVars.setPeerVar('laps', 5));
	await B.page.waitForTimeout(1200);
	const bothOnA = await pv(A);
	const bothOnB = await pv(B);
	h.check(
		bothOnA.all[A.id]?.laps === 3 && bothOnA.all[B.id]?.laps === 5,
		`A reads BOTH rows (${JSON.stringify(bothOnA.all)})`
	);
	h.check(
		bothOnB.all[A.id]?.laps === 3 && bothOnB.all[B.id]?.laps === 5,
		`and so does B — the two screens agree (${JSON.stringify(bothOnB.all)})`
	);

	// the aggregate reads, which is what a HUD asks for
	const agg = await A.page.evaluate(() => ({
		sum: window.__stores.peerVars.peerVarSum('laps'),
		max: window.__stores.peerVars.peerVarMax('laps'),
		mine: window.__stores.peerVars.myPeerVar('laps', 0)
	}));
	h.check(agg.sum === 8 && agg.max === 5 && agg.mine === 3, `sum/max/mine read 8/5/3 (${JSON.stringify(agg)})`);

	// ---- 1b. the node reads the same numbers -------------------------------------
	const readings = await A.page.evaluate((bid) => {
		const s = window.__stores;
		const mk = (data) => ({
			id: crypto.randomUUID(),
			type: 'peervariable',
			position: { x: 0, y: 1200 },
			data: { type: 'peervariable', name: 'laps', ...data },
			class: 'w-[150px]'
		});
		const nodes = {
			mine: mk({ read: 'mine' }),
			sum: mk({ read: 'sum' }),
			max: mk({ read: 'max' }),
			peer: mk({ read: 'peer', peer: bid })
		};
		const out = {};
		for (const [key, node] of Object.entries(nodes))
			out[key] = s.flowRuntime.evalNode(node, [node], [], 0, new Set(), { triggers: {} });
		return out;
	}, B.id);
	h.check(
		readings.mine === 3 && readings.sum === 8 && readings.max === 5 && readings.peer === 5,
		`the Player Variable node reads mine/sum/max/peer (${JSON.stringify(readings)})`
	);

	// =====================================================================
	// 2. A PER-PLAYER COLLECTIBLE: the gem hides only for whoever took it
	// =====================================================================
	await wipe([A, B]);
	const [g1, g2] = await makeBoxes(A, 2);
	const built = await recipe(A, [g1, g2], { variable: 'gems', perPlayer: true });
	h.check(built.built.length === 2 && built.perPlayer === true, `premise: two per-player collectibles built (${JSON.stringify(built.built.length)})`);
	const c1 = await chainOf(A, g1);
	h.check(
		c1.clickPerPlayer === true && c1.counterScope === 'player',
		`the recipe stamps BOTH flags — click.perPlayer=${c1.clickPerPlayer}, counter.scope=${c1.counterScope}`
	);
	h.check(
		c1.latchPerRound === true && c1.visWhilePlaying === true,
		'and leaves 21-F2 exactly as it was — the chain shape is unchanged'
	);
	await h.eventually(
		() => chainOf(B, g1),
		(c) => !!c && c.clickPerPlayer === true && c.counterScope === 'player',
		'the peer holds the same chain, flags and all',
		15000
	);

	for (const p of [A, B]) await setPlay(p, true);
	await A.page.waitForTimeout(900); // the actionSeenAt settle
	h.check((await visibleOf(A, [g1, g2])).every((v) => v === true), 'premise: both gems are on the table when play starts');
	await h.eventually(
		() => visibleOf(B, [g1, g2]),
		(v) => v[0] === true && v[1] === true,
		'premise: the peer holds both gems too',
		20000
	);

	const beforeCollect = await sentLength(A);
	await collect(A, g1);
	h.check(
		(await sentSince(A, 'nodetrigger', beforeCollect)) === 0,
		'THE MECHANISM: a perPlayer collect puts NO nodetrigger on the wire'
	);
	h.check((await visibleOf(A, [g1]))[0] === false, 'A took gem 1 — hidden for A');
	h.check((await visibleOf(B, [g1]))[0] === true, `and STILL THERE for B (${(await visibleOf(B, [g1]))[0]})`);
	h.check((await valueOf(A, c1.latch)) === true, "A's Latch is set...");
	h.check((await valueOf(B, c1.latch)) !== true, `...and B's is not — one graph, two answers (${await valueOf(B, c1.latch)})`);

	h.check((await rowOf(A, A.id, 'gems')) === 1, "A's own count is 1");
	h.check((await rowOf(B, A.id, 'gems')) === 1, "and B can see A's 1");
	h.check((await rowOf(A, B.id, 'gems')) === null, "while B has collected nothing yet");
	h.check((await varOf(A, 'gems')) === 0, `and the SHARED variable was never touched (${await varOf(A, 'gems')})`);

	// B takes the same gem for themselves
	await collect(B, g1);
	h.check((await visibleOf(B, [g1]))[0] === false, 'B takes gem 1 too — now hidden for B');
	h.check((await rowOf(B, B.id, 'gems')) === 1, "B's own count is 1");
	await h.eventually(
		() => rowOf(A, B.id, 'gems'),
		(v) => v === 1,
		"and A converges on B's 1 — each peer's count moved independently",
		12000
	);
	h.check((await rowOf(A, A.id, 'gems')) === 1, "A's count did NOT move when B collected");

	// a second gem for A only, so the two rows differ
	await collect(A, g2);
	h.check((await rowOf(A, A.id, 'gems')) === 2, 'A takes gem 2 as well (2)');
	h.check((await visibleOf(B, [g2]))[0] === true, 'gem 2 is still there for B');
	await h.eventually(
		() => pv(B),
		(d) => d.all[A.id]?.gems === 2 && d.all[B.id]?.gems === 1,
		'both rows converge on B: A=2, B=1',
		12000
	);

	// ---- 2b. `collectcount` reads MY progress by construction --------------------
	const counts = await Promise.all(
		[A, B].map((p) => p.page.evaluate(() => window.__stores.flowRuntime.collectibleCountsFor('gems')))
	);
	h.check(
		counts[0].collected === 2 && counts[0].left === 0,
		`A's Collectibles node reads 2 collected / 0 left (${JSON.stringify(counts[0])})`
	);
	h.check(
		counts[1].collected === 1 && counts[1].left === 1,
		`and B's reads 1 / 1 — same graph, own latches (${JSON.stringify(counts[1])})`
	);

	// =====================================================================
	// 3. THE COUNTERFACTUAL: the shared recipe is unchanged
	// =====================================================================
	await wipe([A, B]);
	const [s1] = await makeBoxes(A, 1);
	const sharedBuilt = await recipe(A, [s1], { variable: 'gems' });
	h.check(sharedBuilt.perPlayer === false, 'premise: a plain recipe reports perPlayer false');
	const sc = await chainOf(A, s1);
	h.check(
		sc.clickPerPlayer === null && sc.counterScope !== 'player',
		`no perPlayer on the click and no player scope on the counter (${sc.clickPerPlayer} / ${sc.counterScope})`
	);

	for (const p of [A, B]) await setPlay(p, true);
	await A.page.waitForTimeout(900);
	const beforeShared = await sentLength(A);
	await collect(A, s1);
	h.check(
		(await sentSince(A, 'nodetrigger', beforeShared)) >= 1,
		'a SHARED collect still replicates its nodetrigger, exactly as before this phase'
	);
	await h.eventually(
		() => visibleOf(B, [s1]),
		(v) => v[0] === false,
		'so the gem hides for EVERYONE, which is what a shared pickup means',
		12000
	);
	h.check((await varOf(A, 'gems')) === 1, `and the count went to the SHARED variable (${await varOf(A, 'gems')})`);
	const noRows = await pv(A);
	h.check(
		Object.keys(noRows.mine).length === 0,
		`with no per-player row written at all (${JSON.stringify(noRows.mine)})`
	);

	// =====================================================================
	// 4. THE LEADERBOARD: rows derived on every peer, nothing sent
	// =====================================================================
	await wipe([A, B]);
	for (const p of [A, B])
		await p.page.evaluate(() => {
			const s = window.__stores;
			s.hudDocs.clearHudDocs();
			s.hudDocs.setHudDocFor('scene', {
				screens: [
					{
						id: 'hud',
						name: 'HUD',
						elements: [{ id: 'board', kind: 'list', label: 'Scores', anchor: 'top-left', x: 20, y: 20, rows: 8 }]
					}
				],
				active: 'hud'
			});
		});
	await A.page.waitForTimeout(600);

	// the ACTION is the entry point a user has, so build it the way they would
	const offered = await A.page.evaluate(() => ({
		list: window.__stores.hudActions.actionsForKind('list').map((a) => a.key),
		text: window.__stores.hudActions.actionsForKind('text').map((a) => a.key)
	}));
	h.check(offered.list.includes('leaderboard'), `a LIST is offered "Show a leaderboard" (${offered.list.join(', ')})`);
	h.check(
		!offered.text.includes('leaderboard'),
		'and a text element is not — rows are a list thing (the PRESSABLE lesson, one kind over)'
	);

	const bound = await A.page.evaluate(() => {
		const r = window.__stores.hudActions.addBinding('board', 'leaderboard');
		// name the variable the players are actually counting into
		const node = r.nodes[0];
		if (node) window.__stores.nodesHandler.setNodeData(node.id, { variable: 'laps' });
		return { ok: r.ok, type: node?.type ?? null, id: node?.id ?? null };
	});
	h.check(bound.ok && bound.type === 'leaderboard', `the binding creates a Leaderboard node (${JSON.stringify(bound)})`);
	const again = await A.page.evaluate(() => window.__stores.hudActions.addBinding('board', 'leaderboard'));
	h.check(again.ok === false, 'and refuses a SECOND one on the same element — two derivations cannot own one list');
	const listed = await A.page.evaluate(() => window.__stores.hudActions.bindingsFor('board').map((b) => b.label));
	h.check(
		listed.some((l) => l.includes('Leaderboard of')),
		`the Actions pane lists it in words (${JSON.stringify(listed)})`
	);

	await A.page.evaluate(() => window.__stores.peerVars.setPeerVar('laps', 4));
	await B.page.evaluate(() => window.__stores.peerVars.setPeerVar('laps', 7));
	await A.page.waitForTimeout(1500);

	const boardA = await rowsOf(A, 'board');
	const boardB = await rowsOf(B, 'board');
	h.check(
		Array.isArray(boardA) && boardA.length === 2,
		`the board holds one row per player (${JSON.stringify(boardA)})`
	);
	h.check(
		boardA.some((r) => r.endsWith('7')) && boardA.some((r) => r.endsWith('4')),
		`carrying BOTH values (${JSON.stringify(boardA)})`
	);
	h.check(
		boardA[0].endsWith('7'),
		`sorted by score, highest first (${JSON.stringify(boardA)})`
	);
	h.check(
		JSON.stringify(boardA) === JSON.stringify(boardB),
		`and B derives the IDENTICAL list — nothing about the board is sent (A ${JSON.stringify(boardA)} / B ${JSON.stringify(boardB)})`
	);

	// the names are the roster's, not raw peer ids — "Bob — 7", which is the whole
	// difference between a scoreboard and a table of peer ids
	h.check(
		boardA[0] === 'Bob — 7' && boardA[1] === 'Alice — 4',
		`rows read as names and scores (${JSON.stringify(boardA)})`
	);

	// a value CHANGE moves the board and nothing else does
	const beforeBoard = await sentLength(A);
	await B.page.evaluate(() => window.__stores.peerVars.setPeerVar('laps', 9));
	await A.page.waitForTimeout(1500);
	const boardAfter = await rowsOf(A, 'board');
	h.check(boardAfter.some((r) => r.endsWith('9')), `A's board follows B's score (${JSON.stringify(boardAfter)})`);
	h.check(
		(await sentSince(A, 'peervars', beforeBoard)) === 0,
		"and A sent nothing — a peer's board is derived, never pushed"
	);

	// =====================================================================
	// 5. LIFETIME: play mode does not own these rows; a disconnect does
	// =====================================================================
	await setPlay(A, true);
	await A.page.waitForTimeout(1200);
	h.check(
		(await playModesOf(B))[A.id] === 'playing',
		`premise: B sees A in play mode (${JSON.stringify(await playModesOf(B))})`
	);
	await setPlay(A, null);
	await A.page.waitForTimeout(1200);
	h.check(
		(await playModesOf(B))[A.id] === undefined,
		'A leaves play and its PRESENCE row is dropped, as 21-F3 intends'
	);
	h.check(
		(await rowOf(B, A.id, 'laps')) === 4,
		`but its VARIABLE row survives — that is the whole reason this is not the playmode map (${await rowOf(B, A.id, 'laps')})`
	);
	h.check((await rowsOf(B, 'board')).length === 2, 'so the leaderboard still shows the player who stepped out');

	// ---- 5b. a LATE JOINER is caught up by the getmodulestate reply --------------
	// (the same code path a RECONNECT takes: the owner re-announces its own row)
	const C = await h.setupPage(browser, 'C');
	await C.page.waitForFunction(() => !!window.__stores?.peerVars, { timeout: 30000 });
	// a joiner must dial the HOST — a connected peer's pill has no dial input
	await h.connect(C, B);
	await h.eventually(
		() => pv(C),
		(d) => d.all[A.id]?.laps === 4 && d.all[B.id]?.laps === 9,
		'a late joiner receives every existing row through getmodulestate',
		20000
	);
	const cSees = await pv(C);
	h.check(
		Object.keys(cSees.mine).length === 0,
		`while holding none of its own (${JSON.stringify(cSees.mine)})`
	);

	await C.page.evaluate(() => window.__stores.peerVars.setPeerVar('laps', 1));
	await h.eventually(
		() => rowOf(A, C.id, 'laps'),
		(v) => v === 1,
		"C's own row reaches A, which C never dialed — the mesh carries it",
		20000
	);

	// ---- 5c. leaving the SESSION drops the row ----------------------------------
	await C.page.evaluate(() => {
		let p;
		window.__stores.peers.subscribe((v) => (p = v))();
		p.leaveSession();
	});
	await h.eventually(
		() => pv(B),
		(d) => d.all[C.id] === undefined,
		'a peer that leaves the session takes its row with it — no ghosts on the scoreboard',
		20000
	);
	h.check((await rowOf(B, A.id, 'laps')) === 4, 'and the peers who stayed are untouched');
	await C.ctx.close();

	// =====================================================================
	// 6. perRound STILL RESETS a per-player chain — and the vars do NOT
	// =====================================================================
	await wipe([A, B]);
	const [r1] = await makeBoxes(A, 1);
	await recipe(A, [r1], { variable: 'gems', perPlayer: true });
	const rc = await chainOf(A, r1);
	for (const p of [A, B]) await setPlay(p, true);
	await A.page.evaluate(() => window.__stores.gameState.setGameState('playing'));
	await A.page.waitForTimeout(1000);
	const round1 = await gstate(A);
	h.check(round1.round === 1 && round1.startedAt > 0, `premise: round 1 is underway (${JSON.stringify(round1)})`);

	await collect(A, r1);
	h.check((await visibleOf(A, [r1]))[0] === false, 'A collects it in round 1');
	h.check((await rowOf(A, A.id, 'gems')) === 1, 'and banks 1 in its own row');

	await A.page.evaluate(() => window.__stores.gameState.setGameState('menu'));
	await A.page.waitForTimeout(1000);
	h.check(
		(await valueOf(A, rc.latch)) === false,
		'back at the menu the LOCAL latch reads un-collected — the cutoff is the replicated round, and it works on a local stamp'
	);
	h.check((await visibleOf(A, [r1]))[0] === true, 'so the gem is back for A');

	await A.page.evaluate(() => window.__stores.gameState.setGameState('playing'));
	await A.page.waitForTimeout(1000);
	const round2 = await gstate(A);
	h.check(round2.round === 2 && round2.startedAt > round1.startedAt, `premise: round 2 bumped the stamp (${JSON.stringify(round2)})`);
	h.check(
		(await rowOf(A, A.id, 'gems')) === 1,
		`THE ROUND DECISION: a new round does NOT clear a per-player variable (${await rowOf(A, A.id, 'gems')}) — laps and campaign scores outlive rounds, and a game that wants the clear authors a scope:'player' Set Variable`
	);
	await collect(A, r1);
	h.check(
		(await rowOf(A, A.id, 'gems')) === 2,
		`while the chain itself re-arms and counts again (${await rowOf(A, A.id, 'gems')})`
	);

	// ---- 6b. and an authored clear is all it takes -------------------------------
	await A.page.evaluate(() => window.__stores.peerVars.setPeerVar('gems', 0));
	await A.page.waitForTimeout(800);
	h.check((await rowOf(A, A.id, 'gems')) === 0, 'a scope-player write of 0 is the reset a game authors');
	await h.eventually(
		() => rowOf(B, A.id, 'gems'),
		(v) => v === 0,
		'and the peers see it, because the owner announced it',
		12000
	);

	for (const p of [A, B]) await setPlay(p, null);
	h.check((h.pageErrors(A).length + h.pageErrors(B).length) === 0, `no page errors on either peer (${JSON.stringify([h.pageErrors(A), h.pageErrors(B)])})`);

	await h.finish(browser);
});
