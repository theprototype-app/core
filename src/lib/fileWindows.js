import { derived, get, writable } from 'svelte/store';
// R22 round 12: the multi-window PREF lives with the other preview prefs; the COLLECTION
// lives here, beside the target it generalises. filePreview imports nothing of ours, so
// this edge closes no cycle.
import { previewMultiWindow, previewPinned } from './filePreview';
// uir-preview: the image editor is the preview window's EDIT face; its open state is a leaf
import { imageEditorTarget, confirmLeaveEditor } from './image/imageEditorState';

// Floating file windows (107): one shared professional code editor window
// (Explorer text files AND the custom-node definition editor route here) and
// a zoomable image preview window.

/** 56 C13: `readOnly` = no Save at all (a session volume's file); then `onSave` may be absent
 * @type {import('svelte/store').Writable<{title: string, code: string, onSave?: (code: string) => void, readOnly?: boolean, onClose?: () => void} | null>} */
export const textEditorTarget = writable(null);

/** @param {{title: string, code: string, onSave?: (code: string) => void, readOnly?: boolean, onClose?: () => void}} target */
export function openTextEditor(target) {
	textEditorTarget.set(target);
}

/**
 * R22 round 11 — THE PREVIEW WINDOW SHOWS MORE THAN AN IMAGE. It now draws an image, an
 * audio transport, a 3D preview or a folder, and its arrows walk the folder the Explorer
 * is showing (see $lib/filePreview for the walk and the overlay prefs).
 *
 * THE STORE KEEPS ITS NAME, and so does the window's DOM id. Four suites and every
 * existing caller address them; the 21-G1 ruling covers exactly this case — the
 * user-visible word changes, the identifiers already written down do not, because
 * renaming them would be a migration for a word. Only the COMPONENT file was renamed, so
 * a reader looking for the audio player can find it.
 *
 * ADDITIVE: a target with no kind is an image, which is what every pre-round-11 caller passes.
 * @type {import('svelte/store').Writable<{title: string, url: string, kind?: 'image'|'audio'|'video'|'object'|'folder', itemId?: string, prefabId?: string, name?: string, folderId?: string, onClose?: () => void} | null>}
 */
/**
 * R22 round 12 — EVERY OPEN PREVIEW WINDOW, oldest first. `{id, ...target}`.
 *
 * The collection is the truth and `imagePreviewTarget` below is a VIEW of the newest
 * entry, because four suites and every existing caller address that store by name and the
 * 21-G1 ruling says identifiers already written down do not get renamed for a feature.
 * With the multi-window pref off there is never more than one entry, so nothing about the
 * old behaviour changes.
 * @type {import('svelte/store').Writable<any[]>}
 */
export const previewWindows = writable([]);

/**
 * R22 ROUND 18 (user): "if clicked cog on both window and then click on Passthrough makes
 * first window were opened to change this option, this is a bug — also allow cog to be
 * opened only to show for one window even if I have multiple ones".
 *
 * THE BUG AND THE REQUEST HAVE THE SAME FIX, which is why they are one change. Every
 * preview window renders the same settings pane, so with two cogs open the document held
 * two elements with `id="preview-passthrough"` — and a `<label for="...">` resolves to the
 * FIRST match in the document, whatever window it belongs to. Clicking the second window's
 * label therefore toggled the first window's checkbox. Now that these are per-window
 * settings (round 14), that mis-aim moves a setting on a window you are not looking at.
 *
 * Holding the id of the ONE window whose cog is open fixes both halves: only one pane
 * exists at a time, so those ids are unique by construction and no label can reach across
 * windows. The suite asserts that uniqueness directly — the fix rests on the invariant, so
 * the invariant is the thing to pin.
 * @type {import('svelte/store').Writable<number|null>}
 */
export const openPreviewCog = writable(null);

let previewSeq = 0;

/**
 * The NEWEST preview window, as a settable store.
 *
 * A custom store rather than a plain `writable`, so the two cannot drift: `set(x)`
 * REPLACES the newest entry (or opens one when there is none), and `set(null)` closes it —
 * which is exactly what every pre-round-12 caller, and `file-windows-esc`, already mean by
 * those calls. `derived` alone would have been read-only.
 * @type {any}
 */
export const imagePreviewTarget = {
	subscribe: derived(previewWindows, (list) => list[list.length - 1] ?? null).subscribe,
	/** @param {any} value */
	set(value) {
		previewWindows.update((list) => {
			if (!value) return list.slice(0, -1);
			if (!list.length) return [{ id: ++previewSeq, ...value }];
			const keepId = list[list.length - 1].id;
			return [...list.slice(0, -1), { ...value, id: keepId }];
		});
	},
	/** @param {(value: any) => any} fn */
	update(fn) {
		let current = null;
		const stop = this.subscribe((/** @type {any} */ v) => (current = v));
		stop();
		this.set(fn(current));
	}
};

/** Close one window by id. @param {number} id */
export function closePreviewWindow(id) {
	previewWindows.update((list) => list.filter((w) => w.id !== id));
}

/** Re-point ONE window without touching the others. @param {number} id @param {any} target */
export function setPreviewWindow(id, target) {
	previewWindows.update((list) => list.map((w) => (w.id === id ? { ...target, id } : w)));
}

/** the same source, already on screen? `{itemId, prefabId, folderId}` is a preview's identity */
const sameSource = (/** @type {any} */ a, /** @type {any} */ b) =>
	(a?.itemId ?? '') === (b?.itemId ?? '') &&
	(a?.prefabId ?? '') === (b?.prefabId ?? '') &&
	(a?.folderId ?? '') === (b?.folderId ?? '') &&
	// a pre-round-11 caller passes only {title, url}; that is its whole identity
	(a?.itemId || a?.prefabId || a?.folderId ? true : (a?.url ?? '') === (b?.url ?? ''));

/** @param {{title: string, url: string, onClose?: () => void}} target */
export function openImagePreview(target) {
	openFilePreview(target);
}

/**
 * The general opener: a file of any previewable kind. 'openImagePreview' stays as the
 * image-shaped front door so nothing that already calls it has to change.
 * @param {{title: string, url?: string, kind?: 'image'|'audio'|'video'|'object'|'folder', itemId?: string, prefabId?: string, name?: string, folderId?: string, onClose?: () => void}} target
 */
export function openFilePreview(target) {
	const spec = { url: '', ...target };
	// R22 round 12: with the pref ON a second open ADDS a window. Two rules make that
	// livable rather than a way to bury the screen in panels:
	//   · THE SAME SOURCE RAISES rather than duplicating (the 21-I3 modelPreviewRaise
	//     ruling — "a repeat open is a raise, not a re-set"), and
	//   · a new window CASCADES off the last one, or every one of them lands on the same
	//     saved rect and only the top is findable.
	if (!get(previewMultiWindow)) {
		// uir-preview: re-pointing the window that is in EDIT asks first (unsaved edits), and the
		// same image asked for again keeps its Edit face — a raise, not a re-set
		const list = get(previewWindows);
		const newest = list[list.length - 1];
		if (newest?.mode === 'edit') {
			if (sameSource(spec, newest)) return void previewRaise.update((n) => n + 1);
			void confirmLeaveEditor('switch').then((ok) => ok && (imagePreviewTarget.set(spec), previewRaise.update((n) => n + 1)));
			return;
		}
		imagePreviewTarget.set(spec);
		// a docked Preview behind another dock tab comes forward with what was opened
		if (list.length) previewRaise.update((n) => n + 1);
		return;
	}
	const list = get(previewWindows);
	const already = list.find((w) => sameSource(spec, w));
	if (already) {
		previewRaise.update((n) => n + 1);
		// bring it to the end, which is what "the active one" means here
		previewWindows.set([...list.filter((w) => w.id !== already.id), already]);
		return;
	}
	previewWindows.set([...list, { ...spec, id: ++previewSeq }]);
}

/**
 * Bumped when an open preview is asked for again. The window listens and raises itself;
 * nothing about the preview changes. A COUNTER, not a flag — two consecutive raises are
 * two events (the modelPreviewRaise precedent, verbatim).
 * @type {import('svelte/store').Writable<number>}
 */
export const previewRaise = writable(0);

// N4: 3D model preview window (rotatable canvas + poly stats).
// 21-H2: `prefabId` is the SECOND source — a prefab is not an Explorer item, so it has
// no `itemId` to resolve to a blob. Exactly one of the two is set.
/** @type {import('svelte/store').Writable<{title: string, itemId?: string, prefabId?: string, name?: string, onClose?: () => void} | null>} */
export const modelPreviewTarget = writable(null);

/**
 * 21-I3 — A REPEAT OPEN IS A RAISE, NOT A RE-SET.
 *
 * Bumped whenever `openModelPreview` is asked for the source that is ALREADY open. The
 * window listens and brings itself forward; nothing about the preview itself changes.
 * A counter rather than a boolean, because two consecutive raises are two events and a
 * flag would collapse them (and would then need clearing, with an order to get wrong).
 * @type {import('svelte/store').Writable<number>}
 */
export const modelPreviewRaise = writable(0);

/**
 * Open the pop-out preview — or, when it is already showing this very source, RAISE it.
 *
 * THE PROBED FINDING (21-I3): the reported "preview hang" was not a wedge. Clicking
 * "3D preview" a second time re-set `modelPreviewTarget` to an equal target, so the
 * `{#key}` did not change, the canvas did not remount and NOTHING MOVED — and a window
 * sitting behind the Explorer or shoved off-screen is indistinguishable from a dead
 * button. Comparing the SOURCE (not object identity — every caller builds a fresh
 * literal) is what separates "open this" from "you already have this open".
 * @param {{title: string, itemId?: string, prefabId?: string, name?: string, onClose?: () => void}} target
 */
export function openModelPreview(target) {
	const current = get(modelPreviewTarget);
	const sameSource =
		!!current &&
		(target.itemId ?? '') === (current.itemId ?? '') &&
		(target.prefabId ?? '') === (current.prefabId ?? '');
	// keep the LIVE target (and its onClose, which belongs to whoever opened it) — the
	// incoming one differs only in the identity of the arrow it carries
	if (sameSource) modelPreviewRaise.update((n) => n + 1);
	else modelPreviewTarget.set(target);
}

/**
 * 21-H2 — THE DOUBLE-CLICK HANG. Opening the pop-out while the Properties pane's inline
 * preview is still running left two WebGL contexts rendering the same tree, and the
 * reported symptom was a hang. The inline preview stands down while a pop-out is open.
 *
 * This is RUNTIME state, and it is deliberately NOT a write to `enable3dPreview`. The
 * user asked for "disable preview in settings", but a runtime state written into a
 * STORED preference becomes stored state the next session inherits — a window still open
 * at reload would leave previews switched off with nothing left to connect that to. Same
 * reasoning as `lookOverride` beside the authored post document (scenePost).
 *
 * DERIVED rather than a flag two call sites raise and lower: the window is the only
 * thing that can be open, so it cannot drift out of step or leak if the window closes by
 * some other route. Consumed by the INLINE preview only — the pop-out must not suspend
 * itself.
 * @type {import('svelte/store').Readable<boolean>}
 */
export const previewSuspended = derived(
	[modelPreviewTarget, previewWindows],
	// R22 round 12: an OBJECT shown in the file preview window is the same situation the
	// pop-out was — two live WebGL contexts rendering one asset, which is the 21-H2 hang.
	// The reason it is a derived and not a flag two call sites raise is unchanged: the
	// windows are the only things that can be open, so it cannot drift or leak.
	([target, windows]) => !!target || windows.some((/** @type {any} */ w) => w.kind === 'object')
);


// ---- uir-preview: Pin to dock, and View | Edit -------------------------------------------------
//
// Owner 2026-11-09 ("Windows, chat and tools"): ONE Preview tab that follows the Explorer selection
// and docks, and the preview + image editor as ONE window with View | Edit. A window's face is its
// target's `mode` ('view' when absent — every pre-uir caller); 'edit' draws the image editor in the
// body. The editor is a singleton (`imageEditorTarget`), so ONE window at a time is in Edit.

/** the id of the window in Edit, or null @type {import('svelte/store').Readable<number|null>} */
export const previewEditWin = derived(previewWindows, (list) => list.find((w) => w.mode === 'edit')?.id ?? null);

/** Put one window in View or Edit; Edit leaves any other window's Edit (one editor).
 * @param {number} id @param {'view'|'edit'} mode */
export function setPreviewMode(id, mode) {
	previewWindows.update((list) =>
		list.map((w) => (w.id === id ? { ...w, mode } : mode === 'edit' && w.mode === 'edit' ? { ...w, mode: 'view' } : w))
	);
}

/** @param {any} w */
function revokeOf(w) {
	if (w?.url && String(w.url).startsWith('blob:')) URL.revokeObjectURL(w.url);
}

/**
 * Open the image editor on a library image — IN a preview window. Which one: the window already
 * showing this image, else the one already editing, else the first (the pinned one), else a new
 * window. A repeat ask for what is already open is a RAISE (21-I3). The image's bytes for the View
 * face resolve in the window (`url: ''`), because the editor reads its own.
 * @param {string} itemId @param {string} [name] @returns {number} the window's id
 */
export function openPreviewEditor(itemId, name = '') {
	const list = get(previewWindows);
	const win =
		list.find((w) => (w.kind ?? 'image') === 'image' && w.itemId === itemId) ??
		list.find((w) => w.mode === 'edit') ??
		list[0];
	// no name given (a bridged open): the title is left empty and the window reads the library name
	const spec = { title: name || '', kind: 'image', itemId, name: name || '', url: '', mode: 'edit' };
	if (!win) {
		const id = ++previewSeq;
		previewWindows.set([...list, { ...spec, id }]);
		return id;
	}
	const same = win.itemId === itemId && (win.kind ?? 'image') === 'image';
	if (!same) revokeOf(win);
	previewWindows.set(
		list.map((w) =>
			w.id === win.id
				? { ...spec, title: spec.title || (same ? win.title : ''), url: same ? win.url : '', onClose: win.onClose, id: win.id }
				: w.mode === 'edit'
					? { ...w, mode: 'view' }
					: w
		)
	);
	previewRaise.update((n) => n + 1);
	return win.id;
}

/**
 * Close one preview window, asking first when it holds unsaved edits. The ONE close path: the
 * header ✕, Esc in View, and the dock tab's ✕ all come here.
 * @param {number} id @returns {Promise<boolean>} closed
 */
export async function closePreviewGuarded(id) {
	const w = get(previewWindows).find((x) => x.id === id);
	if (!w) return true;
	if (w.mode === 'edit' && !(await confirmLeaveEditor('close'))) return false;
	w.onClose?.();
	revokeOf(w);
	closePreviewWindow(id);
	if (get(openPreviewCog) === id) openPreviewCog.set(null);
	return true;
}

/**
 * Open THE Preview tab (the dock "+" row, a layout restore): pinned, so it follows the Explorer
 * selection; an empty face until there is something to show.
 */
export function openPinnedPreview() {
	previewPinned.set(true);
	if (get(previewWindows).length) {
		previewRaise.update((n) => n + 1);
		return;
	}
	previewWindows.set([{ id: ++previewSeq, title: 'Preview', kind: 'empty', url: '' }]);
}

/** close the first window (the dock tab ✕) */
export function closePinnedPreview() {
	const first = get(previewWindows)[0];
	if (first) void closePreviewGuarded(first.id);
}

// THE BRIDGE between the editor's own store and the window that hosts it, both directions, so
// every existing writer of `imageEditorTarget` (openImageEditor, the dock's closer shape, suites)
// still works: setting it opens the image in a window's Edit face; clearing it (the editor's own
// close after its ask) returns that window to View; a window entering or leaving Edit, or walking
// to another image in Edit, writes it. `bridging` stops each half answering the other.
let bridging = false;
/** @param {() => void} fn */
const quietly = (fn) => {
	bridging = true;
	try {
		fn();
	} finally {
		bridging = false;
	}
};
if (typeof window !== 'undefined') {
	imageEditorTarget.subscribe((t) => {
		if (bridging) return;
		const editing = get(previewWindows).find((w) => w.mode === 'edit');
		if (!t) {
			if (editing) quietly(() => setPreviewMode(editing.id, 'view'));
			return;
		}
		if (editing && (editing.itemId ?? '') === (t.itemId ?? '')) {
			previewRaise.update((n) => n + 1);
			return;
		}
		quietly(() => {
			if (t.itemId) openPreviewEditor(t.itemId);
			else {
				// "open the editor with nothing in it" (the dock's closer shape): an empty Edit face
				const first = get(previewWindows)[0];
				if (first) setPreviewWindow(first.id, { ...first, mode: 'edit' });
				else previewWindows.set([{ id: ++previewSeq, title: 'Image editor', kind: 'image', itemId: '', url: '', mode: 'edit' }]);
			}
		});
	});
	previewWindows.subscribe((list) => {
		if (bridging) return;
		const editing = list.find((w) => w.mode === 'edit');
		const t = get(imageEditorTarget);
		if (!editing) {
			if (t) quietly(() => imageEditorTarget.set(null));
			return;
		}
		if (!t || (t.itemId ?? '') !== (editing.itemId ?? '')) {
			quietly(() => imageEditorTarget.set({ itemId: editing.itemId ?? '', raise: (t?.raise ?? 0) + 1 }));
		}
	});
}
