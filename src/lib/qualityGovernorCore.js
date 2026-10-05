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

/**
 * 31-perf P3 — THE THRESHOLDS OF A LIVE XR SESSION, from the headset's own refresh rate
 * (72/80/90/120 on a Quest 3). An XR frame is VSYNC-QUANTISED exactly like the desktop's,
 * so a session holding its rate reads the budget (13.9 ms at 72 Hz) at every percentile and
 * a missed frame reads twice it. `overMs` = 1.3 budgets: the p95 only passes it when more
 * than ~5% of frames were missed — the stutter a player feels. `underMs` = 1.12 budgets:
 * recovery needs essentially EVERY frame on time for the whole recovery window (a flap is
 * then caught by the doubling hold, which is what it is for). The static `vr` pair above
 * would never recover at 72 Hz (a healthy frame reads 13.9, never under 11.1).
 * @param {number} hz @returns {{overMs: number, underMs: number, hz: number}}
 */
export function xrThresholds(hz) {
	const f = Number(hz) >= 30 && Number(hz) <= 240 ? Number(hz) : 72;
	const budget = 1000 / f;
	return { overMs: budget * 1.3, underMs: budget * 1.12, hz: f };
}

/**
 * 36 G1 — A PHONE IS JUDGED AGAINST ITS OWN REFRESH RATE. The 1.20 beacon caught a phone on a
 * menu (steady 16.6 ms at 60 Hz, 3 draw calls) stepping 0 -> 1 -> 2 -> 3 -> 4: the phone path
 * governs every scene as heavy (33 G1) against the DESKTOP thresholds, so the only thing that
 * could move it was the long-task rule — and a menu's own UI work (the beacon recorded stalls
 * of 100-274 ms while editing) reads as "overloaded" there. Two rules, both pure:
 *   - thresholds from the MEASURED refresh rate (60 / 90 / 120 Hz panels — the 1.20 phone
 *     was a 60-90 Hz LTPO panel), the XR shape: over = 1.3 budgets (the p95 passes it only
 *     when more than ~5% of frames were missed), recovery = 1.12 budgets;
 *   - a TRIVIALLY LIGHT scene is never stepped: fewer than TRIVIAL_CALLS draw calls and a p95
 *     within TRIVIAL_SLACK budgets — nothing the ladder takes away (shadows, resolution, AO,
 *     post) can help a frame that is already on time, and a long task there is UI, not drawing.
 * @param {number} hz @returns {{overMs: number, underMs: number, hz: number, budgetMs: number}}
 */
export function phoneThresholds(hz) {
	const f = Number(hz) >= 30 && Number(hz) <= 240 ? Number(hz) : 60;
	const budget = 1000 / f;
	return { overMs: budget * 1.3, underMs: budget * 1.12, hz: f, budgetMs: budget };
}

/** below this many draw calls a scene is "trivially light" (36 G1) */
export const TRIVIAL_CALLS = 20;
/** ...when its p95 is also within this many refresh periods */
export const TRIVIAL_SLACK = 1.1;

/** the refresh rates a panel actually runs at (a measured interval snaps to the nearest) */
export const REFRESH_RATES = [30, 48, 50, 60, 72, 75, 90, 96, 100, 120, 144, 165, 240];

/**
 * The display's refresh rate from frame intervals. A frame is VSYNC-QUANTISED: a scene keeping
 * up reads exactly the period, a missed frame reads a multiple of it — so the FAST end of the
 * distribution (the 20th percentile) is the period, whatever the misses. Snapped to the nearest
 * real rate within 8 %; null with too few frames (under 30) or nothing near a real rate.
 * @param {number[]} frameMs @returns {number | null}
 */
export function measureRefreshHz(frameMs) {
	const ok = (frameMs ?? []).filter((m) => Number.isFinite(m) && m > 2 && m < 100);
	if (ok.length < 30) return null;
	const sorted = [...ok].sort((a, b) => a - b);
	const fast = percentile(sorted, 0.2);
	if (!fast) return null;
	const hz = 1000 / fast;
	let best = null;
	for (const r of REFRESH_RATES) if (best === null || Math.abs(r - hz) < Math.abs(best - hz)) best = r;
	return best !== null && Math.abs(best - hz) / best <= 0.08 ? best : null;
}

/**
 * Is this scene too light to govern? (36 G1) @param {{calls?: number|null, p95?: number|null, budgetMs?: number|null}} d
 */
export function isTriviallyLight(d) {
	const calls = Number(d?.calls);
	const p95 = Number(d?.p95);
	const budget = Number(d?.budgetMs);
	if (!Number.isFinite(calls) || !Number.isFinite(p95) || !Number.isFinite(budget) || budget <= 0) return false;
	if (d?.calls == null || d?.p95 == null) return false;
	return calls < TRIVIAL_CALLS && p95 <= budget * TRIVIAL_SLACK;
}

/** The level a headset session starts at in auto mode: step 1 = shadows off, the Quest
 * budget's rule ("shadows off in Interact") — a shadow pass is a second draw of every
 * caster, per eye, and a headset has a third of a desktop's frame time. */
export const XR_START_LEVEL = 1;

/**
 * 33 G1 — A PHONE STARTS LIGHTER, AND IS ALWAYS WORTH GOVERNING. The report: "Stars room is
 * too heavy for mobile users, it lags". The governor never acted on a phone at all: it judges
 * by the desktop budgets, where a game of 100 draw calls is LIGHT, and a light scene is never
 * governed (and is walked back to full quality). So a phone drew the Stars Room at its native
 * pixel ratio (2.6 measured on the phone profile = 2.6 Mpx per pass) through 32 render passes
 * a frame — shadows, the authored AO, bloom, SMAA. A phone is bound by FILL, not by calls,
 * so the size of the scene says nothing about whether stepping helps.
 * The start = shadows off, resolution 72 %, AO off (the first four steps). No floor: a phone
 * that holds its frames walks back up by the ordinary recovery rule.
 */
export const PHONE_START_LEVEL = 4;

/**
 * A phone or a small tablet: a coarse pointer, no hover, and a short screen side (CSS px).
 * Pure; the wiring reads the three from matchMedia/screen. A desktop with a touch screen has
 * hover; a laptop's short side is over the line.
 * @param {{coarse?: boolean, hover?: boolean, minSide?: number}} d
 */
export function isPhoneLike(d) {
	const side = Number(d?.minSide);
	return !!d?.coarse && !d?.hover && Number.isFinite(side) && side > 0 && side <= 820;
}

/**
 * The XR framebuffer scale, ALWAYS full. 31-perf first carried the resolution half of the ladder
 * into the headset through `setFramebufferScaleFactor` (applied to the NEXT session, since three
 * refuses it while presenting): any session that touched level 2 (a load hitch, or a game's
 * Medium/Low Quality pin) left every later entry in that tab at 0.85..0.5 of the eye buffer, and
 * EVERY panel's text went soft (the owner's Quest report on preview-1-18: "all text in VR menus
 * became blurry", while frames were already good from the per-frame fixes). A headset's frame
 * budget is defended by the steps that cost nothing to read (shadows at entry, particles,
 * presence); the resolution steps are a desktop measure and are no-ops in a session.
 */
export const XR_FRAMEBUFFER_SCALE = 1;

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
	settleMs: 600,
	/** 36-fb-water F27: frames this soon after a scene LOAD ends are not evidence either — the
	 * scene's first frames still link programs, fill fluid tanks, start workers and run the first
	 * screen-space passes. MEASURED on a phone profile (Fluid tank toy, CPU x4): one p95 of 33 ms
	 * right after the load stepped 4 -> 5 -> 6 (the fluid's points tier) and the walk back took
	 * minutes; on a contended box it never came back within 95 s. 8 s: Aquarium's water pre-pass
	 * and bubbles still hitched at 7 s after its load (phone profile). */
	loadSettleMs: 8000
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
	/** 31-perf P3: a live XR session's thresholds (xrThresholds), null = the profile's;
	 * 36 G1: a phone's (phoneThresholds) carry `budgetMs`, which arms the trivially-light rule
	 * @type {{overMs: number, underMs: number, budgetMs?: number} | null} */
	let thresholdOverride = null;
	/** 31-perf P3: recovery never walks below this (a headset's entry floor) */
	let floor = 0;

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
		/** 36-fb-water F27: ignore frames + long tasks for `ms` from `now` (a scene load just
		 * ended — its warm-up is not the scene's cost). @param {number} now @param {number} [ms] */
		settleFor(now, ms = timing.loadSettleMs) {
			frames = [];
			longTasks = [];
			settleUntil = Math.max(settleUntil, now + ms);
		},
		/**
		 * @param {number} now
		 * @param {{profile?: 'desktop'|'vr', heavy: boolean, pinned?: boolean, calls?: number|null}} ctx
		 * @returns {{level: number, moved: 'up'|'down'|null, reason: string, p95: number|null}}
		 */
		decide(now, ctx) {
			trim(now);
			const t = thresholdOverride ?? THRESHOLDS[ctx.profile === 'vr' ? 'vr' : 'desktop'];
			const p95 = p95Over(now, timing.triggerWindowMs);
			const tasks = longTasks.filter((at) => at >= now - timing.longTaskWindowMs).length;
			// 36 G1: a trivially light scene on a refresh-judged device is never overloaded —
			// not by its frames (they are on time) and not by long tasks (they are UI, and no
			// step of the ladder makes UI work cheaper)
			const budgetMs = /** @type {any} */ (t).budgetMs;
			const trivial = budgetMs != null && isTriviallyLight({ calls: ctx.calls, p95, budgetMs });
			const overloaded = !trivial && ((p95 != null && p95 > t.overMs) || tasks > timing.longTasksOver);
			const since = now - changedAt;

			// UP: overloaded, the scene is heavy enough that setting quality aside could help,
			// and the last step has had its hold
			if (overloaded && ctx.heavy && level < MAX_LEVEL && since >= timing.stepHoldMs) {
				change(level + 1, now);
				return { level, moved: 'up', reason: p95 != null && p95 > t.overMs ? 'frames' : 'long tasks', p95 };
			}
			if (level > floor && !ctx.pinned && since >= recoverHoldMs) {
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
			return { level, moved: null, reason: overloaded ? 'overloaded' : trivial ? 'trivially light' : 'steady', p95 };
		},
		/** Set the level directly (the chip's "restore full quality"). @param {number} to @param {number} now */
		setLevel(to, now) {
			const next = Math.max(0, Math.min(MAX_LEVEL, Math.floor(to) || 0));
			if (next !== level) change(next, now);
			return level;
		},
		/** 31-perf P3: judge against these (an XR session's rate) until cleared with null.
		 * @param {{overMs: number, underMs: number, budgetMs?: number} | null} t */
		setThresholds(t) {
			thresholdOverride =
				t && Number.isFinite(t.overMs) && Number.isFinite(t.underMs)
					? Number.isFinite(/** @type {any} */ (t).budgetMs)
						? { overMs: t.overMs, underMs: t.underMs, budgetMs: /** @type {any} */ (t).budgetMs }
						: { overMs: t.overMs, underMs: t.underMs }
					: null;
		},
		thresholds: () => thresholdOverride,
		/** 31-perf P3: the lowest level RECOVERY may reach (setLevel is not bound by it — the
		 * chip's "restore full quality" still means it). @param {number} n */
		setFloor(n) {
			floor = Math.max(0, Math.min(MAX_LEVEL, Math.floor(Number(n)) || 0));
		},
		floor: () => floor,
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
