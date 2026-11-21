// 102b: per-object body tuning and the four new joint kinds — the PURE half (imports nothing),
// so the clamps and defaults that decide what a body or joint becomes are unit-testable with no
// rapier and no stores. physics.js applies them, joints.js and the agent tools validate with them.

/** The per-body tuning keys on userData.physics (each optional; absent = the scene's value). */
export const BODY_TUNING_KEYS = /** @type {const} */ (['gravityScale', 'linearDamping', 'angularDamping']);

/** The clamps: gravity scale may go negative (a balloon), damping uses the scene's own range. */
export const BODY_TUNING_RANGE = {
	gravityScale: [-5, 5],
	linearDamping: [0, 5],
	angularDamping: [0, 5]
};

/**
 * What a dynamic body's gravity scale and damping resolve to — its own value, else the scene's
 * damping and a gravity scale of 1 (the pre-102b body, exactly).
 * @param {any} p collectParams entry / userData.physics (or null) @param {any} defaults scenePhysicsDefaults
 * @returns {{gravityScale: number, linear: number, angular: number}}
 */
export function bodyTuningOf(p, defaults) {
	return {
		gravityScale: Number.isFinite(p?.gravityScale) ? p.gravityScale : 1,
		linear: Number.isFinite(p?.linearDamping) ? p.linearDamping : (defaults?.damping?.linear ?? 0),
		angular: Number.isFinite(p?.angularDamping) ? p.angularDamping : (defaults?.damping?.angular ?? 0)
	};
}

/**
 * A caller's tuning values, clamped into a setPhysicsFor patch. `null` passes through (it means
 * "back to the scene's value"); anything not a finite number is dropped.
 * @param {any} input @returns {Record<string, number|null>}
 */
export function bodyTuningPatch(input) {
	/** @type {Record<string, number|null>} */
	const out = {};
	if (!input || typeof input !== 'object') return out;
	for (const key of BODY_TUNING_KEYS) {
		const v = input[key];
		if (v === null) out[key] = null;
		else if (Number.isFinite(v)) {
			const [lo, hi] = BODY_TUNING_RANGE[key];
			out[key] = Math.min(Math.max(v, lo), hi);
		}
	}
	return out;
}
