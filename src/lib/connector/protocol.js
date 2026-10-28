// Roadmap 86 B1/B5 — THE TAB'S HALF OF THE CLAUDE CONNECTOR WIRE. Imports NOTHING (the unit layer's
// entry rule): the frames the person's own tab exchanges with its Durable Object relay, the close
// codes, the size caps, and which tools a relayed call may name. The contract is 86-a's
// `worker-mcp/PROTOCOL.md` (cloud repo) § 1 — the shape 86-b proposed (QUESTIONS-86-b Q1) with 86-a's
// seven deltas (QUESTIONS-86-a A1): exact ping text, `replaces` on pair, `connections`, `scope` +
// `connection` on a call, the `revoked` frame, close 4008.
//
//   claude.ai ──MCP──▶ Worker ──one DO per connection──▶ WebSocket ──▶ THIS TAB ──▶ tpAgent.exec
//
// Every frame is one JSON object. Nothing here trusts a frame: `parseFrame` answers null for
// anything that is not exactly one of the shapes below, and a call's ARGS are validated later
// against the tool's own schema (argsSchema.js) — the same schema a local agent reads.

/** the wire version the tab speaks (`hello.v`) */
export const CONNECTOR_PROTOCOL = 1;

/** the largest frame the tab accepts from the relay (bytes of JSON text) */
export const MAX_INBOUND_BYTES = 256 * 1024;
/** the largest result the tab sends back: the DO accepts 4 MB, but the platform's WebSocket message limit
 * (1 MiB) is the real ceiling (PROTOCOL.md § 1.3) — kept under it with room for the frame around it */
export const MAX_RESULT_BYTES = 1000 * 1000;
/** a screenshot's base64 the Worker still passes on (PROTOCOL.md § 1.3) */
export const MAX_IMAGE_BASE64 = 1000 * 1000 - 4096;
/** a call id: what the DO numbers its requests with */
export const MAX_ID_LENGTH = 64;
/** calls the tab runs at once before answering `busy` (tpAgent.exec queues them one at a time anyway) */
export const MAX_IN_FLIGHT = 8;

/** keepalive: the tab pings this often; two unanswered pings = the link is dead */
export const PING_MS = 25 * 1000;
/** the DO must answer `hello` within this long */
export const HELLO_TIMEOUT_MS = 10 * 1000;
/** reconnect backoff after a blip: first wait, cap */
export const RECONNECT_FIRST_MS = 1000;
export const RECONNECT_MAX_MS = 30 * 1000;
/** a tab hidden this long has its timers throttled by the browser (Chrome: 1/min after 5 min) */
export const HIDDEN_THROTTLE_MS = 5 * 60 * 1000;

/** close codes the DO sends that mean "do NOT reconnect" */
export const CLOSE = /** @type {const} */ ({
	normal: 1000,
	revoked: 4001,
	replaced: 4002,
	refused: 4003,
	expired: 4004,
	/** a protocol violation the DO saw — healed like a blip */
	violation: 4008
});

/** @param {number} code @returns {'revoked'|'replaced'|'refused'|'expired'|'blip'|'normal'} */
export function closeReason(code) {
	if (code === CLOSE.normal) return 'normal';
	if (code === CLOSE.revoked) return 'revoked';
	if (code === CLOSE.replaced) return 'replaced';
	if (code === CLOSE.refused) return 'refused';
	if (code === CLOSE.expired) return 'expired';
	return 'blip';
}

/** a close the tab should heal on its own (a network blip, a DO restart, an idle expiry → re-pair) @param {number} code */
export function shouldReconnect(code) {
	const r = closeReason(code);
	return r === 'blip' || r === 'expired';
}

/** The three bridge tools a connector answers beside the scene tools (the 55 bridge's names, mcpTools.js). */
export const BRIDGE_TOOLS = /** @type {const} */ (['status', 'screenshot', 'wait_for_edit']);

/**
 * 86 B5 / QUESTIONS Q3: agent-PAGE tools a remote caller may NOT reach in a person's tab — they load
 * code into it (install_modules), press the person's own buttons (an approval, a role offer), or end
 * their session. The person keeps those.
 */
export const CONNECTOR_BLOCKED_TOOLS = new Set(['install_modules', 'pending_offers', 'accept_offer', 'leave', 'connect']);

/** the wait_for_edit cap a connector call may ask for (the bridge's own) */
export const MAX_WAIT_MS = 120 * 1000;

/** error codes a relayed call can answer with */
export const ERROR_CODES = /** @type {const} */ ([
	'invalid_args',
	'unknown_tool',
	'refused',
	'hidden',
	'cancelled',
	'busy',
	'too_large',
	'failed'
]);

/** @param {any} c @returns {{id: string, client: string, scopes: string[], lastUsed: number}[]} */
function grants(c) {
	if (!Array.isArray(c)) return [];
	return c
		.filter((g) => isPlainObject(g) && isId(g.id))
		.slice(0, 50)
		.map((g) => ({
			id: g.id,
			client: String(g.client ?? 'Claude').slice(0, 40),
			scopes: Array.isArray(g.scopes) ? g.scopes.filter((/** @type {any} */ x) => typeof x === 'string').slice(0, 8) : [],
			lastUsed: Number.isFinite(Number(g.lastUsed)) ? Number(g.lastUsed) : 0
		}));
}

/** @param {any} v */
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** @param {any} v */
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH;
// tool names: what every MCP host accepts (mcpTools.js NAME)
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * One frame from the relay, or null when it is not one we speak. Never throws.
 * @param {unknown} text
 * @returns {null
 *  | {type: 'ready', connection: {id: string, client: string, account: string}, connections: {id: string, client: string, scopes: string[], lastUsed: number}[]}
 *  | {type: 'refused', reason: string}
 *  | {type: 'call', id: string, tool: string, args: Record<string, any>, timeoutMs: number|null, scope: 'read'|'edit', connection: string}
 *  | {type: 'cancel', id: string}
 *  | {type: 'revoked', connection: string}
 *  | {type: 'ping', t: number}
 *  | {type: 'pong', t: number}}
 */
export function parseFrame(text) {
	if (typeof text !== 'string' || text.length > MAX_INBOUND_BYTES) return null;
	/** @type {any} */
	let f;
	try {
		f = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isPlainObject(f) || typeof f.type !== 'string') return null;
	switch (f.type) {
		case 'ready': {
			const c = f.connection;
			if (!isPlainObject(c) || !isId(c.id)) return null;
			return {
				type: 'ready',
				connection: { id: c.id, client: String(c.client ?? 'Claude').slice(0, 40) || 'Claude', account: typeof c.account === 'string' ? c.account.slice(0, 80) : '' },
				connections: grants(f.connections)
			};
		}
		case 'refused':
			return { type: 'refused', reason: String(f.reason ?? '').slice(0, 200) };
		case 'call': {
			if (!isId(f.id) || typeof f.tool !== 'string' || !TOOL_NAME.test(f.tool)) return null;
			if (f.args !== undefined && !isPlainObject(f.args)) return null;
			const t = Number(f.timeoutMs);
			return {
				type: 'call',
				id: f.id,
				tool: f.tool,
				args: f.args ?? {},
				timeoutMs: Number.isFinite(t) && t > 0 ? t : null,
				// a call that does not say 'edit' is read-only (fail closed)
				scope: f.scope === 'edit' ? 'edit' : 'read',
				connection: isId(f.connection) ? f.connection : ''
			};
		}
		case 'cancel':
			return isId(f.id) ? { type: 'cancel', id: f.id } : null;
		case 'revoked':
			return isId(f.connection) ? { type: 'revoked', connection: f.connection } : null;
		case 'ping':
		case 'pong': {
			const t = Number(f.t);
			return { type: f.type, t: Number.isFinite(t) ? t : 0 };
		}
		default:
			return null;
	}
}

/** @param {string} token @param {string} version @param {string[]} tools */
export const helloFrame = (token, version, tools) =>
	JSON.stringify({ type: 'hello', v: CONNECTOR_PROTOCOL, token, app: { version: String(version) }, tools });

/** @param {boolean} visible */
export const stateFrame = (visible) => JSON.stringify({ type: 'state', visible, connectorVersion: CONNECTOR_PROTOCOL });

/** 86-a Δ1: EXACTLY this text — the DO answers it by hibernation auto-response, which needs a fixed string */
export const PING_TEXT = '{"type":"ping"}';
/** the answer to a ping the DO sends (it does not today; answered anyway) */
export const PONG_TEXT = '{"type":"pong"}';

export const byeFrame = () => JSON.stringify({ type: 'bye' });

/**
 * The answer to one call: a result, or a coded error. A result too big to send becomes `too_large`.
 * @param {string} id
 * @param {{result: any} | {error: {code: string, message: string}}} answer
 * @returns {string}
 */
export function answerFrame(id, answer) {
	if ('error' in answer) {
		const code = ERROR_CODES.includes(/** @type {any} */ (answer.error.code)) ? answer.error.code : 'failed';
		return JSON.stringify({ type: 'error', id, error: { code, message: String(answer.error.message ?? '').slice(0, 1000) } });
	}
	let text;
	try {
		text = JSON.stringify({ type: 'result', id, result: answer.result ?? null });
	} catch {
		return answerFrame(id, { error: { code: 'failed', message: 'the result could not be serialised' } });
	}
	if (text.length > MAX_RESULT_BYTES) return answerFrame(id, { error: { code: 'too_large', message: 'the result is too large to send — ask for less (a smaller screenshot, a page of the scene)' } });
	return text;
}
