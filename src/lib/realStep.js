// 92-correct row 4 — WALK SPEED IS PER SECOND. Imports nothing (unit-tested).
//
// The play speeds a scene stores (`charcontroller.speed`, `movespeed.value`, the scroll wheel's
// moveSpeed) are in units PER 60 Hz FRAME, and fly mode applied them once per frame: the same scene
// moved twice as far at 120 Hz as at 60, half as far at 30. Walk mode already scaled by `delta * 60`,
// but threlte hands every task a delta CLAMPED to 0.1 s, so below 10 fps (a throttled tab, a busy
// phone) each frame still counted 0.1 s and the player fell short.
//
// The rule now, for every built-in player movement: the stored number is unchanged (an old scene
// keeps its exact feel at 60 Hz) and each frame moves `perFrame * 60 * dt`, with dt the REAL time
// since the last frame, capped at STEP_CAP_S — a hidden tab gets no frames at all, and the frame it
// comes back on must not teleport the player across the level. Collision code sub-steps a long
// frame (charController KCC_MAX_DT), so a 0.5 s frame is eight short sweeps, not one long one.

/** the longest frame counted in full (s): a 1 fps tab still covers its ground (measured: the Deck's headless
 * page draws at 1.4-2 fps, and a 0.5 s cap lost a quarter of the distance there) */
export const STEP_CAP_S = 1;
/** the frame rate the stored per-frame speeds were authored at */
export const AUTHORED_HZ = 60;

/**
 * A real-time frame clock. `now` in ms (performance.now()); the first call answers `fallback`.
 * @param {number} [cap] @returns {(now: number, fallback?: number) => number} seconds
 */
export function makeRealClock(cap = STEP_CAP_S) {
	/** @type {number | null} */
	let last = null;
	return (now, fallback = 1 / AUTHORED_HZ) => {
		const dt = last === null ? fallback : (now - last) / 1000;
		last = now;
		return Math.min(cap, Math.max(0, Number.isFinite(dt) ? dt : 0));
	};
}

/** a per-60Hz-frame distance turned into this frame's distance @param {number} perFrame @param {number} dt seconds */
export function frameDistance(perFrame, dt) {
	return (Number(perFrame) || 0) * AUTHORED_HZ * Math.max(0, dt);
}
