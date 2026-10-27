// Object locks name a peer: who holds, who lets go, who asks. The name that counts is the
// connection's own (`conn.peer`), never one carried in the payload — the payload fields stay
// on the wire for older peers and are ignored on receipt.
//
// PURE (no imports) so the rules are unit-tested without a mesh: tests/unit/lockTrust.test.js.

/** one `lockrequest` per peer and object in this window */
export const LOCK_REQUEST_GAP_MS = 3000;

/** @param {any} v */
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128;

/**
 * The rows of a `locked` table (handshake / room arrival) that its sender may speak for.
 * The session host forwards the room's table, so its rows may name anyone; every other
 * connection speaks only for itself. A sender that may not take locks at all (a viewer,
 * when a capability provider says so) adds nothing. Rows naming us are ours to know, never
 * a peer's to tell. Malformed and repeated rows are dropped.
 * @param {any} rows
 * @param {{from: string, selfId?: string | null, fromHost: boolean, mayLock: boolean}} ctx
 * @returns {[string, string][]}
 */
export function acceptedLockRows(rows, { from, selfId, fromHost, mayLock }) {
	if (!Array.isArray(rows) || !mayLock || !isId(from)) return [];
	/** @type {[string, string][]} */
	const out = [];
	const seen = new Set();
	for (const row of rows) {
		if (!Array.isArray(row) || !isId(row[0]) || !isId(row[1])) continue;
		if (row[0] === selfId) continue;
		if (!fromHost && row[0] !== from) continue;
		const key = row[0] + '\n' + row[1];
		if (seen.has(key)) continue;
		seen.add(key);
		out.push([row[0], row[1]]);
	}
	return out;
}

/**
 * `table` plus the `rows` it does not already have (a re-sent table must not stack).
 * @param {any[] | null | undefined} table @param {[string, string][]} rows @returns {any[]}
 */
export function mergeLockRows(table, rows) {
	const base = Array.isArray(table) ? table : [];
	const have = new Set(base.filter(Array.isArray).map((l) => l[0] + '\n' + l[1]));
	return base.concat(rows.filter((r) => !have.has(r[0] + '\n' + r[1])));
}

/**
 * Does `peerId` hold `uuid` in this table?
 * @param {any[] | null | undefined} table @param {string} peerId @param {string} uuid
 */
export function holdsLock(table, peerId, uuid) {
	return Array.isArray(table) && table.some((l) => Array.isArray(l) && l[0] === peerId && l[1] === uuid);
}

/**
 * Is `uuid` held by anybody in this table?
 * @param {any[] | null | undefined} table @param {string} uuid
 */
export function isHeld(table, uuid) {
	return Array.isArray(table) && table.some((l) => Array.isArray(l) && l[1] === uuid);
}

/**
 * A per-peer, per-object limiter for control requests: `allow(from, uuid, now)` is true at
 * most once per `gapMs` for each pair. The map prunes itself, so a peer cycling through
 * uuids cannot grow it without bound.
 * @param {number} [gapMs]
 */
export function createRequestLimiter(gapMs = LOCK_REQUEST_GAP_MS) {
	/** @type {Map<string, number>} */
	const last = new Map();
	return {
		/** @param {string} from @param {string} uuid @param {number} now */
		allow(from, uuid, now) {
			if (last.size > 256) {
				for (const [k, t] of last) if (now - t >= gapMs) last.delete(k);
			}
			const key = from + '\n' + uuid;
			const prev = last.get(key);
			if (prev !== undefined && now - prev < gapMs) return false;
			last.set(key, now);
			return true;
		},
		/** forget one peer (it left) @param {string} from */
		drop(from) {
			for (const k of last.keys()) if (k.startsWith(from + '\n')) last.delete(k);
		}
	};
}
