// RW: first-run welcome + "what's new" (ship-qa B1/B4). The deliberate design is
// BADGE, NOT POPUP for updates — every dialog between click and canvas spends the
// first-minute wow, so a version change only gets a dot on the logo plus one
// auto-dismissing toast. The changelog itself opens in a floating window.
//
// First visit ever shows the welcome overlay INSTEAD — never both.

import { writable, get } from 'svelte/store';
import { APP_VERSION, IS_DEV } from './version.js';
import { showToast } from '../stores/appStore.js';
// The changelog ships as the repo-root CHANGELOG.md (GitHub renders the same file).
import changelogRaw from '../../CHANGELOG.md?raw';

/** Raw markdown of the changelog, rendered by WhatsNew.svelte. */
export const CHANGELOG = String(changelogRaw || '');

const SEEN_WELCOME = 'hasSeenWelcome';
const LAST_SEEN_VERSION = 'lastSeenVersion';

/**
 * Persisted boolean preference (the appStore idiom: absent = default).
 * @param {string} key @param {boolean} dflt
 */
function boolPref(key, dflt) {
	const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
	const store = writable(raw === null ? dflt : raw === 'true');
	if (typeof localStorage !== 'undefined') {
		store.subscribe((v) => {
			try {
				localStorage.setItem(key, v ? 'true' : 'false');
			} catch {
				/* storage disabled */
			}
		});
	}
	return store;
}

/**
 * Show the welcome overlay on every start. Default OFF: the overlay appears on the
 * FIRST visit regardless (see startWhatsNew), and opting in makes it a permanent
 * launcher for the quick-start links. Mirrored by a Settings toggle.
 */
export const showWelcomeOnStart = boolPref('showWelcomeOnStart', false);
/** Announce new versions (logo dot + one toast). Default ON. */
export const showWhatsNewNotice = boolPref('showWhatsNewNotice', true);

/** Welcome overlay open state. */
export const welcomeOpen = writable(false);
/** What's-new floating window open state. */
export const whatsNewOpen = writable(false);
/** Unseen-update marker — paints the dot on the logo menu button. */
export const whatsNewUnseen = writable(false);

function markSeen() {
	try {
		localStorage.setItem(LAST_SEEN_VERSION, APP_VERSION);
	} catch {
		/* storage disabled */
	}
}

/** Open the changelog window; clears the badge and marks this version seen. */
export function openWhatsNew() {
	whatsNewUnseen.set(false);
	markSeen();
	whatsNewOpen.set(true);
}

export function closeWhatsNew() {
	whatsNewOpen.set(false);
}

/** Open the welcome overlay by hand (Settings / menu). */
export function openWelcome() {
	welcomeOpen.set(true);
}

/** Close the welcome overlay and remember that it has been seen. */
export function closeWelcome() {
	welcomeOpen.set(false);
	try {
		localStorage.setItem(SEEN_WELCOME, 'true');
	} catch {
		/* storage disabled */
	}
}

/**
 * Decide what (if anything) greets the user this boot. Called once from App.svelte.
 * First visit -> welcome overlay, and the current version counts as seen so the
 * update badge can't fire on top of it. Returning user on a new version -> badge +
 * one toast. Everything else -> nothing at all.
 */
export function startWhatsNew() {
	if (typeof localStorage === 'undefined') return;
	const firstVisit = !localStorage.getItem(SEEN_WELCOME);
	if (firstVisit || get(showWelcomeOnStart)) {
		welcomeOpen.set(true);
		if (firstVisit) markSeen();
		return;
	}
	if (!get(showWhatsNewNotice)) return;
	const lastSeen = localStorage.getItem(LAST_SEEN_VERSION);
	// IS_DEV: the version string is constant across dev reloads, so this stays quiet
	// after the first acknowledgement instead of nagging every HMR restart.
	if (!lastSeen) {
		markSeen();
		return;
	}
	if (lastSeen === APP_VERSION) return;
	whatsNewUnseen.set(true);
	showToast('Updated to ' + APP_VERSION + (IS_DEV ? '-dev' : '') + ' — see what changed.', [
		{ label: "What's new", action: openWhatsNew }
	]);
}
