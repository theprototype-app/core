// 41 G24 — the Image editor's open state as a LEAF (svelte/store only), so the dock's
// bookkeeping (dockMenu.js: the "+" list, the tab ✕, the phone sheet) can address the editor
// without importing imageEditor.js and the library/scene modules behind it.
import { writable, derived, get } from 'svelte/store';

/**
 * The open editor: which Explorer image, plus a `raise` counter so asking again for the
 * same image brings the window forward instead of reloading it (the 21-I3 ruling the
 * preview window keeps). null = closed. `itemId: ''` = open with no image yet (the dock
 * "+" row) — the editor shows how to pick one.
 * @type {import('svelte/store').Writable<{itemId: string, raise: number} | null>}
 */
export const imageEditorTarget = writable(null);

export function closeImageEditor() {
	imageEditorTarget.set(null);
}

/**
 * The dock's closer shape (`DOCK_CLOSERS` — true = closed) over `imageEditorTarget`:
 * reading it says whether the editor is closed; `set(false)` opens it (empty when no image
 * is targeted), `set(true)` closes it. The tab ✕ goes through the editor's own registered
 * closer instead (it asks before discarding unsaved edits).
 */
const closedView = derived(imageEditorTarget, (t) => !t);
export const imageEditorClose = {
	subscribe: closedView.subscribe,
	/** @param {boolean} closed */
	set(closed) {
		if (closed) closeImageEditor();
		else if (!get(imageEditorTarget)) imageEditorTarget.set({ itemId: '', raise: 1 });
	},
	/** @param {(closed: boolean) => boolean} fn */
	update(fn) {
		this.set(fn(get(closedView)));
	}
};

/**
 * uir-preview — THE EDITOR LIVES IN THE PREVIEW WINDOW NOW (its Edit face), so several things can
 * take it away from an unsaved edit: the View tab, Esc, the window's close, walking to another image
 * with `[` `]` or the filmstrip, the pinned preview following the Explorer. They all ask through the
 * ONE question the editor registers here (its "Close without saving?" choice), so none of them can
 * discard an edit silently. No editor mounted = nothing unsaved = yes.
 * @type {((action?: 'leave' | 'switch' | 'close') => Promise<boolean>) | null}
 */
let leaveGuard = null;
/** @param {(action?: 'leave' | 'switch' | 'close') => Promise<boolean>} fn */
export function registerEditorGuard(fn) {
	leaveGuard = fn;
	return () => {
		if (leaveGuard === fn) leaveGuard = null;
	};
}
/** May the editor's current image be left? Asks only when there are unsaved edits.
 * @param {'leave' | 'switch' | 'close'} [action] @returns {Promise<boolean>} */
export function confirmLeaveEditor(action = 'leave') {
	return leaveGuard ? leaveGuard(action) : Promise.resolve(true);
}

/** uir-preview: the editor has unsaved edits (the preview header's dot) @type {import('svelte/store').Writable<boolean>} */
export const imageEditorDirty = writable(false);
