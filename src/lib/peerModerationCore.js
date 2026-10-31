// Roadmap 55 A9 — REMOVE A PEER FROM A MESH, the pure half (imports nothing).
//
// A session is a MESH: every peer holds its own connection to every other, so "the host
// closes the connection" removes nobody — the kicked client is still wired to everybody
// else. The remover therefore BROADCASTS `{type:'kick', peer, block}` and EVERY receiver
// closes its own connection to that peer and drops it from its whitelist. A client that
// ignores the message stays connected to nobody, because the closing is done by the others.
//
// WHO MAY. A receiver acts only when the SENDER is entitled, decided receive-side and never
// from anything the sender says about itself:
//   · a cloud build (a roles plugin publishes `rolesInfo`): the sender is an ADMIN, or the
//     session host (the host is the roles authority, so this is the same peer in practice);
//   · the OSS build (no roles): the sender is the SESSION HOST — the peer that approved us.
// The cloud plugin's capability gate drops a non-admin `kick` before it reaches the
// dispatcher too (cloud roles.js ADMIN_ONLY), so on a cloud build the rule holds twice.
//
// BLOCK is a per-session list. A blocked peer's re-dial is refused with the `removed` join
// result ("You were removed from this session") by whichever peer it reaches — every
// receiver keeps the list, not only the host, because a mesh re-dial can land anywhere.
// *Allow back* is the same message with `allow: true`.

/** How long a plain removal keeps a peer out of the roster/mesh-fill paths, so a stale
 * `userdata` or `hosts` message still in flight from another peer cannot write them back.
 * Short on purpose: a removed (not blocked) person may ask to join again. */
export const REMOVED_HOLD_MS = 30_000;

/**
 * May `sender` remove peers, as seen by THIS receiver?
 * @param {string} sender the peer the message came from (the conn's id, never a field)
 * @param {{host: string | null, roleOf?: ((id: string) => string) | null, capsOf?: ((id: string) => any) | null}} ctx
 *   `host` = our sessionHost (null = we host); `roleOf` = rolesInfo.roleOf on a cloud build
 * @returns {boolean}
 */
export function kickAllowedFrom(sender, ctx) {
	if (!sender) return false;
	if (ctx.host && sender === ctx.host) return true;
	if (typeof ctx.roleOf === 'function') {
		try {
			// 71 TR1: or the capability an admin gave them
			return ctx.roleOf(sender) === 'admin' || ctx.capsOf?.(sender)?.moderate === true;
		} catch {
			return false;
		}
	}
	return false;
}

/**
 * May WE remove peers (what the menu offers)? Cloud: an admin. OSS: the session host,
 * which from our own side is "nobody approved us and somebody is here".
 * @param {{host: string | null, amAdmin?: boolean | null, hasRoles: boolean, connected: boolean}} ctx
 */
export function canModerateWith(ctx) {
	if (ctx.hasRoles) return !!ctx.amAdmin;
	return !ctx.host && ctx.connected;
}

/** @param {any} d */
export function isKickMessage(d) {
	return (
		!!d &&
		typeof d === 'object' &&
		typeof d.peer === 'string' &&
		d.peer.length > 0 &&
		d.peer.length <= 64 &&
		(d.block === undefined || typeof d.block === 'boolean') &&
		(d.allow === undefined || typeof d.allow === 'boolean')
	);
}

/**
 * What a receiver does with a kick: 'ignore' (sender not entitled, or malformed),
 * 'self' (we are the one removed), 'allow' (lift a block), 'remove' (drop that peer).
 * @param {any} msg @param {string} sender @param {string} me
 * @param {{host: string | null, roleOf?: ((id: string) => string) | null}} ctx
 * @returns {'ignore' | 'self' | 'allow' | 'remove'}
 */
export function kickDecision(msg, sender, me, ctx) {
	if (!isKickMessage(msg)) return 'ignore';
	if (!kickAllowedFrom(sender, ctx)) return 'ignore';
	if (msg.allow) return 'allow';
	if (msg.peer === sender) return 'ignore'; // nobody removes themselves by message
	if (msg.peer === me) return 'self';
	return 'remove';
}

/**
 * The session's moderation memory: who is BLOCKED (until allowed back) and who was just
 * REMOVED (held out of the roster/mesh-fill for REMOVED_HOLD_MS).
 * @param {() => number} [now]
 */
export function createModerationState(now = () => Date.now()) {
	/** @type {Map<string, {peerId: string, name: string, at: number, by: string}>} */
	const blocked = new Map();
	/** @type {Map<string, number>} peerId -> held until */
	const removed = new Map();
	return {
		/** @param {string} peerId @param {{block?: boolean, name?: string, by?: string}} [o] */
		remove(peerId, o = {}) {
			removed.set(peerId, now() + REMOVED_HOLD_MS);
			if (o.block) blocked.set(peerId, { peerId, name: o.name || blocked.get(peerId)?.name || '', at: now(), by: o.by || '' });
		},
		/** @param {string} peerId @returns {boolean} whether there was a block to lift */
		allow(peerId) {
			removed.delete(peerId);
			return blocked.delete(peerId);
		},
		/** an approval says "let them in" — forget the short removal hold (a block stays) @param {string} peerId */
		forget(peerId) {
			removed.delete(peerId);
		},
		/** @param {string} peerId */
		isBlocked(peerId) {
			return blocked.has(peerId);
		},
		/** blocked, or removed moments ago @param {string} peerId */
		isHeldOut(peerId) {
			if (blocked.has(peerId)) return true;
			const until = removed.get(peerId);
			if (until === undefined) return false;
			if (until > now()) return true;
			removed.delete(peerId);
			return false;
		},
		list() {
			return [...blocked.values()].sort((a, b) => a.at - b.at);
		},
		reset() {
			blocked.clear();
			removed.clear();
		}
	};
}
