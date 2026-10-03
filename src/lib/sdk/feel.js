// Module SDK — haptics and the knock feed (onHit / hitLog).
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { vrControlsRef, knockRef, knockReady } from './refs.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkFeel(ctx) {
	const { onDispose } = ctx;
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
			// 30b: silent in EDIT mode (core's own gate) — vibration is for playing
			vrControlsRef?.hapticPulse?.(intensity, durationMs, hand);
		},
		/**
		 * 30b: a named haptic PATTERN — 'tap' (hover), 'bump' (a press), 'hit' (a grab,
		 * a contact), 'success', 'fail', 'rumble' (an engine, an explosion), 'heartbeat'.
		 * On one hand ('left'|'right') or both. LOCAL, Interact/Play only (false in Edit,
		 * on desktop nothing buzzes). Core already plays tap / bump / hit / knocks for
		 * you; use this for the game's own moments.
		 * @param {string} name @param {'left'|'right'=} hand @returns {boolean}
		 */
		hapticPattern(name, hand = undefined) {
			return vrControlsRef?.hapticPattern?.(String(name), hand) ?? false;
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
			const stop = () => {
				gone = true;
				off?.();
				off = null;
			};
			onDispose(stop);
			return stop;
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
