// 65 M4 — FRAME SCHEDULING for the offline (frame-exact) export. PURE: numbers in, numbers out.
//
// The 36-share recorder ran on WALL time (the camera is where it should be at now - t0), which is
// right for a live capture and wrong for a file whose frame count must be exact. The offline render
// runs on FRAME time instead: frame i shows the moment i / fps, whatever the wall clock did while it
// was being drawn, so a 4K frame that took 300 ms to render still lands on its own instant and the
// file has exactly round(duration × fps) frames.
//
// Container clocks are integers, so each one gets its own rounding rule here, all CUMULATIVE —
// frame i lasts round((i + 1) · unit) − round(i · unit), never round(unit) — so the per-frame
// durations add up to the exact length instead of drifting by the rounding error times the count.

/** @param {number} duration seconds @param {number} fps @returns {number} the number of frames a take has */
export function frameCount(duration, fps) {
	if (!(duration > 0) || !(fps > 0)) return 0;
	return Math.max(1, Math.round(duration * fps));
}

/** the moment frame i shows, seconds from the start @param {number} i @param {number} fps */
export function frameTime(i, fps) {
	return i / fps;
}

/**
 * Where frame i sits along a camera path, 0..1. A LOOP (a whole-turn turntable) never draws its
 * last instant — it is the first frame again, and a GIF that shows it twice stutters at the seam —
 * so it runs i / n; an open path (a flythrough) must arrive, so it runs i / (n − 1).
 * @param {number} i @param {number} n @param {boolean} loop
 */
export function pathT(i, n, loop) {
	if (n <= 1) return 0;
	return Math.min(1, Math.max(0, loop ? i / n : i / (n - 1)));
}

/**
 * The timeline time frame i shows (seconds into the sequence): from `start`, looping inside the
 * sequence when it loops, else held on its last moment.
 * @param {number} i @param {number} fps @param {{start?: number, duration: number, loop?: boolean}} seq
 */
export function timelineTime(i, fps, seq) {
	const dur = Math.max(0, Number(seq.duration) || 0);
	const t = (Number(seq.start) || 0) + i / fps;
	if (!(dur > 0)) return 0;
	if (seq.loop) return ((t % dur) + dur) % dur;
	return Math.min(dur, Math.max(0, t));
}

/**
 * Integer per-frame durations in `unitsPerSecond` (100 = GIF centiseconds, 1000 = WebP ms,
 * 1e6 = WebCodecs µs), cumulative so they add up to round(n × unitsPerSecond / fps) exactly.
 * @param {number} n @param {number} fps @param {number} unitsPerSecond @returns {number[]}
 */
export function frameDurations(n, fps, unitsPerSecond) {
	const out = new Array(Math.max(0, n));
	const per = unitsPerSecond / fps;
	for (let i = 0; i < n; i++) out[i] = Math.round((i + 1) * per) - Math.round(i * per);
	return out;
}

/** frame i's start in `unitsPerSecond`, the same rounding as frameDurations @param {number} i @param {number} fps @param {number} unitsPerSecond */
export function frameStamp(i, fps, unitsPerSecond) {
	return Math.round((i * unitsPerSecond) / fps);
}

/**
 * Browsers clamp a GIF frame delay under 2 centiseconds up to 10 (a 60 fps GIF plays at 10 fps),
 * so a GIF runs at most 50 fps: this is the highest rate whose every cumulative delay is ≥ 2 cs.
 */
export const GIF_MAX_FPS = 50;

/**
 * Backpressure for the render loop: may frame i be captured now? The sink reports how many frames
 * it still holds; past `limit` the loop keeps the frame posed (and re-renders it) until there is
 * room, which is what keeps memory flat however slow the encoder is.
 * @param {number} pending @param {number} [limit]
 */
export function sinkHasRoom(pending, limit = 4) {
	return pending < limit;
}
