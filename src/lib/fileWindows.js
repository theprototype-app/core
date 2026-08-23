import { derived, get, writable } from 'svelte/store';

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
export const previewSuspended = derived(modelPreviewTarget, (target) => !!target);
