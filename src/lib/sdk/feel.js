// Module SDK — haptics and the knock feed (onHit / hitLog).
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { vrControlsRef, knockRef, knockReady } from './refs.js';
import { gameFeelActive } from '../gameFeel';
import { hapticLevel } from '../gameSettings';
import { hapticSchedule, xrHaptics } from '../hapticPatterns';

// 103 (H6): the vibration output layer (gamepads, Android phones, VR controllers) — LAZY, so a
// module that never buzzes costs nothing; a call before it lands plays once it has
/** @type {any} */
let out = null;
/** @type {Promise<any> | null} */
let outLoad = null;
const load = () => (outLoad ??= import('../hapticOutput.js').then((m) => (out = m)));
/** @param {any} spec @param {any} opts @returns {boolean} */
function buzz(spec, opts) {
	// in a headset: the controllers directly, synchronously, as before 103 (vrControls owns that gate)
	if (vrControlsRef && xrHaptics()?.active?.()) {
		const k = Number.isFinite(opts?.scale) ? Math.max(0, opts.scale) : 1;
		if (typeof spec === 'string') return vrControlsRef.hapticPattern?.(spec, opts?.hand, k) ?? false;
		const i = Math.min(1, Math.max(0, Number(spec?.strength ?? 0.6) * k * (hapticLevel() || 1)));
		const ms = Math.min(1000, Math.max(1, Number(spec?.ms ?? 80)));
		vrControlsRef.hapticPulse?.(i, ms, opts?.hand);
		return gameFeelActive();
	}
	if (!gameFeelActive()) return false;
	if (out) return out.playHaptic(spec, opts);
	load().then((m) => m.playHaptic(spec, opts));
	return true;
}
/** @param {any} hand @returns {'left' | 'right' | undefined} */
const handOf = (hand) => (hand === 'left' || hand === 'right' ? hand : undefined);

/** @param {import('./context.js').SdkContext} ctx */
export function sdkFeel(ctx) {
	const { owned } = ctx;
	return {
		/**
		 * Buzz the VR controllers (press feedback). No-op on desktop / when
		 * the session's gamepads lack haptics. `hand` targets one controller
		 * ('left'|'right', resolved by handedness); omit to pulse both.
		 * Reaches vrControls via the primed dynamic import (a static edge
		 * would close a module cycle - same rule as vrRadialMenu). (17-A1)
		 * @param {number=} intensity 0..1 @param {number=} durationMs
		 * @param {'left'|'right'=} hand
		 */
		haptic(intensity = 0.5, durationMs = 50, hand = undefined) {
			// 30b: silent in EDIT mode (core's own gate) — vibration is for playing.
			// 103 (H6): through the one output layer — a gamepad or a phone feels it too
			buzz({ strength: Number(intensity), ms: Number(durationMs) }, { hand: handOf(hand) });
		},
		/**
		 * 30b: a named haptic PATTERN — 'tap' (hover), 'bump' (a press), 'hit' (a grab,
		 * a contact), 'success', 'fail', 'rumble' (an engine, an explosion), 'heartbeat'.
		 * On one hand ('left'|'right') or both. LOCAL, Interact/Play only (false in Edit).
		 * 103 (H6): on VR controllers, a gamepad (dual / trigger rumble) or an Android phone,
		 * whichever this device has. Core already plays tap / bump / hit / knocks in VR for
		 * you; use this for the game's own moments.
		 * @param {string} name @param {'left'|'right'=} hand @returns {boolean}
		 */
		hapticPattern(name, hand = undefined) {
			if (!hapticSchedule(String(name)).length) return false;
			return buzz(String(name), { hand: handOf(hand) });
		},
		/**
		 * 103 (H6): VIBRATION on this device. `feel.vibrate('hit')` plays a pattern (the names of
		 * hapticPattern), `feel.vibrate({strength: 0.8, ms: 200})` a custom buzz; options `{hand:
		 * 'left'|'right', scale: 0..1}` (a hand = that controller in VR, that side's motor on a
		 * pad). LOCAL — buzz only the player it is for (a module decides that, e.g. on its own
		 * peer's hit). Interact / Play only, never Edit; the player's Vibration setting and
		 * strength apply; nothing happens where there is no motor (iOS). `feel.stop()` stops
		 * what is playing; `feel.outputs()` says what this device has.
		 */
		feel: {
			vibrate: (/** @type {string | {strength?: number, ms?: number}} */ spec, /** @type {{hand?: string, scale?: number}} */ options = {}) =>
				buzz(typeof spec === 'string' ? spec : { strength: Number(spec?.strength ?? 0.6), ms: Number(spec?.ms ?? 80) }, {
					hand: handOf(options?.hand),
					...(Number.isFinite(Number(options?.scale)) ? { scale: Number(options.scale) } : {})
				}),
			stop: () => {
				out?.stopHaptics?.('module');
			},
			/** @returns {{vr: boolean, gamepads: number, triggerRumble: boolean, phone: boolean}} */
			outputs: () => {
				const env = out?.hapticEnv?.();
				if (!env) {
					load();
					return { vr: false, gamepads: 0, triggerRumble: false, phone: false };
				}
				const pads = env.pads.filter((/** @type {any} */ p) => p.effects.length || p.pulse);
				return {
					vr: env.xr,
					gamepads: pads.length,
					triggerRumble: pads.some((/** @type {any} */ p) => p.effects.includes('trigger-rumble')),
					phone: !env.xr && !pads.length && env.vibrate
				};
			}
		},
		/**
		 * 24-A A2: every KNOCK this peer sees — its own hand's, and every peer's as the
		 * `hit` message is applied — as `{uuid, by, at, speed, point, linvel, angvel,
		 * probe, local}`. `local` is true on the peer whose hand it was; `by` is that
		 * peer's id (empty when solo). The same feed On Hit stamps from, so a module and a
		 * graph agree on which hits happened. Returns the unsubscribe; torn down with the
		 * module. Football's last-touch attribution rides this, evaluated BY EACH PEER
		 * (the peerVars one-writer rule).
		 * @param {(hit: any) => void} fn @returns {() => void}
		 */
		onHit(fn) {
			/** @param {any} hit @param {boolean} local */
			const wrapped = (hit, local) => fn({ ...hit, local });
			/** @type {(() => void) | null} */
			let off = null;
			let gone = false;
			knockReady.then((m) => {
				if (m && !gone) off = m.registerHitListener(wrapped);
			});
			return owned('hitListener', () => {
				gone = true;
				off?.();
				off = null;
			});
		},
		/**
		 * 24-A A2: the knock log as a COPY — `last` = the most recent hit per live body
		 * (keyed by uuid), `recent` = the last 32 hits in order. Runtime state: a late
		 * joiner's log starts empty (a module that needs history keeps its own through
		 * registerStateSync).
		 * @returns {{last: Record<string, any>, recent: any[]}}
		 */
		hitLog() {
			return knockRef?.hitLogSnapshot?.() ?? { last: {}, recent: [] };
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. tests/unit/moduleLifecycle.test.js holds every 'registers' member to a
 * teardown path; a member missing here fails it. */
sdkFeel.surface = {
	haptic: 'action',
	hapticPattern: 'action',
	'feel.vibrate': 'action',
	'feel.stop': 'action',
	'feel.outputs': 'read',
	onHit: 'registers',
	hitLog: 'read'
};
