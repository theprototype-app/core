// 56 C1/C4/C5/C6/C11 — the agent chat on every peer: stores + wire (the pure reducer is
// agentChatCore.js). Store-only like agentLog.js: peerHandler, the AI assistant window, the
// Users menu and the VR panel reach it; it imports no peer or history module, so no cycle.
//
//   SEND   a person's request / Stop / a host's Mute go out on `{type:'agentchat'}` to the whole
//          mesh (F1: the session reads the thread) and apply here first (golden rule 1).
//   RECEIVE peerHandler hands every `agentchat` to `applyAgentChatMessage(conn.peer, data)`; the
//          agent page's own half (56-bridge's agentInbox) ACTS on the ones addressed to it.
//   LATE JOINER `sendAgentChatBacklogTo(conn)` in the handshake (the newest 200 messages);
//          saved chats come with the scene through the `.tpchat` store (56-media).
//   FILES  one writer per session saves each chat through the store (`saveChat`, debounced).
import { writable, derived, get } from 'svelte/store';
import { peers, userdata, username, showToast, aiAssistantHidden } from '../stores/appStore';
import { rolesInfo } from './cloudHooks';
import { sessionHost } from './connectionState';
import {
	emptyState,
	applyAgentChat,
	agentGone,
	backlogOf,
	runningRequest,
	loadChat,
	chatRecord,
	isChatWriter,
	samePeer,
	kindOf
} from './agentChatCore.js';
import { chatList, readChat, saveChat, registerChatOpener } from './chat/tpchatStore.js';

/** every chat + every agent's status this peer knows @type {import('svelte/store').Writable<ReturnType<typeof emptyState>>} */
export const agentChatState = writable(emptyState());

/**
 * Who the AI window talks to: null = the configured provider (the app's own chat, F3 — as
 * before), or an agent peer. LOCAL: a fact about this screen.
 * @type {import('svelte/store').Writable<null | {kind: 'agent', id: string}>}
 */
export const chatTarget = writable(null);
/** the agent chat the window shows (null = a fresh one, minted on the first send) */
export const activeChatId = writable(/** @type {string|null} */ (null));
/** chatId -> message count the window last showed (the history list's unread dot) */
export const seenCounts = writable(/** @type {Record<string, number>} */ ({}));

/** @returns {any} */
const link = () => get(peers);
/** @returns {string|null} */
export const myPeerId = () => link()?.peer?.id ?? null;

/** the roster row of a peer @param {string} id */
const rowOf = (id) => (/** @type {any[]} */ (get(userdata)) ?? []).find((r) => Array.isArray(r) && samePeer(r[0], id));

/** a peer's display name @param {string} id */
export function peerLabel(id) {
	if (samePeer(id, myPeerId())) return 'You';
	const row = rowOf(id);
	return (row && row[1]) || (row?.[6]?.kind === 'agent' ? 'AI agent' : String(id || '').slice(0, 5).toUpperCase());
}

/**
 * The agents a person can address: connected peers whose roster row says `kind:'agent'`
 * (55 invite), with how they run when their status said (`mode`).
 */
export const agentTargets = derived([userdata, peers, agentChatState], ([$rows, $peers, $state]) => {
	const open = /** @type {any} */ ($peers)?.openedPeers;
	const online = (/** @type {string} */ id) => !open || [...open].some((p) => samePeer(p, id));
	return (/** @type {any[]} */ ($rows) ?? [])
		.filter((r) => Array.isArray(r) && r[6]?.kind === 'agent' && online(r[0]))
		.map((r) => {
			const st = Object.entries($state.agents).find(([k]) => samePeer(k, r[0]))?.[1];
			const name = String(r[1] || 'AI agent');
			// "Claude · agent via MCP" / "grok-3-mini · agent REPL" (the REPL names its model)
			const label = st?.mode === 'repl' ? (st.model || name) + ' · agent REPL' : st?.mode === 'mcp' ? name + ' · agent via MCP' : name + ' · agent';
			return { id: String(r[0]), name, label, status: st?.status ?? null, muted: !!st?.muted };
		});
});

/** an agent's status row (or null) @param {ReturnType<typeof emptyState>} state @param {string} id */
export function agentStatusOf(state, id) {
	return Object.entries(state.agents).find(([k]) => samePeer(k, id))?.[1] ?? null;
}

// ---------------------------------------------------------------- roles (C5)

/** a peer's role as THIS peer knows it (rolesInfo; null = no roles in this build) @param {string} id */
export function roleOfPeer(id) {
	/** @type {any} */
	const ri = get(rolesInfo);
	if (!ri) return null;
	try {
		return samePeer(id, myPeerId()) ? ri.myRole ?? null : ri.roleOf?.(id) ?? null;
	} catch {
		return null;
	}
}
/** am I a viewer (the composer says what the agent will and won't do) */
export const iAmViewer = () => roleOfPeer(myPeerId() ?? '') === 'viewer';
/** may I mute an agent? the session host (OSS) or an admin (cloud) */
export function canMuteAgents() {
	/** @type {any} */
	const ri = get(rolesInfo);
	if (ri) return !!ri.amAdmin || (get(sessionHost) === null && ri.myRole !== 'viewer');
	return get(sessionHost) === null;
}
/** may I Stop this request? its sender, the host, or anyone who is not a viewer @param {any} request */
export function canStop(request) {
	if (!request) return false;
	if (samePeer(request.from, myPeerId())) return true;
	return get(sessionHost) === null || !iAmViewer();
}

// ---------------------------------------------------------------- send

/** @param {any} msg */
function broadcast(msg) {
	try {
		link()?.send?.({ type: 'agentchat', ...msg });
		return true;
	} catch {
		return false;
	}
}

/** @param {any} msg */
function applyOwn(msg) {
	const me = myPeerId();
	if (!me) return;
	agentChatState.update((s) => applyAgentChat(s, me, { type: 'agentchat', ...msg }));
}

const newId = () => (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

/** start a fresh chat with the current agent (C11 New chat) */
export function newChat() {
	activeChatId.set(newId());
}

/**
 * Send a person's message to an agent (C1). Returns false with nothing sent when there is no
 * agent or no link. `answers` = the ask this is a button press for.
 * @param {string} text @param {{agentId?: string, chatId?: string, images?: any[], answers?: string}} [opts]
 */
export function sendToAgent(text, opts = {}) {
	const agentId = opts.agentId ?? get(chatTarget)?.id;
	const me = myPeerId();
	if (!agentId || !me) return false;
	let chatId = opts.chatId ?? get(activeChatId);
	const chat = chatId ? get(agentChatState).chats[chatId] : null;
	if (!chatId || (chat && chat.agent && !samePeer(chat.agent, agentId))) {
		chatId = newId();
	}
	activeChatId.set(chatId);
	/** @type {any} */
	const msg = { id: newId(), chatId, from: me, to: agentId, text: String(text ?? ''), at: Date.now() };
	const name = String(get(username) ?? '').trim();
	if (name) msg.name = name.slice(0, 32);
	if (opts.images?.length) msg.images = opts.images.slice(0, 4);
	if (opts.answers) msg.answers = opts.answers;
	applyOwn(msg);
	return broadcast(msg);
}

/** Stop the running request in a chat (C6) — `{cancel}` to the agent @param {string} [chatId] */
export function stopAgentRequest(chatId = get(activeChatId) ?? '') {
	const state = get(agentChatState);
	const chat = state.chats[chatId];
	const running = runningRequest(chat);
	const me = myPeerId();
	if (!running || !me || !canStop(running)) return false;
	const msg = { cancel: running.id, chatId, from: me, to: chat.agent };
	applyOwn(msg);
	return broadcast(msg);
}

/** Stop whatever an agent is answering, in any chat (the Users menu's "Stop request") @param {string} agentId */
export function stopAgent(agentId) {
	const state = get(agentChatState);
	let stopped = false;
	for (const chat of Object.values(state.chats)) if (samePeer(chat.agent, agentId) && runningRequest(chat)) stopped = stopAgentRequest(chat.id) || stopped;
	return stopped;
}

/** mute / unmute an agent (C5; the agent page obeys the host or an admin) @param {string} agentId @param {boolean} mute */
export function muteAgent(agentId, mute) {
	const me = myPeerId();
	if (!me || !canMuteAgents()) return false;
	return broadcast({ from: me, to: agentId, mute: !!mute });
}

// ---------------------------------------------------------------- receive

/**
 * An `agentchat` arrived from `fromPeer`. The first reply from an agent while the window is
 * shut says where to read it.
 * @param {string} fromPeer @param {any} data
 */
export function applyAgentChatMessage(fromPeer, data) {
	const before = get(agentChatState);
	const next = applyAgentChat(before, fromPeer, data);
	if (next === before) return;
	agentChatState.set(next);
	const k = kindOf(data);
	if ((k === 'reply' || k === 'ask') && !data.partial && samePeer(data.to, myPeerId()) && get(aiAssistantHidden) !== '') {
		showToast(peerLabel(fromPeer) + ' answered you in the AI assistant.', [{ label: 'Show', action: () => openChatInAssistant(data.chatId) }]);
	}
}

/** the late joiner's share, straight down the opening conn @param {any} conn */
export function sendAgentChatBacklogTo(conn) {
	const backlog = backlogOf(get(agentChatState));
	if (!backlog.length || !conn) return;
	try {
		conn.send({ type: 'agentchat', backlog });
	} catch {
		/* the next handshake will carry it */
	}
}

/** a peer left: if it was an agent, it is away @param {string} peerId */
export function agentChatPeerGone(peerId) {
	agentChatState.update((s) => agentGone(s, peerId));
}

// ---------------------------------------------------------------- history (C11)

/**
 * Open a chat in the AI window: from memory, else the scene's `.tpchat` store. Its agent
 * becomes the target (even if it is not connected now — the thread still reads).
 * @param {string} chatId
 */
export async function openChatInAssistant(chatId) {
	if (!chatId) return false;
	let chat = get(agentChatState).chats[chatId];
	if (!chat) {
		const saved = await readChat(chatId);
		if (saved) agentChatState.update((s) => loadChat(s, saved));
		chat = get(agentChatState).chats[chatId];
		if (!chat && saved?.target?.kind === 'agent') {
			// an empty saved chat: still a place to type
			chatTarget.set({ kind: 'agent', id: saved.target.id });
			activeChatId.set(chatId);
			aiAssistantHidden.set('');
			return true;
		}
	}
	if (!chat) {
		showToast('That chat is not in this scene any more.');
		return false;
	}
	chatTarget.set({ kind: 'agent', id: chat.agent });
	activeChatId.set(chatId);
	aiAssistantHidden.set('');
	return true;
}
registerChatOpener((id) => void openChatInAssistant(id));

/** mark the open chat read @param {string} chatId @param {number} count */
export function markChatSeen(chatId, count) {
	seenCounts.update((m) => (m[chatId] === count ? m : { ...m, [chatId]: count }));
}

/** the scene's saved chats (re-exported for the window) */
export { chatList };

// ---------------------------------------------------------------- files: one writer per session

/** @type {Map<string, any>} */
const saveTimers = new Map();
/** @type {Map<string, string>} */
const savedSig = new Map();
const SAVE_DELAY = 2000;

function iAmWriter() {
	const me = myPeerId();
	const open = [.../** @type {any} */ (link())?.openedPeers ?? []];
	const editors = open.filter((id) => roleOfPeer(id) !== 'viewer' && rowOf(id)?.[6]?.kind !== 'agent');
	return isChatWriter({ myId: me, hostId: get(sessionHost), iCanEdit: !iAmViewer(), editors });
}

/** @param {any} chat */
function scheduleSave(chat) {
	// streaming partials are not worth a file write — the final copy is
	if (chat.messages.some((/** @type {any} */ m) => m.partial)) return;
	const rec = chatRecord(chat, agentLabelOf(chat.agent));
	const sig = JSON.stringify(rec.messages.map((/** @type {any} */ m) => [m.id, m.text.length, !!m.cancelled])) + rec.title;
	if (savedSig.get(chat.id) === sig) return;
	clearTimeout(saveTimers.get(chat.id));
	saveTimers.set(
		chat.id,
		setTimeout(() => {
			saveTimers.delete(chat.id);
			if (!iAmWriter()) return;
			const live = get(agentChatState).chats[chat.id];
			if (!live) return;
			const saved = /** @type {any} */ (readChat(chat.id));
			const fresh = chatRecord(live, agentLabelOf(live.agent));
			try {
				// the store keeps what it owns (include switch, image refs) — we hand the thread
				saveChat({ ...(saved && typeof saved.then !== 'function' ? saved : {}), ...fresh, title: saved?.title || fresh.title });
				savedSig.set(chat.id, sig);
			} catch {
				/* the store refused (a cap): the thread still shows */
			}
		}, SAVE_DELAY)
	);
}

/** @param {string} agentId */
function agentLabelOf(agentId) {
	return get(agentTargets).find((t) => samePeer(t.id, agentId))?.label ?? peerLabel(agentId);
}

/** @type {Record<string, any>} */
let lastChats = {};
agentChatState.subscribe((s) => {
	for (const chat of Object.values(s.chats)) if (lastChats[chat.id] !== chat) scheduleSave(chat);
	lastChats = s.chats;
});
