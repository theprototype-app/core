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

/** end timestamp of the current trackpad-swipe gesture (see isTrackpadSwipe) */
let lastSwipeTs = 0;

/** Trackpad-swipe detector. Classic wheels tick in coarse (>=40px or line-mode)
 *  vertical jumps; trackpads emit fine pixel deltas, usually with a horizontal
 *  component. STATEFUL: once a swipe is recognized, events arriving within the
 *  gesture window stay a PAN even when a fast flick produces big deltas — the
 *  per-event heuristic alone let mid-pan flicks fall through to zoom.
 *  @param {WheelEvent} e */
function isTrackpadSwipe(e) {
	const mode = get(trackpadMode);
	if (mode === 'off') return false;
	if (mode === 'on') return true;
	if (e.deltaMode !== 0) return false;
	const now = performance.now();
	if (now - lastSwipeTs < 250) return true; // continuation of the active gesture
	return e.deltaX !== 0 || Math.abs(e.deltaY) < 40;
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

/** @param {WheelEvent} e */
function onWheel(e) {
	const canvas = get(globalRenderer)?.domElement;
	const overCanvas = !!canvas && e.target === canvas;
	// the canvas must sit OUTSIDE the body's pan-x/pan-y guard: Chromium
	// axis-latches scroll gestures over pan-x/pan-y regions (two-finger pans
	// lock to one axis unless started diagonally). Idempotent, set lazily
	// because the renderer doesn't exist at install time.
	if (canvas && canvas.style.touchAction !== 'none') canvas.style.touchAction = 'none';
	if (e.ctrlKey) {
		// pinch / ctrl+wheel: the PAGE must never zoom. Over the canvas the event
		// reaches OrbitControls (which dollies) UNLESS pinch zoom is disabled.
		if (!get(allowBrowserZoom)) e.preventDefault();
		if (overCanvas && !get(pinchZoomEnabled)) e.stopPropagation();
		return;
	}
	if (!overCanvas) return; // UI panels keep native scrolling
	if (document.pointerLockElement) return; // play mode owns the pointer
	if (!get(panEnabled)) return; // pan off -> wheel zoom; right-drag still pans
	if (!isTrackpadSwipe(e)) return; // classic wheel -> OrbitControls dolly
	lastSwipeTs = performance.now(); // extend the gesture window
	e.preventDefault();
	e.stopPropagation(); // capture phase: OrbitControls never sees the pan swipe
	const dir = get(reversePan) ? 1 : -1; // default = content-follows-fingers
	panCamera(dir * e.deltaX, dir * e.deltaY);
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
