import { writable, get } from 'svelte/store';

/**
 * Session-connection state (roadmap #14 CN). STORE-ONLY module (svelte/store only)
 * so peerHandler, commandsHandler and UI can all import it without closing a module
 * cycle — the peerApproval.js precedent.
 *
 * "Host" = the peer whose session we JOINED: set when our outbound connection
 * request gets approved (their side opens a connection back to us and our
 * waitingForApproval entry flips to 'approved'). Stays null when WE are the one
 * approving others — null while connected means "you are hosting".
 */

/** @type {import('svelte/store').Writable<string|null>} */
export const sessionHost = writable(null);

/** @type {import('svelte/store').Writable<Record<string, number>>} peerId -> joined-at ms */
export const peerJoinedAt = writable({});

/** Record when a peer's connection actually OPENED (first time only). @param {string} peerId */
export function markPeerJoined(peerId) {
	const map = get(peerJoinedAt);
	if (map[peerId]) return;
	peerJoinedAt.set({ ...map, [peerId]: Date.now() });
}

/** Forget a departed peer. @param {string} peerId */
export function dropPeerJoined(peerId) {
	const map = get(peerJoinedAt);
	if (!(peerId in map)) return;
	const next = { ...map };
	delete next[peerId];
	peerJoinedAt.set(next);
}

/** Full reset — leaving the session / cancelling out. */
export function resetSession() {
	sessionHost.set(null);
	peerJoinedAt.set({});
}
