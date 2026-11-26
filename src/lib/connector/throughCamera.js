// 104 B2 (lane 104-world) — WHICH CAMERA THE PERSON LOOKS THROUGH (or records from), for where_are_users and
// screenshot {view: "current"}. Every way of looking through a scene camera ends in ONE store, cameraPreview
// (the Preview button, a game's Look Through Camera / Game Camera node, a sequence shot, Film mode), and
// while it is set that camera IS the render camera (CameraPreview.svelte makes it threlte's default), so the
// pose where_are_users reads is already the camera's. What was missing is the NAME of the source, which only
// the source knows: this reads the leaf flags each one leaves (none of them is imported here but the sequence
// player, which the app's own graph already holds).
//
//   recording  the viewport recorder is taking a video, or a Film take is recording
//   phone      Film mode (the phone virtual camera, roadmap 68)
//   sequence   a running sequence is showing one of its shots
//   play       Play mode looks through it (a Look Through Camera / Game Camera node)
//   preview    the person pressed Preview on a camera
import { get } from 'svelte/store';
import { cameraPreview } from '$lib/cameraPreview';
import { isLocked } from '../../stores/sceneStore.js';
import { filmOpen, filmRecording } from '$lib/film/filmState.js';
import { recordingState } from '$lib/recording/recordingStores.js';
import { sequenceCamera } from '$lib/sequencePlayer';

import { throughKind, THROUGH_KINDS } from './throughCameraCore.js';
export { throughKind, THROUGH_KINDS };

/**
 * The camera this tab shows full-screen right now, or null (the person's own editor or play view).
 * @param {(uuid: string) => any} [find] the camera object by uuid (its name)
 * @returns {{uuid: string | null, name: string, kind: import('./throughCameraCore.js').ThroughKind, note?: string} | null}
 */
export function lookingThrough(find) {
	const preview = /** @type {any} */ (get(cameraPreview))?.uuid ?? null;
	const rec = /** @type {any} */ (get(recordingState))?.status;
	const kind = throughKind({
		preview,
		film: /** @type {any} */ (get(filmOpen))?.uuid ?? null,
		filmRecording: get(filmRecording),
		recorder: rec === 'preparing' || rec === 'recording',
		sequence: sequenceCamera()?.uuid ?? null,
		playing: get(isLocked) === true
	});
	if (!kind) return null;
	if (!preview) return { uuid: null, name: '', kind, note: 'the viewport recorder is filming the editor view (turntable or flythrough): the pose is its camera, moving' };
	const object = find?.(preview);
	return { uuid: preview, name: String(object?.name ?? ''), kind };
}
