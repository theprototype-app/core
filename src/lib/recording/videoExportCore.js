// 65 M4 — THE EXPORT PLAN: which path writes the file the options ask for, on this browser, and what
// it will cost. PURE (imports only the other pure halves), so the matrix of formats × capabilities is
// pinned by a unit suite.
//
// Paths:
//   webcodecs     — frame-exact offline render, encoded by WebCodecs and muxed by Mediabunny (MP4/WebM)
//   mediarecorder — the 36-share live recorder (wall time) — the fallback where WebCodecs is missing
//   gif           — frame-exact, gifenc (palette per frame)
//   webp          — frame-exact, canvas WebP stills muxed into an animated WebP (webpAnim.js)
//   png           — frame-exact, canvas PNG stills in a .zip (alpha kept)
import { outputSize, bitrateFor, estimateBytes } from './recordingCore.js';
import { frameCount, GIF_MAX_FPS } from './frameClock.js';

/** `phone` / `hot` (68 V9): a phone renders a capped export; a hot (governor stepped down) one a smaller one
 * @typedef {{webcodecs: boolean, mediaRecorder: boolean, webpEncode: boolean, phone?: boolean, hot?: boolean}} ExportCaps */

/** 68 V9: the longest export a phone renders — a long render heats it, slows it and drains it */
export const PHONE_MAX_SECONDS = 20;
/** 68 V9: the long side a phone renders at most (a 4K render is minutes of a hot phone) */
export const PHONE_MAX_SIDE = 1920;
/** 68 V9: the long side while the device runs hot */
export const HOT_MAX_SIDE = 1280;

/**
 * A size scaled down (aspect kept, even dimensions) so its long side is at most `max`.
 * @param {{w: number, h: number}} size @param {number} max @returns {{w: number, h: number}}
 */
export function capSize(size, max) {
	const long = Math.max(size.w, size.h);
	if (!(long > max)) return size;
	const k = max / long;
	const even = (/** @type {number} */ n) => Math.max(2, Math.round((n * k) / 2) * 2);
	return { w: even(size.w), h: even(size.h) };
}

/** the labels the dialog shows, in its order */
export const FORMAT_INFO = Object.freeze({
	mp4: { label: 'MP4 video', ext: 'mp4', note: 'Plays everywhere: phones, chat apps, editors.' },
	webm: { label: 'WebM video', ext: 'webm', note: 'Smaller files; plays in browsers.' },
	gif: { label: 'GIF loop', ext: 'gif', note: 'Loops anywhere; 256 colours, large files. Keep it small and short.' },
	webp: { label: 'Animated WebP loop', ext: 'webp', note: 'A loop like a GIF with full colour, transparency and much smaller files.' },
	png: { label: 'PNG sequence (.zip)', ext: 'zip', note: 'One lossless PNG per frame, with transparency — for video editors.' }
});

/** formats whose frames may keep transparency */
export const ALPHA_FORMATS = Object.freeze(['webp', 'png']);

/** frames a GIF/WebP/PNG export holds at most (they are kept in memory until the file is written) */
export const STILLS_MAX_FRAMES = 1800;

/** canvas WebP quality per quality step */
export const STILL_QUALITY = Object.freeze({ low: 0.6, medium: 0.78, high: 0.9 });

/**
 * What this browser can do (the globals and the WebP probe are passed in, so the plan stays pure).
 * @param {any} g a window-like global @param {boolean} webpEncode a canvas really encoded image/webp
 * @returns {ExportCaps}
 */
export function probeCaps(g, webpEncode) {
	return {
		webcodecs: typeof g?.VideoEncoder === 'function' && typeof g?.VideoFrame === 'function',
		mediaRecorder: typeof g?.MediaRecorder === 'function',
		webpEncode: !!webpEncode
	};
}

/**
 * The plan for an export.
 * @param {import('./recordingCore.js').RecordingPrefs} prefs
 * @param {ExportCaps} caps
 * @param {{w: number, h: number}} canvas the drawing buffer (for the viewport size)
 * @param {{duration?: number} | null} [sequence] the timeline being exported (timeline mode)
 * @returns {{path: string, format: string, ext: string, fps: number, duration: number, frames: number,
 *   size: {w: number, h: number}, alpha: boolean, notes: string[], blocker: string}}
 */
export function exportPlan(prefs, caps, canvas, sequence) {
	const format = prefs.format;
	const info = /** @type {any} */ (FORMAT_INFO)[format] ?? FORMAT_INFO.mp4;
	/** @type {string[]} */
	const notes = [];
	let fps = prefs.fps;
	if (format === 'gif' && fps > GIF_MAX_FPS) {
		fps = GIF_MAX_FPS;
		notes.push(`GIF plays at most ${GIF_MAX_FPS} fps (browsers slow down faster GIFs), so this one is ${GIF_MAX_FPS} fps.`);
	}
	const duration = prefs.duration;
	let size = outputSize(prefs.resolution, canvas);
	// 68 V9: a phone renders a smaller, shorter export; a hot device a smaller one still
	const maxSide = caps.hot ? HOT_MAX_SIDE : caps.phone ? PHONE_MAX_SIDE : 0;
	if (maxSide) {
		const capped = capSize(size, maxSide);
		if (capped !== size) {
			notes.push(
				caps.hot
					? `The device is running hot, so this export is ${capped.w} × ${capped.h} instead of ${size.w} × ${size.h}.`
					: `On a phone an export is at most ${maxSide} px on its long side: this one is ${capped.w} × ${capped.h}.`
			);
			size = capped;
		}
	}
	const frames = frameCount(duration, fps);
	const alpha = prefs.transparent && ALPHA_FORMATS.includes(format);
	let path = format;
	let blocker = '';
	let ext = info.ext;
	if (format === 'mp4' || format === 'webm') {
		if (caps.webcodecs) path = 'webcodecs';
		else if (caps.mediaRecorder) {
			path = 'mediarecorder';
			ext = 'webm';
			notes.push('This browser has no WebCodecs: the video is recorded live as WebM instead (not frame-exact — keep the tab in front).');
			if (prefs.mode === 'timeline') notes.push('The timeline plays in real time while it records.');
		} else blocker = 'This browser cannot write video (no WebCodecs, no MediaRecorder).';
	}
	if (caps.phone && duration > PHONE_MAX_SECONDS + 1e-6)
		blocker = `On a phone an export is at most ${PHONE_MAX_SECONDS} s (this one is ${Math.round(duration * 10) / 10} s): a long render heats the phone and slows it down. Shorten it, or export it on a computer.`;
	else if (caps.phone && !blocker) notes.push('Keep the phone plugged in and the app in front: the screen shows the render while it runs.');
	if (format === 'webp' && !caps.webpEncode) blocker = 'This browser cannot encode WebP images (try Chrome, Edge or Firefox, or pick GIF).';
	if ((format === 'gif' || format === 'webp' || format === 'png') && frames > STILLS_MAX_FRAMES)
		blocker = `At most ${STILLS_MAX_FRAMES} frames for a ${info.label} (this is ${frames}): shorten it or lower the frame rate.`;
	if (prefs.transparent && !ALPHA_FORMATS.includes(format)) notes.push(`${info.label} has no transparency: the background is drawn.`);
	if (format === 'gif' && size.w * size.h > 1280 * 720) notes.push('A large GIF is slow to write and heavy to load: Small (854 × 480) is the usual size.');
	if (prefs.mode === 'timeline' && sequence && duration > (Number(sequence.duration) || 0) + 1e-6)
		notes.push('The take is longer than the timeline: it holds its last moment (or loops, if the timeline loops).');
	return { path, format, ext, fps, duration, frames, size, alpha, notes, blocker };
}

/**
 * About how big the file will be, bytes — a ballpark for the dialog, labelled "about".
 * @param {{path: string, format: string, fps: number, duration: number, frames: number, size: {w: number, h: number}}} plan
 * @param {string} quality
 */
export function estimateExportBytes(plan, quality) {
	const px = plan.size.w * plan.size.h;
	const q = /** @type {any} */ ({ low: 0.7, medium: 1, high: 1.5 })[quality] ?? 1;
	switch (plan.format) {
		case 'gif':
			return Math.round(px * plan.frames * 0.45);
		case 'webp':
			// a rendered scene's smooth shading compresses far better than a photo: measured 0.007 B/px
			// for two primitives on a plain sky; textured scenes run several times that
			return Math.round(px * plan.frames * 0.035 * q);
		case 'png':
			return Math.round(px * plan.frames * 1.6);
		default:
			return estimateBytes(bitrateFor(plan.size, plan.fps, quality), plan.duration);
	}
}

/**
 * Codecs to try, best first, for a container.
 * @param {string} format mp4 | webm @returns {('avc'|'hevc'|'vp9'|'vp8'|'av1')[]}
 */
export function codecCandidates(format) {
	return format === 'webm' ? ['vp9', 'vp8', 'av1'] : ['avc', 'vp9', 'av1', 'hevc'];
}

/** @param {number} bytes */
export function formatBytes(bytes) {
	if (!(bytes > 0)) return '0 KB';
	if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
	if (bytes < 1024 * 1024 * 1024) return (bytes / 1048576).toFixed(1) + ' MB';
	return (bytes / 1073741824).toFixed(2) + ' GB';
}
