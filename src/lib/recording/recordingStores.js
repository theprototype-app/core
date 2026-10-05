// 36-share (B13) — the recorder's state and its remembered options. A LEAF (svelte/store +
// safeStorage + the pure core), so App.svelte can gate the lazy dialog on it and the viewport
// menu can open it without pulling the recorder (and its THREE/Explorer imports) into the boot
// graph.
import { writable, get } from 'svelte/store';
import { safeStorage } from '../safeStorage';
import { coerceRecordingPrefs } from './recordingCore.js';

/** the Recording dialog is open @type {import('svelte/store').Writable<boolean>} */
export const recordingOpen = writable(false);

/**
 * What the recorder is doing. `status`: idle | preparing | recording | finishing | done | error.
 * `progress` 0..1 of the requested length, `elapsed`/`duration` in seconds, `result` the finished
 * file (done), `error` a sentence for the person (error).
 * @typedef {{status: 'idle'|'preparing'|'recording'|'finishing'|'done'|'error', progress: number,
 *   elapsed: number, duration: number, frames: number, error: string, result: RecordingResult | null}} RecordingState
 * @typedef {{name: string, url: string, blob: Blob, bytes: number, durationMs: number, width: number,
 *   height: number, fps: number, mime: string, itemId: string | null, savedNote: string}} RecordingResult
 */

/** @type {RecordingState} */
export const IDLE_RECORDING = Object.freeze({ status: 'idle', progress: 0, elapsed: 0, duration: 0, frames: 0, error: '', result: null });

/** @type {import('svelte/store').Writable<RecordingState>} */
export const recordingState = writable({ ...IDLE_RECORDING });

const PREFS_KEY = 'recording:prefs';

function readPrefs() {
	try {
		return coerceRecordingPrefs(JSON.parse(safeStorage.getItem(PREFS_KEY) || 'null'));
	} catch {
		return coerceRecordingPrefs(null);
	}
}

/** the dialog's options, persisted per device @type {import('svelte/store').Writable<import('./recordingCore.js').RecordingPrefs>} */
export const recordingPrefs = writable(readPrefs());

/** @param {Partial<import('./recordingCore.js').RecordingPrefs>} patch */
export function setRecordingPrefs(patch) {
	const next = coerceRecordingPrefs({ ...get(recordingPrefs), ...patch });
	recordingPrefs.set(next);
	safeStorage.setItem(PREFS_KEY, JSON.stringify(next));
}

/** open the dialog (Tools ▸ Recording…) */
export function openRecording() {
	recordingOpen.set(true);
}
