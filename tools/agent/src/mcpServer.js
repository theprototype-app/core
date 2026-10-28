// MCP mode (roadmap 10 B5 → 55 A3): a stdio MCP server whose scene tools are the HOST'S.
//
// With the browser engine the tool list is generated from `tpAgent.tools()` once the agent page
// is up (never a hardcoded catalog: it is the live app's set, physics and mesh gen included
// when the host offers them) and re-read on a poll and after every call, so a host that turns
// a provider on, or a role change, reaches the client as `notifications/tools/list_changed`.
// Beside them sit the bridge's own four: connect, status, screenshot, wait_for_edit.
//
// The server answers IMMEDIATELY and connects in the background: approval is a human's, so no
// tool registration ever waits on it — scene tools refuse with "not in the session yet" until
// the host lets the agent in. stdout is the protocol, so nothing else may write to it.
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { bridgeTools, mapHostTools, toolSignature, textResult, resultIsError } from './mcpTools.js';
import { parseLink } from './link.js';

export const PKG_VERSION = (() => {
	try {
		return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0';
	} catch {
		return '0.0.0';
	}
})();

const INSTRUCTIONS = [
	'theprototype.app session bridge: you are a peer in a live, shared 3D scene. Everything you change replicates to everyone in the session, with undo.',
	'Start with status (or connect with the session link the host gave you). The scene tools are the host app\'s own and appear once you are in;',
	'call list_scene first so you use real uuids, batch many objects into one call, and use screenshot to look at the result. wait_for_edit waits for the humans.'
].join(' ');

const CONNECT_WAIT_MS = 45000;
const WAIT_EDIT_MAX_MS = 120000;

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The server, engine-agnostic (tests drive it with a fake engine over an in-memory transport).
 * @param {Object} opts
 * @param {'browser'|'wire'} opts.kind
 * @param {(link: string) => any} opts.createEngine
 * @param {any[]} [opts.staticTools] host tools known before connecting (the wire engine's catalog)
 * @param {number} [opts.pollMs] how often to re-read the host's tool list (default 5000)
 * @param {number} [opts.connectWaitMs]
 * @param {(m: string) => void} [opts.log]
 */
export function createBridgeServer(opts) {
	const log = opts.log || (() => {});
	const builtins = bridgeTools(opts.kind);
	const reserved = builtins.map((t) => t.name);
	/** @type {any} */
	let engine = null;
	/** @type {Promise<any> | null} */
	let starting = null;
	/** @type {any[]} */
	let hostTools = [];
	/** @type {string[]} */
	let dropped = [];
	let signature = '';
	let wasJoined = false;
	/** @type {ReturnType<typeof setInterval> | null} */
	let poll = null;
	let closed = false;

	if (opts.staticTools) {
		const m = mapHostTools(opts.staticTools, reserved);
		hostTools = m.tools;
		dropped = m.dropped;
		signature = toolSignature(hostTools);
	}

	const server = new Server(
		{ name: 'theprototype', version: PKG_VERSION },
		{ capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS }
	);

	const notifyChanged = () => {
		server.sendToolListChanged().catch(() => {}); // before the client initializes there is nobody to tell
	};

	const engineReady = () => !!engine && (engine.kind === 'wire' ? !!engine.bridge : engine.state === 'ready');

	/** Re-read the host's tools; tell the client when the list it sees changed. */
	async function refreshTools() {
		if (closed || !engine) return;
		if (!engineReady()) return;
		let raw;
		try {
			raw = await engine.tools();
		} catch (e) {
			log('tools() failed: ' + /** @type {any} */ (e).message);
			return;
		}
		const m = mapHostTools(raw, reserved);
		const sig = toolSignature(m.tools);
		if (sig !== signature) {
			signature = sig;
			hostTools = m.tools;
			dropped = m.dropped;
			log('host tool list: ' + hostTools.length + ' tools');
			notifyChanged();
		}
		// a join (or a role change that comes with it) can change what the host offers
		const j = await engine.joined().catch(() => false);
		if (j !== wasJoined) {
			wasJoined = j;
			log(j ? 'in the session' : 'not in the session');
		}
	}

	/** @param {string} link */
	async function connect(link) {
		const parsed = parseLink(link); // throws a readable error on a bad link
		if (engine && engine.hostId === parsed.peerId && engine.link.origin === parsed.origin && !['failed', 'closed'].includes(engine.state)) {
			return starting;
		}
		if (engine) {
			const old = engine;
			engine = null;
			await old.close().catch(() => {});
			if (!opts.staticTools && hostTools.length) {
				hostTools = [];
				signature = toolSignature(hostTools);
				notifyChanged();
			}
		}
		engine = opts.createEngine(link);
		wasJoined = false;
		const mine = engine;
		starting = engine
			.start()
			.then(() => refreshTools())
			.catch((/** @type {any} */ e) => log('connect failed: ' + e.message));
		if (!poll) {
			poll = setInterval(() => refreshTools().catch(() => {}), opts.pollMs ?? 5000);
			poll.unref?.();
		}
		mine.on?.('closed', () => {
			if (engine === mine && !opts.staticTools && hostTools.length) {
				hostTools = [];
				signature = toolSignature(hostTools);
				notifyChanged();
			}
		});
		return starting;
	}

	async function statusInfo() {
		if (!engine) return { state: 'idle', note: 'not connected: call connect with the session link (https://theprototype.app/#<id>)' };
		/** @type {any} */
		const out = { ...engine.describe() };
		let joined = false;
		if (engineReady()) {
			try {
				const s = await engine.status();
				out.session = s;
				joined = await engine.joined();
			} catch (e) {
				out.sessionError = /** @type {any} */ (e).message;
			}
		}
		out.joined = joined;
		out.tools = hostTools.map((t) => t.name);
		if (dropped.length) out.toolsNotOffered = dropped;
		const role = out.session && out.session.role;
		if (out.state === 'failed') out.note = 'the agent could not start: ' + (out.error || 'unknown error');
		else if (!engineReady()) out.note = 'starting the agent (' + out.state + ')…';
		else if (!joined) out.note = 'waiting for the host to let you in: ask them to Approve the join, or to send an invite link.';
		else if (role === 'viewer') out.note = 'you are a VIEWER: your edits stay on your side. Ask the host for edit access or an Edit invite.';
		else if (out.session && out.session.withHost === false)
			out.note = 'the host is in another scene (' + JSON.stringify(out.session.hostScene || '') + ')' + (out.session.following ? ' — following them there; edits wait until you arrive.' : ' and edits would not reach them — wait for withHost, or ask the host.');
		else out.note = 'in the session — the scene tools are live.';
		return out;
	}

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...builtins, ...hostTools] }));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const name = req.params.name;
		const a = /** @type {any} */ (req.params.arguments || {});
		try {
			if (name === 'connect') {
				const link = a.link || a.peer_id || a.url;
				if (!link) return textResult({ error: 'pass the session link: connect({ link: "https://theprototype.app/#F0FD3" })' }, true);
				const p = connect(String(link));
				await Promise.race([p, sleep(opts.connectWaitMs ?? CONNECT_WAIT_MS)]);
				const st = await statusInfo();
				if (engineReady()) {
					const guide = await engine.systemPrompt().catch(() => '');
					if (guide) st.guide = guide;
				}
				return textResult(st, st.state === 'failed');
			}
			if (name === 'status' || (name === 'get_status' && opts.kind === 'wire')) return textResult(await statusInfo());
			if (!engine) return textResult({ error: 'not connected', note: 'call connect with the session link first' }, true);
			if (name === 'screenshot' && reserved.includes('screenshot')) {
				if (!engineReady()) return textResult({ error: 'the agent page is not up yet (' + engine.state + ')' }, true);
				const shot = await engine.screenshot({ view: a.view, uuid: a.uuid, size: a.size });
				/** @type {any[]} */
				const content = [{ type: 'image', data: shot.data, mimeType: shot.mimeType || 'image/png' }];
				if (shot.note) content.push({ type: 'text', text: shot.note });
				return { content };
			}
			if (name === 'wait_for_edit' && reserved.includes('wait_for_edit')) {
				if (!engineReady()) return textResult({ error: 'the agent page is not up yet (' + engine.state + ')' }, true);
				const ms = Math.max(1000, Math.min(WAIT_EDIT_MAX_MS, Number(a.timeout_ms) || 30000));
				const r = await engine.waitForEdit(ms);
				return textResult(r, resultIsError(r));
			}
			if (!hostTools.some((t) => t.name === name)) {
				return textResult({ error: 'unknown tool: ' + name, note: engineReady() ? 'call status for the tools this session offers' : 'the scene tools appear once connected' }, true);
			}
			if (!engineReady() || !(await engine.joined())) {
				return textResult(
					{
						error: 'not in the session yet',
						state: engine.state,
						note: 'ask the host to Approve the join (or send an invite link), then retry; status says when you are in.'
					},
					true
				);
			}
			const r = await engine.exec(name, a);
			refreshTools().catch(() => {});
			if (r && r.__missing) return textResult({ error: 'this app build has no exec()' }, true);
			return textResult(r, resultIsError(r));
		} catch (e) {
			return textResult({ error: String(/** @type {any} */ (e).message || e).split('\n')[0] }, true);
		}
	});

	async function shutdown() {
		if (closed) return;
		closed = true;
		if (poll) clearInterval(poll);
		const e = engine;
		engine = null;
		if (e) await Promise.race([e.close().catch(() => {}), sleep(4000)]);
	}

	return {
		server,
		connect,
		refreshTools,
		statusInfo,
		shutdown,
		get engine() {
			return engine;
		},
		get hostTools() {
			return hostTools;
		}
	};
}

/** A display name from the MCP client's own (`claude-code` → "Claude"). @param {any} info */
export function nameFromClient(info) {
	const n = String((info && info.name) || '').trim();
	if (!n) return 'AI agent';
	if (/claude/i.test(n)) return 'Claude';
	const words = n.replace(/[-_]+/g, ' ').replace(/\b(mcp|client)\b/gi, '').trim();
	return (words ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : 'AI agent').slice(0, 32);
}

/**
 * stdio entry point.
 * @param {Record<string, any>} args parsed CLI flags
 * @param {{ kind: 'browser'|'wire', link: string | null, makeEngine: (link: string, name: string) => any, staticTools?: any[] }} deps
 */
export async function runMcp(args, deps) {
	// stdout is the protocol: anything a dependency prints goes to stderr instead
	console.log = (...m) => console.error(...m);
	console.info = (...m) => console.error(...m);
	const log = (/** @type {string} */ m) => console.error('[agent] ' + m);
	let name = args.name || null;
	const bridge = createBridgeServer({
		kind: deps.kind,
		staticTools: deps.staticTools,
		createEngine: (link) => deps.makeEngine(link, name || nameFromClient(bridge.server.getClientVersion())),
		log: args.verbose ? log : () => {}
	});

	let exiting = false;
	const exit = async (/** @type {string} */ why) => {
		if (exiting) return;
		exiting = true;
		log('leaving the session (' + why + ')');
		await bridge.shutdown();
		process.exit(0);
	};
	for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) process.on(sig, () => exit(sig));
	process.stdin.on('end', () => exit('client closed stdin'));

	// the first connect waits for initialize, so the agent can carry the client's name
	bridge.server.oninitialized = () => {
		if (deps.link) bridge.connect(deps.link).catch((e) => log('connect failed: ' + e.message));
	};
	bridge.server.onclose = () => exit('transport closed');
	await bridge.server.connect(new StdioServerTransport());
	log('MCP stdio server ready (' + deps.kind + ' engine' + (deps.link ? ', joining as soon as the client initializes' : ', call connect to join a session') + ')');
	return bridge;
}
