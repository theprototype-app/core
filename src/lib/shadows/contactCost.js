// 106 S2b — WHAT CONTACT SHADOWS COST ON THIS DEVICE, measured, the #625 pattern (cinematicCore.createCostMeter) on
// the standard WebGL view. LAZY: loaded by the shadow-level chunk on the pc tier, or by the Preview menu there; a
// phone or a headset never runs it (On is not allowed there, so there is nothing to price).
//
// Every 4th composed frame, the GPU time of the composer's render (EXT_disjoint_timer_query_webgl2 TIME_ELAPSED:
// the work itself, which a 60 Hz frame interval hides) is filed under the frame's configuration: the contact pass
// in the stack or not, at this many drawn pixels. The cost = the median with it minus the median without it, known
// once both sides have MIN samples (the switch flipped, the governor's pre-step, a level change). Kept per device
// in safeStorage `contactShadowsCost` ({ ms, pixels }) and shown in the menu scaled to the window's pixels now.
// No timer extension = no number (the row then shows the state only). Never in a scene, never on the wire.
import { writable, get } from 'svelte/store';
import { contactFrameProbe } from '../lightParams';
import { safeStorage } from '../safeStorage';

const KEY = 'contactShadowsCost';
export const MIN = 20;
const KEEP = 90;
/** samples older than this (ms) no longer count */
export const WINDOW_MS = 30000;
/** samples skipped after the pass joins or leaves the stack */
export const SETTLE = 8;

/** @returns {{ ms: number, pixels: number } | null} */
function load() {
	try {
		const v = JSON.parse(safeStorage.getItem(KEY) || 'null');
		return v && v.ms >= 0 && v.pixels > 0 ? { ms: +v.ms, pixels: +v.pixels } : null;
	} catch {
		return null;
	}
}

/** this device's measured cost (null = not known yet) */
export const contactCost = writable(load());
contactCost.subscribe((c) => {
	try {
		if (c) safeStorage.setItem(KEY, JSON.stringify(c));
	} catch {
		/* storage refused: the number lives for this tab */
	}
});

/** a median of numbers (pure) @param {number[]} xs */
function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The pure meter: feed(drawn, pixels, ms, t); cost() = median(with) - median(without), or null.
 *  · a window resize starts both sides again (the pass costs per pixel)
 *  · only samples from the last WINDOW_MS count (a scene load, a level change or another scene's frames age out
 *    instead of pricing the pass: chain 1 stored 6.3 ms from post-reload frames while the medians differed by 0.07)
 *  · the first SETTLE samples after the pass joins or leaves the stack are skipped (its shader compile)
 * @param {{ min?: number, keep?: number, windowMs?: number, settle?: number }} [o]
 */
export function createContactMeter(o = {}) {
	const min = o.min ?? MIN;
	const keep = o.keep ?? KEEP;
	const windowMs = o.windowMs ?? WINDOW_MS;
	const settle = o.settle ?? SETTLE;
	let px = 0;
	let newest = -Infinity;
	/** @type {boolean | null} */
	let lastDrawn = null;
	let skip = 0;
	/** @type {{ on: {t: number, ms: number}[], off: {t: number, ms: number}[] }} */
	let s = { on: [], off: [] };
	/** @param {'on'|'off'} k */
	const fresh = (k) => s[k].filter((x) => x.t >= newest - windowMs).map((x) => x.ms);
	return {
		/** @param {boolean} drawn @param {number} pixels @param {number} ms @param {number} t */
		feed(drawn, pixels, ms, t) {
			if (!(ms >= 0) || ms > 1000 || !(pixels > 0) || !Number.isFinite(t)) return;
			if (pixels !== px) {
				px = pixels;
				s = { on: [], off: [] };
			}
			if (lastDrawn !== null && drawn !== lastDrawn) skip = settle;
			lastDrawn = drawn;
			if (skip > 0) {
				skip--;
				return;
			}
			newest = Math.max(newest, t);
			const xs = drawn ? s.on : s.off;
			xs.push({ t, ms });
			if (xs.length > keep) xs.shift();
		},
		/** @returns {{ ms: number, pixels: number } | null} */
		cost() {
			const on = fresh('on');
			const off = fresh('off');
			if (on.length < min || off.length < min) return null;
			return { ms: Math.max(0, median(on) - median(off)), pixels: px };
		},
		/** forget every sample (the suites' frame rows start clean) */
		reset() {
			s = { on: [], off: [] };
			lastDrawn = null;
			skip = 0;
		},
		counts: () => {
			const on = fresh('on');
			const off = fresh('off');
			return { on: on.length, off: off.length, pixels: px, onMs: on.length ? median(on) : null, offMs: off.length ? median(off) : null };
		}
	};
}

/**
 * The menu's words for a cost, scaled to the drawn pixels now ('' = not known yet). The #625 wording.
 * @param {{ ms: number, pixels: number } | null | undefined} c @param {number} pixels
 */
export function contactCostText(c, pixels) {
	if (!c || !(c.ms >= 0) || !(c.pixels > 0)) return '';
	const ms = pixels > 0 ? (c.ms * pixels) / c.pixels : c.ms;
	if (ms < 0.5) return 'under 1 ms';
	return 'about ' + Math.round(ms) + ' ms';
}

const meter = createContactMeter();
/** @type {any} */
let gl = null;
/** @type {any} */
let ext = null;
/** in flight: [query, drawn, pixels] @type {any[]} */
let pending = [];
let frames = 0;
let started = false;
/** the frame's query (begin -> end) */
let open = /** @type {any} */ (null);
let openPixels = 0;

function poll() {
	if (!pending.length) return;
	const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
	while (pending.length) {
		const [q, drawn, pixels, t] = pending[0];
		if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
		pending.shift();
		if (!disjoint) meter.feed(drawn, pixels, gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6, t);
		gl.deleteQuery(q);
	}
	if (pending.length > 32) pending.splice(0, pending.length - 32).forEach(([q]) => gl.deleteQuery(q));
}

function publish() {
	const c = meter.cost();
	if (!c) return;
	const was = get(contactCost);
	const scaledWas = was ? (was.ms * c.pixels) / was.pixels : -1;
	if (Math.abs(scaledWas - c.ms) < 0.3) return;
	contactCost.set({ ms: Math.round(c.ms * 10) / 10, pixels: c.pixels });
}

const probe = {
	/** @param {any} renderer */
	begin(renderer) {
		frames++;
		if (frames % 4) return;
		if (!gl) {
			try {
				gl = renderer.getContext();
				ext = gl?.getExtension?.('EXT_disjoint_timer_query_webgl2') ?? null;
			} catch {
				ext = null;
			}
		}
		if (!ext) return;
		poll();
		if (frames % 120 === 0) publish();
		// perf/detailed.js times render() calls with the same query type while its recorder runs: one at a time
		if (renderer.__perfDetailed) return;
		const c = gl.canvas;
		openPixels = (c?.width || 0) * (c?.height || 0);
		try {
			const q = gl.createQuery();
			gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
			open = q;
		} catch {
			open = null;
		}
	},
	/** @param {boolean} drawn */
	end(drawn) {
		if (!open) return;
		try {
			gl.endQuery(ext.TIME_ELAPSED_EXT);
			pending.push([open, !!drawn, openPixels, performance.now()]);
		} catch {
			/* a lost context */
		}
		open = null;
	}
};

/** Start the meter (idempotent). */
export function startContactMeter() {
	if (started) return;
	started = true;
	contactFrameProbe.on = probe;
}

/** For the suites' frame rows: start the meter's samples clean. */
export function contactMeterReset() {
	meter.reset();
}

/** For the suites: the meter's sample counts, whether a GPU timer exists, the stored cost. */
export function contactMeterDebug() {
	return { started, timer: !!ext, ...meter.counts(), cost: meter.cost(), stored: get(contactCost) };
}
