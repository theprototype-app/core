// 29-F: WHO KEEPS THE WORLD when two peers start simulating at once.
//
// THE BUG THIS EXISTS FOR, measured on a real two-peer Football match (24-B's handover):
// `playMode.maybeSimOnPlay` guards on `simulating || remoteSimulating`, and both are
// still false on BOTH peers for as long as it takes the other side's `simulate` message
// to arrive — a window that spans `warmup()` plus the whole of `startSimulation`, so two
// Play presses a second apart can still both pass it. Both peers then step a world and
// broadcast `move` at 30 Hz, each one's stream reads as an EXTERNAL write on the other,
// and every dynamic body sits under a `hold: 'external'` that is refreshed before its
// 250 ms timeout can ever expire. Measured: 74 moves in ~2 s, the ball snapping back
// under a permanent hold, `applyThrow` eaten, and NO GOAL COULD SCORE. A late joiner
// that is already simulating meets the same shape through the handshake push.
//
// THE RULE: **the lower peer id keeps the world.** It needs no negotiation and no new
// message, because the only two facts it reads — my id and the id in the message we just
// received — are already on both sides, so both peers reach the same verdict from the
// same data with no round trip. PeerJS ids are non-empty strings, stable for the life of
// a connection and compared with `<`, which is a TOTAL order: exactly one of two distinct
// ids is lower, so the rule can never elect two winners or none. (Our own id is the one
// the signalling server handed us, not something a message can claim — a peer cannot lie
// its way into keeping the world without also being the peer that owns that id.)
//
// ADDITIVE, absent = old behaviour: a message with no `peerId` (an older build) cannot be
// compared, so it takes the pre-29-F path verbatim — `adopt` — and a session with no race
// in it never reaches any verdict but `adopt` and `clear`.
//
// A LEAF that imports NOTHING, so the truth table is a vitest unit and the decision can
// be read without a browser, a peer or rapier (the `sessionClock`/`netBackoff` shape).

/**
 * The verdict for one incoming `simulate` message.
 *
 * - `adopt`  — record them as the simulator (the old behaviour, and the normal one)
 * - `keep`   — we are simulating and we won: stay authoritative, ignore their claim
 * - `yield`  — we are simulating and we lost: stop, then adopt them
 * - `clear`  — their run ended and it was the one we were watching
 * - `ignore` — the message says nothing about the peer we believe is stepping the world
 *
 * `ignore` on a STOP is what keeps a three-peer race honest: the loser of a race
 * broadcasts `running: false` on its way out, and a spectator that had recorded the
 * WINNER must not blank its `remoteSimulating` because a peer it was not watching
 * stopped — that store is what arms the knock probes and play-mode grab (24-A A2), so
 * blanking it silently disarms a spectator mid-match. `ignore` on a START is the same
 * rule from the other side: a spectator told about two simulators keeps the LOWER id, so
 * every peer in the mesh — not just the two racing — agrees on who the authority is.
 *
 * @param {object} state
 * @param {boolean} state.running the message's `running` flag
 * @param {string|null|undefined} state.mine our own peer id (null when we have none yet)
 * @param {string|null|undefined} state.theirs the message's `peerId` (absent on older builds)
 * @param {boolean} state.simulating whether WE are stepping a world right now
 * @param {string|null|undefined} state.remote the peer we currently believe is stepping one
 * @returns {'adopt'|'keep'|'yield'|'clear'|'ignore'}
 */
export function simulateVerdict({ running, mine, theirs, simulating, remote }) {
	const them = typeof theirs === 'string' && theirs ? theirs : null;
	const me = typeof mine === 'string' && mine ? mine : null;
	const watching = typeof remote === 'string' && remote ? remote : null;

	if (!running) {
		// no id to match against: the pre-29-F behaviour, which is to take any stop
		if (!them) return 'clear';
		return watching === them ? 'clear' : 'ignore';
	}
	// our own message coming back at us is not evidence about anybody else
	if (them && me && them === me) return 'ignore';
	if (simulating) {
		// nothing to compare (an older sender, or no id of our own yet): old behaviour
		if (!them || !me) return 'adopt';
		return them < me ? 'yield' : 'keep';
	}
	// not simulating. A start from a peer with a HIGHER id than the one we already
	// believe is stepping the world is the losing half of a race we are watching from
	// outside; the same comparison both racers make tells us to keep the lower one.
	if (them && watching && watching !== them && watching < them) return 'ignore';
	return 'adopt';
}
