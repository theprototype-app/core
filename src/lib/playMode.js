import { derived, get, writable } from 'svelte/store';
import { isLocked, isVRMode, vrOverride, vrPassthrough } from '../stores/sceneStore';

// THE PLAY STATE MACHINE, lifted out of Controls.svelte so the play FAB, the FAB's
// right-click mode menu and (next) a keyboard shortcut all press the same button.
// It used to live as three private pieces of that component — the XR support probes,
// `checkPlay` and the exit-cooldown effect — which is why the FAB's GLYPH and its
// ACTION read two different sources: the glyph derived from
// `navigator.xr.isSessionSupported`, while the click SNIFFED threlte's private button
// label and localStorage. One decision lives here now; the label survives only as a
// safety guard (see `requestPlay`).
//
// The imports are deliberately sceneStore + svelte/store ONLY. shortcuts.js sits in
// history.js's import subtree, so anything reachable from here would have to be
// cycle-safe from there too — and this module is about to be imported from it.

/* ------------------------------------------------------------------ support ---- */

/** immersive-vr is available on this device (probe answer, false until it lands) */
export const vrSupported = writable(false);
/** immersive-ar — passthrough — is available on this device */
export const arSupported = writable(false);

// try/catch and not just .catch(): a runtime whose isSessionSupported THROWS
// synchronously would otherwise throw during this module's evaluation, and this
// module owns the play button — the one control the app cannot lose.
try {
	const xr = typeof navigator === 'undefined' ? null : /** @type {any} */ (navigator).xr;
	xr?.isSessionSupported?.('immersive-vr')
		?.then((/** @type {boolean} */ ok) => vrSupported.set(!!ok))
		?.catch(() => vrSupported.set(false));
	xr?.isSessionSupported?.('immersive-ar')
		?.then((/** @type {boolean} */ ok) => arSupported.set(!!ok))
		?.catch(() => arSupported.set(false));
} catch {
	vrSupported.set(false);
	arSupported.set(false);
}

/**
 * WHAT a play press is about to do: a supported immersive session AND no desktop
 * override. `vrPassthrough` picks WHICH session kind is asked for, so it also picks
 * which support answer matters.
 *
 * `vrOverride` is a STRING ('true') or null in practice — Scene.svelte seeds it
 * straight from localStorage — so this is a TRUTHINESS test, never `=== true`.
 */
export const willEnterXR = derived(
	[vrPassthrough, vrSupported, arSupported, vrOverride],
	([$passthrough, $vr, $ar, $override]) => (($passthrough ? $ar : $vr) && !$override)
);

/** ...and that session is the passthrough (immersive-ar) one */
export const willEnterAR = derived(
	[willEnterXR, vrPassthrough],
	([$xr, $passthrough]) => $xr && !!$passthrough
);

/* ------------------------------------------------------------------ cooldown --- */

// Both flags are declared ABOVE the `isLocked` subscription at the foot of this file,
// which runs its callback SYNCHRONOUSLY at module evaluation (the module-level
// subscribe rule — a `let` read from below would TDZ-crash the SSR prerender).

/** false while the post-exit re-entry lockout is running */
let allowPlay = true;
// 21-F3 REJOIN: a play press that landed inside the exit cooldown, replayed when it
// expires. The cooldown itself has to stay — it exists because the browser refuses a
// pointer-lock request for about a second after a user-initiated Esc — but DROPPING
// the press was never part of that: the button simply did nothing, with no feedback,
// which is precisely the "I left play and could not get back in" report. Deferring is
// the whole fix, and it costs one flag.
let playQueued = false;

/* ------------------------------------------------------------------ the press -- */

/**
 * The one entry point. Enters an immersive session when that is what this press
 * means, and desktop play otherwise.
 *
 * It must stay SYNCHRONOUS on the XR path: `requestSession` is only granted inside
 * the user gesture that asked for it, so nothing here may await.
 */
export function requestPlay() {
	if (get(willEnterXR) && typeof document !== 'undefined') {
		// Both hidden XR buttons are mounted permanently (Controls.svelte), so the aimed
		// one is already in the DOM even when the preference was flipped by the menu item
		// that is calling us — there is no remount to wait for.
		const aimed = /** @type {HTMLElement | null} */ (
			document.querySelector(get(vrPassthrough) ? '#vrButtonAr button' : '#vrButtonVr button')
		);
		// The label test is BELT AND BRACES, not the decision. threlte writes
		// 'Enter VR' / 'Enter AR' only while a session can be STARTED, and flips it to
		// 'Exit …' once one runs — clicking THAT would leave the session we were asked to
		// enter — and to a not-supported text when its own probe says no. The probes
		// above decide; this refuses a click that would do the wrong thing.
		if (aimed && (aimed.textContent ?? '').trim().startsWith('Enter')) {
			isVRMode.set(true);
			aimed.click();
			return;
		}
	}
	// already in play — a second press is not a re-entry
	if (get(isLocked) === true) return;
	// 21-F3: inside the exit cooldown, REMEMBER the press instead of eating it.
	// `isLocked === false` is the transient the exit path writes (the subscription below
	// settles it to null), so both non-null values land here.
	if (allowPlay !== true || get(isLocked) === false) {
		playQueued = true;
		return;
	}
	// NOTE for whoever tidies this: `isLocked` is `writable(null)`, so TS infers
	// Writable<null> and every `.set(true)` in the app reads as an error — twelve of
	// them sit in PointerLockControls alone. This one MOVED here with the code and is
	// part of the 385 baseline. Casting it away locally would drop the count to 384;
	// the real fix is a JSDoc annotation on the store, which moves the baseline by a
	// dozen and belongs in its own change.
	if (get(isLocked) === null) isLocked.set(true);
}

// The exit debounce, formerly Controls' `$effect`. `isLocked === false` is what the
// exit path writes; it settles to null here and locks re-entry out for two seconds.
if (typeof window !== 'undefined') {
	isLocked.subscribe((v) => {
		if (v !== false) return;
		allowPlay = false;
		// NEVER write a store from inside its own subscriber (flush loop) — hop out of
		// the notification first. It costs one macrotask and no semantics: every reader
		// of the transient `false` already treats it as "not playing, not ready yet".
		setTimeout(() => {
			if (get(isLocked) === false) isLocked.set(null);
		}, 0);
		setTimeout(() => {
			allowPlay = true;
			// 21-F3: honour a press made during the cooldown. Through `requestPlay`, not a
			// bare store write, so the XR branch and the guards above still decide.
			if (playQueued) {
				playQueued = false;
				requestPlay();
			}
		}, 2000);
	});
}
