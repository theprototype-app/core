// 103 (H6): ONE OUTPUT LAYER FOR VIBRATION. The haptic patterns (hapticPatterns.js) used to play
// on the Quest's controller actuators only. They now play on whatever this device has:
//   · in a headset session: the XR controllers (vr/haptics registers itself as the XR sink in
//     hapticPatterns, so this file never imports the VR code);
//   · a GAMEPAD: `vibrationActuator.playEffect` — 'dual-rumble' (strong + weak motor), or
//     'trigger-rumble' where the pad lists it (an Xbox pad on Chromium/Edge), which carries the
//     same two motors plus the trigger motors; Firefox's `hapticActuators[0].pulse` as a fallback;
//   · an ANDROID phone: `navigator.vibrate`, when no pad took the pulse.
// Nothing present (iOS, desktop Safari, a pad with no motors) = nothing happens, silently.
//
// THE GATE is the existing one (gameFeel: Interact or Play, never Edit) plus the game's own
// settings (Vibration on/off + strength, OS reduced motion = off by default — gameSettings), and
// a pulse is gated again AS IT FIRES, so a pattern stops part-way the moment the player leaves the
// game, the round pauses, the tab is hidden or the scene changes (stopHaptics runs on each).
//
// LOCAL by construction: every call here buzzes THIS device. Who gets a buzz in a shared session
// is decided before we are called (flowRuntime's `who` gate, a module calling its own api), so
// there is no message and no new data about anyone.
//
// The mapping (planHaptic) is PURE over a described environment, so the unit tests run it with
// fakes; `hapticEnv()` is the one place that reads the browser.
import { get } from 'svelte/store';
import { gameFeelActive, gameFeelOn } from './gameFeel';
import { hapticsAllowed, hapticLevel } from './gameSettings';
import { hapticSchedule, customHapticSchedule, xrHaptics, hapticDeviceEnv, connectedGamepads as gamepads, registerHapticOutput } from './hapticPatterns';
import { gameState } from './gameState';

/** @typedef {import('./hapticPatterns').HapticPulse} HapticPulse */
/** @typedef {'left' | 'right' | undefined} Hand */
/**
 * What this device can buzz, described as data.
 * @typedef {{xr: boolean, pads: {index: number, effects: string[], pulse: boolean}[], vibrate: boolean}} HapticEnv
 */
/**
 * One timed output call.
 * @typedef {{at: number, out: 'xr', intensity: number, ms: number, hand: Hand}
 *   | {at: number, out: 'pad', pad: number, effect: string, params: Record<string, number>}
 *   | {at: number, out: 'padpulse', pad: number, intensity: number, ms: number}
 *   | {at: number, out: 'vibrate', pattern: number[]}} HapticCall
 */

const clamp01 = (/** @type {any} */ v) => {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

/**
 * A pulse as gamepad motor magnitudes. The STRONG motor (left grip, low frequency) carries the
 * weight, the WEAK one (right grip, high frequency) the crispness, so a light tap is mostly weak
 * motor and a hit is both. A HAND picks one side: left = the strong motor (and the left trigger),
 * right = the weak motor (and the right trigger). Trigger motors join only for firm pulses (a tap
 * on the trigger under a finger reads as a fault, not feedback). PURE.
 * @param {number} intensity 0..1 @param {Hand} hand @param {boolean} triggers the pad has trigger motors
 * @returns {Record<string, number>}
 */
export function padMagnitudes(intensity, hand, triggers) {
	const i = clamp01(intensity);
	const strong = hand === 'right' ? 0 : hand === 'left' ? i : i >= 0.5 ? i : i * 0.5;
	const weak = hand === 'left' ? 0 : i;
	/** @type {Record<string, number>} */
	const out = { strongMagnitude: round3(strong), weakMagnitude: round3(weak) };
	if (triggers) {
		const t = i >= 0.6 ? round3(i * 0.5) : 0;
		out.leftTrigger = hand === 'right' ? 0 : t;
		out.rightTrigger = hand === 'left' ? 0 : t;
	}
	return out;
}

/** @param {number} n */
function round3(n) {
	return Math.round(n * 1000) / 1000;
}

/**
 * A schedule as a `navigator.vibrate` pattern ([on, off, on, ...] in ms). A phone motor has no
 * strength, only time, so intensity becomes LENGTH: a full pulse keeps its length, a faint one
 * shrinks toward 40 % of it, never under 10 ms (shorter is not felt on most Android motors). A
 * pulse that would overlap the next one is cut where the next starts. PURE.
 * @param {HapticPulse[]} pulses @returns {number[]}
 */
export function vibratePattern(pulses) {
	/** @type {number[]} */
	const out = [];
	let t = 0;
	const sorted = [...pulses].sort((a, b) => a.at - b.at);
	for (let k = 0; k < sorted.length; k++) {
		const p = sorted[k];
		if (p.intensity <= 0) continue;
		const gap = Math.max(0, Math.round(p.at - t));
		if (out.length) out.push(gap);
		else if (gap > 0) out.push(0, gap);
		let on = Math.max(10, Math.round(p.ms * (0.4 + 0.6 * clamp01(p.intensity))));
		const next = sorted[k + 1];
		if (next) on = Math.max(10, Math.min(on, Math.round(next.at - p.at)));
		out.push(on);
		t = Math.max(t, p.at) + on;
	}
	return out;
}

/**
 * Which output calls a schedule becomes on a described device. XR wins outright (a headset's
 * controllers are what the player holds; a pad or the phone would be a second, wrong buzz); then
 * every connected pad with motors; the phone only when no pad took it. PURE.
 * @param {HapticPulse[]} pulses @param {HapticEnv} env @param {Hand} [hand]
 * @returns {HapticCall[]}
 */
export function planHaptic(pulses, env, hand = undefined) {
	const live = pulses.filter((p) => p.intensity > 0 && p.ms > 0);
	if (!live.length) return [];
	/** @type {HapticCall[]} */
	const calls = [];
	if (env.xr) {
		for (const p of live) calls.push({ at: p.at, out: 'xr', intensity: p.intensity, ms: p.ms, hand });
		return calls;
	}
	let padTook = false;
	for (const pad of env.pads) {
		const triggers = pad.effects.includes('trigger-rumble');
		const effect = triggers ? 'trigger-rumble' : pad.effects.includes('dual-rumble') ? 'dual-rumble' : '';
		if (effect) {
			padTook = true;
			for (const p of live)
				calls.push({ at: p.at, out: 'pad', pad: pad.index, effect, params: { duration: p.ms, startDelay: 0, ...padMagnitudes(p.intensity, hand, triggers) } });
		} else if (pad.pulse) {
			padTook = true;
			for (const p of live) calls.push({ at: p.at, out: 'padpulse', pad: pad.index, intensity: p.intensity, ms: p.ms });
		}
	}
	if (!padTook && env.vibrate) {
		const pattern = vibratePattern(live);
		if (pattern.length) calls.push({ at: 0, out: 'vibrate', pattern });
	}
	return calls;
}

/** What to play: a pattern NAME, or a custom `{strength, ms}` single pulse. PURE.
 * @param {string | {strength?: number, ms?: number}} spec @param {number} [scale] multiplies every intensity
 * @returns {HapticPulse[]} */
export function scheduleFor(spec, scale = 1) {
	if (typeof spec === 'string') return hapticSchedule(spec, scale);
	if (spec && typeof spec === 'object') return customHapticSchedule(Number(spec.strength ?? 0.6) * (Number.isFinite(scale) ? scale : 1), Number(spec.ms ?? 80));
	return [];
}

/* ----------------------------------------------------------------- the runtime --- */

/** suites: a fake environment in place of the browser's (null = read the browser) @type {HapticEnv | null} */
let envOverride = null;
/** @param {HapticEnv | null} env */
export function setHapticEnvForTest(env) {
	envOverride = env;
}

/** Read the device (the browser's own, unless a suite set a fake). @returns {HapticEnv} */
export function hapticEnv() {
	return envOverride ?? hapticDeviceEnv();
}

/** may a pulse fire NOW? the edit-mode gate, the player's switch, a paused round, a hidden tab */
function mayFire() {
	if (!gameFeelActive() || !hapticsAllowed()) return false;
	if (get(gameState)?.state === 'paused') return false;
	if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
	return true;
}

/** pending timers, so stopHaptics can cancel a pattern part-way @type {Set<any>} */
const timers = new Set();
/** suites' view (no motor attached headless) */
const debug = {
	/** @type {any[]} */ calls: [],
	plays: 0,
	suppressed: 0,
	stops: 0,
	/** @type {string} */ lastStop: ''
};

/** @param {HapticCall} call */
function fire(call) {
	if (!mayFire()) {
		debug.suppressed++;
		return;
	}
	debug.calls.push({ ...call, t: Date.now() });
	if (debug.calls.length > 128) debug.calls.shift();
	if (envOverride) return; // a fake device: recorded, nothing to drive
	try {
		if (call.out === 'xr') xrHaptics()?.pulse(call.intensity, call.ms, call.hand);
		else if (call.out === 'pad') {
			const pad = gamepads().find((p) => Number(p.index) === call.pad);
			pad?.vibrationActuator?.playEffect?.(call.effect, call.params)?.catch?.(() => {});
		} else if (call.out === 'padpulse') {
			const pad = gamepads().find((p) => Number(p.index) === call.pad);
			pad?.hapticActuators?.[0]?.pulse?.(call.intensity, call.ms);
		} else if (call.out === 'vibrate') navigator.vibrate(call.pattern);
	} catch {
		/* a motor that refuses is a motor that is not there */
	}
}

/**
 * Play a pattern or a custom pulse on this device. Returns false when nothing will play (edit
 * mode, switched off, strength 0, an unknown pattern, no motor at all).
 * @param {string | {strength?: number, ms?: number}} spec a pattern name or {strength 0..1, ms}
 * @param {{hand?: Hand, scale?: number}} [opts] `scale` sizes it before the player's strength
 * @returns {boolean}
 */
export function playHaptic(spec, opts = {}) {
	install();
	if (!mayFire()) {
		debug.suppressed++;
		return false;
	}
	const level = hapticLevel();
	const scale = (Number.isFinite(opts.scale) ? Math.max(0, Number(opts.scale)) : 1) * level;
	const hand = opts.hand === 'left' || opts.hand === 'right' ? opts.hand : undefined;
	const calls = planHaptic(scheduleFor(spec, scale), hapticEnv(), hand);
	if (!calls.length) return false;
	debug.plays++;
	for (const call of calls) {
		if (call.at <= 0) fire(call);
		else {
			const id = setTimeout(() => {
				timers.delete(id);
				fire(call);
			}, call.at);
			timers.add(id);
		}
	}
	return true;
}

/**
 * Stop everything: pending pulses are dropped and every motor is told to stop.
 * @param {string} [reason] what stopped it (suites)
 */
export function stopHaptics(reason = 'stop') {
	const busy = timers.size > 0;
	for (const id of timers) clearTimeout(id);
	timers.clear();
	debug.stops++;
	debug.lastStop = reason;
	if (envOverride) return;
	try {
		for (const pad of gamepads()) pad.vibrationActuator?.reset?.()?.catch?.(() => {});
		// cancelling a phone pattern is a vibrate(0); only when we may have started one
		if (busy || debug.plays) navigator.vibrate?.(0);
		xrHaptics()?.stop?.();
	} catch {
		/* nothing to stop */
	}
}

let installed = false;
/** The stop wiring, once, on first use: leaving the game, a pause, a hidden tab, a new scene. */
function install() {
	if (installed) return;
	installed = true;
	gameFeelOn.subscribe((on) => {
		if (!on) stopHaptics('left-game');
	});
	gameState.subscribe((s) => {
		if (s?.state === 'paused') stopHaptics('paused');
	});
	if (typeof document !== 'undefined')
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') stopHaptics('hidden');
		});
	// a scene replaced (open / travel / new): levels is in the app already; reached lazily so this
	// file stays a leaf
	import('./levels')
		.then((m) => {
			let first = true;
			m.currentLevel.subscribe(() => {
				if (first) first = false;
				else stopHaptics('scene');
			});
		})
		.catch(() => {});
}

/** suites' view @returns {any} */
export function hapticOutputDebug() {
	return { calls: debug.calls.map((c) => ({ ...c })), plays: debug.plays, suppressed: debug.suppressed, stops: debug.stops, lastStop: debug.lastStop, pending: timers.size, env: hapticEnv() };
}
/** a suite section's clean slate */
export function resetHapticOutputDebug() {
	debug.calls = [];
	debug.plays = 0;
	debug.suppressed = 0;
	debug.stops = 0;
	debug.lastStop = '';
}

// every caller (a module's api.feel, the Vibrate node, the headset path) finds the layer synchronously once it is here
registerHapticOutput({ playHaptic, stopHaptics, hapticEnv });
