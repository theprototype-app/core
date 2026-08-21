// 21-F4a — SCENES AS LEVELS, the asset + travel core (the travel NODE and the debug
// element are F4b, on top of this):
//
//   levels.saveSceneAsLevel   the current scene as a content-hashed .tpscene in a
//                             `Scenes` Explorer folder (workspace stripped; 21-G1
//                             renamed the folder and made discovery kind-based —
//                             `scene-folders` owns that contract)
//   levels.newLevel           an empty level asset that captures NOTHING
//   levels.travelToLevel      a LOCAL, silent scene replace: no backup stash, no
//                             replication (the deterministic model — the trigger is
//                             what replicates), the file's `game` EXCLUDED and the
//                             live state re-asserted (fork 3: campaign semantics),
//                             and a missing hash PULLED from peers first (the LUT
//                             watch — ask once, then watch until the bytes land)
//
// TIMING: h.GPU_ARGS — the two-peer pull section measures a real asset round trip.
// Run: APP_URL='https://localhost:5204/' PEER_CONFIG=... npm run e2e -- scene-levels
const h = require('./helpers.cjs');

// ---- reading the world -----------------------------------------------------------
const childUuids = (peer) =>
	peer.page.evaluate(() => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return (group?.children ?? []).map((c) => c.uuid).sort();
	});

const gstate = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.gameState.gameState.subscribe((v) => (g = v))();
		return g;
	});

const levelItemsOf = (peer) =>
	peer.page.evaluate(() => {
		let items;
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		return items.filter((i) => i.kind === 'scene').map((i) => ({ name: i.name, hash: i.hash }));
	});

const sessionCount = (peer) =>
	peer.page.evaluate(async () => {
		await window.__stores.sessions.loadSessions();
		let list;
		window.__stores.sessions.sessions.subscribe((v) => (list = v))();
		return list.length;
	});

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

	// =====================================================================
	// 1. THE ENTRY POINT — the Explorer grid menu, driven as a user would
	// =====================================================================
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(600);
	A.page.once('dialog', (d) => d.accept('UI Level'));
	await A.page.locator('#explorer-list [role="region"]').first()
		.click({ button: 'right', position: { x: 200, y: 140 } });
	await A.page.waitForTimeout(300);
	const rows = await A.page.evaluate(() =>
		[...document.querySelectorAll('[role="menu"] button, [role="menu"] [role="menuitem"]')].map(
			(el) => el.textContent?.trim()
		)
	);
	h.check(
		rows.some((r) => r?.includes('Save scene…')) && rows.some((r) => r?.includes('New scene')),
		`the grid menu offers both scene entries (${JSON.stringify(rows)})`
	);
	await A.page.getByText('Save scene…', { exact: false }).click();
	await h.eventually(
		() => levelItemsOf(A),
		(items) => items.some((i) => i.name.includes('UI Level')),
		'the UI path saved a level item (empty scene is a valid level)'
	);

	// =====================================================================
	// 2. SAVE AS LEVEL + NEW SCENE, store-driven
	// =====================================================================
	const one = await makeBoxes(A, 2);
	const savedOne = await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Level One'));
	h.check(!!savedOne?.hash, `Level One saved with a content hash (${savedOne?.hash?.slice(0, 8)})`);
	const foldersA = await A.page.evaluate(() => {
		let f;
		window.__stores.explorer.explorerFolders.subscribe((v) => (f = v))();
		return f.map((x) => x.name);
	});
	// 21-G1: the folder is `Scenes` and is only where a save LANDS — discovery is by kind
	// (scene-folders owns that contract; this is the "a save premakes it" half)
	h.check(foldersA.includes('Scenes'), `the Scenes folder is premade by the save (${JSON.stringify(foldersA)})`);
	const items2 = await levelItemsOf(A);
	h.check(
		items2.some((i) => i.name === 'Level One.tpscene'),
		`the level is an ordinary .tpscene item (${JSON.stringify(items2.map((i) => i.name))})`
	);
	h.check(
		(await A.page.evaluate(() => {
			let c;
			window.__stores.levels.currentLevel.subscribe((v) => (c = v))();
			return c?.name;
		})) === 'Level One',
		'currentLevel names the save'
	);

	const blank = await A.page.evaluate(() => window.__stores.levels.newLevel('Blank'));
	h.check(!!blank?.hash && blank.hash !== savedOne.hash, 'New scene… makes a distinct empty asset');

	// =====================================================================
	// 3. TRAVEL: local, silent, carried state, no backup
	// =====================================================================
	// Level Three carries a BAKED game state, to prove the file's game is EXCLUDED
	await A.page.evaluate(() => {
		window.__stores.gameState.setGameState('playing');
		window.__stores.gameState.setGameState('over');
	});
	await A.page.evaluate(() => window.__stores.commandsHandler.clearSceneLocal());
	const three = await makeBoxes(A, 3);
	const savedThree = await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Level Three'));
	h.check(!!savedThree?.hash, 'Level Three saved (its file bakes state=over)');

	// now a LIVE campaign state that must survive the hop
	await A.page.evaluate(() => {
		window.__stores.gameState.setGameState('playing');
		window.__stores.gameState.setGameVar('gems', 7);
	});
	const liveBefore = await gstate(A);
	h.check(liveBefore.state === 'playing' && liveBefore.vars.gems === 7, 'premise: a live round with a score');

	const sessionsBefore = await sessionCount(A);
	const traveled = await A.page.evaluate((hash) => window.__stores.levels.travelToLevel(hash, 'Level One'), savedOne.hash);
	h.check(traveled === true, 'travelToLevel reports a load');
	h.check(
		JSON.stringify(await childUuids(A)) === JSON.stringify([...one].sort()),
		'the scene is Level One again, ORIGINAL uuids preserved'
	);
	const liveAfter = await gstate(A);
	h.check(
		liveAfter.state === 'playing' && liveAfter.round === liveBefore.round && liveAfter.vars.gems === 7,
		`fork 3: the live game state CARRIED across the hop — the file's baked 'over' never applied (${liveAfter.state}, round ${liveAfter.round}, gems ${liveAfter.vars.gems})`
	);
	h.check((await sessionCount(A)) === sessionsBefore, 'no backup session was stashed by the hop');

	// travel to the EMPTY level: a blank slate, state still carried
	await A.page.evaluate((hash) => window.__stores.levels.travelToLevel(hash, 'Blank'), blank.hash);
	h.check((await childUuids(A)).length === 0, 'the empty level really is empty');
	h.check((await gstate(A)).vars.gems === 7, 'and the score still carried');

	// =====================================================================
	// 4. TWO PEERS: the pull-then-load watch, and travel stays LOCAL
	// =====================================================================
	// back onto Level Three content so the peers have a scene to share
	await A.page.evaluate((hash) => window.__stores.levels.travelToLevel(hash, 'Level Three'), savedThree.hash);
	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);
	await h.eventually(
		() => childUuids(B),
		(ids) => ids.length === 3,
		'premise: B received the current scene through the ordinary handshake'
	);
	const missing = await B.page.evaluate(
		(hash) => !window.__stores.explorer.itemByHash(hash),
		savedOne.hash
	);
	h.check(missing, "premise: B does NOT hold Level One's bytes");

	const aBefore = await childUuids(A);
	const bSessionsBefore = await sessionCount(B);
	// fire and WATCH — the pull resolves when the bytes land (the LUT precedent)
	await B.page.evaluate((hash) => {
		void window.__stores.levels.travelToLevel(hash, 'Level One');
	}, savedOne.hash);
	await h.eventually(
		() => childUuids(B),
		(ids) => JSON.stringify(ids) === JSON.stringify([...one].sort()),
		'B pulled the level from A and loaded it — ask once, then watch until the bytes land',
		30000
	);
	h.check(
		(await B.page.evaluate((hash) => !!window.__stores.explorer.itemByHash(hash), savedOne.hash)),
		"the pulled bytes are in B's library now (content-hash dedupe)"
	);
	h.check(
		JSON.stringify(await childUuids(A)) === JSON.stringify(aBefore),
		"A's scene is untouched — B's travel applied LOCALLY, nothing was broadcast"
	);
	h.check((await sessionCount(B)) === bSessionsBefore, 'and B stashed no backup either');

	// =====================================================================
	// 5. THE TRAVEL NODE: one replicated pulse moves EVERYONE
	// =====================================================================
	// A is on Level Three's content, B on Level One's — the node must converge them.
	const built = await A.page.evaluate(
		({ hash, name }) => {
			const s = window.__stores;
			let p;
			s.peers.subscribe((v) => (p = v))();
			const mk = (type, data, x) => ({
				id: crypto.randomUUID(),
				type,
				position: { x, y: 40 },
				data: { label: type, type, ...data },
				class: 'w-[150px]'
			});
			const click = mk('onclick', {}, 40);
			const travel = mk('travel', { level: hash, levelName: name }, 260);
			for (const node of [click, travel]) {
				s.nodesHandler.createFlowNode(node, s.SCENE_GRAPH);
				if (p) p.send({ type: 'nodecreate', node: s.nodesHandler.serializeNode(node), graphId: s.SCENE_GRAPH });
			}
			const edge = { id: 'e-' + click.id + '-' + travel.id + '.trigger', source: click.id, target: travel.id, targetHandle: 'trigger' };
			s.nodesHandler.createFlowEdge(edge, s.SCENE_GRAPH);
			if (p) p.send({ type: 'edgecreate', edge: s.nodesHandler.serializeEdge(edge), graphId: s.SCENE_GRAPH });
			return { click: click.id, travel: travel.id };
		},
		{ hash: savedThree.hash, name: 'Level Three' }
	);
	// the peer must HOLD the graph before the pulse (flowNodes.set does not broadcast —
	// the documented slow-raily nodesync trap — so wait on the sends we just made)
	await h.eventually(
		() => B.page.evaluate((id) => window.__stores.allNodes().some((n) => n.id === id), built.travel),
		(v) => v === true,
		'premise: the peer holds the travel node'
	);
	// SETTLE past the stale-stamp cutoff: B's actionSeenAt records the node on its next
	// TICK, milliseconds after the premise above — a stamp minted inside that window is
	// correctly refused (measured: stamp 21618.485 vs seenAt 21618.489). A human press
	// comes seconds after wiring; the guard is doing its 21-E job, so the suite waits.
	await A.page.waitForTimeout(600);
	await A.page.evaluate((id) => window.__stores.flowRuntime.applyNodeTrigger(id, (Date.now() % 86400000) / 1000, true), built.click);
	await h.eventually(
		() => childUuids(B),
		(ids) => JSON.stringify(ids) === JSON.stringify([...three].sort()),
		'the pulse replicated and B loaded the level ITSELF (no scene bytes on the wire)',
		30000
	);
	h.check(
		JSON.stringify(await childUuids(A)) === JSON.stringify([...three].sort()),
		'A landed on the same level from the same stamp'
	);
	h.check((await gstate(B)).vars.gems === 7, `fork 3 on the peer too: B's carried score survived the hop (${(await gstate(B)).vars.gems})`);

	// =====================================================================
	// 6. A LATE JOINER lands in the CURRENT level with the carried state
	// =====================================================================
	const C = await h.setupPage(browser, 'C');
	// the JOINER dials — A's Connect pill is already in its connected state and has no
	// dial input to fill
	await h.connect(C, A);
	await h.eventually(
		() => childUuids(C),
		(ids) => JSON.stringify(ids) === JSON.stringify([...three].sort()),
		'the late joiner receives the current level through the ordinary handshake',
		30000
	);
	const cState = await gstate(C);
	const aState = await gstate(A);
	h.check(
		cState.state === aState.state && cState.round === aState.round && cState.vars.gems === 7,
		`and the carried game state with it (${cState.state}, round ${cState.round}, gems ${cState.vars.gems})`
	);

	// =====================================================================
	// 7. ALLPLAYERS: the group gate — every peer IN PLAY answers for themselves
	// =====================================================================
	// A and B play; C stays in the EDITOR and must not block (a spectator is not a
	// player). Each player's answer is a LOCAL latch (replicate:false pulses), which is
	// exactly the per-peer shape the condition input means.
	const gate = await A.page.evaluate(() => {
		const s = window.__stores;
		let p;
		s.peers.subscribe((v) => (p = v))();
		const mk = (type, data, x, y) => ({
			id: crypto.randomUUID(),
			type,
			position: { x, y },
			data: { label: type, type, ...data },
			class: 'w-[150px]'
		});
		// a latch is set/reset through edges FROM a pulsed source, so the per-peer answer
		// is two locally-pulsed buttons — the same graph a real ready-up menu builds
		const yes = mk('onclick', {}, 40, 160);
		const no = mk('onclick', {}, 40, 280);
		const ready = mk('latch', {}, 260, 220);
		const all = mk('allplayers', {}, 480, 220);
		for (const node of [yes, no, ready, all]) {
			s.nodesHandler.createFlowNode(node, s.SCENE_GRAPH);
			if (p) p.send({ type: 'nodecreate', node: s.nodesHandler.serializeNode(node), graphId: s.SCENE_GRAPH });
		}
		const edges = [
			{ id: 'e-' + yes.id + '-' + ready.id + '.set', source: yes.id, target: ready.id, targetHandle: 'set' },
			{ id: 'e-' + no.id + '-' + ready.id + '.reset', source: no.id, target: ready.id, targetHandle: 'reset' },
			{ id: 'e-' + ready.id + '-' + all.id + '.condition', source: ready.id, target: all.id, targetHandle: 'condition' }
		];
		for (const edge of edges) {
			s.nodesHandler.createFlowEdge(edge, s.SCENE_GRAPH);
			if (p) p.send({ type: 'edgecreate', edge: s.nodesHandler.serializeEdge(edge), graphId: s.SCENE_GRAPH });
		}
		return { yes: yes.id, no: no.id, all: all.id };
	});
	await h.eventually(
		() => B.page.evaluate((id) => window.__stores.allNodes().some((n) => n.id === id), gate.all),
		(v) => v === true,
		'premise: the peer holds the gate'
	);
	const firedAt = (peer) =>
		peer.page.evaluate((id) => {
			let t;
			window.__stores.flowTriggers.subscribe((v) => (t = v))();
			return t[id]?.lastT ?? null;
		}, gate.all);
	// LOCAL pulses (replicate false) — this player's own answer, nobody else's
	const setReady = (peer, on) =>
		peer.page.evaluate(
			({ id }) => window.__stores.flowRuntime.applyNodeTrigger(id, (Date.now() % 86400000) / 1000, false),
			{ id: on ? gate.yes : gate.no }
		);
	for (const p of [A, B]) await p.page.evaluate(() => window.__stores.isLocked.set(true));
	await A.page.waitForTimeout(900);
	await setReady(A, true);
	await A.page.waitForTimeout(900);
	h.check((await firedAt(A)) === null, 'one ready player out of two fires NOTHING');
	await setReady(B, true);
	await h.eventually(() => firedAt(A), (t) => typeof t === 'number', 'both ready — the gate fires on A', 15000);
	const t1 = await firedAt(A);
	await h.eventually(() => firedAt(B), (t) => typeof t === 'number', 'and on B, derived from the same replicated verdicts', 15000);
	h.check(true, `C sat in the editor the whole time and did not block (spectators are not players)`);
	// falling then rising fires AGAIN (an edge, not a level)
	await setReady(A, false);
	await A.page.waitForTimeout(900);
	await setReady(A, true);
	await h.eventually(() => firedAt(A), (t) => typeof t === 'number' && t !== t1, 're-satisfying the gate fires a fresh edge', 15000);
	for (const p of [A, B]) await p.page.evaluate(() => window.__stores.isLocked.set(null));

	// =====================================================================
	// 8. THE DEBUG ELEMENT renders the truth
	// =====================================================================
	// settle the shared state FIRST: everybody just left play, so F3's abandon watch is
	// ~10s from writing menu itself — a race that would land mid-assertion. resetGame
	// keeps vars (gems stays 7), which is also what the expanded pill asserts.
	await A.page.evaluate(() => window.__stores.gameState.resetGame());
	await A.page.waitForTimeout(400);
	await A.page.evaluate(() => {
		window.__stores.hudDocs.setHudDocFor('scene', {
			screens: [
				{
					id: 'main',
					name: 'Main',
					elements: [
						{ id: 'dbg', kind: 'debug', anchor: 'top-left', x: 12, y: 12, w: 280, h: 26, compact: true, variable: 'gems' }
					]
				}
			],
			active: 'main'
		});
	});
	await A.page.waitForTimeout(1200); // two sampler beats
	const pill = await A.page.evaluate(() => document.querySelector('.hud-debug')?.textContent ?? '');
	const liveA = await gstate(A);
	h.check(pill.includes(liveA.state) && pill.includes('r' + liveA.round), `the pill reads the live state (${pill.trim()})`);
	h.check(/\d+fps/.test(pill), 'and a real fps number');
	await A.page.click('.hud-debug');
	await A.page.waitForTimeout(800);
	const expanded = await A.page.evaluate(() => document.querySelector('.hud-debug')?.textContent ?? '');
	h.check(expanded.includes('gems=7'), `expanding shows the vars map (${expanded.includes('gems=7')})`);
	h.check(expanded.includes('Level Three'), 'and the scene name');
	h.check(
		(expanded.match(/editor|playing/g) || []).length >= 2,
		'and a mode chip per player'
	);

	for (const p of [A, B, C]) {
		const errs = await h.pageErrors(p);
		h.check(errs.length === 0, `no page errors on ${p === A ? 'A' : p === B ? 'B' : 'C'} (${JSON.stringify(errs)})`);
	}
	await h.finish(browser);
});
