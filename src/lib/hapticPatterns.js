// 30b (vr-play) C4 — HAPTIC PATTERNS as data. `api.hapticPattern(name, hand)` plays one
// of these on the Quest's controller actuators; core fires the defaults in Interact/Play
// (hover-enter `tap`, a press `bump`, a grab `hit`, a knock scaled by its impulse).
//
// A pattern is a list of PULSES, each `{at, intensity, ms}` with `at` in milliseconds
// from the start. A GamepadHapticActuator plays one pulse at a time and a new pulse
// REPLACES the one running, so a pattern is timed pulses, never overlapping ones — the
// schedule below is what vrControls plays through setTimeout.
//
// Imports NOTHING (103: plus the XR sink slot below): the shapes are tested with no browser and no headset. How they FEEL is
// the on-device check (owed) — the numbers are a first pass at "make it cool".

/** @typedef {{at: number, intensity: number, ms: number}} HapticPulse */

/** 103 (H6): the XR SINK slot. vr/haptics (boot) registers the headset's controllers here and the
 * lazy output layer (hapticOutput) reads it — the one mutable thing in this file, kept here because
 * both sides already import it and neither may import the other.
 * @typedef {{active: () => boolean, pulse: (intensity: number, ms: number, hand: 'left' | 'right' | undefined) => void, stop?: () => void}} XrHapticSink */
/** @type {XrHapticSink | null} */
let xrSink = null;
/** @param {XrHapticSink | null} sink */
export function registerXrHaptics(sink) {
	xrSink = sink;
}
/** @returns {XrHapticSink | null} */
export function xrHaptics() {
	return xrSink;
}
/** the output layer once it has loaded (it registers itself), so a caller that did not load it
 * plays synchronously instead of waiting on its own dynamic import @type {any} */
let outputLayer = null;
/** @param {any} layer */
export function registerHapticOutput(layer) {
	outputLayer = layer;
}
/** @returns {any} */
export function hapticOutputLayer() {
	return outputLayer;
}

/* the device read */
/** the connected gamepads, as the browser hands them (navigator.getGamepads can throw in a
 * sandboxed frame) @returns {any[]} */
export function connectedGamepads() {
	try {
		const list = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
		return Array.from(list ?? []).filter((p) => p && p.connected !== false);
	} catch {
		return [];
	}
}

/** 103 (H6): what this device can vibrate with — VR controllers, pads, a phone motor. Lives here, in
 * the boot chunk, so `api.feel.outputs()` answers on its first call (the output layer is lazy). @returns {import('./hapticOutput.js').HapticEnv} */
export function hapticDeviceEnv() {
	const pads = connectedGamepads().map((/** @type {any} */ p) => {
		const actuator = p.vibrationActuator;
		const effects = actuator && typeof actuator.playEffect === 'function' ? (Array.isArray(actuator.effects) ? [...actuator.effects] : ['dual-rumble']) : [];
		const pulse = typeof p.hapticActuators?.[0]?.pulse === 'function';
		return { index: Number(p.index), effects, pulse };
	});
	const vibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
	return { xr: !!xrHaptics()?.active?.(), pads, vibrate };
}

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
 * 103 (H6): a CUSTOM buzz — one pulse of `strength` (0..1) for `ms` (10..1000), the Vibrate node's
 * "custom" and `api.feel.vibrate({strength, ms})`. Clamped like a pattern. PURE.
 * @param {number} strength @param {number} ms @returns {HapticPulse[]}
 */
export function customHapticSchedule(strength, ms) {
	const i = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0;
	const d = Number.isFinite(ms) ? Math.min(1000, Math.max(10, ms)) : 80;
	return i > 0 ? [{ at: 0, intensity: i, ms: Math.round(d) }] : [];
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
