// 85 N3 — AMBIENT ANIMALS, the pure half (imports nothing). An animal wanders (Wander's noise path)
// but RESTS between walks, faces where it goes, looks at the nearest player while it rests and,
// optionally, shies away from a player who comes close.
//
// The rest schedule is a TIME WARP of the shared clock: `walkTime(t)` advances only while the
// animal walks, so the wander path pauses and resumes exactly where it stopped — and stays a pure
// function of the clock (two peers, same animal, same place). The flee is a displacement FIELD
// over the players' current positions (already replicated avatars), never integrated state.

/** @param {any} v @param {number} fallback @param {number} lo @param {number} hi */
export function clampNum(v, fallback, lo, hi) {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return n < lo ? lo : n > hi ? hi : n;
}

export const AMBIENT_DEFAULTS = Object.freeze({
	speed: 0.3,
	seed: 0,
	rx: 3,
	ry: 0.3,
	rz: 3,
	margin: 0.2,
	ground: true,
	rest: 0.35,
	restTime: 3,
	lookRadius: 4,
	fleeRadius: 0,
	fleeDistance: 2,
	turnSpeed: 4,
	forward: '+z',
	clips: true
});

/**
 * The warped clock: how far along its wander path the animal is at shared time `t`, and whether it
 * is walking. A cycle of `restTime / rest` seconds walks first and rests last; `seed01` shifts the
 * cycle so a herd does not stop in step. `rest` 0 = never rests (plain Wander time).
 * @param {number} t @param {any} data @param {number} seed01
 * @returns {{tau: number, walking: boolean, restLeft: number}}
 */
export function walkTime(t, data, seed01) {
	const rest = clampNum(data?.rest, AMBIENT_DEFAULTS.rest, 0, 0.9);
	if (rest <= 0.001) return { tau: t, walking: true, restLeft: 0 };
	const restTime = clampNum(data?.restTime, AMBIENT_DEFAULTS.restTime, 0.2, 600);
	const cycle = restTime / rest;
	const walk = cycle - restTime;
	const s = t + seed01 * cycle;
	const k = Math.floor(s / cycle);
	const r = s - k * cycle;
	const walking = r < walk;
	// tau keeps the session clock's scale (k * walk + the part walked) so a long session does not
	// collapse the noise path into a few cycles
	return { tau: k * walk + Math.min(r, walk), walking, restLeft: walking ? 0 : cycle - r };
}

/**
 * The nearest player to `p` (world), or null. @param {number[]} p @param {number[][]} players
 * @returns {{at: number[], d: number} | null}
 */
export function nearest(p, players) {
	let best = null;
	let bd = Infinity;
	for (const q of players) {
		if (!Array.isArray(q) || q.length !== 3) continue;
		const d = Math.hypot(q[0] - p[0], q[2] - p[2]);
		if (d < bd) {
			bd = d;
			best = q;
		}
	}
	return best ? { at: best, d: bd } : null;
}

/**
 * How far the animal shies away from a player at horizontal distance `d` — full `distance` at
 * the player's feet, nothing at `radius`, smooth in between (a pure field, no state).
 * @param {number} d @param {number} radius @param {number} distance
 */
export function fleeAmount(d, radius, distance) {
	if (radius <= 0 || d >= radius) return 0;
	const x = 1 - d / radius;
	return distance * x * x * (3 - 2 * x);
}

/** the yaw (about +y) that points `forward` along (dx, dz) @param {number} dx @param {number} dz @param {string} forward */
export function yawToward(dx, dz, forward = '+z') {
	const yaw = Math.atan2(dx, dz);
	switch (forward) {
		case '-z':
			return yaw + Math.PI;
		case '+x':
			return yaw - Math.PI / 2;
		case '-x':
			return yaw + Math.PI / 2;
		default:
			return yaw;
	}
}

/** shortest signed angle a -> b @param {number} a @param {number} b */
export function angleTo(a, b) {
	let d = (b - a) % (2 * Math.PI);
	if (d > Math.PI) d -= 2 * Math.PI;
	if (d < -Math.PI) d += 2 * Math.PI;
	return d;
}
