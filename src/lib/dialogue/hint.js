// 92-dialogue (GC7): THE FIRST-USE HINT for a Dialogue node, the 93 levels-hint shape: the first Dialogue a
// person adds on this device says, once, how to write it and how it starts. LOCAL (the person who added
// it), once ever per device (safeStorage). A lazy chunk: Nodes.svelte imports it only when one is added.
import { safeStorage } from '../safeStorage.js';

export const DIALOGUE_HINT =
	'Dialogue added. Write a line per row as Speaker: text; "> Yes -> part" adds a choice and "# part" starts that part. Wire a Proximity (to: player) into start so it opens when someone walks up: only that player sees it.';

export const DIALOGUE_HINT_KEY = 'tp:dialogue-hint';

/** @param {{show: (id: string, message: string, actions: any[]) => void}} ui @returns {boolean} shown */
export function dialogueHintOnce(ui) {
	if (safeStorage.getItem(DIALOGUE_HINT_KEY)) return false;
	safeStorage.setItem(DIALOGUE_HINT_KEY, '1');
	ui.show('dialogue-hint', DIALOGUE_HINT, [{ label: 'Got it', action: () => {} }]);
	return true;
}
