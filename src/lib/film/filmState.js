// 68 V1 — Film mode's LEAF store: is Film open, and on which camera. Everything else of
// Film (the runtime, the sensors, the recorder, the overlay) is a lazy chunk App.svelte
// imports only while this is set, so the boot carries this file and nothing more.
import { writable } from 'svelte/store';

/** null = closed; `{uuid: null}` = open on the camera picker
 * @type {import('svelte/store').Writable<{uuid: string|null} | null>} */
export const filmOpen = writable(null);

/**
 * The group the preview camera hangs in (CameraPreview mounts it). Identity, except during Film's AR
 * walk, which poses it so the XR runtime — it draws the views under the camera's PARENT — renders
 * the room pose mapped into the scene: T(anchor) · Ry(δ) · S(scale) · T(-roomStart).
 * @type {import('svelte/store').Writable<any>}
 */
export const filmCameraMount = writable(null);

/** Open Film mode — on a scene camera, or on the picker (New camera / pick one). @param {string|null} [uuid] */
export function openFilm(uuid = null) {
	filmOpen.set({ uuid: uuid ?? null });
}

export function closeFilm() {
	filmOpen.set(null);
}
