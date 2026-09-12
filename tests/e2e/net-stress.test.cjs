// 27-I — THE SMALL MESH REGRESSION SUITE.
//
// `net-stress.cjs` beside this file is the MEASUREMENT RIG: a many-minute sweep across
// mesh sizes that spawns its own signaling server and refuses any non-localhost APP_URL.
// Its header has always pointed at this file for the quick check, and this file did not
// exist — so `npm run e2e -- net-stress` matched the rig's name and ran nothing.
//
// What this pins, on a THREE-peer mesh, is the handful of properties the rig measures
// that would be a real regression if they broke:
//   1. the mesh FILLS — a late joiner dials one peer and ends up connected to both
//   2. a broadcast reaches every peer with NO loss, by sequence number
//   3. one send's fan-out cost stays bounded (it is a per-conn loop, never batched)
//   4. the same, while a second sender is loading the mesh — nobody starves
//
// The probe rides a REAL `move` payload with additive `__ns` fields, which is the rig's
// own trick and matters twice over: it exercises the real applier path, and since 27-A
// validates every incoming message, a made-up uuid would be REJECTED by that guard — so
// the probe carries an actual object's uuid.
//
// Run: APP_URL=https://theprototype.app:5175/ npm run e2e -- net-stress.test
const h = require('./helpers.cjs');

/** A reduced installProbe: hook every conn, count probe messages per sender by seq. */
const installProbe = (peer) =>
	peer.page.evaluate((myId) => {
		const w = window;
		let pc;
		w.__stores.peers.subscribe((p) => (pc = p))();
		const ns = (w.__probe = w.__probe || { myId, hooked: new WeakSet(), rx: {}, sendMs: [], seq: 0 });
		ns.pc = pc;
		// the app's outgoing map AND peerjs's own, which also holds INBOUND conns — an
		// ack can come back over a conn this peer never dialled
		ns.allConns = () => {
			const seen = new Set();
			const out = [];
			const push = (c) => {
				if (!c || typeof c.send !== 'function' || c.type !== 'data' || seen.has(c)) return;
				seen.add(c);
				out.push(c);
			};
			for (const k of Object.keys(pc.connections || {})) push(pc.connections[k]);
			const raw = (pc.peer && pc.peer.connections) || {};
			for (const k of Object.keys(raw)) (raw[k] || []).forEach(push);
			return out;
		};
		ns.hook = () => {
			for (const c of ns.allConns()) {
				if (ns.hooked.has(c)) continue;
				ns.hooked.add(c);
				c.on('data', (d) => {
					if (!d || d.__ns !== 'probe') return;
					const s = ns.rx[d.__from] || (ns.rx[d.__from] = { count: 0, maxSeq: -1 });
					s.count++;
					if (d.__seq > s.maxSeq) s.maxSeq = d.__seq;
				});
			}
			return ns.allConns().length;
		};
		// conns keep appearing through the join phase, so keep re-scanning
		ns.hook();
		if (!ns.auto) ns.auto = setInterval(() => ns.hook(), 250);
		ns.send = (uuid, seq) => {
			const t = performance.now();
			pc.send({
				type: 'move',
				uuid,
				pos: [Math.sin(seq / 10), 0.5, Math.cos(seq / 10)],
				rot: [0, seq / 50, 0],
				scale: [1, 1, 1],
				__ns: 'probe',
				__from: ns.myId,
				__seq: seq
			});
			ns.sendMs.push(performance.now() - t);
		};
		// `maxSeq` is a RUNNING MAXIMUM and `count` accumulates, so a later section that
		// sends fewer messages than an earlier one cannot lower either — without this the
		// two-way check below passes on numbers left over from the first blast.
		ns.reset = () => {
			ns.rx = {};
		};
		ns.blast = async (uuid, count, gapMs) => {
			ns.sendMs = [];
			for (let i = 0; i < count; i++) {
				ns.send(uuid, i);
				await new Promise((r) => setTimeout(r, gapMs));
			}
			return { sent: count, maxSendMs: Math.max(...ns.sendMs) };
		};
		return true;
	}, peer.id);

const received = (peer, fromId) =>
	peer.page.evaluate((from) => {
		const s = window.__probe?.rx?.[from];
		return s ? { count: s.count, maxSeq: s.maxSeq } : { count: 0, maxSeq: -1 };
	}, fromId);

const openConns = (peer) =>
	peer.page.evaluate(() => {
		let pc;
		window.__stores.peers.subscribe((p) => (pc = p))();
		return pc?.openedPeers?.size ?? 0;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	const C = await h.setupPage(browser, 'C');

	// ---- 1. the mesh fills -------------------------------------------------------------
	await h.connect(B, A);
	// a CONNECTED peer's pill has no dial input, so the late joiner dials the HOST
	await h.connect(C, A);
	await h.eventually(() => openConns(C), (n) => n >= 2, 'the late joiner ends up connected to BOTH peers', 30000);
	await h.eventually(() => openConns(A), (n) => n >= 2, 'the host holds both connections', 20000);
	await h.eventually(() => openConns(B), (n) => n >= 2, 'and the first joiner was filled in by the mesh', 20000);

	// a REAL object, so the probe's `move` survives the 27-A wire validator
	const uuid = await A.page.evaluate(() => {
		window.__stores.addObjects.spawnAtPoint('/create Box 1 1 1', [3, 0.5, -2]);
		return new Promise((resolve) =>
			window.__stores.objectsGroup.subscribe((g) => {
				const o = g.children[g.children.length - 1];
				resolve(o ? o.uuid : null);
			})()
		);
	});
	h.check(!!uuid, `premise: a real object to address, so the probe is not rejected as malformed (${uuid})`);
	await A.page.waitForTimeout(800);

	for (const p of [A, B, C]) await installProbe(p);
	await A.page.waitForTimeout(600);

	// ---- 2. a broadcast reaches everyone, with no loss ----------------------------------
	const blast = await A.page.evaluate(
		([u, n, gap]) => window.__probe.blast(u, n, gap),
		[uuid, 60, 25]
	);
	h.check(blast.sent === 60, `premise: the host sent 60 probe messages (${blast.sent})`);
	await A.page.waitForTimeout(1200);

	const atB = await received(B, A.id);
	const atC = await received(C, A.id);
	h.check(atB.count === 60, `every message reached the first joiner (${atB.count}/60, maxSeq ${atB.maxSeq})`);
	h.check(atC.count === 60, `every message reached the late joiner (${atC.count}/60, maxSeq ${atC.maxSeq})`);
	h.check(
		atB.maxSeq === 59 && atC.maxSeq === 59,
		`and the LAST one arrived, so nothing was dropped off the tail (${atB.maxSeq}, ${atC.maxSeq})`
	);

	// ---- 3. fan-out cost stays bounded --------------------------------------------------
	// `send` is a per-conn loop with no batching, so this is the number that grows with N.
	h.check(
		blast.maxSendMs < 250,
		`one broadcast's fan-out stays bounded (worst send ${blast.maxSendMs.toFixed(1)}ms across 2 conns)`
	);

	// ---- 4. two senders at once: nobody starves -----------------------------------------
	// clear the counters first, or section 2's seq 59 makes this check unfalsifiable
	for (const p of [A, B, C]) await p.page.evaluate(() => window.__probe.reset());
	await Promise.all([
		A.page.evaluate(([u, n, gap]) => window.__probe.blast(u, n, gap), [uuid, 40, 25]),
		B.page.evaluate(([u, n, gap]) => window.__probe.blast(u, n, gap), [uuid, 40, 25])
	]);
	await A.page.waitForTimeout(1500);
	const cFromA = await received(C, A.id);
	const cFromB = await received(C, B.id);
	h.check(
		cFromA.maxSeq === 39 && cFromB.maxSeq === 39 && cFromA.count === 40 && cFromB.count === 40,
		`under two-way load the late joiner got both streams WHOLE (A ${cFromA.count}/40 seq ${cFromA.maxSeq}, B ${cFromB.count}/40 seq ${cFromB.maxSeq})`
	);

	await h.finish(browser);
});
