// REPL mode (roadmap 10 B4 → 55 A3 → 56 C3/C4): your own OpenAI-compatible model drives the scene. Either
// engine: the browser engine hands the model the host app's own tools and system prompt; the wire engine its
// fixed object catalog. Slash commands: /status /tools /raw <tool> <json> /quit.
//
// 56: the bridge owns the model loop here, so a message typed in the app's AI assistant window goes STRAIGHT
// IN as a user turn — no terminal needed after launch. Terminal lines and app messages share ONE transcript,
// run one at a time; the reply streams into the window (and the terminal), terminal turns show "via
// terminal", and Stop in the window ends the turn (the page answers `cancelled` to the next tool call).
import readline from 'node:readline';
import { runChat } from './llmClient.js';
import { mapHostTools } from './mcpTools.js';
import { redactLink } from './link.js';

/** how often a streamed reply is pushed to the window (each push carries the full text so far) */
const FLUSH_MS = 250;
/** how long one app wait lasts before it re-arms */
const APP_WAIT_MS = 25000;

/**
 * One REPL conversation over an engine. Exported for the tests (a fake engine + a stub endpoint).
 * @param {Object} o
 * @param {any} o.engine
 * @param {{apiUrl: string, apiKey: string, model: string}} o.cfg
 * @param {(s: string) => void} [o.out] terminal output
 * @param {(s: string) => void} [o.log] stderr notes
 * @param {number} [o.flushMs]
 * @param {number} [o.appWaitMs]
 */
export function createReplSession(o) {
	const { engine, cfg } = o;
	const out = o.out ?? ((s) => process.stdout.write(s));
	const log = o.log ?? ((s) => console.error('[agent] ' + s));
	const flushMs = o.flushMs ?? FLUSH_MS;
	/** does this page take app messages? (browser engine on tpAgent 1.1.0) */
	let chatOn = engine.kind === 'browser' && typeof engine.chat === 'function';
	/** @type {any[]} */
	const history = [];
	/** @type {Promise<any>} */
	let busy = Promise.resolve();
	let pendingTerminal = 0;
	let closed = false;
	/** @type {string | null} */
	let waitToken = null;

	const toolsFor = async () => mapHostTools(await engine.tools(), []).tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema }));

	/** @param {string} method @param {...any} args */
	const chat = (method, ...args) => (chatOn ? engine.chat(method, ...args) : Promise.resolve(null));

	/** @param {() => Promise<any>} fn */
	function enqueue(fn) {
		const job = busy.then(fn);
		busy = job.catch(() => {});
		return job;
	}

	/**
	 * A streamed reply into the window: deltas batched every flushMs, the last push final.
	 * @param {any} ids replyTo/to/chatId for an app request, or {via:'cli'} for a terminal turn
	 */
	function streamer(ids) {
		let pending = '';
		let any = false;
		let lastRound = 0;
		/** @type {ReturnType<typeof setTimeout> | null} */
		let timer = null;
		let sending = Promise.resolve();
		const push = (/** @type {boolean} */ final) => {
			const delta = pending;
			pending = '';
			sending = sending.then(() => chat('reply', { ...ids, delta, final }).catch(() => null));
			return sending;
		};
		return {
			/** @param {string} t @param {number} round */
			delta(t, round) {
				if (any && round !== lastRound) {
					pending += '\n\n';
					out('\n\n');
				}
				lastRound = round;
				any = true;
				pending += t;
				out(t);
				if (!timer) timer = setTimeout(() => ((timer = null), push(false)), flushMs);
			},
			/** @param {string} [tail] */
			async end(tail) {
				if (timer) clearTimeout(timer);
				timer = null;
				if (tail) {
					pending += (any ? '\n\n' : '') + tail;
					out((any ? '\n\n' : '') + tail);
				}
				out('\n');
				return push(true);
			}
		};
	}

	/**
	 * Run one turn of the model with streaming. Returns 'done' | 'stopped'.
	 * @param {any} user the user message (text or content parts) @param {any} ids
	 */
	async function turn(user, ids) {
		if (!history.length) history.push({ role: 'system', content: await engine.systemPrompt() });
		history.push({ role: 'user', content: user });
		const s = streamer(ids);
		let stopped = false;
		try {
			await runChat({
				cfg,
				messages: history,
				tools: await toolsFor(),
				executeTool: (name, a) => engine.exec(name, a),
				onTool: (name, a) => out('\n  · ' + name + ' ' + summarizeArgs(a) + '\n'),
				onDelta: (t, round) => s.delta(t, round),
				stopOn: (r) => {
					if (r && r.cancelled) stopped = true;
					return stopped;
				}
			});
		} catch (e) {
			const msg = String(/** @type {any} */ (e).message || e).split('\n')[0];
			// an endpoint without vision: say so once and go on in text
			if (Array.isArray(user) && /image|vision|content/i.test(msg) && !/^API 401/.test(msg)) {
				history.pop();
				const text = user.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
				log('this model refused the images (' + msg.slice(0, 80) + '); retrying without them');
				return turn(text + '\n(The person attached images, but this model cannot see images.)', ids);
			}
			await s.end('Error: ' + msg);
			throw e;
		}
		await s.end(stopped ? '(stopped)' : undefined);
		if (stopped) history.push({ role: 'system', content: 'The person pressed Stop: that request was cancelled. Do not continue it.' });
		return stopped ? 'stopped' : 'done';
	}

	/** A line typed in the terminal: echoed into the app's thread as "via terminal", then answered. @param {string} text */
	function terminal(text) {
		pendingTerminal++;
		if (waitToken) chat('abortWait', waitToken).catch(() => {});
		return enqueue(async () => {
			try {
				await chat('reply', { prompt: text, via: 'cli' }).catch(() => null);
				return await turn(text, { via: 'cli' });
			} finally {
				pendingTerminal--;
			}
		});
	}

	/** A message typed in the app's window, as a user turn. @param {any} msg */
	function appTurn(msg) {
		return enqueue(async () => {
			const who = (msg.name || String(msg.from || '').toUpperCase() || 'someone') + ' (' + (msg.role || 'editor') + ')';
			out('\n[app] ' + who + ': ' + (msg.text || '') + (msg.images?.length ? ' [' + msg.images.length + ' image' + (msg.images.length > 1 ? 's' : '') + ']' : '') + '\n');
			if (msg.history?.length) {
				const lines = msg.history.map((/** @type {any} */ h) => (h.name || h.from) + (h.via === 'cli' ? ' (terminal)' : '') + ': ' + String(h.text || '').slice(0, 400));
				history.push({ role: 'system', content: 'Earlier in this chat (' + msg.chatId + '). ' + (msg.summary || '') + '\n' + lines.join('\n') });
			}
			let text = '[' + who + ' in the app' + (msg.answers ? ', answering your question' : '') + ']: ' + (msg.text || '');
			if (msg.role === 'viewer') text += '\n(This person is a VIEWER: answer, but do not change the scene for them — edits are refused.)';
			const user = msg.images?.length
				? [{ type: 'text', text }, ...msg.images.map((/** @type {any} */ im) => ({ type: 'image_url', image_url: { url: 'data:' + im.mimeType + ';base64,' + im.data } }))]
				: text;
			return turn(user, { replyTo: msg.id, to: msg.from, chatId: msg.chatId }).catch((e) => log('turn failed: ' + e.message));
		});
	}

	/** Pick up app messages until stopped (each one waits for the turn before it). */
	async function appLoop() {
		if (!chatOn) return;
		await chat('chatStatus', null, { mode: 'repl', model: cfg.model }).catch(() => {});
		while (!closed) {
			await busy;
			if (closed) break;
			const token = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
			waitToken = token;
			let msg;
			try {
				msg = await engine.chat('nextMessage', o.appWaitMs ?? APP_WAIT_MS, token);
			} catch (e) {
				waitToken = null;
				if (/no agent chat/.test(String(/** @type {any} */ (e).message))) {
					log('this app build has no agent chat: only the terminal talks to the model');
					chatOn = false;
					return;
				}
				await new Promise((r) => setTimeout(r, 1000));
				continue;
			}
			waitToken = null;
			if (!msg) continue;
			if (pendingTerminal > 0) {
				// a terminal line got in first: this one goes back and waits its turn
				await chat('requeue', msg).catch(() => {});
				continue;
			}
			appTurn(msg);
		}
	}

	return {
		history,
		terminal,
		appTurn,
		appLoop,
		toolsFor,
		get busy() {
			return busy;
		},
		get chatOn() {
			return chatOn;
		},
		stop() {
			closed = true;
			if (waitToken) chat('abortWait', waitToken).catch(() => {});
		}
	};
}

/**
 * @param {Record<string, any>} args
 * @param {string} link
 * @param {(link: string) => any} makeEngine
 */
export async function runRepl(args, link, makeEngine) {
	const cfg = {
		apiUrl: args['api-url'] || process.env.AGENT_API_URL,
		apiKey: args['api-key'] || process.env.AGENT_API_KEY || '',
		model: args.model || process.env.AGENT_MODEL
	};
	if (!cfg.apiUrl || !cfg.model) throw new Error('repl needs --api-url and --model (or env AGENT_API_URL / AGENT_MODEL)');

	const engine = makeEngine(link);
	/** @type {ReturnType<typeof createReplSession> | null} */
	let session = null;
	const quit = async (/** @type {number} */ code) => {
		session?.stop();
		await engine.close().catch(() => {});
		process.exit(code);
	};
	process.on('SIGINT', () => quit(0));
	process.on('SIGTERM', () => quit(0));
	console.error('[agent] joining ' + redactLink(link) + ' (' + engine.kind + ' engine)…');
	await engine.start();
	console.error('[agent] waiting for the host to let us in (Approve, or an invite link)…');
	const t0 = Date.now();
	while (!(await engine.joined())) {
		if (Date.now() - t0 > (Number(args['approval-timeout']) || 120) * 1000) {
			console.error('[agent] not let in within the approval timeout');
			return quit(1);
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	session = createReplSession({ engine, cfg });
	const s = session;
	console.error(
		'[agent] in the session. Type a request, or /help. Ctrl+C to quit.' +
			(s.chatOn ? ' People can also type to ' + cfg.model + ' in the app\'s AI assistant window.' : '') +
			'\n'
	);

	const interactive = !!process.stdin.isTTY;
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'scene> ', terminal: interactive });
	s.appLoop().catch((e) => console.error('[agent] app messages stopped: ' + e.message));
	rl.prompt();

	rl.on('line', async (line) => {
		const text = line.trim();
		if (!text) return rl.prompt();
		try {
			if (text.startsWith('/')) {
				if ((await handleSlash(text, engine, s.toolsFor)) === 'quit') return quit(0);
			}
			else await s.terminal(text);
		} catch (e) {
			console.error('[agent] error: ' + /** @type {any} */ (e).message + '\n');
		}
		rl.prompt();
	});
	// a closed stdin (a script, `--repl < /dev/null`) keeps the agent answering the app; Ctrl+C quits
	rl.on('close', () => {
		if (interactive || !s.chatOn) quit(0);
	});
}

/** @param {any} a */
function summarizeArgs(a) {
	for (const k of ['objects', 'updates', 'uuids', 'nodes']) if (Array.isArray(a?.[k])) return '(' + a[k].length + ' ' + k + ')';
	return '';
}

/** @param {string} text @param {any} engine @param {() => Promise<any[]>} toolsFor @returns {Promise<'quit' | void>} */
async function handleSlash(text, engine, toolsFor) {
	const [cmd, ...rest] = text.slice(1).split(/\s+/);
	if (cmd === 'quit' || cmd === 'q' || cmd === 'exit') return 'quit';
	if (cmd === 'status') console.log(JSON.stringify({ ...engine.describe(), session: await engine.status() }, null, 2));
	else if (cmd === 'tools') for (const t of await toolsFor()) console.log('  ' + t.name);
	else if (cmd === 'raw') {
		const [name, ...json] = rest;
		try {
			console.log(JSON.stringify(await engine.exec(name, json.length ? JSON.parse(json.join(' ')) : {}), null, 2));
		} catch (e) {
			console.log('bad call: ' + /** @type {any} */ (e).message);
		}
	} else if (cmd === 'help') console.log('/status  /tools  /raw <tool> <json>  /quit — anything else is a request for the model');
	else console.log('unknown command /' + cmd + ' (try /help)');
}
