// 95 SM1 — THE MOMENT BUFFER'S PURE HALF: the rolling buffer of the last seconds of Play, the
// rules for when it may run at all, the trim and the resample that turns irregular captures into
// a file of the right length. Numbers in, numbers out (the frames are opaque payloads), so a unit
// suite pins it with a fake clock.
//
// What a frame is: one picture of the GAME VIEW (the canvas only — no editor UI, no chat, never
// anybody's voice or microphone), captured at a capped rate and size and kept COMPRESSED (a JPEG
// blob, about 30-60 KB at 640 px), so ten seconds cost a few MB rather than the ~140 MB the raw
// pixels would. The browser half (momentBuffer.js) does the capturing; this half decides which
// frames to keep and which to hand to the encoder.
import { capSize } from '../recording/videoExportCore.js';

/** how much Play the buffer keeps, seconds */
export const MOMENT_SECONDS = 10;
/** captures per second at most (a 60 Hz game is sampled, not copied) */
export const MOMENT_FPS = 15;
/** the long side of a kept frame, px (a phone keeps a smaller one) */
export const MOMENT_MAX_SIDE = 640;
export const MOMENT_PHONE_MAX_SIDE = 480;
/** the most the buffer may hold, bytes (the oldest frames go first past it) */
export const MOMENT_MAX_BYTES = 24 * 1024 * 1024;
/** the shortest and longest moment a person can trim to, seconds */
export const MOMENT_MIN_TRIM = 3;
export const MOMENT_MAX_TRIM = 10;
/** SM3: the frame-cost GUARD — past this mean main-thread cost per frame (ms, over FRAME_COST_WINDOW
 * frames) the buffer turns itself off for the visit. The TARGET is ≤ 1 ms on a desktop; a phone gets
 * the same line (its frame is ~16 ms too), a desktop a looser guard so a busy moment does not trip it. */
export const MOMENT_PHONE_GUARD_MS = 1;
export const MOMENT_DESKTOP_GUARD_MS = 2.5;
export const FRAME_COST_WINDOW = 120;
/** JPEG quality of a kept frame */
export const MOMENT_JPEG_QUALITY = 0.82;
/** a device reporting less memory than this (GB, navigator.deviceMemory) keeps no buffer */
export const MOMENT_MIN_DEVICE_GB = 4;

/**
 * @template T
 * @typedef {{t: number, bytes: number, data: T}} MomentFrame  `t` seconds on the caller's clock
 */

/**
 * The rolling buffer. `due(t)` says whether a capture is wanted now (the rate cap; a frame the app
 * did not render is the caller's business); `push` keeps a frame and evicts what fell out of the
 * window or over the byte cap, oldest first, through `onEvict` (so a blob URL or bitmap can be
 * released). Frames must arrive in time order; one older than the newest is dropped.
 * @template T
 * @param {{seconds?: number, fps?: number, maxBytes?: number, onEvict?: (f: MomentFrame<T>) => void}} [o]
 */
export function createMomentRing(o = {}) {
	const seconds = o.seconds ?? MOMENT_SECONDS;
	const fps = o.fps ?? MOMENT_FPS;
	const maxBytes = o.maxBytes ?? MOMENT_MAX_BYTES;
	const onEvict = o.onEvict;
	/** @type {MomentFrame<T>[]} */
	let frames = [];
	let bytes = 0;
	/** when the last capture was ASKED for (a capture in flight counts, or slow encodes double up) */
	let lastDue = -Infinity;
	// 8 % slack: a 60 Hz display sampled at 15 fps takes every 4th frame, not every 5th on jitter
	const gap = (1 / fps) * 0.92;

	/** @param {number} cutoff */
	function evictBefore(cutoff) {
		while (frames.length && (frames[0].t < cutoff || bytes > maxBytes)) {
			const f = /** @type {MomentFrame<T>} */ (frames.shift());
			bytes -= f.bytes;
			onEvict?.(f);
		}
	}
	return {
		seconds,
		fps,
		/** is a capture wanted at `t`? Marks it asked when it is. @param {number} t */
		due(t) {
			if (t - lastDue < gap) return false;
			lastDue = t;
			return true;
		},
		/** keep a frame @param {MomentFrame<T>} f @returns {boolean} kept */
		push(f) {
			const last = frames[frames.length - 1];
			if (!(Number.isFinite(f.t) && f.bytes >= 0) || (last && f.t < last.t)) {
				onEvict?.(f);
				return false;
			}
			frames.push(f);
			bytes += f.bytes;
			evictBefore(f.t - seconds);
			return true;
		},
		/** drop frames older than the window as of `t` (a quiet stretch still ages the buffer) @param {number} t */
		age(t) {
			evictBefore(t - seconds);
		},
		/** a copy of the kept frames, oldest first */
		frames() {
			return frames.slice();
		},
		/** seconds between the first and the last kept frame */
		span() {
			return frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
		},
		bytes: () => bytes,
		count: () => frames.length,
		/** forget everything (Play ended, the setting went off) */
		clear() {
			const old = frames;
			frames = [];
			bytes = 0;
			lastDue = -Infinity;
			for (const f of old) onEvict?.(f);
		},
		/** hand the frames over and forget them WITHOUT evicting (the preview owns them now) */
		take() {
			const out = frames;
			frames = [];
			bytes = 0;
			lastDue = -Infinity;
			return out;
		}
	};
}

/**
 * Why the buffer may not run right now, or '' when it may. The ORDER is the answer a person
 * sees first, so the most permanent reason leads.
 * @param {{playing: boolean, vr: boolean, player: boolean, sceneAllows: boolean, setting: boolean,
 *   lowMemory: boolean, slow?: boolean, capture?: boolean}} s
 *   `player` = a published game's player (an embed, an export, the /play page); `capture` = the
 *   browser can copy the canvas at all; `slow` = the frame-cost guard tripped on this device
 * @returns {string}
 */
export function momentBlocker(s) {
	if (s.player && !s.sceneAllows) return 'player';
	if (!s.setting) return 'setting';
	if (s.capture === false) return 'browser';
	if (s.lowMemory) return 'memory';
	if (s.slow) return 'slow';
	if (s.vr) return 'vr';
	if (!s.playing) return 'idle';
	return '';
}

/** the sentence for a blocker (the setting row and the button's tooltip) @param {string} reason */
export function momentBlockerText(reason) {
	switch (reason) {
		case 'player':
			return 'This game does not record moments.';
		case 'setting':
			return 'Recording the last 10 s is off (Settings ▸ Privacy).';
		case 'browser':
			return 'This browser cannot copy the game view.';
		case 'memory':
			return 'Off on this device: it has too little memory to keep the last 10 s.';
		case 'slow':
			return 'Off on this device: keeping the last 10 s slowed the game down.';
		case 'vr':
			return 'Not in VR: the headset owns the view.';
		case 'idle':
			return 'Records only while you play.';
		default:
			return '';
	}
}

/** does this device report too little memory for the buffer? @param {any} nav a navigator-like */
export function isLowMemory(nav) {
	const gb = Number(nav?.deviceMemory);
	return Number.isFinite(gb) && gb > 0 && gb < MOMENT_MIN_DEVICE_GB;
}

/**
 * The size a kept frame is drawn at: the drawing buffer's aspect, the long side capped, even
 * dimensions (the video encoders want them).
 * @param {number} w @param {number} h @param {boolean} [phone]
 * @returns {{w: number, h: number}}
 */
export function momentFrameSize(w, h, phone = false) {
	const even = (/** @type {number} */ n) => Math.max(2, Math.round(n / 2) * 2);
	const size = { w: even(w > 0 ? w : 1280), h: even(h > 0 ? h : 720) };
	return capSize(size, phone ? MOMENT_PHONE_MAX_SIDE : MOMENT_MAX_SIDE);
}

/**
 * A trim, clamped: inside [0, total], at most MOMENT_MAX_TRIM long and at least MOMENT_MIN_TRIM
 * (or all of it, when less than that was recorded). `end` wins a tie: dragging the end handle
 * pushes the start along, dragging the start pushes the end.
 * @param {number} total seconds recorded @param {number} start @param {number} end
 * @param {'start'|'end'} [moved] which handle moved (the other one gives way)
 * @returns {{start: number, end: number}}
 */
export function clampTrim(total, start, end, moved = 'end') {
	const T = Math.max(0, Number(total) || 0);
	const min = Math.min(MOMENT_MIN_TRIM, T);
	const max = Math.min(MOMENT_MAX_TRIM, T);
	let s = Math.min(T, Math.max(0, Number(start) || 0));
	let e = Math.min(T, Math.max(0, Number.isFinite(Number(end)) ? Number(end) : T));
	if (moved === 'start') {
		if (e - s < min) e = Math.min(T, s + min);
		if (e - s < min) s = e - min;
		if (e - s > max) e = s + max;
	} else {
		if (e - s < min) s = Math.max(0, e - min);
		if (e - s < min) e = s + min;
		if (e - s > max) s = e - max;
	}
	const r = (/** @type {number} */ n) => Math.round(n * 1000) / 1000;
	return { start: r(Math.max(0, s)), end: r(Math.min(T, e)) };
}

/** the default trim: the LAST `MOMENT_MAX_TRIM` seconds (the moment just happened) @param {number} total */
export function defaultTrim(total) {
	return clampTrim(total, total - MOMENT_MAX_TRIM, total, 'end');
}

/**
 * The file's frames: output frame i shows the moment start + i / fps, i.e. the LATEST kept frame
 * at or before it (a capture the game was too slow to make repeats the one before), so the file
 * plays for exactly the trimmed length at the game's own speed whatever the capture rate did.
 * @param {number[]} times kept frames' times, seconds from the first kept frame, ascending
 * @param {number} start @param {number} end seconds, same clock @param {number} fps the file's rate
 * @returns {number[]} an index into `times` per output frame
 */
export function resampleFrames(times, start, end, fps) {
	if (!times.length || !(fps > 0) || !(end > start)) return [];
	const n = Math.max(1, Math.round((end - start) * fps));
	/** @type {number[]} */
	const out = [];
	let j = 0;
	for (let i = 0; i < n; i++) {
		const at = start + i / fps + 1e-6;
		while (j + 1 < times.length && times[j + 1] <= at) j++;
		out.push(j);
	}
	return out;
}

/** `Moment 2026-11-19 14-03-22.gif` @param {Date} when @param {string} ext */
export function momentFileName(when, ext) {
	const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
	return `Moment ${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}-${p(when.getMinutes())}-${p(when.getSeconds())}.${ext}`;
}

/**
 * The frame-cost meter: a rolling mean and the worst of the last `n` per-frame costs (ms) the
 * buffer added to the main thread. SM3's budget reads it (≤ 1 ms on desktop).
 * @param {number} [n]
 */
export function createCostMeter(n = 120) {
	/** @type {number[]} */
	const ring = [];
	let total = 0;
	let samples = 0;
	return {
		/** @param {number} ms */
		add(ms) {
			if (!Number.isFinite(ms) || ms < 0) return;
			ring.push(ms);
			total += ms;
			samples++;
			if (ring.length > n) total -= /** @type {number} */ (ring.shift());
		},
		mean: () => (ring.length ? total / ring.length : 0),
		max: () => (ring.length ? Math.max(...ring) : 0),
		/** the p95 of the window */
		p95() {
			if (!ring.length) return 0;
			const s = ring.slice().sort((a, b) => a - b);
			return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
		},
		samples: () => samples,
		reset() {
			ring.length = 0;
			total = 0;
			samples = 0;
		}
	};
}
