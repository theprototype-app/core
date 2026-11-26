// 104 B2 — the PURE half of throughCamera.js (imports nothing): which kind of looking-through the facts say.
export const THROUGH_KINDS = /** @type {const} */ (['preview', 'play', 'sequence', 'phone', 'recording']);
/** @typedef {(typeof THROUGH_KINDS)[number]} ThroughKind */

/**
 * Pure: the kind from the facts each source leaves.
 * @param {{preview: string | null, film: string | null, filmRecording: boolean, recorder: boolean, sequence: string | null, playing: boolean}} f
 * @returns {ThroughKind | null}
 */
export function throughKind(f) {
	if (f.recorder) return 'recording';
	if (!f.preview) return null;
	if (f.film && f.film === f.preview) return f.filmRecording ? 'recording' : 'phone';
	if (f.sequence && f.sequence === f.preview) return 'sequence';
	if (f.playing) return 'play';
	return 'preview';
}

