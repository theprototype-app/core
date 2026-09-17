// 27-I + 25-G — THE MESH REGRESSION SUITE, on FOUR peers and a LOCAL signaling server.
//
// `net-stress.cjs` beside this file is the MEASUREMENT RIG (a many-minute sweep across
// mesh sizes). This is the quick check that would catch a real regression in what the rig
// measures. 27-I shipped it on three peers against the shared signaling box; 25-G makes it
// what that brief asked for:
//   - N=4, because with three peers the host's `hosts` roster only ever names ONE other
//     peer, so a fill that mishandled a list longer than one (only the first id, only the
//     last) would still pass. With four, each fill has to reach two peers that never
//     dialled each other — six of the twelve links come from the fill alone.
//   - a LOCAL `peer` server on :9001 (localSignal.cjs), so a signaling hiccup on a shared
//     box can no longer masquerade as a mesh regression, and nothing floods production.
//
// What this pins:
//   1. the mesh FILLS — every one of the 12 ordered pairs is open (pair-complete: a link
//      that never formed is exactly the loss a user feels)
//   2. a broadcast reaches every peer with NO loss, by sequence number
//   3. all FOUR broadcasting at once: every ordered pair delivers whole — nobody starves
//   4. one send's fan-out cost stays bounded
//   5. the PRESENCE stream (roadmap 25 3c/3d, audit H7): four peers orbiting at display
//      rate send `camera` at the gated rate (20/s desktop), NOT once per frame — with a
//      premise that every sender drew well above the gate, so per-frame would be visible
//   6. the main thread under that load: long tasks per peer are recorded and bounded
//
// The probe rides a REAL `move` payload with additive `__ns` fields: 27-A validates every
// incoming message, so a made-up uuid would be rejected — the probe carries a real uuid.
//
// Run: APP_URL=https://theprototype.app:5180/ npm run e2e -- net-stress.test
const h = require('./helpers.cjs');
const { LOCAL_PEER_STORAGE, ensureSignalServer, stopSignalServer } = require('./localSignal.cjs');

/** Hook every conn; count probe messages per sender by seq, and presence per sender. */
const installProbe = (peer) =>
	peer.page.evaluate((myId) => {
		const w = window;
		let pc;
		w.__stores.peers.subscribe((p) => (pc = p))();
		const ns = (w.__probe = w.__probe || { myId, hooked: new WeakSet(), rx: {}, cam: {}, sendMs: [], tasks: [] });
		ns.pc = pc;
		if (!ns.observer) {
			try {
				ns.observer = new PerformanceObserver((list) => {
					for (const e of list.getEntries()) ns.tasks.push({ at: e.startTime, ms: e.duration });
				});
				ns.observer.observe({ entryTypes: ['longtask'] });
			} catch {
				ns.observer = null;
			}
		}
		// the app's outgoing map AND peerjs's own, which also holds INBOUND conns
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
					if (!d) return;
					if (d.type === 'camera' && d.peerId) ns.cam[d.peerId] = (ns.cam[d.peerId] || 0) + 1;
					if (d.__ns !== 'probe') return;
					const s = ns.rx[d.__from] || (ns.rx[d.__from] = { count: 0, maxSeq: -1 });
					s.count++;
					if (d.__seq > s.maxSeq) s.maxSeq = d.__seq;
				});
			}
			return ns.allConns().length;
		};
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
		// sends fewer messages than an earlier one cannot lower either — every section that
		// counts starts from a reset, or it passes on numbers left over from the last one.
		ns.reset = () => {
			ns.rx = {};
			ns.cam = {};
		};
		ns.blast = async (uuid, count, gapMs) => {
			ns.sendMs = [];
			for (let i = 0; i < count; i++) {
				ns.send(uuid, i);
				await new Promise((r) => setTimeout(r, gapMs));
			}
			return { sent: count, maxSendMs: Math.max(...ns.sendMs) };
		};
		// orbit the editor camera every frame for `ms`, counting our own frames — the
		// presence stream's send rate is stated against THIS number
		ns.orbit = async (ms) => {
			let controls;
			w.__stores.orbitControls.subscribe((c) => (controls = c))();
			const started = performance.now();
			let frames = 0;
			const taskFrom = ns.tasks.length;
			while (performance.now() - started < ms) {
				await new Promise((r) => requestAnimationFrame(r));
				if (controls?._rotateLeft) controls._rotateLeft(0.03);
				controls?.update?.();
				frames++;
			}
			const tasks = ns.tasks.slice(taskFrom);
			return {
				frames,
				elapsed: performance.now() - started,
				longTasks: tasks.length,
				longest: tasks.reduce((m, t) => Math.max(m, t.ms), 0)
			};
		};
		return true;
	}, peer.id);

const received = (peer, fromId) =>
	peer.page.evaluate((from) => {
		const s = window.__probe?.rx?.[from];
		return s ? { count: s.count, maxSeq: s.maxSeq } : { count: 0, maxSeq: -1 };
	}, fromId);

const openPeers = (peer) =>
	peer.page.evaluate(() => {
		let pc;
		window.__stores.peers.subscribe((p) => (pc = p))();
		return [...(pc?.openedPeers ?? [])];
	});

h.run(async () => {
	/** @type {any} */
	let browserRef = null;
	const signal = await ensureSignalServer();
	try {
		// GPU args: section 5 is a RATE claim against display frames, and a SwiftShader page
		// at ~2.5fps can never exercise a 50ms gate (the e2e skill's rule)
		const browser = (browserRef = await h.launch({ args: h.GPU_ARGS }));
		const opts = { storage: LOCAL_PEER_STORAGE, context: { viewport: { width: 800, height: 600 } } };
		const peers = [];
		for (const name of ['A', 'B', 'C', 'D']) peers.push(await h.setupPage(browser, name, opts));
		const [A, B, C, D] = peers;
		const server = await A.page.evaluate(() => {
			let s;
			window.__stores.peerServer.peerServerStatus.subscribe((v) => (s = v))();
			return s;
		});
		h.check(server?.kind === 'local', `premise: the peers signal through the LOCAL server (${JSON.stringify(server)})`);

		// ---- 1. the mesh fills -----------------------------------------------------------
		// a CONNECTED peer's pill has no dial input, so every joiner dials the HOST
		await h.connect(B, A);
		await h.connect(C, A);
		await h.connect(D, A);
		/** every ordered pair (i sees j open) */
		const pairState = async () => {
			const lists = [];
			for (const p of peers) lists.push(await openPeers(p));
			const missing = [];
			peers.forEach((p, i) =>
				peers.forEach((q, j) => {
					if (i !== j && !lists[i].includes(q.id)) missing.push(`${'ABCD'[i]}->${'ABCD'[j]}`);
				})
			);
			return missing;
		};
		await h.eventually(pairState, (m) => m.length === 0, 'all 12 ordered pairs of a four-peer mesh are open', 45000);
		const missing = await pairState();
		h.check(
			missing.length === 0,
			`the mesh is FULL — B, C and D each dialled only the host (missing: ${JSON.stringify(missing)})`
		);

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
		await h.eventually(
			() => D.page.evaluate((u) => !!window.__stores.objectsGroup && (() => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return !!g.getObjectByProperty('uuid', u); })(), uuid),
			(ok) => ok,
			'premise: the object reached the last joiner',
			15000
		);

		for (const p of peers) await installProbe(p);
		await A.page.waitForTimeout(600);

		// ---- 2. a broadcast reaches everyone, with no loss -------------------------------
		const blast = await A.page.evaluate(([u, n, gap]) => window.__probe.blast(u, n, gap), [uuid, 60, 25]);
		h.check(blast.sent === 60, `premise: the host sent 60 probe messages (${blast.sent})`);
		await A.page.waitForTimeout(1200);
		for (const p of [B, C, D]) {
			const got = await received(p, A.id);
			h.check(got.count === 60 && got.maxSeq === 59, `${p === B ? 'B' : p === C ? 'C' : 'D'} got every host message, tail included (${got.count}/60, maxSeq ${got.maxSeq})`);
		}

		// ---- 4. fan-out cost stays bounded ------------------------------------------------
		h.check(blast.maxSendMs < 250, `one broadcast's fan-out stays bounded (worst send ${blast.maxSendMs.toFixed(1)}ms across 3 conns)`);

		// ---- 3. all four at once: every ordered pair whole --------------------------------
		for (const p of peers) await p.page.evaluate(() => window.__probe.reset());
		await Promise.all(peers.map((p) => p.page.evaluate(([u, n, gap]) => window.__probe.blast(u, n, gap), [uuid, 40, 25])));
		await A.page.waitForTimeout(1800);
		let pairsWhole = 0;
		const broken = [];
		for (let i = 0; i < 4; i++) {
			for (let j = 0; j < 4; j++) {
				if (i === j) continue;
				const got = await received(peers[i], peers[j].id);
				if (got.count === 40 && got.maxSeq === 39) pairsWhole++;
				else broken.push(`${'ABCD'[j]}->${'ABCD'[i]} ${got.count}/40`);
			}
		}
		h.check(pairsWhole === 12, `under four-way load every ordered pair delivered whole (${pairsWhole}/12 ${JSON.stringify(broken)})`);

		// ---- 5. the presence stream is throttled, not per frame ---------------------------
		for (const p of peers) await p.page.evaluate(() => window.__probe.reset());
		const runs = await Promise.all(peers.map((p) => p.page.evaluate((ms) => window.__probe.orbit(ms), 3000)));
		// read at once: OrbitControls damping keeps the camera drifting (and sending) after the
		// orbit loop stops, and those messages belong to no measured frame window
		const cams = [];
		for (const p of peers) cams.push(await p.page.evaluate(() => ({ ...window.__probe.cam })));
		// the claim is only testable when a per-frame sender would EXCEED the gate: 25-C gates
		// the desktop camera at 50ms (20/s), so every peer must be drawing well above that
		h.check(
			runs.every((r) => (r.frames * 1000) / r.elapsed >= 40),
			`premise: every peer ran well above the 20/s gate while orbiting (${runs.map((r) => Math.round((r.frames * 1000) / r.elapsed)).join(', ')} fps)`
		);
		// per SENDER, as seen by every other peer, in messages per second of orbit
		const rates = [];
		let flowing = true;
		peers.forEach((sender, j) => {
			peers.forEach((_, i) => {
				if (i === j) return;
				const got = cams[i][sender.id] || 0;
				if (got < 10) flowing = false;
				rates.push(Math.round((got / (runs[j].elapsed / 1000)) * 10) / 10);
			});
		});
		h.check(flowing, `premise: the camera stream flows between every pair while orbiting (${JSON.stringify(cams.map((c) => Object.values(c)))})`);
		const worst = Math.max(...rates);
		const slowestFps = Math.min(...runs.map((r) => (r.frames * 1000) / r.elapsed));
		// 20/s plus slack for in-flight messages at the cut; a per-frame sender
		// would read at its frame rate, which the premise put at 40 or more
		h.check(
			worst <= 25 && worst < slowestFps * 0.65,
			`presence is gated, not per frame: worst ${worst} msgs/s per sender against >= ${Math.round(slowestFps)} fps (all ${JSON.stringify(rates)})`
		);

		// ---- 6. the main thread under the load --------------------------------------------
		const longest = Math.max(...runs.map((r) => r.longest));
		console.log('long tasks while four peers orbit: ' + JSON.stringify(runs.map((r) => ({ n: r.longTasks, longest: Math.round(r.longest) }))));
		h.check(longest < 1000, `no peer froze while four orbit and stream presence (longest task ${Math.round(longest)}ms)`);
	} catch (error) {
		stopSignalServer(signal);
		throw error;
	}
	// `finish` exits the process, so the server we started is stopped BEFORE it — a
	// leftover listener on the machine-wide :9001 would be reused by the next lane's run
	stopSignalServer(signal);
	await h.finish(browserRef);
});
