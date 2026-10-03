// VR controls — haptics: pulses, patterns, knocks (silent in Edit).
// 34 R4 (A5): one concern of src/lib/vrControls.js, which re-exports the public names unchanged.
import { gameFeelActive } from '../gameFeel';
import { hapticsAllowed } from '../gameSettings';
import { hapticSchedule, knockHapticScale } from '../hapticPatterns';
import { renderer } from './core.js';

/** 30b: what the actuators were asked for (a ring, newest last) and how many pulses the
 * Edit-mode gate swallowed — the suites' view, since no headset is attached headless */
const hapticRing = /** @type {{intensity: number, ms: number, hand: string | null, at: number}[]} */ ([]);
let hapticSuppressed = 0;

/**
 * Buzz the VR controllers if the session's gamepads support it (no-op on
 * desktop). Used by modules for press feedback. Optional `hand` targets one
 * controller — matched by each inputSource's OWN handedness (never a raw slot
 * index, which diverges from the controller order after a hands<->controllers
 * swap — 194/210; axesForSlot resolves the same way).
 *
 * 30b (C4): a NO-OP IN EDIT MODE — "The vibration should be only interactive mode, not
 * in edit mode" (the user, from a Quest). Every core pulse and a module's api.haptic
 * funnel through here, so this one gate covers all of them.
 * @param {number} intensity 0..1 @param {number} durationMs
 * @param {'left'|'right'=} hand omit to pulse both
 * @param {boolean=} force pulse even in Edit (the mode-switch tick only)
 */
export function hapticPulse(intensity = 0.5, durationMs = 50, hand = undefined, force = false) {
	// `force`: the one pulse that must be felt IN Edit — 30b-vr-modes' Edit/Interact switch
	// tick, which confirms the switch INTO Edit
	// 31 K3: and never when this game's "Controller vibration" setting is off
	if (!force && (!gameFeelActive() || !hapticsAllowed())) {
		hapticSuppressed++;
		return;
	}
	const session = renderer?.xr?.getSession?.();
	if (!session) return;
	hapticRing.push({ intensity, ms: durationMs, hand: hand ?? null, at: performance.now() });
	if (hapticRing.length > 64) hapticRing.shift();
	session.inputSources?.forEach((/** @type {any} */ source) => {
		if (hand && source.handedness !== hand) return;
		const actuator = source.gamepad?.hapticActuators?.[0];
		actuator?.pulse?.(intensity, durationMs);
	});
}

/**
 * 30b (C4): play a named PATTERN ('tap' 'bump' 'hit' 'success' 'fail' 'rumble'
 * 'heartbeat' — hapticPatterns.js) as timed pulses. `scale` sizes every pulse (a knock's
 * impulse). Returns false for an unknown name or outside Interact/Play; each pulse is
 * gated again as it fires, so leaving the game mid-pattern stops it.
 * @param {string} name @param {'left'|'right'=} hand @param {number=} scale
 * @returns {boolean}
 */
export function hapticPattern(name, hand = undefined, scale = 1) {
	const pulses = hapticSchedule(name, scale);
	if (!pulses.length || !gameFeelActive()) return false;
	for (const pulse of pulses) {
		if (pulse.at <= 0) hapticPulse(pulse.intensity, pulse.ms, hand);
		else setTimeout(() => hapticPulse(pulse.intensity, pulse.ms, hand), pulse.at);
	}
	return true;
}

/** 30b: the knock's haptic seam (Scene hands this to knock.js) — a `hit` sized by the
 * knock's own strength, on the hand that hit. `intensity` arrives as knock.js computes
 * it (0.2 + speed/10); read back as the speed it encodes.
 * @param {number} intensity @param {number} _ms @param {'left'|'right'} hand */
export function hapticKnock(intensity, _ms, hand) {
	hapticPattern('hit', hand, knockHapticScale(Math.max(0, (Number(intensity) - 0.2) * 10)));
}

/** the suites' view of the actuators @returns {{pulses: any[], suppressed: number}} */
export function hapticDebug() {
	return { pulses: hapticRing.map((p) => ({ ...p })), suppressed: hapticSuppressed };
}
