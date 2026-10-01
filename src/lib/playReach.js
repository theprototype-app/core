// 31-towers P1: GRAB REACH — how far from your body a player may take hold of something.
//
// A pure LEAF (imports nothing), so the rule is unit-tested with no scene, no headset and no
// pointer lock, and both input paths (desktop Play's crosshair in playInteract, a VR grip in
// vrControls) ask the same question.
//
// THE RULE: the distance from the point you are aiming at to your BODY — the vertical segment
// from your feet to your eye — must not exceed the scene's `play.reach`. Measuring from the eye
// alone was the obvious first reading and it is wrong twice: a crate lying at your feet is 1.7 m
// from your eye, so a 1.3 m reach would refuse the thing you are standing over, and a crate on a
// ledge right above your head would read closer than one at arm's length in front of you. The
// segment answers the way a body does: anything between your feet and your eye is as far away
// as it is horizontally, and above your eye the reach bends round your head.
//
// Absent (`null`) = no limit, which is every scene before this existed.

/** metres: the smallest and largest reach a scene may ask for */
export const REACH_MIN = 0.3;
export const REACH_MAX = 20;

/**
 * The scene field's one boundary: a finite number clamped into range, or null for "no limit".
 * @param {any} value @returns {number | null}
 */
export function normalizeReach(value) {
	if (value == null || value === '' || typeof value === 'boolean') return null;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return null;
	return Math.max(REACH_MIN, Math.min(REACH_MAX, n));
}

/**
 * Distance from `point` to the body segment (feet..eye, straight up).
 * @param {{x: number, y: number, z: number}} point what the player aims at (world)
 * @param {{x: number, y: number, z: number}} eye the player's eye / head (world)
 * @param {number} feetY the height of the feet (world); clamped to at most the eye
 * @returns {number}
 */
export function bodyDistance(point, eye, feetY) {
	const top = eye.y;
	const bottom = Math.min(Number.isFinite(feetY) ? feetY : top, top);
	const y = Math.max(bottom, Math.min(top, point.y));
	const dx = point.x - eye.x;
	const dy = point.y - y;
	const dz = point.z - eye.z;
	return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Is `point` within `reach` of the body? A null reach always answers true.
 * @param {{x: number, y: number, z: number}} point
 * @param {{x: number, y: number, z: number}} eye
 * @param {number} feetY
 * @param {number | null} reach
 */
export function withinReach(point, eye, feetY, reach) {
	if (reach == null) return true;
	return bodyDistance(point, eye, feetY) <= reach + 1e-6;
}

/**
 * The farthest a carried object may be held out along a ray from the eye while staying within
 * reach: the carry distance along the aim that keeps the carried point on the reach boundary.
 * Looking straight ahead that is the reach itself; looking DOWN it is longer (the body segment
 * is under you), looking UP it is the reach again (above the eye the boundary is a sphere).
 * Returns `fallback` when there is no reach.
 * @param {{x: number, y: number, z: number}} dir the aim direction (unit)
 * @param {number} eyeHeight the eye above the feet (>= 0)
 * @param {number | null} reach
 * @param {number} fallback
 */
export function carryLimit(dir, eyeHeight, reach, fallback) {
	if (reach == null) return fallback;
	// along the ray t, the point is (t*dx, t*dy, t*dz) relative to the eye. While it is within
	// the segment's height band (-eyeHeight <= t*dy <= 0) the distance is the horizontal one;
	// otherwise the offset from the nearer end of the segment.
	const h = Math.hypot(dir.x, dir.z);
	if (dir.y >= 0) return reach; // above the eye: a sphere of `reach` round it
	// descending: horizontal distance grows as t*h while t*|dy| <= eyeHeight
	const tBand = eyeHeight / -dir.y;
	const tHorizontal = h > 1e-6 ? reach / h : Infinity;
	if (tHorizontal <= tBand) return tHorizontal;
	// below the feet: distance from the foot point (0, -eyeHeight, 0) must equal reach
	// |t*d - f|^2 = reach^2 with f = (0, -eyeHeight, 0): t^2 - 2 t (d.f) + |f|^2 - reach^2 = 0
	const df = -dir.y * eyeHeight;
	const c = eyeHeight * eyeHeight - reach * reach;
	const disc = df * df - c;
	if (disc < 0) return tBand;
	return df + Math.sqrt(disc);
}
