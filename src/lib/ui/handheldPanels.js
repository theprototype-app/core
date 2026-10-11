// 41 G18 — ON A PHONE, A DOCKED WINDOW STARTS WITH ITS SIDEBARS HIDDEN.
//
// The user's rule: "on every docked window on mobile it is better to have sidebars hidden by
// default, unless they were clicked to be shown". A phone's dock is a few hundred pixels wide
// (folded) and a palette + a properties column leave the graph a sliver. So every sidebar
// open/closed pref goes through here:
//   - a HANDHELD (touch-first, no hover, short screen side — a folded OR unfolded phone, a small
//     tablet) reads and writes its OWN key (`<key>:touch`), whose default is CLOSED;
//   - anything else keeps the key and the default it always had (byte-identical on desktop).
// The separate key is what makes "starts hidden" true for people who already used the app on
// that phone (the old key held the desktop default) and keeps a touch laptop's two modes apart.
// Once the user opens a sidebar on the phone it stays open, per window — the key is per window.
//
// A LEAF (safeStorage only), so WindowShell, the node editor and anything else can share it.
import { safeStorage } from '../safeStorage';

/** the longest short side (css px) still treated as a handheld: an unfolded OPPO Find N6 is ~770 */
export const HANDHELD_MAX_SIDE = 900;

/** A touch-first handheld: coarse pointer, no hover, and a short screen side. Read from the
 *  SCREEN, not the window, so a fold/unfold (or a split-screen window) does not flip it. */
export function handheld() {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
	if (!window.matchMedia('(pointer: coarse)').matches) return false;
	if (window.matchMedia('(hover: hover)').matches) return false;
	const s = window.screen;
	const side = Math.min(s?.width || window.innerWidth, s?.height || window.innerHeight);
	return side > 0 && side <= HANDHELD_MAX_SIDE;
}

/** the storage key a sidebar pref lives under on this device @param {string} key */
export function panelKey(key) {
	return handheld() ? `${key}:touch` : key;
}

/**
 * Is this sidebar open? The stored choice when there is one; otherwise CLOSED on a handheld and
 * `desktopDefault` elsewhere.
 * @param {string} key @param {boolean} desktopDefault
 */
export function readPanelOpen(key, desktopDefault) {
	const hand = handheld();
	let v = null;
	try {
		v = safeStorage.getItem(hand ? `${key}:touch` : key);
	} catch {
		v = null;
	}
	if (v == null) return hand ? false : desktopDefault;
	return v !== 'false';
}

/** remember the user's choice for this sidebar on this device @param {string} key @param {boolean} open */
export function writePanelOpen(key, open) {
	try {
		safeStorage.setItem(panelKey(key), String(!!open));
	} catch {
		// private mode: this session only
	}
}
