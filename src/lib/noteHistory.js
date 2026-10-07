// 37 R16 — NOTE EDITS UNDO. The 'annotation' history kind: creating, editing, deleting a note
// and replying to one are each ONE undo step, and undoing REPLICATES (it writes through the
// same setAnnotation / deleteAnnotation the popover uses, so every peer converges).
//
// This module's BODY registers the kind, so nothing in history's own import subtree may reach
// it statically (the joints / flowGraphs rule): annotationsHandler reaches it through a primed
// dynamic import and calls `recordNoteChange` from its two writers. Recording is muted while
// history applies an entry (history.recordEntry's own guard), so an undo records nothing.
//
// THE DIRECTION IS READ BY IDENTITY (`state === entry.before`), the rule every kind keeps —
// the shader-redo bug came from reading a flag instead.
//
// REPLIES are not simply put back: the wire MERGES replies per reply by their `at` stamp, so
// setting an older list would be outvoted by every peer's newer copy. Undo instead RE-STAMPS
// the difference: a reply the target lacks becomes a tombstone now, a reply the target has
// that is currently gone comes back now — newer than anything a peer holds, so it wins.
import { get } from 'svelte/store';
import { registerHistoryKind, recordEntry } from './history';
import { annotations, setAnnotation, deleteAnnotation } from './annotationsHandler';
import { restampReplies, changedReplyIds } from './noteReplies';

/** the fields a person edits — a change elsewhere (an author re-stamp) is not an undo step */
const EDITED = ['text', 'name', 'color', 'label', 'shape', 'camera', 'follow', 'offset', 'objectUuid', 'replies'];

/** @param {any} a @param {any} b */
function sameNote(a, b) {
	if (!a || !b) return a === b;
	return EDITED.every((k) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
}

/** @param {any} note */
const copy = (note) => (note ? structuredClone(note) : null);

/**
 * Record one note change. `before`/`after` are whole notes (null = absent).
 * @param {any} before @param {any} after
 */
export function recordNoteChange(before, after) {
	if (sameNote(before, after)) return;
	const id = (after ?? before)?.id;
	if (!id) return;
	const label = !before ? 'Add note' : !after ? 'Delete note' : (after.replies?.length ?? 0) !== (before.replies?.length ?? 0) || JSON.stringify(after.replies) !== JSON.stringify(before.replies) ? 'Reply' : 'Edit note';
	recordEntry({ kind: 'annotation', id, label, before: copy(before), after: copy(after) });
}

registerHistoryKind('annotation', (/** @type {any} */ entry, /** @type {any} */ state) => {
	const target = state === entry.before ? entry.before : entry.after;
	const current = get(annotations).find((a) => a.id === entry.id) ?? null;
	if (!target) {
		if (current) deleteAnnotation(entry.id);
		return true;
	}
	// only what THIS step changed: a reply somebody else wrote or deleted since is theirs
	const only = entry.before && entry.after ? changedReplyIds(entry.before.replies, entry.after.replies) : null;
	const replies = restampReplies(current?.replies ?? [], target.replies ?? [], Date.now(), only);
	// a reply step changes the thread, never the note's own text (someone may have edited it since)
	const base = entry.label === 'Reply' && current ? current : target;
	setAnnotation({ ...structuredClone(base), replies });
	return true;
});
