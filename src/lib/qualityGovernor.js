import { writable, get } from 'svelte/store';
import {
	createGovernor,
	overridesAt,
	stepLabelsAt,
	drawGapFor,
	FULL_QUALITY,
	MAX_LEVEL
} from './qualityGovernorCore';
import {
	registerFrameObserver,
	registerLongTaskObserver,
	sceneMetrics,
	isHeavy,
	qualityBaseline
} from './sceneBudget';
import { renderPaused } from './overloadGuard';
import { sceneBatchOpen } from '../stores/sceneStore';
import { safeStorage } from './safeStorage';
import { xrThresholds, XR_START_LEVEL, xrScaleAfter } from './qualityGovernorCore';
import { globalRenderer } from '../stores/sceneStore';
import { lodBias } from './lod';
import { lodBiasFor } from './lodCore';

// 26-D (roadmap 26 section 4, Stage 1) — ADAPTIVE QUALITY: THE WIRING.
//
// The RULE is `qualityGovernorCore.js` (pure, unit-tested); this file feeds it the frames
// sceneBudget's loop already measures, publishes what it decided, and holds the two
// things a person can say about it (pin it, give it back). Every consumer READS a store —
// lightParams (shadows), Outline (AO, the post stack, the composer size, the ingest draw
// gap), Scene (the pixel ratio, the presence send gap), particleRuntime (the particle cap)
// — so this module imports none of them and stays a leaf beside overloadGuard.
//
// NOTHING HERE PERSISTS OR REPLICATES except the one opt-out, `autoQuality`: a level is a
// fact about this device right now. In particular a reduced shadow setting is NEVER written
// to `shadowQuality` — that is the user's preference, saved to storage, and a governor that
// wrote it would leave a person with shadows off forever after one heavy scene.
//
// WHAT IT MUST NOT DO: fight 26-G. The freeze streak only counts while the scene is heavy,
// and turning shadows off halves the draw calls, which would make the scene read as light.
// So the first step records the size readings as they were (`qualityBaseline`) and 26-G
// judges against those until the governor is back at full quality. The perf-governor
// suite proves it: a heavy scene reduced to green calls still pauses on a frozen streak.
//
// VR: sceneBudget's loop is window rAF, which does not run inside an immersive session, so
// the governor sees no frames in a headset and never acts there. The VR thresholds are
// carried in the core for when it does — owed on a headset.

/** @typedef {import('./qualityGovernorCore').QualityOverrides} QualityOverrides */

/** What every consumer reads. LOCAL, never saved, never sent.
 * @type {import('svelte/store').Writable<QualityOverrides>} */
export const qualityOverrides = writable({ ...FULL_QUALITY });

/** The ingest draw gap in ms (0 = draw every frame). Its own store because it changes on a
 * different clock from a quality level: it lasts exactly as long as one received batch. */
export const ingestDrawGap = writable(0);

/**
 * For the chip and the suite.
 * @type {import('svelte/store').Writable<{level: number, max: number, pinned: boolean, labels: string[], reason: string, at: number, snoozedUntil: number}>}
 */
export const qualityState = writable({
	level: 0,
	max: MAX_LEVEL,
	pinned: false,
	labels: /** @type {string[]} */ ([]),
	reason: '',
	at: 0,
	snoozedUntil: 0
});

/** The opt-out. LOCAL preference, default ON. */
export const autoQuality = writable(safeStorage.getItem('autoQuality') !== 'false');

/** A decision is taken at most this often; the frames themselves are noted every frame. */
const DECIDE_EVERY_MS = 250;
/** "Restore full quality" means it: no automatic step for this long afterwards. */
export const RELEASE_SNOOZE_MS = 60000;

const governor = createGovernor();
/** 31-perf P3: the live XR session, as far as quality is concerned.
 * @type {{active: boolean, session: any, hz: number, last: number, raised: boolean, before: number, minScale: number, nextScale: number}} */
const xr = { active: false, session: null, hz: 72, last: 0, raised: false, before: 0, minScale: 1, nextScale: 1 };
let lastDecideAt = 0;
let wasHidden = false;
let pinned = false;
let snoozedUntil = 0;
let drawGapEngaged = false;
/** @type {string} */
let lastReason = '';

function now() {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** @param {number} level @param {string} reason */
function publish(level, reason) {
	const at = Date.now();
	if (level > 0 && !get(qualityBaseline)) {
		// the FIRST step: remember what the scene cost at full quality (see the header)
		const m = get(sceneMetrics);
		qualityBaseline.set({
			objects: Number(m.objects) || 0,
			triangles: Number(m.triangles) || 0,
			calls: Number(m.calls) || 0
		});
	}
	if (level === 0) qualityBaseline.set(null);
	qualityOverrides.set(overridesAt(level));
	// 31-perf P2/P3: every step also pulls the LOD switch distances in (a struggling device
	// struggles with triangles too); lod.js reads the bias, never this module
	lodBias.set(lodBiasFor(level));
	if (xr.active && overridesAt(level).dprScale < xr.minScale) xr.minScale = overridesAt(level).dprScale;
	lastReason = reason;
	qualityState.set({
		level,
		max: MAX_LEVEL,
		pinned,
		labels: stepLabelsAt(level),
		reason,
		at,
		snoozedUntil
	});
}

/** The profile and heaviness the core needs, read off the last sample. */
function context() {
	const metrics = get(sceneMetrics);
	// 31-perf P3: inside an XR session the sampler's window-rAF loop is asleep, so its last
	// reading is a DESKTOP one from before entry. The session itself is the evidence: VR, and
	// always worth governing — a missed headset frame is judder, not a slow chart, and the
	// light-scene exemption (26-G's ruling) exists for a desktop that is merely slow
	if (xr.active) return { metrics, profile: /** @type {'desktop'|'vr'} */ ('vr'), heavy: true };
	const profile = metrics?.profile === 'vr' ? 'vr' : 'desktop';
	return { metrics, profile: /** @type {'desktop'|'vr'} */ (profile), heavy: isHeavy(metrics, profile, get(qualityBaseline)) };
}

/**
 * Fed every frame by sceneBudget's loop.
 * @param {number} ms
 */
export function noteFrameForQuality(ms) {
	const t = now();
	// a hidden tab is throttled to ~1Hz on purpose and its first frame back spans the
	// whole absence; neither is the scene being slow (26-G's rule, same reasons)
	if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
		wasHidden = true;
		governor.forget();
		return;
	}
	if (wasHidden) {
		wasHidden = false;
		governor.forget();
		return;
	}
	// paused by 26-G: no frames are being drawn, so none of these describe drawing
	if (get(renderPaused)) {
		governor.forget();
		return;
	}
	governor.noteFrame(ms, t);
	if (t - lastDecideAt < DECIDE_EVERY_MS) return;
	lastDecideAt = t;
	decideNow(t);
}

/** One decision, now. Exported for the suite, which drives time it cannot wait out.
 * @param {number} [t] */
export function decideNow(t = now()) {
	const ctx = context();
	const enabled = get(autoQuality);
	// "Restore full quality" snoozes CLIMBING for a minute; it never blocks a walk back down
	const snoozed = Date.now() < snoozedUntil;
	const d = enabled
		? governor.decide(t, { profile: ctx.profile, heavy: ctx.heavy && !snoozed, pinned })
		: { level: governor.level(), moved: null, reason: 'off', p95: null };
	if (d.moved) publish(d.level, d.reason);

	// THE INGEST RULE (26-E): while a received batch drains through slow frames, draw at
	// most four frames a second so the queue gets the main thread back
	const draining = sceneBatchOpen();
	const backlog = Number(ctx.metrics?.ingestBacklog) || 0;
	const gap = enabled ? drawGapFor({ engaged: drawGapEngaged, draining, backlog, p95: d.p95, profile: ctx.profile }) : 0;
	drawGapEngaged = gap > 0;
	if (get(ingestDrawGap) !== gap) ingestDrawGap.set(gap);
	return d;
}

/** Keep the current level: no walking back up until released. */
export function pinQuality() {
	pinned = true;
	publish(governor.level(), lastReason || 'pinned');
}

/** Full quality now, and no automatic step for a minute — "give it back" must stick long
 * enough to see what it looks like. */
export function releaseQuality() {
	pinned = false;
	snoozedUntil = Date.now() + RELEASE_SNOOZE_MS;
	governor.setLevel(0, now());
	publish(0, 'released');
}

/** @param {boolean} on */
export function setAutoQuality(on) {
	autoQuality.set(!!on);
}

// ONE path for the opt-out, whoever flips it (Settings binds the store, the suite calls
// setAutoQuality): remember it locally, and turning it off gives full quality back NOW
let autoQualitySeen = false;
autoQuality.subscribe((on) => {
	// the first call is the value just read from storage — nothing to write or undo
	if (!autoQualitySeen) {
		autoQualitySeen = true;
		return;
	}
	safeStorage.setItem('autoQuality', on ? 'true' : 'false');
	if (!on) {
		pinned = false;
		governor.setLevel(0, now());
		publish(0, 'turned off');
		ingestDrawGap.set(0);
		drawGapEngaged = false;
	}
});

/** TEST-ONLY: feed a synthetic frame / long task at an explicit time, and reset. */
export const governorForTest = {
	/** @param {number} ms @param {number} t */
	frame(ms, t) {
		governor.noteFrame(ms, t);
	},
	/** @param {number} t */
	longTask(t) {
		governor.noteLongTask(t);
	},
	/** @param {number} level */
	setLevel(level) {
		governor.setLevel(level, now());
		publish(governor.level(), 'test');
	},
	reset() {
		pinned = false;
		snoozedUntil = 0;
		drawGapEngaged = false;
		lastDecideAt = 0;
		governor.setLevel(0, -1e9);
		governor.forget();
		ingestDrawGap.set(0);
		publish(0, 'reset');
	},
	level: () => governor.level()
};

registerFrameObserver(noteFrameForQuality);
registerLongTaskObserver(() => governor.noteLongTask(now()));

// ---- 31-perf P3: THE HEADSET -------------------------------------------------------------
//
// Until now the governor never ran in VR: its frames come from sceneBudget's window rAF, which
// an immersive session suspends, so a Quest sat at full quality however badly it judged. Now:
//   · FRAMES: the session's own requestAnimationFrame (a second callback beside three's, which
//     the WebXR spec allows) feeds every frame interval, and decides every 250 ms
//   · THRESHOLDS: from the headset's refresh rate (xrThresholds: 72 / 90 / 120 Hz), updated on
//     `frameratechange` — see the core for why the static VR pair could never recover
//   · START: auto mode enters a session at XR_START_LEVEL (shadows off — the Quest budget) and
//     gives the level it found back on exit; a lower level reached in the headset is kept
//     only if it is still needed (the ordinary recovery walks it back)
//   · RESOLUTION: an XR framebuffer's size is fixed at entry, so the scale a session needed is
//     applied to the NEXT entry (xrScaleAfter) — three already runs maximum foveation
// The opt-out holds: with auto quality off, none of this changes a level.
// MERGE NOTE (31-game-shell): a game's pinned Quality preset must win over the entry floor.

/** @param {any} r */
function hookXR(r) {
	if (!r?.xr || r.__qualityXR) return;
	r.__qualityXR = true;
	r.xr.addEventListener?.('sessionstart', () => startXRQuality(r.xr.getSession?.()));
	r.xr.addEventListener?.('sessionend', () => endXRQuality(r));
}
globalRenderer.subscribe((r) => hookXR(r));

/** A session began: judge by its rate, feed its frames, take the entry floor.
 * Exported for the suite (a headless page cannot present). @param {any} session @param {number} [hzOverride] */
export function startXRQuality(session, hzOverride) {
	if (xr.active && xr.session === session) return;
	xr.active = true;
	xr.session = session ?? null;
	xr.last = 0;
	xr.minScale = 1;
	xr.hz = Number(hzOverride ?? session?.frameRate) || 72;
	governor.setThresholds(xrThresholds(xr.hz));
	governor.forget();
	session?.addEventListener?.('frameratechange', () => {
		xr.hz = Number(session.frameRate) || xr.hz;
		governor.setThresholds(xrThresholds(xr.hz));
		governor.forget();
	});
	xr.raised = false;
	xr.before = governor.level();
	if (get(autoQuality)) {
		// the floor HOLDS for the session: recovery must not switch shadows back on because
		// frames were fine without them — that is the flap the floor exists to prevent
		governor.setFloor(XR_START_LEVEL);
		if (governor.level() < XR_START_LEVEL) {
			governor.setLevel(XR_START_LEVEL, now());
			xr.raised = true;
			publish(XR_START_LEVEL, 'headset: shadows off');
		}
	}
	const loop = (/** @type {number} */ t) => {
		if (!xr.active || xr.session !== session) return;
		session.requestAnimationFrame(loop);
		if (xr.last) noteXRFrame(t - xr.last, t);
		xr.last = t;
	};
	session?.requestAnimationFrame?.(loop);
}

/** One XR frame interval. Exported for the suite. @param {number} ms @param {number} [t] */
export function noteXRFrame(ms, t = now()) {
	if (!xr.active) return;
	governor.noteFrame(ms, t);
	if (t - lastDecideAt < DECIDE_EVERY_MS) return;
	lastDecideAt = t;
	decideNow(t);
}

/** The session ended: desktop thresholds, the entry floor handed back, and the resolution
 * the headset needed saved for the next entry. Exported for the suite. @param {any} [r] */
export function endXRQuality(r = get(globalRenderer)) {
	if (!xr.active) return;
	xr.active = false;
	xr.session = null;
	governor.setThresholds(null);
	governor.setFloor(0);
	governor.forget();
	xr.nextScale = xrScaleAfter(xr.minScale);
	try {
		// three refuses this while presenting; sessionend fires after it has stopped
		r?.xr?.setFramebufferScaleFactor?.(xr.nextScale);
	} catch {
		/* a renderer without XR */
	}
	if (xr.raised && get(autoQuality)) {
		governor.setLevel(xr.before, now());
		publish(xr.before, 'left the headset');
	}
	xr.raised = false;
}

/** For the suite and the stats plate. */
export function xrQualityDebug() {
	return { active: xr.active, hz: xr.hz, raised: xr.raised, minScale: xr.minScale, nextScale: xr.nextScale, floor: governor.floor(), thresholds: governor.thresholds(), level: governor.level() };
}
