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
