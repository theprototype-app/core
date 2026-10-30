// 56 C13 (addendum 2026-10-28f) — the "Save project" dialog's open state, a LEAF so the burger menu can
// mount the dialog lazily without importing the save runtime (saveProject.js) into the boot graph.
import { writable } from 'svelte/store';

/**
 * Null = closed. Open = the rows to offer (sessionVolumeCore.saveDialogRows), what pressed Save,
 * and the open scene's name when it has unsaved changes (the dirty-scene line).
 * @type {import('svelte/store').Writable<{trigger: 'burger' | 'ctrls', rows: any[], scene: string | null} | null>}
 */
export const saveManyDialog = writable(null);
