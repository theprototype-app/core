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
//  1. QUIET: all of the above. Under ICE_DROP_GRACE_MS the same conn simply carries on; past it
//     (the 5 s default) fix-live F-3 closes the silent link and the reconnect window redials it.
//  2. HARD (a network CHANGE): the same, plus the peer connection is closed outright at the start, so
//     the B5 reconnect window has to redial — through a signaling server it cannot reach until the
//     drop ends. The window is ~15.5 s (checks at 0.5/1/2/4/8 s), so a 5 s drop must fit inside it.
//  3. QUIET with the signaling server back NETDROP_SIG_LAG_MS (25 s) after the network (54-net: what a
//     loaded box did on a deployed build) — the window holds on our own signaling link until a redial
//     could have happened, so the session survives a heal that starts late. 0 skips the phase.
// net-drop-1 (deployed builds): with a cloud ROLES plugin loaded — every Pages deploy, or a dev server run
// with E2E_CLOUD_PLUGIN=https://theprototype.pages.dev/cloud-plugin.js — the joiner came back from the heal
// a VIEWER and its edits never left it: peerjs nulls `peer.id` while the signaling socket is down, the
// plugin read "no id, one peer" as alone and wiped its role map. Two checks hold the fix
// (peerDrop.keepPeerId): the own id at the cut (no plugin needed; red on v1.44.0) and roles unchanged by
// the heal (with a plugin; B read viewer on v1.44.0 + the production plugin, 4 B -> A checks red).
// Counterfactual: NETDROP_MS=20000 outlasts the window — phase 2 goes red (teardown + toast; measured
// e2e/v10cf). Phase 1 stays green at 20 s, by design: a QUIET drop never breaks the data channel, so it
// proves the conn carries on, not the window's length.
const h = require('./helpers.cjs');

const DROP_MS = Number(process.env.NETDROP_MS || 5000);
/** net-drop-1: print the wire trace for every phase, not only a failing one */
const TRACE = !!process.env.NETDROP_TRACE;
/** src/lib/peerDrop.js ICE_DROP_GRACE_MS */
const ICE_DROP_GRACE_MS = 4000;
/** 54-net: phase 3 keeps the signaling server unreachable this long after the network is back */
const SIG_LAG_MS = Number(process.env.NETDROP_SIG_LAG_MS ?? 25000);

/** runs in the page before any app code: the hold switch + fake ICE state + the WIRE TRACE (net-drop-1:
 * every peer connection's real ICE/connection state, every data channel's open/close and its sent /
 * delivered / held message counts by label — a peerjs channel's label is its conn's connectionId, so
 * "which conn does each send use, and does anything read it" is answerable on a deployed build) */
function dropShim() {
	const D = (window.__drop = {
		holding: false,
		/** 54-net: the signaling server stays unreachable while this is set (outlives `holding` in the
		 * slow-signaling phase) */
		sigHolding: false,
		queue: /** @type {Function[]} */ ([]),
		pcs: /** @type {RTCPeerConnection[]} */ ([]),
		held: 0,
		log: /** @type {string[]} */ ([]),
		/** label -> {pc, sent, recv, held, state} */
		dcs: /** @type {Record<string, any>} */ ({})
	});
	const realIce = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'iceConnectionState')?.get;
	// @ts-ignore
	D.note = (/** @type {string} */ what) => {
		D.log.push(new Date().toISOString().slice(14, 23) + ' ' + what);
		if (D.log.length > 600) D.log.splice(0, 100);
	};
	const dcRow = (/** @type {any} */ dc) => (D.dcs[dc.label] ??= { pc: dc.__pc ?? '?', sent: 0, recv: 0, held: 0, state: 'new' });
	const send = RTCDataChannel.prototype.send;
	RTCDataChannel.prototype.send = function (/** @type {any} */ data) {
		const row = dcRow(this);
		row.sent++;
		if (this.readyState !== 'open') D.note(`SEND on ${this.label} (pc${row.pc}) while ${this.readyState}`);
		return send.call(this, data);
	};
	const watchDc = (/** @type {any} */ dc, /** @type {number} */ n, /** @type {string} */ how) => {
		dc.__pc = n;
		const row = dcRow(dc);
		row.pc = n;
		D.note(`dc ${dc.label} ${how} on pc${n} (${dc.readyState})`);
		for (const ev of ['open', 'close', 'closing', 'error'])
			dc.addEventListener(ev, () => {
				row.state = ev;
				D.note(`dc ${dc.label} pc${n} ${ev} sent=${row.sent} recv=${row.recv} held=${row.held}`);
			});
	};
	const wrap = (/** @type {Function} */ fn) =>
		function (/** @type {any} */ event) {
			// @ts-ignore
			const self = this;
			const row = dcRow(self);
			if (D.holding) {
				D.held++;
				row.held++;
				D.queue.push(() => {
					row.recv++;
					return fn.call(self, event);
				});
				return;
			}
			row.recv++;
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
		return new RealWS(D.holding || D.sigHolding ? 'wss://127.0.0.1:9/' : url, protocols);
	};
	window.WebSocket.prototype = RealWS.prototype;
	Object.setPrototypeOf(window.WebSocket, RealWS);
	const Real = window.RTCPeerConnection;
	// @ts-ignore
	window.RTCPeerConnection = function (/** @type {any[]} */ ...args) {
		const pc = new Real(...args);
		const n = D.pcs.push(pc) - 1;
		const policy = args[0]?.iceTransportPolicy ?? 'all';
		const servers = (args[0]?.iceServers ?? []).map((/** @type {any} */ s) => [].concat(s.urls).map((u) => String(u).split(':')[0]).join('+')).join(',');
		D.note(`pc${n} new policy=${policy} servers=${servers || '-'}`);
		const cdc = pc.createDataChannel.bind(pc);
		pc.createDataChannel = (/** @type {any[]} */ ...a) => {
			// @ts-ignore
			const dc = cdc(...a);
			watchDc(dc, n, 'created');
			return dc;
		};
		pc.addEventListener('datachannel', (e) => watchDc(e.channel, n, 'inbound'));
		pc.addEventListener('iceconnectionstatechange', () => D.note(`pc${n} ice=${realIce?.call(pc)}${D.holding ? ' (held)' : ''}`));
		pc.addEventListener('connectionstatechange', () => D.note(`pc${n} conn=${pc.connectionState}`));
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
	/** where an object stands on its creator: local-only (the viewer gate), and the creator's role */
	const made = (/** @type {any} */ p, /** @type {string} */ uuid) =>
		p.page.evaluate((/** @type {string} */ u) => {
			/** @type {any} */ let g;
			window.__stores.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
			/** @type {any} */ let r;
			window.__stores.cloudHooks?.rolesInfo?.subscribe((/** @type {any} */ v) => (r = v))();
			const o = g?.getObjectByProperty('uuid', u);
			return `exists=${!!o} localOnly=${!!o?.userData?.__localOnly} role=${r ? r.myRole : '-'}`;
		}, uuid);
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
	// net-drop-1: B -> A worked BEFORE any drop (on a deployed build the lock alone, a protocol-floor
	// message, could not tell a direction lost to the heal from one that never carried content)
	await h.eventually(() => has(A, lockBox), (v) => v, "premise: B's edit reaches A before any drop");

	/** net-drop-1: both pages' wire logs, each conn's channel counts and the selected ICE pair's
	 * candidate types (host / srflx / relay), printed — the deployed-build diagnosis */
	async function wireTrace(/** @type {string} */ tag, /** @type {string} */ why) {
		for (const [p, other] of [[A, B.id], [B, A.id]]) {
			const t = await p.page
				.evaluate(async (/** @type {string} */ pid) => {
					// @ts-ignore
					const D = window.__drop;
					/** @type {any} */ let pc;
					window.__stores.peers.subscribe((/** @type {any} */ v) => (pc = v))();
					const c = pc.connections[pid];
					const pairs = [];
					for (const [n, rpc] of D.pcs.entries()) {
						if (rpc.signalingState === 'closed') continue;
						try {
							const rows = [];
							(await rpc.getStats()).forEach((/** @type {any} */ r) => rows.push(r));
							const tr = rows.find((r) => r.type === 'transport' && r.selectedCandidatePairId);
							const pair = tr && rows.find((r) => r.id === tr.selectedCandidatePairId);
							const kind = (/** @type {string} */ id) => rows.find((r) => r.id === id)?.candidateType ?? '?';
							pairs.push(`pc${n}: ${pair ? kind(pair.localCandidateId) + '->' + kind(pair.remoteCandidateId) + ' ' + pair.state : 'no pair'}`);
						} catch (e) {
							pairs.push(`pc${n}: stats ${String(e).slice(0, 40)}`);
						}
					}
					return {
						app: c ? `connections[peer] = ${c.connectionId} open=${c.open} dc=${c.dataChannel?.label}/${c.dataChannel?.readyState}` : 'connections[peer] = none',
						dcs: Object.entries(D.dcs).map(([l, r]) => `${l} pc${r.pc} ${r.state} sent=${r.sent} recv=${r.recv} held=${r.held}`),
						pairs,
						log: D.log.slice(-220).concat(Object.entries(D.quiet ?? {}).map(([k, n]) => `counted ${k} x${n}`))
					};
				}, other)
				.catch((/** @type {any} */ e) => ({ app: 'err ' + e, dcs: [], pairs: [], log: [] }));
			console.log(`  ${tag} GATES ${p === A ? 'A' : 'B'} about the other:\n      ` + (await gates(p, other)));
			console.log(`  ${tag} WIRE ${p === A ? 'A' : 'B'} (${p.id}) — ${why}\n    ${t.app}\n    ${t.pairs.join(' | ')}\n    ` + t.dcs.join('\n    ') + '\n    --\n    ' + t.log.join('\n    '));
		}
	}

	/** net-drop-1: the APP half of the trace — every DataConnection's sends and 'data' events by message
	 * type (pose/clock streams only counted), patched on peerjs's shared prototype so a conn made by a
	 * heal is covered too */
	async function appTrace(/** @type {any} */ p) {
		await p.page.evaluate(() => {
			// @ts-ignore
			const D = window.__drop;
			/** @type {any} */ let pc;
			window.__stores.peers.subscribe((/** @type {any} */ v) => (pc = v))();
			const any = Object.values(pc.connections)[0];
			let proto = Object.getPrototypeOf(any);
			while (proto && !Object.prototype.hasOwnProperty.call(proto, 'send')) proto = Object.getPrototypeOf(proto);
			if (!proto || proto.__ndTraced) return;
			proto.__ndTraced = true;
			const noisy = new Set(['camera', 'vrhands', 'clockping', 'clockpong', 'cursor', 'cursors', 'pointer', 'ping', 'pong', 'pose', 'move', 'batch']);
			D.quiet = {};
			const note = (/** @type {string} */ dir, /** @type {any} */ c, /** @type {any} */ d) => {
				const t = String(d?.type ?? (d && d.__peerData ? 'peerjs' : typeof d));
				if (noisy.has(t)) {
					const k = dir + ' ' + t + ' ' + c.peer + ' ' + c.connectionId;
					D.quiet[k] = (D.quiet[k] ?? 0) + 1;
					return;
				}
				D.note(`APP ${dir} ${t} ${dir === 'out' ? 'to' : 'from'} ${c.peer} on ${c.connectionId}${c.open ? '' : ' (NOT OPEN)'}`);
			};
			const send = proto.send;
			proto.send = function (/** @type {any} */ d, /** @type {any[]} */ ...rest) {
				note('out', this, d);
				return send.call(this, d, ...rest);
			};
			const emit = proto.emit;
			proto.emit = function (/** @type {string} */ ev, /** @type {any[]} */ ...args) {
				if (ev === 'data') note('in', this, args[0]);
				return emit.call(this, ev, ...args);
			};
		});
	}
	await appTrace(A);
	await appTrace(B);

	/** net-drop-1: what each side's gates answer about the other right now */
	async function gates(/** @type {any} */ p, /** @type {string} */ other) {
		return p.page
			.evaluate(async (/** @type {string} */ pid) => {
				const S = window.__stores;
				/** @type {any} */ let pc;
				S.peers.subscribe((/** @type {any} */ v) => (pc = v))();
				const get = (/** @type {any} */ st) => {
					let v;
					st?.subscribe?.((/** @type {any} */ x) => (v = x))();
					return v;
				};
				const out = [];
				const safe = (/** @type {string} */ k, /** @type {() => any} */ f) => {
					try {
						out.push(k + '=' + JSON.stringify(f()));
					} catch (e) {
						out.push(k + '=ERR ' + String(e).slice(0, 50));
					}
				};
				safe('withholdFrom(create)', () => pc.withholdFrom(pid, { type: 'create' }));
				safe('canApply(create)', () => S.cloudHooks?.canApply?.(pid, 'create'));
				safe('canApplyByRoom(create)', () => S.peerScenes?.canApplyByRoom?.(pid, 'create'));
				safe('gateHolds', () => S.sessions?.gateHolds?.(pid));
				safe('amPrivate', () => S.peerScenes?.amPrivate?.());
				safe('myScene', () => S.peerScenes?.myScene?.());
				safe('peerScenes', () => Object.fromEntries(Object.entries(get(S.peerScenes?.peerScenes) ?? {})));
				safe('sessionHost', () => get(S.connectionState?.sessionHost));
				safe('rolesInfo', () => {
					const r = get(S.cloudHooks?.rolesInfo);
					return r ? { myRole: r.myRole, amAdmin: r.amAdmin, theirs: r.roleOf?.(pid) } : null;
				});
				safe('viewer', () => S.objectPermissions?.isViewer?.());
				safe('roomLabelOf(them)', () => S.peerScenes?.roomLabelOf?.(pid));
				safe('myRoomLabel', () => S.peerScenes?.myRoomLabel?.());
				safe('toasts', () => (get(S.notifications) ?? []).slice(-4).map((/** @type {any} */ n) => String(n.text ?? n.message ?? n).slice(0, 90)));
				return out.join('\n      ');
			}, other)
			.catch((/** @type {any} */ e) => 'err ' + e);
	}

	/** each side's own role and its role for the other, from the rolesInfo bridge (null without a plugin) */
	async function roles() {
		const one = (/** @type {any} */ p, /** @type {string} */ other) =>
			p.page.evaluate((/** @type {string} */ pid) => {
				/** @type {any} */ let r;
				window.__stores.cloudHooks?.rolesInfo?.subscribe((/** @type {any} */ v) => (r = v))();
				return r ? `${r.myRole}/${r.roleOf?.(pid)}` : null;
			}, other);
		return { a: await one(A, B.id), b: await one(B, A.id) };
	}

	/** @param {'quiet' | 'hard'} shape @param {number} [sigLag] the signaling server stays away this much longer */
	async function drop(shape, sigLag = 0) {
		const tag = shape.toUpperCase() + ` ${DROP_MS / 1000}s drop${sigLag ? `, signaling back ${sigLag / 1000}s later` : ''}:`;
		const toastsA = (await store(A, 'notifications')).length;
		const toastsB = (await store(B, 'notifications')).length;
		// mark the conns, to tell "the same conn carried on" from "a redial healed it" — a phase after a
		// torn-down one has no conn to drop, which is a red premise, not a script crash
		let marked = true;
		for (const [p, other] of [[A, B.id], [B, A.id]]) {
			marked &&= await p.page.evaluate((/** @type {string} */ id) => {
				/** @type {any} */ let pc;
				window.__stores.peers.subscribe((/** @type {any} */ v) => (pc = v))();
				if (!pc.connections[id]?.open) return false;
				pc.connections[id].__th1 = 'before';
				return true;
			}, other);
		}
		h.check(marked, `${tag} premise: an open conn both ways before the drop`);
		if (!marked) return;
		const rolesBefore = await roles();
		// ---- the network goes away
		for (const p of [A, B]) await p.page.context().setOffline(true);
		for (const p of [A, B]) {
			await p.page.evaluate(() => {
				/** @type {any} */ let pc;
				window.__stores.peers.subscribe((/** @type {any} */ v) => (pc = v))();
				// @ts-ignore
				window.__drop.holding = true;
				// @ts-ignore
				window.__drop.sigHolding = true;
				// @ts-ignore
				window.__drop.ice('disconnected');
				// a real drop ends the socket at once (1006, ERR_NETWORK_CHANGED); a graceful close() waits for
				// the server's close frame, which offline emulation held for 3 s+ on a BUILT app (net-drop-1:
				// the QUIET premise red on production — B's socket sat CLOSING with peer.open still true), so
				// peerjs is handed the close event the dropped socket would have fired
				try {
					const ws = pc.peer._socket._socket;
					ws?.close();
					ws?.onclose?.(new CloseEvent('close', { code: 1006, reason: 'net-drop' }));
				} catch {}
			});
		}
		// the premise is read AT THE CUT: whether peerjs's own reconnect later slips past the shim (it did,
		// now and then) is the app recovering, not the drop failing to happen
		let cut = false;
		for (const t = Date.now(); !cut && Date.now() - t < 3000; await A.page.waitForTimeout(150))
			cut = !(await signalingUp(A)) && !(await signalingUp(B)); // peerjs marks itself down on the socket's close event
		if (!cut || TRACE)
			for (const p of [A, B])
				console.log(
					`  ${tag} signaling at the cut, ${p === A ? 'A' : 'B'}: ` +
						(await p.page.evaluate(() => {
							/** @type {any} */ let pc;
							window.__stores.peers.subscribe((/** @type {any} */ v) => (pc = v))();
							const q = pc.peer;
							return `open=${q?.open} disconnected=${q?.disconnected} destroyed=${q?.destroyed} ws=${q?._socket?._socket?.readyState ?? '-'} id=${q?.id}`;
						}))
				);
		if (shape === 'hard') {
			await A.page.evaluate((/** @type {string} */ id) => {
				/** @type {any} */ let pc;
				window.__stores.peers.subscribe((/** @type {any} */ v) => (pc = v))();
				// (a conn F-3 or the socket's end already closed is already being redialled)
				pc.connections[id]?.peerConnection?.close();
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
					return `sig=${pc.peer?.open ? 1 : 0} rec=${pc.reconnecting.get(pid) ?? '-'} conn=${c ? (c.open ? 'open' : 'neg ' + age(c)) + ' ' + c.connectionId : 'none'} in=${pc.inboundDials?.has(pid) ? 'neg ' + age(pc.inboundDials.get(pid)) : '-'} opened=${pc.openedPeers.has(pid) ? 1 : 0}`;
				}, id)
				.catch((/** @type {any} */ e) => 'err ' + String(e?.message ?? e).slice(0, 60));
		// net-drop-1: who we are does not change while the signaling link is down. peerjs nulls `peer.id`
		// on every drop (Peer.disconnect) until a reconnect re-registers; the cloud roles plugin then
		// counted itself alone, wiped its role map, and B came back from the heal a VIEWER whose edits never
		// left (deployed builds only — a dev server has no plugin). Sampled through the whole drop, since
		// peerjs's own retries put the id back between failed attempts. Counterfactual: red on v1.44.0.
		/** @type {string[]} */
		const idLost = [];
		const ownIds = async () => {
			for (const p of [A, B]) {
				const id = await p.page
					.evaluate(() => {
						/** @type {any} */ let pc;
						window.__stores.peers.subscribe((/** @type {any} */ v) => (pc = v))();
						return pc.peer?.id ?? null;
					})
					.catch(() => 'err');
				if (id !== p.id && idLost.length < 4) idLost.push(`${p === A ? 'A' : 'B'} read ${id} at ${Date.now() - t0}ms`);
			}
		};
		await ownIds();
		const watch = async () => {
			if (Date.now() - t0 < DROP_MS) await ownIds();
			timeline.push(`${((Date.now() - t0) / 1000).toFixed(1)}s A[${await state(A, B.id)}] B[${await state(B, A.id)}]`);
			if (!(await inRoster(A, B.id))) lost.push(`A lost B at ${Date.now() - t0}ms`);
			if (!(await inRoster(B, A.id))) lost.push(`B lost A at ${Date.now() - t0}ms`);
			if ((await bLocks()) === 0) lost.push(`A dropped B's lock at ${Date.now() - t0}ms`);
		};
		// an edit on each side DURING the drop
		for (const until = Date.now() + Math.min(1500, DROP_MS / 3); Date.now() < until; ) await ownIds();
		const duringA = await create(A, 'sphere');
		const duringB = await create(B, 'cylinder');
		const madeA = await made(A, duringA);
		while (Date.now() - t0 < DROP_MS) {
			await watch();
			await A.page.waitForTimeout(500);
		}
		h.check(cut, `${tag} premise: the signaling link really was down on both pages (at the cut)`);
		h.check(idLost.length === 0, `${tag} each page read its own peer id throughout the drop (${idLost.join(', ') || 'always'})`);
		// ---- the network comes back: lift the shim's hold FIRST, so the app's own `online` retry
		// (fired by setOffline(false)) reaches the real server rather than the held-down socket
		for (const p of [A, B]) {
			await p.page.evaluate((/** @type {number} */ lag) => {
				// @ts-ignore
				window.__drop.ice(null);
				// @ts-ignore
				window.__drop.release();
				// @ts-ignore
				if (lag) setTimeout(() => (window.__drop.sigHolding = false), lag);
				// @ts-ignore
				else window.__drop.sigHolding = false;
			}, sigLag);
		}
		for (const p of [A, B]) await p.page.context().setOffline(false);
		// watch the roster through the rest of the reconnect window: ~15.5 s from the drop's start, plus
		// the up-to-20 s its last check gives a dial still negotiating (VERDICT_GRACE_MS)
		const healed = { a: false, b: false };
		while (Date.now() - t0 < Math.max(DROP_MS, 0) + sigLag + 37000) {
			await watch();
			healed.a ||= await openTo(A, B.id);
			healed.b ||= await openTo(B, A.id);
			if (healed.a && healed.b && Date.now() - t0 > 16000) break;
			await A.page.waitForTimeout(500);
		}
		h.check(lost.length === 0, `${tag} each peer kept the other in its roster, and B's lock stood, throughout (${lost.slice(0, 2).join(', ') || 'never lost'})`);
		const healedBoth = (await openTo(A, B.id)) && (await openTo(B, A.id));
		// with a roles plugin loaded (every deployed build; E2E_CLOUD_PLUGIN on a dev server), the heal
		// changes nobody's role — on either side
		const rolesNow = await roles();
		if (rolesBefore.a || rolesBefore.b)
			h.check(
				JSON.stringify(rolesNow) === JSON.stringify(rolesBefore),
				`${tag} roles unchanged by the heal (before ${JSON.stringify(rolesBefore)}, after ${JSON.stringify(rolesNow)})`
			);
		if (TRACE) await wireTrace(tag, 'after the heal');
		if (!healedBoth) console.log(`  ${tag} timeline (A=${A.id} B=${B.id}; the lower id dials):\n    ` + timeline.join('\n    '));
		h.check(healedBoth, `${tag} the conn is open both ways again`);
		h.check((await disconnectToasts(A, toastsA)) === 0 && (await disconnectToasts(B, toastsB)) === 0, `${tag} no "disconnected" toast on either side`);
		await h.eventually(() => has(B, duringA), (v) => v, `${tag} A's edit made during the drop reaches B`, 15000);
		// 54-net: an edit that never left A — a creation made while A read itself a viewer is kept local
		// (objectPermissions.gateCreationBroadcast) and out of every full-state reply
		if (!(await has(B, duringA))) {
			console.log(`  ${tag} A's during-drop object ${duringA.slice(0, 8)}: at creation ${madeA}, now ${await made(A, duringA)}`);
			for (const [name, p] of [['A', A], ['B', B]])
				console.log(
					`  ${tag} ${name} objects: ` +
						(await p.page
							.evaluate(() => {
								/** @type {any} */ let g;
								window.__stores.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
								const ch = /** @type {any} */ (window.__stores.commandsHandler);
								const list = (g?.children ?? []).map((/** @type {any} */ o) => `${o.name}:${o.uuid.slice(0, 8)}`).join(' ');
								return `${list} | backlog=${ch?.ingestBacklog?.() ?? '?'} held=${ch?.ingestGateOpen?.() ?? '?'}`;
							})
							.catch((/** @type {any} */ e) => 'err ' + String(e?.message ?? e).slice(0, 60)))
				);
			// TEMP 54-net diag: is B's ingest queue throttled (a nested setTimeout chain) or stuck?
			const probe = await B.page
				.evaluate(async () => {
					const t = performance.now();
					for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
					return `vis=${document.visibilityState} focus=${document.hasFocus()} 10 nested setTimeout(0)=${Math.round(performance.now() - t)}ms`;
				})
				.catch((/** @type {any} */ e) => 'err ' + String(e?.message ?? e).slice(0, 60));
			console.log(`  ${tag} B timers: ${probe}`);
			const t1 = Date.now();
			while (Date.now() - t1 < 90000 && !(await has(B, duringA))) await A.page.waitForTimeout(1000);
			console.log(`  ${tag} A's during-drop object on B ${(await has(B, duringA)) ? 'arrived ' + Math.round((Date.now() - t1) / 1000) + ' s later' : 'still missing after 90 s'}`);
		}
		if (!TRACE && !(await has(B, duringA))) await wireTrace(tag, "A's edit never reached B");
		await h.eventually(() => has(A, duringB), (v) => v, `${tag} B's edit made during the drop reaches A`, 15000);
		if (!TRACE && !(await has(A, duringB))) await wireTrace(tag, "B's edit never reached A");
		const afterB = await create(B, 'cone');
		await h.eventually(() => has(A, afterB), (v) => v, `${tag} an edit after the drop replicates`, 10000);
		await h.eventually(async () => (await signalingUp(A)) && (await signalingUp(B)), (v) => v, `${tag} both pages are back on the signaling server`, 20000);
		const same = await A.page.evaluate((/** @type {string} */ id) => {
			/** @type {any} */ let pc;
			window.__stores.peers.subscribe((/** @type {any} */ v) => (pc = v))();
			return pc.connections[id]?.__th1 === 'before';
		}, B.id);
		// fix-live F-3 closes a link whose ICE sits `disconnected` past ICE_DROP_GRACE_MS (4 s,
		// src/lib/peerDrop.js) and hands it to the reconnect window, so a quiet drop LONGER than that
		// heals by a redial; the checks above (roster, locks, no toast, edits both ways) are the promise
		if (shape === 'quiet' && DROP_MS < ICE_DROP_GRACE_MS) h.check(same, `${tag} the SAME conn carried on (no redial was needed)`);
		else if (shape === 'quiet') console.log(`  ${tag} healed by ${same ? 'the same conn' : 'a redial (F-3: ICE held disconnected past the grace)'}`);
		else h.check(!same, `${tag} premise: the conn really was replaced by the reconnect window`);
	}

	await drop('quiet');
	await drop('hard');
	// 54-net: the deployed QUIET red — on a loaded box the signaling link came back ~25 s after a 5 s
	// drop, the reconnect window ran out first, and both sides tore the session down while the redial
	// was negotiating. The window now holds on our own signaling link (peerDrop.signalingHold).
	// Counterfactual: red on v1.46.0 (roster lost, "disconnected" toasts).
	if (SIG_LAG_MS) await drop('quiet', SIG_LAG_MS);
	await h.finish(browser);
});
