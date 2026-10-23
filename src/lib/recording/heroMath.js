// 65 M7 — the website section's arithmetic. PURE and DEPENDENCY-FREE on purpose: the same file is
// bundled into the exported script (heroRuntime.js, via the vite `virtual:tp-hero-runtime` module)
// AND unit-tested here, so the page a user ships scrubs by exactly the maths the suite pins.

/** @param {number} v */
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0); // also maps NaN and -0 to 0

/**
 * How far through its scroll a section is, 0..1.
 *  - `track` mode (the section sits in a tall wrapper with a sticky canvas — the classic scroll
 *    hero): 0 when the wrapper's top reaches the viewport top, 1 when its bottom reaches the
 *    viewport bottom.
 *  - `pass` mode (a plain canvas in the page): 0 as its top enters at the bottom of the viewport,
 *    1 as its bottom leaves at the top.
 * @param {{top: number, height: number}} rect the element's bounding rect @param {number} vh viewport height
 * @param {'track'|'pass'} mode
 */
export function scrollProgress(rect, vh, mode) {
	if (mode === 'track') {
		const range = rect.height - vh;
		if (!(range > 0)) return rect.top <= 0 ? 1 : 0;
		return clamp01(-rect.top / range);
	}
	const range = vh + rect.height;
	if (!(range > 0)) return 0;
	return clamp01((vh - rect.top) / range);
}

/** the frame a timeline position shows @param {number} t 0..1 @param {number} n frames */
export function frameIndexAt(t, n) {
	if (!(n > 1)) return 0;
	return Math.round(clamp01(t) * (n - 1));
}

/**
 * Where an `sw × sh` frame is drawn in a `dw × dh` canvas: `cover` fills and crops, `contain`
 * shows all of it (letterboxed). Centred.
 * @param {number} sw @param {number} sh @param {number} dw @param {number} dh @param {'cover'|'contain'} fit
 * @returns {{x: number, y: number, w: number, h: number}}
 */
export function fitRect(sw, sh, dw, dh, fit) {
	const s = fit === 'contain' ? Math.min(dw / sw, dh / sh) : Math.max(dw / sw, dh / sh);
	const w = sw * s;
	const h = sh * s;
	return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}

/**
 * Where a hover / click section heads next. Hover: in → the end, out → the start. Click: each press
 * flips the destination.
 * @param {'hover'|'click'} trigger @param {string} event enter | leave | click @param {number} current destination 0|1
 */
export function nextTarget(trigger, event, current) {
	if (trigger === 'hover') return event === 'enter' ? 1 : event === 'leave' ? 0 : current;
	if (trigger === 'click' && event === 'click') return current >= 0.5 ? 0 : 1;
	return current;
}

/**
 * How long a glide from `from` to `to` takes, ms. Scroll glides take the smoothing time (a lag
 * behind the wheel, not a playback); hover/click glides PLAY the timeline at its own speed, so half
 * the distance takes half the time.
 * @param {'scroll'|'hover'|'click'} trigger @param {number} from @param {number} to
 * @param {{smooth: number, duration: number}} o smooth ms, duration = the timeline's seconds
 */
export function glideMs(trigger, from, to, o) {
	if (trigger === 'scroll') return Math.max(0, o.smooth);
	return Math.max(0, Math.abs(to - from) * o.duration * 1000);
}
