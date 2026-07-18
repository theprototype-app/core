// Bounded exponential backoff for reconnecting to a peer whose DataConnection
// dropped without a graceful leave (transient ICE/network blip). Pure and
// deterministic (no Date/Math.random) so it unit-tests cleanly and every peer
// computes the same schedule. attempt is 1-indexed; returns the delay (ms)
// before that attempt, or null once attempts are exhausted (the caller then
// finalizes the disconnect). Defaults: 500 / 1000 / 2000 / 4000 ms, capped.

/**
 * @param {number} attempt 1-indexed attempt number
 * @param {{ base?: number, factor?: number, cap?: number, max?: number }} [opts]
 * @returns {number | null} delay in ms, or null when exhausted
 */
export function backoffDelay(attempt, opts = {}) {
	const { base = 500, factor = 2, cap = 8000, max = 4 } = opts;
	if (!Number.isFinite(attempt) || attempt < 1 || attempt > max) return null;
	return Math.min(cap, Math.round(base * Math.pow(factor, attempt - 1)));
}

/**
 * The full schedule as an array of delays (ms), length = max.
 * @param {{ base?: number, factor?: number, cap?: number, max?: number }} [opts]
 * @returns {number[]}
 */
export function backoffSchedule(opts = {}) {
	const { max = 4 } = opts;
	const out = [];
	for (let i = 1; i <= max; i++) {
		const d = backoffDelay(i, opts);
		if (d === null) break;
		out.push(d);
	}
	return out;
}
