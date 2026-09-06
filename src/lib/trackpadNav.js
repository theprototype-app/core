// Trackpad navigation + page-zoom guards (launch polish, user fork 2026-07-30):
// - two-finger trackpad swipes PAN the editor camera (auto-detected; classic mouse
//   wheels keep zooming through OrbitControls untouched; shift+wheel pans too since
//   browsers map it to deltaX)
// - pinch (browsers deliver it as ctrlKey+wheel) must NEVER zoom the PAGE — over
//   the canvas OrbitControls still dollies the camera as before, over UI it is
//   swallowed; an accessibility toggle gives browser zoom back
// - mobile: browser pinch-zoom is suppressed on the UI chrome (body touch-action
//   + iOS gesturestart); the viewport canvas keeps its own touch gestures
// Store-only module — reads scene refs lazily inside the handlers, so it can be
// started from App.svelte before the scene exists. LOCAL prefs, nothing replicates.
import { get, writable } from 'svelte/store';
import { globalCamera, globalRenderer, orbitControls } from '../stores/sceneStore';
// 19-A P7b: while a proportional mesh drag is live the wheel resizes the falloff
// radius (proportional.js owns that listener). Both listeners sit on WINDOW in
// the capture phase, where stopPropagation cannot stop a same-node sibling — so
// this one has to ask and stand down itself. proportional is a svelte/store-only
// leaf: no cycle.
import { proportionalWheelActive } from './proportional';

/** How two-finger swipes are treated: 'auto' (heuristic) | 'on' | 'off'.
 *  @type {import('svelte/store').Writable<string>} */
export const trackpadMode = writable(
	typeof localStorage !== 'undefined' ? localStorage.getItem('trackpadMode') || 'auto' : 'auto'
);
trackpadMode.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('trackpadMode', value);
});

/** Accessibility escape hatch: let the BROWSER zoom the page again (pinch /
 *  ctrl+wheel over UI, mobile pinch). Off by default — pinch is an app gesture.
 *  @type {import('svelte/store').Writable<boolean>} */
export const allowBrowserZoom = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('allowBrowserZoom') === 'true'
);
allowBrowserZoom.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('allowBrowserZoom', String(value));
});

/** Flip the two-finger pan direction. The DEFAULT (off) is content-follows-
 *  fingers, the user-picked direction; on = the opposite convention.
 *  @type {import('svelte/store').Writable<boolean>} */
export const reversePan = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('trackpadReversePan') === 'true'
);
reversePan.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('trackpadReversePan', String(value));
});

/** Two-finger pan on/off (default ON). Off = trackpad swipes fall through to the
 *  wheel zoom and panning stays available via right-click drag (OrbitControls).
 *  @type {import('svelte/store').Writable<boolean>} */
export const panEnabled = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('trackpadPanEnabled') !== 'false'
);
panEnabled.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('trackpadPanEnabled', String(value));
});

/** Pinch-to-zoom on/off (default ON). Off = pinch does nothing to the camera
 *  (the page-zoom guard still applies); zoom stays on the mouse wheel.
 *  @type {import('svelte/store').Writable<boolean>} */
export const pinchZoomEnabled = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('trackpadPinchZoom') !== 'false'
);
pinchZoomEnabled.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('trackpadPinchZoom', String(value));
});

// ---- 24-A2: the wheel classifier ------------------------------------------------
//
// THE FINDING: the old test was MAGNITUDE — a pixel-mode event under 40px was "a
// trackpad" and PANNED. Linux Chromium/CEF with libinput's high-resolution scrolling
// (the Steam Deck's trackpad-as-wheel, Logitech hi-res wheels, many laptops) emits
// 3-15px ticks, so every notch panned and the dolly never fired ("scrolling moving
// up/down camera does not work"). Firefox delivers line mode and was fine.
//
// THE RULE NOW: DEVICE SIGNATURE, not size. A real wheel is a `wheelDeltaY` multiple of
// 120 (Chromium/WebKit's legacy field), or an integer vertical-only delta of notch size,
// or a SPARSE stream — one event, then silence. A trackpad is dense, often two-axis,
// fractional. The thresholds are exported CONSTANTS so the Settings ▸ Controls readout
// (`lastWheelEvents`, the Deck's own numbers) can tune them without a refactor.
// `trackpadMode` 'on'/'off' still overrides everything.
//
// The one honest ambiguity is the FIRST event of a vertical-only stream: a hi-res
// wheel notch and the first sample of a two-finger swipe look identical at that
// instant (small, deltaX 0). Deciding "wheel" there would dolly one step at the start
// of every Mac trackpad swipe, so that event is HELD for `TRACKPAD_DENSE_MS`: a
// follow-up inside the window makes it a swipe (both samples pan), silence makes it a
// notch and it is REPLAYED to the canvas for OrbitControls. ~20ms of latency on the
// first notch only; nothing else waits.

/** Chromium/WebKit report a real wheel notch as `wheelDeltaY` in multiples of this. */
export const WHEEL_NOTCH = 120;
/** A vertical-only INTEGER delta at/over this many px is a wheel whatever the cadence. */
export const WHEEL_MIN_INTEGER_PX = 40;
/** Events closer than this are one dense stream (a swipe); a lone event = a notch. */
export const TRACKPAD_DENSE_MS = 20;
/** Continuation window: once a gesture is classified, later events keep the verdict. */
export const GESTURE_WINDOW_MS = 250;
/** Diagnostics ring length (Settings ▸ Controls ▸ Wheel diagnostics). */
export const WHEEL_LOG_SIZE = 8;

/**
 * @typedef {{ t: number, dt: number, deltaMode: number, deltaX: number, deltaY: number,
 *   wheelDeltaY: number | null, ctrl: boolean, kind: 'wheel'|'trackpad'|'pinch', why: string }} WheelSample
 */

/** The last few wheel events over the canvas, newest LAST — the readout that turns a
 *  "scrolling does nothing on my machine" report into numbers in one minute.
 *  @type {import('svelte/store').Writable<WheelSample[]>} */
export const lastWheelEvents = writable([]);

/** @param {WheelSample} sample */
function logWheel(sample) {
	lastWheelEvents.update((list) => {
		const next = [...list, sample];
		return next.length > WHEEL_LOG_SIZE ? next.slice(next.length - WHEEL_LOG_SIZE) : next;
	});
}

/** timestamp of the previous over-canvas wheel event (cadence) */
let lastWheelTs = 0;
/** what the previous event was classified as, for the continuation rule */
/** @type {'wheel'|'trackpad'|null} */
let lastKind = null;
/** a first vertical-only event waiting to learn whether a stream follows */
/** @type {{ e: WheelEvent, t: number, timer: any } | null} */
let held = null;
/** set on a replayed event so the capture listener lets it through to OrbitControls */
const REPLAY = '__tpWheelReplay';

/**
 * Signature verdict for one event, or null when it is ambiguous (decided by cadence).
 * Pure: no state read beyond the constants.
 * @param {WheelEvent} e
 * @returns {{ kind: 'wheel'|'trackpad', why: string } | null}
 */
export function classifyWheelSignature(e) {
	if (e.deltaMode !== 0) return { kind: 'wheel', why: 'line/page mode' };
	const wd = /** @type {any} */ (e).wheelDeltaY;
	if (typeof wd === 'number' && wd !== 0 && wd % WHEEL_NOTCH === 0) return { kind: 'wheel', why: 'notch multiple' };
	if (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= WHEEL_MIN_INTEGER_PX)
		return { kind: 'wheel', why: 'integer ≥ ' + WHEEL_MIN_INTEGER_PX + 'px' };
	if (e.deltaX !== 0) return { kind: 'trackpad', why: 'two-axis' };
	return null;
}

/**
 * The full verdict, with mode override and cadence. `'hold'` = ambiguous first event.
 * @param {WheelEvent} e @param {number} now
 * @returns {{ kind: 'wheel'|'trackpad'|'hold', why: string }}
 */
function classifyWheel(e, now) {
	const mode = get(trackpadMode);
	if (mode === 'off') return { kind: 'wheel', why: 'mode: zoom' };
	if (mode === 'on') return { kind: 'trackpad', why: 'mode: pan' };
	if (e.deltaMode !== 0) return { kind: 'wheel', why: 'line/page mode' };
	const gap = now - lastWheelTs;
	// a LIVE swipe keeps panning whatever one sample looks like: a fast flick mid-gesture
	// produces a big integer vertical delta (the trackpad-nav suite's case, user-reported
	// as "mid-pan flicks zoomed"), and a macOS trackpad's 40px sample has wheelDeltaY
	// -120 — both would read as a wheel by signature alone
	if (lastKind === 'trackpad' && gap < GESTURE_WINDOW_MS) return { kind: 'trackpad', why: 'gesture continues' };
	const signature = classifyWheelSignature(e);
	if (signature) return signature;
	if (lastKind === 'wheel' && gap < GESTURE_WINDOW_MS) return { kind: 'wheel', why: 'notch stream continues' };
	// vertical-only, small, fractional or not, first after silence: cadence decides
	return { kind: 'hold', why: 'first vertical sample' };
}

/** @param {WheelEvent} e @param {number} now @param {'wheel'|'trackpad'} kind @param {string} why */
function sampleOf(e, now, kind, why) {
	const wd = /** @type {any} */ (e).wheelDeltaY;
	return {
		t: now,
		dt: lastWheelTs ? Math.round(now - lastWheelTs) : 0,
		deltaMode: e.deltaMode,
		deltaX: e.deltaX,
		deltaY: e.deltaY,
		wheelDeltaY: typeof wd === 'number' ? wd : null,
		ctrl: !!e.ctrlKey,
		kind,
		why
	};
}

/** Screen-space pan of the orbit camera + target (the same math OrbitControls
 *  uses internally, which it does not expose). @param {number} dx @param {number} dy */
function panCamera(dx, dy) {
	const camera = get(globalCamera);
	const controls = get(orbitControls);
	const el = get(globalRenderer)?.domElement;
	if (!camera || !controls || controls.enabled === false || !el) return;
	// vectors are cloned off the camera so this file needs no `three` import
	// (fresh clones per event — shared temp vectors corrupt across helper calls)
	const distance = camera.position.distanceTo(controls.target);
	const targetDistance = distance * Math.tan(((camera.fov / 2) * Math.PI) / 180);
	const panX = (2 * dx * targetDistance) / el.clientHeight;
	const panY = (2 * dy * targetDistance) / el.clientHeight;
	const pan = camera.position
		.clone()
		.setFromMatrixColumn(camera.matrix, 0)
		.multiplyScalar(-panX)
		.add(camera.position.clone().setFromMatrixColumn(camera.matrix, 1).multiplyScalar(panY));
	camera.position.add(pan);
	controls.target.add(pan);
}

/** Pan by one event's deltas (direction pref applied). @param {WheelEvent} e */
function panBy(e) {
	const dir = get(reversePan) ? 1 : -1; // default = content-follows-fingers
	panCamera(dir * e.deltaX, dir * e.deltaY);
}

/** A2.3: once ever, the first time the classifier turns a wheel into a pan in auto
 *  mode, point at the one-click override. `wheelHintSeen` in localStorage. */
function maybeWheelHint() {
	if (typeof localStorage === 'undefined' || localStorage.getItem('wheelHintSeen')) return;
	localStorage.setItem('wheelHintSeen', '1');
	import('../stores/appStore').then((m) =>
		m.showToast('Wheel panned instead of zooming? Viewport menu ▸ View ▸ Mouse wheel switches it')
	);
}

/** Replay a held event to the canvas so OrbitControls dollies exactly as it would have.
 *  @param {WheelEvent} e */
function replayToCanvas(e) {
	const canvas = get(globalRenderer)?.domElement;
	if (!canvas) return;
	const copy = new WheelEvent('wheel', {
		deltaX: e.deltaX,
		deltaY: e.deltaY,
		deltaZ: e.deltaZ,
		deltaMode: e.deltaMode,
		clientX: e.clientX,
		clientY: e.clientY,
		ctrlKey: e.ctrlKey,
		shiftKey: e.shiftKey,
		altKey: e.altKey,
		metaKey: e.metaKey,
		bubbles: true,
		cancelable: true
	});
	/** @type {any} */ (copy)[REPLAY] = true;
	canvas.dispatchEvent(copy);
}

/** The held first sample turned out to be alone: a wheel notch. */
function releaseHeldAsWheel() {
	const h = held;
	held = null;
	if (!h) return;
	lastKind = 'wheel';
	logWheel(sampleOf(h.e, h.t, 'wheel', 'held → alone = notch'));
	replayToCanvas(h.e);
}

/** @param {WheelEvent} e */
function onWheel(e) {
	if (/** @type {any} */ (e)[REPLAY]) return; // our own replay: straight to OrbitControls
	// a live proportional drag owns the wheel (radius resize) — never pan under it
	if (proportionalWheelActive()) return;
	const canvas = get(globalRenderer)?.domElement;
	const overCanvas = !!canvas && e.target === canvas;
	// the canvas must sit OUTSIDE the body's pan-x/pan-y guard: Chromium
	// axis-latches scroll gestures over pan-x/pan-y regions (two-finger pans
	// lock to one axis unless started diagonally). Idempotent, set lazily
	// because the renderer doesn't exist at install time.
	if (canvas && canvas.style.touchAction !== 'none') canvas.style.touchAction = 'none';
	const now = performance.now();
	if (e.ctrlKey) {
		// pinch / ctrl+wheel: the PAGE must never zoom. Over the canvas the event
		// reaches OrbitControls (which dollies) UNLESS pinch zoom is disabled.
		if (!get(allowBrowserZoom)) e.preventDefault();
		if (overCanvas && !get(pinchZoomEnabled)) e.stopPropagation();
		if (overCanvas) {
			logWheel({ ...sampleOf(e, now, 'wheel', 'ctrl: pinch/zoom'), kind: 'pinch' });
			lastWheelTs = now;
		}
		return;
	}
	if (!overCanvas) return; // UI panels keep native scrolling
	if (document.pointerLockElement) return; // play mode owns the pointer
	if (!get(panEnabled)) {
		// pan off -> wheel zoom; right-drag still pans
		logWheel(sampleOf(e, now, 'wheel', 'two-finger pan off'));
		lastWheelTs = now;
		return;
	}
	const verdict = classifyWheel(e, now);
	if (held) {
		// a second sample inside the dense window: the held one was a swipe's first
		// sample — pan both, and this one is trackpad whatever its own signature said
		const h = held;
		clearTimeout(h.timer);
		held = null;
		// (the hold timer releases at TRACKPAD_DENSE_MS, so a follow-up that finds one
		// still held IS inside the dense window — the wide-gap branch below is a guard
		// against a late timer, nothing more)
		if (now - h.t < TRACKPAD_DENSE_MS || verdict.kind === 'trackpad' || verdict.kind === 'hold') {
			lastKind = 'trackpad';
			logWheel(sampleOf(h.e, h.t, 'trackpad', 'held → stream = swipe'));
			lastWheelTs = h.t;
			panBy(h.e);
			logWheel(sampleOf(e, now, 'trackpad', 'dense follow-up'));
			lastWheelTs = now;
			e.preventDefault();
			e.stopPropagation();
			panBy(e);
			maybeWheelHint();
			return;
		}
		// the gap was wider than the window: the held one was a notch after all
		lastKind = 'wheel';
		logWheel(sampleOf(h.e, h.t, 'wheel', 'held → alone = notch'));
		lastWheelTs = h.t;
		replayToCanvas(h.e);
	}
	if (verdict.kind === 'hold') {
		e.preventDefault();
		e.stopPropagation(); // OrbitControls must not dolly a swipe's first sample
		held = { e, t: now, timer: setTimeout(releaseHeldAsWheel, TRACKPAD_DENSE_MS) };
		lastWheelTs = now;
		return;
	}
	logWheel(sampleOf(e, now, verdict.kind, verdict.why));
	lastWheelTs = now;
	lastKind = verdict.kind;
	if (verdict.kind === 'wheel') return; // classic wheel -> OrbitControls dolly
	e.preventDefault();
	e.stopPropagation(); // capture phase: OrbitControls never sees the pan swipe
	panBy(e);
	if (get(trackpadMode) === 'auto') maybeWheelHint();
}

/** iOS Safari fires proprietary gesture events for pinch — the only reliable
 *  way to stop page zoom there. @param {Event} e */
function onGestureStart(e) {
	if (!get(allowBrowserZoom)) e.preventDefault();
}

let installed = false;

/** Install the window-level listeners once (App.svelte boot). */
export function startTrackpadNav() {
	if (installed || typeof window === 'undefined') return;
	installed = true;
	window.addEventListener('wheel', onWheel, { passive: false, capture: true });
	document.addEventListener('gesturestart', onGestureStart, { passive: false });
	allowBrowserZoom.subscribe((allow) => {
		// pan-x pan-y lets panels scroll but removes the browser's pinch-zoom and
		// double-tap-zoom on the chrome; the canvas manages its own touch-action
		document.body.style.touchAction = allow ? '' : 'pan-x pan-y';
	});
}
