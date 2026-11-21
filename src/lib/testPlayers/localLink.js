// 61 G3 — TEST WITH PLAYERS: THE LOCAL LINK. A transport with PeerJS's shape (a Peer that emits
// `open` / `connection` / `error`, DataConnections that emit `open` / `data` / `close` / `error` and carry
// `metadata`) between this tab and the simulated players it runs in hidden same-origin frames. No server:
// every link is one MessageChannel, brokered once by the tab that started the test (the HUB).
//
// WHY THE SAME SHAPE: everything above a DataConnection — the dial metadata (101's `proto` + `caps`, `jr`,
// invites, `kind`), the approval path, the protocol check, the inbound budget, the receive gate, roles,
// wireValidate — runs unchanged, so a test with bots exercises the code real peers do. Frames are encoded
// with PeerJS's own binary format (peerCodec `packFrame`) and decoded by the app's hardened decoder
// (`decodeFrame`, with its object / depth limits); a refused frame is reported exactly like one from a
// real link. The reliable channel's byte meter reads `conn.dataChannel` 'message' events, so the fake
// channel fires them. There is no RTCPeerConnection (`peerConnection` null): the fast channel, the ICE
// watch and the consent poll all stand down by their own guards, and voice `call()` answers undefined.
//
// WHY A HUB AND NOT A BroadcastChannel: a MessagePort can only be handed to another frame through
// postMessage, and it must ARRIVE in the receiving frame's realm — a port (and the ArrayBuffers it
// delivers) created in another realm fails the decoder's `instanceof ArrayBuffer`. So a dial is
// `{kind: 'dial'}` + the far port, posted to the hub window, which forwards it (port transferred again)
// to the frame that owns the id, or accepts it itself when the id is the hub's own.
//
// TRUST: only same-origin windows can talk to the hub, only frames the hub created are listened to, a
// dial's `from` must be the id that frame registered, and a frame registers one id once. Nothing here
// reaches the network.

import { decodeFrame, packFrame, reportFrameRefusal, FRAME_LIMITS } from '../peerCodec.js';
import { LINK_TAG } from './seams.js';

export { LINK_TAG };

/** a peer id this transport accepts: what createPeer() makes, plus room for test ids */
const ID_RE = /^[0-9a-z][0-9a-z_-]{2,40}$/i;
/** a bot re-sends its hello this often until welcomed, for at most HELLO_TRIES more times (30 s) */
export const HELLO_EVERY_MS = 1000;
export const HELLO_TRIES = 30;

/** A tiny EventEmitter with the eventemitter3 surface the app calls on a Peer / DataConnection. */
class Emitter {
	constructor() {
		/** @type {Map<string, Set<{fn: Function, once: boolean}>>} */
		this.__events = new Map();
	}
	/** @param {string} name @param {Function} fn */
	on(name, fn) {
		if (typeof fn !== 'function') return this;
		if (!this.__events.has(name)) this.__events.set(name, new Set());
		/** @type {Set<any>} */ (this.__events.get(name)).add({ fn, once: false });
		return this;
	}
	/** @param {string} name @param {Function} fn */
	once(name, fn) {
		if (typeof fn !== 'function') return this;
		if (!this.__events.has(name)) this.__events.set(name, new Set());
		/** @type {Set<any>} */ (this.__events.get(name)).add({ fn, once: true });
		return this;
	}
	/** @param {string} name @param {Function} [fn] */
	off(name, fn) {
		const set = this.__events.get(name);
		if (!set) return this;
		if (!fn) set.clear();
		else for (const entry of set) if (entry.fn === fn) set.delete(entry);
		return this;
	}
	/** @param {string} name @param {Function} [fn] */
	removeListener(name, fn) {
		return this.off(name, fn);
	}
	/** @param {string} [name] */
	removeAllListeners(name) {
		if (name === undefined) this.__events.clear();
		else this.__events.delete(name);
		return this;
	}
	/** @param {string} name */
	listenerCount(name) {
		return this.__events.get(name)?.size ?? 0;
	}
	/** @param {string} name @param {...any} args */
	emit(name, ...args) {
		const set = this.__events.get(name);
		if (!set || !set.size) return false;
		for (const entry of [...set]) {
			if (entry.once) set.delete(entry);
			try {
				entry.fn.apply(this, args);
			} catch (error) {
				console.error('local link listener threw:', error);
			}
		}
		return true;
	}
}

let connSeq = 0;

/**
 * One end of a local link. `send` encodes with PeerJS's binary format; arriving frames are metered on
 * `dataChannel` and decoded by the app's own decoder.
 */
export class LocalDataConnection extends Emitter {
	/**
	 * @param {{peer: string, metadata?: any, port: MessagePort, onEnd?: (conn: LocalDataConnection) => void}} opts
	 */
	constructor(opts) {
		super();
		this.peer = opts.peer;
		this.metadata = opts.metadata;
		this.open = false;
		this.closed = false;
		this.type = 'data';
		this.reliable = true;
		this.serialization = 'binary';
		this.connectionId = 'lc_' + (++connSeq).toString(36) + Math.random().toString(36).slice(2, 7);
		this.label = this.connectionId;
		/** there is no RTCPeerConnection: fast channel, ICE and consent watches stand down */
		/** @type {RTCPeerConnection | null} always null: a local link has no ICE, no fast channel, no consent watch */
		this.peerConnection = null;
		/** marks a link of this transport (the host admits a test bot only over one) */
		this.__tpLocal = true;
		this.port = opts.port;
		this.onEnd = opts.onEnd;
		/** @type {Promise<void> | null} sends waiting behind an async (Blob) pack */
		this.pending = null;
		this.pendingSeq = 0;
		this.bytesIn = 0;
		this.bytesOut = 0;
		/** a stand-in for the reliable RTCDataChannel: the byte meter listens for its 'message' events */
		const dc = /** @type {any} */ (new EventTarget());
		dc.bufferedAmount = 0;
		dc.readyState = 'connecting';
		dc.label = this.label;
		dc.close = () => this.close();
		this.dataChannel = dc;
		this.port.onmessage = (e) => this.receive(e.data);
		this.port.start?.();
	}

	/** @param {any} data */
	receive(data) {
		if (this.closed) return;
		if (data instanceof ArrayBuffer) {
			if (!this.open) return; // nothing flows before both ends are open
			this.bytesIn += data.byteLength;
			try {
				this.dataChannel.dispatchEvent(new MessageEvent('message', { data }));
			} catch {
				/* a meter that threw never drops the frame */
			}
			if (data.byteLength > FRAME_LIMITS.messageBytes) {
				reportFrameRefusal(this.peer, 'frame-size');
				return;
			}
			let value;
			try {
				value = decodeFrame(data);
			} catch (error) {
				reportFrameRefusal(this.peer, /** @type {any} */ (error)?.reason || 'decode');
				return;
			}
			if (value === null || value === undefined) {
				reportFrameRefusal(this.peer, 'empty');
				return;
			}
			this.emit('data', value);
			return;
		}
		const ctl = data && typeof data === 'object' ? data.ctl : null;
		if (ctl === 'open') this.markOpen();
		else if (ctl === 'close') this.finish();
		else if (ctl === 'unavailable') {
			/** @type {any} */ (this).__unavailable = true;
			this.finish();
		}
	}

	markOpen() {
		if (this.open || this.closed) return;
		this.open = true;
		this.dataChannel.readyState = 'open';
		this.emit('open');
	}

	/** @param {any} data */
	send(data) {
		if (!this.open) {
			this.emit('error', Object.assign(new Error('Connection is not open. You should listen for the `open` event before sending messages.'), { type: 'not-open-yet' }));
			return;
		}
		/** @type {any} */
		let packed;
		try {
			packed = packFrame(data);
		} catch (error) {
			this.emit('error', Object.assign(new Error('could not encode: ' + String(error)), { type: 'invalid-message' }));
			return;
		}
		if (packed instanceof Promise || this.pending) {
			const seq = ++this.pendingSeq;
			const before = this.pending ?? Promise.resolve();
			this.pending = before
				.then(() => packed)
				.then((buf) => this.post(buf))
				.catch(() => {})
				.finally(() => {
					if (seq === this.pendingSeq) this.pending = null;
				});
			return;
		}
		this.post(packed);
	}

	/** @param {ArrayBuffer | Uint8Array} buf */
	post(buf) {
		if (!this.open || this.closed) return;
		const ab = buf instanceof ArrayBuffer ? buf : /** @type {ArrayBuffer} */ (buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
		this.bytesOut += ab.byteLength;
		try {
			this.port.postMessage(ab, [ab]);
		} catch (error) {
			this.emit('error', Object.assign(new Error(String(error)), { type: 'connection' }));
		}
	}

	close() {
		if (this.closed) return;
		try {
			this.port.postMessage({ ctl: 'close' });
		} catch {
			/* the far frame is already gone */
		}
		this.finish();
	}

	/** the link is over, whichever end said so: 'close' once, a microtask later (PeerJS fires it async too) */
	finish() {
		if (this.closed) return;
		const wasOpen = this.open;
		this.closed = true;
		this.open = false;
		this.dataChannel.readyState = 'closed';
		try {
			this.port.onmessage = null;
			this.port.close();
		} catch {
			/* already closed */
		}
		this.onEnd?.(this);
		setTimeout(() => this.emit('close', { wasOpen }), 0);
	}
}

/**
 * The connection bookkeeping a Peer-shaped endpoint needs (bot peers and the hub's own end share it).
 */
class Endpoint extends Emitter {
	/** @param {string} id */
	constructor(id) {
		super();
		this.id = id;
		/** @type {Record<string, LocalDataConnection[]>} PeerJS's shape: remote id -> links */
		this.connections = {};
	}

	/** @param {LocalDataConnection} conn */
	track(conn) {
		(this.connections[conn.peer] ??= []).push(conn);
	}

	/** @param {LocalDataConnection} conn */
	untrack(conn) {
		const list = this.connections[conn.peer];
		if (!list) return;
		const i = list.indexOf(conn);
		if (i >= 0) list.splice(i, 1);
		if (!list.length) delete this.connections[conn.peer];
	}

	/**
	 * A dial arrived: the far end's port is ours now. 'connection' first (the app decides and wires
	 * synchronously, as with PeerJS), then both ends open a tick later.
	 * @param {string} from @param {any} metadata @param {MessagePort} port
	 */
	accept(from, metadata, port) {
		const conn = new LocalDataConnection({ peer: from, metadata, port, onEnd: (c) => this.untrack(c) });
		this.track(conn);
		this.emit('connection', conn);
		setTimeout(() => {
			if (conn.closed) return;
			try {
				port.postMessage({ ctl: 'open' });
			} catch {
				conn.finish();
				return;
			}
			conn.markOpen();
		}, 0);
		return conn;
	}

	/** @param {string} to @param {LocalDataConnection} conn */
	watchUnavailable(to, conn) {
		conn.once('close', () => {
			if (!(/** @type {any} */ (conn).__unavailable)) return;
			this.emit('error', Object.assign(new Error('Could not connect to peer ' + to), { type: 'peer-unavailable' }));
		});
	}

	/** close every link to one peer (a stopped bot) @param {string} peerId */
	dropPeer(peerId) {
		for (const conn of [...(this.connections[peerId] ?? [])]) conn.finish();
	}

	closeAll() {
		for (const list of Object.values(this.connections)) for (const conn of [...list]) conn.close();
	}

	call() {
		return undefined;
	}
	/** @param {(ids: string[]) => void} cb */
	listAllPeers(cb) {
		if (typeof cb === 'function') cb([]);
	}
}

/**
 * The Peer a bot frame holds. Opens once the hub that started the test has accepted its id.
 * @param {string} id @param {{test: string, hub?: Window, origin?: string}} opts
 */
export function createBotPeer(id, opts) {
	const hub = opts.hub ?? window.parent;
	const origin = opts.origin ?? location.origin;
	const test = String(opts.test);
	const peer = /** @type {any} */ (new Endpoint(id));
	peer.open = false;
	peer.disconnected = false;
	peer.destroyed = false;
	/** @param {MessageEvent} e */
	const onMessage = (e) => {
		if (e.source !== hub || e.origin !== origin) return;
		const d = e.data;
		if (!d || d[LINK_TAG] !== 1 || d.test !== test) return;
		if (d.kind === 'welcome' && d.id === id) {
			if (peer.open || peer.destroyed) return;
			peer.open = true;
			peer.emit('open', id);
		} else if (d.kind === 'dial' && d.to === id && e.ports[0] && typeof d.from === 'string') {
			if (!peer.open) {
				e.ports[0].postMessage({ ctl: 'unavailable' });
				return;
			}
			peer.accept(d.from, d.meta, e.ports[0]);
		}
	};
	window.addEventListener('message', onMessage);
	/** @param {string} to @param {any} [options] */
	peer.connect = (to, options) => {
		if (!peer.open || peer.destroyed || typeof to !== 'string') return undefined;
		const channel = new MessageChannel();
		const conn = new LocalDataConnection({ peer: to, metadata: options?.metadata, port: channel.port1, onEnd: (c) => peer.untrack(c) });
		peer.track(conn);
		peer.watchUnavailable(to, conn);
		hub.postMessage({ [LINK_TAG]: 1, kind: 'dial', test, from: id, to, meta: options?.metadata }, origin, [channel.port2]);
		return conn;
	};
	peer.reconnect = () => {};
	peer.disconnect = () => {};
	peer.destroy = () => {
		if (peer.destroyed) return;
		peer.destroyed = true;
		peer.open = false;
		window.removeEventListener('message', onMessage);
		peer.closeAll();
		peer.emit('close');
	};
	// say hello until the hub answers: one postMessage is all a frame gets otherwise, and a frame that loses
	// it (a hub busy booting its other frame) would sit at "loading" for the whole run
	const hello = () => hub.postMessage({ [LINK_TAG]: 1, kind: 'hello', test, id }, origin);
	hello();
	let tries = 0;
	const again = setInterval(() => {
		if (peer.open || peer.destroyed || ++tries > HELLO_TRIES) clearInterval(again);
		else hello();
	}, HELLO_EVERY_MS);
	return peer;
}

/**
 * The tab that runs a test: brokers every dial between its frames and accepts the ones addressed to
 * itself on its own endpoint (`endpoint`, which `wrapHostPeer` grafts onto the real PeerJS Peer).
 * @param {{test: string, hostId: () => string, origin?: string, onReady?: (n: number, id: string) => void}} opts
 */
export function createHub(opts) {
	const origin = opts.origin ?? location.origin;
	const test = String(opts.test);
	/** @type {Map<Window, {n: number, id: string | null}>} */
	const frames = new Map();
	/** @type {Map<string, Window>} */
	const ids = new Map();
	const endpoint = /** @type {any} */ (new Endpoint(opts.hostId()));

	/** @param {any} d @param {MessagePort} port */
	const route = (d, port) => {
		const to = String(d.to);
		const message = { [LINK_TAG]: 1, kind: 'dial', test, from: d.from, to, meta: d.meta };
		if (to === opts.hostId()) {
			endpoint.id = to;
			endpoint.accept(d.from, d.meta, port);
			return;
		}
		const win = ids.get(to);
		if (!win) {
			port.postMessage({ ctl: 'unavailable' });
			return;
		}
		try {
			win.postMessage(message, origin, [port]);
		} catch {
			try {
				port.postMessage({ ctl: 'unavailable' });
			} catch {
				/* both ends gone */
			}
		}
	};

	/** every hello that reached the hub (n null = from a frame it never added), for the debug hook */
	const stats = { hellos: /** @type {{n: number | null, id: string | null, at: number}[]} */ ([]) };

	/** @param {MessageEvent} e */
	const onMessage = (e) => {
		if (e.origin !== origin) return;
		const d = e.data;
		if (!d || d[LINK_TAG] !== 1 || d.test !== test) return;
		const frame = frames.get(/** @type {Window} */ (e.source));
		if (d.kind === 'hello' && stats.hellos.length < 50) stats.hellos.push({ n: frame?.n ?? null, id: typeof d.id === 'string' ? d.id.slice(0, 40) : null, at: Date.now() % 1e7 });
		if (!frame) return; // only frames this hub made
		if (d.kind === 'hello') {
			const id = typeof d.id === 'string' ? d.id : '';
			// a repeated hello from the frame we already accepted lost our welcome: answer it again
			if (frame.id && frame.id === id) return /** @type {Window} */ (e.source).postMessage({ [LINK_TAG]: 1, kind: 'welcome', test, id }, origin);
			if (frame.id || !ID_RE.test(id) || ids.has(id) || id === opts.hostId()) return;
			frame.id = id;
			ids.set(id, /** @type {Window} */ (e.source));
			/** @type {Window} */ (e.source).postMessage({ [LINK_TAG]: 1, kind: 'welcome', test, id }, origin);
			opts.onReady?.(frame.n, id);
		} else if (d.kind === 'dial') {
			const port = e.ports[0];
			if (!port) return;
			// a frame dials only as the id it registered
			if (!frame.id || d.from !== frame.id || typeof d.to !== 'string') {
				port.postMessage({ ctl: 'unavailable' });
				return;
			}
			route(d, port);
		}
	};
	window.addEventListener('message', onMessage);

	/** @param {string} to @param {any} [options] */
	endpoint.connect = (to, options) => {
		if (!ids.has(to)) return undefined;
		const from = opts.hostId();
		endpoint.id = from;
		const channel = new MessageChannel();
		const conn = new LocalDataConnection({ peer: to, metadata: options?.metadata, port: channel.port1, onEnd: (c) => endpoint.untrack(c) });
		endpoint.track(conn);
		endpoint.watchUnavailable(to, conn);
		route({ from, to, meta: options?.metadata }, channel.port2);
		return conn;
	};

	return {
		endpoint,
		test,
		stats,
		/** @param {Window} win @param {number} n */
		addFrame(win, n) {
			frames.set(win, { n, id: null });
		},
		/** forget a frame and end every link the hub's own end holds to it @param {Window} win */
		removeFrame(win) {
			const frame = frames.get(win);
			frames.delete(win);
			if (frame?.id) {
				ids.delete(frame.id);
				endpoint.dropPeer(frame.id);
			}
		},
		/** @param {string} id */
		has(id) {
			return ids.has(id);
		},
		ids() {
			return [...ids.keys()];
		},
		destroy() {
			window.removeEventListener('message', onMessage);
			for (const id of ids.keys()) endpoint.dropPeer(id);
			frames.clear();
			ids.clear();
		}
	};
}

/**
 * Graft the hub onto the tab's real PeerJS Peer: a dial to a bot id goes over the local link, a bot's
 * dial arrives as that Peer's own 'connection' event (so `handleConnection` sees it like any other).
 * Idempotent; returns the undo.
 * @param {any} peer @param {ReturnType<typeof createHub>} hub @returns {() => void}
 */
export function wrapHostPeer(peer, hub) {
	if (!peer || peer.__tpLocalHub === hub) return () => {};
	const realConnect = peer.__tpRealConnect ?? peer.connect;
	peer.__tpRealConnect = realConnect;
	peer.__tpLocalHub = hub;
	peer.connect = function (/** @type {string} */ to, /** @type {any} */ options) {
		if (hub.has(to)) return hub.endpoint.connect(to, options);
		return realConnect.call(peer, to, options);
	};
	/** @param {any} conn */
	const relay = (conn) => {
		if (peer.__tpLocalHub !== hub || peer.destroyed) {
			conn.close();
			return;
		}
		peer.emit('connection', conn);
	};
	hub.endpoint.on('connection', relay);
	/** @param {any} err */
	const relayError = (err) => {
		if (peer.__tpLocalHub === hub && !peer.destroyed) peer.emit('error', err);
	};
	hub.endpoint.on('error', relayError);
	return () => {
		hub.endpoint.off('connection', relay);
		hub.endpoint.off('error', relayError);
		if (peer.__tpLocalHub === hub) {
			peer.connect = realConnect;
			delete peer.__tpLocalHub;
			delete peer.__tpRealConnect;
		}
	};
}
