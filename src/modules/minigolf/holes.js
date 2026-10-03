// 35-mini-golf: the course table (a pure leaf — no THREE, no stores).
//
// Six holes laid side by side, each its own lane running from the tee (+z) to the cup (-z).
// The template def builds the geometry FROM this table (scripts/templates/mini-golf.cjs keeps
// a copy of the numbers; the module finds the objects BY NAME), so the module only needs the
// points that matter to the rules: where the ball starts, where the cup is, where the lane's
// bounds are, where the sand is, and the par.

/** lane x centres */
export const LANE_X = [-12.5, -7.5, -2.5, 2.5, 7.5, 12.5];
/** every lane is this wide (inside the rails) and runs z from TEE_Z to the back rail */
export const LANE_W = 3;
export const TEE_Z = 5;
export const BACK_Z = -6.5;
/** the green's top (the ball rests at GREEN_TOP + BALL_R) */
export const GREEN_TOP = 0.1;
export const BALL_R = 0.06;
/** the cup's capture radius (centre to ball centre) and the speed it still catches */
export const CUP_R = 0.13;
export const CUP_SPEED = 2.2;
/** at most this many strokes a hole; then the ball is picked up */
export const MAX_STROKES = 8;

/**
 * @typedef {{id: number, name: string, par: number, x: number, cup: number[], tip: string,
 *   sand?: {min: number[], max: number[]}}} Hole
 */
/** @type {Hole[]} */
export const HOLES = [
	{ id: 1, name: 'Straight', par: 2, x: LANE_X[0], cup: [LANE_X[0], GREEN_TOP, -4.5], tip: 'A straight warm-up. Drag back from the ball and let go.' },
	{ id: 2, name: 'The ramp', par: 3, x: LANE_X[1], cup: [LANE_X[1], 0.6, -5], tip: 'Up the ramp to the high green — hit it firmly.' },
	{ id: 3, name: 'Windmill', par: 3, x: LANE_X[2], cup: [LANE_X[2], GREEN_TOP, -5], tip: 'Time your putt between the windmill blades.' },
	{ id: 4, name: 'Bank shot', par: 3, x: LANE_X[3], cup: [LANE_X[3] + 0.8, GREEN_TOP, -5], tip: 'A wall blocks the middle — bank it off the rail.' },
	{ id: 5, name: 'Sand trap', par: 3, x: LANE_X[4], cup: [LANE_X[4], GREEN_TOP, -5], tip: 'Sand eats speed. Go around it, or hit hard.', sand: { min: [LANE_X[4] - 1.5, -2.6], max: [LANE_X[4] + 0.6, -1.2] } },
	{ id: 6, name: 'The hump', par: 4, x: LANE_X[5], cup: [LANE_X[5], GREEN_TOP, -5.2], tip: 'Over the hump and around the posts.' }
];

/** @param {number} id @returns {Hole | null} */
export const holeById = (id) => HOLES.find((h) => h.id === id) ?? null;
/** the tee spot (ball centre) @param {Hole} hole */
export const teeOf = (hole) => [hole.x, GREEN_TOP + BALL_R + 0.02, TEE_Z - 0.6];
/** the player's spawn behind the tee (feet) */
export const spawnOf = (/** @type {Hole} */ hole) => [hole.x, 0, TEE_Z + 1.4];
export const PAR_TOTAL = HOLES.reduce((s, h) => s + h.par, 0);

/** is a ball position out of this hole's lane (fell off, or jumped the rails)
 * @param {Hole} hole @param {number[]} p */
export function outOfBounds(hole, p) {
	if (p[1] < -0.4) return true;
	if (Math.abs(p[0] - hole.x) > LANE_W / 2 + 0.4) return true;
	if (p[2] > TEE_Z + 0.6 || p[2] < BACK_Z - 0.4) return true;
	return false;
}
/** @param {Hole} hole @param {number[]} p */
export function inSand(hole, p) {
	const s = hole.sand;
	return !!s && p[0] >= s.min[0] && p[0] <= s.max[0] && p[2] >= s.min[1] && p[2] <= s.max[1];
}
/** is the ball in the cup @param {Hole} hole @param {number[]} p @param {number} speed */
export function inCup(hole, p, speed) {
	const dx = p[0] - hole.cup[0];
	const dz = p[2] - hole.cup[2];
	return Math.hypot(dx, dz) < CUP_R && Math.abs(p[1] - (hole.cup[1] + BALL_R)) < 0.2 && speed < CUP_SPEED;
}
/** a score's name relative to par @param {number} strokes @param {number} par */
export function scoreName(strokes, par) {
	if (strokes === 1) return 'Hole in one!';
	const d = strokes - par;
	return d <= -2 ? 'Eagle!' : d === -1 ? 'Birdie!' : d === 0 ? 'Par' : d === 1 ? 'Bogey' : d === 2 ? 'Double bogey' : '+' + d;
}
/** "+2", "E", "-1" @param {number} d */
export const relText = (d) => (d === 0 ? 'E' : d > 0 ? '+' + d : String(d));
/** putt speed from a drag length (m) — 0..MAX over 0..2.5 m */
export const PUTT_MAX = 7;
/** @param {number} dragLen */
export const puttSpeed = (dragLen) => Math.min(PUTT_MAX, Math.max(0, dragLen) * (PUTT_MAX / 2.5));
