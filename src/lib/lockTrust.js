// Object locks name a peer: who holds, who lets go, who asks. The name that counts is the
// connection's own (`conn.peer`), never one carried in the payload — the payload fields stay
// on the wire for older peers and are ignored on receipt.
//
// PURE (no imports) so the rules are unit-tested without a mesh: tests/unit/lockTrust.test.js.

/** one `lockrequest` per peer and object in this window */
export const LOCK_REQUEST_GAP_MS = 3000;

/** @param {any} v */
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128;

/** a lock stamp: when the holder took the object, on the session clock (sessionNow) @param {any} v */
const isStamp = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The rows of a `locked` table (handshake / room arrival) that its sender may speak for.
 * The session host forwards the room's table, so its rows may name anyone; every other
 * connection speaks only for itself. A sender that may not take locks at all (a viewer,
 * when a capability provider says so) adds nothing. Rows naming us are ours to know, never
 * a peer's to tell. Malformed and repeated rows are dropped.
 * @param {any} rows
 * @param {{from: string, selfId?: string | null, fromHost: boolean, mayLock: boolean}} ctx
 * @returns {([string, string] | [string, string, number])[]}
 */
export function acceptedLockRows(rows, { from, selfId, fromHost, mayLock }) {
	if (!Array.isArray(rows) || !mayLock || !isId(from)) return [];
	/** @type {([string, string] | [string, string, number])[]} */
	const out = [];
	const seen = new Set();
	for (const row of rows) {
		if (!Array.isArray(row) || !isId(row[0]) || !isId(row[1])) continue;
		if (row[0] === selfId) continue;
		if (!fromHost && row[0] !== from) continue;
		const key = row[0] + '\n' + row[1];
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(isStamp(row[2]) ? [row[0], row[1], row[2]] : [row[0], row[1]]);
	}
	return out;
}

/**
 * `table` plus the `rows` it does not already have (a re-sent table must not stack).
 * @param {any[] | null | undefined} table @param {any[][]} rows @returns {any[]}
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

// ---------------------------------------------------------------------------------------------
// 80a K3: two peers taking one object, and the receiving-side gate.
//
// A lock row is [holder, uuid, at?]: `at` is when the holder took the object on the session clock
// (sessionNow, so two machines compare one clock). Two peers selecting at once both send a `lock`;
// every peer keeps both rows and agrees on ONE holder: the earlier stamp, then the lower peer id.
// An older peer sends no stamp and loses to any stamped row. Losing rows are kept, so when the
// holder lets go the other claim takes over with no new message.

/**
 * Does lock `a` beat lock `b`? A strict order: never true for a row against itself.
 * @param {{peer: string, at?: any}} a @param {{peer: string, at?: any}} b
 */
export function lockBeats(a, b) {
	const ta = isStamp(a.at) ? a.at : Infinity;
	const tb = isStamp(b.at) ? b.at : Infinity;
	if (ta !== tb) return ta < tb;
	return a.peer < b.peer;
}

/** @param {any} row */
const isRow = (row) => Array.isArray(row) && isId(row[0]) && isId(row[1]);

/**
 * Who holds `uuid`: the winning row of `table` (remote locks), with our own claim (`mine`) in the
 * running. Null when nobody does.
 * @param {any[] | null | undefined} table @param {string} uuid
 * @param {{self: string, at?: any} | null} [mine] our own claim on this uuid, if we have one
 * @returns {string | null}
 */
export function holderOf(table, uuid, mine = null) {
	/** @type {{peer: string, at?: any} | null} */
	let best = mine && isId(mine.self) ? { peer: mine.self, at: mine.at } : null;
	if (Array.isArray(table))
		for (const row of table) {
			if (!isRow(row) || row[1] !== uuid) continue;
			const cand = { peer: row[0], at: row[2] };
			if (!best || lockBeats(cand, best)) best = cand;
		}
	return best ? best.peer : null;
}

/**
 * The table in holder order: for every object its winning row comes first, so the many readers
 * that ask `table.find((l) => l[1] === uuid)` read the holder. The same order on every peer.
 * @param {any[]} table @returns {any[]}
 */
export function sortLockTable(table) {
	return table.filter(isRow).sort((a, b) => (lockBeats({ peer: a[0], at: a[2] }, { peer: b[0], at: b[2] }) ? -1 : lockBeats({ peer: b[0], at: b[2] }, { peer: a[0], at: a[2] }) ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

/**
 * A `lock` message's rows: its uuids, each with its stamp from the parallel `ats` (when it has one).
 * @param {string} peerId @param {string[]} uuids @param {any} ats
 */
export function stampedRows(peerId, uuids, ats) {
	return uuids.map((u, i) => (Array.isArray(ats) && isStamp(ats[i]) ? [peerId, u, ats[i]] : [peerId, u]));
}

/**
 * The edits the receiving side checks against locks, and the field naming the object. Flow edits
 * name the object whose flow they change (`graphId`; the scene graph is nobody's). Runtime traffic
 * (pulses, presence, physics hits) is not an edit and is not here.
 * @type {Record<string, string>}
 */
export const LOCK_GATED = {
	move: 'uuid',
	name: 'uuid',
	delete: 'uuid',
	color: 'uuid',
	objectParameters: 'uuid',
	geometry: 'uuid',
	lighttarget: 'uuid',
	verts: 'uuid',
	meshgeo: 'uuid',
	splineedit: 'uuid',
	animdata: 'uuid',
	shadergraph: 'key',
	shadergraphdelete: 'key',
	graphcreate: 'uuid',
	graphdelete: 'uuid',
	nodecreate: 'graphId',
	nodemove: 'graphId',
	nodedata: 'graphId',
	nodedelete: 'graphId',
	edgecreate: 'graphId',
	edgedelete: 'graphId'
};

/** ids that are not objects: the scene graph, post / scene shader keys */
const NOT_OBJECT = /^(scene|post:.*)$/;

/**
 * The object an edit touches, or null when the gate does not cover it.
 * @param {any} data @returns {string | null}
 */
export function gatedUuid(data) {
	if (!data || typeof data.type !== 'string' || !Object.prototype.hasOwnProperty.call(LOCK_GATED, data.type)) return null;
	const v = data[LOCK_GATED[data.type]];
	return isId(v) && !NOT_OBJECT.test(v) ? v : null;
}

/**
 * What the receiving side does with an edit:
 * - `apply`: nobody else holds the object (or the sender does);
 * - `reject`: WE hold it: drop it, tell the sender (`lockreject`) and send it the object as it is;
 * - `drop`: a third peer holds it: drop it (the holder answers);
 * - `park`: the sender also claims it while another row still wins (a hand-over whose `unlock`
 *   is still on its way): hold it a moment and apply it once the sender holds the object.
 * A running world (simulation, a peer in play) moves things: `move` passes then.
 * @param {{data: any, from: string, selfId: string | null | undefined, table: any[], mine: {self: string, at?: any} | null, runtime: boolean}} ctx
 * @returns {'apply' | 'reject' | 'drop' | 'park'}
 */
export function lockGateVerdict({ data, from, table, mine, runtime }) {
	const uuid = gatedUuid(data);
	if (!uuid) return 'apply';
	if (runtime && data.type === 'move') return 'apply';
	const holder = holderOf(table, uuid, mine);
	if (!holder || holder === from) return 'apply';
	if (mine && holder === mine.self) return 'reject';
	if (holdsLock(table, from, uuid)) return 'park';
	return 'drop';
}

/** how far back a new claim on a HELD object may be dated: one-way latency plus clock error */
export const LOCK_RACE_MS = 2000;

/**
 * The stamp we store for one row of a peer's `lock` set. An object the peer already held keeps the
 * stamp we stored then (a re-sent set cannot re-date it). A claim on an object somebody else holds
 * is a race only if it was made about when it arrived: it may not be dated earlier than
 * `LOCK_RACE_MS` before now, so a claim dated back cannot take an object held for longer.
 * @param {{claimed: any, prev: number | undefined, contested: boolean, now: number}} ctx
 * @returns {number | undefined}
 */
export function claimStamp({ claimed, prev, contested, now }) {
	if (isStamp(prev)) return prev;
	if (!isStamp(claimed)) return undefined;
	return contested ? Math.max(claimed, now - LOCK_RACE_MS) : claimed;
}
