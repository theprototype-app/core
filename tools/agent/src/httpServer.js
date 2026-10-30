// `theprototype-agent serve --port <n>` (roadmap 56 C18): the same bridge as `mcp`, as streamable HTTP MCP on
// 127.0.0.1, so a Claude Code that is already running joins with no MCP restart.
//
// It answers loopback only: the listener binds 127.0.0.1, and a request whose Host or Origin is another site
// is refused, or any web page could reach it through DNS rebinding and drive this agent's session.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createBridgeServer, nameFromClient } from './mcpServer.js';

/** import_model / import_file carry a 25 MB file as base64 */
const MAX_BODY = 40 * 1024 * 1024;
const LOOPBACK = /^(127\.0\.0\.1|localhost)(:\d+)?$/i;

/** Is this request from this machine's own clients? @param {import('node:http').IncomingHttpHeaders} headers */
export function loopbackRequest(headers) {
	if (!LOOPBACK.test(String(headers.host ?? ''))) return false;
	const origin = headers.origin;
	if (!origin) return true; // a CLI sends none; a browser always does across origins
	try {
		return LOOPBACK.test(new URL(String(origin)).host);
	} catch {
		return false;
	}
}

/** @param {import('node:http').IncomingMessage} req @returns {Promise<any>} */
function readJson(req) {
	return new Promise((resolve, reject) => {
		/** @type {Buffer[]} */
		const parts = [];
		let size = 0;
		req.on('data', (c) => {
			size += c.length;
			if (size > MAX_BODY) {
				reject(Object.assign(new Error('request too large'), { status: 413 }));
				req.destroy();
			} else parts.push(c);
		});
		req.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));
			} catch {
				reject(Object.assign(new Error('not JSON'), { status: 400 }));
			}
		});
		req.on('error', reject);
	});
}

/**
 * @param {import('node:http').ServerResponse} res @param {number} status @param {string} message
 */
function refuse(res, status, message) {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * The listener over a bridge. One client at a time: a new initialize (a restarted client) takes the bridge over,
 * and the session the agent joined stays up.
 * @param {ReturnType<typeof createBridgeServer>} bridge @param {number} port
 * @returns {Promise<import('node:http').Server>}
 */
export function listenHttp(bridge, port) {
	/** @type {StreamableHTTPServerTransport | null} */
	let transport = null;
	const http = createServer(async (req, res) => {
		try {
			if (!loopbackRequest(req.headers)) return refuse(res, 403, 'loopback clients only');
			if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') return refuse(res, 404, 'the endpoint is /mcp');
			const body = req.method === 'POST' ? await readJson(req) : undefined;
			if (body !== undefined && isInitializeRequest(body)) {
				if (transport) await bridge.server.close();
				transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
				await bridge.server.connect(transport);
			}
			if (!transport) return refuse(res, 400, 'initialize first');
			await transport.handleRequest(req, res, body);
		} catch (e) {
			if (!res.headersSent) refuse(res, /** @type {any} */ (e).status ?? 500, String(/** @type {any} */ (e).message ?? e));
		}
	});
	return new Promise((resolve, reject) => {
		http.once('error', reject);
		http.listen(port, '127.0.0.1', () => resolve(http));
	});
}

/** @param {Record<string, any>} args @param {any} deps */
export async function runHttp(args, deps) {
	const port = Number(args.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('serve needs --port <1-65535>');
	const log = (/** @type {string} */ m) => console.error('[agent] ' + m);
	let name = args.name || null;
	const bridge = createBridgeServer({
		kind: deps.kind,
		staticTools: deps.staticTools,
		createEngine: (link) => deps.makeEngine(link, name || nameFromClient(bridge.server.getClientVersion())),
		log: args.verbose ? log : () => {}
	});
	const http = await listenHttp(bridge, port);
	if (deps.link) bridge.connect(deps.link).catch((/** @type {any} */ e) => log('connect failed: ' + e.message));
	let exiting = false;
	const exit = async (/** @type {string} */ why) => {
		if (exiting) return;
		exiting = true;
		log('leaving the session (' + why + ')');
		http.close();
		await bridge.shutdown();
		process.exit(0);
	};
	for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) process.on(sig, () => exit(sig));
	log('MCP HTTP server ready: http://127.0.0.1:' + port + '/mcp (' + deps.kind + ' engine' + (deps.link ? '' : ', call connect to join') + ')');
	return { bridge, http };
}
