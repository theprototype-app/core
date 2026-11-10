import { writable, derived, get } from 'svelte/store';
import { dirtyPulse } from './autosave';

/*
 * showhide-v8 section 6: the burger's Save is greyed until an edit.
 * The dirty pulse counts every dirty mark; a Save remembers the count it saved at, so Save is armed exactly
 * when something changed since the last file save. A leaf over the autosave store; nothing replicates or
 * persists (a reload starts unarmed until the next edit).
 */
const savedAt = writable(get(dirtyPulse));

/** has the scene changed since it was last saved to a file from the menu? */
export const editedSinceSave = derived([dirtyPulse, savedAt], ([$pulse, $at]) => $pulse !== $at);

/** the edit count right now: take it when Save is PRESSED and hand it to noteFileSaved once the save went through */
export function editMark() {
	return get(dirtyPulse);
}

/**
 * a Save went through: disarm until the next edit. `at` = the edit count when Save was pressed (editMark), so an
 * edit made while the save ran keeps Save armed; a Cancel or "without these changes" never calls this
 * @param {number} [at]
 */
export function noteFileSaved(at = get(dirtyPulse)) {
	savedAt.set(at);
}
