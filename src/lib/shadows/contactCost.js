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
 * The pure meter: feed(drawn, pixels, ms); cost() = median(with) - median(without) at the newest pixel count, or null.
 * A window resize starts both sides again (the pass costs per pixel). @param {{ min?: number, keep?: number }} [o]
 */
export function createContactMeter(o = {}) {
	const min = o.min ?? MIN;
	const keep = o.keep ?? KEEP;
	let px = 0;
	/** @type {{ on: number[], off: number[] }} */
	let s = { on: [], off: [] };
	return {
		/** @param {boolean} drawn @param {number} pixels @param {number} ms */
		feed(drawn, pixels, ms) {
			if (!(ms >= 0) || ms > 1000 || !(pixels > 0)) return;
			if (pixels !== px) {
				px = pixels;
				s = { on: [], off: [] };
			}
			const xs = drawn ? s.on : s.off;
			xs.push(ms);
			if (xs.length > keep) xs.shift();
		},
		/** @returns {{ ms: number, pixels: number } | null} */
		cost() {
			if (s.on.length < min || s.off.length < min) return null;
			return { ms: Math.max(0, median(s.on) - median(s.off)), pixels: px };
		},
		counts: () => ({ on: s.on.length, off: s.off.length, pixels: px, onMs: s.on.length ? median(s.on) : null, offMs: s.off.length ? median(s.off) : null })
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
		const [q, drawn, pixels] = pending[0];
		if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
		pending.shift();
		if (!disjoint) meter.feed(drawn, pixels, gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
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
			pending.push([open, !!drawn, openPixels]);
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

/** For the suites: the meter's sample counts, whether a GPU timer exists, the stored cost. */
export function contactMeterDebug() {
	return { started, timer: !!ext, ...meter.counts(), cost: meter.cost(), stored: get(contactCost) };
}
