// The chat half of the bridge (roadmap 56 C2-C4, C6, C8, C11). Pure apart from the image spool's disk writes.
//
// An MCP host cannot be woken by a server, so a message typed in the app's AI assistant window waits in the
// agent page's inbox until the agent PICKS IT UP: `wait_for_message` long-polls `tpAgent.nextMessage`, the
// agent acts, `reply` streams the answer back into the window, and it waits again. The page owns every rule
// (the sender's role, viewers refused, Stop → `cancelled`, history on a chat switch); this file shapes what
// the model sees: the message as JSON, each image as an MCP image block AND a temp file whose path rides in
// the JSON (so a skill that wants a file — img2threejs — can take it as its reference).
import { mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

export const CHAT_TOOL_NAMES = ['wait_for_message', 'reply', 'ask', 'get_thread'];

/** wait_for_message: default and longest wait (seconds) */
export const WAIT_DEFAULT_S = 240;
export const WAIT_MAX_S = 600;
/** import_model: the largest local GLB the bridge reads (the app's own import cap) */
export const IMPORT_MAX_BYTES = 25 * 1024 * 1024;

/** The chat tools (browser engine only: the wire peer has no inbox). */
export function chatTools() {
	return [
		{
			name: 'wait_for_message',
			description:
				'Listen for the people in the session: blocks until someone types to you in the app\'s AI assistant window, then returns that message ' +
				'(id, chatId, from, name, role, text, images with a local file path each, answers = the ask it answers). Returns null when the timeout passes ' +
				'with no message — call it again to keep listening. Loop: wait_for_message → do the work with the scene tools → reply(final) → wait_for_message. ' +
				'role "viewer" = that person may not change the scene: answer, but do not edit for them (edits are refused). A message in a chat you have not ' +
				'seen carries history (its newest messages) + summary; get_thread pages further back.',
			inputSchema: {
				type: 'object',
				properties: { timeoutS: { type: 'number', description: 'seconds to wait (default ' + WAIT_DEFAULT_S + ', at most ' + WAIT_MAX_S + ')' } }
			}
		},
		{
			name: 'reply',
			description:
				'Answer in the app\'s AI assistant window (everyone in the session sees the thread). Each call adds a paragraph to ONE streamed reply ' +
				'(people watch it grow); final: true finishes it and ends your "working" state. Without `to` it answers the message you are working on. ' +
				'When the user typed to you in THIS terminal instead, pass their words as `prompt` so the app shows that turn too ("via terminal"). ' +
				'After Stop, reply answers cancelled until you send final.',
			inputSchema: {
				type: 'object',
				properties: {
					text: { type: 'string', description: 'what to say (a paragraph added to your reply)' },
					final: { type: 'boolean', description: 'true = this reply is complete' },
					to: { type: 'string', description: 'peer id to answer (default: the sender of the message you are working on)' },
					chatId: { type: 'string', description: 'default: the chat of the message you are working on' },
					prompt: { type: 'string', description: 'the user\'s own words typed in the terminal, echoed into the app before your reply' }
				},
				required: ['text']
			}
		},
		{
			name: 'ask',
			description:
				'Ask the person a question with buttons in the window ("Pine or oak?"). Their click arrives through wait_for_message as a message whose ' +
				'`answers` is the id this returns and whose text is the option chosen.',
			inputSchema: {
				type: 'object',
				properties: {
					question: { type: 'string' },
					options: { type: 'array', items: { type: 'string' }, description: 'button labels (at most 8)' },
					to: { type: 'string', description: 'peer id (default: the sender of the message you are working on)' },
					chatId: { type: 'string' }
				},
				required: ['question', 'options']
			}
		},
		{
			name: 'get_thread',
			description:
				'Read a chat in the app, oldest first: the `limit` messages before message id `before` (omit for the newest). `more` says older ones exist. ' +
				'Use it when a message\'s history is not enough.',
			inputSchema: {
				type: 'object',
				properties: {
					chatId: { type: 'string', description: 'default: the chat you are in' },
					before: { type: 'string', description: 'a message id; returns the messages before it' },
					limit: { type: 'number', description: 'default 20, at most 100' }
				}
			}
		}
	];
}

/** seconds → the clamped wait in ms @param {any} s */
export function waitMs(s) {
	const n = Number(s);
	const sec = Number.isFinite(n) && n > 0 ? Math.min(WAIT_MAX_S, Math.max(1, n)) : WAIT_DEFAULT_S;
	return Math.round(sec * 1000);
}

const EXT = /** @type {Record<string, string>} */ ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' });

/** a filename-safe id @param {any} s */
const safe = (s) => String(s ?? 'x').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'x';

/**
 * The temp files the images go to: `<tmp>/theprototype-agent/<session>/<chatId>/<msgId>-<n>.<ext>`, the
 * directories 0700 and the files 0600 (photos are private), removed when the bridge exits.
 */
export class ImageSpool {
	/** @param {{root?: string}} [o] */
	constructor(o = {}) {
		this.root = o.root ?? join(tmpdir(), 'theprototype-agent', process.pid + '-' + randomBytes(4).toString('hex'));
		this.made = false;
	}

	/**
	 * @param {string} chatId @param {string} msgId @param {number} n @param {{mimeType: string, data: string, name?: string}} im
	 * @returns {string} the file's path
	 */
	write(chatId, msgId, n, im) {
		const dir = join(this.root, safe(chatId));
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		this.made = true;
		const file = join(dir, safe(msgId) + '-' + n + '.' + (EXT[im.mimeType] ?? 'bin'));
		writeFileSync(file, Buffer.from(im.data, 'base64'), { mode: 0o600 });
		return file;
	}

	cleanup() {
		if (!this.made) return;
		try {
			rmSync(this.root, { recursive: true, force: true });
		} catch {}
		this.made = false;
	}
}

/**
 * A delivered message → MCP content: the JSON (image bytes replaced by their file paths) first, then one
 * image block per image (Claude sees them).
 * @param {any} msg @param {ImageSpool | null} spool
 */
export function messageContent(msg, spool) {
	const images = Array.isArray(msg.images) ? msg.images : [];
	/** @type {any[]} */
	const blocks = [];
	/** @type {any[]} */
	const listed = [];
	images.forEach((/** @type {any} */ im, /** @type {number} */ i) => {
		if (!im || typeof im.data !== 'string') return;
		/** @type {any} */
		const row = { mimeType: im.mimeType };
		if (im.name) row.name = im.name;
		if (im.w && im.h) row.size = im.w + 'x' + im.h;
		if (spool) {
			try {
				row.path = spool.write(msg.chatId, msg.id, i + 1, im);
			} catch (e) {
				row.pathError = String(/** @type {any} */ (e).message || e).split('\n')[0];
			}
		}
		listed.push(row);
		blocks.push({ type: 'image', data: im.data, mimeType: im.mimeType });
	});
	const { images: _drop, ...rest } = msg;
	/** @type {any} */
	const out = { ...rest };
	if (listed.length) out.images = listed;
	if (msg.role === 'viewer') out.note = 'This person is a VIEWER: they may read and ask, but not change the scene. Edits for this request are refused — say so in your reply.';
	if (msg.imagesDropped) out.note = (out.note ? out.note + ' ' : '') + 'They attached images; viewers cannot attach, so they were dropped.';
	if (msg.history?.length) out.historyNote = 'You have not seen this chat in this session: history = its newest messages, summary = the whole of it; get_thread pages back.';
	return [{ type: 'text', text: JSON.stringify(out) }, ...blocks];
}

/** the host's `import_model` schema plus the bridge's `path` (a local file) @param {any} tool */
export function withImportPath(tool) {
	if (!tool || tool.name !== 'import_model') return tool;
	const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object' };
	const properties = { ...(schema.properties ?? {}) };
	if (properties.path) return tool;
	properties.path = {
		type: 'string',
		description: 'a self-contained .glb on the machine running this bridge (≤ 25 MB); the bridge reads it and sends the bytes — use instead of data/url'
	};
	return {
		...tool,
		description: tool.description + (tool.description ? ' ' : '') + 'Local files: pass `path` (the bridge reads it).',
		inputSchema: { ...schema, properties }
	};
}

/**
 * `import_model` with a `path`: read the local file (≤ 25 MB, glTF binary magic), hand the page `data`.
 * The path never reaches the page. Throws a readable error.
 * @param {any} args @param {{read?: (p: string) => Buffer, size?: (p: string) => number, maxBytes?: number}} [io]
 */
export function importModelArgs(args, io = {}) {
	if (!args || typeof args.path !== 'string' || !args.path) return args;
	const { path, ...rest } = args;
	if (rest.data || rest.url) throw new Error('import_model: pass one of path, data or url');
	const max = io.maxBytes ?? IMPORT_MAX_BYTES;
	let size;
	try {
		size = (io.size ?? ((p) => statSync(p).size))(path);
	} catch (e) {
		throw new Error('import_model: cannot read ' + path + ' (' + String(/** @type {any} */ (e).code || /** @type {any} */ (e).message) + ')');
	}
	if (size > max) throw new Error('import_model: ' + basename(path) + ' is ' + (size / 1048576).toFixed(1) + ' MB; the limit is ' + max / 1048576 + ' MB');
	const buf = (io.read ?? ((p) => readFileSync(p)))(path);
	if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'glTF')
		throw new Error('import_model: ' + basename(path) + ' is not a binary glTF (.glb) — export a self-contained GLB (no external files)');
	return { ...rest, data: buf.toString('base64'), name: rest.name ?? basename(path).replace(/\.glb$/i, '') };
}
