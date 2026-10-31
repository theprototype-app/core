// 55 (1.48.1, 41's voice-Claude finding b): WHO holds a lock, said in the AI tools' skip. "locked by another peer"
// left an agent guessing which object and whom to ask; the skip now names both. A leaf (stores only), shared by
// tools.js and flowTools.js.

import { get } from 'svelte/store';
import { lockedObjects } from '../../stores/sceneStore.js';
import { userdata } from '../../stores/appStore.js';

/** @param {string} uuid @returns {{peerId: string, name: string} | null} the peer holding the object's lock */
export function lockHolder(uuid) {
	const row = /** @type {any[]} */ (get(lockedObjects)).find((l) => l?.[1] === uuid);
	if (!row) return null;
	const peerId = String(row[0] ?? '');
	const user = /** @type {any[]} */ (get(userdata) ?? []).find((u) => u?.[0] === peerId);
	return { peerId, name: String(user?.[1] ?? '') };
}

/**
 * The skip text: the object (by name when it has one) and who holds it. Pure over its inputs (exported for the unit test).
 * @param {string} uuid @param {string} objectName @param {{peerId: string, name: string}} holder
 */
export function lockNoteText(uuid, objectName, holder) {
	const what = objectName ? '"' + objectName + '" (' + uuid + ')' : uuid;
	const who = holder.name ? holder.name + ' (peer ' + holder.peerId + ')' : 'peer ' + holder.peerId;
	return what + ' is locked by ' + who + ' — they are editing it; try again when they let go';
}

/** @param {string} uuid @param {any} [object] @returns {string | null} the skip text, or null when nobody holds it */
export function lockSkip(uuid, object) {
	const holder = lockHolder(uuid);
	return holder ? lockNoteText(uuid, String(object?.name ?? ''), holder) : null;
}
