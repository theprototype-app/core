// uir-account — open Settings on a page, optionally at one element of it (an id inside the page). The page key is
// a `settingsSection` deep-link key ('account', 'interface'…, aliases included: 'connectedapps' → Account); the
// anchor is an element id Settings scrolls into view once it renders (plugin rows arrive after an await), then flashes.
// Core callers (Connect Claude's "Connected apps") and the cloud plugin (cloudApi.openSettings) share it.
import { settingsOpen, settingsSection, settingsAnchor } from '../../stores/appStore.js';

/** an element id: letters, digits, '-' and '_' only (it goes into getElementById, never a selector) */
const ANCHOR_RE = /^[A-Za-z][\w-]{0,79}$/;
/** 89 I2: the Connected apps groups moved from Settings ▸ Account to Settings ▸ AI — their anchors follow them */
const MOVED_TO_AI = /^(connected-apps-|row-connected-app|row-connector-tab)/;

/**
 * @param {string} section a deep-link key
 * @param {string | null} [anchor] an element id on that page
 * @returns {boolean} false for a malformed request (nothing opens)
 */
export function openSettingsAt(section, anchor = null) {
	let key = String(section ?? '').trim();
	if (!key || key.length > 40) return false;
	let id = anchor == null || anchor === '' ? null : String(anchor);
	if (id !== null && !ANCHOR_RE.test(id)) return false;
	// 89 I2: an old link to Account's Connected apps (the cloud plugin's, a saved one) lands on the AI page's card
	const page = key.toLowerCase().replace(/[^a-z0-9]/g, '');
	if (page === 'connectedapps' || (page === 'account' && id !== null && MOVED_TO_AI.test(id))) {
		key = 'ai';
		id = id ?? 'connected-apps-settings';
	}
	settingsAnchor.set(id);
	settingsSection.set(key);
	settingsOpen.set(true);
	return true;
}
