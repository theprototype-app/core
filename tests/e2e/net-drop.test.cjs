// test-health-1 (plans review #29, done/b5-network-stress.md's device smoke): A 5 s CONNECTION DROP
// MUST NOT TEAR A TWO-PEER SESSION DOWN — no "disconnected" toast, the peer stays in the roster with
// its locks, and what was edited during the drop arrives afterwards.
//
// What a real wifi drop does to a Chromium tab, and how each part is reproduced headless (tc netem
// needs root and would hit every lane on this box):
//  * the signaling WebSocket dies (ERR_NETWORK_CHANGED) and nothing new can be fetched until the
//    network is back — `context.setOffline(true)` on both pages, and the socket closed by hand
//    (offline emulation leaves an OPEN socket alone);
//  * the data channels go silent — a page shim HOLDS every message it would deliver and releases
//    them in order when the drop ends (SCTP retransmits what it buffered once the path is back);
//  * ICE reports `disconnected` after its consent checks fail, and `connected` again after —
//    the shim reports both on every RTCPeerConnection.
// Two shapes, both DROP_MS long (default 5000):
//  1. QUIET: all of the above. The same conn should simply carry on.
//  2. HARD (a network CHANGE): the same, plus the peer connection is closed outright at the start, so
//     the B5 reconnect window has to redial — through a signaling server it cannot reach until the
//     drop ends. The window is ~15.5 s (checks at 0.5/1/2/4/8 s), so a 5 s drop must fit inside it.
// Counterfactual: NETDROP_MS=20000 outlasts the window — phase 2 goes red (teardown + toast; measured
// e2e/v10cf). Phase 1 stays green at 20 s, by design: a QUIET drop never breaks the data channel, so it
// proves the conn carries on, not the window's length.
const h = require('./helpers.cjs');

const DROP_MS = Number(process.env.NETDROP_MS || 5000);

/** runs in the page before any app code: the hold switch + fake ICE state */
function dropShim() {
	const D = (window.__drop = { holding: false, queue: /** @type {Function[]} */ ([]), pcs: /** @type {RTCPeerConnection[]} */ ([]), held: 0 });
	const wrap = (/** @type {Function} */ fn) =>
		function (/** @type {any} */ event) {
			// @ts-ignore
			const self = this;
			if (D.holding) {
				D.held++;
				D.queue.push(() => fn.call(self, event));
				return;
			}
			return fn.call(self, event);
		};
	const proto = RTCDataChannel.prototype;
	const desc = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(proto, 'onmessage'));
	Object.defineProperty(proto, 'onmessage', {
		configurable: true,
		get() {
			return this.__onmsg ?? null;
		},
		set(fn) {
			this.__onmsg = fn;
			desc.set?.call(this, typeof fn === 'function' ? wrap(fn) : fn);
		}
	});
	const add = proto.addEventListener;
	proto.addEventListener = function (/** @type {string} */ type, /** @type {any} */ fn, /** @type {any} */ opts) {
		return add.call(this, type, type === 'message' && typeof fn === 'function' ? wrap(fn) : fn, opts);
	};
	// the signaling server stays unreachable for the whole drop: offline emulation alone let peerjs's
	// own reconnect back in mid-drop (A was on the server again at 2.8 s), so a socket opened while
	// the drop holds goes nowhere
	const RealWS = window.WebSocket;
	// @ts-ignore
	window.WebSocket = function (/** @type {string} */ url, /** @type {any} */ protocols) {
		return new RealWS(D.holding ? 'wss://127.0.0.1:9/' : url, protocols);
	};
	window.WebSocket.prototype = RealWS.prototype;
	Object.setPrototypeOf(window.WebSocket, RealWS);
	const Real = window.RTCPeerConnection;
	// @ts-ignore
	window.RTCPeerConnection = function (/** @type {any[]} */ ...args) {
		const pc = new Real(...args);
		D.pcs.push(pc);
		return pc;
	};
	window.RTCPeerConnection.prototype = Real.prototype;
	Object.setPrototypeOf(window.RTCPeerConnection, Real);
	/** @param {'disconnected' | null} state null = the real one again */
	// @ts-ignore
	D.ice = (state) => {
		for (const pc of D.pcs) {
			if (pc.signalingState === 'closed') continue;
			if (state) Object.defineProperty(pc, 'iceConnectionState', { configurable: true, get: () => state });
			// @ts-ignore
			else delete pc.iceConnectionState;
			pc.dispatchEvent(new Event('iceconnectionstatechange'));
			// @ts-ignore
			pc.oniceconnectionstatechange?.(new Event('iceconnectionstatechange'));
		}
	};
	// @ts-ignore
	D.release = () => {
		D.holding = false;
		for (const run of D.queue.splice(0)) {
			try {
				run();
			} catch (e) {
				setTimeout(() => {
					throw e;
				});
			}
		}
	};
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { init: dropShim });
	const B = await h.setupPage(browser, 'B', { init: dropShim });
	await h.connect(B, A);

	const store = (/** @type {any} */ p, /** @type {string} */ name) =>
		p.page.evaluate((/** @type {string} */ n) => new Promise((r) => window.__stores[n].subscribe((/** @type {any} */ v) => r(v))()), name);
	const inRoster = async (/** @type {any} */ p, /** @type {string} */ id) => (await store(p, 'userdata')).some((/** @type {any} */ u) => u[0] === id);
	const openTo = (/** @type {any} */ p, /** @type {string} */ id) =>
		p.page.evaluate((/** @type {string} */ pid) => {
			/** @type {any} */ let pc;
			window.__stores.peers.subscribe((/** @type {any} */ v) => (pc = v))();
			return !!pc.connections[pid]?.open && pc.openedPeers.has(pid);
		}, id);
	const create = (/** @type {any} */ p, /** @type {string} */ shape) =>
		p.page.evaluate((/** @type {string} */ s) => {
			window.__stores.commandsHandler.sceneCommand('/create ' + s);
			/** @type {any} */ let g;
			window.__stores.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
			return g.children[g.children.length - 1].uuid;
		}, shape);
	const has = (/** @type {any} */ p, /** @type {string} */ uuid) =>
		p.page.evaluate((/** @type {string} */ u) => {
			/** @type {any} */ let g;
			window.__stores.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
			return !!g?.getObjectByProperty('uuid', u);
		}, uuid);
	const disconnectToasts = async (/** @type {any} */ p, /** @type {number} */ from) =>
		(await store(p, 'notifications')).slice(from).filter((/** @type {any} */ n) => /disconnected/.test(String(n.text))).length;
	const signalingUp = (/** @type {any} */ p) =>
		p.page.evaluate(() => {
			/** @type {any} */ let pc;
			window.__stores.peers.subscribe((/** @type {any} */ v) => (pc = v))();
			return !!pc.peer && !pc.peer.disconnected && pc.peer.open !== false;
		});

	await h.eventually(() => openTo(A, B.id), (v) => v, 'premise: A holds an open conn to B');
	await h.eventually(() => openTo(B, A.id), (v) => v, 'premise: B holds an open conn to A');
	// a created object is selected = locked by its creator; B always holds one from here on (each
	// create moves it), and a teardown releases every lock of the departed peer
	const bLocks = async () => (await store(A, 'lockedObjects')).filter((/** @type {any} */ x) => x[0] === B.id).length;
	const lockBox = await create(B, 'box');
	await h.eventually(() => store(A, 'lockedObjects'), (l) => l.some((/** @type {any} */ x) => x[0] === B.id && x[1] === lockBox), "premise: A sees B's lock");

	/** @param {'quiet' | 'hard'} shape */
	async function drop(shape) {
		const tag = shape.toUpperCase() + ` ${DROP_MS / 1000}s drop:`;
		const toastsA = (await store(A, 'notifications')).length;
		const toastsB = (await store(B, 'notifications')).length;
		// mark the conns, to tell "the same conn carried on" from "a redial healed it"
		for (const [p, other] of [[A, B.id], [B, A.id]]) {
			await p.page.evaluate((/** @type {string} */ id) => {
				/** @type {any} */ let pc;
				window.__stores.peers.subscribe((/** @type {any} */ v) => (pc = v))();
				pc.connections[id].__th1 = 'before';
			}, other);
		}
		// ---- the network goes away
		for (const p of [A, B]) await p.page.context().setOffline(true);
		for (const p of [A, B]) {
			await p.page.evaluate(() => {
				/** @type {any} */ let pc;
				window.__stores.peers.subscribe((/** @type {any} */ v) => (pc = v))();
				// @ts-ignore
				window.__drop.holding = true;
				// @ts-ignore
				window.__drop.ice('disconnected');
				try {
					pc.peer._socket._socket?.close();
				} catch {}
			});
		}
		// the premise is read AT THE CUT: whether peerjs's own reconnect later slips past the shim (it did,
		// now and then) is the app recovering, not the drop failing to happen
		let cut = false;
		for (const t = Date.now(); !cut && Date.now() - t < 3000; await A.page.waitForTimeout(150))
			cut = !(await signalingUp(A)) && !(await signalingUp(B)); // peerjs marks itself down on the socket's close event
		if (shape === 'hard') {
			await A.page.evaluate((/** @type {string} */ id) => {
				/** @type {any} */ let pc;
				window.__stores.peers.subscribe((/** @type {any} */ v) => (pc = v))();
				pc.connections[id].peerConnection?.close();
			}, B.id);
		}
		const t0 = Date.now();
		/** @type {string[]} */
		const lost = [];
		/** what each side's reconnect window is doing, printed if the heal fails @type {string[]} */
		const timeline = [];
		const state = (/** @type {any} */ p, /** @type {string} */ id) =>
			p.page
				.evaluate((/** @type {string} */ pid) => {
					/** @type {any} */ let pc;
					window.__stores.peers.subscribe((/** @type {any} */ v) => (pc = v))();
					const c = pc.connections[pid];
					const age = (/** @type {any} */ x) => (x?.__dialedAt ? Math.round((Date.now() - x.__dialedAt) / 100) / 10 + 's' : '-');
					return `sig=${pc.peer?.open ? 1 : 0} rec=${pc.reconnecting.get(pid) ?? '-'} conn=${c ? (c.open ? 'open' : 'neg ' + age(c)) : 'none'} in=${pc.inboundDials?.has(pid) ? 'neg ' + age(pc.inboundDials.get(pid)) : '-'} opened=${pc.openedPeers.has(pid) ? 1 : 0}`;
				}, id)
				.catch((/** @type {any} */ e) => 'err ' + String(e?.message ?? e).slice(0, 60));
		const watch = async () => {
			timeline.push(`${((Date.now() - t0) / 1000).toFixed(1)}s A[${await state(A, B.id)}] B[${await state(B, A.id)}]`);
			if (!(await inRoster(A, B.id))) lost.push(`A lost B at ${Date.now() - t0}ms`);
			if (!(await inRoster(B, A.id))) lost.push(`B lost A at ${Date.now() - t0}ms`);
			if ((await bLocks()) === 0) lost.push(`A dropped B's lock at ${Date.now() - t0}ms`);
		};
		// an edit on each side DURING the drop
		await A.page.waitForTimeout(Math.min(1500, DROP_MS / 3));
		const duringA = await create(A, 'sphere');
		const duringB = await create(B, 'cylinder');
		while (Date.now() - t0 < DROP_MS) {
			await watch();
			await A.page.waitForTimeout(500);
		}
		h.check(cut, `${tag} premise: the signaling link really was down on both pages (at the cut)`);
		// ---- the network comes back: lift the shim's hold FIRST, so the app's own `online` retry
		// (fired by setOffline(false)) reaches the real server rather than the held-down socket
		for (const p of [A, B]) {
			await p.page.evaluate(() => {
				// @ts-ignore
				window.__drop.ice(null);
				// @ts-ignore
				window.__drop.release();
			});
		}
		for (const p of [A, B]) await p.page.context().setOffline(false);
		// watch the roster through the rest of the reconnect window: ~15.5 s from the drop's start, plus
		// the up-to-20 s its last check gives a dial still negotiating (VERDICT_GRACE_MS)
		const healed = { a: false, b: false };
		while (Date.now() - t0 < Math.max(DROP_MS, 0) + 37000) {
			await watch();
			healed.a ||= await openTo(A, B.id);
			healed.b ||= await openTo(B, A.id);
			if (healed.a && healed.b && Date.now() - t0 > 16000) break;
			await A.page.waitForTimeout(500);
		}
		h.check(lost.length === 0, `${tag} each peer kept the other in its roster, and B's lock stood, throughout (${lost.slice(0, 2).join(', ') || 'never lost'})`);
		const healedBoth = (await openTo(A, B.id)) && (await openTo(B, A.id));
		if (!healedBoth) console.log(`  ${tag} timeline (A=${A.id} B=${B.id}; the lower id dials):\n    ` + timeline.join('\n    '));
		h.check(healedBoth, `${tag} the conn is open both ways again`);
		h.check((await disconnectToasts(A, toastsA)) === 0 && (await disconnectToasts(B, toastsB)) === 0, `${tag} no "disconnected" toast on either side`);
		await h.eventually(() => has(B, duringA), (v) => v, `${tag} A's edit made during the drop reaches B`, 15000);
		await h.eventually(() => has(A, duringB), (v) => v, `${tag} B's edit made during the drop reaches A`, 15000);
		const afterB = await create(B, 'cone');
		await h.eventually(() => has(A, afterB), (v) => v, `${tag} an edit after the drop replicates`, 10000);
		await h.eventually(async () => (await signalingUp(A)) && (await signalingUp(B)), (v) => v, `${tag} both pages are back on the signaling server`, 20000);
		const same = await A.page.evaluate((/** @type {string} */ id) => {
			/** @type {any} */ let pc;
			window.__stores.peers.subscribe((/** @type {any} */ v) => (pc = v))();
			return pc.connections[id]?.__th1 === 'before';
		}, B.id);
		if (shape === 'quiet') h.check(same, `${tag} the SAME conn carried on (no redial was needed)`);
		else h.check(!same, `${tag} premise: the conn really was replaced by the reconnect window`);
	}

	await drop('quiet');
	await drop('hard');
	await h.finish(browser);
});
