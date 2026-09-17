// 25-E (roadmap 25 section 4, audit M8) — ONE CLOCK FOR THE SESSION.
//
// Every stamp another peer compares used to be that machine's own Date.now(). A joiner
// whose clock runs 90 s fast therefore WON every latest-wins merge for the next 90 s —
// a host's LATER edit to the sky was refused on the joiner and overwritten on the host —
// its flow clock ran 90 s out of phase, and its game timer read a round 90 s older.
//
// What this suite pins, with C's Date.now pushed +90 s by an init script (the music-clock
// 6b recipe) and A its honest host:
//   1. premise: the skew is real, and a lone peer's session clock is its own
//   2. the joiner ADOPTS the host's clock (sessionNow agrees across the two machines)
//   3. a LATER edit wins on both sides even though the earlier one came from the fast clock
//   4. the synced flow clock and a game's elapsed time agree across the two
//   5. one toast per skewed peer, and the round trip is on the capability floor
//   6. the wire is additive (a pong carries so/ref; an older pong without them still folds)
//   7. leaving the session hands the joiner its own clock back; the host drops the samples
//
// Measured against the REAL clock (`new Date().getTime()`, which the init script leaves
// alone), so evaluate lag between two pages cannot pass or fail a check by itself.
//
// Run: APP_URL=https://theprototype.app:5175/ PEER_CONFIG=... npm run e2e -- session-clock
const h = require('./helpers.cjs');

const SKEW = 90000;

/** run a snippet with `s = window.__stores` in scope */
const inPage = (peer, body, arg) =>
	peer.page.evaluate(([src, a]) => Object.getPrototypeOf(async function () {}).constructor('s', 'arg', src)(window.__stores, a), [body, arg ?? null]);

/** the session clock minus the REAL clock, in ms — 0 on a machine keeping true time */
const sessionError = (peer) => inPage(peer, 'return s.connectionState.sessionNow() - new Date().getTime()');
const debug = (peer) => inPage(peer, 'return s.connectionState.sessionClockDebug()');
const notes = (peer) =>
	inPage(peer, 'let v = []; s.notifications.subscribe((x) => (v = x))(); return v.map((n) => String(n.text ?? n.message ?? n))');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const C = await h.setupPage(browser, 'C');
	await C.ctx.addInitScript((skew) => {
		const real = Date.now;
		Date.now = () => real() + skew;
	}, SKEW);
	await h.freshReload(C);
	C.id = await C.page.evaluate(() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.peer?.id))()));
	console.log('A id: ' + A.id + '   C id (skewed +90s): ' + C.id);

	// ---- 1. premise ------------------------------------------------------------------------
	console.log('\n=== 1. premise ===');
	const raw = await inPage(C, 'return Date.now() - new Date().getTime()');
	h.check(raw >= SKEW - 5 && raw <= SKEW + 5, `C's raw Date.now runs ${SKEW} ms ahead of the real clock (${raw})`);
	const alone = await debug(C);
	h.check(alone.offset === 0 && alone.reference === null, `a peer on its own keeps its own clock (offset ${alone.offset}, reference ${alone.reference})`);
	const aloneErr = await sessionError(C);
	h.check(Math.abs(aloneErr - SKEW) < 50, `…so an unconnected C reads its own fast clock (${aloneErr})`);

	// ---- 2. the joiner adopts the host's clock ------------------------------------------------
	console.log('\n=== 2. adoption ===');
	await h.connect(C, A, 3000);
	await h.eventually(
		() => sessionError(C),
		(e) => Math.abs(e) < 250,
		"C's session clock lands on A's (the host keeps true time here)",
		20000
	);
	const cDbg = await debug(C);
	const aDbg = await debug(A);
	console.log('  C: ' + JSON.stringify({ offset: cDbg.offset, reference: cDbg.reference, state: cDbg.state }));
	console.log('  A: ' + JSON.stringify({ offset: aDbg.offset, reference: aDbg.reference }));
	h.check(cDbg.reference === A.id, `C keeps time by the peer whose session it joined (${cDbg.reference})`);
	h.check(Math.abs(cDbg.offset + SKEW) < 250, `C's offset is the negative of its skew (${cDbg.offset})`);
	h.check(aDbg.offset === 0 && aDbg.reference === null, `the HOST never moves its clock toward a joiner (offset ${aDbg.offset})`);
	const [ea, ec] = await Promise.all([sessionError(A), sessionError(C)]);
	h.check(Math.abs(ea - ec) < 250, `sessionNow agrees across the two machines (A ${ea}, C ${ec})`);

	// ---- 3. the later edit wins -------------------------------------------------------------
	console.log('\n=== 3. a later edit wins everywhere ===');
	// C edits FIRST; A edits a beat later. With raw clocks C's stamp is ~90 s newer, so A's
	// later edit is refused on C and C's earlier one overwrites A. On the session clock the
	// order of the stamps is the order things happened in.
	await inPage(C, 'const e = s.environment; let st; e.environment.subscribe((v) => (st = v))(); e.setEnvironment("sunset", 1)');
	await h.eventually(
		() => inPage(A, 'let st; s.environment.environment.subscribe((v) => (st = v))(); return st.preset'),
		(p) => p === 'sunset',
		"premise: C's edit reaches A",
		10000
	);
	await A.page.waitForTimeout(400);
	await inPage(A, 's.environment.setEnvironment("night", 1)');
	await A.page.waitForTimeout(2500);
	const presets = await Promise.all(
		[A, C].map((p) => inPage(p, 'let st; s.environment.environment.subscribe((v) => (st = v))(); return { preset: st.preset, changedAt: st.changedAt }'))
	);
	console.log('  A ' + JSON.stringify(presets[0]) + '  C ' + JSON.stringify(presets[1]));
	h.check(presets[0].preset === 'night', `A keeps its own later edit (${presets[0].preset})`);
	h.check(presets[1].preset === 'night', `C takes A's later edit over its own earlier one (${presets[1].preset})`);

	// ---- 4. the shared runtime clocks --------------------------------------------------------
	console.log('\n=== 4. the flow clock and the game timer ===');
	const [ta, tc] = await Promise.all([A, C].map((p) => inPage(p, 'return { t: s.moduleSDK.runtimeNow(), real: new Date().getTime() }')));
	// correct for the two evaluations landing at different real instants
	const flowDiff = tc.t - ta.t - (tc.real - ta.real) / 1000;
	h.check(Math.abs(flowDiff) < 0.3, `the synced flow time agrees to ${flowDiff.toFixed(3)} s (it was 90 s apart)`);

	// The history epoch and every action node's first-seen time are SESSION seconds taken
	// as local cutoffs, mostly during the joiner's handshake. Recorded on the fast clock and
	// never corrected, they sit 90 s in the future and every live pulse is refused as stale.
	const syncedS = 'return { epoch: s.flowRuntime.triggerHistoryEpoch(), now: (s.connectionState.sessionNow() % 86400000) / 1000 }';
	const ep = await inPage(C, syncedS);
	h.check(ep.epoch > 0, `premise: the joiner received trigger history and marked its epoch (${ep.epoch})`);
	h.check(ep.epoch <= ep.now + 0.5, `the joiner's history epoch is not in the future of its corrected clock (epoch ${ep.epoch.toFixed(2)}, now ${ep.now.toFixed(2)})`);
	// …and a jump that happens AFTER the epoch was taken moves it by exactly the jump. Force
	// one by feeding C's ring zero-RTT samples 30 s away from the truth, then put it back.
	const jump = await inPage(C, `
		const mc = s.musicClock;
		const est = s.connectionState.sessionClockDebug().peers[arg].offset;
		const e0 = s.flowRuntime.triggerHistoryEpoch();
		const o0 = s.connectionState.sessionClockDebug().offset;
		for (let i = 0; i < 12; i++) mc.recordClockSample(arg, est + 30000, 0);
		const e1 = s.flowRuntime.triggerHistoryEpoch();
		const moved = s.connectionState.sessionClockDebug().offset;
		for (let i = 0; i < 12; i++) mc.recordClockSample(arg, est, 0);
		const o2 = s.connectionState.sessionClockDebug().offset;
		return { d: e1 - e0, want: (moved - o0) / 1000, back: s.flowRuntime.triggerHistoryEpoch() - e0, wantBack: (o2 - o0) / 1000 };`, A.id);
	h.check(Math.abs(jump.want - 30) < 0.1 && Math.abs(jump.d - jump.want) < 0.001, `a 30 s clock correction moves the epoch by exactly the jump (${jump.d.toFixed(3)} for ${jump.want.toFixed(3)})`);
	h.check(Math.abs(jump.back - jump.wantBack) < 0.001, `…and putting the clock back puts the epoch back (${jump.back.toFixed(3)} for ${jump.wantBack.toFixed(3)})`);

	await inPage(A, 's.gameState.setGameState("playing")');
	await h.eventually(
		() => inPage(C, 'let g; s.gameState.gameState.subscribe((v) => (g = v))(); return g.state'),
		(st) => st === 'playing',
		'premise: the game start reaches C',
		10000
	);
	const [ga, gc] = await Promise.all([A, C].map((p) => inPage(p, 'return { e: s.gameState.gameElapsed(), real: new Date().getTime() }')));
	const gameDiff = gc.e - ga.e - (gc.real - ga.real) / 1000;
	h.check(Math.abs(gameDiff) < 0.3, `a round's elapsed time agrees to ${gameDiff.toFixed(3)} s on the fast joiner`);
	await inPage(A, 's.gameState.setGameState("menu")');

	// ---- 5. the toast and the floor ----------------------------------------------------------
	console.log('\n=== 5. the skew toast and the capability floor ===');
	await h.eventually(
		() => notes(A),
		(list) => list.some((t) => t.includes(String(C.id).slice(0, 6).toUpperCase()) && /clock is 90 s ahead/.test(t)),
		"A is told C's clock is 90 s ahead",
		20000
	);
	await h.eventually(
		() => notes(C),
		(list) => list.some((t) => /clock is 90 s behind/.test(t)),
		"C is told A's clock is 90 s behind",
		20000
	);
	const once = await notes(A);
	h.check(once.filter((t) => /clock is 90 s ahead/.test(t)).length === 1, 'once per peer, not once per resync');
	const floor = await inPage(A, 's.cloudHooks.setCapabilityProvider(() => false); const r = { ping: s.cloudHooks.canApply("x", "clockping"), pong: s.cloudHooks.canApply("x", "clockpong"), other: s.cloudHooks.canApply("x", "environment") }; s.cloudHooks.setCapabilityProvider(null); return r');
	h.check(floor.ping && floor.pong && !floor.other, `clockping/clockpong sit on the ALWAYS_ALLOWED floor (${JSON.stringify(floor)})`);

	// ---- 6. the wire is additive -------------------------------------------------------------
	console.log('\n=== 6. additive wire ===');
	const pong = await inPage(C, `
		let pc; s.peers.subscribe((v) => (pc = v))();
		const conn = pc.connections[arg];
		const seen = [];
		const orig = conn.send.bind(conn);
		conn.send = (m) => { if (m?.type === 'clockpong') seen.push(m); return orig(m); };
		s.musicClock.answerClockPing({ type: 'clockping', sender: arg, t0: Date.now() });
		conn.send = orig;
		return seen[0] ?? null;`, A.id);
	h.check(!!pong && typeof pong.so === 'number' && pong.ref === A.id, `a pong carries the responder's session offset and whose clock it is (so ${pong?.so}, ref ${pong?.ref})`);
	const old = await inPage(A, `
		const before = s.connectionState.sessionClockDebug().samples[arg]?.offsets.length ?? 0;
		const now = Date.now();
		s.musicClock.applyClockPong({ type: 'clockpong', sender: arg, t0: now - 10, t1: now - 5, t2: now - 5 });
		return { before, after: s.connectionState.sessionClockDebug().samples[arg]?.offsets.length ?? 0 };`, C.id);
	h.check(old.after === Math.min(old.before + 1, 12), `an OLDER peer's pong (no so/ref) still folds into the estimate (${old.before} -> ${old.after})`);

	// ---- 7. leaving -------------------------------------------------------------------------
	console.log('\n=== 7. leaving ===');
	await inPage(C, 'let p; s.peers.subscribe((v) => (p = v))(); p.leaveSession()');
	await h.eventually(() => debug(C), (d) => d.offset === 0 && d.reference === null, 'leaving hands C its own clock back', 10000);
	await h.eventually(() => debug(A), (d) => !(C.id in d.peers), "the host drops the departed joiner's samples", 15000);

	return h.finish(browser);
});
