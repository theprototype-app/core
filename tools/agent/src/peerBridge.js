import { EventEmitter } from 'node:events';
import { installPolyfills } from './polyfills.js';
import { Registry } from './registry.js';
import { hostsMsg, userdataMsg, lockedMsg, deleteMsg } from './messages.js';

installPolyfills();

// peerjs 1.5's socket does not always attach an 'error' handler to the raw ws in
// time, so a transient signaling error (e.g. the public cloud's 429 rate limit)
// surfaces as an UNCAUGHT 'error' event that would crash the process. Swallow only
// those transient socket errors (the bridge's own retry/timeout drives recovery);
// let anything else through. Installed once, process-wide.
let errorGuardInstalled = false;
function installErrorGuard() {
	if (errorGuardInstalled) return;
	errorGuardInstalled = true;
	process.on('uncaughtException', (e) => {
		const msg = String((e && e.message) || e);
		if (msg.includes('429') || msg.toLowerCase().includes('websocket') || msg.includes('ECONN') || msg.includes('socket hang up')) {
			return; // transient signaling — bridge retry handles it
		}
		throw e;
	});
}

/**
 * Connects to a theprototype.app session as a peer and mirrors the browser's
 * approval + handshake dance (verified against peerHandler.svelte.js):
 *
 *   connect(host) -> host closes the unknown conn -> a human clicks Approve ->
 *   the host opens ITS OWN conn back and gossips {type:'hosts'} -> we (re)open a
 *   fresh outgoing conn (now whitelisted) -> on open we send our minimal handshake
 *   -> connected. A stable, already-whitelisted id skips approval (the first conn
 *   just opens).
 *
 * Emits: 'open' (agentId), 'connected', 'approval-needed', 'failed' (reason),
 *        'message' ({from, msg}), 'closed'.
 */
export class PeerBridge extends EventEmitter {
	/**
	 * @param {Object} opts
	 * @param {string} opts.agentId
	 * @param {string} [opts.name]
	 * @param {string} [opts.hostId]
	 * @param {{host:string,port:number,secure?:boolean,path?:string}|null} [opts.server] null = public cloud
	 * @param {number} [opts.approvalTimeout] ms (default 120000)
	 * @param {boolean} [opts.verbose]
	 */
	constructor(opts) {
		super();
		this.agentId = opts.agentId;
		this.name = opts.name || 'agent';
		this.hostId = opts.hostId || null;
		this.server = opts.server || null;
		this.approvalTimeout = opts.approvalTimeout || 120000;
		this.verbose = !!opts.verbose;

		this.state = 'idle';
		/** @type {Map<string, any>} */
		this.out = new Map(); // outgoing conns by peer id
		/** @type {Set<any>} */
		this.inbound = new Set();
		/** @type {Set<string>} */
		this.whitelist = new Set(this.hostId ? [this.hostId] : []);
		/** @type {any[]} */
		this.queue = [];
		this.registry = new Registry();
		this.everConnected = false;
		/** @type {any} */
		this.peer = null;
		this._approvalTimer = null;
		this._Peer = null;
	}

	/** @param {string} m */
	log(m) {
		if (this.verbose) console.error('[bridge] ' + m);
	}

	_setState(s) {
		if (this.state === s) return;
		this.state = s;
		this.log('state -> ' + s);
	}

	/** Load peerjs (ESM default.Peer) and create the Peer, retrying transient
	 * signaling failures (cloud 429) with backoff. @returns {Promise<string>} */
	async start(maxAttempts = 5) {
		installErrorGuard();
		if (!this._Peer) this._Peer = (await import('peerjs')).default.Peer;
		let lastErr = 'unknown';
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return await this._openPeer();
			} catch (e) {
				lastErr = (e && e.message) || String(e);
				this.log('signaling attempt ' + attempt + ' failed: ' + lastErr);
				try {
					this.peer && this.peer.destroy();
				} catch {}
				if (attempt < maxAttempts) {
					const wait = Math.min(30000, 3000 * attempt);
					this.log('retrying signaling in ' + wait + 'ms');
					await new Promise((r) => setTimeout(r, wait));
				}
			}
		}
		throw new Error('signaling failed after ' + maxAttempts + ' attempts (' + lastErr + ')');
	}

	/** One signaling attempt: create the Peer and wait for 'open'. @returns {Promise<string>} */
	_openPeer() {
		this._setState('signaling');
		const peer = this.server
			? new this._Peer(this.agentId, {
					host: this.server.host,
					port: this.server.port,
					secure: this.server.secure !== false,
					path: this.server.path || '/'
			  })
			: new this._Peer(this.agentId);
		this.peer = peer;

		return new Promise((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					reject(new Error('no open event in 18s (rate-limited or unreachable)'));
				}
			}, 18000);
			peer.on('open', (id) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.agentId = id;
				this.log('peer open: ' + id);
				this.emit('open', id);
				resolve(id);
			});
			peer.on('error', (err) => {
				const type = err && err.type;
				this.log('peer error: ' + type + ' ' + (err && err.message));
				if (type === 'peer-unavailable') {
					this.emit('failed', 'host ' + this.hostId + ' is not available');
					return; // not fatal to signaling
				}
				if (!settled && !this.everConnected) {
					settled = true;
					clearTimeout(timer);
					reject(new Error('signaling error: ' + (type || (err && err.message))));
				}
			});
			peer.on('connection', (conn) => this._onInbound(conn));
			peer.on('disconnected', () => this._onDisconnected());
			peer.on('close', () => this._setState('closed'));
		});
	}

	_onDisconnected() {
		this.log('peer disconnected from signaling; reconnecting');
		this._setState('reconnecting');
		try {
			this.peer.reconnect();
		} catch (e) {
			// ignore
		}
	}

	/** Begin the join dance to the host. @param {string} [hostId] */
	connectToHost(hostId) {
		if (hostId) {
			this.hostId = hostId;
			this.whitelist.add(hostId);
		}
		if (!this.hostId) throw new Error('no hostId to connect to');
		this._setState('requesting');
		this._openOutgoing(this.hostId);
		this._armApprovalTimer();
	}

	_armApprovalTimer() {
		if (this._approvalTimer) return;
		this._approvalTimer = setTimeout(() => {
			if (!this.everConnected) {
				this._setState('failed');
				this.emit('failed', 'approval timed out after ' + Math.round(this.approvalTimeout / 1000) + 's (was the join approved?)');
			}
		}, this.approvalTimeout);
	}

	_clearApprovalTimer() {
		if (this._approvalTimer) {
			clearTimeout(this._approvalTimer);
			this._approvalTimer = null;
		}
	}

	/** @param {string} peerId */
	_openOutgoing(peerId) {
		if (!peerId || peerId === this.agentId) return;
		if (this.out.has(peerId)) return;
		this.log('opening outgoing conn to ' + peerId);
		let conn;
		try {
			conn = this.peer.connect(peerId, { reliable: true });
		} catch (e) {
			this.log('connect threw: ' + e.message);
			return;
		}
		this.out.set(peerId, conn);
		conn.on('open', () => this._onOutOpen(peerId, conn));
		conn.on('close', () => this._onOutClose(peerId, conn));
		conn.on('data', (d) => this._onData(peerId, d));
		conn.on('error', (e) => this.log('outgoing conn error (' + peerId + '): ' + (e && e.message)));
	}

	_onOutOpen(peerId, conn) {
		this.log('outgoing conn OPEN to ' + peerId);
		// minimal handshake — NO modules/environment/get* (see B1 notes)
		const hostIds = [this.agentId, ...this.out.keys()].filter((v, i, a) => a.indexOf(v) === i);
		conn.send(lockedMsg());
		conn.send(hostsMsg(this.agentId, hostIds));
		conn.send(userdataMsg(this.agentId, this.name));

		if (!this.everConnected) {
			this.everConnected = true;
			this._clearApprovalTimer();
			this._setState('connected');
			this.emit('connected');
		}
		this._flush();
	}

	_onOutClose(peerId, conn) {
		this.log('outgoing conn CLOSED to ' + peerId);
		if (this.out.get(peerId) === conn) this.out.delete(peerId);
		// host closed our unknown conn pre-approval -> wait for the approve + inbound
		if (!this.everConnected && peerId === this.hostId) {
			this._setState('awaiting-approval');
			this.emit('approval-needed');
		} else if (this.everConnected && peerId === this.hostId && this.out.size === 0) {
			// lost the host after being connected — try to re-open (still whitelisted)
			this._setState('reconnecting');
			setTimeout(() => this._openOutgoing(peerId), 2000);
		}
	}

	/** @param {any} conn */
	_onInbound(conn) {
		this.log('inbound conn from ' + conn.peer);
		this.inbound.add(conn);
		conn.on('data', (d) => this._onData(conn.peer, d));
		conn.on('close', () => this.inbound.delete(conn));
		conn.on('error', () => {});
	}

	/** @param {string} from @param {any} msg */
	_onData(from, msg) {
		if (!msg || typeof msg !== 'object') return;
		this.registry.observe(msg, from);
		this.emit('message', { from, msg });
		if (msg.type === 'hosts' && Array.isArray(msg.hosts)) {
			for (const id of msg.hosts) {
				this.whitelist.add(id);
				this._openOutgoing(id); // mirror the browser mesh gossip
			}
		} else if (msg.type === 'userdata' && Array.isArray(msg.userdata)) {
			for (const row of msg.userdata) if (row && row[0]) this.whitelist.add(row[0]);
		}
	}

	_flush() {
		if (!this.queue.length) return;
		const pending = this.queue.splice(0);
		for (const msg of pending) this.broadcast(msg);
	}

	/**
	 * Broadcast a mutation to every open outgoing conn (queues until connected).
	 * @param {any} msg
	 */
	broadcast(msg) {
		const open = [...this.out.values()].filter((c) => c && c.open);
		if (!open.length) {
			this.queue.push(msg);
			return false;
		}
		this.registry.observeOutgoing(msg);
		for (const conn of open) {
			try {
				conn.send(msg);
			} catch (e) {
				this.log('send failed: ' + e.message);
			}
		}
		return true;
	}

	/** Wait until at least one outgoing conn is open. @param {number} [timeout] */
	waitUntilConnected(timeout = this.approvalTimeout) {
		if (this.everConnected) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => {
				this.off('connected', onC);
				this.off('failed', onF);
				reject(new Error('not connected within ' + Math.round(timeout / 1000) + 's'));
			}, timeout);
			const onC = () => {
				clearTimeout(t);
				this.off('failed', onF);
				resolve();
			};
			const onF = (reason) => {
				clearTimeout(t);
				this.off('connected', onC);
				reject(new Error(reason));
			};
			this.once('connected', onC);
			this.once('failed', onF);
		});
	}

	/** Human-readable status. */
	status() {
		return {
			state: this.state,
			agentId: this.agentId,
			hostId: this.hostId,
			connected: this.everConnected,
			outgoingPeers: [...this.out.keys()],
			objects: this.registry.size
		};
	}

	/** Send a delete for an object we created (helper for shutdown/cleanup). */
	deleteObject(id) {
		this.broadcast(deleteMsg(id, this.agentId));
	}

	shutdown() {
		this._clearApprovalTimer();
		this._setState('closed');
		try {
			this.peer && this.peer.destroy();
		} catch (e) {
			// ignore
		}
		this.emit('closed');
	}
}
