import { get } from 'svelte/store';
import { peers, userdata, avatarConfig, showToast } from '../stores/appStore';
import { safeStorage } from './safeStorage';

// Roadmap 55 A9 — peer-menu actions shared by the Users panel and the VR People ring.

/** @param {string} peerId */
export function peerName(peerId) {
	const row = /** @type {any[]} */ (get(userdata)).find((u) => u[0] === peerId);
	return (row && row[1]) || String(peerId).slice(0, 6).toUpperCase();
}

/** Does this peer wear something other than the default look? @param {string} peerId */
export function hasLook(peerId) {
	const row = /** @type {any[]} */ (get(userdata)).find((u) => u[0] === peerId);
	return !!row?.[5] && Object.keys(row[5]).length > 0;
}

/**
 * COPY THEIR LOOK: wear their character and colours. Our own slot 5, written and sent the
 * way the character panel's own commit does it (a `userdata` broadcast) — so the change
 * replicates like any avatar edit and can be changed back in Change character.
 * @param {string} peerId @returns {boolean}
 */
export function copyLookOf(peerId) {
	const rows = /** @type {any[]} */ (get(userdata));
	const theirs = rows.find((u) => u[0] === peerId)?.[5];
	if (!theirs) return false;
	const next = { ...theirs };
	avatarConfig.set(/** @type {any} */ (next));
	try {
		safeStorage.setItem('avatarConfig', JSON.stringify(next));
	} catch {
		/* storage refused: the look still applies for this session */
	}
	/** @type {any} */
	const pc = get(peers);
	const me = pc?.peer?.id;
	rows.forEach((row) => {
		if (row[0] === me) row[5] = next;
	});
	userdata.set(/** @type {any} */ (rows));
	pc?.send?.({ type: 'userdata', userdata: rows });
	showToast('You now wear ' + peerName(peerId) + '’s look. Change character to adjust it.');
	return true;
}
