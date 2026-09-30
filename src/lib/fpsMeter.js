// 31 (K3) G3 — SHOW FPS. "All of them should be able to show FPS when I want to debug."
//
// One reading for both places it is shown: the desktop corner counter (FpsCounter.svelte)
// and the VR top strip + wrist card (vrGamePanel). Two frame SOURCES, because there are two
// frame loops: on the desktop, sceneBudget's own rAF loop (its frame observer); in a
// headset the window's rAF does not drive the frames, so the VR game panel — called once
// per XR frame by vrGameInput's frame hook — notes each frame with its timestamp. Whichever
// source is live wins; the other is ignored while an XR session presents.
//
// The draw calls / triangles are sceneBudget's per-display-frame totals (sampled ~1/s).
// A LEAF: svelte/store + sceneBudget (itself a leaf) + sceneStore.
import { writable, get } from 'svelte/store';
import { registerFrameObserver, sceneMetrics } from './sceneBudget';
import { globalRenderer } from '../stores/sceneStore';

/** @typedef {{fps: number | null, ms: number | null, calls: number | null, tris: number | null, source: 'desktop' | 'xr' | null}} FpsReading */

/** The reading, republished every PUBLISH_MS. @type {import('svelte/store').Writable<FpsReading>} */
export const fpsReading = writable({ fps: null, ms: null, calls: null, tris: null, source: null });

const PUBLISH_MS = 500;
const RING = 90;
/** @type {number[]} frame durations (ms), newest last */
const ring = [];
let lastXrAt = 0;
let lastPublish = 0;
/** @type {'desktop' | 'xr' | null} */
let source = null;

function presenting() {
	return !!(/** @type {any} */ (get(globalRenderer))?.xr?.isPresenting);
}

/** @param {number} ms @param {'desktop' | 'xr'} from */
function note(ms, from) {
	if (!Number.isFinite(ms) || ms <= 0 || ms > 1000) return;
	source = from;
	ring.push(ms);
	if (ring.length > RING) ring.shift();
	const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
	if (now - lastPublish >= PUBLISH_MS) {
		lastPublish = now;
		publish();
	}
}

/** the median frame of the ring, as fps + ms. Pure over the numbers; exported. @param {number[]} frames */
export function fpsOf(frames) {
	if (!frames.length) return { fps: null, ms: null };
	const sorted = [...frames].sort((a, b) => a - b);
	const ms = sorted[Math.floor(sorted.length / 2)];
	return { fps: Math.round(1000 / ms), ms: Math.round(ms * 10) / 10 };
}

function publish() {
	const m = /** @type {any} */ (get(sceneMetrics));
	const { fps, ms } = fpsOf(ring);
	fpsReading.set({ fps, ms, calls: m?.calls ?? null, tris: m?.triangles ?? null, source });
}

/** One XR frame (the VR game panel's per-frame call). @param {number} [now] ms */
export function noteXrFrame(now = typeof performance !== 'undefined' ? performance.now() : Date.now()) {
	if (lastXrAt) note(now - lastXrAt, 'xr');
	lastXrAt = now;
}

registerFrameObserver((ms) => {
	if (presenting()) return; // the XR source owns a presenting session
	lastXrAt = 0;
	note(ms, 'desktop');
});

/** A reading as the counter's text: "60 fps · 16.7 ms", and the detail line. @param {FpsReading} r */
export function fpsText(r) {
	if (!r || r.fps === null) return { main: '— fps', detail: '' };
	const tris = r.tris === null ? null : r.tris >= 1000 ? Math.round(r.tris / 1000) + 'k' : String(r.tris);
	return {
		main: r.fps + ' fps',
		detail: [r.ms !== null ? r.ms + ' ms' : null, r.calls !== null ? r.calls + ' calls' : null, tris !== null ? tris + ' tris' : null].filter(Boolean).join(' · ')
	};
}

/** Test seam: forget the ring. */
export function resetFpsMeter() {
	ring.length = 0;
	lastXrAt = 0;
	lastPublish = 0;
	source = null;
	fpsReading.set({ fps: null, ms: null, calls: null, tris: null, source: null });
}
