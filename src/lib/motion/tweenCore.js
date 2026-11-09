// 85 N1 / N2 / N4 — the PURE half of Oscillate, the three Tween nodes (Move to / Rotate to /
// Scale to) and the light nodes' fades. Imports nothing (the unit layer's entry rule):
// tweenNodes.js and lightNodes.js do the three.js work, this file does the maths.
//
// DETERMINISM IS THE NETCODE. Every value here is a pure function of the shared clock and of
// trigger STAMPS that are already replicated, so two peers holding the same stamps draw the
// same pose and nothing is streamed (the Spin / Wander rule). The one input that is not a
// stamp — an `open` BOOLEAN (a Proximity, a Latch) — enters as an event at the moment the
// peer SAW it change, so peers differ by their latency while it moves and agree once it
// settles.

/** @param {number} x */
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** @param {any} v @param {number} fallback @param {number} lo @param {number} hi */
export function clampNum(v, fallback, lo, hi) {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return n < lo ? lo : n > hi ? hi : n;
}

// ---- easing -----------------------------------------------------------------------------------

/** the easing names the nodes offer, in palette order */
export const EASINGS = ['smooth', 'linear', 'ease in', 'ease out', 'back', 'bounce', 'elastic'];

/** @param {number} x */
function bounceOut(x) {
	const n = 7.5625;
	const d = 2.75;
	if (x < 1 / d) return n * x * x;
	if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
	if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
	return n * (x -= 2.625 / d) * x + 0.984375;
}

/**
 * Eased progress for x in 0..1 (clamped). Unknown names read as 'smooth' (cubic in-out), so a
 * typo from an agent still moves, just without the overshoot it asked for.
 * @param {string} name @param {number} x
 */
export function ease(name, x) {
	const t = clamp01(x);
	switch (name) {
		case 'linear':
			return t;
		case 'ease in':
			return t * t * t;
		case 'ease out':
			return 1 - Math.pow(1 - t, 3);
		case 'back': {
			// overshoots ~10 % and settles: a door that swings a little past and back
			const c1 = 1.70158;
			const c3 = c1 + 1;
			return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
		}
		case 'bounce':
			return bounceOut(t);
		case 'elastic': {
			if (t === 0 || t === 1) return t;
			return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
		}
		default:
			return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
	}
}

// ---- N1 Oscillate ------------------------------------------------------------------------------

export const OSCILLATE_DEFAULTS = Object.freeze({
	property: 'rotation',
	axis: 'z',
	amplitude: 20,
	period: 2,
	phase: 0,
	damping: 0,
	wave: 'sine',
	pivot: 'top'
});

/**
 * The oscillation value (in the node's units: degrees, metres or a scale fraction) at `time`.
 * `start` = the stamp of the trigger that set it swinging, or null when nothing is wired (then
 * it runs forever and damping does not apply — a decay needs a moment to decay FROM).
 * A wired trigger with no stamp yet = at rest (`armed`).
 * @param {any} data @param {number} time @param {number | null} start @param {boolean} armed
 */
export function oscillateAt(data, time, start, armed = false) {
	const d = OSCILLATE_DEFAULTS;
	const amp = clampNum(data?.amplitude, d.amplitude, -720, 720);
	const period = clampNum(data?.period, d.period, 0.05, 600);
	const phase = clampNum(data?.phase, d.phase, 0, 1);
	const damping = clampNum(data?.damping, d.damping, 0, 20);
	if (armed && start === null) return 0;
	const t = start === null ? time : time - start;
	if (t < 0) return 0;
	// a wrapped cycle keeps float precision on a session clock that is a large number
	const cycle = (((t / period + phase) % 1) + 1) % 1;
	let w;
	switch (data?.wave) {
		case 'triangle':
			w = cycle < 0.25 ? cycle * 4 : cycle < 0.75 ? 2 - cycle * 4 : cycle * 4 - 4;
			break;
		case 'bob':
			// up and back only, never below the rest pose: a floating buoy, a breathing chest
			w = 0.5 - 0.5 * Math.cos(cycle * 2 * Math.PI);
			break;
		default:
			w = Math.sin(cycle * 2 * Math.PI);
	}
	const env = start !== null && damping > 0 ? Math.exp(-damping * t) : 1;
	// a decayed swing settles EXACTLY at rest instead of drifting by 1e-9 forever
	return env < 1e-4 ? 0 : amp * w * env;
}

// ---- N2 Tween progress -----------------------------------------------------------------------------

/**
 * @typedef {{t: number, dir: 0 | 1}} TweenEvent  a moment the tween was sent somewhere: 1 = to the
 * goal, 0 = back to rest
 */

/**
 * Collect the tween's events from its inputs, newest LAST. `toggle` carries a parity (its count
 * of flips since a trigger/back cleared it — the Latch precedent), so an odd count heads to the
 * goal and an even one back to rest.
 * @param {{trigger?: number|null, back?: number|null, toggle?: number|null, toggleCount?: number, open?: TweenEvent[]}} s
 * @returns {TweenEvent[]}
 */
export function tweenEvents(s) {
	/** @type {TweenEvent[]} */
	const out = [];
	if (typeof s.trigger === 'number') out.push({ t: s.trigger, dir: 1 });
	if (typeof s.back === 'number') out.push({ t: s.back, dir: 0 });
	if (typeof s.toggle === 'number') out.push({ t: s.toggle, dir: (s.toggleCount ?? 1) % 2 === 1 ? 1 : 0 });
	for (const e of s.open ?? []) if (e && typeof e.t === 'number') out.push(e);
	// a same-moment tie reads as "to the goal" (the Latch's set-wins tie rule)
	out.sort((a, b) => a.t - b.t || a.dir - b.dir);
	return out;
}

/**
 * Where a tween stands (0 = rest, 1 = goal) at `time`, and whether it is still moving.
 *
 * Only the LAST two events matter: the last says where it is heading and since when; the one
 * before says where it was when that happened (it is assumed to have started from the far
 * end — the log keeps one stamp per input, so anything older is gone, and a peer deriving the
 * same answer from the same two stamps is what keeps the peers together). A reversal half-way
 * turns back from where it was, at the same speed, instead of jumping.
 *
 * `repeat` = 'none' | 'pingpong' | 'loop': after the newest TO-GOAL event (or from the start of
 * the clock when nothing is wired) the tween keeps going back and forth / restarting.
 * @param {TweenEvent[]} events @param {number} time @param {number} duration @param {string} [repeat]
 * @param {boolean} [unwired] no trigger/back/toggle/open input is wired at all
 * @returns {{raw: number, moving: boolean, dir: 0 | 1, from: number}}
 */
export function tweenProgress(events, time, duration, repeat = 'none', unwired = false) {
	const dur = Math.max(0.01, duration);
	if (repeat === 'pingpong' || repeat === 'loop') {
		// the cycle starts at the newest event that sent it to the goal; a newer BACK stops it
		const last = events.length ? events[events.length - 1] : null;
		if (last && last.dir === 0) return settle(events, time, dur);
		const start = last ? last.t : unwired ? 0 : null;
		if (start === null) return { raw: 0, moving: false, dir: 0, from: 0 };
		const u = (time - start) / dur;
		if (u < 0) return { raw: 0, moving: true, dir: 1, from: 0 };
		if (repeat === 'loop') return { raw: u % 1, moving: true, dir: 1, from: 0 };
		const k = u % 2;
		return k < 1 ? { raw: k, moving: true, dir: /** @type {1} */ (1), from: 0 } : { raw: 2 - k, moving: true, dir: /** @type {0} */ (0), from: 1 };
	}
	return settle(events, time, dur);
}

/** the one-shot (repeat 'none') read @param {TweenEvent[]} events @param {number} time @param {number} dur
 * @returns {{raw: number, moving: boolean, dir: 0 | 1, from: number}} */
function settle(events, time, dur) {
	if (!events.length) return { raw: 0, moving: false, dir: /** @type {0} */ (0), from: 0 };
	const last = events[events.length - 1];
	const prev = events.length > 1 ? events[events.length - 2] : null;
	// where it stood when `last` arrived: the previous leg evaluated at that moment, linear
	// (the raw position along the path; easing is applied to the whole leg below)
	let from = 0;
	if (prev) {
		const prevFrom = 1 - prev.dir;
		const legSpan = Math.abs(prev.dir - prevFrom);
		const u = clamp01((last.t - prev.t) / (dur * Math.max(legSpan, 1e-6)));
		from = prevFrom + (prev.dir - prevFrom) * u;
	}
	const span = Math.abs(last.dir - from);
	if (span < 1e-6) return { raw: last.dir, moving: false, dir: last.dir, from };
	const u = (time - last.t) / (dur * span);
	if (u <= 0) return { raw: from, moving: true, dir: last.dir, from };
	if (u >= 1) return { raw: last.dir, moving: false, dir: last.dir, from };
	return { raw: from + (last.dir - from) * u, moving: true, dir: last.dir, from };
}

/**
 * The eased position (0..1, may overshoot with back / elastic) for a tween read. The easing runs
 * over the CURRENT leg, from `from` to `dir`, so a reversed door eases out of its turn too.
 * @param {{raw: number, dir: 0 | 1, from: number}} p @param {string} easing
 */
export function easedPosition(p, easing) {
	const span = p.dir - p.from;
	if (Math.abs(span) < 1e-6) return p.raw;
	const u = (p.raw - p.from) / span;
	return p.from + span * ease(easing, u);
}

/**
 * An `open` boolean's events, kept per peer: the moment it was SEEN to change, plus the change
 * before it (a quick open-close-open must turn back from where it was, which needs two).
 * The caller keeps the returned state per (node, object) and hands `events` to tweenEvents.
 * @param {{value: boolean, events: TweenEvent[]} | undefined} held @param {any} value @param {number} time
 * @returns {{value: boolean, events: TweenEvent[]}}
 */
export function openEvent(held, value, time) {
	const on = !!value;
	if (!held) {
		// first sight: a boolean that is ALREADY true stands at the goal (a moment far in the
		// past), so a late joiner or a reload does not watch the door open again
		return { value: on, events: on ? [{ t: -1e9, dir: 1 }] : [] };
	}
	if (held.value === on) return held;
	const last = held.events[held.events.length - 1];
	return { value: on, events: [...(last ? [last] : []), { t: time, dir: on ? 1 : 0 }] };
}

// ---- N4 light level ---------------------------------------------------------------------------------

/**
 * A light switch's level (0..1) from its switch events, faded over `fade` seconds — the tween
 * read with 'smooth' easing. `initial` = on before any event.
 * @param {TweenEvent[]} events @param {number} time @param {number} fade @param {boolean} initial
 */
export function lightLevel(events, time, fade, initial) {
	/** @type {TweenEvent[]} */
	const list = initial ? [{ t: -1e9, dir: 1 }, ...events] : events;
	if (fade <= 0.001) return list.length ? list[list.length - 1].dir : 0;
	const p = tweenProgress(list, time, fade);
	return clamp01(easedPosition(p, 'smooth'));
}

/** parse "#ff0000, #00ff88 #3366ff" into hex strings (max 8) @param {any} raw @returns {string[]} */
export function parseColours(raw) {
	if (typeof raw !== 'string') return [];
	const out = [];
	for (const m of raw.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)) {
		let h = m[0].toLowerCase();
		if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
		out.push(h);
		if (out.length >= 8) break;
	}
	return out;
}

/** @param {string} hex @returns {[number, number, number]} 0..1 */
export function hexRgb(hex) {
	const n = parseInt(hex.slice(1), 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** @param {number} h 0..1 @param {number} s @param {number} l @returns {[number, number, number]} */
export function hslRgb(h, s, l) {
	const k = (/** @type {number} */ n) => (n + h * 12) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (/** @type {number} */ n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
	return [f(0), f(8), f(4)];
}

/**
 * The colour cycle's colour at `time`: 'rainbow' walks the hue wheel, 'list' blends through the
 * given colours (a smooth blend, or a hard step with `step` on). Pure of the shared clock.
 * @param {any} data @param {number} time @returns {[number, number, number]}
 */
export function cycleColour(data, time) {
	const period = clampNum(data?.period, 4, 0.1, 600);
	const u = (((time / period) % 1) + 1) % 1;
	const list = parseColours(data?.colors);
	if (data?.mode !== 'list' || list.length < 2) {
		const sat = clampNum(data?.saturation, 1, 0, 1);
		return hslRgb(u, sat, 0.5);
	}
	const x = u * list.length;
	const i = Math.floor(x) % list.length;
	const j = (i + 1) % list.length;
	const a = hexRgb(list[i]);
	if (data?.step) return a;
	const b = hexRgb(list[j]);
	const f = ease('smooth', x - Math.floor(x));
	return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// ---- pivots ------------------------------------------------------------------------------------------

/** the pivot choices for a swing / a door, in palette order */
export const PIVOTS = ['origin', 'top', 'bottom', 'left', 'right', 'front', 'back'];

/**
 * The pivot in the object's LOCAL frame: the centre of one face of its local bounds, or null
 * for 'origin' (the caller then uses the object's Origin / centre, the Spin rule).
 * left/right = -x/+x, bottom/top = -y/+y, back/front = -z/+z.
 * @param {string} pivot @param {{min: number[], max: number[]} | null} box
 * @returns {number[] | null}
 */
export function pivotPoint(pivot, box) {
	if (!box || pivot === 'origin' || !PIVOTS.includes(pivot)) return null;
	const c = [0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2);
	switch (pivot) {
		case 'left':
			return [box.min[0], c[1], c[2]];
		case 'right':
			return [box.max[0], c[1], c[2]];
		case 'bottom':
			return [c[0], box.min[1], c[2]];
		case 'top':
			return [c[0], box.max[1], c[2]];
		case 'back':
			return [c[0], c[1], box.min[2]];
		case 'front':
			return [c[0], c[1], box.max[2]];
	}
	return null;
}
