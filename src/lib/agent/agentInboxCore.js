// Roadmap 56 C2-C6 + C11 — THE AGENT PAGE's INBOX: what people type to the agent in the AI assistant window,
// held until the agent's bridge picks it up (`tpAgent.nextMessage`), and what the agent says back. Imports
// NOTHING (the unit layer's entry rule); agentInbox.js wires the real stores and the peer link.
//
// One replicated message type, `{type:'agentchat'}`, fields discriminate (the shape 56-chat's window
// renders — handovers/QUESTIONS-56-bridge.md Q1):
//   request  {id, chatId, to, from, text, images?, answers?}   person → agent (everyone sees it: F1)
//   reply    {id, chatId, from, to, replyTo, text, partial?, via?}   agent → all; `text` is the FULL text so
//            far (a lost partial is harmless), the last copy has no `partial`
//   terminal {id, chatId, from, role:'user', via:'cli', text}   a turn the user typed in the agent's terminal
//   ask      {id, chatId, from, to, ask: {question, options}}   buttons; the click is a request with `answers`
//   cancel   {cancel: requestId, chatId, from, to}               Stop
//   status   {from, status, muted?, chatId?}                     listening | working | away
//   mute     {to, from, mute}                                    host / admin only
//
// The rules this file owns (they hold whatever the model does):
//   · the sender is the CONNECTION's peer id and its role is ours to look up (`roleOf`) — a `from` or a
//     `role` inside the payload is never believed;
//   · a viewer's request is delivered as `role:'viewer'` without its images, and while it is the running
//     request every edit is refused (`gate`);
//   · Stop marks the running request cancelled: every gated call answers `cancelled` until the next request;
//   · muted (by the host or an admin) → nothing is delivered;
//   · the first request in a chat other than the one the agent last saw carries that chat's history (the
//     newest HISTORY_COUNT messages + a summary), because the agent's own memory does not have it (C11).

/** messages a chat switch hands the agent */
export const HISTORY_COUNT = 20;
/** messages kept per chat in this page's memory */
export const LOG_CAP = 500;
/** requests waiting for the agent, at most */
export const QUEUE_CAP = 50;
/** images per request (C8: the composer sends ≤ 4) */
export const MAX_IMAGES = 4;
/** the base64 of one image, at most (~1 MB of bytes, with headroom) */
export const MAX_IMAGE_B64 = 1_600_000;
/** characters of one message's text */
export const MAX_TEXT = 20_000;
/** no wait armed and nothing running for this long → `away` */
export const AWAY_AFTER_MS = 20_000;
/** the status is re-sent this often (a late joiner's badge, and a sign of life) */
export const HEARTBEAT_MS = 20_000;
/** longest nextMessage wait */
export const MAX_WAIT_MS = 10 * 60 * 1000;

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** @param {unknown} v */
export const isId = (v) => typeof v === 'string' && ID.test(v);

/** @param {unknown} v */
const str = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * A request's images, checked: known image types, bounded base64, at most MAX_IMAGES.
 * @param {unknown} list @returns {{mimeType: string, data: string, name?: string, w?: number, h?: number}[]}
 */
export function cleanImages(list) {
	if (!Array.isArray(list)) return [];
	/** @type {any[]} */
	const out = [];
	for (const im of list) {
		if (out.length >= MAX_IMAGES) break;
		if (!im || typeof im !== 'object') continue;
		let data = typeof im.data === 'string' ? im.data : '';
		let mimeType = typeof im.mimeType === 'string' ? im.mimeType.toLowerCase() : '';
		const m = /^data:([^;,]+);base64,/.exec(data);
		if (m) {
			mimeType = mimeType || m[1].toLowerCase();
			data = data.slice(m[0].length);
		}
		if (!IMAGE_TYPES.has(mimeType) || !data || data.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 200))) continue;
		/** @type {any} */
		const row = { mimeType, data };
		if (typeof im.name === 'string' && im.name) row.name = im.name.slice(0, 120);
		if (Number.isFinite(im.w)) row.w = im.w;
		if (Number.isFinite(im.h)) row.h = im.h;
		out.push(row);
	}
	return out;
}

/**
 * A few lines saying what an earlier conversation was about — no model needed.
 * @param {{from?: string, name?: string, role?: string, text?: string, via?: string, at?: number, kind?: string}[]} earlier
 * @param {string} selfId
 */
export function summarizeThread(earlier, selfId) {
	const said = earlier.filter((m) => m.text && m.kind !== 'ask');
	if (!said.length) return '';
	/** @type {Map<string, number>} */
	const who = new Map();
	for (const m of said) {
		const n = m.from === selfId ? 'you (the agent)' : m.via === 'cli' ? 'your terminal' : m.name || m.from || 'someone';
		who.set(n, (who.get(n) ?? 0) + 1);
	}
	const clip = (/** @type {string} */ t) => {
		const one = t.replace(/\s+/g, ' ').trim();
		return one.length > 140 ? one.slice(0, 137) + '…' : one;
	};
	const first = said[0];
	const lastAsk = [...said].reverse().find((m) => m.from !== selfId);
	const parts = [
		said.length + ' earlier message' + (said.length === 1 ? '' : 's') + ' (' + [...who].map(([n, c]) => n + ' ' + c).join(', ') + ').',
		'It began: "' + clip(first.text || '') + '".'
	];
	if (lastAsk && lastAsk !== first) parts.push('The last request was: "' + clip(lastAsk.text || '') + '".');
	return parts.join(' ');
}

/**
 * @typedef {object} InboxDeps
 * @property {() => string|null} selfId this page's peer id
 * @property {(peerId: string) => string|null} roleOf 'admin'|'editor'|'viewer', or null when the build has no roles
 * @property {() => string|null} host the session host's peer id
 * @property {(peerId: string) => string} [nameOf]
 * @property {() => string} [myName] the agent's display name
 * @property {(msg: any) => void} send broadcast to every open peer
 * @property {(chatId: string) => Promise<any>|any} [readChat] the `.tpchat` store (56-media): `{messages}` or null
 * @property {() => number} [now]
 * @property {(fn: () => void, ms: number) => any} [setTimer]
 * @property {(t: any) => void} [clearTimer]
 * @property {() => string} [makeId]
 */

/**
 * @param {InboxDeps} deps
 */
export function createInbox(deps) {
	const now = deps.now ?? (() => Date.now());
	const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
	let seq = 0;
	const makeId = deps.makeId ?? (() => 'ac' + now().toString(36) + (++seq).toString(36));
	const self = () => String(deps.selfId() ?? '').toLowerCase();

	/** chatId -> messages, oldest first @type {Map<string, any[]>} */
	const logs = new Map();
	/** requests not yet picked up @type {any[]} */
	const queue = [];
	/** armed waits: token -> resolver @type {Map<string, (m: any) => void>} */
	const waiters = new Map();
	/** the request the agent is working on @type {null | {id: string, chatId: string, from: string, role: string|null, via?: string, cancelled: boolean, done: boolean}} */
	let current = null;
	/** the chat the agent last saw a message in */
	let lastChat = /** @type {string|null} */ (null);
	let muted = false;
	/** the bridge's explicit status (null = derived) */
	let forced = /** @type {string|null} */ (null);
	let lastSent = '';
	let lastActive = now();
	/** replies being streamed: replyTo|'cli:'+chatId -> {id, text, chatId, to, replyTo, via} */
	const streams = new Map();
	/** @type {any} */
	let awayTimer = null;
	/** @type {Set<() => void>} */
	const listeners = new Set();

	/** @param {string} chatId @param {any} entry */
	function remember(chatId, entry) {
		let log = logs.get(chatId);
		if (!log) logs.set(chatId, (log = []));
		const i = log.findIndex((m) => m.id === entry.id);
		if (i >= 0) log[i] = { ...log[i], ...entry };
		else log.push(entry);
		if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
	}

	/** what the log keeps of a message (never the image bytes) @param {any} m */
	function logEntry(m) {
		/** @type {any} */
		const e = { id: m.id, from: m.from, text: m.text ?? '', at: m.at ?? now() };
		for (const k of ['name', 'role', 'via', 'kind', 'replyTo', 'to', 'answers', 'partial']) if (m[k] !== undefined) e[k] = m[k];
		if (m.ask) e.ask = m.ask;
		if (m.images?.length) e.images = m.images.map((/** @type {any} */ im) => ({ mimeType: im.mimeType, name: im.name }));
		return e;
	}

	function status() {
		if (forced) return forced;
		if (waiters.size) return 'listening';
		if (current && !current.done && !current.cancelled) return 'working';
		return now() - lastActive < AWAY_AFTER_MS ? 'listening' : 'away';
	}

	/** broadcast the status when it changed (or always, for the heartbeat) @param {boolean} [force] */
	function publishStatus(force = false) {
		const s = status();
		const key = s + (muted ? ':m' : '') + ':' + (current?.chatId ?? lastChat ?? '');
		if (!force && key === lastSent) return;
		lastSent = key;
		/** @type {any} */
		const msg = { type: 'agentchat', from: self(), status: s };
		if (muted) msg.muted = true;
		const chatId = current?.chatId ?? lastChat;
		if (chatId) msg.chatId = chatId;
		try {
			deps.send(msg);
		} catch {
			/* not connected: the next heartbeat says it */
		}
		for (const fn of listeners) {
			try {
				fn();
			} catch {}
		}
	}

	/** re-check `away` once the grace runs out */
	function armAway() {
		if (awayTimer) clearTimer(awayTimer);
		awayTimer = setTimer(() => {
			awayTimer = null;
			publishStatus();
		}, AWAY_AFTER_MS + 50);
	}

	/** may this peer mute the agent? (the session host, or an admin) @param {string} from */
	const isModerator = (from) => from === String(deps.host() ?? '').toLowerCase() || deps.roleOf(from) === 'admin';
	/** may this peer Stop a request? The requester, the host, or anyone who is not a viewer (the window's
	 * own rule for showing Stop) @param {string} from @param {string} requester */
	const mayStop = (from, requester) => from === requester || isModerator(from) || deps.roleOf(from) !== 'viewer';

	/** the chat's earlier messages for a switch, from our log and the `.tpchat` store @param {string} chatId */
	async function threadOf(chatId) {
		const mine = logs.get(chatId) ?? [];
		/** @type {any[]} */
		let stored = [];
		if (deps.readChat) {
			try {
				const r = await deps.readChat(chatId);
				if (r && Array.isArray(r.messages)) stored = r.messages;
			} catch {
				/* the store is a bonus: our log still answers */
			}
		}
		if (!stored.length) return mine.slice();
		const seen = new Set(mine.map((m) => m.id));
		const merged = [...stored.filter((m) => m && !seen.has(m.id)).map(logEntry), ...mine];
		merged.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
		return merged;
	}

	/** hand `msg` to a waiter (a chat switch adds the history) @param {any} msg */
	async function prepare(msg) {
		/** @type {any} */
		const out = { ...msg };
		if (msg.chatId !== lastChat) {
			const all = await threadOf(msg.chatId);
			const earlier = all.filter((m) => m.id !== msg.id && (m.at ?? 0) <= msg.at && !m.partial);
			if (earlier.length) {
				out.history = earlier.slice(-HISTORY_COUNT);
				out.summary = summarizeThread(earlier, self());
				out.olderMessages = Math.max(0, earlier.length - HISTORY_COUNT);
			}
		}
		lastChat = msg.chatId;
		current = { id: msg.id, chatId: msg.chatId, from: msg.from, role: msg.role, cancelled: false, done: false };
		lastActive = now();
		return out;
	}

	function pump() {
		while (queue.length && waiters.size) {
			const [token, resolve] = waiters.entries().next().value;
			waiters.delete(token);
			const msg = queue.shift();
			prepare(msg).then(resolve, () => resolve(msg));
		}
		publishStatus();
	}

	/**
	 * A peer's `agentchat` message. `fromPeer` is the CONNECTION's id.
	 * @param {string} fromPeer @param {any} data
	 */
	function receive(fromPeer, data) {
		if (!data || typeof data !== 'object') return;
		const from = String(fromPeer || '').toLowerCase();
		// a window's late-joiner backlog (56-chat) is history between windows, never a request
		if (data.backlog !== undefined) return;
		// a peer speaks only for itself (the window applies the same rule)
		if (data.from !== undefined && String(data.from).toLowerCase() !== from) return;
		const me = self();
		const toMe = String(data.to ?? '').toLowerCase() === me && !!me;
		if (data.mute !== undefined) {
			if (toMe && isModerator(from)) {
				muted = !!data.mute;
				if (muted) queue.length = 0;
				publishStatus(true);
			}
			return;
		}
		if (data.cancel !== undefined) {
			if (!toMe || !isId(data.cancel)) return;
			const id = data.cancel;
			const qi = queue.findIndex((m) => m.id === id && mayStop(from, m.from));
			if (qi >= 0) queue.splice(qi, 1);
			if (current && current.id === id && mayStop(from, current.from)) {
				current.cancelled = true;
				for (const [k, s] of streams) if (s.replyTo === id) streams.delete(k);
			}
			publishStatus();
			return;
		}
		if (data.status !== undefined) return; // another agent's badge
		if (!isId(data.id) || !isId(data.chatId)) return;
		/** @type {any} */
		const msg = {
			id: data.id,
			chatId: data.chatId,
			from,
			text: str(data.text),
			at: now()
		};
		const name = str(data.name, 64) || deps.nameOf?.(from) || '';
		if (name) msg.name = name;
		if (data.via === 'cli') msg.via = 'cli';
		if (data.role === 'user' && data.via === 'cli') msg.kind = 'terminal';
		if (isId(data.replyTo)) msg.replyTo = data.replyTo;
		if (data.partial) msg.partial = true;
		if (data.ask && typeof data.ask === 'object') {
			msg.kind = 'ask';
			msg.ask = { question: str(data.ask.question, 2000), options: Array.isArray(data.ask.options) ? data.ask.options.slice(0, 8).map((/** @type {any} */ o) => str(o, 200)) : [] };
		}
		if (!toMe || msg.replyTo || msg.kind) {
			// someone else's conversation, or another agent's reply / ask: the log only (history, get_thread)
			if (msg.text || msg.ask) remember(msg.chatId, logEntry({ ...msg, to: str(data.to, 64) || undefined }));
			return;
		}
		msg.role = deps.roleOf(from) ?? 'editor'; // null = no roles in this build: everyone edits
		if (isId(data.answers)) msg.answers = data.answers;
		const images = msg.role === 'viewer' ? [] : cleanImages(data.images);
		if (images.length) msg.images = images;
		if (msg.role === 'viewer' && Array.isArray(data.images) && data.images.length) msg.imagesDropped = true;
		remember(msg.chatId, logEntry(msg));
		if (muted) return;
		if (!msg.text && !images.length && !msg.answers) return;
		if (queue.some((m) => m.id === msg.id) || current?.id === msg.id) return;
		queue.push(msg);
		if (queue.length > QUEUE_CAP) queue.splice(0, queue.length - QUEUE_CAP);
		pump();
	}

	/**
	 * The next request, or null after `timeoutMs`. `token` names the wait so the bridge can abandon it.
	 * @param {number} [timeoutMs] @param {string} [token]
	 * @returns {Promise<any|null>}
	 */
	function next(timeoutMs = 30000, token) {
		const ms = Math.max(0, Math.min(MAX_WAIT_MS, Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 30000));
		const key = typeof token === 'string' && token ? token : makeId();
		lastActive = now();
		return new Promise((resolve) => {
			/** @type {any} */
			let timer = null;
			waiters.set(key, (/** @type {any} */ m) => {
				if (timer) clearTimer(timer);
				lastActive = now();
				armAway();
				resolve(m);
			});
			timer = setTimer(() => {
				if (!waiters.has(key)) return;
				waiters.delete(key);
				lastActive = now();
				armAway();
				publishStatus();
				resolve(null);
			}, ms);
			pump();
		});
	}

	/** give up an armed wait (the MCP client cancelled the call) @param {string} token */
	function abortWait(token) {
		const r = waiters.get(token);
		if (!r) return false;
		waiters.delete(token);
		r(null);
		publishStatus();
		return true;
	}

	/** put a delivered request back at the front (its result never reached the agent) @param {any} msg */
	function requeue(msg) {
		if (!msg || !isId(msg.id) || queue.some((m) => m.id === msg.id)) return false;
		const { history, summary, olderMessages, ...plain } = msg;
		queue.unshift(plain);
		if (current?.id === msg.id) current = null;
		lastChat = null; // the agent never saw it: the switch is still to come
		pump();
		return true;
	}

	/**
	 * Say something in the chat. `text` is a paragraph added to the running reply; `delta` is raw text
	 * appended as is (token streaming). `prompt` first posts a terminal turn: the user's own words typed
	 * in the agent's terminal (C4), which also starts a new request — a Stop no longer applies.
	 * @param {{to?: string, text?: string, delta?: string, final?: boolean, chatId?: string, replyTo?: string, via?: string, prompt?: string}} o
	 */
	function reply(o = {}) {
		const me = self();
		if (!me) return { ok: false, error: 'not connected yet' };
		const at = now();
		lastActive = at;
		let via = o.via === 'cli' ? 'cli' : undefined;
		if (typeof o.prompt === 'string' && o.prompt.trim()) {
			const chatId = isId(o.chatId) ? /** @type {string} */ (o.chatId) : lastChat ?? 'terminal';
			const id = makeId();
			const turn = { type: 'agentchat', id, chatId, from: me, role: 'user', via: 'cli', text: str(o.prompt) };
			deps.send(turn);
			remember(chatId, logEntry({ ...turn, kind: 'terminal', at }));
			current = { id, chatId, from: me, role: null, via: 'cli', cancelled: false, done: false };
			lastChat = chatId;
			via = 'cli';
		}
		const live = current && !current.done ? current : null;
		if (!via && !live && !o.to && !o.replyTo) via = 'cli';
		if (live?.via === 'cli') via = 'cli';
		const replyTo = isId(o.replyTo) ? /** @type {string} */ (o.replyTo) : via ? (live?.via === 'cli' ? live.id : null) : live?.id ?? null;
		const chatId = isId(o.chatId) ? /** @type {string} */ (o.chatId) : live?.chatId ?? lastChat ?? 'terminal';
		if (live && live.cancelled && replyTo === live.id && !o.final) return { ok: false, cancelled: true, error: 'cancelled: the person pressed Stop — wait for the next message' };
		// a terminal turn is answered to everyone; an app request to its sender
		const to = typeof o.to === 'string' && o.to ? o.to.toLowerCase() : live && live.via !== 'cli' && !via ? live.from : null;
		const key = replyTo ?? 'cli:' + chatId;
		let s = streams.get(key);
		if (!s) {
			s = { id: makeId(), text: '', chatId, to, replyTo, via };
			streams.set(key, s);
		}
		if (typeof o.delta === 'string') s.text += o.delta;
		if (typeof o.text === 'string' && o.text) s.text += (s.text && !/\n$/.test(s.text) ? '\n\n' : '') + o.text;
		s.text = s.text.slice(0, MAX_TEXT);
		const final = !!o.final;
		/** @type {any} */
		const msg = { type: 'agentchat', id: s.id, chatId: s.chatId, from: me, to: s.to, replyTo: s.replyTo, text: s.text };
		const name = deps.myName?.();
		if (name) msg.name = name;
		if (!final) msg.partial = true;
		if (s.via) msg.via = s.via;
		deps.send(msg);
		remember(s.chatId, logEntry({ ...msg, at }));
		if (final) {
			streams.delete(key);
			if (current && current.id === replyTo) current.done = true;
			armAway();
		}
		publishStatus();
		return { ok: true, id: s.id, chatId: s.chatId, final };
	}

	/**
	 * Ask the person a question with buttons; the click comes back as a request with `answers` = the id.
	 * @param {{to?: string, question?: string, options?: string[], chatId?: string}} o
	 */
	function ask(o = {}) {
		const me = self();
		if (!me) return { ok: false, error: 'not connected yet' };
		const question = str(o.question, 2000).trim();
		const options = Array.isArray(o.options) ? o.options.map((x) => str(String(x), 200)).filter(Boolean).slice(0, 8) : [];
		if (!question) return { ok: false, error: 'question required' };
		const live = current && !current.done ? current : null;
		const chatId = isId(o.chatId) ? /** @type {string} */ (o.chatId) : live?.chatId ?? lastChat ?? 'terminal';
		const id = makeId();
		const msg = { type: 'agentchat', id, chatId, from: me, to: (o.to || live?.from || null)?.toLowerCase?.() ?? null, ask: { question, options } };
		deps.send(msg);
		remember(chatId, logEntry({ ...msg, kind: 'ask', text: question, at: now() }));
		return { ok: true, id, chatId };
	}

	/**
	 * A page of a chat, oldest first: the `limit` messages before `before` (a message id; omit = the newest).
	 * @param {{chatId?: string, before?: string, limit?: number}} o
	 */
	async function thread(o = {}) {
		const chatId = isId(o.chatId) ? /** @type {string} */ (o.chatId) : lastChat;
		if (!chatId) return { chatId: null, messages: [], more: false };
		const all = (await threadOf(chatId)).filter((m) => !m.partial);
		const limit = Math.max(1, Math.min(100, Number(o.limit) || 20));
		let end = all.length;
		if (isId(o.before)) {
			const i = all.findIndex((m) => m.id === o.before);
			if (i >= 0) end = i;
		}
		const start = Math.max(0, end - limit);
		return { chatId, messages: all.slice(start, end), more: start > 0 };
	}

	/**
	 * May a tool run now? null = yes, else the result to answer with. Edits are gated by the running
	 * request: cancelled → `cancelled`; a viewer's → refused.
	 * @param {string} name @param {boolean} isEdit
	 */
	function gate(name, isEdit) {
		if (!current || current.done) return null;
		if (current.cancelled)
			return { error: 'cancelled', cancelled: true, note: 'The person pressed Stop on this request. Do not continue it: call wait_for_message for the next one.' };
		if (isEdit && current.role === 'viewer')
			return {
				error: 'refused: this request came from a VIEWER, and viewers may not change the scene. Tell them so in your reply.',
				refused: true,
				role: 'viewer'
			};
		return null;
	}

	/** the bridge's explicit status ('listening'|'working'|'away'), or null to derive it @param {string|null} s */
	function setStatus(s) {
		forced = s === 'listening' || s === 'working' || s === 'away' ? s : null;
		publishStatus();
		return { ok: true, status: status() };
	}

	return {
		receive,
		next,
		abortWait,
		requeue,
		reply,
		ask,
		thread,
		gate,
		setStatus,
		heartbeat: () => publishStatus(true),
		/** for status() and tests */
		state: () => ({
			status: status(),
			muted,
			queued: queue.length,
			waiting: waiters.size,
			current: current ? { ...current } : null,
			chatId: current?.chatId ?? lastChat
		}),
		/** @param {() => void} fn */
		onChange(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		}
	};
}
