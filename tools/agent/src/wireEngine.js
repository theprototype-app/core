// The wire engine (`--engine=wire`): the original Node peer (@roamhq/wrtc + peerjs) speaking the
// peer protocol directly — light, no browser, objects only (no full scene read, no flows,
// behaviours or physics). Wrapped here in the same shape as the browser engine so one MCP
// server drives either. The PeerBridge and its native WebRTC load lazily: a browser-engine
// install never needs the native module.
import { EventEmitter } from 'node:events';
import { parseLink, redactLink, endpointsFor } from './link.js';
import { TOOL_SCHEMAS, executeTool, systemPrompt } from './tools.js';

export class WireEngine extends EventEmitter {
	/**
	 * @param {Object} opts
	 * @param {string} opts.link a session link or a bare peer id
	 * @param {(hostId: string, endpoints: any) => Promise<any>} opts.makeBridge builds a PeerBridge
	 * @param {any} [opts.server] --peer-server override (undefined = from the link; 'public' = the public cloud)
	 * @param {string | false} [opts.turnUrl] --turn-url / --no-turn
	 */
	constructor(opts) {
		super();
		this.kind = 'wire';
		this.link = parseLink(opts.link);
		this.endpoints = endpointsFor(this.link, { override: opts.server, turnUrl: opts.turnUrl });
		this._makeBridge = opts.makeBridge;
		/** @type {any} */
		this.bridge = null;
		this.error = null;
		this._starting = false;
	}

	get hostId() {
		return this.link.peerId;
	}

	get state() {
		if (this.error) return 'failed';
		return this.bridge ? this.bridge.state : this._starting ? 'starting' : 'idle';
	}

	/** Signal, dial the host, and return — approval is the host's, so it is not awaited here. */
	async start() {
		if (this.bridge) return;
		this._starting = true;
		try {
			const bridge = await this._makeBridge(this.hostId, this.endpoints);
			this.bridge = bridge;
			bridge.on('failed', (/** @type {string} */ r) => (this.error = r));
			await bridge.start();
			bridge.connectToHost(this.hostId);
			bridge.waitUntilConnected().catch(() => {});
		} catch (e) {
			this.error = (e && /** @type {any} */ (e).message) || String(e);
			throw e;
		} finally {
			this._starting = false;
		}
	}

	async tools() {
		return TOOL_SCHEMAS;
	}

	async systemPrompt() {
		return systemPrompt();
	}

	/** @param {string} name @param {any} args */
	async exec(name, args) {
		return executeTool(this.bridge, name, args ?? {});
	}

	async status() {
		return this.bridge ? this.bridge.status() : { state: this.state };
	}

	async joined() {
		return !!(this.bridge && this.bridge.everConnected);
	}

	async close() {
		const b = this.bridge;
		this.bridge = null;
		if (b) await b.shutdown();
		this.emit('closed');
	}

	describe() {
		const s = this.endpoints.server;
		return {
			engine: 'wire',
			link: redactLink(this.link),
			host: this.hostId,
			state: this.state,
			signaling: s ? s.host + ':' + (s.port || 443) + (s.path || '/peerjs') : 'public PeerJS cloud',
			signalingFrom: this.endpoints.source,
			turn: this.bridge?.turnState ?? (this.endpoints.turnApi ? 'pending' : 'none'),
			error: this.error || undefined
		};
	}
}
