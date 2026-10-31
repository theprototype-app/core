// Roadmap 56 — THE AGENT PAGE's INBOX, wired (behaviour: ./agentInboxCore.js). Reached only by dynamic
// imports: peerHandler's `agentchat` line on an agent page, and tpAgent.js. A person's page never loads it.
//
// The `.tpchat` store (56-media, `src/lib/chat/tpchatStore.js`) answers history for a chat this page did
// not witness (C11). It is found by a glob, so this file works with or without that module in the build.

import { get } from 'svelte/store';
import { createInbox, HEARTBEAT_MS } from './agentInboxCore.js';
import { peers, userdata } from '../../stores/appStore.js';
import { sessionHost } from '$lib/connectionState';
import { rolesInfo } from '$lib/cloudHooks';

const chatStores = import.meta.glob('../chat/tpchatStore.js');

/** @returns {Promise<((chatId: string) => any) | null>} */
async function chatReader() {
	const load = Object.values(chatStores)[0];
	if (!load) return null;
	try {
		const m = /** @type {any} */ (await load());
		return typeof m.readChat === 'function' ? m.readChat : null;
	} catch {
		return null;
	}
}

/** @param {string} id */
function nameOf(id) {
	const row = (/** @type {any[]} */ (get(userdata)) ?? []).find((u) => Array.isArray(u) && u[0] === id);
	return row?.[1] ? String(row[1]) : '';
}

function myId() {
	const p = /** @type {any} */ (get(peers));
	return p?.peer?.id ?? p?.myId ?? null;
}

/** @type {ReturnType<typeof createInbox> | null} */
let inbox = null;

/** The page's one inbox (made on first use; the heartbeat starts with it). */
export function agentInbox() {
	if (inbox) return inbox;
	inbox = createInbox({
		selfId: myId,
		roleOf: (id) => /** @type {any} */ (get(rolesInfo))?.roleOf?.(id) ?? null,
		host: () => get(sessionHost),
		nameOf,
		myName: () => nameOf(myId()),
		send: (msg) => /** @type {any} */ (get(peers))?.send?.(msg),
		readChat: async (chatId) => (await chatReader())?.(chatId) ?? null
	});
	const beat = inbox.heartbeat;
	setInterval(() => {
		if (myId()) beat();
	}, HEARTBEAT_MS);
	return inbox;
}

/** peerHandler's `agentchat` line on an agent page @param {string} fromPeer @param {any} data */
export function receiveAgentChat(fromPeer, data) {
	agentInbox().receive(fromPeer, data);
}
