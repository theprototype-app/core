// 93 — THE FIRST-USE HINT: the first Portal or Checkpoint a person places on this device says, once, what it
// does and where its settings and the Levels table live. Once ever per kind (safeStorage), LOCAL (the person
// who placed it, never a peer), and quiet in an export or Play (nobody authoring).
import { safeStorage } from '../safeStorage.js';

/** @type {Record<'portal' | 'checkpoint', string>} */
export const LEVEL_HINTS = {
	portal:
		'Portal placed. Walking into it in Play takes that player to a level, a scene or a spot: choose where in Properties ▸ Portal. List the game\'s levels, and what carries between them, in Configure Scene ▸ Levels.',
	checkpoint:
		'Checkpoint placed. Stepping on it in Play saves that player\'s progress here: after a fall, Back to checkpoint or a reload of the exported game, they come back to it.'
};

/** the storage key of a hint @param {string} kind */
export const hintKey = (kind) => 'tp:levels-hint:' + kind;

/**
 * Show a kind's hint if this device has not seen it. @param {'portal' | 'checkpoint'} kind
 * @param {{show: (id: string, message: string, actions: any[]) => void, openLevels: () => void}} ui
 * @returns {boolean} shown
 */
export function hintOnce(kind, ui) {
	if (!LEVEL_HINTS[kind] || safeStorage.getItem(hintKey(kind))) return false;
	safeStorage.setItem(hintKey(kind), '1');
	ui.show('levels-hint-' + kind, LEVEL_HINTS[kind], [{ label: 'Levels', action: () => ui.openLevels() }, { label: 'Got it', action: () => {} }]);
	return true;
}
