// 59 T5 — what a button does when its tool is missing: say WHAT is missing and open the row in
// Settings ▸ Tools & connections, instead of hiding the button. One place, so the AI button, the
// quick prompt bar, the Add menu's Generate 3D model, the mic and the phone's More sheet all say
// the same sentence and land on the same row.
import { settingsOpen, settingsSection, showToast } from '../../stores/appStore.js';
import { featureStatus, toolsFocus } from './toolStatus.js';
import './builtinTools.js'; // fills the registry before anyone asks it

/** the Settings deep-link key of the page (`settingsNav` matches the prefix of 'toolsconnections') */
export const TOOLS_SECTION_KEY = 'tools';

/**
 * Open Settings ▸ Tools & connections at a section (and a row in it).
 * @param {string} section a TOOL_SECTIONS id @param {string | null} [row] a row id ('mesh:<id>')
 */
export function openToolRow(section, row = null) {
	toolsFocus.set({ section, row, at: Date.now() });
	settingsSection.set(TOOLS_SECTION_KEY);
	settingsOpen.set(true);
}

/**
 * The T5 gate a button calls first: ready → false (go on); missing → a toast saying what is
 * missing, Settings opened at its row, and true (stop).
 * @param {string} featureId @returns {boolean} true when the feature cannot run
 */
export function explainMissing(featureId) {
	const status = featureStatus(featureId);
	if (status.ready) return false;
	showToast(status.message);
	openToolRow(status.section, status.row);
	return true;
}
