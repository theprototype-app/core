// 21-D6 — the game shell: a replicated latest-wins game state, its nodes, and the camera.
//
// Verified before this was built: core had NO notion of a game running. Play mode
// (`isLocked`) is per-viewer and unreplicated, camera preview is a per-viewer makeDefault
// swap with replicated PRESENCE only, and there was no active/game camera anywhere. So a
// Start button had nothing to write to.
//
// THE POLICY THIS SUITE PINS DOWN: the STATE replicates, the CAMERA does not. Every peer
// reacts locally to the replicated state, so all views converge with no new message and
// without one peer seizing another's viewpoint (the house rule).
//
// Run: $env:APP_URL='https://localhost:5201/'; PEER_CONFIG=...; npm run e2e -- game-state
const h = require('./helpers.cjs');

const state = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.gameState.gameState.subscribe((v) => (g = v))();
		return g;
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) await p.page.waitForFunction(() => !!window.__stores?.gameState, { timeout: 30000 });
	await h.connect(A, B);

	// ---- 1. the default is pristine, and saves as NOTHING -------------------
	const fresh = await page0(A);
	async function page0(peer) {
		return peer.page.evaluate(() => {
			const G = window.__stores.gameState;
			G.clearGameState();
			return { snapshot: G.gameStateSnapshot(), state: G.gameStateSnapshot() };
		});
	}
	h.check(fresh.snapshot === null, 'a pristine game snapshots as NULL, so a scene with no game saves unchanged');

	// ---- 2. the state replicates, latest-wins -------------------------------
	const started = await A.page.evaluate(() => {
		const G = window.__stores.gameState;
		const before = G.gameStateSnapshot();
		G.setGameState('playing');
		let g;
		G.gameState.subscribe((v) => (g = v))();
		return { before, state: g.state, round: g.round, startedAt: g.startedAt, changedAt: g.changedAt };
	});
	h.check(started.state === 'playing', `setGameState moves the state (${started.state})`);
	h.check(started.round === 1, `entering play bumps the round (${started.round})`);
	h.check(started.startedAt > 1e12, 'and stamps a shared startedAt, so a timer needs no clock of its own');

	await A.page.waitForTimeout(1300);
	const onB = await state(B);
	h.check(onB.state === 'playing', `the state reached the peer (${onB.state})`);
	h.check(
		onB.startedAt === started.startedAt && onB.round === started.round,
		`with the SAME start stamp and round, so both peers agree on the clock (${onB.startedAt})`
	);

	// a receiver must not echo, or two peers ping-pong forever
	const echo = await B.page.evaluate(async () => {
		const s = window.__stores;
		window.__bSent = [];
		const peer = await new Promise((r) => s.peers.subscribe((p) => r(p))());
		const real = peer.send.bind(peer);
		peer.send = (msg) => {
			if (msg?.type === 'game') window.__bSent.push(msg.type);
			return real(msg);
		};
		window.__restore = () => (peer.send = real);
		return true;
	});
	h.check(echo, 'premise: the peer`s send is wrapped');
	await A.page.evaluate(() => window.__stores.gameState.setGameState('paused'));
	await A.page.waitForTimeout(1200);
	const echoed = await B.page.evaluate(() => ({ sent: window.__bSent.slice(), restored: (window.__restore(), true) }));
	h.check((await state(B)).state === 'paused', 'a second change also arrives');
	h.check(echoed.sent.length === 0, `and the receiver sends NOTHING back (${JSON.stringify(echoed.sent)})`);

	// STRICTLY older is refused; an EQUAL stamp is accepted (an ordered channel means it
	// arrived later) — the rule a fast burst depends on
	const stamps = await B.page.evaluate(() => {
		const G = window.__stores.gameState;
		const S = window.__stores.gameSync;
		let mine;
		G.gameState.subscribe((v) => (mine = v))();
		S.applyRemoteGameState({ ...mine, state: 'menu', changedAt: mine.changedAt - 5000 });
		let afterStale;
		G.gameState.subscribe((v) => (afterStale = v))();
		S.applyRemoteGameState({ ...mine, state: 'over', outcome: 'won', changedAt: mine.changedAt });
		let afterEqual;
		G.gameState.subscribe((v) => (afterEqual = v))();
		return { afterStale: afterStale.state, afterEqual: afterEqual.state, outcome: afterEqual.outcome };
	});
	h.check(stamps.afterStale === 'paused', `a STRICTLY older state is refused (${stamps.afterStale})`);
	h.check(
		stamps.afterEqual === 'over' && stamps.outcome === 'won',
		`an EQUAL stamp is ACCEPTED, and carries the outcome — which is how win/lose is said (${stamps.afterEqual}/${stamps.outcome})`
	);

	// ---- 3. MONOTONIC stamps: a burst must not collapse ---------------------
	const burst = await A.page.evaluate(() => {
		const G = window.__stores.gameState;
		const out = [];
		for (let i = 0; i < 20; i++) {
			G.setGameVar('score', i);
			let g;
			G.gameState.subscribe((v) => (g = v))();
			out.push(g.changedAt);
		}
		let rising = true;
		for (let i = 1; i < out.length; i++) if (out[i] <= out[i - 1]) rising = false;
		return { rising, first: out[0], last: out[out.length - 1] };
	});
	h.check(burst.rising, `20 writes in a burst all get STRICTLY increasing stamps (${burst.first} -> ${burst.last})`);

	// ---- 4. the NODES ------------------------------------------------------
	// setgamestate acts on the trigger's STAMP EDGE, not per frame — acting every frame
	// would re-enter `playing` and re-stamp startedAt sixty times a second.
	const nodes = await A.page.evaluate(async () => {
		const s = window.__stores;
		// pin the score explicitly THROUGH the write path, so it replicates and both peers
		// agree. clearGameState() is a local-only test seam: on a connected pair the peer
		// still holds the old value and hands it straight back.
		s.gameState.setGameVar('score', 0);
		s.flowNodes.set([
			{ id: 'go', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', pulse: 0.3 } },
			{ id: 'play', type: 'setgamestate', position: { x: 220, y: 0 }, data: { type: 'setgamestate', state: 'playing' } },
			{ id: 'onplay', type: 'ongamestate', position: { x: 440, y: 0 }, data: { type: 'ongamestate', state: 'playing', edge: 'enter' } },
			{ id: 'tally', type: 'counter', position: { x: 660, y: 0 }, data: { type: 'counter', step: 1, op: 'up' } },
			{ id: 'addscore', type: 'setvariable', position: { x: 220, y: 160 }, data: { type: 'setvariable', name: 'score', op: 'add', value: 5 } },
			{ id: 'readscore', type: 'getvariable', position: { x: 440, y: 160 }, data: { type: 'getvariable', name: 'score' } },
			{ id: 'clock', type: 'gametime', position: { x: 440, y: 320 }, data: { type: 'gametime', read: 'elapsed' } }
		]);
		s.flowEdges.set([
			{ id: 'e-go-play', source: 'go', target: 'play', targetHandle: 'trigger' },
			{ id: 'e-onplay-tally', source: 'onplay', target: 'tally', targetHandle: 'pulse' },
			{ id: 'e-go-addscore', source: 'go', target: 'addscore', targetHandle: 'trigger' }
		]);
		await new Promise((r) => setTimeout(r, 1000));
		return true;
	});
	h.check(nodes, 'premise: the game graph is placed');
	await A.page.evaluate((id) => window.__stores.nodesHandler.sendNodes(id), B.id);
	await A.page.waitForTimeout(1500);

	const pulsed = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.flowRuntime.applyNodeTrigger('go', (Date.now() % 86400000) / 1000, true);
		await new Promise((r) => setTimeout(r, 1400));
		let g, t;
		s.gameState.gameState.subscribe((v) => (g = v))();
		s.flowTriggers.subscribe((v) => (t = v))();
		return { state: g.state, score: g.vars?.score, tally: t?.tally?.count ?? 0, startedAt: g.startedAt };
	});
	h.check(pulsed.state === 'playing', `a click through Set Game State starts the game (${pulsed.state})`);
	h.check(pulsed.score === 5, `and Set Variable ADDED 5 to the shared number (${pulsed.score})`);
	h.check(pulsed.tally === 1, `On Game State pulsed a Counter on the transition (${pulsed.tally})`);

	// the STAMP EDGE: while the pulse is still alive, nothing must re-fire
	await A.page.waitForTimeout(900);
	const stable = await A.page.evaluate(() => {
		let g, t;
		window.__stores.gameState.gameState.subscribe((v) => (g = v))();
		window.__stores.flowTriggers.subscribe((v) => (t = v))();
		return { startedAt: g.startedAt, score: g.vars?.score, tally: t?.tally?.count ?? 0 };
	});
	h.check(
		stable.startedAt === pulsed.startedAt,
		'the actions fire on the STAMP EDGE — startedAt is not re-stamped every frame'
	);
	h.check(stable.score === 5 && stable.tally === 1, `nor does the variable or the counter run away (${stable.score}/${stable.tally})`);

	// the readable half, derived not sent
	const readable = await A.page.evaluate(() => {
		const s = window.__stores;
		let nodes, edges;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowEdges.subscribe((v) => (edges = v))();
		const ev = (id) => s.flowRuntime.evalNode(nodes.find((n) => n.id === id), nodes, edges, 1, new Set(), null);
		return { score: ev('readscore'), elapsed: ev('clock') };
	});
	h.check(readable.score === 5, `Get Variable reads the shared number (${readable.score})`);
	h.check(readable.elapsed > 0 && readable.elapsed < 60, `Game Time derives the elapsed round (${readable.elapsed.toFixed(2)}s)`);

	// the peer computes the SAME numbers with no message of its own
	const peerRead = await B.page.evaluate(() => {
		const s = window.__stores;
		let nodes, edges, g;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowEdges.subscribe((v) => (edges = v))();
		s.gameState.gameState.subscribe((v) => (g = v))();
		const ev = (id) => s.flowRuntime.evalNode(nodes.find((n) => n.id === id), nodes, edges, 1, new Set(), null);
		return { state: g.state, score: ev('readscore'), elapsed: ev('clock') };
	});
	h.check(peerRead.state === 'playing' && peerRead.score === 5, `the peer holds the same state and score (${peerRead.state}/${peerRead.score})`);
	h.check(
		Math.abs(peerRead.elapsed - readable.elapsed) < 2,
		`and derives the same round time from the shared stamp (${readable.elapsed.toFixed(1)} / ${peerRead.elapsed.toFixed(1)})`
	);

	// ---- 5. THE CAMERA: replicated STATE, local decision -------------------
	const camera = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Camera');
		await new Promise((r) => setTimeout(r, 1800));
		const list = s.cameraObjects.listCameraObjects();
		if (!list.length) return null;
		const uuid = list[0].uuid;
		let nodes;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.flowNodes.set([
			...nodes,
			{ id: 'gstart', type: 'gamestart', position: { x: 0, y: 480 }, data: { type: 'gamestart', camera: uuid, state: 'playing' } }
		]);
		await new Promise((r) => setTimeout(r, 800));
		return uuid;
	});
	h.check(!!camera, 'premise: a camera object and a Game Start node naming it');
	await A.page.evaluate((id) => window.__stores.nodesHandler.sendNodes(id), B.id);
	await A.page.waitForTimeout(1800);

	// leave and re-enter play, so the TRANSITION fires with the Game Start node in place
	const looking = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.gameState.setGameState('menu');
		await new Promise((r) => setTimeout(r, 900));
		s.gameState.setGameState('playing');
		await new Promise((r) => setTimeout(r, 1600));
		let p;
		s.cameraPreview.cameraPreview.subscribe((v) => (p = v))();
		return p?.uuid ?? null;
	});
	h.check(looking === camera, `entering play moves the author's view to the Game Start camera (${looking === camera})`);

	await A.page.waitForTimeout(1600);
	const peerLooking = await B.page.evaluate(() => {
		let p;
		window.__stores.cameraPreview.cameraPreview.subscribe((v) => (p = v))();
		return p?.uuid ?? null;
	});
	h.check(
		peerLooking === camera,
		`AND the peer's view moves too — every peer acts on the replicated STATE itself (${peerLooking === camera})`
	);

	// the camera is NOT on the wire: only the state was sent
	const wire = await A.page.evaluate(async () => {
		const s = window.__stores;
		const seen = [];
		const peer = await new Promise((r) => s.peers.subscribe((p) => r(p))());
		const real = peer.send.bind(peer);
		peer.send = (msg) => {
			seen.push(msg?.type);
			return real(msg);
		};
		s.gameState.setGameState('menu');
		await new Promise((r) => setTimeout(r, 400));
		s.gameState.setGameState('playing');
		await new Promise((r) => setTimeout(r, 900));
		peer.send = real;
		return seen;
	});
	h.check(
		wire.includes('game'),
		`the STATE crosses the wire (${JSON.stringify([...new Set(wire)])})`
	);
	// `campreview` is in there, and that is correct: it is the PRE-EXISTING presence message
	// ("X is previewing camera Y"), not a command. The property that matters is that
	// receiving it never moves the receiver's own view — which is what makes the converge
	// come from the replicated STATE rather than from one peer seizing another's camera.
	h.check(
		!wire.some((t) => t === 'setcamera' || t === 'activecamera' || t === 'lookat'),
		'and NO camera-command message was invented for this'
	);
	const presenceInert = await B.page.evaluate(async () => {
		const s = window.__stores;
		s.cameraPreview.stopCameraPreview();
		await new Promise((r) => setTimeout(r, 500));
		const before = (() => {
			let p;
			s.cameraPreview.cameraPreview.subscribe((v) => (p = v))();
			return p?.uuid ?? null;
		})();
		// a peer telling us it is previewing something must NOT move us
		s.cameraPreview.applyRemoteCameraPreview({ peerId: 'someone', uuid: 'not-a-real-camera' });
		await new Promise((r) => setTimeout(r, 500));
		let after;
		s.cameraPreview.cameraPreview.subscribe((v) => (after = v))();
		return { before, after: after?.uuid ?? null };
	});
	h.check(
		presenceInert.before === null && presenceInert.after === null,
		`a peer's camera PRESENCE never moves our own view (${JSON.stringify(presenceInert)})`
	);

	// ---- 6. a LATE JOINER gets the state and catches up ---------------------
	const C = await h.setupPage(browser, 'C');
	await C.page.waitForFunction(() => !!window.__stores?.gameState, { timeout: 30000 });
	await h.connect(C, A);
	await C.page.waitForTimeout(2600);
	const onC = await state(C);
	h.check(onC.state === 'playing', `a late joiner receives the running game (${onC.state})`);
	h.check(onC.startedAt === (await state(A)).startedAt, 'with the same start stamp, so its round timer is already right');
	const aScore = (await state(A)).vars?.score;
	h.check(
		onC.vars?.score === aScore && aScore !== undefined,
		`and the shared variables, matching the author's (${onC.vars?.score} == ${aScore})`
	);

	// ---- 7. undo, and the save paths ---------------------------------------
	const undone = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.gameState.setGameState('over', { outcome: 'lost' });
		await new Promise((r) => setTimeout(r, 400));
		let before;
		s.gameState.gameState.subscribe((v) => (before = v))();
		s.history.undo();
		await new Promise((r) => setTimeout(r, 500));
		let after;
		s.gameState.gameState.subscribe((v) => (after = v))();
		s.history.redo();
		await new Promise((r) => setTimeout(r, 500));
		let again;
		s.gameState.gameState.subscribe((v) => (again = v))();
		return { before: before.state, after: after.state, again: again.state };
	});
	h.check(undone.before === 'over', `premise: the game ended (${undone.before})`);
	h.check(undone.after !== 'over', `undo steps the game state back (${undone.after})`);
	h.check(undone.again === 'over', `and REDO restores it - the identity idiom, not a present flag (${undone.again})`);

	const saved = await A.page.evaluate(async () => {
		const s = window.__stores;
		const payload = s.sessions.buildSessionPayload('game-test');
		const had = !!payload.game;
		const savedScore = payload.game?.vars?.score;
		s.gameState.clearGameState();
		await new Promise((r) => setTimeout(r, 300));
		const wiped = s.gameState.gameStateSnapshot();
		await s.sessions.applySession(payload);
		await new Promise((r) => setTimeout(r, 900));
		let g;
		s.gameState.gameState.subscribe((v) => (g = v))();
		return { had, wiped, savedScore, state: g.state, score: g.vars?.score, stamped: g.changedAt > 1e12 };
	});
	h.check(saved.had, 'buildSessionPayload carries a `game` field');
	h.check(saved.wiped === null, 'premise: the wipe emptied it');
	h.check(
		saved.state === 'over' && saved.score === saved.savedScore,
		`a session restore brings the game back (${saved.state}/${saved.score})`
	);
	h.check(saved.stamped, 'and stamps FRESH, so the restore wins over a peer holding an older state');

	await h.finish(browser);
});
