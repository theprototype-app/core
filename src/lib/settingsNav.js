// 36 B14 — SETTINGS ON WINDOWSHELL: the section REGISTRY behind the sidebar.
//
// Settings used to be one long accordion. It is a WindowShell window now: a sidebar listing the
// sections, and the main pane showing ONE of them. The list is not written anywhere — each
// `SettingsSection` (the drop-in for flowbite's AccordionItem, same `bind:open` + `header`
// snippet API) REGISTERS itself here when it mounts, so a section another lane adds to
// Settings.svelte with one `<AccordionItem>` block appears in the sidebar with no second edit.
// That is the merge-hot-spot rule (one line per new section) carried over to the new chrome.
//
// THE OPEN FLAG STAYS THE SECTION'S MOUNT SWITCH. Settings.svelte's own logic is unchanged:
// a search sets every section open (the I4 filter can only see mounted rows), a deep link
// (`settingsSection`) opens one. What this registry adds is the rule OUTSIDE a search: exactly
// one section is open — the ACTIVE one — and a sidebar click, a deep link or a reopen picks it
// (deep link > the section that was active > any section already open > the last one used on
// this device > the first). While searching every section stays open and a sidebar click
// scrolls to that section instead.
//
// LOCAL: which section was last used is a per-device convenience (safeStorage).
//
// 37-settings (R21) adds two pieces of navigation state, both per-window and never persisted:
//   - `sub`  the SUB-PAGE open inside the active section ({id, label} or null): a submenu opens in
//            the content area with a breadcrumb ("VR › Remap buttons"), never as a modal on top.
//            Switching section, a search or a reopen closes it.
//   - `home` on a phone (< 640 px) the first screen is the category LIST; tapping a category pushes
//            its page, "‹ Settings" comes back. A deep link skips the list.
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';

export const NAV_CONTEXT = 'settings-nav';
const LAST_KEY = 'settings:section';

/** 'Node types' -> 'nodetypes' — the shape of `settingsSection` deep-link keys ('vr', 'ai', 'explorer'…)
 * @param {string} label */
export function sectionKeyOf(label) {
	return String(label ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '');
}

/**
 * @typedef {{
 *   header: any,
 *   label: string,
 *   isOpen: () => boolean,
 *   setOpen: (open: boolean) => void,
 *   el: () => HTMLElement | null
 * }} NavEntry
 */

export function createSettingsNav() {
	/** registration order = template order (sections register in their script body) */
	const entries = writable(/** @type {NavEntry[]} */ ([]));
	const active = writable(/** @type {NavEntry | null} */ (null));
	const searching = writable(false);
	/** the open sub-page of the active section @type {import('svelte/store').Writable<{id: string, label: string} | null>} */
	const sub = writable(/** @type {{id: string, label: string} | null} */ (null));
	/** a phone shows the category list (true) or one category page (false) */
	const home = writable(false);

	/** @param {NavEntry} entry */
	function register(entry) {
		entries.update((list) => [...list, entry]);
		return () => {
			entries.update((list) => list.filter((e) => e !== entry));
			if (get(active) === entry) active.set(null);
		};
	}

	/** Outside a search, exactly the active section is open. */
	function enforce() {
		if (get(searching)) return;
		const current = get(active);
		for (const e of get(entries)) if (e.isOpen() !== (e === current)) e.setOpen(e === current);
	}

	/** @param {NavEntry | null | undefined} entry @param {{remember?: boolean, keepHome?: boolean}} [opts] */
	function activate(entry, opts = {}) {
		if (!entry) return;
		if (get(searching)) {
			entry.el()?.scrollIntoView({ block: 'start' });
			return;
		}
		if (get(active) !== entry) sub.set(null);
		// a reopen picking the section to show must not leave a phone's list; a tap or a deep link does
		if (!opts.keepHome) home.set(false);
		active.set(entry);
		enforce();
		if (opts.remember !== false && entry.label) safeStorage.setItem(LAST_KEY, sectionKeyOf(entry.label));
		const main = typeof document !== 'undefined' ? document.getElementById('settings-main') : null;
		if (main) main.scrollTop = 0;
	}

	/** @param {string | null} key a `settingsSection` deep-link key */
	function activateKey(key) {
		const want = sectionKeyOf(key ?? '');
		if (!want) return false;
		// exact first, then a prefix: the 'touch' link names the "Touch controls" section
		const list = get(entries);
		const hit = list.find((e) => sectionKeyOf(e.label) === want) ?? list.find((e) => sectionKeyOf(e.label).startsWith(want));
		if (hit) activate(hit, { remember: false });
		return !!hit;
	}

	/**
	 * Pick the section to show — called once the sidebar knows every label (each time Settings
	 * mounts its sections, i.e. on open) and when a search ends.
	 * @param {string | null} [deepLink]
	 */
	function resolve(deepLink = null) {
		if (get(searching)) return;
		const list = get(entries);
		if (!list.length) return;
		if (deepLink && activateKey(deepLink)) return;
		const current = get(active);
		const remembered = safeStorage.getItem(LAST_KEY);
		const pick =
			(current && list.includes(current) ? current : null) ??
			list.find((e) => e.isOpen()) ??
			list.find((e) => remembered && sectionKeyOf(e.label) === remembered) ??
			list[0];
		activate(pick, { remember: false, keepHome: true });
	}

	/** The search box changed. Ending a search puts the one-section view back. @param {boolean} on */
	function setSearching(on) {
		if (get(searching) === on) return;
		searching.set(on);
		// after Settings.svelte has restored its own open flags (same flush), keep the active one
		if (on) sub.set(null);
		if (!on) queueMicrotask(() => resolve());
	}

	/**
	 * open a sub-page of the active section. `key` names the page that asks (Settings wraps this so a
	 * NavRow pressed in a search result first jumps to that page).
	 * @param {string} id @param {string} label @param {string} [key]
	 */
	// eslint-disable-next-line no-unused-vars
	function openSub(id, label, key) {
		sub.set({ id, label });
		const main = typeof document !== 'undefined' ? document.getElementById('settings-main') : null;
		if (main) main.scrollTop = 0;
	}
	/** back out of the sub-page (to its section) */
	function closeSub() {
		sub.set(null);
	}
	/** a phone's "‹ Settings": back to the category list */
	function showHome() {
		sub.set(null);
		home.set(true);
	}
	/** the section key of an entry ('Touch controls' → 'touchcontrols') @param {NavEntry | null | undefined} e */
	function keyOf(e) {
		return e ? sectionKeyOf(e.label) : '';
	}

	return { entries, active, searching, sub, home, register, activate, activateKey, resolve, setSearching, enforce, openSub, closeSub, showHome, keyOf };
}
