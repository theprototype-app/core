// 85b S2 — POINT-AND-SAY, the pure half. A ping already flashed a marker for everyone for 4 s (87); an agent needs
// it to LAST a little and to say WHAT was pinged, so "put a lamp here" can build at it. The record gains an
// optional `on` — the object the ping landed on, the point and the surface normal in THAT OBJECT'S frame — so a
// ping on a table follows the table if somebody moves it. The log keeps a few pings per person for a short
// while; nothing here is saved, undone or sent beyond the ping message itself. Imports nothing.

/** how long a ping stays readable for an agent (the marker still fades after 4 s) */
export const PING_LOG_TTL = 120000;
/** pings kept per person */
export const PING_LOG_PER_PEER = 5;
/** a person's pings closer together than this are dropped (send and receive): a held key or a double click */
export const PING_MIN_GAP = 250;

const finite3 = (/** @type {any} */ v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
const str = (/** @type {any} */ v, /** @type {number} */ max) => v === undefined || (typeof v === 'string' && v.length <= max);
const UUID = /^[0-9a-fA-F-]{8,64}$/;

/**
 * The wire row (wireValidate): the 87 fields plus the optional `on`.
 * @param {any} d @returns {boolean}
 */
export function isPingMessage(d) {
	if (typeof d.id !== 'string' || !d.id || d.id.length > 64 || !finite3(d.pos)) return false;
	if (!str(d.name, 200) || !str(d.color, 64) || !str(d.sound, 64) || !str(d.peerId, 128)) return false;
	if (d.uuid !== undefined && !(typeof d.uuid === 'string' && UUID.test(d.uuid))) return false;
	if (d.on === undefined) return true;
	const on = d.on;
	return !!on && typeof on === 'object' && typeof on.uuid === 'string' && UUID.test(on.uuid) && finite3(on.local) && (on.normal === undefined || finite3(on.normal));
}

/**
 * @typedef {{id: string, peer: string, name: string, time: number, pos: number[], on?: {uuid: string, local: number[], normal?: number[]}}} PingRecord
 */

/**
 * Add one ping to the log: drops expired rows, a ping arriving too soon after that person's last (throttle),
 * and keeps the newest PING_LOG_PER_PEER per person.
 * @param {PingRecord[]} log @param {PingRecord} rec @param {number} now
 * @returns {{log: PingRecord[], added: boolean}}
 */
export function logPing(log, rec, now) {
	const live = pruneLog(log, now);
	const last = live.filter((p) => p.peer === rec.peer).reduce((t, p) => Math.max(t, p.time), -Infinity);
	if (rec.time - last < PING_MIN_GAP) return { log: live, added: false };
	const next = [...live, rec];
	const mine = next.filter((p) => p.peer === rec.peer);
	const drop = new Set(mine.slice(0, Math.max(0, mine.length - PING_LOG_PER_PEER)));
	return { log: next.filter((p) => !drop.has(p)), added: true };
}

/** @param {PingRecord[]} log @param {number} now */
export const pruneLog = (log, now) => log.filter((p) => now - p.time < PING_LOG_TTL);

/**
 * Which ping `at: {ping}` means. A ping id; or 'latest' = the newest by `me` (the person this tab acts as),
 * else the newest by anybody else (an agent page has no pings of its own).
 * @param {PingRecord[]} log @param {string} ref @param {string | null} me @param {(id: string) => boolean} [isAgent]
 * @returns {PingRecord | null}
 */
export function findPing(log, ref, me, isAgent = () => false) {
	if (typeof ref !== 'string' || !ref) return null;
	if (ref !== 'latest') return log.find((p) => p.id === ref) ?? null;
	const newest = (/** @type {PingRecord[]} */ rows) => rows.reduce((/** @type {PingRecord | null} */ b, p) => (!b || p.time > b.time ? p : b), null);
	return newest(log.filter((p) => p.peer === me)) ?? newest(log.filter((p) => !isAgent(p.peer)));
}
