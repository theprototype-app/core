// 34 PF (profiler-xr) — THE LIVE STREAM'S WIRE. A headset's frames, shown live on a desktop
// peer in the same room, over the peer connection the session already has.
//
// ONE message type, `perflive`, with an `op` (wireValidate holds its shape):
//   desktop -> headset   watch {mode: 'light'|'detailed'} · unwatch · detail {frames?} (one capture now)
//   headset -> desktop   hello {meta, rec, base} · frames {seq, base, t0, f, c?, ev?, rec, drop?}
//                        · capture {base, t, cap} · bye
//   headset -> everyone  state {rec}   (a recording started/stopped: "Watch" offers itself)
//
// DIRECT sends to the peers that asked (never `broadcast` per batch — a stream nobody watches
// costs nothing), 2 batches a second, light by default: per frame five INTEGERS (binarypack
// writes a small int in 1-5 bytes, so 90 Hz is ~1.5 KB/s). Detailed = the CPU phases per frame
// (`c`, six more ints, only while a detailed recording runs on the headset) + every detailed
// capture, trimmed to the heaviest MAX_CAPTURE_OBJECTS.
//
// A DELIBERATE LEAF that imports NOTHING: peerHandler reaches the stream through the routing
// seam below (the perfMarks shape), wireValidate cannot import at all, and vitest covers the
// packing with no browser.

/** a batch every LIVE_BATCH_MS (2 Hz: a live graph, not a video) */
export const LIVE_BATCH_MS = 500;
/** what a new watcher is sent first, so its graph is not empty */
export const LIVE_BACKFILL_MS = 10000;
/** columns per packed frame: dt (0.1 ms after t0), ms x100, calls, tris, quality */
export const FRAME_COLS = 5;
/** CPU phases per frame in `c` (tpprof CPU_PHASES: input physics modules flow render other) */
export const CPU_COLS = 6;
/** a batch never carries more than this many frames (a hidden tab's backlog is dropped, counted) */
export const MAX_BATCH_FRAMES = 1200;
/** events per batch */
export const MAX_BATCH_EVENTS = 50;
/** a streamed capture keeps the heaviest objects only */
export const MAX_CAPTURE_OBJECTS = 200;
/** the light-mode budget the brief sets (bytes per second, JSON-measured) */
export const LIGHT_BUDGET_BPS = 20 * 1024;
/** absent value in a packed column */
export const NONE = -1;

/** @param {any} v */
const intOr = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NONE);

/**
 * Pack frames for the wire. Times are relative to `t0` (the first frame's time) in 0.1 ms.
 * @param {{t: number, ms: number, calls?: number|null, tris?: number|null, quality?: number|null, cpu?: ArrayLike<number>|Record<string, number>|null}[]} frames
 * @param {boolean} [withCpu] include `c` when at least one frame has phases
 * @returns {{t0: number, f: number[], c?: number[]}}
 */
export function packFrames(frames, withCpu = false) {
	const t0 = frames.length ? Math.round(frames[0].t * 10) / 10 : 0;
	/** @type {number[]} */
	const f = new Array(frames.length * FRAME_COLS);
	/** @type {number[] | null} */
	let c = null;
	for (let i = 0; i < frames.length; i++) {
		const fr = frames[i];
		const k = i * FRAME_COLS;
		f[k] = Math.max(0, Math.round((fr.t - t0) * 10));
		f[k + 1] = Math.max(0, Math.round(fr.ms * 100));
		f[k + 2] = intOr(fr.calls);
		f[k + 3] = intOr(fr.tris);
		f[k + 4] = intOr(fr.quality);
		if (withCpu && fr.cpu) {
			if (!c) c = new Array(frames.length * CPU_COLS).fill(NONE);
			const vals = cpuValues(fr.cpu);
			for (let p = 0; p < CPU_COLS; p++) c[i * CPU_COLS + p] = Math.max(0, Math.round((vals[p] || 0) * 100));
		}
	}
	return c ? { t0, f, c } : { t0, f };
}

/** @type {readonly string[]} */
const PHASE_KEYS = ['input', 'physics', 'modules', 'flow', 'render', 'other'];

/** @param {ArrayLike<number> | Record<string, number>} cpu @returns {ArrayLike<number>} */
function cpuValues(cpu) {
	if (typeof (/** @type {any} */ (cpu).length) === 'number') return /** @type {ArrayLike<number>} */ (cpu);
	const rec = /** @type {Record<string, number>} */ (cpu);
	return PHASE_KEYS.map((key) => rec[key] || 0);
}

/**
 * The inverse: T1 frames (t in the SOURCE's time base, i.e. `t0 + dt`).
 * @param {{t0: number, f: number[], c?: number[]}} batch
 * @returns {import('./tpprof.js').TpFrame[]}
 */
export function unpackFrames(batch) {
	const f = batch.f;
	const n = Math.floor(f.length / FRAME_COLS);
	/** @type {any[]} */
	const out = new Array(n);
	for (let i = 0; i < n; i++) {
		const k = i * FRAME_COLS;
		/** @type {any} */
		const fr = {
			t: Math.round((batch.t0 + f[k] / 10) * 10) / 10,
			ms: f[k + 1] / 100,
			calls: f[k + 2] === NONE ? null : f[k + 2],
			tris: f[k + 3] === NONE ? null : f[k + 3],
			quality: f[k + 4] === NONE ? null : f[k + 4]
		};
		if (batch.c && batch.c[i * CPU_COLS] !== NONE) {
			/** @type {Record<string, number>} */
			const cpu = {};
			for (let p = 0; p < CPU_COLS; p++) cpu[PHASE_KEYS[p]] = batch.c[i * CPU_COLS + p] / 100;
			fr.cpu = cpu;
		}
		out[i] = fr;
	}
	return out;
}

/**
 * A capture trimmed for the wire: the heaviest objects by calls then tris (the order the
 * probe already returns), the rest folded into one "(N more)" row so the totals still add up.
 * @param {import('./tpprof.js').TpCapture} cap @param {number} [max] @returns {import('./tpprof.js').TpCapture}
 */
export function trimCapture(cap, max = MAX_CAPTURE_OBJECTS) {
	if (!cap?.objects || cap.objects.length <= max) return cap;
	const keep = cap.objects.slice(0, max - 1);
	const rest = cap.objects.slice(max - 1);
	let calls = 0;
	let tris = 0;
	for (const o of rest) {
		calls += o.calls || 0;
		tris += o.tris || 0;
	}
	keep.push({ uuid: '', name: `(${rest.length} more)`, path: '', calls: Math.round(calls * 100) / 100, tris, material: '', shadow: false });
	return { ...cap, objects: keep };
}

// ---------------------------------------------------------------- the routing seam

/** @type {{message: (peerId: string, data: any) => void, gone: (peerId: string) => void} | null} */
let handlers = null;

/** The stream's two halves register here at boot (perf/live*.js). @param {{message: (peerId: string, data: any) => void, gone: (peerId: string) => void} | null} h */
export function registerPerfLive(h) {
	handlers = h;
}

/** peerHandler's dispatch case. @param {string} peerId @param {any} data */
export function routePerfLive(peerId, data) {
	handlers?.message(peerId, data);
}

/** peerHandler's disconnect sites. @param {string} peerId */
export function perfLivePeerGone(peerId) {
	try {
		handlers?.gone(peerId);
	} catch {
		/* teardown must not throw */
	}
}
