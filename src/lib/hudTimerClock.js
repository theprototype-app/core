// 92-correct row 1 — where an AUTOSTART HUD Timer counts from. Imports nothing (unit-tested).
//
// Before: "from when this peer first saw the node", so a timer authored in the editor had run down
// before anyone pressed Play (the 2.0-eval2 round-timer task scored 0/10 on it). Now:
//   - a game ROUND (the shell is in use): seconds since the round's shared `startedAt`, minus the
//     shared pause spans — every peer, a late joiner included, reads the host's number, and a
//     pause stops it. In the menu it shows its full time; when the round is over it holds.
//   - plain Play (no round ever started): from this peer's own Play press, on the pause-folded
//     effect clock — the same rule as a Script node's `elapsed` (scriptElapsed.js). In the editor
//     it shows its full time.

/**
 * @typedef {{ state?: string, round?: number, startedAt?: number, pausedAt?: number, pausedMs?: number }} GameFacts
 * @typedef {{ since?: number, held?: number }} TimerAnchor kept by the caller per node
 */

/** Has the game shell ever been used? (gameState.shellInUse, restated: that one is private) @param {GameFacts} g */
export function shellInUse(g) {
	return (g?.round ?? 0) > 0 || (g?.startedAt ?? 0) > 0;
}

/** Seconds of the round, pause spans excluded. @param {GameFacts} g @param {number} nowMs */
export function roundSeconds(g, nowMs) {
	if (!g?.startedAt) return 0;
	const live = g.pausedAt ? nowMs - g.pausedAt : 0;
	return Math.max(0, (nowMs - g.startedAt - (g.pausedMs ?? 0) - live) / 1000);
}

/**
 * Seconds an autostart timer has run.
 * @param {{ game: GameFacts, nowMs: number, playing: boolean, effNow: number }} facts
 *   `nowMs` = the session clock (epoch ms), `playing` = this peer is in Play, `effNow` = the
 *   pause-folded local effect clock in seconds
 * @param {TimerAnchor} anchor
 * @returns {number}
 */
export function autostartElapsed(facts, anchor) {
	const g = facts.game ?? {};
	if (shellInUse(g)) {
		anchor.since = undefined;
		if (g.state === 'playing' || g.state === 'paused') {
			anchor.held = undefined;
			return roundSeconds(g, facts.nowMs);
		}
		if (g.state === 'over') {
			if (anchor.held === undefined) anchor.held = roundSeconds(g, facts.nowMs);
			return anchor.held;
		}
		anchor.held = undefined;
		return 0;
	}
	anchor.held = undefined;
	if (!facts.playing) {
		anchor.since = undefined;
		return 0;
	}
	if (anchor.since === undefined) anchor.since = facts.effNow;
	return Math.max(0, facts.effNow - anchor.since);
}

/**
 * Seconds a WIRED timer (its Start fired at `stamp`) has run, pause excluded. `paused` is how
 * many seconds this peer's effect clock has been held so far; `anchor` remembers that number
 * when the stamp was first seen, so only pauses AFTER the start come off.
 * @param {{ time: number, stamp: number, paused: number }} facts
 * @param {{ stamp?: number, paused?: number }} anchor
 */
export function wiredElapsed(facts, anchor) {
	if (anchor.stamp !== facts.stamp || anchor.paused === undefined) {
		anchor.stamp = facts.stamp;
		anchor.paused = facts.paused;
	}
	return facts.time - facts.stamp - Math.max(0, facts.paused - anchor.paused);
}
