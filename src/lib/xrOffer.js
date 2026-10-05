// 36 A2 — LET THE HEADSET BROWSER OFFER "ENTER VR" BY ITSELF (navigator.xr.offerSession).
//
// THE FINDING: core never called offerSession, yet it was already being called — @threlte/xr's
// <XR> does it by default (`offerSession = true`), and its default is wrong for us three ways:
// it offers immersive-AR on any AR-capable device (a Quest is one, so the browser offered
// passthrough to someone who wanted VR), it offers AGAIN after every session ends (its effect
// re-runs when the session clears), and it never hears a decline (it swallows the rejection).
//
// So Scene passes `offerSession={$xrOfferMode}` and this module decides the value:
//   · feature-detected: only where `navigator.xr.offerSession` exists AND the mode is supported
//   · the mode follows the user's Play preference (passthrough → AR, else VR), like requestPlay
//   · ONCE PER PAGE: the first session that starts (offered or entered with Play) ends it
//   · RESPECTS A DECLINE: a NotAllowedError from the offer is remembered on this device and
//     nothing is offered again until the setting is switched off and on
//   · a setting (`xrOfferSession`, default on) turns the whole thing off
// The offer itself stays threlte's (it owns the session hand-off: setSession + its own state),
// so the store must stay truthy until the offer SETTLES — flipping it early would run the
// effect's cleanup, which drops an accepted session on the floor. We observe the outcome by
// wrapping `navigator.xr.offerSession` once, at install.

import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';

export const OFFER_SETTING_KEY = 'xrOfferSession';
export const DECLINED_KEY = 'xrOfferDeclined';

/** what Scene hands <XR offerSession>: false, or the mode to offer @type {import('svelte/store').Writable<false | 'immersive-vr' | 'immersive-ar'>} */
export const xrOfferMode = writable(false);

/** the user's switch (Settings ▸ Tours ▸ Offer Enter VR) */
export const xrOfferEnabled = writable(safeStorage.getItem(OFFER_SETTING_KEY) !== 'false');
let wasOff = safeStorage.getItem(OFFER_SETTING_KEY) === 'false';
xrOfferEnabled.subscribe((on) => {
	safeStorage.setItem(OFFER_SETTING_KEY, on ? 'true' : 'false');
	// switching it (back) on forgets an earlier decline: the user asked for the offer again
	if (on && wasOff) safeStorage.removeItem(DECLINED_KEY);
	wasOff = !on;
	if (!on) xrOfferMode.set(false);
});

/**
 * Should this page offer a session, and which? Pure.
 * @param {{hasOffer: boolean, supported: boolean, enabled: boolean, declined: boolean,
 *   settled: boolean, passthrough: boolean}} s
 *   settled: an offer already ran its course on this page, or a session already started
 * @returns {false | 'immersive-vr' | 'immersive-ar'}
 */
export function offerDecision(s) {
	if (!s.hasOffer || !s.supported || !s.enabled || s.declined || s.settled) return false;
	return s.passthrough ? 'immersive-ar' : 'immersive-vr';
}

/** the page's own record (the suites read it) */
const state = { installed: false, settled: false, outcome: /** @type {string | null} */ (null), offers: 0, mode: /** @type {string | null} */ (null) };

/**
 * Install once (Scene's onMount). `passthrough` is the Play preference's store; `vrMode` the
 * app's VR flag (any session that starts settles the page). Returns the teardown.
 * @param {{passthrough: import('svelte/store').Readable<boolean>, vrMode: import('svelte/store').Readable<boolean>}} stores
 * @returns {() => void}
 */
export function installXROffer({ passthrough, vrMode }) {
	const xr = /** @type {any} */ (typeof navigator !== 'undefined' ? navigator : null)?.xr;
	if (state.installed || !xr || typeof xr.offerSession !== 'function') return () => {};
	state.installed = true;
	const original = xr.offerSession;
	xr.offerSession = function (/** @type {any[]} */ ...args) {
		state.offers++;
		state.mode = args[0];
		const promise = original.apply(xr, args);
		Promise.resolve(promise).then(
			() => settle('accepted'),
			(/** @type {any} */ error) => {
				if (error?.name === 'NotAllowedError') safeStorage.setItem(DECLINED_KEY, String(Date.now()));
				settle(error?.name === 'NotAllowedError' ? 'declined' : 'cancelled');
			}
		);
		return promise;
	};
	/** @param {string} outcome */
	function settle(outcome) {
		state.settled = true;
		state.outcome = state.outcome ?? outcome;
		xrOfferMode.set(false);
	}

	let alive = true;
	/** @type {Record<string, boolean>} */
	const supported = {};
	const decide = async () => {
		const mode = get(passthrough) ? 'immersive-ar' : 'immersive-vr';
		if (!(mode in supported)) {
			try {
				supported[mode] = !!(await xr.isSessionSupported(mode));
			} catch {
				supported[mode] = false;
			}
		}
		if (!alive) return;
		const next = offerDecision({
			hasOffer: true,
			supported: supported[mode],
			enabled: get(xrOfferEnabled),
			declined: !!safeStorage.getItem(DECLINED_KEY),
			settled: state.settled,
			passthrough: get(passthrough)
		});
		// never swap the mode under a live offer (the effect's cleanup would orphan it)
		if (get(xrOfferMode) && next) return;
		xrOfferMode.set(next);
	};
	const stops = [
		passthrough.subscribe(() => void decide()),
		xrOfferEnabled.subscribe(() => void decide()),
		vrMode.subscribe((vr) => {
			// once per page: the first session — offered or entered with Play — settles it
			if (vr) settle('session');
		})
	];
	return () => {
		alive = false;
		for (const stop of stops) stop();
		xr.offerSession = original;
		state.installed = false;
		xrOfferMode.set(false);
	};
}

/** the suites' view */
export function xrOfferDebug() {
	return { ...state, mode: get(xrOfferMode), lastOffered: state.mode };
}
