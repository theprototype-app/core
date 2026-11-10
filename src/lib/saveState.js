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

/** a Save went through: disarm until the next edit */
export function noteFileSaved() {
	savedAt.set(get(dirtyPulse));
}
