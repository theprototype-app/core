// 36-avatars (plan 76.3, decision "3-point estimate"): where a peer's BODY stands and faces, from the
// three points the wire already carries — the head (the `camera` stream) and the two hands (`vrhands`).
// A LEAF of plain numbers (no three, no stores): every peer runs it on the same samples, so every peer
// draws the same body with no message of its own (76.4: camera + vrhands only).
//
// Angles are three's yaw convention: 0 faces -Z, positive turns left (counter-clockwise from above).

const TAU = Math.PI * 2;

/** wrap an angle into [-PI, PI) @param {number} a */
export function wrapAngle(a) {
	let r = (a + Math.PI) % TAU;
	if (r < 0) r += TAU;
	return r - Math.PI;
}

/** the signed shortest turn from `from` to `to` @param {number} from @param {number} to */
export function angleDelta(from, to) {
	return wrapAngle(to - from);
}

/**
 * Yaw + pitch of a forward vector (three: a camera looks down its local -Z).
 * @param {number[]} fwd [x, y, z], need not be unit
 */
export function yawPitchOf(fwd) {
	const [x, y, z] = fwd;
	const flat = Math.hypot(x, z);
	return { yaw: Math.atan2(-x, -z), pitch: Math.atan2(y, flat || 1e-9) };
}

/** the forward vector (-Z) of a quaternion [x, y, z, w] @param {number[]} q */
export function forwardOfQuat(q) {
	const [x, y, z, w] = q;
	// rotate (0, 0, -1) by q
	return [-(2 * (x * z + w * y)), -(2 * (y * z - w * x)), -(1 - 2 * (x * x + y * y))];
}

/**
 * The yaw the HANDS suggest: facing the midpoint of the two hands from the head, when both are in
 * front of the body and spread out enough to mean something. Null otherwise.
 * @param {number[]} head @param {number[] | null | undefined} left @param {number[] | null | undefined} right
 */
export function handsYaw(head, left, right) {
	if (!left || !right) return null;
	const mx = (left[0] + right[0]) / 2 - head[0];
	const mz = (left[2] + right[2]) / 2 - head[2];
	if (Math.hypot(mx, mz) < 0.12) return null; // hands at the chest: no direction
	return Math.atan2(-mx, -mz);
}

/**
 * The body's next yaw. A real body does not turn with every glance: it holds still while the head
 * looks around inside a comfort cone and catches up once the head leaves it, or straight away while
 * walking (you walk where you look). Hands, when both are tracked in front, pull the body toward them
 * (you face what you hold).
 * @param {{bodyYaw: number, headYaw: number, handsYaw?: number | null, speed: number, dt: number,
 *   cone?: number, rate?: number}} s
 */
export function nextBodyYaw({ bodyYaw, headYaw, handsYaw = null, speed, dt, cone = 0.6, rate = 4 }) {
	let target = headYaw;
	if (handsYaw !== null && handsYaw !== undefined) target = headYaw + angleDelta(headYaw, handsYaw) * 0.4;
	const off = angleDelta(bodyYaw, target);
	const moving = speed > 0.3;
	// inside the cone and standing: keep the body still
	if (!moving && Math.abs(off) < cone) return wrapAngle(bodyYaw);
	// standing past the cone: turn only far enough to bring the head back inside it, smoothly
	const want = moving ? off : off - Math.sign(off) * cone * 0.8;
	const k = 1 - Math.exp(-(moving ? rate * 2 : rate) * Math.max(0, dt));
	return wrapAngle(bodyYaw + want * k);
}

/**
 * The neck: the head's turn relative to the body, clamped to what a neck can do.
 * @param {number} headYaw @param {number} headPitch @param {number} bodyYaw
 */
export function neckAngles(headYaw, headPitch, bodyYaw) {
	const clamp = (/** @type {number} */ v, /** @type {number} */ m) => Math.max(-m, Math.min(m, v));
	return { yaw: clamp(angleDelta(bodyYaw, headYaw), 1.2), pitch: clamp(headPitch, 0.9) };
}

/**
 * How much to trust a hand for the arm IK, 0..1. A pose older than the stream's cadence fades out
 * (the peer left VR, or the stream stalled), and a hand farther from the shoulder than the stretched
 * arm can reach is a controller held at arm's length the body cannot follow — the floating hand shows
 * it better than a dislocated arm.
 * @param {{ageMs: number, distance: number, reach: number}} s
 */
export function armConfidence({ ageMs, distance, reach }) {
	const fresh = ageMs <= 400 ? 1 : ageMs >= 1200 ? 0 : 1 - (ageMs - 400) / 800;
	const r = distance / Math.max(reach, 1e-6);
	const near = r <= 1.25 ? 1 : r >= 1.7 ? 0 : 1 - (r - 1.25) / 0.45;
	return Math.max(0, Math.min(1, fresh * near));
}
