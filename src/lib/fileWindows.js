import { derived, writable } from 'svelte/store';

// Floating file windows (107): one shared professional code editor window
// (Explorer text files AND the custom-node definition editor route here) and
// a zoomable image preview window.

/** @type {import('svelte/store').Writable<{title: string, code: string, onSave: (code: string) => void, onClose?: () => void} | null>} */
export const textEditorTarget = writable(null);

/** @param {{title: string, code: string, onSave: (code: string) => void, onClose?: () => void}} target */
export function openTextEditor(target) {
	textEditorTarget.set(target);
}

/** @type {import('svelte/store').Writable<{title: string, url: string, onClose?: () => void} | null>} */
export const imagePreviewTarget = writable(null);

/** @param {{title: string, url: string, onClose?: () => void}} target */
export function openImagePreview(target) {
	imagePreviewTarget.set(target);
}

// N4: 3D model preview window (rotatable canvas + poly stats).
// 21-H2: `prefabId` is the SECOND source — a prefab is not an Explorer item, so it has
// no `itemId` to resolve to a blob. Exactly one of the two is set.
/** @type {import('svelte/store').Writable<{title: string, itemId?: string, prefabId?: string, name?: string, onClose?: () => void} | null>} */
export const modelPreviewTarget = writable(null);

/** @param {{title: string, itemId?: string, prefabId?: string, name?: string, onClose?: () => void}} target */
export function openModelPreview(target) {
	modelPreviewTarget.set(target);
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
export const previewSuspended = derived(modelPreviewTarget, (target) => !!target);
