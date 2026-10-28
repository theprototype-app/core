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
//
// 55 (41's gem test): AN AI AGENT'S PAGE IS NEVER THE AUTHORITY while a person is present — the
// rule "an agent page is nobody's host" applied to the kit. Agent ids (`agents`, self-declared on
// the roster, which every peer holds) are dropped from all three tiers; a session of agents only
// still has an authority (the smallest of them), so a page alone with another agent never stalls.

/**
 * @param {{me?: string | null, peers?: (string | null | undefined)[], host?: string | null,
 *   initiator?: string | null, agents?: (string | null | undefined)[]}} facts
 *   `me` this peer's id · `peers` the ids it is connected to · `host` the session host as this
 *   peer knows it · `initiator` the peer stepping the physics (this peer's id when it is)
 *   · `agents` the AI agents' ids among them (this peer's own too when it is one)
 * @returns {string | null} the authority's id (null only when nobody has an id: then `me` decides)
 */
export function pickAuthority(facts) {
	const me = facts?.me ? String(facts.me) : null;
	const present = new Set((facts?.peers ?? []).filter(Boolean).map(String));
	if (me) present.add(me);
	const agents = new Set((facts?.agents ?? []).filter(Boolean).map(String));
	const people = [...present].filter((id) => !agents.has(id));
	const eligible = new Set(people.length ? people : present);
	const host = facts?.host ? String(facts.host) : null;
	if (host && eligible.has(host)) return host;
	const initiator = facts?.initiator ? String(facts.initiator) : null;
	if (initiator && eligible.has(initiator)) return initiator;
	const ids = [...eligible].sort();
	return ids[0] ?? null;
}

/** Is `facts.me` the authority? A peer with no id is (it is alone). @param {Parameters<typeof pickAuthority>[0]} facts */
export function isAuthorityFor(facts) {
	if (!facts?.me) return true;
	return pickAuthority(facts) === String(facts.me);
}
