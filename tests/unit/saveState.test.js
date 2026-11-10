// 78-fix-547: the burger's Save greys only once a save went through — a Cancel in the "unsaved changes" question or
// "Save project without these changes" leaves it armed (it used to grey at the press).
import { describe, it, expect, vi } from 'vitest';
import { get, writable } from 'svelte/store';

vi.mock('../../src/lib/autosave', () => ({ dirtyPulse: writable(0) }));

const { dirtyPulse } = await import('../../src/lib/autosave');
const { editedSinceSave, editMark, noteFileSaved } = await import('../../src/lib/saveState.js');

describe('saveState', () => {
	it('arms on an edit and disarms when the save that was pressed went through', () => {
		expect(get(editedSinceSave)).toBe(false);
		dirtyPulse.update((n) => n + 1);
		expect(get(editedSinceSave)).toBe(true);
		const at = editMark();
		noteFileSaved(at);
		expect(get(editedSinceSave)).toBe(false);
	});
	it('a press that never saved (Cancel) leaves it armed: nothing calls noteFileSaved', () => {
		dirtyPulse.update((n) => n + 1);
		editMark(); // pressed, then cancelled
		expect(get(editedSinceSave)).toBe(true);
	});
	it('an edit made while the save ran keeps it armed', () => {
		const at = editMark();
		dirtyPulse.update((n) => n + 1); // during the save
		noteFileSaved(at);
		expect(get(editedSinceSave)).toBe(true);
		noteFileSaved();
		expect(get(editedSinceSave)).toBe(false);
	});
});
