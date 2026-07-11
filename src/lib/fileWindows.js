import { writable } from 'svelte/store';

// Floating file windows (107): one shared professional code editor window
// (Explorer text files AND the custom-node definition editor route here) and
// a zoomable image preview window.

/** @type {import('svelte/store').Writable<{title: string, code: string, onSave: (code: string) => void} | null>} */
export const textEditorTarget = writable(null);

/** @param {{title: string, code: string, onSave: (code: string) => void}} target */
export function openTextEditor(target) {
	textEditorTarget.set(target);
}

/** @type {import('svelte/store').Writable<{title: string, url: string} | null>} */
export const imagePreviewTarget = writable(null);

/** @param {{title: string, url: string}} target */
export function openImagePreview(target) {
	imagePreviewTarget.set(target);
}
