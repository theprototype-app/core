// 26-D (roadmap 26 section 4, Stage 1) — THE ADAPTIVE QUALITY GOVERNOR'S DECISION RULE.
//
// PURE and import-free: frame times and long-task moments go in, a level comes out. The
// wiring (which store a level writes, which frame loop feeds it, what the chip says) is
// `qualityGovernor.js`; this file is only the rule, so every threshold and every hold is
// provable with no GPU, no browser and no clock (vitest drives it with invented times).
//
// WHAT 26-E MEASURED, AND WHAT THE STEP ORDER TAKES FROM IT (Radeon 890M, 1280x720):
//   - a many-object scene is bound by DRAW CALLS — CPU time per call — and the shadow pass
//     draws every mesh a second time: 1,000 boxes = 1,943 calls, 3,000 = 5,323 (p95 50ms).
//     Turning the post stack off moved nothing (shaded: 5,236 calls, p95 49.9).
//   - a dense scene (6M triangles) held 60fps on the same GPU, so resolution is the lever
//     only where FILL is the cost — a weaker GPU, a HiDPI screen.
//   - the biggest freeze was not drawing a scene but RECEIVING one: ingest is frame-bound,
//     3,000 objects took ~180s to land while the joiner drew them and 5.6s with drawing
//     paused. That is its own rule below (`drawGapFor`), not a quality step.
// So the order is SHADOWS first (halves the calls where the cost is), then resolution in
// the roadmap's 0.85 steps, then AO and the rest of the post stack, then particles and the
// presence stream. The roadmap listed resolution first; the measurement is why it is not.
//
// Every step is REVERSIBLE and LOCAL — nothing here writes a preference, a document or a
// message. A level is a fact about this device right now.

/** @typedef {{dprScale: number, shadowsOff: boolean, aoOff: boolean, postOff: boolean, particlesCapped: boolean, presenceSlow: boolean}} QualityOverrides */

/** @type {QualityOverrides} */
export const FULL_QUALITY = Object.freeze({
	dprScale: 1,
	shadowsOff: false,
	aoOff: false,
	postOff: false,
	particlesCapped: false,
	presenceSlow: false
});

/**
 * The steps, in the order they are taken. Each names only what it changes; a level is the
 * sum of every step up to it (a later `dprScale` replaces an earlier one).
 * @type {{key: string, label: string, set: Partial<QualityOverrides>}[]}
 */
export const GOVERNOR_STEPS = [
	{ key: 'shadows', label: 'Shadows off', set: { shadowsOff: true } },
	{ key: 'res85', label: 'Resolution 85%', set: { dprScale: 0.85 } },
	{ key: 'res72', label: 'Resolution 72%', set: { dprScale: 0.72 } },
	{ key: 'ao', label: 'Ambient occlusion off', set: { aoOff: true } },
	{ key: 'res61', label: 'Resolution 61%', set: { dprScale: 0.61 } },
	{ key: 'post', label: 'Scene look (post-processing) off', set: { postOff: true } },
	{ key: 'res50', label: 'Resolution 50%', set: { dprScale: 0.5 } },
	{ key: 'particles', label: 'Fewer particles', set: { particlesCapped: true } },
	{ key: 'presence', label: 'Your camera updates to peers halved', set: { presenceSlow: true } }
];

export const MAX_LEVEL = GOVERNOR_STEPS.length;

/** @param {number} level @returns {QualityOverrides} */
export function overridesAt(level) {
	/** @type {QualityOverrides} */
	const out = { ...FULL_QUALITY };
	const n = Math.max(0, Math.min(MAX_LEVEL, Math.floor(level) || 0));
	for (let i = 0; i < n; i++) Object.assign(out, GOVERNOR_STEPS[i].set);
	return out;
}

/** The labels of every step in effect at `level`, for the chip's tooltip. @param {number} level */
export function stepLabelsAt(level) {
	return GOVERNOR_STEPS.slice(0, Math.max(0, Math.min(MAX_LEVEL, level))).map((s) => s.label);
}

/**
 * Thresholds per profile. Desktop: slower than 30fps, and recovery under 20ms. The roadmap
 * said "p95 > 33ms"; 26-E measured why that cannot be the number — frames are VSYNC-
 * QUANTISED, so a scene holding a steady 30fps reads 33.3-33.4ms at every percentile, and a
 * 33ms trigger would call it overloaded and keep stepping to the bottom of the ladder. 35ms
 * is the first reading that means a 30fps frame was actually missed. VR: 72Hz (13.9ms) and
 * recovery at 90Hz (11.1ms) — the roadmap's, UNMEASURED: the governor's frame source does not
 * run inside an XR session yet, so they are carried for when it does (owed on a headset).
 */
export const THRESHOLDS = {
	desktop: { overMs: 35, underMs: 20 },
	vr: { overMs: 13.9, underMs: 11.1 }
};

export const TIMING = {
	/** p95 over this much recent time decides "overloaded" */
	triggerWindowMs: 2000,
	/** a step is held at least this long before the next one (the roadmap's 3s) */
	stepHoldMs: 3000,
	/** recovery needs this much consecutive good time (the roadmap's 10s) */
	recoverWindowMs: 10000,
	/** long tasks counted over this window… */
	longTaskWindowMs: 5000,
	/** …more than this many is overloaded, whatever the frames say */
	longTasksOver: 2,
	/** a step back UP within this long after a walk back DOWN doubles the next recovery */
	flapWindowMs: 20000,
	/** the recovery hold never grows past this */
	maxRecoverHoldMs: 80000,
	/** a window must be at least this full before it may decide anything */
	coverage: 0.75,
	/** frames this soon after a change are not evidence: the change itself costs a hitch
	 * (turning shadows off recompiles every lit material, a dpr change reallocates the
	 * composer). MEASURED: without this, 3,000 real boxes took a second, needless step
	 * on the recompile frames right after the shadows step. */
	settleMs: 600
};

/** Nearest-rank percentile (sceneBudget's rule). @param {number[]} sorted @param {number} q */
function percentile(sorted, q) {
	if (!sorted.length) return null;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/**
 * One governor. `note*` feed it; `decide` says whether the level moves.
 *
 * HOLD, NOT HURRY: a decision is only ever taken on a FULL window, and every level change
 * throws the window away — the frames that justified the last step describe a scene that
 * no longer exists. So a step is followed by at least `stepHoldMs` of fresh frames before
 * the next, and a walk back down by `recoverWindowMs` of them.
 *
 * FLAPPING is the failure mode of every automatic quality system (drop, recover, drop…,
 * each transition itself a visible hitch). A step back up shortly after a walk down
 * doubles the recovery hold for next time, capped; a step up long after the last walk down
 * is just a heavier scene, and resets it.
 * @param {{timing?: Partial<typeof TIMING>}} [opts]
 */
export function createGovernor(opts = {}) {
	const timing = { ...TIMING, ...(opts.timing ?? {}) };
	/** @type {{at: number, ms: number}[]} */
	let frames = [];
	/** @type {number[]} */
	let longTasks = [];
	let level = 0;
	let changedAt = -Infinity;
	let lastDownAt = -Infinity;
	let recoverHoldMs = timing.recoverWindowMs;
	let settleUntil = -Infinity;

	function trim(/** @type {number} */ now) {
		// keep enough for the LONGEST window any decision reads — the recovery hold grows
		// when the governor flaps, and a ring trimmed shorter than it could never recover
		const keep = Math.max(recoverHoldMs, timing.triggerWindowMs);
		if (frames.length && frames[0].at < now - keep) frames = frames.filter((f) => f.at >= now - keep);
		if (longTasks.length && longTasks[0] < now - timing.longTaskWindowMs)
			longTasks = longTasks.filter((t) => t >= now - timing.longTaskWindowMs);
	}

	/** p95 over the last `windowMs`, or null when the window is not full enough to judge */
	function p95Over(/** @type {number} */ now, /** @type {number} */ windowMs) {
		const from = now - windowMs;
		const inWindow = frames.filter((f) => f.at >= from);
		if (inWindow.length < 8) return null;
		// covered: the oldest sample reaches back far enough, and nothing older than the
		// last change can be in here (the window was emptied then)
		if (inWindow[0].at - inWindow[0].ms > from + windowMs * (1 - timing.coverage)) return null;
		return percentile(inWindow.map((f) => f.ms).sort((a, b) => a - b), 0.95);
	}

	function change(/** @type {number} */ to, /** @type {number} */ now) {
		if (to < level) lastDownAt = now;
		else if (to > level)
			// a step up soon after a walk down is a FLAP: make the next recovery wait longer.
			// A step up long after one is simply a scene that got heavier: forgive the history
			recoverHoldMs =
				now - lastDownAt < timing.flapWindowMs
					? Math.min(timing.maxRecoverHoldMs, recoverHoldMs * 2)
					: timing.recoverWindowMs;
		level = to;
		changedAt = now;
		settleUntil = now + timing.settleMs;
		frames = [];
		longTasks = [];
	}

	return {
		/** @param {number} ms @param {number} now */
		noteFrame(ms, now) {
			if (!Number.isFinite(ms) || ms <= 0) return;
			if (now < settleUntil) return;
			frames.push({ at: now, ms });
			trim(now);
		},
		/** @param {number} now */
		noteLongTask(now) {
			if (now < settleUntil) return;
			longTasks.push(now);
			trim(now);
		},
		/** Throw the evidence away — a hidden tab, a pause, a resume. The next decision waits
		 * for a full window of frames that describe the present. */
		forget() {
			frames = [];
			longTasks = [];
		},
		/**
		 * @param {number} now
		 * @param {{profile?: 'desktop'|'vr', heavy: boolean, pinned?: boolean}} ctx
		 * @returns {{level: number, moved: 'up'|'down'|null, reason: string, p95: number|null}}
		 */
		decide(now, ctx) {
			trim(now);
			const t = THRESHOLDS[ctx.profile === 'vr' ? 'vr' : 'desktop'];
			const p95 = p95Over(now, timing.triggerWindowMs);
			const tasks = longTasks.filter((at) => at >= now - timing.longTaskWindowMs).length;
			const overloaded = (p95 != null && p95 > t.overMs) || tasks > timing.longTasksOver;
			const since = now - changedAt;

			// UP: overloaded, the scene is heavy enough that setting quality aside could help,
			// and the last step has had its hold
			if (overloaded && ctx.heavy && level < MAX_LEVEL && since >= timing.stepHoldMs) {
				change(level + 1, now);
				return { level, moved: 'up', reason: p95 != null && p95 > t.overMs ? 'frames' : 'long tasks', p95 };
			}
			if (level > 0 && !ctx.pinned && since >= recoverHoldMs) {
				// the scene is no longer heavy: a light scene is never governed, so give it back
				if (!ctx.heavy) {
					change(level - 1, now);
					return { level, moved: 'down', reason: 'scene is light', p95 };
				}
				const calm = p95Over(now, recoverHoldMs);
				if (calm != null && calm < t.underMs && tasks === 0) {
					change(level - 1, now);
					return { level, moved: 'down', reason: 'recovered', p95: calm };
				}
			}
			return { level, moved: null, reason: overloaded ? 'overloaded' : 'steady', p95 };
		},
		/** Set the level directly (the chip's "restore full quality"). @param {number} to @param {number} now */
		setLevel(to, now) {
			const next = Math.max(0, Math.min(MAX_LEVEL, Math.floor(to) || 0));
			if (next !== level) change(next, now);
			return level;
		},
		level: () => level,
		recoverHoldMs: () => recoverHoldMs
	};
}

/**
 * THE INGEST RULE (26-E's biggest finding). While a received scene is still draining into
 * this one, a slow frame is not only a slow frame — it is the drain's throughput, because
 * every object's parse waits for a frame to pass. So while a batch drains AND drawing is
 * slow, draw at most one frame every `INGEST_DRAW_GAP_MS`: the scene keeps visibly
 * filling in, and the queue gets the main thread back. Returns the gap to enforce, or 0.
 *
 * STICKY FOR THE DRAIN: once throttled, the frames are cheap BECAUSE they are throttled, so
 * re-judging on them would switch the throttle off, which makes them slow, which switches
 * it on — a flicker at the period of the frame window. It is engaged once per drain and
 * released when the drain ends. Not a level: it ends by itself, so it stays off the chip.
 * @param {{engaged: boolean, draining: boolean, backlog: number, p95: number|null, profile?: 'desktop'|'vr'}} ctx
 */
export function drawGapFor(ctx) {
	if (!ctx.draining) return 0;
	if (ctx.engaged) return INGEST_DRAW_GAP_MS;
	if (!(ctx.backlog > INGEST_MIN_BACKLOG)) return 0;
	const t = THRESHOLDS[ctx.profile === 'vr' ? 'vr' : 'desktop'];
	// a fast frame costs the drain nothing worth saving — only a slow one is throttled
	if (ctx.p95 == null || ctx.p95 <= t.underMs) return 0;
	return INGEST_DRAW_GAP_MS;
}

/** Below this many parked objects a drain finishes in well under a second anyway. */
export const INGEST_MIN_BACKLOG = 50;
/** Four frames a second while a big scene lands: enough to see it arrive. */
export const INGEST_DRAW_GAP_MS = 250;
