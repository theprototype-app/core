// #23 A2 — the musical clock: the replicated transport, the look-ahead scheduler,
// and the peer clock-offset estimate (finding 6).
//
// Sections 1-3 run on one page and are deterministic; 4-6 need two real peers over
// the signaling box (PEER_CONFIG on a lane URL). Section 6 is the MEASUREMENT this
// phase exists for: two peers on one machine have a TRUE skew of 0, so the estimator's
// error distribution is read directly; a third peer with an injected +300 ms Date.now
// proves it converges on a real offset.
//
// The scheduler's counterfactual is the horizon itself: an event's `at` must sit AHEAD
// of the audio clock when the callback runs (never late) and consecutive beats must be
// exactly a beat apart on the audio clock (never rAF-jittered).
const h = require('./helpers.cjs');

/** run a snippet against the musicClock module in the page */
const mc = (page, body, arg) =>
	page.evaluate(
		([src, a]) => Object.getPrototypeOf(async function () {}).constructor('mc', 'eng', 'arg', src)(window.__stores.musicClock, window.__stores.audioEngine, a),
		[body, arg ?? null]
	);

const QUANTUM_S = 128 / 44100; // one render quantum — "within one buffer"

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { audio: true });
	const page = A.page;

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. the document ===');
	const d = await mc(page, 'return mc.clockDebug().transport');
	h.check(d.bpm === 120 && d.playing === false && d.swing === 0 && d.barsPerLoop === 4, '1.1 defaults: 120, stopped, straight, 4 bars');
	h.check(d.changedAt === 0 && d.startedAt === 0, '1.2 a fresh transport has never been stamped or started');

	const norm = await mc(
		page,
		'const a = mc.normalizeTransport({ bpm: 9999, swing: -3, barsPerLoop: 2.6, futureField: "keep", type: "transport" });' +
			'const b = mc.normalizeTransport(a);' +
			'return { a, same: JSON.stringify(a) === JSON.stringify(b) }'
	);
	h.check(norm.a.bpm === 300 && norm.a.swing === 0 && norm.a.barsPerLoop === 3, '1.3 clamps live in the normalizer (bpm ' + norm.a.bpm + ', swing ' + norm.a.swing + ', bars ' + norm.a.barsPerLoop + ')');
	h.check(norm.a.futureField === 'keep' && !('type' in norm.a), '1.4 an unknown field is preserved, the wire envelope is not');
	h.check(norm.same, '1.5 normalizing twice is idempotent');

	const snapNull = await mc(page, 'return mc.transportSnapshot()');
	h.check(snapNull === null, '1.6 a default transport snapshots to null — no `transport` key in a save');

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. beat maths ===');
	const maths = await mc(
		page,
		'const s = mc.normalizeTransport({ bpm: 120, playing: true, startedAt: 1000000, barsPerLoop: 2 });' +
			'return {' +
			'  b0: mc.beatAt(s, 1000000), b2: mc.beatAt(s, 1001000), stopped: mc.beatAt({ ...s, playing: false }, 1005000),' +
			'  wall4: mc.wallForBeat(s, 4), loop: mc.loopBeats(s),' +
			'  sw0: mc.swungBeat(2.5, 0), sw1: mc.swungBeat(2.5, 1), swDown: mc.swungBeat(3, 1), sw16: mc.swungBeat(2.25, 1), swTrip: mc.swungBeat(0.5, 2/3)' +
			'}'
	);
	h.check(maths.b0 === 0 && Math.abs(maths.b2 - 2) < 1e-9, '2.1 120 bpm: one second is two beats (' + maths.b2 + ')');
	h.check(maths.stopped === 0, '2.2 a stopped transport reads beat 0');
	h.check(maths.wall4 === 1002000, '2.3 wallForBeat inverts beatAt (beat 4 = +2000 ms)');
	h.check(maths.loop === 8, '2.4 two bars of four is an eight-beat loop');
	h.check(maths.sw0 === 2.5 && maths.sw1 === 2.75, '2.5 swing 1 pushes the off-eighth to 3/4 of the beat (' + maths.sw1 + ')');
	h.check(maths.swDown === 3 && maths.sw16 === 2.25, '2.6 downbeats and sixteenths do not move');
	h.check(Math.abs(maths.swTrip - (0.5 + 1 / 6)) < 1e-9, '2.7 swing 2/3 is the triplet feel (' + maths.swTrip.toFixed(4) + ')');

	// a BPM change while playing must not move the beat you are on
	const anchor = await mc(
		page,
		'mc.playTransport();' +
			'await new Promise((r) => setTimeout(r, 600));' +
			'const before = mc.transportNow().beat;' +
			'mc.setBpm(240);' +
			'const after = mc.transportNow().beat;' +
			'const s = mc.clockDebug().transport;' +
			'mc.stopTransport();' +
			'return { before, after, bpm: s.bpm, playing: s.playing }'
	);
	h.check(anchor.bpm === 240 && anchor.playing, '2.8 (premise) tempo changed while playing');
	h.check(Math.abs(anchor.after - anchor.before) < 0.05, '2.9 re-anchoring keeps the beat continuous across a tempo change (' + anchor.before.toFixed(3) + ' -> ' + anchor.after.toFixed(3) + ')');

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. persistence and history ===');
	const round = await mc(
		page,
		'mc.transportRestore(null);' +
			'mc.setTransport({ bpm: 97, swing: 0.3, barsPerLoop: 8 });' +
			'const snap = mc.transportSnapshot();' +
			'mc.transportRestore(null);' + // wipe: absent = default
			'const wiped = mc.clockDebug().transport;' +
			'mc.transportRestore({ ...snap, changedAt: 1 });' + // a STALE file stamp
			'const back = mc.clockDebug().transport;' +
			'return { snap, wiped, back }'
	);
	h.check(round.snap && round.snap.bpm === 97, '3.1 a non-default transport snapshots to a payload');
	h.check(round.wiped.bpm === 120 && round.wiped.swing === 0, '3.2 an absent payload resets to the default (whole-world replace)');
	h.check(round.back.bpm === 97 && round.back.swing === 0.3 && round.back.barsPerLoop === 8, '3.3 restore brings back every field');
	h.check(round.back.changedAt > round.wiped.changedAt, '3.4 a restore stamps FRESH and monotonic — a stale file stamp cannot lose to live state');

	const resume = await mc(
		page,
		'const t0 = Date.now();' +
			'const a = mc.transportRestore({ bpm: 100, playing: true, startedAt: 5 });' +
			'const b = mc.transportRestore({ bpm: 100, playing: true, startedAt: 5 }, false, { resume: false });' +
			'mc.transportRestore(null);' +
			'return { aPlaying: a.playing, aStarted: a.startedAt >= t0, bPlaying: b.playing }'
	);
	h.check(resume.aPlaying && resume.aStarted, '3.5 a saved PLAYING transport restarts from beat 0 NOW (the musicRestore rule)');
	h.check(resume.bPlaying === false, '3.6 resume:false brings it back stopped (autosave)');

	const session = await page.evaluate(() => {
		const mcl = window.__stores.musicClock;
		mcl.transportRestore(null);
		const plain = window.__stores.sessions.buildSessionPayload('plain');
		mcl.setBpm(133);
		const tuned = window.__stores.sessions.buildSessionPayload('tuned');
		mcl.transportRestore(null);
		return { plainHas: 'transport' in plain, tunedBpm: tuned.transport?.bpm ?? null };
	});
	h.check(session.plainHas === false, '3.7 a session of a default scene has NO transport key (byte-identical file)');
	h.check(session.tunedBpm === 133, '3.8 a tuned transport rides the session payload (bpm ' + session.tunedBpm + ')');

	const undo = await page.evaluate(() => {
		const mcl = window.__stores.musicClock;
		const hist = window.__stores.history;
		mcl.setBpm(140);
		mcl.setSwing(0.5);
		const afterEdits = mcl.clockDebug().transport;
		hist.undo();
		const oneBack = mcl.clockDebug().transport;
		hist.undo();
		const twoBack = mcl.clockDebug().transport;
		hist.redo();
		const redone = mcl.clockDebug().transport;
		mcl.transportRestore(null);
		return { afterEdits, oneBack, twoBack, redone };
	});
	h.check(undo.afterEdits.bpm === 140 && undo.afterEdits.swing === 0.5, '3.9 (premise) two edits landed');
	h.check(undo.oneBack.swing === 0 && undo.oneBack.bpm === 140, '3.10 undo reverts the last edit only');
	h.check(undo.twoBack.bpm === 120, '3.11 a second undo reverts the first');
	h.check(undo.redone.bpm === 140 && undo.redone.swing === 0, '3.12 redo re-applies in order');
	h.check(undo.redone.changedAt > undo.afterEdits.changedAt, '3.13 a replay stamps FRESH, so peers follow the undo');

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. the look-ahead scheduler ===');
	const sched = await mc(
		page,
		'const ctx = eng.ensureAudioContext();' +
			'const hits = [];' +
			'const cancel = mc.scheduleRepeat(1, (e) => hits.push({ beat: e.beat, at: e.at, now: ctx.currentTime, late: e.late }));' +
			'const oneShot = [];' +
			'mc.schedule(2.5, (e) => oneShot.push({ beat: e.beat, at: e.at, now: ctx.currentTime, late: e.late }));' +
			'mc.setBpm(120);' +
			'mc.playTransport();' +
			'await new Promise((r) => setTimeout(r, 1700));' +
			'mc.stopTransport();' +
			'const firedWhilePlaying = hits.length;' +
			'await new Promise((r) => setTimeout(r, 300));' +
			'const dbg = mc.clockDebug().scheduler;' +
			'cancel();' +
			'return { hits, oneShot, firedWhilePlaying, afterStop: hits.length, dbg, rate: ctx.sampleRate }'
	);
	const beats = sched.hits.map((x) => x.beat);
	h.check(beats.length >= 3 && beats.every((b, i) => b === i), '4.1 beats fire in order from 0 with no gap and no double fire (' + beats.join(',') + ')');
	const leads = sched.hits.map((x) => x.at - x.now);
	const minLead = Math.min(...leads.slice(1)); // beat 0 is the (re)start's grace case
	const maxLead = Math.max(...leads);
	h.check(minLead >= 0, '4.2 every callback runs AHEAD of its audio time — never late (min lead ' + (minLead * 1000).toFixed(1) + ' ms)');
	h.check(maxLead <= (h.HORIZON_MS ?? 100) / 1000 + 0.06, '4.3 and no further ahead than the horizon plus a tick (max lead ' + (maxLead * 1000).toFixed(1) + ' ms)');
	const quantum = 128 / sched.rate;
	const gaps = sched.hits.slice(1).map((x, i) => x.at - sched.hits[i].at);
	const worstGap = Math.max(...gaps.map((g) => Math.abs(g - 0.5)));
	// bound: each `at` is ctx.currentTime (quantized to 128 samples) plus a Date.now() delta (1 ms
	// resolution), so two of them differ by at most one quantum plus a millisecond
	h.check(worstGap < quantum + 0.001, '4.4 consecutive beats are 500 ms apart ON THE AUDIO CLOCK within one buffer (worst ' + (worstGap * 1000).toFixed(2) + ' ms, bound ' + ((quantum + 0.001) * 1000).toFixed(2) + ' ms)');
	h.check(sched.oneShot.length === 1 && sched.oneShot[0].beat === 2.5 && !sched.oneShot[0].late, '4.5 a one-shot at beat 2.5 fires exactly once, on time');
	h.check(sched.afterStop === sched.firedWhilePlaying, '4.6 nothing fires after Stop');
	h.check(sched.dbg.ticking && sched.dbg.repeats === 1, '4.7 the scheduler ticks on setInterval and keeps the repeat registered');

	const lateAndRestart = await mc(
		page,
		'const got = [];' +
			'const cancel = mc.scheduleRepeat(1, (e) => got.push(e.beat));' +
			'mc.playTransport(Date.now() - 3200);' + // join a transport already at beat ~6.4
			'await new Promise((r) => setTimeout(r, 700));' +
			'const late = [];' +
			'mc.schedule(1, (e) => late.push({ beat: e.beat, late: e.late }));' + // beat 1 is long gone
			'await new Promise((r) => setTimeout(r, 120));' +
			'mc.stopTransport();' +
			'cancel();' +
			'return { got, late }'
	);
	h.check(lateAndRestart.got.length && lateAndRestart.got[0] >= 6, '4.8 a repeat joining at beat ~6.4 starts THERE — the past is not replayed (first ' + lateAndRestart.got[0] + ')');
	h.check(lateAndRestart.late.length === 1 && lateAndRestart.late[0].late === true, '4.9 a one-shot already in the past fires once, flagged late (plays now rather than never)');

	// the scheduler drives REAL sound: a metronome through an oscVoice at the scheduled `at`
	const audible = await (async () => {
		const start = mc(
			page,
			'mc.setBpm(240);' +
				'window.__metro = mc.scheduleRepeat(1, (e) => { const v = eng.oscVoice({ freq: 880, gain: 0.5, attack: 0.005, decay: 0.05, sustain: 0.2, release: 0.05 }); v.start(e.at); v.stop(e.at + 0.08); setTimeout(() => v.dispose(), 400); });' +
				'mc.playTransport();'
		);
		await start;
		const heard = await h.audioMetrics(A, 1000);
		await mc(page, 'mc.stopTransport(); window.__metro(); window.__metro = null;');
		await page.waitForTimeout(500);
		const quiet = await h.audioMetrics(A, 400);
		await mc(page, 'mc.transportRestore(null)');
		return { heard, quiet };
	})();
	h.check(!audible.heard.silent, '4.10 a scheduled metronome is HEARD through the tap (peak ' + audible.heard.peak.toFixed(3) + ')');
	h.check(Math.abs(audible.heard.centroid - 880) < 200, '4.11 at the pitch it scheduled (' + Math.round(audible.heard.centroid) + ' Hz)');
	h.check(audible.quiet.silent, '4.12 and Stop silences it (peak ' + audible.quiet.peak.toFixed(5) + ')');

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. two peers: the transport replicates ===');
	const B = await h.setupPage(browser, 'B', { audio: true });
	await mc(page, 'mc.setBpm(100); mc.playTransport();');
	await h.connect(B, A);

	const readB = () => mc(B.page, 'return mc.clockDebug().transport');
	const readA = () => mc(page, 'return mc.clockDebug().transport');
	const tA = await readA();
	await h.eventually(readB, (t) => t.bpm === 100 && t.playing && t.startedAt === tA.startedAt, '5.1 a late joiner inherits the transport from the handshake push (bpm, playing, startedAt)');
	// read both grids at ONE wall instant (node's clock is this same machine's clock), so
	// this compares the documents rather than two round trips a quarter-beat apart
	const T1 = Date.now();
	const beatsAB = await Promise.all([mc(page, 'return mc.beatAt(mc.clockDebug().transport, arg)', T1), mc(B.page, 'return mc.beatAt(mc.clockDebug().transport, arg)', T1)]);
	h.check(Math.abs(beatsAB[0] - beatsAB[1]) < 1e-6, '5.2 both peers place one instant on the same beat (' + beatsAB[0].toFixed(3) + ' vs ' + beatsAB[1].toFixed(3) + ')');

	// a fast double edit — two writes in one millisecond — must BOTH replicate
	await mc(page, 'mc.setBpm(90); mc.setBpm(95);');
	await h.eventually(readB, (t) => t.bpm === 95, '5.3 THE MONOTONIC STAMP: the second of two same-millisecond edits reaches the peer (counterfactual: a bare Date.now() stamp drops it)');
	const stampsA = await mc(page, 'const a = mc.clockDebug().transport.changedAt; mc.setBpm(96); return { a, b: mc.clockDebug().transport.changedAt }');
	h.check(stampsA.b > stampsA.a, '5.4 every commit bumps the stamp strictly past the previous one');

	await page.evaluate(() => window.__stores.history.undo());
	await h.eventually(readB, (t) => t.bpm === 95, '5.5 an undo on A replicates to B');
	await page.evaluate(() => window.__stores.history.redo());
	await h.eventually(readB, (t) => t.bpm === 96, '5.6 and so does the redo');

	// B edits too: latest wins in the other direction
	await mc(B.page, 'mc.setSwing(0.4)');
	await h.eventually(readA, (t) => t.swing === 0.4 && t.bpm === 96, '5.7 an edit from B lands on A without clobbering A\'s tempo');

	// the explicit re-pull: wipe B locally, ask A for it
	await B.page.evaluate((aId) => {
		const mcl = window.__stores.musicClock;
		mcl.transport.set(mcl.normalizeTransport(null)); // stamp 0, a local wipe with no broadcast
		const peer = window.__stores.peers;
		let p;
		peer.subscribe((v) => (p = v))();
		p.connections[aId].send({ type: 'gettransport', sender: p.peer.id });
	}, A.id);
	await h.eventually(readB, (t) => t.bpm === 96 && t.swing === 0.4, '5.8 `gettransport` re-pulls the document');

	// a stale document is refused
	const stale = await mc(B.page, 'const cur = mc.clockDebug().transport; const took = mc.applyRemoteTransport({ ...cur, bpm: 50, changedAt: cur.changedAt - 1 }); return { took, bpm: mc.clockDebug().transport.bpm }');
	h.check(stale.took === false && stale.bpm === 96, '5.9 a strictly OLDER document is refused');
	const equal = await mc(B.page, 'const cur = mc.clockDebug().transport; const took = mc.applyRemoteTransport({ ...cur, bpm: 51 }); const bpm = mc.clockDebug().transport.bpm; mc.applyRemoteTransport({ ...cur, bpm: 96, changedAt: cur.changedAt + 1 }); return { took, bpm }');
	h.check(equal.took === true && equal.bpm === 51, '5.10 an EQUAL stamp is accepted — on an ordered channel it arrived later');

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. THE MEASUREMENT: peer clock offset ===');
	// 6a. true skew 0 (same machine): the estimator's noise floor
	const est = await h
		.eventually(
			() => mc(page, 'return mc.clockDebug().peers', null).then((p) => p[B.id] ?? null),
			(p) => !!p && p.samples >= 5,
			'6.1 within a second of connecting A holds an estimate for B built from the burst (>= 5 samples)',
			8000
		)
		.then(() => mc(page, 'return mc.clockDebug().peers').then((p) => p[B.id]));
	console.log('  burst estimate: ' + JSON.stringify(est));
	h.check(est && Math.abs(est.offset) < 5, '6.2 same-machine peers: |offset| under 5 ms (' + est.offset.toFixed(2) + ' ms, rtt ' + est.rtt.toFixed(2) + ' ms)');

	// 25 more pings, one every 120 ms, reading the newest raw sample each time
	const dist = await mc(
		page,
		'const out = [];' +
			'for (let i = 0; i < 25; i++) {' +
			'  const before = (mc.clockDebug().samples[arg]?.offsets ?? []).length + i;' +
			'  mc.sendClockPing(arg);' +
			'  await new Promise((r) => setTimeout(r, 120));' +
			'  const s = mc.clockDebug().samples[arg];' +
			'  if (s) out.push({ offset: s.offsets[s.offsets.length - 1], rtt: s.rtts[s.rtts.length - 1] });' +
			'}' +
			'return out',
		B.id
	);
	const sorted = (arr) => [...arr].sort((a, b) => a - b);
	const pct = (arr, p) => sorted(arr)[Math.min(arr.length - 1, Math.floor(p * arr.length))];
	const offs = dist.map((s) => Math.abs(s.offset));
	const rtts = dist.map((s) => s.rtt);
	console.log('  raw samples: ' + dist.length);
	console.log('  |offset| ms  median ' + pct(offs, 0.5).toFixed(2) + '  p90 ' + pct(offs, 0.9).toFixed(2) + '  max ' + Math.max(...offs).toFixed(2));
	console.log('  rtt ms       median ' + pct(rtts, 0.5).toFixed(2) + '  p90 ' + pct(rtts, 0.9).toFixed(2) + '  max ' + Math.max(...rtts).toFixed(2));
	h.check(dist.length >= 20, '6.3 (premise) the steady pings were answered (' + dist.length + '/25)');
	h.check(pct(offs, 0.9) < 5, '6.4 p90 |offset error| under 5 ms at true skew 0 (' + pct(offs, 0.9).toFixed(2) + ' ms)');

	// 6b. an injected +300 ms skew on a third peer: does the estimate converge on it?
	const C = await h.setupPage(browser, 'C');
	await C.ctx.addInitScript(() => {
		const real = Date.now;
		Date.now = () => real() + 300;
	});
	await h.freshReload(C);
	C.id = await C.page.evaluate(() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.peer?.id))()));
	console.log('C (skewed +300ms) id: ' + C.id);
	const skewed = await C.page.evaluate(() => Date.now() - new Date().getTime());
	h.check(skewed >= 299 && skewed <= 301, '6.5 (premise) C\'s Date.now runs 300 ms ahead of its real clock (' + skewed + ')');
	await h.connect(C, A);
	// the burst waits ~2 s for the connect storm to pass and the 5 s resync keeps adding
	// samples; the min-RTT filter is what lets the estimate settle on the truth
	await h.eventually(
		() => mc(page, 'return mc.clockDebug().peers').then((p) => p[C.id] ?? null),
		(p) => !!p && p.samples >= 6 && Math.abs(p.offset - 300) < 10,
		'6.6 A estimates C\'s clock at +300 ms within 10 ms',
		25000
	);
	const aSeesC = await mc(page, 'return mc.clockDebug().peers').then((p) => p[C.id] ?? null);
	const cView = await mc(C.page, 'return mc.clockDebug().peers').then((p) => p[A.id] ?? null);
	console.log('  A sees C: ' + JSON.stringify(aSeesC) + '  C sees A: ' + JSON.stringify(cView));
	console.log('  A raw samples of C: ' + JSON.stringify(await mc(page, 'return mc.clockDebug().samples[arg] ?? null', C.id)));
	h.check(!!cView && Math.abs(cView.offset + 300) < 10, '6.7 and C estimates A at -300 ms — the estimate is antisymmetric (' + (cView ? cView.offset.toFixed(1) : 'none') + ')');
	const corrected = await mc(page, 'const stamp = 1000000; return { c: mc.correctRemoteStamp(arg, stamp), unknown: mc.correctRemoteStamp("nobody", stamp) }', C.id);
	h.check(Math.abs(corrected.c - (1000000 - 300)) < 10 && corrected.unknown === 1000000, '6.8 correctRemoteStamp moves a C stamp onto A\'s clock; an unknown peer is left alone');

	// skew does NOT move a note's beat, only the real time each grid renders it at — the
	// module header's argument, asserted: the skewed joiner holds the same document (so any
	// wire stamp maps to the same beat on both), and its clock simply reads 300 ms more
	const T2 = Date.now();
	const grid = 'const d = mc.clockDebug().transport; return { startedAt: d.startedAt, bpm: d.bpm, now: Date.now(), beat: mc.beatAt(d, arg) }';
	const [gridA, gridC] = await Promise.all([mc(page, grid, T2), mc(C.page, grid, T2)]);
	console.log('  A grid ' + JSON.stringify(gridA) + '\n  C grid ' + JSON.stringify(gridC));
	h.check(gridA.startedAt === gridC.startedAt && gridA.bpm === gridC.bpm && Math.abs(gridA.beat - gridC.beat) < 1e-6, '6.9a the skewed joiner holds the SAME document, so a wire stamp lands on the same beat on both peers');
	const lead = gridC.now - gridA.now;
	h.check(lead > 250 && lead < 1500, '6.9b what skew changes is WHEN: C\'s clock reads ' + lead + ' ms more than A\'s (300 injected + evaluate lag), so it renders every beat that much earlier in real time');

	// 6c. teardown cleans up — a graceful leave says goodbye, and the receiver's full
	// per-peer teardown (handleDisconnected) runs at once
	await C.page.evaluate(() => { let p; window.__stores.peers.subscribe((v) => (p = v))(); p.leaveSession(); });
	await h.eventually(() => mc(page, 'return mc.clockDebug().peers').then((p) => C.id in p), (has) => has === false, '6.10 a departed peer\'s clock samples are dropped', 15000);
	await C.ctx.close();

	await mc(page, 'mc.transportRestore(null)');
	await h.finish(browser);
});
