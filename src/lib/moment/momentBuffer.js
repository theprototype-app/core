// 95 SM1 — THE MOMENT BUFFER: while you play, the last 10 s of the GAME VIEW, kept so a moment can
// be shared after it happened (Share a moment, SM2).
//
// What it records: the 3D view's drawing buffer and nothing else — no editor UI, no HUD DOM, no
// chat, and never anybody's voice or microphone (there is no audio path at all). It records only in
// Play, never in VR, never on a device short of memory, never when this device's setting is off, and
// for a published game's player only when the game's author allows it (SM3). Leaving Play forgets
// everything. Nothing is sent anywhere: the frames live in this tab until the person makes a file.
//
// How a frame is kept: the recorder's capture stage (RecordingDriver → recorder.js) calls the tap
// right after a render, while the drawing buffer still holds the frame. At most MOMENT_FPS times a
// second the tap asks `createImageBitmap` for a SCALED copy (a GPU-side snapshot; the call returns at
// once) and posts it to a worker that writes a JPEG; the ring keeps the blobs. Main-thread cost per
// frame is metered (SM3: ≤ 1 ms on desktop) and a device that runs over its guard turns the buffer
// off for the visit. A browser without OffscreenCanvas falls back to a 2D canvas + toBlob.
//
// Loaded LAZILY on the first Play (MomentHost.svelte), so none of it is in the boot graph.
import { get } from 'svelte/store';
import { globalRenderer, isLocked, isVRMode } from '../../stores/sceneStore';
import { embedMode } from '../playMode';
import { scenePlay } from '../scenePhysics';
import { isPhoneDevice } from '../qualityGovernor';
import { onInput } from '../inputRuntime';
import { setMomentTap } from '../recording/recorder.js';
import { registerDebugHook } from '../debugHookRegistry.js';
import { momentRecording, momentStatus, momentOpen, openMoment, MOMENT_KEY, MOMENT_PAD_BUTTON } from './momentStores.js';
import {
	createMomentRing,
	createCostMeter,
	momentBlocker,
	momentFrameSize,
	isLowMemory,
	MOMENT_FPS,
	MOMENT_SECONDS,
	MOMENT_JPEG_QUALITY,
	MOMENT_PHONE_GUARD_MS,
	MOMENT_DESKTOP_GUARD_MS,
	FRAME_COST_WINDOW
} from './momentCore.js';

/** captures being encoded at most (a slow encoder skips captures rather than queueing them) */
const MAX_IN_FLIGHT = 4;

/** @type {ReturnType<typeof createMomentRing<Blob>>} */
const ring = createMomentRing();
/** every rendered frame's main-thread cost (0-ish on frames that capture nothing) */
const meter = createCostMeter(FRAME_COST_WINDOW);
/** the cost of the frames that DID capture */
const captureMeter = createCostMeter(FRAME_COST_WINDOW);
const phone = isPhoneDevice();

let started = false;
/** the tap is armed (eligible and not frozen) */
let armed = false;
/** the frame-cost guard tripped: off for this visit */
let slow = false;
let lastRenderFrame = -1;
let inFlight = 0;
let nextId = 1;
/** @type {Worker | null} */
let worker = null;
/** @type {Map<number, number>} capture id -> its time */
const pendingTimes = new Map();
/** @type {'worker' | 'canvas' | 'none'} */
let path = 'none';
/** 2D fallback canvas @type {HTMLCanvasElement | null} */
let small = null;
/** @type {{w: number, h: number}} */
let size = { w: 0, h: 0 };
/** how many captures failed (the e2e and the debug read) */
let failures = 0;
/** frames dropped because the encoder was busy */
let skipped = 0;
let lastError = '';

function capturePath() {
	if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function' && 'convertToBlob' in OffscreenCanvas.prototype && typeof Worker === 'function') return 'worker';
	if (typeof document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && 'toBlob' in HTMLCanvasElement.prototype) return 'canvas';
	return 'none';
}

/** why the buffer may not run now ('' = it may) */
function blocker() {
	return momentBlocker({
		playing: get(isLocked) === true,
		vr: !!get(isVRMode),
		player: !!get(embedMode),
		sceneAllows: get(scenePlay)?.moments === true,
		setting: !!get(momentRecording),
		lowMemory: typeof navigator !== 'undefined' && isLowMemory(navigator),
		slow,
		capture: path !== 'none'
	});
}

function ensureWorker() {
	if (worker || path !== 'worker') return;
	try {
		worker = new Worker(new URL('./momentEncode.worker.js', import.meta.url), { type: 'module' });
		worker.onmessage = (e) => {
			const { id, blob, error } = e.data || {};
			const t = pendingTimes.get(id);
			pendingTimes.delete(id);
			inFlight = Math.max(0, inFlight - 1);
			if (error || !blob || t === undefined) {
				failures++;
				lastError = String(error || 'no frame');
				return;
			}
			// a frame that finished after the buffer stood down is dropped, not kept
			if (armed) ring.push({ t, bytes: blob.size, data: blob });
		};
		worker.onerror = () => {
			// the worker could not start (a CSP, an old engine): fall back to the 2D canvas
			worker?.terminate();
			worker = null;
			path = 'canvas';
			inFlight = 0;
			pendingTimes.clear();
		};
	} catch {
		path = 'canvas';
	}
}

/** the capture stage tap: right after a render, before the drawing buffer is cleared */
function tap() {
	if (!armed) return;
	const t0 = performance.now();
	const renderer = /** @type {any} */ (get(globalRenderer));
	const dom = renderer?.domElement;
	if (!dom) return;
	const frameNo = renderer.info?.render?.frame ?? -1;
	if (frameNo === lastRenderFrame) return; // nothing new was drawn
	lastRenderFrame = frameNo;
	let captured = false;
	const t = t0 / 1000;
	if (ring.due(t)) {
		if (inFlight >= MAX_IN_FLIGHT) skipped++;
		else {
			captured = true;
			capture(dom, t);
		}
	}
	const cost = performance.now() - t0;
	meter.add(cost);
	if (captured) captureMeter.add(cost);
	guard();
}

/** @param {HTMLCanvasElement} dom @param {number} t */
function capture(dom, t) {
	const want = momentFrameSize(dom.width, dom.height, phone);
	if (want.w !== size.w || want.h !== size.h) {
		size = want;
		ring.clear(); // a resize mid-take: frames of two sizes cannot share one file
	}
	try {
		if (path === 'worker') {
			ensureWorker();
			if (path === 'worker' && worker) {
				const id = nextId++;
				const w = worker;
				const { w: sw, h: sh } = size;
				inFlight++;
				pendingTimes.set(id, t);
				createImageBitmap(dom, { resizeWidth: sw, resizeHeight: sh, resizeQuality: 'low' }).then(
					(bitmap) => {
						if (worker !== w) {
							bitmap.close();
							inFlight = Math.max(0, inFlight - 1);
							pendingTimes.delete(id);
							return;
						}
						w.postMessage({ id, bitmap, w: sw, h: sh, quality: MOMENT_JPEG_QUALITY }, [bitmap]);
					},
					(e) => {
						inFlight = Math.max(0, inFlight - 1);
						pendingTimes.delete(id);
						failures++;
						lastError = String(e?.message || e);
					}
				);
				return;
			}
		}
		// the 2D fallback: copy (scaled) now, encode asynchronously
		if (!small) small = document.createElement('canvas');
		if (small.width !== size.w || small.height !== size.h) {
			small.width = size.w;
			small.height = size.h;
		}
		const ctx = small.getContext('2d', { alpha: false });
		if (!ctx) throw new Error('no 2D context');
		ctx.drawImage(dom, 0, 0, size.w, size.h);
		inFlight++;
		small.toBlob(
			(blob) => {
				inFlight = Math.max(0, inFlight - 1);
				if (!blob) {
					failures++;
					return;
				}
				if (armed) ring.push({ t, bytes: blob.size, data: blob });
			},
			'image/jpeg',
			MOMENT_JPEG_QUALITY
		);
	} catch (e) {
		failures++;
		lastError = String(/** @type {any} */ (e)?.message || e);
	}
}

/** SM3: the frame-cost guard — a device whose mean cost runs over its line stops recording */
function guard() {
	if (meter.samples() < FRAME_COST_WINDOW) return;
	const line = phone ? MOMENT_PHONE_GUARD_MS : MOMENT_DESKTOP_GUARD_MS;
	if (meter.mean() > line) {
		slow = true;
		console.info(`[moment] the last-10-s buffer turned off: ${meter.mean().toFixed(2)} ms a frame (over ${line} ms)`);
		update();
	}
}

/** arm or disarm the tap from the current facts */
function update() {
	const reason = blocker();
	const frozen = get(momentOpen);
	const want = reason === '' && !frozen;
	if (want && !armed) {
		armed = true;
		lastRenderFrame = -1;
		meter.reset();
		setMomentTap(tap);
	} else if (!want && armed) {
		armed = false;
		setMomentTap(null);
		// standing down for any reason but the preview (which took the frames) forgets them
		if (!frozen) ring.clear();
	}
	if (reason !== '' && !frozen) {
		ring.clear();
		// out of Play: the encoder goes too (a new one starts with the next Play)
		if (reason === 'idle' && worker) {
			worker.terminate();
			worker = null;
			inFlight = 0;
			pendingTimes.clear();
		}
	}
	publish(reason);
}

/** @param {string} [reason] */
function publish(reason = blocker()) {
	const on = armed;
	const seconds = Math.round(Math.min(MOMENT_SECONDS, ring.span() + (ring.count() ? 1 / MOMENT_FPS : 0)) * 10) / 10;
	const now = get(momentStatus);
	if (now.on !== on || now.reason !== reason || now.seconds !== seconds || !now.loaded) momentStatus.set({ on, reason, seconds, loaded: true });
}

/** F8 in Play (the editor's shortcut table stands down in Play, so the key is heard here) */
function onKey(/** @type {KeyboardEvent} */ e) {
	if (e.code !== MOMENT_KEY || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
	if (get(isLocked) !== true || get(momentOpen)) return;
	if (openMoment()) {
		e.preventDefault();
		e.stopPropagation();
	}
}

/** Start following Play (idempotent). */
export function startMomentBuffer() {
	if (started || typeof window === 'undefined') return;
	started = true;
	path = capturePath();
	for (const s of [isLocked, isVRMode, embedMode, scenePlay, momentRecording, momentOpen]) s.subscribe(() => update());
	window.addEventListener('keydown', onKey, true);
	onInput((kind, code) => {
		if (kind === 'down' && code === MOMENT_PAD_BUTTON && get(isLocked) === true && !get(momentOpen)) openMoment();
	});
	// age the window in a quiet stretch and keep the status line current
	setInterval(() => {
		if (armed) ring.age(performance.now() / 1000);
		publish();
	}, 500);
	registerDebugHook('momentBuffer', momentDebugApi);
}

/**
 * SM2: hand the kept frames to the preview (the buffer is frozen while it is open, so the moment
 * does not roll away under the trim). Oldest first; `t` in seconds.
 * @returns {{frames: {t: number, bytes: number, data: Blob}[], size: {w: number, h: number}, fps: number}}
 */
export function takeMoment() {
	return { frames: ring.take(), size: { ...size }, fps: MOMENT_FPS };
}

/**
 * The preview closed without using up the moment: give the frames back, so pressing again a moment
 * later still reaches back 10 s. Only while the buffer is still allowed to hold them.
 * @param {{t: number, bytes: number, data: Blob}[]} frames
 */
export function returnMoment(frames) {
	if (blocker() !== '' || !frames?.length) return;
	const kept = ring.take();
	for (const f of frames) ring.push(f);
	for (const f of kept) ring.push(f);
	ring.age(performance.now() / 1000);
	publish();
}

/** the debug hook (e2e + the SM3 measurements) */
export const momentDebugApi = {
	state: () => ({
		armed,
		reason: blocker(),
		path,
		slow,
		phone,
		frames: ring.count(),
		bytes: ring.bytes(),
		span: ring.span(),
		size: { ...size },
		inFlight,
		failures,
		skipped,
		lastError,
		cost: { mean: meter.mean(), p95: meter.p95(), max: meter.max(), samples: meter.samples() },
		captureCost: { mean: captureMeter.mean(), p95: captureMeter.p95(), max: captureMeter.max(), samples: captureMeter.samples() }
	}),
	/** force a capture path for a measurement ('worker' | 'canvas') @param {'worker'|'canvas'} p */
	setPath(p) {
		path = p;
		ring.clear();
		meter.reset();
		captureMeter.reset();
	},
	/** clear the guard latch (a measurement run) */
	resetGuard() {
		slow = false;
		meter.reset();
		captureMeter.reset();
		update();
	},
	takeMoment,
	returnMoment
};
