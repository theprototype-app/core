// uir-chat (q-chat-save option c) — WHAT A SAVED CHAT IS, pure: no store, no idb, no browser, so the
// unit layer covers every rule. chatSaves.js is the live half (stores, IndexedDB, the subscriptions).
//
// TWO KINDS, ONE HISTORY.
//  · A SESSION LOG: what people said in the session while a scene was open, kept PER DEVICE per scene
//    (the scene's name; an unnamed scene shares one "Untitled scene" log). The wire is unchanged —
//    lines still travel as `sent` and a joiner still gets 200 of them from a peer (`getchat`); this is
//    only what THIS device remembers, so a reload or a later visit to the scene brings the talk back.
//  · A PROVIDER CHAT: a conversation with your own AI provider (Settings ▸ Tools & connections), kept
//    per device until accounts (71). Agent chats are scene data already (.tpchat, 56 C10) and are
//    listed beside these, never copied.
// Pictures stay ATTACHMENTS: a saved provider chat names each picture by key and the bytes are stored
// once, beside it — never a data URL inline in the conversation record.

import { keyOf, bareBase64 } from './tpchatCore.js';

/** lines a scene's session log keeps (the newest) */
export const SESSION_CAP = 500;
/** provider chats this device keeps (the oldest is dropped) */
export const AI_CHATS_CAP = 50;
/** messages one provider chat keeps */
export const AI_MESSAGES_CAP = 400;
const TEXT_MAX = 4000;
const TITLE_MAX = 60;
export const UNTITLED_ROOM = 'untitled';

/** @typedef {{id: string, text: string, sender: string, name?: string, at: number, mine?: boolean}} SavedLine */
/** @typedef {{key: string, title: string, updatedAt: number, count: number, people: string[]}} LogRow */
/** @typedef {{id: string, title: string, provider: string, updatedAt: number, count: number}} AiRow */

/**
 * The scene a session log belongs to: its name, else the shared untitled bucket. A PRIVATE scene's
 * log is still this device's own (nothing here leaves the machine).
 * @param {any} level `currentLevel` ({name, hash, unsaved?, private?} | null)
 * @returns {{key: string, title: string}}
 */
export function roomOf(level) {
	const name = typeof level?.name === 'string' ? level.name.trim() : '';
	return name ? { key: 'scene:' + name.slice(0, 200), title: name.slice(0, 200) } : { key: UNTITLED_ROOM, title: 'Untitled scene' };
}

/** a chat line worth keeping: what a person said (not a system note), with an id @param {any} m */
export function keepLine(m) {
	return !!m && (m.type === 'sent' || m.type === 'received') && typeof m.text === 'string' && typeof m.id === 'string' && !!m.id && !m.saved;
}

/**
 * A live line -> its saved form.
 * @param {any} m @param {{me?: string|null, nameOf?: (id: string) => string, myName?: string}} ctx
 * @returns {SavedLine}
 */
export function lineOf(m, ctx = {}) {
	const mine = m.type === 'sent' || (!!ctx.me && m.sender === ctx.me);
	const sender = String(m.sender ?? '');
	const name = mine ? ctx.myName || '' : m.name || (ctx.nameOf ? ctx.nameOf(sender) : '') || '';
	/** @type {SavedLine} */
	const out = { id: String(m.id), text: String(m.text).slice(0, TEXT_MAX), sender, at: Number.isFinite(m.at) ? m.at : Number.isFinite(m.ts) ? m.ts : 0 };
	if (name && name !== sender) out.name = name.slice(0, 80);
	if (mine) out.mine = true;
	return out;
}

/** a stored line, checked (what idb hands back is not trusted to be ours) @param {any} l @returns {SavedLine | null} */
export function cleanLine(l) {
	if (!l || typeof l.id !== 'string' || !l.id || l.id.length > 200 || typeof l.text !== 'string') return null;
	/** @type {SavedLine} */
	const out = { id: l.id, text: l.text.slice(0, TEXT_MAX), sender: typeof l.sender === 'string' ? l.sender.slice(0, 200) : '', at: Number.isFinite(l.at) ? l.at : 0 };
	if (typeof l.name === 'string' && l.name) out.name = l.name.slice(0, 80);
	if (l.mine === true) out.mine = true;
	return out;
}

/**
 * Append lines to a log: by id (a line already there is not added twice), ordered by time, the newest
 * SESSION_CAP kept.
 * @param {SavedLine[]} log @param {SavedLine[]} lines @param {number} [cap]
 * @returns {SavedLine[]}
 */
export function appendLines(log, lines, cap = SESSION_CAP) {
	const seen = new Set((log ?? []).map((l) => l.id));
	const added = (lines ?? []).filter((l) => l && !seen.has(l.id) && (seen.add(l.id), true));
	if (!added.length) return log ?? [];
	const all = [...(log ?? []), ...added];
	all.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
	return all.slice(-cap);
}

/**
 * A saved line -> the live chat's record (what `messages` holds). `saved` marks it as this device's
 * memory of the scene, so leaving the scene takes it off the screen again.
 * @param {SavedLine} l @param {string} roomKey @param {string|null} me
 */
export function liveOf(l, roomKey, me) {
	const mine = l.mine === true || (!!me && l.sender === me);
	return { id: l.id, text: l.text, sender: l.sender, name: l.name, type: mine ? 'sent' : 'received', ts: l.at, at: l.at, past: true, saved: roomKey };
}

/** the History row of a log @param {string} key @param {string} title @param {SavedLine[]} log @returns {LogRow} */
export function logRow(key, title, log) {
	const people = [...new Set(log.map((l) => (l.mine ? '' : l.name || '')).filter(Boolean))].slice(0, 6);
	return { key, title, updatedAt: log.length ? log[log.length - 1].at : 0, count: log.length, people };
}

/** put a row into an index (one per key), newest first @param {any[]} index @param {any} row @param {string} [idKey] */
export function upsertRow(index, row, idKey = 'key') {
	const rest = (index ?? []).filter((r) => r && r[idKey] !== row[idKey]);
	return [row, ...rest].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

// ---- provider chats --------------------------------------------------------------------------

/** a conversation's title: its first words @param {any[]} messages */
export function aiTitle(messages) {
	const first = (messages ?? []).find((m) => m?.role === 'user' && typeof m.content === 'string' && m.content.trim());
	const text = first ? first.content.trim().replace(/\s+/g, ' ') : (messages ?? []).some((m) => m?.images?.length) ? 'A picture' : 'New chat';
	return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1).trimEnd() + '…' : text;
}

/** "data:image/png;base64,AAAA" -> its MIME type @param {string} url */
function mimeOf(url) {
	const m = /^data:([^;,]+)[;,]/.exec(url);
	return m ? m[1] : 'image/jpeg';
}

/**
 * The window's messages -> a record to store: streaming state dropped, every picture split into an
 * attachment `{key, name, mimeType}` with its bytes returned separately (keyed, so a picture sent twice
 * is stored once).
 * @param {any[]} messages @returns {{messages: any[], images: Record<string, {mimeType: string, data: string}>}}
 */
export function splitAiImages(messages) {
	/** @type {Record<string, {mimeType: string, data: string}>} */
	const images = {};
	const out = [];
	for (const m of (messages ?? []).slice(-AI_MESSAGES_CAP)) {
		if (!m || typeof m.role !== 'string') continue;
		const { streaming: _s, images: pics, ...rest } = m;
		/** @type {any} */
		const rec = { ...rest, content: typeof m.content === 'string' ? m.content.slice(0, 100_000) : '' };
		if (Array.isArray(pics) && pics.length) {
			rec.images = [];
			for (const p of pics) {
				if (p?.key && !p.url) {
					rec.images.push({ key: String(p.key), name: String(p.name ?? 'picture'), mimeType: String(p.mimeType ?? 'image/jpeg') });
					continue;
				}
				if (typeof p?.url !== 'string' || !p.url.startsWith('data:')) continue;
				const data = bareBase64(p.url);
				if (!data) continue;
				const key = keyOf(data);
				const mimeType = mimeOf(p.url);
				images[key] = { mimeType, data };
				rec.images.push({ key, name: String(p.name ?? 'picture'), mimeType });
			}
			if (!rec.images.length) delete rec.images;
		}
		out.push(rec);
	}
	return { messages: out, images };
}

/**
 * A stored record's messages -> the window's, pictures joined back from their attachments (a picture
 * whose bytes are gone is left out, the words stay).
 * @param {any[]} messages @param {(key: string) => {mimeType: string, data: string} | null | undefined} lookup
 */
export function joinAiImages(messages, lookup) {
	return (messages ?? [])
		.filter((m) => m && typeof m.role === 'string')
		.map((m) => {
			if (!Array.isArray(m.images)) return { ...m };
			const images = m.images
				.map((/** @type {any} */ p) => {
					const bytes = p?.key ? lookup(p.key) : null;
					return bytes ? { url: 'data:' + bytes.mimeType + ';base64,' + bytes.data, name: p.name ?? 'picture' } : null;
				})
				.filter(Boolean);
			const { images: _old, ...rest } = m;
			return images.length ? { ...rest, images } : rest;
		});
}

/** the keys of every picture a set of records uses @param {any[]} records */
export function imageKeysOf(records) {
	const keys = new Set();
	for (const r of records ?? []) for (const m of r?.messages ?? []) for (const p of m?.images ?? []) if (p?.key) keys.add(p.key);
	return keys;
}

/** a model's transcript rebuilt from what the window shows: text turns only @param {any[]} messages */
export function transcriptOf(messages) {
	return (messages ?? [])
		.filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
		.map((m) => ({ role: m.role, content: m.content }));
}

// ---- the one History --------------------------------------------------------------------------

/** @typedef {{kind: 'people'|'agent'|'ai', id: string, title: string, sub: string, updatedAt: number, current?: boolean}} HistoryRow */

/**
 * ONE list for both tabs: session logs (People) and agent + provider chats (AI), newest first, the
 * scene you are in pinned on top of People. `filter` is all | people | ai; `query` matches the title
 * and the line under it.
 * @param {{logs: LogRow[], agents: any[], ai: AiRow[], room: {key: string, title: string}, liveCount: number, filter?: string, query?: string}} src
 * @returns {HistoryRow[]}
 */
export function historyList({ logs, agents, ai, room, liveCount, filter = 'all', query = '' }) {
	/** @type {HistoryRow[]} */
	const rows = [];
	if (filter !== 'ai') {
		const here = (logs ?? []).find((l) => l.key === room.key);
		const count = Math.max(here?.count ?? 0, liveCount);
		rows.push({ kind: 'people', id: room.key, title: 'Session · ' + room.title, sub: peopleSub(here?.people ?? [], count), updatedAt: Number.MAX_SAFE_INTEGER, current: true });
		for (const l of logs ?? []) if (l.key !== room.key && l.count) rows.push({ kind: 'people', id: l.key, title: 'Session · ' + l.title, sub: peopleSub(l.people, l.count), updatedAt: l.updatedAt });
	}
	if (filter !== 'people') {
		for (const a of agents ?? []) rows.push({ kind: 'agent', id: a.id, title: a.title, sub: (a.label || 'AI agent') + ' · in this scene', updatedAt: a.updatedAt ?? 0 });
		for (const c of ai ?? []) rows.push({ kind: 'ai', id: c.id, title: c.title, sub: (c.provider || 'Assistant') + ' · this device', updatedAt: c.updatedAt ?? 0 });
	}
	const q = query.trim().toLowerCase();
	const hit = q ? rows.filter((r) => r.title.toLowerCase().includes(q) || r.sub.toLowerCase().includes(q)) : rows;
	return hit.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** @param {string[]} people @param {number} count */
function peopleSub(people, count) {
	const who = people.length ? people.join(', ') : 'No one else yet';
	return who + ' · ' + count + ' message' + (count === 1 ? '' : 's');
}
