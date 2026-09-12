// Bounded exponential backoff for reconnecting to a peer whose DataConnection
// dropped without a graceful leave (transient ICE/network blip). Pure and
// deterministic (no Date/Math.random) so it unit-tests cleanly and every peer
// computes the same schedule. attempt is 1-indexed; returns the delay (ms)
// before that attempt, or null once attempts are exhausted (the caller then
// finalizes the disconnect). Defaults: 500 / 1000 / 2000 / 4000 ms, capped.

/**
 * 27-F: `jitter`, `rng` and an unbounded `max` are ADDITIVE and inert by default, so
 * every existing caller is byte-identical.
 * @param {number} attempt 1-indexed attempt number
 * @param {{ base?: number, factor?: number, cap?: number, max?: number, jitter?: number,
 *   rng?: () => number }} [opts]
 * @returns {number | null} delay in ms, or null when exhausted
 */
export function backoffDelay(attempt, opts = {}) {
	const { base = 500, factor = 2, cap = 8000, max = 4, jitter = 0, rng = Math.random } = opts;
	if (!Number.isFinite(attempt) || attempt < 1 || attempt > max) return null;
	const delay = Math.min(cap, Math.round(base * Math.pow(factor, attempt - 1)));
	if (!jitter) return delay;
	// 27-F: +/- a fraction of the delay, clamped at 0 (a negative wait would hammer the
	// server). The ONLY non-determinism in this module, and it takes an injectable `rng`
	// so the schedule stays unit-testable — `max: Infinity` is the signaling reconnect,
	// where giving up strands the tab with a dead invite id (audit H2).
	const spread = delay * jitter;
	return Math.max(0, Math.round(delay + (rng() * 2 - 1) * spread));
}

/**
 * The full schedule as an array of delays (ms), length = max (or `limit` when max is
 * unbounded — see the body).
 * @param {{ base?: number, factor?: number, cap?: number, max?: number, jitter?: number,
 *   rng?: () => number, limit?: number }} [opts]
 * @returns {number[]}
 */
export function backoffSchedule(opts = {}) {
	// 27-F: an UNBOUNDED `max` has no full schedule, so `limit` bounds what this returns.
	// Without it the loop below never terminates — measured as `RangeError: Invalid array
	// length` on the pre-27-F module.
	const { max = 4, limit = 10 } = opts;
	const upTo = Number.isFinite(max) ? max : limit;
	const out = [];
	for (let i = 1; i <= upTo; i++) {
		const d = backoffDelay(i, opts);
		if (d === null) break;
		out.push(d);
	}
	return out;
}
