// B5 — mesh network stress harness (LOCAL PeerJS ONLY).
//
//   node tests/e2e/net-stress.cjs [--peers 8,10,12,16] [--load 20] [--objects 20]
//                                 [--out docs/net-stress.md] [--hz 10] [--presence 10]
//
// NOT a .test.cjs on purpose: a full sweep runs for many minutes, well past the
// runner's per-suite timeout. `npm run e2e -- net-stress` runs the small
// REGRESSION suite (net-stress.test.cjs) instead; this file is the measurement
// rig you run by hand and paste into the plan doc.
//
// It measures, per mesh size N:
//   - join cost      — dial -> that joiner has N-1 open conns, and the scene synced
//   - one-way latency + echo RTT over a real DataConnection
//   - message loss   — sequence numbers over a synthetic mutation load
//   - fan-out cost   — wall time of one PeerConnection.send() across N-1 conns
//   - renderer FPS   — idle baseline vs under load (relative; see the caveat below)
//   - long tasks/min — main-thread blocks over 50ms per peer under the load (25-G)
//   - presence       — with --presence N, every peer orbits its camera for N seconds and
//                      each counts the `camera` messages it RECEIVES per sender: the
//                      audit-H7 stream, now rate-gated (25-C), at mesh scale (25-G)
//
// HARD RULE: local signaling server only. Pointing a 10-peer flood at the public
// or self-hosted production box is abuse, so the harness spawns its own `peer` server on
// :9001 (localSignal.cjs) and SEEDS every page with `peerServerConfig = {mode:'local'}` —
// which is what actually keeps the pages off production, whatever the app's hostname.
// The APP_URL must still resolve to this machine (a lane serves theprototype.app via
// /etc/hosts), so the dev server being flooded is our own.
//
// CAVEAT on FPS: N headless Chromium contexts each render a WebGL scene on the
// same machine, so absolute FPS says more about the host than about the protocol.
// Only the idle-vs-load DELTA at a given N is meaningful. The rig launches with
// GPU_ARGS; on a box without a GPU that silently falls back to SwiftShader.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
function arg(name, fallback) {
	const i = argv.indexOf('--' + name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const SIZES = arg('peers', '8,10,12,16')
	.split(',')
	.map((n) => parseInt(n, 10))
	.filter((n) => n >= 2);
const LOAD_SECS = parseInt(arg('load', '20'), 10);
const HZ = parseInt(arg('hz', '10'), 10);
const OBJECTS = parseInt(arg('objects', '20'), 10);
const OUT = arg('out', '');
// 25-G: seconds of continuous camera motion on every peer; 0 = skip the presence phase
const PRESENCE_SECS = parseInt(arg('presence', '0'), 10);
// --logs echoes each page's own console (peerHandler is chatty about the connect
// dance) with a ms stamp, which is the only way to see WHY a join stalls
const LOGS = argv.includes('--logs');
const ROOT = path.resolve(__dirname, '..', '..');
const T0 = Date.now();

const APP_URL = process.env.APP_URL || 'https://localhost:5185/';
process.env.APP_URL = APP_URL;
const host = new URL(APP_URL).hostname;
const h = require('./helpers.cjs');
const { SIGNAL_PORT, LOCAL_PEER_STORAGE, ensureSignalServer } = require('./localSignal.cjs');

/** Does the APP_URL host resolve to this machine? @param {string} name */
function isLoopback(name) {
	if (/^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(name)) return Promise.resolve(true);
	return new Promise((resolve) =>
		require('dns').lookup(name, { all: true }, (err, addrs) =>
			resolve(!err && addrs.length > 0 && addrs.every((a) => a.address === '127.0.0.1' || a.address === '::1'))
		)
	);
}

// ------------------------------------------------------------------- utils
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** @param {number[]} xs */
function stats(xs) {
	if (!xs.length) return { n: 0, p50: NaN, p95: NaN, max: NaN, mean: NaN };
	const s = [...xs].sort((a, b) => a - b);
	const at = (/** @type {number} */ q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
	return {
		n: s.length,
		p50: at(0.5),
		p95: at(0.95),
		max: s[s.length - 1],
		mean: s.reduce((a, b) => a + b, 0) / s.length
	};
}
/** @param {number} x @param {number} [d] */
const r = (x, d = 1) => (Number.isFinite(x) ? Number(x.toFixed(d)) : NaN);

// ----------------------------------------------------------- in-page probe
// Installed on every peer AFTER the mesh forms. Adds a SECOND 'data' listener to
// each live DataConnection (peerjs conns are EventEmitters, so the app's own
// dispatcher is untouched) and drives the load from inside the page, so the
// numbers never include CDP round-trip time.
//
// Probe messages are REAL `move` messages with a few extra `__ns*` fields: the
// app applies them exactly like a peer dragging an object, and unknown extra
// fields ride binarypack harmlessly. Never invent a new `type` — the dispatch
// chain ends in `data.startsWith('/')`, which THROWS on an unknown object type.
/** @param {any} peer */
function installProbe(peer) {
	return peer.page.evaluate((myId) => {
		const w = /** @type {any} */ (window);
		let pc;
		w.__stores.peers.subscribe((/** @type {any} */ p) => (pc = p))();
		/** @type {any} */
		const ns = (w.__ns = w.__ns || {
			myId,
			hooked: new WeakSet(),
			rx: {},
			echoRtt: [],
			sendMs: [],
			seq: 0,
			// per-type traffic accounting — ON during joins (where the interesting
			// asymmetry is), OFF under load so the sizing cost can't skew FPS
			accounting: true,
			traffic: { count: 0, bytes: 0, byType: {} },
			// 25-G: camera messages received per SENDER, and the main thread's long tasks
			cam: {},
			tasks: []
		});
		ns.pc = pc;
		if (!ns.taskObserver) {
			try {
				ns.taskObserver = new PerformanceObserver((list) => {
					for (const e of list.getEntries()) ns.tasks.push(e.startTime);
				});
				ns.taskObserver.observe({ entryTypes: ['longtask'] });
			} catch {
				ns.taskObserver = null;
			}
		}
		/** long tasks that started in the last `ms` */
		ns.tasksIn = (/** @type {number} */ ms) => ns.tasks.filter((/** @type {number} */ t) => t >= performance.now() - ms).length;
		/** orbit the editor camera every frame until stopped — the presence stream's source */
		ns.orbitStart = () => {
			let controls;
			w.__stores.orbitControls.subscribe((/** @type {any} */ c) => (controls = c))();
			ns.orbitFrames = 0;
			ns.orbiting = true;
			const tick = () => {
				if (!ns.orbiting) return;
				if (controls?._rotateLeft) controls._rotateLeft(0.03);
				controls?.update?.();
				ns.orbitFrames++;
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		};
		ns.orbitStop = () => {
			ns.orbiting = false;
			return ns.orbitFrames;
		};

		/** rough wire size; binarypack is compact but relative sizes are what matter */
		ns.sizeOf = (/** @type {any} */ d) => {
			try {
				if (d == null) return 0;
				if (typeof d === 'string') return d.length;
				if (d.byteLength) return d.byteLength;
				let n = 0;
				for (const k of Object.keys(d)) {
					const v = d[k];
					n += k.length + 2;
					if (v == null) n += 2;
					else if (typeof v === 'string') n += v.length;
					else if (typeof v === 'number' || typeof v === 'boolean') n += 8;
					else if (v.byteLength) n += v.byteLength;
					else n += JSON.stringify(v)?.length ?? 0;
				}
				return n;
			} catch {
				return 0;
			}
		};

		ns.allConns = () => {
			const seen = new Set();
			const out = [];
			const push = (/** @type {any} */ c) => {
				if (!c || typeof c.send !== 'function' || c.type !== 'data' || seen.has(c)) return;
				seen.add(c);
				out.push(c);
			};
			// the app's outgoing map AND peerjs's own map (which also holds INBOUND
			// conns — an ack may come back over one we never dialed)
			for (const k of Object.keys(pc.connections || {})) push(pc.connections[k]);
			const raw = (pc.peer && pc.peer.connections) || {};
			for (const k of Object.keys(raw)) (raw[k] || []).forEach(push);
			return out;
		};

		ns.hook = () => {
			let added = 0;
			for (const c of ns.allConns()) {
				if (ns.hooked.has(c)) continue;
				ns.hooked.add(c);
				added++;
				c.on('data', (/** @type {any} */ d) => {
					if (d && d.type === 'camera' && d.peerId) ns.cam[d.peerId] = (ns.cam[d.peerId] || 0) + 1;
					if (ns.accounting && d) {
						const t = typeof d === 'string' ? 'string' : d.type || 'unknown';
						const tr = ns.traffic;
						const e = tr.byType[t] || (tr.byType[t] = { n: 0, bytes: 0 });
						const size = ns.sizeOf(d);
						e.n++;
						e.bytes += size;
						tr.count++;
						tr.bytes += size;
					}
					if (!d || !d.__ns) return;
					const now = Date.now();
					if (d.__ns === 'probe') {
						const s = ns.rx[d.__from] || (ns.rx[d.__from] = { count: 0, maxSeq: -1, lat: [] });
						s.count++;
						if (d.__seq > s.maxSeq) s.maxSeq = d.__seq;
						s.lat.push(now - d.__t0);
					} else if (d.__ns === 'echoreq') {
						try { c.send({ ...d, __ns: 'echoack', __from: ns.myId }); } catch { /* conn died */ }
					} else if (d.__ns === 'echoack') {
						ns.echoRtt.push(now - d.__t0);
					}
				});
			}
			return { added, conns: ns.allConns().length };
		};

		/** @param {string} uuid @param {number} seq */
		ns.movePayload = (uuid, seq) => ({
			type: 'move',
			uuid,
			pos: [Math.sin(seq / 10), 0.5, Math.cos(seq / 10)],
			rot: [0, seq / 50, 0],
			scale: [1, 1, 1]
		});

		ns.fpsStart = () => {
			ns.fpsFrames = 0;
			ns.fpsT0 = performance.now();
			const tick = () => {
				ns.fpsFrames++;
				ns.fpsId = requestAnimationFrame(tick);
			};
			ns.fpsId = requestAnimationFrame(tick);
		};
		ns.fpsStop = () => {
			cancelAnimationFrame(ns.fpsId);
			const secs = (performance.now() - ns.fpsT0) / 1000;
			return secs > 0 ? ns.fpsFrames / secs : 0;
		};

		/** @param {string} uuid @param {number} hz */
		ns.startLoad = (uuid, hz) => {
			ns.seq = 0;
			ns.sendMs = [];
			ns.rx = {};
			ns.timer = setInterval(() => {
				const seq = ns.seq++;
				const payload = ns.movePayload(uuid, seq);
				payload.__ns = 'probe';
				payload.__from = ns.myId;
				payload.__seq = seq;
				payload.__t0 = Date.now();
				const t = performance.now();
				pc.send(payload); // the real broadcast: per-conn loop, no batching
				ns.sendMs.push(performance.now() - t);
			}, Math.round(1000 / hz));
		};
		ns.stopLoad = () => {
			clearInterval(ns.timer);
			return ns.seq;
		};

		/** @param {string} uuid @param {number} rounds */
		ns.echo = async (uuid, rounds) => {
			ns.echoRtt = [];
			for (let i = 0; i < rounds; i++) {
				const payload = ns.movePayload(uuid, i);
				payload.__ns = 'echoreq';
				payload.__from = ns.myId;
				payload.__t0 = Date.now();
				pc.send(payload);
				await new Promise((res) => setTimeout(res, 60));
			}
			await new Promise((res) => setTimeout(res, 500));
			return ns.echoRtt;
		};

		// conns appear over the whole join phase, so keep re-scanning until told to
		// stop — that way the joiner's own handshake traffic is accounted for too
		ns.hook();
		if (!ns.autoHook) ns.autoHook = setInterval(() => ns.hook(), 250);
		ns.stopAutoHook = () => {
			clearInterval(ns.autoHook);
			ns.autoHook = null;
		};
		return true;
	}, peer.id);
}

/** @param {any} peer */
const openCount = (peer) =>
	peer.page.evaluate(() => {
		const w = /** @type {any} */ (window);
		let pc;
		w.__stores.peers.subscribe((/** @type {any} */ p) => (pc = p))();
		return pc?.openedPeers?.size ?? 0;
	});

/** Per-peer link state: who we hold OPEN, who we hold half-dead, who we only know about. */
const linkState = (peer) =>
	peer.page.evaluate(() => {
		const w = /** @type {any} */ (window);
		let pc, roster, pending, waiting;
		w.__stores.peers.subscribe((/** @type {any} */ p) => (pc = p))();
		w.__stores.userdata.subscribe((/** @type {any} */ v) => (roster = v))();
		w.__stores.pendingApprovals.subscribe((/** @type {any} */ v) => (pending = v))();
		w.__stores.waitingForApproval.subscribe((/** @type {any} */ v) => (waiting = v))();
		const open = [];
		const stalled = [];
		for (const id of Object.keys(pc.connections || {})) {
			(pc.connections[id]?.open ? open : stalled).push(id);
		}
		return {
			me: pc.peer.id,
			open,
			stalled, // a conn object exists but never opened — the silent failure
			roster: roster.map((/** @type {any} */ u) => u[0]),
			pending: pending.map((/** @type {any} */ p) => p.peerId),
			waiting: waiting.map((/** @type {any} */ x) => x[0])
		};
	});

/** @param {any} peer */
const sceneCount = (peer) =>
	peer.page.evaluate(() => {
		const w = /** @type {any} */ (window);
		let g;
		w.__stores.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		return g?.children?.length ?? 0;
	});

/** Poll until predicate or timeout; returns elapsed ms or -1. */
async function waitFor(fn, predicate, timeout, interval = 150) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		if (predicate(await fn())) return Date.now() - t0;
		await sleep(interval);
	}
	return -1;
}

// ------------------------------------------------------------- one mesh run
/** @param {number} N */
async function runSize(N) {
	console.log('\n================ N = ' + N + ' peers ================');
	const browser = await h.launch({ args: h.GPU_ARGS });
	/** @type {any[]} */
	const peers = [];
	const row = { N, joins: [], syncs: [], meshMs: -1 };

	try {
		for (let i = 0; i < N; i++) {
			// small viewport + AO off: N software-rendered 1280x720 viewports on one
			// box pin the main thread at ~4 fps, and every latency number then just
			// measures render starvation. We want the NETWORK to be the bottleneck.
			const p = await h.setupPage(browser, 'P' + i, {
				context: { viewport: { width: 800, height: 600 } },
				storage: { viewMode: 'shaded', ...LOCAL_PEER_STORAGE }
			});
			if (LOGS) {
				const tag = 'P' + i + '/' + p.id;
				p.page.on('console', (m) => {
					const t = m.text();
					if (/connect|Connect|conn|peer|approv|restor|adopt|disconnect|lock/i.test(t))
						console.log('    [' + ((Date.now() - T0) / 1000).toFixed(1) + 's ' + tag + '] ' + t.slice(0, 200));
				});
			}
			peers.push(p);
		}
		const A = peers[0];

		// seed a scene on the host so every join carries a real full-state sync
		await A.page.evaluate((n) => {
			const w = /** @type {any} */ (window);
			for (let i = 0; i < n; i++) w.__stores.commandsHandler.sceneCommand('/create box');
		}, OBJECTS);
		await sleep(1500);
		const hostObjects = await sceneCount(A);
		console.log('host scene: ' + hostObjects + ' objects');

		// probe first, so the JOIN traffic is accounted for as well
		for (const p of peers) await installProbe(p);

		// --- joins, one at a time (each joiner meshes with everyone already in)
		const meshT0 = Date.now();
		for (let k = 1; k < N; k++) {
			const J = peers[k];
			const t0 = Date.now();
			await J.page.locator('input[placeholder="Enter peer ID to connect"]').fill(A.id);
			await J.page.getByRole('button', { name: 'Connect', exact: true }).click();
			await A.page.getByRole('button', { name: 'Approve' }).click({ timeout: 45000 });
			const meshed = await waitFor(() => openCount(J), (c) => c >= k, 60000);
			const joinMs = meshed < 0 ? -1 : Date.now() - t0;
			const synced = await waitFor(() => sceneCount(J), (c) => c >= hostObjects, 60000);
			const syncMs = synced < 0 ? -1 : Date.now() - t0;
			row.joins.push(joinMs);
			row.syncs.push(syncMs);
			console.log(
				'  peer ' + k + ' joined: conns ' + (joinMs < 0 ? 'TIMEOUT' : joinMs + 'ms') +
					', scene ' + (syncMs < 0 ? 'TIMEOUT' : syncMs + 'ms')
			);
		}
		row.meshMs = Date.now() - meshT0;

		// every peer must see N-1 open conns for the numbers below to mean anything
		const conns = [];
		for (const p of peers) conns.push(await openCount(p));
		row.conns = conns;
		row.fullMesh = conns.every((c) => c === N - 1);
		console.log('  open conns per peer: [' + conns.join(', ') + '] full mesh: ' + row.fullMesh);

		// which links are missing, and in what state each side left them
		const links = [];
		for (const p of peers) links.push(await linkState(p));
		row.links = links;
		const byId = new Map(peers.map((p, i) => [p.id, i]));
		const missing = [];
		for (let i = 0; i < N; i++) {
			for (let j = 0; j < N; j++) {
				if (i === j) continue;
				if (!links[i].open.includes(peers[j].id)) {
					missing.push(
						'P' + i + '->P' + j +
							(links[i].stalled.includes(peers[j].id)
								? ' (conn stalled, never opened)'
								: links[i].roster.includes(peers[j].id)
									? ' (in roster, never dialed)'
									: ' (unknown to it)')
					);
				}
			}
		}
		row.missingLinks = missing;
		row.pendingApprovals = links.map((l) => l.pending.length);
		if (missing.length) {
			console.log('  MISSING LINKS (' + missing.length + '): ' + missing.join(', '));
			console.log('  stray pending approvals per peer: [' + row.pendingApprovals.join(', ') + ']');
		}
		void byId;
		row.linksFormed = conns.reduce((a, b) => a + b, 0) / 2;
		row.linksWanted = (N * (N - 1)) / 2;

		await sleep(2000);

		// join-phase traffic, per peer. The LAST joiner is the interesting one: its
		// handshake asks EVERY peer it meets for the full state (getobjects/getnodes/
		// getannotations/...), so it receives N-1 copies of the same scene.
		row.joinTraffic = [];
		for (const p of peers) {
			const t = await p.page.evaluate(() => {
				window.__ns.stopAutoHook();
				window.__ns.accounting = false;
				const t = window.__ns.traffic;
				window.__ns.traffic = { count: 0, bytes: 0, byType: {} };
				return t;
			});
			row.joinTraffic.push(t);
		}
		const last = row.joinTraffic[N - 1];
		row.lastJoiner = {
			msgs: last.count,
			kb: r(last.bytes / 1024),
			objectMsgs: last.byType.object?.n ?? 0,
			objectKb: r((last.byType.object?.bytes ?? 0) / 1024)
		};
		console.log(
			'  last joiner received ' + last.count + ' msgs / ' + r(last.bytes / 1024) + ' KB during join' +
				' (of which ' + row.lastJoiner.objectMsgs + ' `object` msgs / ' + row.lastJoiner.objectKb + ' KB)'
		);

		// a shared object every peer will move (host-created, replicated to all)
		const uuid = await A.page.evaluate(() => {
			const w = /** @type {any} */ (window);
			let g;
			w.__stores.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
			return g.children[0].uuid;
		});

		// --- idle FPS baseline
		for (const p of peers) await p.page.evaluate(() => window.__ns.fpsStart());
		await sleep(5000);
		const idleFps = [];
		for (const p of peers) idleFps.push(await p.page.evaluate(() => window.__ns.fpsStop()));
		row.idleFps = idleFps;

		// --- echo RTT, host -> every peer -> host
		const rtt = await A.page.evaluate(([u, rounds]) => window.__ns.echo(u, rounds), [uuid, 30]);
		row.rtt = stats(rtt);
		console.log('  echo RTT p50 ' + r(row.rtt.p50) + 'ms  p95 ' + r(row.rtt.p95) + 'ms  (n=' + row.rtt.n + ')');

		// --- load: every peer broadcasts `move` at hz for `secs`, then a ramp to
		// find where the mesh actually starts hurting
		/**
		 * 25-G: every peer orbits its camera for `secs`, and each counts the `camera` messages
		 * it RECEIVES per sender. The rate is per sender per receiver, stated beside the
		 * sender's own frame count — a 50ms gate at 60fps is ~0.33 messages a frame.
		 * @param {number} secs
		 */
		const presencePhase = async (secs) => {
			for (const p of peers) await p.page.evaluate(() => window.__ns.hook());
			for (const p of peers) await p.page.evaluate(() => { window.__ns.cam = {}; });
			for (const p of peers) await p.page.evaluate(() => window.__ns.orbitStart());
			await sleep(secs * 1000);
			const frames = [];
			for (const p of peers) frames.push(await p.page.evaluate(() => window.__ns.orbitStop()));
			const longPerMin = [];
			for (const p of peers) longPerMin.push(await p.page.evaluate((ms) => window.__ns.tasksIn(ms), secs * 1000));
			await sleep(1000);
			/** received camera msgs/s per peer, summed over every sender */
			const receivedPerPeer = [];
			/** per sender->receiver pair, msgs per sender frame */
			const perFrame = [];
			let pairsSilent = 0;
			for (let i = 0; i < N; i++) {
				const cam = await peers[i].page.evaluate(() => ({ ...window.__ns.cam }));
				let total = 0;
				for (let j = 0; j < N; j++) {
					if (i === j) continue;
					const got = cam[peers[j].id] || 0;
					total += got;
					if (!got) pairsSilent++;
					if (frames[j]) perFrame.push(got / frames[j]);
				}
				receivedPerPeer.push(total / secs);
			}
			const out = {
				secs,
				senderFps: median(frames.map((f) => f / secs)),
				receivedPerPeerPerSec: median(receivedPerPeer),
				maxReceivedPerPeerPerSec: Math.max(...receivedPerPeer),
				msgsPerSenderFrame: stats(perFrame),
				pairsSilent,
				longTasksPerMin: median(longPerMin.map((n) => (n * 60) / secs)),
				maxLongTasksPerMin: Math.max(...longPerMin.map((n) => (n * 60) / secs))
			};
			console.log(
				'  presence: ' + r(out.receivedPerPeerPerSec) + ' camera msgs/s received per peer (max ' + r(out.maxReceivedPerPeerPerSec) + ')' +
					', ' + r(out.msgsPerSenderFrame.p50, 2) + ' msgs per sender frame, sender fps ' + r(out.senderFps) +
					', silent pairs ' + pairsSilent + ', long tasks/min ' + r(out.longTasksPerMin) + ' (max ' + r(out.maxLongTasksPerMin) + ')'
			);
			return out;
		};

		/** @param {number} hz @param {number} secs */
		const loadPhase = async (hz, secs) => {
			for (const p of peers) await p.page.evaluate(() => window.__ns.hook());
			for (const p of peers) await p.page.evaluate(() => window.__ns.fpsStart());
			for (const p of peers) await p.page.evaluate(([u, z]) => window.__ns.startLoad(u, z), [uuid, hz]);
			await sleep(secs * 1000);
			const longPerMin = [];
			for (const p of peers) longPerMin.push(await p.page.evaluate((ms) => window.__ns.tasksIn(ms), secs * 1000));
			const sent = [];
			for (const p of peers) sent.push(await p.page.evaluate(() => window.__ns.stopLoad()));
			const fps = [];
			for (const p of peers) fps.push(await p.page.evaluate(() => window.__ns.fpsStop()));
			await sleep(1500); // let the last messages land

			const sendMs = [];
			const lat = [];
			let expected = 0;
			let got = 0;
			for (let i = 0; i < N; i++) {
				const res = await peers[i].page.evaluate(() => ({
					sendMs: window.__ns.sendMs,
					rx: Object.fromEntries(
						Object.entries(window.__ns.rx).map(([k, v]) => [
							k,
							{ count: v.count, maxSeq: v.maxSeq, lat: v.lat }
						])
					)
				}));
				sendMs.push(...res.sendMs);
				// PAIR-COMPLETE: every ordered pair is expected to deliver. Counting
				// only the pairs that have an rx entry would score a mesh that never
				// finished connecting as 0% loss — the link that was never built is
				// exactly the loss a user feels.
				for (let j = 0; j < N; j++) {
					if (i === j) continue;
					expected += sent[j];
					const s = res.rx[peers[j].id];
					if (!s) continue;
					got += s.count;
					lat.push(...s.lat);
				}
			}
			const out = {
				hz,
				secs,
				// what each peer MEANT to emit vs what the timer actually managed —
				// a shortfall means the page couldn't keep up with its own send rate
				sentPerPeer: median(sent),
				wantedPerPeer: hz * secs,
				sendMs: stats(sendMs),
				oneWay: stats(lat),
				fps: median(fps),
				longTasksPerMin: median(longPerMin.map((n) => (n * 60) / secs)),
				msgs: { expected, got, lossPct: expected ? (100 * (expected - got)) / expected : 0 },
				meshMsgsPerSec: hz * N * (N - 1)
			};
			console.log(
				'  ' + String(hz).padStart(3) + ' Hz/peer (' + String(out.meshMsgsPerSec).padStart(4) + ' msgs/s mesh): ' +
					'delivered ' + got + '/' + expected + ' loss ' + r(out.msgs.lossPct, 2) + '%' +
					'  one-way p50/p95 ' + r(out.oneWay.p50) + '/' + r(out.oneWay.p95) + 'ms' +
					'  send() p95 ' + r(out.sendMs.p95, 2) + 'ms' +
					'  fps ' + r(out.fps) +
					'  emitted ' + r(out.sentPerPeer, 0) + '/' + out.wantedPerPeer
			);
			return out;
		};

		row.steady = await loadPhase(HZ, LOAD_SECS);
		if (PRESENCE_SECS > 0) row.presence = await presencePhase(PRESENCE_SECS);
		row.ramp = [];
		for (const hz of [30, 60, 120]) row.ramp.push(await loadPhase(hz, 8));

		// keep the top-level fields the report table reads
		row.sendMs = row.steady.sendMs;
		row.oneWay = row.steady.oneWay;
		row.msgs = row.steady.msgs;
		row.rate = { perPeerHz: HZ, meshMsgsPerSec: row.steady.meshMsgsPerSec };
		row.loadFps = [row.steady.fps];
		console.log('  FPS idle ' + r(median(idleFps)) + ' -> load ' + r(row.steady.fps) + ' (median across peers)');
	} finally {
		await browser.close();
	}
	return row;
}

/** @param {number[]} xs */
function median(xs) {
	return stats(xs).p50;
}

// ------------------------------------------------------------------ report
/** @param {any[]} rows */
function report(rows) {
	const lines = [];
	lines.push('# B5 — mesh network stress, measured');
	lines.push('');
	lines.push('Local PeerJS server (`peer` on :' + SIGNAL_PORT + '), all peers on one machine,');
	lines.push('headless Chromium (SwiftShader). Load = every peer broadcasting a `move` at ' + HZ + ' Hz');
	lines.push('for ' + LOAD_SECS + 's; host scene = ' + OBJECTS + ' objects.');
	lines.push('');
	lines.push('| N | full mesh | join p50 (ms) | scene sync p50 (ms) | echo RTT p50/p95 | one-way p50/p95 | send() p50/p95/max | mesh msgs/s | loss | FPS idle -> load |');
	lines.push('|---|---|---|---|---|---|---|---|---|---|');
	for (const w of rows) {
		lines.push(
			'| ' + w.N +
				' | ' + (w.fullMesh ? 'yes' : 'NO ' + JSON.stringify(w.conns)) +
				' | ' + r(median(w.joins)) +
				' | ' + r(median(w.syncs)) +
				' | ' + r(w.rtt.p50) + ' / ' + r(w.rtt.p95) +
				' | ' + r(w.oneWay.p50) + ' / ' + r(w.oneWay.p95) +
				' | ' + r(w.sendMs.p50, 2) + ' / ' + r(w.sendMs.p95, 2) + ' / ' + r(w.sendMs.max, 2) +
				' | ' + w.rate.meshMsgsPerSec +
				' | ' + r(w.msgs.lossPct, 2) + '%' +
				' | ' + r(median(w.idleFps)) + ' -> ' + r(median(w.loadFps)) +
				' |'
		);
	}
	lines.push('');
	lines.push('## Join cost of the LAST joiner (it asks every peer it meets for full state)');
	lines.push('');
	lines.push('| N | msgs received | KB | `object` msgs | `object` KB |');
	lines.push('|---|---|---|---|---|');
	for (const w of rows) {
		const l = w.lastJoiner || {};
		lines.push('| ' + w.N + ' | ' + l.msgs + ' | ' + l.kb + ' | ' + l.objectMsgs + ' | ' + l.objectKb + ' |');
	}
	lines.push('');
	lines.push('## Load ramp (8s per step; "emitted" = what the send timer actually managed)');
	lines.push('');
	lines.push('| N | Hz/peer | mesh msgs/s | loss | one-way p50/p95 | send() p95 | fps | long tasks/min | emitted/wanted |');
	lines.push('|---|---|---|---|---|---|---|---|---|');
	for (const w of rows) {
		for (const s of [w.steady, ...(w.ramp || [])]) {
			if (!s) continue;
			lines.push(
				'| ' + w.N + ' | ' + s.hz + ' | ' + s.meshMsgsPerSec + ' | ' + r(s.msgs.lossPct, 2) + '%' +
					' | ' + r(s.oneWay.p50) + ' / ' + r(s.oneWay.p95) +
					' | ' + r(s.sendMs.p95, 2) +
					' | ' + r(s.fps) +
					' | ' + r(s.longTasksPerMin) +
					' | ' + r(s.sentPerPeer, 0) + '/' + s.wantedPerPeer + ' |'
			);
		}
	}
	if (rows.some((w) => w.presence)) {
		lines.push('');
		lines.push('## Presence (25-G): every peer orbiting for ' + PRESENCE_SECS + 's');
		lines.push('');
		lines.push('| N | sender fps | camera msgs/s received per peer (median / max) | msgs per sender frame p50/max | silent pairs | long tasks/min (median / max) |');
		lines.push('|---|---|---|---|---|---|');
		for (const w of rows) {
			const p = w.presence;
			if (!p) continue;
			lines.push(
				'| ' + w.N + ' | ' + r(p.senderFps) +
					' | ' + r(p.receivedPerPeerPerSec) + ' / ' + r(p.maxReceivedPerPeerPerSec) +
					' | ' + r(p.msgsPerSenderFrame.p50, 2) + ' / ' + r(p.msgsPerSenderFrame.max, 2) +
					' | ' + p.pairsSilent +
					' | ' + r(p.longTasksPerMin) + ' / ' + r(p.maxLongTasksPerMin) + ' |'
			);
		}
	}
	lines.push('');
	lines.push('```json');
	lines.push(JSON.stringify(rows, null, 1));
	lines.push('```');
	return lines.join('\n');
}

// -------------------------------------------------------------------- main
(async () => {
	let server = null;
	try {
		if (!(await isLoopback(host))) {
			console.error(
				'REFUSING to run: APP_URL host "' + host + '" does not resolve to this machine.\n' +
					'The rig floods its dev server and must only ever point at a LOCAL one. See the file header.'
			);
			process.exit(2);
		}
		server = await ensureSignalServer();
		console.log('app: ' + APP_URL + '   signaling: https://localhost:' + SIGNAL_PORT);
		const rows = [];
		for (const N of SIZES) rows.push(await runSize(N));
		const md = report(rows);
		console.log('\n' + md.split('```json')[0]);
		if (OUT) {
			const out = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
			fs.mkdirSync(path.dirname(out), { recursive: true });
			fs.writeFileSync(out, md);
			console.log('findings written to ' + out);
		}
	} catch (err) {
		console.error('STRESS RUN FAILED:', err && err.stack ? err.stack : err);
		process.exitCode = 1;
	} finally {
		if (server) try { server.kill(); } catch { /* already gone */ }
	}
})();
