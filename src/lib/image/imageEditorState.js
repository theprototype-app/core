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
