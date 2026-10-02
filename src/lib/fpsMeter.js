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
import { registerFrameObserver, sceneMetrics, noteExternalFrame } from './sceneBudget';
import { globalRenderer } from '../stores/sceneStore';
import { safeStorage } from './safeStorage';

// 33 Q1 — "Show amount of fps and draw calls within quest as an option in settings (150 is
// limit for quest)". An APP-WIDE preference (Settings ▸ Interface ▸ Viewport, and the VR
// settings panel), separate from a game's own Show FPS row: that one is a per-game choice
// that only shows while you play, this one is a debugging lens on any scene in any mode.
// Both draw THIS reading through the same counter (FpsCounter.svelte on the desktop; in a
// headset vrPerfStrip.js), so there is one meter and one number. LOCAL, never replicated.

const PERF_KEY = 'perfStats:show';
/** the app-wide "Show FPS + draw calls" preference */
export const perfStatsShown = writable(safeStorage.getItem(PERF_KEY) === 'true');
perfStatsShown.subscribe((on) => {
	safeStorage.setItem(PERF_KEY, on ? 'true' : 'false');
});

/** draw calls per frame past which the counter warns (amber) */
export const CALLS_WARN = 120;
/** the Quest's practical draw-call ceiling — past it the counter is RED */
export const CALLS_LIMIT = 150;

/** How a draw-call count reads against the Quest budget. Pure; exported for the unit layer.
 * @param {number | null | undefined} calls @returns {'ok' | 'warn' | 'over' | null} */
export function callsTier(calls) {
	if (calls === null || calls === undefined || !Number.isFinite(calls)) return null;
	if (calls > CALLS_LIMIT) return 'over';
	if (calls > CALLS_WARN) return 'warn';
	return 'ok';
}

/** the colour each tier is drawn in (desktop CSS and the VR canvas share it) */
export const TIER_COLORS = { ok: '#d1d5db', warn: '#fbbf24', over: '#f87171' };

/** A reading as its parts, for a counter that colours the calls. @param {FpsReading} r */
export function perfParts(r) {
	const tris = !r || r.tris === null ? null : r.tris >= 1000 ? Math.round(r.tris / 1000) + 'k' : String(r.tris);
	return {
		fps: !r || r.fps === null ? '— fps' : r.fps + ' fps',
		ms: !r || r.ms === null ? null : r.ms + ' ms',
		calls: !r || r.calls === null ? null : r.calls + ' calls',
		tris: tris === null ? null : tris + ' tris',
		tier: callsTier(r?.calls)
	};
}

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
	// 33 Q1: the draw calls/triangles are averaged over DISPLAY frames, which sceneBudget
	// counts off the window's rAF — and that does not run inside an immersive session, so
	// the headset read a frozen (or empty) calls figure. An XR frame counts as one there.
	noteExternalFrame(now);
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
