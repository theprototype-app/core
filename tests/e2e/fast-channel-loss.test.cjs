// 60 Q2 — THE FAST MOVEMENT CHANNEL ON A LOSSY LINK, MEASURED.
//
// Two real peers. A streams its avatar pose at 20 Hz through the app's own send path
// (`peers.send({type:'camera'…}, {fast: true})`, what Scene.svelte does); B times every pose
// the app APPLIES (the `fastChannel.setPoseTap` seam sits after the stale filter, on both
// channels) and the gaps between them give the p95. Six phases on ONE connection:
// before (A's channel switched off = every pose on the reliable conn, the pre-Q2 wire) and
// after, each at 0 / 5 / 10 % loss.
//
// THE LOSS MODEL (a WebRTC loss shim — tc netem needs root and would hit every lane on this
// box). Installed on both pages before boot, it wraps every RTCDataChannel's message delivery:
//  * every message gets a one-way delay of BASE_MS ± JITTER_MS;
//  * on an UNRELIABLE channel (maxRetransmits set) a lost message is gone;
//  * on a RELIABLE ordered channel a lost message is RETRANSMITTED RTX_MS later (doubling on a
//    repeated loss, the SCTP back-off) and every later message waits behind it — head-of-line
//    blocking, which is what SCTP's ordered delivery does with a gap.
// RTX_MS = 200 stands for SCTP's recovery on a 20 Hz stream: fast retransmit needs three later
// packets (~150 ms at 20 Hz) plus a round trip; the RTO path is slower still. A seeded PRNG per
// page, so a rerun draws the same losses.
//
// Also asserted: a reliable EDIT stream (numbered chat messages) arrives complete and in order
// in every phase; and the trailing keyframe lands A's final pose exactly after the stream stops.
// Evidence: EVIDENCE/fast-channel-loss.json + .md (table of p95 / p50 / max / received).
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const BASE_MS = 20;
const JITTER_MS = 5;
const RTX_MS = 200;
const HZ = 20;
const PHASE_MS = Number(process.env.FC_PHASE_MS || 20000);
const LOSSES = [0, 0.05, 0.1];
const EVIDENCE =
	process.env.EVIDENCE || path.join(process.env.HOME || '.', '.code/lanes-30/after-60/60-net');

/** runs in the page before any app code */
function lossShim(cfg) {
	window.__loss = {
		p: 0,
		base: cfg.base,
		jitter: cfg.jitter,
		rtx: cfg.rtx,
		lost: { fast: 0, reliable: 0 },
		msgs: { fast: 0, reliable: 0 }
	};
	let seed = cfg.seed >>> 0;
	const rand = () => {
		seed = (seed + 0x6d2b79f5) >>> 0;
		let t = seed;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const state = new WeakMap();
	/** wrap one listener so delivery follows the model */
	function wrap(dc, fn) {
		return function (event) {
			const L = window.__loss;
			const unreliable = dc.maxRetransmits !== null || dc.maxPacketLifeTime !== null;
			const kind = unreliable ? 'fast' : 'reliable';
			L.msgs[kind]++;
			let at = performance.now() + L.base + (rand() * 2 - 1) * L.jitter;
			if (L.p > 0 && rand() < L.p) {
				L.lost[kind]++;
				if (unreliable) return; // gone
				let rtx = L.rtx;
				at += rtx;
				while (rand() < L.p) {
					rtx *= 2;
					at += rtx;
				}
			}
			const self = this;
			if (unreliable) {
				setTimeout(() => fn.call(self, event), Math.max(0, at - performance.now()));
				return;
			}
			// ordered: nothing overtakes the message before it. ONE FIFO per channel drained by ONE
			// pump — a timer per message does not keep order: Chrome rounds each delay to whole ms, so
			// two messages released by the same retransmit swapped (run4: reliable@10 % applied 201 of
			// 400 poses through the stale filter, and the in-order edit check failed)
			let s = state.get(dc);
			if (!s) state.set(dc, (s = { last: 0, queue: [], timer: 0 }));
			at = Math.max(at, s.last);
			s.last = at;
			s.queue.push({ at, run: () => fn.call(self, event) });
			const pump = () => {
				s.timer = 0;
				while (s.queue.length && s.queue[0].at <= performance.now()) {
					try {
						s.queue.shift().run();
					} catch (e) {
						setTimeout(() => {
							throw e;
						});
					}
				}
				if (s.queue.length)
					s.timer = setTimeout(pump, Math.max(0, s.queue[0].at - performance.now()));
			};
			if (!s.timer) s.timer = setTimeout(pump, Math.max(0, s.queue[0].at - performance.now()));
		};
	}
	const proto = RTCDataChannel.prototype;
	const desc = Object.getOwnPropertyDescriptor(proto, 'onmessage');
	Object.defineProperty(proto, 'onmessage', {
		configurable: true,
		get() {
			return this.__onmsg ?? null;
		},
		set(fn) {
			this.__onmsg = fn;
			desc.set.call(this, typeof fn === 'function' ? wrap(this, fn) : fn);
		}
	});
	const add = proto.addEventListener;
	proto.addEventListener = function (type, fn, opts) {
		if (type === 'message' && typeof fn === 'function')
			return add.call(this, type, wrap(this, fn), opts);
		return add.call(this, type, fn, opts);
	};
}

/** @param {number[]} xs @param {number} q */
const quantile = (xs, q) => {
	if (!xs.length) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
};

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', {
		init: [lossShim, { base: BASE_MS, jitter: JITTER_MS, rtx: RTX_MS, seed: 6001 }]
	});
	const B = await h.setupPage(browser, 'B', {
		init: [lossShim, { base: BASE_MS, jitter: JITTER_MS, rtx: RTX_MS, seed: 6002 }]
	});
	await h.connect(A, B);

	// the channel opened both ways (the modules `fc` + `fastchan` hello)
	await h.eventually(
		async () => ({
			a: await A.page.evaluate((id) => window.__stores.fastChannel.isOpen(id), B.id),
			b: await B.page.evaluate((id) => window.__stores.fastChannel.isOpen(id), A.id)
		}),
		(r) => r.a && r.b,
		'the fast channel is open on both ends after the handshake'
	);
	const hasPc = await A.page.evaluate((id) => {
		let p;
		window.__stores.peers.subscribe((x) => (p = x))();
		return !!p.connections[id]?.peerConnection;
	}, B.id);
	h.check(hasPc, 'the PeerJS connection exposes its RTCPeerConnection');

	// A headless peer renders at a few fps and every frame blocks its main thread for hundreds of
	// ms — a 20 Hz timer then fires at ~1 Hz and every gap measures the RENDERER, not the wire (run2:
	// 17 sends in 20 s, p50 1.2 s). Both pages stop drawing through the app's own overload pause
	// for the measurement; the data channels, the stale filter and the keyframe timer do not draw.
	for (const peer of [A, B])
		await peer.page.evaluate(() =>
			window.__stores.overloadGuard.pauseRendering('e2e: timing the wire')
		);

	// B's tap: arrival times of A's applied camera poses, and the chat edits in arrival order
	await B.page.evaluate((aid) => {
		window.__poses = [];
		window.__stores.fastChannel.setPoseTap((peer, d, via) => {
			if (peer === aid && d.type === 'camera')
				window.__poses.push({ t: performance.now(), via, x: d.position[0], ps: d.ps });
		});
	}, A.id);

	/** one phase: set loss on both, stream for PHASE_MS, collect B's gaps */
	async function phase(mode, loss) {
		const fastOn = mode === 'after';
		for (const peer of [A, B]) await peer.page.evaluate((p) => (window.__loss.p = p), loss);
		await A.page.evaluate(
			(on) =>
				on ? localStorage.removeItem('fastChannel') : localStorage.setItem('fastChannel', 'off'),
			fastOn
		);
		await B.page.evaluate(() => (window.__poses = []));
		const tag = mode + '-' + Math.round(loss * 100);
		const sent = await A.page.evaluate(
			({ ms, hz, tag }) =>
				new Promise((resolve) => {
					let p;
					window.__stores.peers.subscribe((x) => (p = x))();
					let n = 0;
					let edits = 0;
					const t0 = performance.now();
					const timer = setInterval(() => {
						const x = n * 0.01;
						// exactly the call Scene.svelte makes for a moving camera
						p.send(
							{ type: 'camera', peerId: p.peer.id, position: [x, 1.6, 0], rotation: [0, 0, 0] },
							{ fast: true }
						);
						n++;
						// a reliable EDIT every 10th tick (2 a second), numbered
						if (n % 10 === 0) p.sendMessage('edit ' + tag + ' ' + edits++);
						if (performance.now() - t0 >= ms) {
							clearInterval(timer);
							resolve({ n, edits, lastX: (n - 1) * 0.01 });
						}
					}, 1000 / hz);
				}),
			{ ms: PHASE_MS, hz: HZ, tag }
		);
		// let retransmits drain and the trailing keyframe land: at 10 % the doubling back-off can stack past
		// a second (run3: 1.3 s max gap), so wait for the last edit AND the final pose, not a fixed time —
		// a late message would otherwise land in the NEXT phase's samples
		await B.page
			.waitForFunction(
				({ tag, edits, lastX }) => {
					let msgs = [];
					window.__stores.messages?.subscribe?.((m) => (msgs = m))();
					const n = (msgs || []).filter(
						(m) => m?.type === 'received' && String(m?.text ?? '').startsWith('edit ' + tag + ' ')
					).length;
					const last = window.__poses[window.__poses.length - 1];
					return n >= edits && !!last && Math.abs(last.x - lastX) < 1e-9;
				},
				{ tag, edits: sent.edits, lastX: sent.lastX },
				{ timeout: 10000 }
			)
			.catch(() => {});
		await B.page.waitForTimeout(300);
		const got = await B.page.evaluate((tag) => {
			let msgs = [];
			window.__stores.messages?.subscribe?.((m) => (msgs = m))();
			const edits = (msgs || [])
				.filter((m) => m?.type === 'received')
				.map((m) => String(m?.text ?? ''))
				.filter((m) => m.startsWith('edit ' + tag + ' '))
				.map((m) => Number(m.split(' ').pop()));
			return { poses: window.__poses, edits, loss: window.__loss };
		}, tag);
		const times = got.poses.map((p) => p.t);
		const gaps = times.slice(1).map((t, i) => t - times[i]);
		const viaFast = got.poses.filter((p) => p.via === 'fast').length;
		const lastX = got.poses.length ? got.poses[got.poses.length - 1].x : NaN;
		const row = {
			mode,
			loss,
			sent: sent.n,
			received: got.poses.length,
			viaFast,
			p50: Math.round(quantile(gaps, 0.5)),
			p95: Math.round(quantile(gaps, 0.95)),
			p99: Math.round(quantile(gaps, 0.99)),
			max: Math.round(Math.max(...gaps)),
			editsSent: sent.edits,
			editsInOrder: got.edits.length === sent.edits && got.edits.every((v, i) => v === i),
			finalPoseLanded: Math.abs(lastX - sent.lastX) < 1e-9
		};
		console.log(JSON.stringify(row));
		// a phase whose sender could not keep the cadence measured the page, not the channel
		h.check(
			sent.n >= (PHASE_MS / 1000) * HZ * 0.8,
			`${tag}: A kept the ${HZ} Hz cadence (${sent.n} sends in ${PHASE_MS / 1000} s)`
		);
		return row;
	}

	const rows = [];
	for (const loss of LOSSES) {
		rows.push(await phase('before', loss));
		rows.push(await phase('after', loss));
	}
	for (const peer of [A, B]) await peer.page.evaluate(() => (window.__loss.p = 0));

	for (const r of rows) {
		const name = `${r.mode} @ ${Math.round(r.loss * 100)} %`;
		h.check(r.editsInOrder, `${name}: every reliable edit arrived, in order (${r.editsSent})`);
		h.check(r.finalPoseLanded, `${name}: the final pose landed exactly (trailing keyframe)`);
		if (r.mode === 'after')
			h.check(
				r.viaFast > r.received * 0.8,
				`${name}: poses rode the fast channel (${r.viaFast}/${r.received})`
			);
		else {
			h.check(r.viaFast === 0, `${name}: the channel switched off sends every pose reliable`);
			// the shim's own control: an ORDERED channel never trips the stale filter
			h.check(
				r.received >= r.sent,
				`${name}: the ordered channel applied every pose (${r.received}/${r.sent})`
			);
		}
	}
	const at = (mode, loss) => rows.find((r) => r.mode === mode && r.loss === loss);
	h.check(
		at('after', 0.05).p95 < 150,
		`after @ 5 %: p95 pose gap < 150 ms (release bar) — ${at('after', 0.05).p95} ms`
	);
	h.check(
		at('after', 0.05).p95 < at('before', 0.05).p95,
		`5 %: fast p95 ${at('after', 0.05).p95} < reliable p95 ${at('before', 0.05).p95}`
	);
	h.check(
		at('after', 0.1).p95 < at('before', 0.1).p95,
		`10 %: fast p95 ${at('after', 0.1).p95} < reliable p95 ${at('before', 0.1).p95}`
	);

	try {
		fs.mkdirSync(EVIDENCE, { recursive: true });
		const meta = {
			at: new Date().toISOString(),
			model: { BASE_MS, JITTER_MS, RTX_MS, HZ, PHASE_MS },
			rows
		};
		fs.writeFileSync(path.join(EVIDENCE, 'fast-channel-loss.json'), JSON.stringify(meta, null, 2));
		const md = [
			'# 60 Q2 — pose gap on a lossy link (fast-channel-loss e2e)',
			'',
			`Model: one-way ${BASE_MS} ± ${JITTER_MS} ms; reliable loss = retransmit after ${RTX_MS} ms (doubling) with head-of-line blocking; fast loss = dropped. ${HZ} Hz stream, ${PHASE_MS / 1000} s per phase, gaps between APPLIED poses at the receiver.`,
			'',
			'| channel | loss | sent | applied | p50 ms | p95 ms | p99 ms | max ms | edits in order | final pose |',
			'|---|---|---|---|---|---|---|---|---|---|',
			...rows.map(
				(r) =>
					`| ${r.mode === 'after' ? 'fast (after)' : 'reliable (before)'} | ${Math.round(r.loss * 100)} % | ${r.sent} | ${r.received} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.editsInOrder ? 'yes' : 'NO'} | ${r.finalPoseLanded ? 'yes' : 'NO'} |`
			)
		];
		fs.writeFileSync(path.join(EVIDENCE, 'fast-channel-loss.md'), md.join('\n') + '\n');
	} catch (e) {
		console.log('evidence write failed: ' + e);
	}

	await h.finish(browser);
});
