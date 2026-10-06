// 38 R9 — THE PHONE SHELL SWITCH (SPEC §6: "Mobile (< 640px)").
//
// Below this width the editor chrome is the decluttered phone layout (PhoneShell.svelte):
// the logo top-left, a Connect chip, the bell and the avatar across the top; a context strip
// and a five-slot bottom bar (Add, Objects, Play, Chat, More) at the bottom; floating windows
// as bottom sheets. Above it nothing changes.
//
// A STORE and not only a media query, because the switch is STRUCTURAL as well as visual: the
// desktop toolbar pill, the round HUD buttons and the touch-tools column stop RENDERING on a
// phone (their ids — #play-button, #mobile-add-button, #touch-undo … — move to the shell, and an
// id must exist once). Pure CSS stays CSS (`@media (max-width: 640px)` in styles/phone.css); the
// two always agree because both read PHONE_QUERY's number.
//
// 640 is the breakpoint the bottom-sheet mode has used since the responsive pass (Inspector,
// NotesDrawer, the full-screen `.tp-modal-*` treatment) — one phone width for the whole app.
import { readable, writable } from 'svelte/store';

export const PHONE_MAX_WIDTH = 640;
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;

/** true while the viewport is phone-sized (follows rotation, a fold/unfold and window resizes) */
export const phoneShell = readable(false, (set) => {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
	const mq = window.matchMedia(PHONE_QUERY);
	set(mq.matches);
	/** @param {MediaQueryListEvent} e */
	const on = (e) => set(e.matches);
	mq.addEventListener('change', on);
	return () => mq.removeEventListener('change', on);
});

// ---- the shell's own sheets + the one height every framed sheet shares ----------------

/** Which SHELL-OWNED sheet is open: 'more' | 'conn' | null. The windows that become sheets
 *  (Objects, Chat, AI, notifications) keep their own open stores; this is only for the two
 *  sheets the shell draws itself. LOCAL, never saved. */
export const phoneSheet = writable(/** @type {string|null} */ (null));

/** The detent the framed sheets rest at ('peek' | 'half' | 'full'). One value for the
 *  session, so a sheet reopens at the height you left the last one at. */
export const phoneDetent = writable('half');

/** SPEC §6 / the design page: peek 32 %, half 58 %, full 92 % of the window height. */
export const PHONE_DETENTS = { peek: 0.32, half: 0.58, full: 0.92 };

/** @param {number} viewportH @returns {{peek: number, half: number, full: number}} */
export function phoneDetentHeights(viewportH) {
	return {
		peek: Math.round(viewportH * PHONE_DETENTS.peek),
		half: Math.round(viewportH * PHONE_DETENTS.half),
		full: Math.round(viewportH * PHONE_DETENTS.full)
	};
}

/** true while PhoneShell is MOUNTED (phone width, editor, not embedded). Connect reads it to
 *  stop publishing a docked bar's height: on the phone shell the bar is a sheet, so nothing
 *  should be pushed down by it. */
export const phoneShellActive = writable(false);
