// 31 (Stars Room S3): THE CLAP — bring both hands together and hold them there. A pure
// leaf (imports nothing), so the gesture is unit-tested with no headset, no scene and no
// clock: the caller feeds two hand positions and its own time, and the detector answers
// whether this frame is the one a clap lands on, and where.
//
// THE RULE, four facts:
//   · CLOSE: the two hands (controller tips, or tracked hands) are within `distance`;
//   · HELD: they have been close for `holdMs` without a break — a hand swinging past the
//     other at speed is not a clap, and neither is one noisy frame;
//   · RE-ARMED: after a clap the hands must part past `releaseDistance` before the next
//     one counts — holding them together is ONE clap, not one per `cooldownMs`;
//   · COOLED: at least `cooldownMs` since the last clap, so a fast double tap cannot
//     spam whatever the clap makes.
// A frame with a hand missing (untracked, disconnected) breaks the hold and changes
// nothing else — losing tracking for a moment is not "the hands parted", so it neither
// re-arms nor fires.

/** the defaults: ~10 cm (two controller tips touching — the Quest's own bodies keep the
 * tracking origins a few centimetres apart, so 8 cm was on the edge of reachable), a
 * quarter second held, one clap a second, and 20 cm apart to re-arm */
export const CLAP_DEFAULTS = Object.freeze({
	distance: 0.1,
	holdMs: 250,
	cooldownMs: 1000,
	releaseDistance: 0.2
});

/**
 * @typedef {{closeSince: number | null, armed: boolean, lastFireAt: number}} ClapState
 * @typedef {{distance?: number, holdMs?: number, cooldownMs?: number, releaseDistance?: number}} ClapOptions
 */

/** @returns {ClapState} */
export function createClapState() {
	return { closeSince: null, armed: true, lastFireAt: -Infinity };
}

/** @param {any} v @param {number} fallback @param {number} min @param {number} max */
function clampNum(v, fallback, min, max) {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/**
 * The options at a boundary: authored node data may be absent or a peer's string.
 * @param {ClapOptions | null | undefined} raw
 * @returns {{distance: number, holdMs: number, cooldownMs: number, releaseDistance: number}}
 */
export function normalizeClapOptions(raw) {
	const distance = clampNum(raw?.distance, CLAP_DEFAULTS.distance, 0.02, 0.5);
	return {
		distance,
		holdMs: clampNum(raw?.holdMs, CLAP_DEFAULTS.holdMs, 0, 3000),
		cooldownMs: clampNum(raw?.cooldownMs, CLAP_DEFAULTS.cooldownMs, 100, 60000),
		// never inside the close radius, or a held clap would re-arm itself
		releaseDistance: Math.max(distance * 1.25, clampNum(raw?.releaseDistance, CLAP_DEFAULTS.releaseDistance, 0.02, 2))
	};
}

/** @param {any} p */
function isPoint(p) {
	return Array.isArray(p) && p.length >= 3 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);
}

/**
 * One frame. MUTATES `state` and returns what happened.
 * @param {ClapState} state
 * @param {number[] | null | undefined} left the left hand, [x, y, z]
 * @param {number[] | null | undefined} right the right hand
 * @param {number} now ms, the caller's clock
 * @param {ClapOptions} [options]
 * @returns {{fired: boolean, point: [number, number, number] | null, distance: number}}
 */
export function stepClap(state, left, right, now, options) {
	const o = normalizeClapOptions(options);
	if (!isPoint(left) || !isPoint(right)) {
		state.closeSince = null;
		return { fired: false, point: null, distance: Infinity };
	}
	const l = /** @type {number[]} */ (left);
	const r = /** @type {number[]} */ (right);
	const dx = r[0] - l[0];
	const dy = r[1] - l[1];
	const dz = r[2] - l[2];
	const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
	if (distance >= o.releaseDistance) state.armed = true;
	if (distance > o.distance) {
		state.closeSince = null;
		return { fired: false, point: null, distance };
	}
	if (state.closeSince === null) state.closeSince = now;
	const held = now - state.closeSince >= o.holdMs;
	if (!held || !state.armed || now - state.lastFireAt < o.cooldownMs) return { fired: false, point: null, distance };
	state.armed = false;
	state.lastFireAt = now;
	state.closeSince = null;
	return {
		fired: true,
		point: [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2, (l[2] + r[2]) / 2],
		distance
	};
}
