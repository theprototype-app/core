// 102b-sound (row 2) — THE FRAME-EXACT EXPORT'S SOUND, the pure half: where each sound of a take lands on
// the FILE's clock. Numbers in, numbers out, so a unit suite pins it.
//
// A frame-exact export (offlineRender.js) is not real time — a 4K frame can take a second to draw — so
// the sound cannot be listened to while it renders. It is rendered OFFLINE instead, to the same
// timeline the frames follow:
//   - the timeline's audio clips (a timeline take): file time f shows timeline time start + f (looping
//     or holding at the end, exactly as frameClock.timelineTime poses the frames), or, for Film's chosen
//     shots, the ranges back to back (frameClock.rangeTime)
//   - the scene's music track, when it is playing here: from the point of the loop you hear when the
//     export starts, looped for the length of the file
// Sounds that a flow or a module plays on its own clock are not in a frame-exact file (the world motion
// that runs on its own clock is not frame-exact either, the export's own rule); the live recorder and
// moments carry those.

/**
 * @typedef {{sound: string, gain: number, at: number, offset: number, dur: number}} PlacedSound
 *   `at` seconds into the file, `offset` seconds into the sound, `dur` seconds played
 * @typedef {{at: number, len: number, tl: number}} Segment  file [at, at+len) shows timeline [tl, tl+len)
 */

/**
 * The stretches of the file and the timeline time each one shows.
 * @param {{duration?: number, start?: number, loop?: boolean}} seq @param {number} seconds the file's length
 * @param {number[][] | null} [ranges] Film's chosen shots, filmed back to back
 * @returns {Segment[]}
 */
export function timelineSegments(seq, seconds, ranges) {
	/** @type {Segment[]} */
	const out = [];
	if (!(seconds > 0)) return out;
	if (ranges && ranges.length) {
		let at = 0;
		for (const [a, b] of ranges) {
			const len = Math.min(Math.max(0, b - a), seconds - at);
			if (len > 0) out.push({ at, len, tl: a });
			at += Math.max(0, b - a);
			if (at >= seconds) break;
		}
		return out;
	}
	const dur = Math.max(0, Number(seq.duration) || 0);
	if (!(dur > 0)) return out;
	const start = Number(seq.start) || 0;
	if (!seq.loop) {
		const tl = Math.min(dur, Math.max(0, start));
		const len = Math.min(seconds, dur - tl);
		if (len > 0) out.push({ at: 0, len, tl });
		return out; // past the end the frames hold the last moment: no sound
	}
	let at = 0;
	let tl = ((start % dur) + dur) % dur;
	// a guard on the count: a very short loop over a long file is still a bounded list
	for (let n = 0; at < seconds - 1e-9 && n < 10000; n++) {
		const len = Math.min(dur - tl, seconds - at);
		out.push({ at, len, tl });
		at += len;
		tl = 0;
	}
	return out;
}

/**
 * Every audio clip of a timeline placed on the file's clock (unmuted audio tracks, items with a sound).
 * A clip plays from its start for its window, cut at the window's end — the live player's rule.
 * @param {{tracks?: any[], duration?: number, start?: number, loop?: boolean}} seq @param {number} seconds
 * @param {number[][] | null} [ranges] @returns {PlacedSound[]}
 */
export function planTimelineAudio(seq, seconds, ranges) {
	/** @type {PlacedSound[]} */
	const out = [];
	const items = [];
	for (const track of seq?.tracks ?? []) {
		if (track?.kind !== 'audio' || track.muted) continue;
		for (const item of track.items ?? []) if (item?.sound && Number(item.dur) > 0) items.push(item);
	}
	if (!items.length) return out;
	for (const seg of timelineSegments(seq, seconds, ranges)) {
		const end = seg.tl + seg.len;
		for (const item of items) {
			const a = Math.max(item.t, seg.tl);
			const b = Math.min(item.t + item.dur, end);
			if (b - a <= 1e-6) continue;
			out.push({ sound: item.sound, gain: Number.isFinite(Number(item.gain)) ? Number(item.gain) : 1, at: seg.at + (a - seg.tl), offset: a - item.t, dur: b - a });
		}
	}
	return out.sort((x, y) => x.at - y.at);
}

/**
 * The scene music under a take: one looping bed from the phase heard when the export starts.
 * @param {{hash?: string | null, playing?: boolean, startedAt?: number}} music the shared music state
 * @param {number} gain what this listener hears it at (shared volume x local volume x music bus), 0 = none
 * @param {number} nowMs the session clock now @param {number} bufferSeconds the track's length
 * @returns {{sound: string, gain: number, offset: number} | null}
 */
export function planMusicBed(music, gain, nowMs, bufferSeconds) {
	if (!music?.hash || !music.playing || !(gain > 0) || !(bufferSeconds > 0)) return null;
	const phase = (((nowMs - (music.startedAt || nowMs)) / 1000) % bufferSeconds + bufferSeconds) % bufferSeconds;
	return { sound: music.hash, gain, offset: phase };
}
