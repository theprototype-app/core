// uir-chat (q-chat-save option c) — CHATS SURVIVE A RELOAD: the live half of chatSavesCore.js.
//
// SESSION LOGS. Every line people say lands in `messages` (appStore) as before; this module copies
// each one, once, into the log of the scene that was open when it arrived (IndexedDB `chatlog:<key>`,
// newest 500) and keeps an index for History (`chatlog:index`). When a scene opens — a reload, a
// later visit — its log is merged back into the chat, marked `saved: <key>` so that leaving the
// scene takes those lines off the screen again (the session's own live lines stay: chat is
// session-wide). A peer's `chathistory` reply still merges by id on top, so nothing doubles.
//
// PROVIDER CHATS. The assistant window's conversation with your own provider (`aiMessages`) is stored
// when a reply settles (`aichat:<id>`, index `aichat:index`, newest 50); its pictures are separate
// attachment records (`aichat:img:<key>`), shared by every chat that shows them and dropped when no
// chat does. The chat that was open comes back after a reload; History opens any other.
//
// Everything here is LOCAL to this device (nothing is sent). Started once by the Chat window.

import { get, writable } from 'svelte/store';
import { messages, peers, username, userdata } from '../../stores/appStore';
import { safeStorage } from '../safeStorage';
import { idbGet, idbPut, idbDelete } from '../idb.js';
import { mergeChat } from '../chatTokens';
import {
	roomOf,
	keepLine,
	lineOf,
	cleanLine,
	appendLines,
	liveOf,
	logRow,
	upsertRow,
	aiTitle,
	splitAiImages,
	joinAiImages,
	imageKeysOf,
	transcriptOf,
	SESSION_CAP,
	AI_CHATS_CAP
} from './chatSavesCore.js';

const LOG_PREFIX = 'chatlog:';
const LOG_INDEX = 'chatlog:index';
const AI_PREFIX = 'aichat:';
const AI_INDEX = 'aichat:index';
const IMG_PREFIX = 'aichat:img:';
const ACTIVE_KEY = 'aichat:active';

/** the scene the session log belongs to right now */
export const chatRoom = writable(roomOf(null));
/** History's People rows: one per scene this device has a log for @type {import('svelte/store').Writable<import('./chatSavesCore.js').LogRow[]>} */
export const sessionLogs = writable([]);
/** History's provider rows @type {import('svelte/store').Writable<import('./chatSavesCore.js').AiRow[]>} */
export const aiChats = writable([]);
/** the provider chat the Assistant tab shows (null = a new one, not saved yet) */
export const activeAiChatId = writable(/** @type {string|null} */ (safeStorage.getItem(ACTIVE_KEY) || null));
activeAiChatId.subscribe((id) => (id ? safeStorage.setItem(ACTIVE_KEY, id) : safeStorage.removeItem(ACTIVE_KEY)));

/** a read-only look at ANOTHER scene's log (History ▸ People), null = the live chat */
export const archiveView = writable(/** @type {{key: string, title: string, lines: any[]} | null} */ (null));

/** @param {string} key */
const safeGet = (key) => idbGet(key).catch(() => null);
/** @param {string} key @param {any} value */
const safePut = (key, value) => idbPut(key, value).catch(() => {});

const me = () => /** @type {any} */ (get(peers))?.peer?.id ?? null;

// ---- session logs ------------------------------------------------------------------------------

/** ids already filed into a log this page-life (a line belongs to the scene it arrived in) */
const filed = new Set();
/** lines waiting for the debounced write, by room key @type {Map<string, any[]>} */
const pending = new Map();
let flushTimer = /** @type {any} */ (null);
/** rooms whose saved log has been merged into the chat this page-life */
const merged = new Set();

/** @param {any[]} list */
function fileNew(list) {
	const room = get(chatRoom);
	for (const m of list) {
		if (!keepLine(m) || filed.has(m.id)) continue;
		filed.add(m.id);
		const line = lineOf(m, { me: me(), myName: get(username) ?? '', nameOf });
		const q = pending.get(room.key) ?? [];
		q.push(line);
		pending.set(room.key, q);
	}
	if (pending.size && !flushTimer) flushTimer = setTimeout(flush, 800);
}

/** names seen on the roster (userdata), kept so a line keeps its author's name after they leave @type {Map<string, string>} */
const nameCache = new Map();
/** @param {string} id */
const nameOf = (id) => nameCache.get(id) ?? '';

/** write every waiting line to its log */
export async function flush() {
	clearTimeout(flushTimer);
	flushTimer = null;
	const batches = [...pending.entries()];
	pending.clear();
	for (const [key, lines] of batches) {
		const title = key === get(chatRoom).key ? get(chatRoom).title : (get(sessionLogs).find((l) => l.key === key)?.title ?? key);
		const saved = await readLog(key);
		const next = appendLines(saved, lines, SESSION_CAP);
		await safePut(LOG_PREFIX + key, { key, title, lines: next });
		const index = upsertRow(get(sessionLogs), logRow(key, title, next));
		sessionLogs.set(index);
		await safePut(LOG_INDEX, index);
	}
}

/** a scene's saved lines @param {string} key @returns {Promise<import('./chatSavesCore.js').SavedLine[]>} */
export async function readLog(key) {
	const rec = await safeGet(LOG_PREFIX + key);
	return Array.isArray(rec?.lines) ? rec.lines.map(cleanLine).filter(Boolean) : [];
}

/** the scene changed: file what is waiting, take the old scene's saved lines off, bring this one's in
 * @param {{key: string, title: string}} next */
async function enterRoom(next) {
	const prev = get(chatRoom);
	if (prev.key === next.key && merged.has(next.key)) return;
	if (pending.size) await flush();
	// every line on screen now belongs to the scene it arrived in
	for (const m of get(messages)) if (m?.id) filed.add(m.id);
	chatRoom.set(next);
	if (prev.key !== next.key) messages.update((list) => list.filter((m) => !m?.saved || m.saved === next.key));
	merged.add(next.key);
	const lines = await readLog(next.key);
	if (get(chatRoom).key !== next.key || !lines.length) return;
	const mine = me();
	const live = lines.map((l) => liveOf(l, next.key, mine));
	for (const l of live) filed.add(l.id);
	messages.update((list) => mergeChat(list, live, SESSION_CAP));
}

/** open another scene's log read-only (History ▸ People), or the live chat again (null) @param {string | null} key */
export async function viewLog(key) {
	if (!key || key === get(chatRoom).key) {
		archiveView.set(null);
		return;
	}
	const row = get(sessionLogs).find((l) => l.key === key);
	const mine = me();
	const lines = (await readLog(key)).map((l) => liveOf(l, key, mine));
	archiveView.set({ key, title: row?.title ?? key, lines });
}

/** forget one scene's saved log on this device @param {string} key */
export async function deleteLog(key) {
	await idbDelete(LOG_PREFIX + key).catch(() => {});
	const index = get(sessionLogs).filter((l) => l.key !== key);
	sessionLogs.set(index);
	await safePut(LOG_INDEX, index);
	if (get(archiveView)?.key === key) archiveView.set(null);
}

// ---- provider chats -----------------------------------------------------------------------------

/** @type {any} */
let ai = null; // the assistant module (dynamic: it pulls the AI tools)
let aiTimer = /** @type {any} */ (null);
let restoring = false;

/** @param {string} label */
async function saveAiNow(label) {
	if (!ai) return;
	const list = get(ai.aiMessages);
	if (!list.length || get(ai.aiBusy)) return;
	const { messages: stored, images } = splitAiImages(list);
	let id = get(activeAiChatId);
	if (!id) {
		id = 'ai-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
		activeAiChatId.set(id);
	}
	for (const [key, bytes] of Object.entries(images)) {
		if (!(await safeGet(IMG_PREFIX + key))) await safePut(IMG_PREFIX + key, bytes);
	}
	const updatedAt = Date.now();
	const prev = await safeGet(AI_PREFIX + id);
	const record = { id, title: aiTitle(stored), provider: prev?.provider || label, updatedAt, messages: stored };
	await safePut(AI_PREFIX + id, record);
	let index = upsertRow(get(aiChats), { id, title: record.title, provider: record.provider, updatedAt, count: stored.length }, 'id');
	const dropped = index.slice(AI_CHATS_CAP);
	index = index.slice(0, AI_CHATS_CAP);
	aiChats.set(index);
	await safePut(AI_INDEX, index);
	if (dropped.length) await dropAiChats(dropped.map((r) => r.id));
}

/** delete provider chats and every picture no remaining chat shows @param {string[]} ids */
async function dropAiChats(ids) {
	const gone = [];
	for (const id of ids) {
		gone.push(await safeGet(AI_PREFIX + id));
		await idbDelete(AI_PREFIX + id).catch(() => {});
	}
	const kept = [];
	for (const r of get(aiChats)) kept.push(await safeGet(AI_PREFIX + r.id));
	const still = imageKeysOf(kept);
	for (const key of imageKeysOf(gone)) if (!still.has(key)) await idbDelete(IMG_PREFIX + key).catch(() => {});
}

/** forget one provider chat on this device @param {string} id */
export async function deleteAiChat(id) {
	aiChats.set(get(aiChats).filter((r) => r.id !== id));
	await safePut(AI_INDEX, get(aiChats));
	await dropAiChats([id]);
	if (get(activeAiChatId) === id) {
		activeAiChatId.set(null);
		ai?.resetAiConversation();
	}
}

/** open a saved provider chat in the Assistant tab @param {string} id @returns {Promise<boolean>} */
export async function openAiChat(id) {
	ai ??= await import('../ai/assistant.js');
	const rec = await safeGet(AI_PREFIX + id);
	if (!rec || !Array.isArray(rec.messages)) return false;
	if (get(ai.aiBusy)) ai.stopAi();
	/** @type {Record<string, any>} */
	const bytes = {};
	for (const key of imageKeysOf([rec])) bytes[key] = await safeGet(IMG_PREFIX + key);
	const list = joinAiImages(rec.messages, (k) => bytes[k]);
	restoring = true;
	activeAiChatId.set(id);
	ai.restoreAiConversation(list, transcriptOf(list));
	restoring = false;
	return true;
}

/** a fresh provider chat (the window's New chat) */
export function newAiChat() {
	activeAiChatId.set(null);
	ai?.resetAiConversation();
}

// ---- start ----------------------------------------------------------------------------------------

let started = false;

/**
 * Start saving (idempotent). `providerLabel` names the provider a new chat is with.
 * @param {{providerLabel?: () => string}} [opts]
 */
export async function startChatSaves(opts = {}) {
	if (started) return;
	started = true;
	const [logIndex, aiIndex] = await Promise.all([safeGet(LOG_INDEX), safeGet(AI_INDEX)]);
	if (Array.isArray(logIndex)) sessionLogs.set(logIndex.filter((r) => r && typeof r.key === 'string'));
	if (Array.isArray(aiIndex)) aiChats.set(aiIndex.filter((r) => r && typeof r.id === 'string'));

	// names on the roster, remembered so a saved line keeps its author's name after they leave
	userdata.subscribe((rows) => {
		for (const r of rows ?? []) if (Array.isArray(r) && r[0] && r[1]) nameCache.set(String(r[0]), String(r[1]));
	});

	// the scene: a dynamic import (levels.js sits in the history-cycle family)
	const { currentLevel } = await import('../levels.js');
	currentLevel.subscribe((level) => {
		enterRoom(roomOf(level)).catch(() => {});
	});
	messages.subscribe(fileNew);

	// provider chats: the one that was open comes back; a settled reply is saved
	ai = await import('../ai/assistant.js');
	const active = get(activeAiChatId);
	if (active && !get(ai.aiMessages).length) {
		if (!(await openAiChat(active))) activeAiChatId.set(null);
	}
	ai.aiMessages.subscribe(() => {
		if (restoring) return;
		clearTimeout(aiTimer);
		aiTimer = setTimeout(() => saveAiNow(opts.providerLabel?.() ?? 'Assistant').catch(() => {}), 600);
	});
	ai.aiBusy.subscribe((/** @type {boolean} */ busy) => {
		if (busy || restoring) return;
		clearTimeout(aiTimer);
		aiTimer = setTimeout(() => saveAiNow(opts.providerLabel?.() ?? 'Assistant').catch(() => {}), 300);
	});
	if (typeof window !== 'undefined') window.addEventListener('pagehide', () => void flush());
}

/** test seam: the live state @returns {any} */
export function chatSavesForTest() {
	return { room: get(chatRoom), logs: get(sessionLogs), ai: get(aiChats), active: get(activeAiChatId), filed: filed.size, flush };
}
