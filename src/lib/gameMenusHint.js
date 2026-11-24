// 92 (GC7 rule: one first-use hint for the release's main feature) — THE TITLE SCREEN'S FIRST-USE HINT: the first
// time a person turns a title screen on (Configure Scene ▸ Game menus) this device says, once, where it shows and
// what goes with it. LOCAL (safeStorage, never a peer), quiet in an export (nobody authoring). The levels hint's shape.
import { safeStorage } from './safeStorage.js';

export const TITLE_HINT =
	'Title screen on. Play links and exported games open on it, and so does Play here. Turn on Three save slots for Continue and Load game; the pause menu pauses only while nobody else is playing.';
export const TITLE_HINT_KEY = 'tp:menus-hint:title';

/**
 * Show the hint if this device has not seen it. @param {{show: (id: string, message: string, actions: any[]) => void,
 * play?: () => void}} ui @returns {boolean} shown
 */
export function titleHintOnce(ui) {
	if (safeStorage.getItem(TITLE_HINT_KEY)) return false;
	safeStorage.setItem(TITLE_HINT_KEY, '1');
	ui.show('menus-hint-title', TITLE_HINT, [...(ui.play ? [{ label: 'Try it', action: () => ui.play?.() }] : []), { label: 'Got it', action: () => {} }]);
	return true;
}
