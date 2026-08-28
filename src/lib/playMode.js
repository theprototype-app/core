import { derived, get, writable } from 'svelte/store';
import { isLocked, isVRMode, vrOverride, vrPassthrough } from '../stores/sceneStore';
// appStore is a LEAF (svelte/store and nothing else — sceneStore already pulls in more
// than it does), so this does not widen the cycle surface the note below is about.
import { showToast } from '../stores/appStore';

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

/* ------------------------------------------------------------------ the exit --- */

// W3: THE FIXED WALL IS GONE. There used to be an `allowPlay` flag here holding play
// shut for a FLAT 2000ms after every exit, because Chromium refuses
// `requestPointerLock` for about a second after a USER-INITIATED Esc — "The user has
// exited the lock before this request was completed". Two things were wrong with
// paying for that here. It is the WRONG LAYER: the refusal belongs to the pointer
// lock, so the component that asks for the lock is what should cope with it
// (PointerLockControls retries on refusal now, ~275ms steps for up to 2.5s, and stops
// the instant the lock lands). And it is the WRONG PRICE: the ~1s refusal only
// applies to an Esc the USER pressed, so every other exit — a programmatic stop, the
// menu substate, a HUD button — paid two seconds for a browser rule it was never
// subject to. Pressing play now enters as fast as the engine allows, which is
// instant in the common case.
//
// The flag below is declared ABOVE the `isLocked` subscription at the foot of this
// file, which runs its callback SYNCHRONOUSLY at module evaluation (the module-level
// subscribe rule — a `let` read from below would TDZ-crash the SSR prerender).

// 21-F3 REJOIN, and all that survives of the cooldown: `isLocked === false` is a
// TRANSIENT that lives until the next macrotask (the settle below), and a press that
// lands inside that sliver must not be EATEN — the button doing nothing with no
// feedback is precisely the "I left play and could not get back in" report. It is
// replayed at the settle instead, which is now the whole of the deferral.
let playQueued = false;

/* --------------------------------------------------------------- xr recovery --- */

// W3: `isVRMode` is set OPTIMISTICALLY, one line before the click that asks for the
// session, and that is deliberate — Scene arms the whole VR configuration off this
// store (it unmounts the transform gizmo and the Outline pass), so it has to be true
// before the first XR frame, not a beat after it. What was missing is the other half:
// nothing ever put it BACK. `sessionend` is the only reset in the app, and a
// requestSession that REJECTS fires no session events at all — threlte's XRButton
// swallows the rejection into an `onerror` prop no call site passed.
//
// Stuck-true is not cosmetic. `openViewportMenuAt` in Scene.svelte refuses while it
// holds, and that function is the ONE writer of the viewport and object context
// menus, so right-click, the touch long-press and the mobile "+" all go silently
// dead — which is the report, verbatim: deny the VR permission and the context menu
// stops working. Click-select, the gizmo, WASD navigation and focus go with it, and
// the app still LOOKS normal because `isLocked` was never touched.
//
// TWO recoveries, because there are two shapes of failure:
//   · `xrSessionFailed` is the DIRECT one — Controls hands it to both hidden buttons
//     as their `onerror`, so a denied permission answers in well under a second.
//   · the WATCHDOG covers what has no signal at all: XRButton returns SILENTLY
//     (without calling onerror) when its own support state is not 'supported', and a
//     click that never reaches a button reports nothing either.
// Scene's raw `sessionstart` both cancels the watchdog AND asserts `isVRMode` true,
// which is what makes the timer safe to fire while a permission prompt is still on
// screen: the reset is only ever undoing a GUESS, and a late accept re-arms VR from
// the event that actually knows.

const XR_START_TIMEOUT = 6000;
/** @type {any} */
let xrWatchdog = null;

function clearXRWatchdog() {
	if (xrWatchdog) clearTimeout(xrWatchdog);
	xrWatchdog = null;
}

/** a session really started — Scene calls this from the renderer's own event */
export function noteXRSessionStarted() {
	clearXRWatchdog();
}

/** the session request failed (or was denied): undo the optimistic mode switch */
export function xrSessionFailed() {
	clearXRWatchdog();
	if (get(isVRMode) !== true) return;
	isVRMode.set(false);
	// only the DIRECT path says anything: at the timeout we cannot tell a refusal
	// from a prompt the user has not answered yet, and a toast claiming failure over
	// a live permission dialog would be a lie.
	showToast('Could not start the immersive session. Still in the editor.');
}

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
			// W3: arm the safety net BEFORE the click, so a button that returns without
			// asking for anything is covered too (see the xr recovery note above).
			clearXRWatchdog();
			xrWatchdog = setTimeout(() => {
				xrWatchdog = null;
				// a real session cancelled this timer; reaching here means none started
				if (get(isVRMode) === true) isVRMode.set(false);
			}, XR_START_TIMEOUT);
			aimed.click();
			return;
		}
	}
	// already in play — a second press is not a re-entry
	if (get(isLocked) === true) return;
	// 21-F3: `isLocked === false` is the transient the exit path writes and the
	// subscription below settles to null on the next macrotask. Setting `true` on top of
	// it would be read by nobody (the settle would overwrite it), so REMEMBER the press
	// and let the settle replay it — a wait measured in one macrotask, not in seconds.
	if (get(isLocked) === false) {
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

// The exit settle, formerly Controls' `$effect`. `isLocked === false` is what the exit
// path writes; it becomes null here, on the very next macrotask. Nothing waits any
// longer than that — see the W3 note above.
if (typeof window !== 'undefined') {
	isLocked.subscribe((v) => {
		if (v !== false) return;
		// NEVER write a store from inside its own subscriber (flush loop) — hop out of
		// the notification first. It costs one macrotask and no semantics: every reader
		// of the transient `false` already treats it as "not playing, not ready yet".
		setTimeout(() => {
			if (get(isLocked) === false) isLocked.set(null);
			// 21-F3: honour a press made during the transient. Through `requestPlay`, not a
			// bare store write, so the XR branch and the guards above still decide.
			if (playQueued) {
				playQueued = false;
				requestPlay();
			}
		}, 0);
	});
}
