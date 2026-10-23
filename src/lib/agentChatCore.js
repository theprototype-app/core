// 56 C1/C4/C5/C6 — the agent chat, PURE half (imports nothing; the unit layer runs it).
//
// One replicated message type, `{type:'agentchat', …}`, fields discriminate (the contract is
// QUESTIONS-56-bridge Q1 + QUESTIONS-56-chat Q1):
//   request   person → agent   {id, chatId, from, to, name?, text, images?, answers?}
//   reply     agent → all      {id, chatId, from, to?, replyTo?, text (FULL text so far), partial?, via?}
//   terminal  agent → all      {id, chatId, from, role:'user', via:'cli', text}  (typed in the agent's terminal)
//   ask       agent → all      {id, chatId, from, to?, ask: {question, options}}
//   cancel    → agent          {cancel: requestId, chatId, from, to}            (Stop)
//   status    agent → all      {from, status: listening|working|away, muted?, chatId?, mode?: mcp|repl, model?}
//   mute      host → agent     {from, to, mute: bool}                            (the agent page obeys)
//   backlog   window → window  {backlog: [msg…]}                                 (late joiner, the one relay)
// Every peer sees every message (F1: the session reads the thread); only the agent page ACTS on
// one. The window keeps a reducer over them: chats keyed by chatId, messages merged by id (a
// streamed reply re-sends one id with longer text), and each agent's last status.
//
// A live message counts only when `from` is the peer it arrived from; nothing here trusts a
// `role` field — the window shows the role it computes itself (rolesInfo), and the agent page
// gates what a viewer's request may do.

/** longest message text kept (a streamed reply is re-sent whole, so this caps one bubble) */
export const TEXT_MAX = 16000;
/** messages one chat keeps (oldest drop first) */
export const CHAT_CAP = 500;
/** chats the window keeps in memory (the .tpchat files hold the rest) */
export const CHATS_CAP = 50;
/** what the handshake hands a late joiner */
export const BACKLOG_CAP = 200;
/** an id / chatId / peer id */
const ID_MAX = 64;
/** images per message (C8's own cap) */
const IMAGES_MAX = 4;
/** ask buttons */
const OPTIONS_MAX = 6;

export const STATUSES = /** @type {const} */ (['listening', 'working', 'away']);

/** @param {any} v @param {number} [max] */
const isId = (v, max = ID_MAX) => typeof v === 'string' && v.length > 0 && v.length <= max;
/** @param {any} a @param {any} b */
export const samePeer = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * What a wire message is. Cancel / status / mute / backlog are CONTROL (they change state,
 * not the thread); the rest are thread messages.
 * @param {any} d
 * @returns {'backlog'|'cancel'|'status'|'mute'|'ask'|'cli'|'reply'|'request'|null}
 */
export function kindOf(d) {
	if (!d || typeof d !== 'object') return null;
	if (Array.isArray(d.backlog)) return 'backlog';
	if (d.cancel !== undefined) return 'cancel';
	if (d.status !== undefined) return 'status';
	if (d.mute !== undefined) return 'mute';
	if (d.ask !== undefined) return 'ask';
	if (d.via === 'cli' && d.role === 'user') return 'cli';
	if (d.replyTo !== undefined || d.partial !== undefined) return 'reply';
	if (d.to !== undefined) return 'request';
	// a reply that names nobody (an agent speaking up on its own) is still a reply
	return typeof d.text === 'string' ? 'reply' : null;
}

/**
 * The wire validator's row (wireValidate.js uses it): shape only, before the reducer's rules.
 * @param {any} d
 */
export function isAgentChatWire(d) {
	if (!d || typeof d !== 'object') return false;
	const k = kindOf(d);
	if (!k) return false;
	if (k === 'backlog') return d.backlog.length <= BACKLOG_CAP;
	if (k === 'status') return STATUSES.includes(d.status) && (d.chatId === undefined || isId(d.chatId));
	if (k === 'cancel') return isId(d.cancel) && (d.chatId === undefined || isId(d.chatId));
	if (k === 'mute') return typeof d.mute === 'boolean' && isId(d.to);
	return isId(d.id) && isId(d.chatId) && (d.text === undefined || typeof d.text === 'string');
}

/** @param {any} img */
function cleanImage(img) {
	if (!img || typeof img !== 'object' || typeof img.mimeType !== 'string' || !/^image\//.test(img.mimeType)) return null;
	/** @type {any} */
	const out = { mimeType: img.mimeType.slice(0, 40) };
	if (typeof img.data === 'string') out.data = img.data;
	if (typeof img.hash === 'string') out.hash = img.hash.slice(0, 128);
	if (typeof img.name === 'string') out.name = img.name.slice(0, 120);
	if (Number.isFinite(img.w)) out.w = img.w;
	if (Number.isFinite(img.h)) out.h = img.h;
	return out;
}

/**
 * A thread message made safe to keep (it arrived from a peer — untrusted shape), or null.
 * @param {any} d @param {number} [now]
 */
export function cleanMessage(d, now = Date.now()) {
	const kind = kindOf(d);
	if (kind !== 'request' && kind !== 'reply' && kind !== 'cli' && kind !== 'ask') return null;
	if (!isId(d.id) || !isId(d.chatId) || !isId(d.from)) return null;
	const text = typeof d.text === 'string' ? d.text.slice(0, TEXT_MAX) : '';
	/** @type {any} */
	const m = { id: d.id, chatId: d.chatId, kind, from: d.from, text, at: Number.isFinite(d.at) ? d.at : now };
	if (isId(d.to)) m.to = d.to;
	if (typeof d.name === 'string' && d.name.trim()) m.name = d.name.trim().slice(0, 32);
	if (kind === 'reply') {
		if (isId(d.replyTo)) m.replyTo = d.replyTo;
		if (d.partial === true) m.partial = true;
		if (Number.isFinite(d.last) && d.last >= m.at) m.last = d.last;
	}
	if (d.via === 'cli') m.via = 'cli';
	if (kind === 'request' && isId(d.answers)) m.answers = d.answers;
	if (kind === 'ask') {
		const q = d.ask && typeof d.ask === 'object' ? d.ask : {};
		const options = (Array.isArray(q.options) ? q.options : [])
			.filter((/** @type {any} */ o) => typeof o === 'string' && o.trim())
			.slice(0, OPTIONS_MAX)
			.map((/** @type {string} */ o) => o.slice(0, 80));
		m.ask = { question: String(q.question ?? text).slice(0, 500), options };
	}
	if (Array.isArray(d.images)) {
		const imgs = d.images.slice(0, IMAGES_MAX).map(cleanImage).filter(Boolean);
		if (imgs.length) m.images = imgs;
	}
	if (d.cancelled === true) m.cancelled = true;
	if (kind === 'request' && !text.trim() && !m.images) return null;
	return m;
}

/** the agent a thread message belongs to: a request's `to`, everyone else's `from` @param {any} m */
export const agentOf = (m) => (m.kind === 'request' ? m.to : m.from);

/** @typedef {{chats: Record<string, any>, agents: Record<string, any>}} AgentChatState */
/** @type {() => AgentChatState} */
export const emptyState = () => ({ chats: {}, agents: {} });

/** @param {any[]} list */
const byTime = (list) => list.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * Merge one clean message into a chat's list. A streamed reply re-sends its id with LONGER
 * text: the newer copy wins while the old one is still partial; a final copy is never taken
 * back by a stale partial arriving late. Returns the same array when nothing changed.
 * @param {any[]} list @param {any} m
 */
export function mergeMessage(list, m) {
	const i = list.findIndex((x) => x.id === m.id);
	if (i < 0) return byTime([...list, m]).slice(-CHAT_CAP);
	const had = list[i];
	if (!samePeer(had.from, m.from)) return list; // an id is its sender's: nobody else may rewrite it
	let next = had;
	// `last` = when the text last grew: the thread places a reply there, after the steps it streamed across
	if (had.partial && (!m.partial || m.text.length >= had.text.length)) next = { ...had, text: m.text, partial: m.partial === true, last: Math.max(had.at, m.last ?? m.at) };
	if (m.cancelled && !next.cancelled) next = { ...next, cancelled: true };
	if (!next.partial && 'partial' in next) {
		const { partial: _p, ...rest } = next;
		next = rest;
	}
	if (next === had) return list;
	const out = list.slice();
	out[i] = next;
	return out;
}

/**
 * Put a clean message into its chat (creating the chat), capped.
 * @param {AgentChatState} state @param {any} m
 */
function putMessage(state, m) {
	const had = state.chats[m.chatId];
	const agent = agentOf(m);
	if (had && had.agent && agent && !samePeer(had.agent, agent)) return state; // one chat = one agent
	const chat = had ?? { id: m.chatId, agent, messages: [], at: m.at };
	const messages = mergeMessage(chat.messages, m);
	if (had && messages === had.messages) return state;
	const updatedAt = Math.max(chat.updatedAt ?? 0, m.at);
	/** @type {Record<string, any>} */
	let chats = { ...state.chats, [m.chatId]: { ...chat, agent: chat.agent || agent, messages, updatedAt } };
	const ids = Object.keys(chats);
	if (ids.length > CHATS_CAP) {
		const oldest = ids.sort((a, b) => (chats[a].updatedAt ?? 0) - (chats[b].updatedAt ?? 0)).slice(0, ids.length - CHATS_CAP);
		chats = { ...chats };
		for (const id of oldest) delete chats[id];
	}
	return { ...state, chats };
}

/**
 * THE REDUCER: an `agentchat` message from `fromPeer`. Returns the same state when nothing
 * changed (so a store can skip the set).
 * @param {AgentChatState} state @param {string} fromPeer @param {any} d @param {number} [now]
 * @returns {AgentChatState}
 */
export function applyAgentChat(state, fromPeer, d, now = Date.now()) {
	const kind = kindOf(d);
	if (!kind) return state;
	if (kind === 'backlog') {
		// the one relay: messages keep their own `from`; control kinds never ride it
		let next = state;
		for (const raw of d.backlog.slice(-BACKLOG_CAP)) {
			const m = cleanMessage(raw, now);
			if (m) next = putMessage(next, m);
		}
		return next;
	}
	if (!samePeer(d.from, fromPeer)) return state; // a peer speaks only for itself
	if (kind === 'status') {
		if (!STATUSES.includes(d.status)) return state;
		const had = state.agents[d.from];
		const mode = d.mode === 'mcp' || d.mode === 'repl' ? d.mode : had?.mode ?? null; // how it runs, for the picker label
		const model = typeof d.model === 'string' && d.model.trim() ? d.model.trim().slice(0, 48) : had?.model ?? null; // a REPL's model name
		const row = { status: d.status, muted: d.muted === true, chatId: isId(d.chatId) ? d.chatId : had?.chatId ?? null, mode, model, at: now };
		if (had && had.status === row.status && had.muted === row.muted && had.chatId === row.chatId && had.mode === row.mode && had.model === row.model) return state;
		return { ...state, agents: { ...state.agents, [d.from]: row } };
	}
	if (kind === 'mute') return state; // the AGENT obeys it and says so in its status — that is what we show
	if (kind === 'cancel') {
		if (!isId(d.cancel)) return state;
		let next = state;
		for (const chat of Object.values(state.chats)) {
			if (d.chatId && chat.id !== d.chatId) continue;
			const i = chat.messages.findIndex((/** @type {any} */ x) => x.id === d.cancel);
			if (i < 0 || chat.messages[i].cancelled) continue;
			const messages = chat.messages.slice();
			messages[i] = { ...messages[i], cancelled: true, cancelledBy: d.from };
			next = { ...next, chats: { ...next.chats, [chat.id]: { ...chat, messages } } };
		}
		return next;
	}
	const m = cleanMessage(d, now);
	return m ? putMessage(state, m) : state;
}

/**
 * The agent dropped off: it is away (its chats stay — they are history).
 * @param {AgentChatState} state @param {string} peerId @param {number} [now]
 */
export function agentGone(state, peerId, now = Date.now()) {
	const key = Object.keys(state.agents).find((k) => samePeer(k, peerId));
	if (!key || state.agents[key].status === 'away') return state;
	return { ...state, agents: { ...state.agents, [key]: { ...state.agents[key], status: 'away', at: now } } };
}

/**
 * The request the agent is answering in this chat right now, or null: the newest request
 * with no final reply after it, not cancelled.
 * @param {any} chat
 */
export function runningRequest(chat) {
	const list = chat?.messages ?? [];
	for (let i = list.length - 1; i >= 0; i--) {
		const m = list[i];
		if (m.kind === 'ask') return null; // it asked back: the turn is the person's
		if (m.kind === 'request') {
			if (m.cancelled) return null;
			const answered = list.some((/** @type {any} */ r) => r.kind === 'reply' && r.replyTo === m.id && !r.partial);
			return answered ? null : m;
		}
	}
	return null;
}

/** the reply streaming into a request (its partial bubble), or null @param {any} chat @param {string} requestId */
export const streamingReply = (chat, requestId) =>
	(chat?.messages ?? []).find((/** @type {any} */ m) => m.kind === 'reply' && m.partial && m.replyTo === requestId) ?? null;

/**
 * The thread as the window draws it: the chat's messages INTERLEAVED with the agent's A8
 * action lines (55 agentLog entries) by time, from the chat's first message on. An ask that
 * was answered carries `answered` (the buttons go).
 * @param {any} chat @param {any[]} [log] agentLog entries `{id, peer, text, at, …}`
 * @returns {{type: 'msg'|'log', at: number, key: string, m?: any, e?: any}[]}
 */
export function threadItems(chat, log = []) {
	if (!chat) return [];
	const answered = new Set(chat.messages.filter((/** @type {any} */ m) => m.answers).map((/** @type {any} */ m) => m.answers));
	const start = chat.messages[0]?.at ?? Infinity;
	const steps = log.filter((e) => samePeer(e.peer, chat.agent) && e.at >= start).sort((a, b) => a.at - b.at);
	// messages keep their own order; each step goes in before the first message that came after it
	// (a streamed reply counts from its LAST update, so the answer reads after the work it describes)
	/** @type {any[]} */
	const items = [];
	let j = 0;
	for (const m of chat.messages) {
		const when = m.last ?? m.at;
		for (; j < steps.length && steps[j].at < when; j++) items.push({ type: 'log', at: steps[j].at, key: 'l:' + steps[j].id, e: steps[j] });
		items.push({ type: 'msg', at: m.at, key: 'm:' + m.id, m: m.kind === 'ask' && answered.has(m.id) ? { ...m, answered: true } : m });
	}
	for (; j < steps.length; j++) items.push({ type: 'log', at: steps[j].at, key: 'l:' + steps[j].id, e: steps[j] });
	return items;
}

/** a chat's title: its own, else the first request's words @param {any} chat */
export function chatTitle(chat) {
	if (typeof chat?.title === 'string' && chat.title.trim()) return chat.title.trim().slice(0, 60);
	const first = chat?.messages?.find((/** @type {any} */ m) => m.kind === 'request' || m.kind === 'cli');
	const words = String(first?.text ?? '').replace(/\s+/g, ' ').trim();
	return words ? (words.length > 48 ? words.slice(0, 47) + '…' : words) : 'New chat';
}

/**
 * The history list: in-memory chats + the scene's saved ones (`files`, the .tpchat store's
 * rows), one row per chat id, newest first, filtered by `query` (title or agent label).
 * @param {AgentChatState} state @param {any[]} files @param {string} [query]
 * @param {(agentId: string) => string} [labelOf]
 */
export function historyRows(state, files = [], query = '', labelOf = () => '') {
	/** @type {Map<string, any>} */
	const rows = new Map();
	for (const f of files) {
		if (!f || !isId(f.id)) continue;
		rows.set(f.id, { id: f.id, title: f.title || 'Chat', agent: f.target?.kind === 'agent' ? f.target.id : null, label: f.target?.label ?? '', updatedAt: f.updatedAt ?? 0, count: f.count ?? 0, saved: true });
	}
	for (const chat of Object.values(state.chats)) {
		const had = rows.get(chat.id);
		rows.set(chat.id, {
			id: chat.id,
			title: chatTitle(chat.title ? chat : { ...chat, title: had?.title }),
			agent: chat.agent,
			label: labelOf(chat.agent) || had?.label || '',
			updatedAt: Math.max(chat.updatedAt ?? 0, had?.updatedAt ?? 0),
			count: Math.max(chat.messages.length, had?.count ?? 0),
			saved: !!had
		});
	}
	const q = query.trim().toLowerCase();
	return [...rows.values()]
		.filter((r) => !q || r.title.toLowerCase().includes(q) || r.label.toLowerCase().includes(q))
		.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
}

/**
 * The late joiner's share: the newest BACKLOG_CAP thread messages across chats, as wire
 * messages, image BYTES dropped (the .tpchat file carries those; the handshake stays small).
 * @param {AgentChatState} state
 */
export function backlogOf(state) {
	const all = byTime(Object.values(state.chats).flatMap((c) => c.messages));
	return all.slice(-BACKLOG_CAP).map((m) => {
		const { kind: _k, cancelledBy: _c, ...wire } = m;
		if (m.kind === 'cli') wire.role = 'user';
		if (wire.images) wire.images = wire.images.map((/** @type {any} */ { data: _d, ...meta }) => meta);
		return wire;
	});
}

/**
 * Load a saved chat (the .tpchat store's `readChat`) into the state, its messages cleaned
 * like any arriving ones.
 * @param {AgentChatState} state @param {any} saved @param {number} [now]
 */
export function loadChat(state, saved, now = Date.now()) {
	if (!saved || !isId(saved.id) || !Array.isArray(saved.messages)) return state;
	let next = state;
	for (const raw of saved.messages) {
		const m = cleanMessage({ ...raw, chatId: saved.id }, now);
		if (m) next = putMessage(next, m);
	}
	const chat = next.chats[saved.id];
	if (chat && typeof saved.title === 'string' && saved.title && chat.title !== saved.title)
		next = { ...next, chats: { ...next.chats, [saved.id]: { ...chat, title: saved.title } } };
	return next;
}

/** a chat as the .tpchat store saves it (the wire shape minus `type`) @param {any} chat @param {string} [label] */
export function chatRecord(chat, label = '') {
	return {
		id: chat.id,
		title: chatTitle(chat),
		target: { kind: 'agent', id: chat.agent, label },
		participants: [...new Set(chat.messages.map((/** @type {any} */ m) => m.from))],
		messages: chat.messages.map((/** @type {any} */ m) => {
			const { kind: _k, ...rec } = m;
			if (m.kind === 'cli') rec.role = 'user';
			return rec;
		}),
		updatedAt: chat.updatedAt ?? 0
	};
}

/**
 * Who writes the chat files: ONE writer per session, so N peers never churn one asset —
 * the session host when it may edit, else the lowest peer id among the editors present.
 * @param {{myId: string|null, hostId: string|null, iCanEdit: boolean, editors: string[]}} f
 */
export function isChatWriter(f) {
	if (!f.myId || !f.iCanEdit) return false;
	if (f.hostId === null) return true; // we host
	if (f.editors.some((id) => samePeer(id, f.hostId))) return false; // the host writes
	const lowest = [...f.editors, f.myId].map((x) => x.toLowerCase()).sort()[0];
	return lowest === f.myId.toLowerCase();
}
