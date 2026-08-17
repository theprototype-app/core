// The size ceilings for geometry work, in ONE place.
//
// They used to be a single number — 45000 floats (~5k triangles) — copied into
// faceEdit, uvEditor, meshTopology and commandsHandler, and every one of them
// refused with "that edit is too large to sync". The number was chosen when a big
// plain-number array could blow binarypack's call stack; raw bytes fixed that, and
// nobody re-measured afterwards.
//
// MEASURED 2026-08-17, two real peers over the self-hosted signaling box, sending
// exactly what `broadcastMeshGeo` sends:
//
//   floats     verts       arrived   time
//   45 000     15 000      yes       0.8 s
//   360 000    120 000     yes       1.0 s
//   1 500 000  500 000     yes       1.7 s
//   3 000 000  1 000 000   yes       4.9 s   (12 MB of raw bytes)
//
// So the WIRE was never the limit — peerjs chunks binary internally and a 12 MB
// snapshot arrives intact. What large geometry actually costs is:
//
//  1. LIVE PREVIEW bandwidth. A gesture streams a preview ~5×/s; at 12 MB that is
//     60 MB/s and the session stops being interactive for everyone. This is the
//     limit that genuinely has to stay small — hence a SEPARATE, low ceiling for
//     previews. Above it the gesture still previews LOCALLY and still commits and
//     replicates at the end; peers simply see the result instead of the rehearsal.
//  2. UNDO MEMORY. A meshgeo entry holds a before AND an after array, so one 500k
//     vertex edit is ~12 MB of history. Fifty of those is a browser tab dying, which
//     is what `HISTORY_BYTES` bounds.
//  3. Commit latency, which is seconds at the top of the range — acceptable once,
//     not per frame. That is the same trade as (1).
//
// Imports NOTHING, deliberately: every consumer (faceEdit, uvEditor, meshTopology,
// commandsHandler, history) sits in a different corner of the import graph, and a
// leaf can be reached from all of them without closing a cycle.

/**
 * Ceiling for a COMMITTED geometry snapshot, in floats (3 per vertex).
 * 1.5M floats = 500k vertices ≈ 166k triangles — a dense imported GLB.
 *
 * R4 (2026-08-17) measured the LOCAL cost the wire table above does not cover,
 * on the same headless page:
 *
 *   vertices   commit    undo     redo
 *   50 000     8.9 ms    8.5 ms   7.3 ms
 *   150 000    42 ms     26 ms    22 ms
 *   500 000    66 ms     67 ms    83 ms
 *
 * At the ceiling that is a visible hitch — and it is a ONE-SHOT: a commit happens
 * when a gesture ENDS, never per frame (the per-frame costs are what
 * MAX_LIVE_PREVIEW and faceEdit's VR_FACE_CAP bound, and those were measured too).
 * ~80 ms once is worth being able to edit the model at all, so the ceiling stands.
 */
export const MAX_SNAPSHOT = 1_500_000;

/** Ceiling for a snapshot that is streamed as a LIVE PREVIEW during a gesture,
 * in floats. Deliberately the old MAX_SNAPSHOT: a mesh that used to be uneditable
 * is now editable, and what it gives up is only the rehearsal, not the result. */
export const MAX_LIVE_PREVIEW = 45_000;

/** Corner budget for the stored face partition — indices, not coordinates, so it
 * is counted separately. Scaled with MAX_SNAPSHOT (a snapshot at the ceiling has
 * ~500k corners; the headroom covers n-gon partitions). */
export const MAX_FACE_TRIS = 1_500_000;

/**
 * Total bytes of geometry snapshots the undo stack may hold. Beyond it the OLDEST
 * geometry entry is dropped — losing the far end of the history, never the recent
 * steps a user is actually reaching for.
 *
 * R5 (2026-08-17) VALIDATED the number instead of leaving it a guess. A snapshot
 * at the commit ceiling measures **11.4 MB** as a history entry (before AND after,
 * 1.5M floats each), and a deliberately heavy probe session — three ceiling-sized
 * commits plus five sealed mesh sessions — held 11 entries totalling 16 MB, i.e.
 * 6% of the budget. So 256 MB buys about 22 edits at the very top of the range and
 * effectively unlimited ordinary ones, which is the right shape: the cap exists to
 * stop a pathological session eating the tab, not to ration normal work.
 */
export const HISTORY_BYTES = 256 * 1024 * 1024;

/** Is this snapshot too large to COMMIT at all? @param {number} floats */
export function overSnapshotBudget(floats) {
	return floats > MAX_SNAPSHOT;
}

/** May a gesture of this size stream previews to peers? @param {number} floats */
export function previewReplicable(floats) {
	return floats <= MAX_LIVE_PREVIEW;
}

/** The message every refusal shows, so the ceiling is stated once — and stated as
 * a NUMBER, because "too large" with no figure leaves the user guessing whether
 * they are near it or nowhere close.
 * @param {number} floats @param {string} [noun] what was refused ('edit', 'bevel', …) */
export function tooLargeMessage(floats, noun = 'edit') {
	const verts = Math.round(floats / 3).toLocaleString();
	const max = Math.round(MAX_SNAPSHOT / 3).toLocaleString();
	return `That ${noun} is too large to sync — ${verts} vertices, and the limit is ${max}`;
}

/** Rough byte cost of one history entry's geometry payload — what `HISTORY_BYTES`
 * counts. Arrays are float64 in JS but travel/store as float32, so 4 bytes per
 * element is the honest wire-shaped figure; anything unrecognised counts as 0
 * (a transform or a selection entry is noise next to a geometry one).
 * @param {any} entry */
export function entryBytes(entry) {
	if (!entry) return 0;
	let total = 0;
	for (const side of [entry.before, entry.after]) total += stateBytes(side);
	// an aibatch/composite holds its own children
	if (Array.isArray(entry.entries)) for (const child of entry.entries) total += entryBytes(child);
	return total;
}

/** @param {any} state */
function stateBytes(state) {
	if (!state) return 0;
	if (Array.isArray(state)) return state.length * 4; // a bare positions array
	if (typeof state !== 'object') return 0;
	let total = 0;
	for (const key of ['positions', 'uvs', 'faceTris', 'faceCounts']) {
		const value = state[key];
		if (Array.isArray(value)) total += value.length * 4;
		else if (value?.byteLength) total += value.byteLength;
	}
	if (Array.isArray(state.faces))
		for (const face of state.faces) total += (face?.length ?? 0) * 4;
	return total;
}
