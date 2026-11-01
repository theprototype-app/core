// 15+16 (mcp-fix) — `elapsed` for a Script node: seconds since Play began, small enough to read. `time` stays what it was, seconds
// of the day on the session clock, so old scenes and peers in step keep working. Imports nothing (unit-tested).

/**
 * A game round has a shared Start stamp, so its `elapsed` is the same for every peer and stops while paused. A plain Play press
 * has no shared stamp: it counts from this peer's own press, and in the editor from when this tab last left Play or first ran.
 * @param {{round: number | null, playing: boolean, now: number}} facts `round` = seconds of the running round (null = none),
 *   `now` = a monotonic local clock in seconds
 * @param {{playing?: boolean, since?: number}} anchor kept by the caller between frames
 * @returns {number} seconds, never negative
 */
export function elapsedNow(facts, anchor) {
	if (anchor.since === undefined || anchor.playing !== facts.playing) {
		anchor.since = facts.now;
		anchor.playing = facts.playing;
	}
	return facts.round !== null ? Math.max(0, facts.round) : Math.max(0, facts.now - anchor.since);
}
