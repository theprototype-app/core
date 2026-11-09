import { writable, derived, get } from 'svelte/store';
import { dirtyPulse } from './autosave';

// showhide-v8 §6 (burger direction A) — "Save is greyed until an edit". autosave's `dirtyPulse` counts every dirty
// mark (one integer, no work of its own); a Save remembers the count it saved at, so the burger's Save row is armed
// exactly when something changed since the last file save (or since the app started, for a scene never saved). A
// LEAF over autosave's store; nothing replicates or persists (a reload starts unarmed until the next edit).

const savedAt = writable(get(dirtyPulse));

/** has the scene changed since it was last saved to a file from the menu? */
export const editedSinceSave = derived([dirtyPulse, savedAt], ([$pulse, $at]) => $pulse !== $at);

/** a Save went through: disarm until the next edit */
export function noteFileSaved() {
	savedAt.set(get(dirtyPulse));
}
