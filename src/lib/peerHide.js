import { writable, get } from 'svelte/store';

// Roadmap 55 A9 — HIDE, for you only. In a public room somebody you would rather not see:
// their avatar, their cursor and their voice disappear on THIS screen. Nothing is sent,
// nothing is saved, and they are not told — they are still in the session and still
// editing it, and their edits still arrive (hiding a person is not hiding the world).
// Session-scoped: peer ids are minted per session, so a list kept across reloads would
// only ever hide strangers who happen to reuse an id.

/** @type {import('svelte/store').Writable<string[]>} */
export const hiddenPeers = writable([]);

/** @param {string} peerId */
export function isHiddenPeer(peerId) {
	return get(hiddenPeers).includes(peerId);
}

/** @param {string} peerId @param {boolean} [on] */
export function setPeerHidden(peerId, on = !isHiddenPeer(peerId)) {
	hiddenPeers.update((list) => (on ? (list.includes(peerId) ? list : [...list, peerId]) : list.filter((id) => id !== peerId)));
}
