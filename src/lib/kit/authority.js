// 34 R2 (T3) — WHO DECIDES a kit change: ONE authority peer (proposal §4.4, fork F2).
//
// A pure LEAF (imports nothing), so every peer — and every fake peer in the logic sim
// (tests/unit/sim) — answers the question from the same facts with the same function. Two
// peers must never both believe they are the authority for long, and when the authority
// leaves, the next one must be obvious to everybody without a message:
//
//   1. the SESSION HOST (the peer the room was joined through), while it is still here
//   2. else the PHYSICS INITIATOR (the stepping peer — the one that knows speeds and holds;
//      the spawner's "the INITIATOR spawns and everybody else receives" rule)
//   3. else the SMALLEST peer id among me and the peers I see (the roles module's fallback,
//      and 31-towers' "else the lowest peer id")
//
// A peer with no id yet (offline, before the signalling server answered) is alone, so it
// is its own authority — a single-player game never waits for a network.

/**
 * @param {{me?: string | null, peers?: (string | null | undefined)[], host?: string | null,
 *   initiator?: string | null}} facts
 *   `me` this peer's id · `peers` the ids it is connected to · `host` the session host as this
 *   peer knows it · `initiator` the peer stepping the physics (this peer's id when it is)
 * @returns {string | null} the authority's id (null only when nobody has an id: then `me` decides)
 */
export function pickAuthority(facts) {
	const me = facts?.me ? String(facts.me) : null;
	const present = new Set((facts?.peers ?? []).filter(Boolean).map(String));
	if (me) present.add(me);
	const host = facts?.host ? String(facts.host) : null;
	if (host && present.has(host)) return host;
	const initiator = facts?.initiator ? String(facts.initiator) : null;
	if (initiator && present.has(initiator)) return initiator;
	const ids = [...present].sort();
	return ids[0] ?? null;
}

/** Is `facts.me` the authority? A peer with no id is (it is alone). @param {Parameters<typeof pickAuthority>[0]} facts */
export function isAuthorityFor(facts) {
	if (!facts?.me) return true;
	return pickAuthority(facts) === String(facts.me);
}
