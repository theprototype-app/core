// 34 PF/R1 — THE PERF RECORDER. One frame stream, three readers:
//   1. the LIGHT RING — always on, the last ~32 s of frames (ms, draw calls, triangles,
//      quality level) plus the markers. "Report this moment" and the beacon's 10-s
//      windows are cut from it, so neither has to have been "started";
//   2. a RECORDING the user starts (Profiler tab, VR menu, `api`): light, or DETAILED
//      (CPU phases per frame + per-object draw attribution captures — phase 3's probe,
//      registered through `registerDetailedProbe`, because it costs frame time);
//   3. saved recordings in IndexedDB, wrapped the safeStorage way (a failed write is
//      remembered in memory for the session and counted, never thrown at the caller).
//
// THE FRAME SOURCE is fpsMeter's `registerMeterFrame`: the desktop rAF loop AND the XR
// frame hook (the window's rAF does not run inside an immersive session). Draw calls and
// triangles come from sceneBudget's render wrapper, drained once per frame
// (`takeFrameRender`) — every render() pass of the frame, the composer's included.
//
// THE OVERHEAD RULE (≤ 0.3 ms/frame in light mode, Quest budget "no per-frame
// allocations"): the hot path writes numbers into typed-array columns (perfTrack.js) and
// reads cached values — no store `get()` per frame (a subscribe/unsubscribe each), no
// objects. `perfOverhead()` measures the hot path itself when a suite asks.
//
// LOCAL. Nothing here replicates; a recording is a fact about this device.
import { writable, get } from 'svelte/store';
import { registerMeterFrame } from '../fpsMeter';
import { takeFrameRender, registerLongTaskObserver } from '../sceneBudget';
import { qualityState } from '../qualityGovernor';
import { XR_FRAMEBUFFER_SCALE } from '../qualityGovernorCore';
import { sceneLoad } from '../sceneLoader';
import { globalRenderer, editorMode, isLocked } from '../../stores/sceneStore';
import { gameId } from '../gameSettings';
import { idbGet, idbPut, idbDelete } from '../idb';
import { APP_VERSION, COMMIT_SHA, IS_DEV } from '../version.js';
import { createTrack } from './perfTrack.js';
import { onPerfMark, perfContext, registerPerfContext } from './perfMarks.js';
import { STALL_MS, MOMENT_MS, TPPROF_VERSION, CPU_PHASES, encodeTpprof, decodeTpprof, summarize, windowOf } from './tpprof.js';

/** the light ring: ~32 s at 144 Hz, ~64 s at 72 Hz */
export const RING_FRAMES = 4608;
/** a DETAILED recording's default length (it costs frame time) and its capture cadence */
export const DETAILED_MS = 10000;
export const CAPTURE_EVERY_MS = 1000;
/** a recording's hard cap: 10 minutes at 120 Hz (it stops itself there, with an event) */
export const MAX_RECORD_FRAMES = 72000;
/** events kept in the ring's side list (they are rare; a stall storm is bounded here) */
const MAX_RING_EVENTS = 400;
/** saved recordings kept before the oldest UNPINNED one goes */
export const MAX_SAVED = 40;
/** a gap longer than this is the tab hidden / the device asleep, not a frame */
const GAP_MS = 5000;
/** what a stall's "doing" looks back over */
const DOING_LOOKBACK_MS = 1500;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---- the clock: ring times are ms since this module loaded (perf clock), anchored to wall time
const ringPerf0 = now();
const ringEpoch0 = Date.now();

const ring = createTrack({ capacity: RING_FRAMES, ring: true });
/** @type {import('./tpprof.js').TpEvent[]} */
let ringEvents = [];

/** cached per-frame inputs (kept current by subscriptions, read without a get()) */
let qualityLevel = 0;
/** @type {any} */
let renderer = null;
let lastLongTask = { at: -Infinity, ms: 0 };
let loadingNow = false;
let modeNow = 'edit';

/**
 * The detailed-mode probe (phase 3, `detailed.js`). Absent = detailed records light + a note.
 * @typedef {{
 *   start: () => {gpuTimer: boolean},
 *   stop: () => void,
 *   frameCpu: () => ArrayLike<number> | null,
 *   frameGpu: () => number | null,
 *   capture: (frames?: number) => Promise<import('./tpprof.js').TpCapture | null>
 * }} DetailedProbe
 */
/** @type {DetailedProbe | null} */
let detailedProbe = null;
/** @param {DetailedProbe | null} probe */
export function registerDetailedProbe(probe) {
	detailedProbe = probe;
}

/**
 * @typedef {{
 *   id: string, mode: 'light' | 'detailed', perf0: number, meta: import('./tpprof.js').TpMeta,
 *   track: import('./perfTrack.js').Track, events: import('./tpprof.js').TpEvent[],
 *   captures: import('./tpprof.js').TpCapture[], notes: import('./tpprof.js').TpNote[],
 *   gpuTimer: boolean
 * }} Active
 */
/** @type {Active | null} */
let active = null;

/**
 * What the UI shows: the recording in progress and how many are saved. Written on start /
 * stop / save and ~2x/s while recording (never per frame).
 * @type {import('svelte/store').Writable<{recording: null | {id: string, mode: string, startedAt: number, frames: number}, saved: number, version: number}>}
 */
export const perfState = writable({ recording: null, saved: 0, version: 0 });

// ---------------------------------------------------------------- the hot path

let overheadOn = false;
let overheadSum = 0;
let overheadFrames = 0;
let overheadMax = 0;
let lastPublish = 0;

/** @param {number} ms @param {'desktop' | 'xr'} from @param {number} at */
function onFrame(ms, from, at) {
	const t0 = overheadOn ? now() : 0;
	if (ms > GAP_MS) {
		// the tab was hidden or the headset slept: not a frame, a gap
		noteEvent('gap', { ms: Math.round(ms) }, at);
		takeFrameRender();
		return;
	}
	const drawn = takeFrameRender();
	const calls = drawn.calls;
	const tris = drawn.triangles;
	ring.push(at - ringPerf0, ms, calls, tris, qualityLevel);
	if (active) {
		const cpu = active.mode === 'detailed' && detailedProbe ? detailedProbe.frameCpu() : null;
		const gpu = active.mode === 'detailed' && detailedProbe ? detailedProbe.frameGpu() : null;
		if (!active.track.push(at - active.perf0, ms, calls, tris, qualityLevel, cpu, gpu)) {
			noteEvent('mark', { text: 'recording reached its 10-minute cap' }, at);
			void stopRecording();
		} else if (at - lastPublish > 500) {
			lastPublish = at;
			publishState();
		}
	}
	if (ms > STALL_MS) noteEvent('stall', { ms: Math.round(ms), doing: doingAt(at), source: from, calls, quality: qualityLevel }, at);
	if (overheadOn) {
		const spent = now() - t0;
		overheadSum += spent;
		overheadFrames++;
		if (spent > overheadMax) overheadMax = spent;
	}
}

/** What was going on around a stall: recent markers + the state flags that explain one. @param {number} at */
function doingAt(at) {
	/** @type {string[]} */
	const out = [];
	const since = at - ringPerf0 - DOING_LOOKBACK_MS;
	for (let i = ringEvents.length - 1; i >= 0 && ringEvents[i].t >= since; i--) {
		const k = ringEvents[i].kind;
		if (k !== 'stall' && !out.includes(k)) out.push(k);
	}
	if (loadingNow) out.push('loading');
	if (renderer?.xr?.isPresenting) out.push('xr');
	out.push('mode:' + modeNow);
	if (at - lastLongTask.at < 1000) out.push('long-task:' + Math.round(lastLongTask.ms));
	if (qualityLevel) out.push('quality:' + qualityLevel);
	return out;
}

function currentMode() {
	return get(isLocked) === true ? 'play' : get(editorMode) === 'interact' ? 'interact' : 'edit';
}

/** @param {string} kind @param {any} detail @param {number} [at] perf time */
function noteEvent(kind, detail, at = now()) {
	const ev = { t: Math.round((at - ringPerf0) * 10) / 10, kind: String(kind).slice(0, 40), detail: detail ?? null };
	ringEvents.push(ev);
	if (ringEvents.length > MAX_RING_EVENTS) ringEvents.splice(0, ringEvents.length - MAX_RING_EVENTS);
	// trim to what the ring still covers (events older than the oldest frame are useless)
	const oldest = ring.firstT;
	if (oldest !== null && ringEvents.length > 50 && ringEvents[0].t < oldest - 1000) {
		ringEvents = ringEvents.filter((e) => e.t >= oldest - 1000);
	}
	if (active) active.events.push({ ...ev, t: Math.round((at - active.perf0) * 10) / 10 });
	for (const fn of eventObservers) {
		try {
			fn(ev);
		} catch {
			/* isolated */
		}
	}
}

/** @type {Set<(ev: import('./tpprof.js').TpEvent) => void>} */
const eventObservers = new Set();
/** Hear every recorder event as it happens (the beacon sends stalls). @param {(ev: import('./tpprof.js').TpEvent) => void} fn */
export function onPerfEvent(fn) {
	eventObservers.add(fn);
	return () => eventObservers.delete(fn);
}

// ---------------------------------------------------------------- wiring (once)

let started = false;
/** @type {(() => void)[]} */
const offs = [];

/** Boot: hear frames, markers and the state changes worth a marker. Idempotent. */
export function startPerfRecorder() {
	if (started) return;
	started = true;
	offs.push(registerMeterFrame(onFrame));
	offs.push(onPerfMark((kind, detail) => noteEvent(kind, detail)));
	// 34 PF (profiler-xr): the VR menu's Record/Stop labels and the headset's recording
	// indicator read this through the leaf — the VR import family never imports the recorder
	offs.push(registerPerfContext('recording', recordingInfo));
	offs.push(
		registerLongTaskObserver((ms) => {
			lastLongTask = { at: now(), ms };
		})
	);
	offs.push(
		qualityState.subscribe((q) => {
			if (q.level !== qualityLevel) {
				qualityLevel = q.level;
				noteEvent('quality', { level: q.level, reason: q.reason || '' });
			}
		})
	);
	let loadStarted = 0;
	/** @type {string | null} */
	let loadName = null;
	offs.push(
		sceneLoad.subscribe((job) => {
			loadingNow = !!job;
			if (job && loadName === null) {
				loadStarted = now();
				loadName = String(job.name ?? '');
				noteEvent('scene-load', { scene: loadName, phase: 'start' });
			} else if (!job && loadName !== null) {
				noteEvent('scene-load', { scene: loadName, phase: 'end', ms: Math.round(now() - loadStarted) });
				loadName = null;
			}
		})
	);
	let lastMode = '';
	const modeChanged = () => {
		const m = currentMode();
		modeNow = m;
		if (m !== lastMode) {
			if (lastMode) noteEvent('mode', { mode: m });
			lastMode = m;
		}
	};
	offs.push(editorMode.subscribe(modeChanged));
	offs.push(isLocked.subscribe(modeChanged));
	offs.push(
		globalRenderer.subscribe((r) => {
			renderer = r;
			hookXR(r);
		})
	);
}

/** @param {any} r */
function hookXR(r) {
	if (!r?.xr || r.__perfXR) return;
	r.__perfXR = true;
	r.xr.addEventListener?.('sessionstart', () => {
		const session = r.xr.getSession?.();
		noteEvent('xr-start', { hz: Number(session?.frameRate) || null });
	});
	r.xr.addEventListener?.('sessionend', () => noteEvent('xr-end', null));
}

// ---------------------------------------------------------------- meta

/** a short id, safe in a storage key @returns {string} */
export function makeId() {
	const rand = Math.random().toString(36).slice(2, 8);
	return Date.now().toString(36) + '-' + rand;
}

/** @type {WeakMap<object, string | null>} one lookup per renderer */
const gpuNames = new WeakMap();
/** The GPU's name where the browser says it (Chromium does; Quest's browser may not). */
function gpuName() {
	if (!renderer) return null;
	if (gpuNames.has(renderer)) return /** @type {string | null} */ (gpuNames.get(renderer));
	let name = null;
	try {
		const gl = renderer.getContext?.();
		const ext = gl?.getExtension?.('WEBGL_debug_renderer_info');
		name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)).slice(0, 200) : null;
	} catch {
		name = null;
	}
	gpuNames.set(renderer, name);
	return name;
}

/** the display rate: an XR session's own, else the median frame of the ring */
function refreshRate() {
	const xr = renderer?.xr;
	if (xr?.isPresenting) {
		const hz = Number(xr.getSession?.()?.frameRate);
		if (hz) return hz;
	}
	const ms = ring.recentMs(120).sort();
	return ms.length ? Math.round(1000 / ms[Math.floor(ms.length / 2)]) : null;
}

/**
 * What a recording / window says about where it came from.
 * @param {'light' | 'detailed'} mode @param {number} startedAt epoch ms
 * @returns {import('./tpprof.js').TpMeta}
 */
export function currentMeta(mode, startedAt) {
	const xr = !!renderer?.xr?.isPresenting;
	const game = get(gameId);
	return {
		build: COMMIT_SHA,
		version: APP_VERSION + (IS_DEV ? '-dev' : ''),
		modules: /** @type {Record<string, string>} */ (perfContext('modules') ?? {}),
		device: typeof navigator !== 'undefined' ? String(navigator.userAgent).slice(0, 300) : 'unknown',
		gpu: gpuName(),
		xr,
		refreshRate: refreshRate(),
		framebufferScale: xr ? XR_FRAMEBUFFER_SCALE : Number(renderer?.getPixelRatio?.()) || null,
		scene: /** @type {string | null} */ (perfContext('scene')),
		game: game && game !== 'untitled' ? game : null,
		startedAt,
		mode
	};
}

// ---------------------------------------------------------------- the light ring

/**
 * The last `ms` of the always-on light ring as a T1 document (a beacon window, a moment).
 * @param {number} [ms] @param {Partial<import('./tpprof.js').TpMeta>} [metaPatch]
 * @returns {import('./tpprof.js').Tpprof}
 */
export function lightWindow(ms = MOMENT_MS, metaPatch = {}) {
	const to = now() - ringPerf0;
	const full = {
		tpprof: /** @type {1} */ (TPPROF_VERSION),
		meta: currentMeta('light', ringEpoch0),
		frames: ring.frames(to - ms, to),
		events: ringEvents.filter((e) => e.t > to - ms && e.t <= to)
	};
	return windowOf(full, to - ms, to, metaPatch);
}

/** ring time (ms since the ring's origin) right now — a beacon remembers where it cut */
export function ringNow() {
	return now() - ringPerf0;
}

/**
 * The ring between two ring times (a beacon's consecutive windows never overlap).
 * @param {number} from @param {number} to @param {Partial<import('./tpprof.js').TpMeta>} [metaPatch]
 */
export function ringWindow(from, to, metaPatch = {}) {
	const full = {
		tpprof: /** @type {1} */ (TPPROF_VERSION),
		meta: currentMeta('light', ringEpoch0),
		frames: ring.frames(from, to),
		events: ringEvents.filter((e) => e.t > from && e.t <= to)
	};
	return windowOf(full, from, to, metaPatch);
}

// ---------------------------------------------------------------- recordings

/** @type {any} */
let captureTimer = null;
/** @type {any} */
let stopTimer = null;

/**
 * Start a recording. A second call while one runs returns the running one's id. A DETAILED
 * recording takes a per-object capture every CAPTURE_EVERY_MS and stops itself after
 * `durationMs` (default DETAILED_MS; 0 = run until stopped).
 * @param {{mode?: 'light' | 'detailed', name?: string, durationMs?: number}} [opts]
 * @returns {string} id
 */
export function startRecording(opts = {}) {
	startPerfRecorder();
	if (active) return active.id;
	const mode = opts.mode === 'detailed' ? 'detailed' : 'light';
	let gpuTimer = false;
	if (mode === 'detailed' && detailedProbe) {
		try {
			gpuTimer = !!detailedProbe.start().gpuTimer;
		} catch {
			gpuTimer = false;
		}
	}
	const startedAt = Date.now();
	active = {
		id: makeId(),
		mode,
		perf0: now(),
		meta: { ...currentMeta(mode, startedAt), name: opts.name || defaultName(mode, startedAt) },
		track: createTrack({ capacity: MAX_RECORD_FRAMES, cpu: mode === 'detailed' }),
		events: [],
		captures: [],
		notes: [],
		gpuTimer
	};
	noteEvent('mark', { text: 'recording started', mode });
	if (mode === 'detailed') {
		const rec = active;
		const loop = async () => {
			if (active !== rec) return;
			await captureNow();
			if (active === rec) captureTimer = setTimeout(loop, CAPTURE_EVERY_MS);
		};
		captureTimer = setTimeout(loop, 200);
		const ms = opts.durationMs ?? DETAILED_MS;
		if (ms > 0) stopTimer = setTimeout(() => active === rec && void stopRecording(), ms);
	}
	publishState();
	return active.id;
}

/** @param {string} mode @param {number} at */
function defaultName(mode, at) {
	const d = new Date(at);
	const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
	return `${mode === 'detailed' ? 'Detailed' : 'Light'} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Take a detailed capture now (per-object draw attribution over a few frames) into the
 * running detailed recording. Resolves the capture, or null (light mode / no probe).
 * @param {number} [frames]
 */
export async function captureNow(frames = 3) {
	if (!active || active.mode !== 'detailed' || !detailedProbe) return null;
	const rec = active;
	const at = now();
	const cap = await detailedProbe.capture(frames);
	if (!cap || active !== rec) return null;
	cap.t = Math.round((at - rec.perf0) * 10) / 10;
	rec.captures.push(cap);
	noteEvent('capture', { objects: cap.objects.length });
	return cap;
}

/**
 * Add a note (and optionally a screenshot data URL) at "now" to the running recording.
 * @param {string} text @param {string} [screenshot]
 */
export function noteNow(text, screenshot) {
	if (!active) return false;
	active.notes.push({ t: Math.round((now() - active.perf0) * 10) / 10, text: String(text).slice(0, 1000), ...(screenshot ? { screenshot } : {}) });
	return true;
}

/** Stop and save. Resolves the saved id, or null when nothing was recording. */
export async function stopRecording() {
	if (!active) return null;
	const rec = active;
	active = null;
	clearTimeout(captureTimer);
	clearTimeout(stopTimer);
	if (rec.mode === 'detailed' && detailedProbe) {
		try {
			detailedProbe.stop();
		} catch {
			/* a probe that fails to stop must not lose the recording */
		}
	}
	/** @type {import('./tpprof.js').Tpprof} */
	const doc = {
		tpprof: TPPROF_VERSION,
		meta: { ...rec.meta, durationMs: Math.round(now() - rec.perf0), ...(rec.mode === 'detailed' ? { gpuTimer: rec.gpuTimer } : {}) },
		frames: rec.track.frames(),
		events: rec.events
	};
	if (rec.captures.length) doc.captures = rec.captures;
	if (rec.notes.length) doc.notes = rec.notes;
	await saveRecording(rec.id, doc);
	publishState();
	return rec.id;
}

/** Is something recording, and how far along. */
export function recordingInfo() {
	if (!active) return null;
	return { id: active.id, mode: active.mode, startedAt: active.meta.startedAt, frames: active.track.length };
}

// ---------------------------------------------------------------- storage (IndexedDB, safeStorage-wrapped)

const INDEX_KEY = 'perf:index';
const REC_PREFIX = 'perf:rec:';
/** a write that failed lives here for the session (the safeStorage rule) @type {Map<string, any>} */
const memory = new Map();
let storeFailures = 0;

/** @param {string} key */
async function storeGet(key) {
	if (memory.has(key)) return memory.get(key);
	try {
		return (await idbGet(key)) ?? null;
	} catch {
		return null;
	}
}
/** @param {string} key @param {any} value */
async function storePut(key, value) {
	try {
		await idbPut(key, value);
		memory.delete(key);
		return true;
	} catch {
		storeFailures++;
		memory.set(key, value);
		return false;
	}
}
/** @param {string} key */
async function storeDelete(key) {
	memory.delete(key);
	try {
		await idbDelete(key);
	} catch {
		/* gone either way for this session */
	}
}

/**
 * @typedef {{id: string, name: string, mode: string, kind?: string, startedAt: number, durationMs: number,
 *   pinned: boolean, scene: string | null, game: string | null, xr: boolean, build: string,
 *   frames: number, summary: ReturnType<typeof summarize>}} RecordingRow
 */
/** @returns {Promise<RecordingRow[]>} */
async function readIndex() {
	const idx = await storeGet(INDEX_KEY);
	return Array.isArray(idx) ? idx : [];
}

/** @param {string} id @param {import('./tpprof.js').Tpprof} doc @returns {RecordingRow} */
function rowOf(id, doc) {
	const m = doc.meta;
	return {
		id,
		name: m.name || 'Recording',
		mode: m.mode,
		...(m.kind ? { kind: m.kind } : {}),
		startedAt: m.startedAt,
		durationMs: m.durationMs ?? 0,
		pinned: !!m.pinned,
		scene: m.scene ?? null,
		game: m.game ?? null,
		xr: !!m.xr,
		build: m.build,
		frames: doc.frames.length,
		summary: summarize(doc)
	};
}

/** @param {string} id @param {import('./tpprof.js').Tpprof} doc */
async function saveRecording(id, doc) {
	await storePut(REC_PREFIX + id, doc);
	let idx = (await readIndex()).filter((r) => r.id !== id);
	idx.unshift(rowOf(id, doc));
	// the oldest UNPINNED recordings go past the cap
	const unpinned = idx.filter((r) => !r.pinned);
	if (unpinned.length > MAX_SAVED) {
		const drop = new Set(unpinned.slice(MAX_SAVED).map((r) => r.id));
		for (const d of drop) await storeDelete(REC_PREFIX + d);
		idx = idx.filter((r) => !drop.has(r.id));
	}
	await storePut(INDEX_KEY, idx);
	savedCount = idx.length;
	return id;
}

let savedCount = 0;
let version = 0;
function publishState() {
	version++;
	perfState.set({ recording: recordingInfo(), saved: savedCount, version });
}

/** Saved recordings, newest first (rows only — no frames). */
export async function listRecordings() {
	const idx = await readIndex();
	savedCount = idx.length;
	return idx;
}

/** One saved recording, whole. @param {string} id @returns {Promise<import('./tpprof.js').Tpprof | null>} */
export async function getRecording(id) {
	return /** @type {any} */ (await storeGet(REC_PREFIX + id));
}

/** @param {string} id */
export async function deleteRecording(id) {
	await storeDelete(REC_PREFIX + id);
	const idx = (await readIndex()).filter((r) => r.id !== id);
	await storePut(INDEX_KEY, idx);
	savedCount = idx.length;
	publishState();
	return true;
}

/** @param {string} id @param {(doc: import('./tpprof.js').Tpprof) => void} edit */
async function editRecording(id, edit) {
	const doc = await getRecording(id);
	if (!doc) return false;
	edit(doc);
	await saveRecording(id, doc);
	publishState();
	return true;
}

/** @param {string} id @param {string} name */
export function renameRecording(id, name) {
	return editRecording(id, (doc) => {
		doc.meta.name = String(name).slice(0, 120) || doc.meta.name;
	});
}

/** @param {string} id @param {boolean} on */
export function pinRecording(id, on) {
	return editRecording(id, (doc) => {
		doc.meta.pinned = !!on;
	});
}

/** A saved recording as a `.tpprof` Blob (gzip JSON). @param {string} id */
export async function exportRecording(id) {
	const doc = await getRecording(id);
	if (!doc) return null;
	const bytes = encodeTpprof(doc);
	return new Blob([/** @type {BlobPart} */ (bytes)], { type: 'application/x-tpprof' });
}

/**
 * Bring a `.tpprof` (or a plain-JSON T1 document, e.g. a beacon export) in as a saved
 * recording. Throws the decoder's readable message on a bad file.
 * @param {Blob | ArrayBuffer | Uint8Array | string} input @returns {Promise<string>} the new id
 */
export async function importRecording(input) {
	let data = input;
	if (typeof Blob !== 'undefined' && input instanceof Blob) data = new Uint8Array(await input.arrayBuffer());
	const doc = decodeTpprof(/** @type {any} */ (data));
	delete doc.summary;
	const id = makeId();
	if (!doc.meta.name) doc.meta.name = 'Imported ' + new Date(doc.meta.startedAt).toISOString().slice(0, 19).replace('T', ' ');
	await saveRecording(id, doc);
	publishState();
	return id;
}

/**
 * Save an already-built document as a recording (a "Report this moment" keeps a local copy).
 * @param {import('./tpprof.js').Tpprof} doc @returns {Promise<string>}
 */
export async function saveDocument(doc) {
	const id = makeId();
	await saveRecording(id, doc);
	publishState();
	return id;
}

/** A marker in the ring and the running recording, from code that holds the recorder. @param {string} text */
export function mark(text) {
	noteEvent('mark', { text: String(text).slice(0, 200) });
}

// ---------------------------------------------------------------- measuring itself

/** Turn hot-path self-timing on/off (a suite's overhead table). Resets the counters. @param {boolean} on */
export function measureOverhead(on) {
	overheadOn = !!on;
	overheadSum = 0;
	overheadFrames = 0;
	overheadMax = 0;
}
/** mean / max ms the recorder spent per frame since `measureOverhead(true)` */
export function perfOverhead() {
	return { frames: overheadFrames, meanMs: overheadFrames ? overheadSum / overheadFrames : 0, maxMs: overheadMax };
}

/** For the suite and the diagnostics bundle. */
export function recorderDebug() {
	return { ringFrames: ring.length, ringEvents: ringEvents.length, recording: recordingInfo(), storeFailures, memoryKeys: [...memory.keys()], phases: CPU_PHASES, probe: !!detailedProbe };
}

/** The `perf` API as one object (the debug hook, the SDK, the Profiler tab). */
export const perf = {
	record: startRecording,
	stop: stopRecording,
	list: listRecordings,
	get: getRecording,
	delete: deleteRecording,
	rename: renameRecording,
	pin: pinRecording,
	export: exportRecording,
	import: importRecording,
	mark,
	capture: captureNow,
	note: noteNow,
	lightWindow,
	state: perfState,
	onChange: (/** @type {(s: any) => void} */ fn) => perfState.subscribe(fn)
};
