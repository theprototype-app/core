// 30b (vr-play) C4 — HAPTIC PATTERNS as data. `api.hapticPattern(name, hand)` plays one
// of these on the Quest's controller actuators; core fires the defaults in Interact/Play
// (hover-enter `tap`, a press `bump`, a grab `hit`, a knock scaled by its impulse).
//
// A pattern is a list of PULSES, each `{at, intensity, ms}` with `at` in milliseconds
// from the start. A GamepadHapticActuator plays one pulse at a time and a new pulse
// REPLACES the one running, so a pattern is timed pulses, never overlapping ones — the
// schedule below is what vrControls plays through setTimeout.
//
// Imports NOTHING: the shapes are tested with no browser and no headset. How they FEEL is
// the on-device check (owed) — the numbers are a first pass at "make it cool".

/** @typedef {{at: number, intensity: number, ms: number}} HapticPulse */

/** @type {Record<string, HapticPulse[]>} */
export const HAPTIC_PATTERNS = {
	// a fingertip on a button: the lightest thing that is still felt
	tap: [{ at: 0, intensity: 0.18, ms: 12 }],
	// a press landing: short and firm
	bump: [{ at: 0, intensity: 0.45, ms: 28 }],
	// a grab or a solid contact: a hard edge, then a short settle
	hit: [
		{ at: 0, intensity: 0.85, ms: 35 },
		{ at: 55, intensity: 0.3, ms: 25 }
	],
	// a win: three rising pulses
	success: [
		{ at: 0, intensity: 0.3, ms: 40 },
		{ at: 90, intensity: 0.5, ms: 40 },
		{ at: 180, intensity: 0.8, ms: 70 }
	],
	// a miss: two heavy, flat pulses
	fail: [
		{ at: 0, intensity: 0.7, ms: 90 },
		{ at: 160, intensity: 0.7, ms: 140 }
	],
	// an engine / an explosion: a long grinding buzz, fading
	rumble: [
		{ at: 0, intensity: 1, ms: 120 },
		{ at: 120, intensity: 0.75, ms: 120 },
		{ at: 240, intensity: 0.5, ms: 120 },
		{ at: 360, intensity: 0.28, ms: 140 }
	],
	// lub-dub
	heartbeat: [
		{ at: 0, intensity: 0.65, ms: 45 },
		{ at: 150, intensity: 0.4, ms: 55 }
	]
};

/** the names `api.hapticPattern` accepts */
export const HAPTIC_PATTERN_NAMES = Object.keys(HAPTIC_PATTERNS);

/**
 * A pattern's pulses, clamped to what an actuator takes (0..1, 1..1000 ms). Unknown -> [].
 * `scale` multiplies every intensity — how a knock's impulse sizes a `hit`.
 * @param {string} name @param {number} [scale] @returns {HapticPulse[]}
 */
export function hapticSchedule(name, scale = 1) {
	const pattern = HAPTIC_PATTERNS[String(name)];
	if (!pattern) return [];
	const k = Number.isFinite(scale) ? Math.max(0, scale) : 1;
	return pattern.map((p) => ({
		at: Math.max(0, p.at),
		intensity: Math.min(1, Math.max(0, p.intensity * k)),
		ms: Math.min(1000, Math.max(1, p.ms))
	}));
}

/**
 * The strength a KNOCK buzzes with: a light brush is a tap, a real swing a full hit.
 * `speed` is the closing speed in m/s (knockMath's `approach`).
 * @param {number} speed @returns {number} 0.2..1
 */
export function knockHapticScale(speed) {
	const s = Number.isFinite(speed) ? Math.max(0, speed) : 0;
	return Math.min(1, 0.2 + s / 6);
}
