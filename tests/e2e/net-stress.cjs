// B5 — mesh network stress harness (LOCAL PeerJS ONLY).
//
//   node tests/e2e/net-stress.cjs [--peers 4,6,8,10] [--load 20] [--objects 20]
//                                 [--out docs/net-stress.md] [--hz 10]
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
//
// HARD RULE: local signaling server only. Pointing a 10-peer flood at the public
// or self-hosted production box is abuse, so the harness refuses any APP_URL that
// isn't localhost and spawns its own `peer` server on :9001 (the same one the
// .vscode "peerjs" task starts).
//
// CAVEAT on FPS: N headless Chromium contexts each render a WebGL scene on the
// same machine (SwiftShader, no GPU), so absolute FPS says more about the host
// than about the protocol. Only the idle-vs-load DELTA at a given N is meaningful.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
function arg(name, fallback) {
	const i = argv.indexOf('--' + name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const SIZES = arg('peers', '4,6,8,10')
	.split(',')
	.map((n) => parseInt(n, 10))
	.filter((n) => n >= 2);
const LOAD_SECS = parseInt(arg('load', '20'), 10);
const HZ = parseInt(arg('hz', '10'), 10);
const OBJECTS = parseInt(arg('objects', '20'), 10);
const OUT = arg('out', '');
// --logs echoes each page's own console (peerHandler is chatty about the connect
// dance) with a ms stamp, which is the only way to see WHY a join stalls
const LOGS = argv.includes('--logs');
const ROOT = path.resolve(__dirname, '..', '..');
const T0 = Date.now();

const APP_URL = process.env.APP_URL || 'https://localhost:5185/';
process.env.APP_URL = APP_URL;
const host = new URL(APP_URL).hostname;
if (!/^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(host)) {
	console.error(
		'REFUSING to run: APP_URL host is "' + host + '".\n' +
			'The stress harness floods the signaling server and must only ever point at a\n' +
			'LOCAL dev server (which routes PeerJS to localhost:9001). See the file header.'
	);
	process.exit(2);
}

const h = require('./helpers.cjs');

// ------------------------------------------------------- local peerjs server
const SIGNAL_PORT = 9001;

function signalUp() {
	return new Promise((resolve) => {
		const req = https.get(
			{ host: 'localhost', port: SIGNAL_PORT, path: '/', rejectUnauthorized: false, timeout: 1500 },
			(res) => {
				res.resume();
				resolve(res.statusCode === 200);
			}
		);
		req.on('error', () => resolve(false));
		req.on('timeout', () => { req.destroy(); resolve(false); });
	});
}

async function ensureSignalServer() {
	if (await signalUp()) return null;
	const bin = path.join(ROOT, 'node_modules', 'peer', 'dist', 'bin', 'peerjs.js');
	const key = path.join(ROOT, 'certs', 'localhost.key');
	const crt = path.join(ROOT, 'certs', 'localhost.crt');
	if (!fs.existsSync(bin)) throw new Error('the `peer` devDependency is missing — run npm ci');
	if (!fs.existsSync(key)) throw new Error('certs/localhost.key missing — run npm run certs');
	console.log('starting local PeerJS server on :' + SIGNAL_PORT);
	const child = spawn(process.execPath, [bin, '--port', String(SIGNAL_PORT), '--sslkey', key, '--sslcert', crt], {
		cwd: ROOT,
		stdio: 'ignore'
	});
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		if (await signalUp()) return child;
	}
	try { child.kill(); } catch { /* already gone */ }
	throw new Error('local PeerJS server did not come up on :' + SIGNAL_PORT);
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
			traffic: { count: 0, bytes: 0, byType: {} }
		});
		ns.pc = pc;

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
				storage: { viewMode: 'shaded' }
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
		/** @param {number} hz @param {number} secs */
		const loadPhase = async (hz, secs) => {
			for (const p of peers) await p.page.evaluate(() => window.__ns.hook());
			for (const p of peers) await p.page.evaluate(() => window.__ns.fpsStart());
			for (const p of peers) await p.page.evaluate(([u, z]) => window.__ns.startLoad(u, z), [uuid, hz]);
			await sleep(secs * 1000);
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
	lines.push('| N | Hz/peer | mesh msgs/s | loss | one-way p50/p95 | send() p95 | fps | emitted/wanted |');
	lines.push('|---|---|---|---|---|---|---|---|');
	for (const w of rows) {
		for (const s of [w.steady, ...(w.ramp || [])]) {
			if (!s) continue;
			lines.push(
				'| ' + w.N + ' | ' + s.hz + ' | ' + s.meshMsgsPerSec + ' | ' + r(s.msgs.lossPct, 2) + '%' +
					' | ' + r(s.oneWay.p50) + ' / ' + r(s.oneWay.p95) +
					' | ' + r(s.sendMs.p95, 2) +
					' | ' + r(s.fps) +
					' | ' + r(s.sentPerPeer, 0) + '/' + s.wantedPerPeer + ' |'
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
