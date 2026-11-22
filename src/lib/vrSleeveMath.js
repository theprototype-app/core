// Roadmap 82 P1-P4 — the VR sleeve's take / grow / latch / cancel maths, pure and allocation-free
// (plain numbers in, numbers out) so the unit suite drives it without three.js or a headset, and the
// per-frame path in vrSleeve.js allocates nothing on a Quest.
//
// THE GESTURE: a taken ghost rides the taking hand. Its size follows how far that hand is from the
// sleeve WRIST: ghost size at GROW_NEAR, true size (× the world's scale) at GROW_FAR. It is held in
// front of the hand, pushed out along the hand's ray far enough that it never covers more than
// MAX_VIEW_DEG of the view. Reaching full size LATCHES it (a detent tick); from then on it is an
// ordinary grab (the grip-move sticks reel and scale it). Bringing the hand back within CANCEL_NEAR
// of the wrist (once it has left the wrist) cancels: the preview shrinks and flies back into its slot.

/** wrist distance (m) where growth starts / where the object reaches true size */
export const GROW_NEAR = 0.06;
export const GROW_FAR = 0.4;
/** P3: back within this of the wrist cancels; the cancel arms once the hand is past CANCEL_ARM */
export const CANCEL_NEAR = 0.1;
export const CANCEL_ARM = 0.14;
/** P4: a grip (or a pinch) this close to a slot is a direct take */
export const CONTACT_RANGE = 0.04;
/** P1: the held object never covers more than this much of the view (full angular diameter) */
export const MAX_VIEW_DEG = 50;
/** the shown growth chases the wanted growth at this rate (per second): a distance take still grows */
export const GROW_RATE = 4;
/** P3: the fly-back into the slot takes this long (0 under reduced motion) */
export const FLY_BACK_MS = 220;
/** the object's near surface stays this far in front of the hand */
const HAND_GAP = 0.04;

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Wanted growth 0..1 for the taking hand `wristDistance` metres from the sleeve wrist.
 * @param {number} wristDistance
 */
export function growthTarget(wristDistance) {
	return clamp((wristDistance - GROW_NEAR) / (GROW_FAR - GROW_NEAR), 0, 1);
}

/**
 * One frame of the shown growth chasing the wanted one at GROW_RATE per second (both ways).
 * @param {number} shown @param {number} target @param {number} dt seconds
 */
export function stepGrowth(shown, target, dt) {
	const step = GROW_RATE * clamp(dt, 0, 0.1);
	return target > shown ? Math.min(target, shown + step) : Math.max(target, shown - step);
}

/**
 * The uniform world factor for growth `t`: the ghost's factor at 0, the full one at 1, interpolated in
 * LOG space (a 3 cm ghost and a 2 m box differ 60×: a linear lerp would be half-size a few cm out).
 * @param {number} t @param {number} ghostFactor @param {number} fullFactor
 */
export function growthFactor(t, ghostFactor, fullFactor) {
	const g = Math.max(ghostFactor, 1e-6);
	const f = Math.max(fullFactor, 1e-6);
	return g * Math.pow(f / g, clamp(t, 0, 1));
}

/**
 * The full angular diameter (degrees) a sphere of `radius` at `distance` covers.
 * @param {number} radius @param {number} distance
 */
export function viewAngleDeg(radius, distance) {
	if (distance <= radius) return 180;
	return (2 * Math.asin(radius / distance) * 180) / Math.PI;
}

/**
 * P1: how far along the hand's ray (unit dir) the object's centre sits. At least `baseOffset` (the reel
 * length, or just in front of the hand), and far enough from the HEAD that a sphere of `radius` around
 * the centre covers at most `maxDeg` of the view. Solves |hand + dir·o − head| = radius / sin(maxDeg/2)
 * for the far root. Plain numbers so it allocates nothing.
 * @param {number} hx @param {number} hy @param {number} hz hand position
 * @param {number} dx @param {number} dy @param {number} dz hand ray (unit)
 * @param {number} ex @param {number} ey @param {number} ez head (eye) position
 * @param {number} radius object bounding radius about its origin (world metres)
 * @param {number} baseOffset @param {number} [maxDeg]
 */
export function clampedOffset(hx, hy, hz, dx, dy, dz, ex, ey, ez, radius, baseOffset, maxDeg = MAX_VIEW_DEG) {
	const minFromHand = radius + HAND_GAP;
	const want = Math.max(baseOffset, minFromHand);
	const R = radius / Math.sin(((maxDeg / 2) * Math.PI) / 180);
	const vx = hx - ex, vy = hy - ey, vz = hz - ez;
	const b = vx * dx + vy * dy + vz * dz; // v·dir
	const c = vx * vx + vy * vy + vz * vz - R * R;
	const disc = b * b - c;
	if (disc < 0) return want; // the ray never comes within R of the head
	const far = -b + Math.sqrt(disc);
	return Math.max(want, far);
}

/**
 * P3: the cancel state machine for one frame. `armed` turns on once the hand has left the wrist (past
 * CANCEL_ARM) — a direct take starts AT the wrist — and a hand back within CANCEL_NEAR then cancels.
 * @param {number} wristDistance @param {boolean} armed
 * @returns {0 | 1 | 2} 0 = nothing, 1 = arm now, 2 = cancel
 */
export function cancelStep(wristDistance, armed) {
	if (!armed) return wristDistance > CANCEL_ARM ? 1 : 0;
	return wristDistance < CANCEL_NEAR ? 2 : 0;
}

/**
 * P3: the fly-back's progress 0..1 at `elapsedMs` (eased out), 1 at once with no duration.
 * @param {number} elapsedMs @param {number} durationMs
 */
export function flyBackProgress(elapsedMs, durationMs) {
	if (!(durationMs > 0)) return 1;
	const t = clamp(elapsedMs / durationMs, 0, 1);
	return 1 - (1 - t) * (1 - t);
}

/**
 * P2/placement: the objectsGroup-LOCAL scale multiplier that keeps the preview's WORLD size when it lands
 * (the preview lives at the scene root; the objects live under the world rig, shrunk in miniature mode).
 * @param {number} worldFactor the preview's uniform factor over the object's own scale @param {number} groupWorldScale
 */
export function placementScale(worldFactor, groupWorldScale) {
	return worldFactor / Math.max(groupWorldScale, 1e-6);
}

/**
 * Bounding radius about the ORIGIN of a box (conservative for an off-centre shape: the farthest corner).
 * @param {number} minX @param {number} minY @param {number} minZ @param {number} maxX @param {number} maxY @param {number} maxZ
 */
export function originRadius(minX, minY, minZ, maxX, maxY, maxZ) {
	const x = Math.max(Math.abs(minX), Math.abs(maxX));
	const y = Math.max(Math.abs(minY), Math.abs(maxY));
	const z = Math.max(Math.abs(minZ), Math.abs(maxZ));
	return Math.sqrt(x * x + y * y + z * z);
}
