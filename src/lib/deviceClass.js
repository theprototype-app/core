import { readable, derived } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { phoneShell } from './ui/phoneShell.js';

// showhide-v8 (owner 2026-11-09) — THE THREE DEVICES THE SIDEBAR DEFAULTS ARE WRITTEN FOR. The owner's table:
//
//   device                       | "Show viewport sidebar handles"     | side-panels button
//   desktop (mouse)              | on, only while a column is CLOSED   | hidden (Customize adds it)
//   unfolded phone               | off                                 | shown
//   wide touch screen / tablet   | on                                  | hidden (the handles replace it)
//
// The folded phone is the phone shell (no sidebars at all) and is not in the table. An unfolded foldable and a tablet
// are both a coarse pointer on a screen wider than the phone shell, so the WIDTH cannot tell them apart (the N6 inner
// screen is wider than many tablets in CSS px). What does: the browser says "mobile" for a phone, folded or not, and
// not for a tablet — `navigator.userAgentData.mobile` where it exists (Chromium), else the UA's "Mobi" token (Android
// phones carry it, Android tablets do not). An iPad is a tablet whichever UA it sends (iPadOS sends the Mac one with
// touch points). A LEAF (svelte/store + safeStorage + the phone shell switch).

/** @typedef {'desktop'|'phone'|'tablet'} DeviceClass */

/** a test / support override (Settings never writes it): localStorage `deviceClass` = desktop | phone | tablet */
const OVERRIDE_KEY = 'deviceClass';

/** a touch screen: no hover, coarse pointer */
export const coarsePointer = readable(false, (set) => {
	if (typeof window === 'undefined' || !window.matchMedia) return;
	const mq = window.matchMedia('(pointer: coarse)');
	set(mq.matches);
	const on = () => set(mq.matches);
	mq.addEventListener?.('change', on);
	return () => mq.removeEventListener?.('change', on);
});

/** does the browser call itself mobile (a phone)? */
export function browserSaysMobile() {
	if (typeof navigator === 'undefined') return false;
	/** @type {any} */
	const nav = navigator;
	const ua = String(nav.userAgent || '');
	if (/iPad/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1)) return false;
	if (typeof nav.userAgentData?.mobile === 'boolean') return nav.userAgentData.mobile;
	return /Mobi|iPhone|iPod/.test(ua);
}

/** @param {any} v @returns {DeviceClass|null} */
const asClass = (v) => (v === 'desktop' || v === 'phone' || v === 'tablet' ? v : null);

/**
 * desktop = a mouse; phone = a touch screen that says it is mobile (the unfolded foldable — the folded one is the
 * phone shell); tablet = any other touch screen.
 * @type {import('svelte/store').Readable<DeviceClass>}
 */
export const deviceClass = derived(coarsePointer, ($coarse) => {
	const forced = typeof localStorage !== 'undefined' ? asClass(safeStorage.getItem(OVERRIDE_KEY)) : null;
	if (forced) return forced;
	if (!$coarse) return 'desktop';
	return browserSaysMobile() ? 'phone' : 'tablet';
});

/** the unfolded phone: a phone whose screen is wide enough for sidebars (the folded one is the phone shell) */
export const unfoldedPhone = derived([deviceClass, phoneShell], ([$c, $phone]) => $c === 'phone' && !$phone);
