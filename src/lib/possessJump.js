// 54i k: THE POSSESS HOP — a LEAF (imports nothing), so the arithmetic is testable without a scene.
//
// Possess drives any object with tank controls and had no way off the ground. A jump here is a
// KINEMATIC hop, the same kind of motion as the drive (possess owns the transform for the ride; a
// possessed dynamic body already follows the move stream on the external-hold path): an upward
// speed that reaches `height` metres, the scene's gravity pulling it back, and the landing on the
// height it left from — possess knows no ground, so the take-off height IS the ground. One hop at a
// time: a press in the air does nothing (no double jump), and the press is an EDGE (a held key's
// browser repeat or a held A button is still one jump).

/** what makes the possessed object jump: the keyboard's Space, a gamepad's A (the game codes
 * inputRuntime publishes, after any remap) */
export const POSSESS_JUMP_CODES = ['Space', 'GamepadA'];

/** the default hop height, metres */
export const POSSESS_JUMP_HEIGHT = 1.2;

/** @param {any} v @param {number} d */
const finite = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * Take off from height `y`. null when the hop is switched off (height 0) or gravity is not down.
 * @param {number} y @param {number} height metres @param {number} [gravity] m/s², positive = down
 * @returns {{base: number, vy: number, g: number} | null}
 */
export function startHop(y, height, gravity = 9.81) {
	const h = Math.max(0, Math.min(20, finite(height, POSSESS_JUMP_HEIGHT)));
	const g = finite(gravity, 9.81);
	if (!(h > 0) || !(g > 0)) return null;
	return { base: finite(y, 0), vy: Math.sqrt(2 * g * h), g };
}

/**
 * One frame of a hop: the new height, and the hop (null once it has landed — `y` is then exactly
 * the take-off height).
 * @param {{base: number, vy: number, g: number}} hop @param {number} y @param {number} dt seconds
 * @returns {{y: number, hop: {base: number, vy: number, g: number} | null, landed: boolean}}
 */
export function stepHop(hop, y, dt) {
	const t = Math.max(0, Math.min(0.1, finite(dt, 0)));
	const vy = hop.vy - hop.g * t;
	const next = y + (hop.vy + vy) * 0.5 * t;
	if (vy < 0 && next <= hop.base) return { y: hop.base, hop: null, landed: true };
	return { y: next, hop: { ...hop, vy }, landed: false };
}
