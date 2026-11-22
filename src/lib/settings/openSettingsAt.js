// uir-account — open Settings on a page, optionally at one element of it (an id inside the page). The page key is
// a `settingsSection` deep-link key ('account', 'interface'…, aliases included: 'connectedapps' → Account); the
// anchor is an element id Settings scrolls into view once it renders (plugin rows arrive after an await), then flashes.
// Core callers (Connect Claude's "Connected apps") and the cloud plugin (cloudApi.openSettings) share it.
import { settingsOpen, settingsSection, settingsAnchor } from '../../stores/appStore.js';

/** an element id: letters, digits, '-' and '_' only (it goes into getElementById, never a selector) */
const ANCHOR_RE = /^[A-Za-z][\w-]{0,79}$/;

/**
 * @param {string} section a deep-link key
 * @param {string | null} [anchor] an element id on that page
 * @returns {boolean} false for a malformed request (nothing opens)
 */
export function openSettingsAt(section, anchor = null) {
	const key = String(section ?? '').trim();
	if (!key || key.length > 40) return false;
	const id = anchor == null || anchor === '' ? null : String(anchor);
	if (id !== null && !ANCHOR_RE.test(id)) return false;
	settingsAnchor.set(id);
	settingsSection.set(key);
	settingsOpen.set(true);
	return true;
}
