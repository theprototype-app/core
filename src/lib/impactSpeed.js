// fix-batch-1 #14: what counts as an IMPACT, as pure functions (physics.js measures, flowRuntime
// gates). Up to 1.43 only a landing counted — the pre-step DOWNWARD velocity had to reach 1.2 m/s,
// so a ball thrown sideways at a wall or a target never fired On Impact. Now a contact counts
// when the bodies CLOSE along the contact normal fast enough, from any side; the downward test
// is kept as its own channel so On Impact nodes saved before it (no `direction`) and the
// emitters' "On impact" burst behave exactly as they did.
//
// A LEAF: no imports, plain {x, y, z} objects, so the whole rule is unit-testable.

export const IMPACT_MIN_DOWN_VY = 1.2; // m/s downward (pre-step) for a landing to count
export const IMPACT_MIN_SPEED = 1.2; // m/s closing speed along the contact normal (pre-step)

/** the On Impact `direction` a node saved before the key existed has */
export const LEGACY_IMPACT_DIRECTION = 'down';

/** @typedef {{x: number, y: number, z: number}} V3 */

/**
 * How fast two bodies approach each other along the contact normal (m/s, ≥ 0). The normal's
 * sign does not matter (rapier's points from collider 1 to 2, either side may be ours), and a
 * graze along a wall reads ~0 however fast it is. No normal (no manifold) → the vertical, the
 * old landing assumption.
 * @param {V3} va pre-step velocity of this body @param {V3 | null} vb the other's (null = static)
 * @param {V3 | null} n contact normal (any length)
 */
export function closingSpeed(va, vb, n) {
	const rx = va.x - (vb?.x ?? 0);
	const ry = va.y - (vb?.y ?? 0);
	const rz = va.z - (vb?.z ?? 0);
	const len = n ? Math.hypot(n.x, n.y, n.z) : 0;
	if (!n || !(len > 1e-9)) return Math.abs(ry);
	return Math.abs((rx * n.x + ry * n.y + rz * n.z) / len);
}

/**
 * The strength an On Impact node sees for one registered impact, or null when it does not fire.
 * `down` / `speed` are the two channels physics registered (null = that channel did not count
 * this contact, e.g. a sideways hit has no downward channel).
 * @param {any} direction the node's `direction` ('any' | 'down'; missing = the legacy 'down')
 * @param {number | null} down @param {number | null} speed
 */
export function impactStrengthFor(direction, down, speed) {
	return (direction ?? LEGACY_IMPACT_DIRECTION) === 'down' ? down : speed;
}
