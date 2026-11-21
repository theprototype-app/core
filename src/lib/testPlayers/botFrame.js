// 61 G3 — IS THIS PAGE A "TEST WITH PLAYERS" BOT? A LEAF (safeStorage only), in the boot graph and on
// purpose tiny: the transport (localLink.js) and the host's sheet are dynamic imports.
//
// A bot is a frame of the tab that started the test, opened with `?tpbot=<test id>&tprole=<role>&tpn=<n>`
// and the host's id as its hash (the ordinary invite auto-dial). `storageIsolated` (safeStorage) is the
// same test, made once: a frame that says it is a bot keeps every write in memory.

import { storageIsolated } from '../safeStorage';

/** the roles a bot can be given in the sheet */
export const BOT_ROLES = /** @type {const} */ (['editor', 'viewer', 'player']);

/** @returns {{test: string, role: 'editor' | 'viewer' | 'player', n: number} | null} */
function read() {
	if (!storageIsolated) return null;
	try {
		const q = new URLSearchParams(location.search);
		const test = String(q.get('tpbot') || '').slice(0, 40);
		if (!/^[0-9a-z-]{4,40}$/i.test(test)) return null;
		const role = /** @type {any} */ (BOT_ROLES.includes(/** @type {any} */ (q.get('tprole'))) ? q.get('tprole') : 'player');
		const n = Math.max(1, Math.min(9, Math.floor(Number(q.get('tpn')) || 1)));
		return { test, role, n };
	} catch {
		return null;
	}
}

/** This frame's bot facts, or null on every ordinary page. */
export const botFrame = read();
