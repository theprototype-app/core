// 98 P3 — the PURE half of TRAA (imports NOTHING): the jitter sequence, the per-tier on/off rule, and the
// "is this a camera cut" test that resets the history. TSL-portable rule: none of this lives in a shader.

/** Halton radical inverse. @param {number} index (1-based) @param {number} base */
export function halton(index, base) {
	let f = 1;
	let r = 0;
	let i = index;
	while (i > 0) {
		f /= base;
		r += f * (i % base);
		i = Math.floor(i / base);
	}
	return r;
}

export const JITTER_SAMPLES = 8;

/**
 * The sub-pixel offset for frame `n`, in PIXELS in -0.5..0.5 (Halton 2,3 over 8 frames — the usual TAA
 * sequence: low discrepancy, so 8 frames cover the pixel evenly).
 * @param {number} n @returns {[number, number]}
 */
export function jitterAt(n) {
	const i = (((n % JITTER_SAMPLES) + JITTER_SAMPLES) % JITTER_SAMPLES) + 1;
	return [halton(i, 2) - 0.5, halton(i, 3) - 0.5];
}

/**
 * Offset a projection matrix (column-major, three's `elements`) by a sub-pixel jitter, IN PLACE.
 * Perspective: the third column's x/y (elements 8/9); orthographic: the translation (12/13).
 * @param {number[] | Float32Array} e @param {[number, number]} jitter pixels @param {number} width @param {number} height
 */
export function applyJitter(e, jitter, width, height) {
	const dx = (2 * jitter[0]) / Math.max(1, width);
	const dy = (2 * jitter[1]) / Math.max(1, height);
	const ortho = e[15] === 1 && e[11] === 0;
	if (ortho) {
		e[12] += dx;
		e[13] += dy;
	} else {
		e[8] += dx;
		e[9] += dy;
	}
}

/**
 * Whether TRAA runs on this device right now. The PLAY OFF SWITCH: fast first-person motion is where a
 * temporal filter ghosts, so in Play a phone (and a headset — no post in XR anyway) falls back to no AA
 * unless the author pinned it; a PC keeps it. `inPlay`: auto | on | off.
 * @param {{tier: 'pc'|'phone'|'quest', playing: boolean, inPlay?: string}} s
 */
export function traaActive(s) {
	if (s.tier === 'quest') return false;
	if (!s.playing) return true;
	if (s.inPlay === 'on') return true;
	if (s.inPlay === 'off') return false;
	return s.tier === 'pc';
}

/**
 * A camera CUT: the history no longer describes this view, so blending it in would smear the old shot over
 * the new one. A different camera, or the eye jumping further than `maxMove` world units in one frame.
 * @param {{camera: any, pos: number[]} | null} prev @param {{camera: any, pos: number[]}} now @param {number} [maxMove]
 */
export function isCameraCut(prev, now, maxMove = 5) {
	if (!prev || prev.camera !== now.camera) return true;
	const d = Math.hypot(now.pos[0] - prev.pos[0], now.pos[1] - prev.pos[1], now.pos[2] - prev.pos[2]);
	return d > maxMove;
}
