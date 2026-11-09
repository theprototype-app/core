// 78 F2 / F3 / F8 — the PURE halves of On Hover, Hover Animate and Toggle Animation. Imports
// NOTHING, so the swing, the hysteresis and the door's state machine are unit-tested with no
// scene, no clock and no peers (the flowDebugCore / hudArrange shape).
//
// THE SYNC MODEL, one rule: every peer derives the pose from the REPLICATED trigger stamps it
// already holds — a hover enter is a stamp, a door press is a stamp — so the same stamps give
// the same swing and the same door everywhere, and nothing is streamed. These functions take
// the stamps and a time and answer a number; the runtime only gathers the stamps.

/** a hover over the same object closer than this to the previous stamp continues a RUN (the
 * "over" re-stamp, a held key) rather than starting a new swing */
export const RUN_GAP = 0.6;
/** how long an object must be missed before it counts as left (seconds) */
export const HOVER_HYSTERESIS = 0.12;
/** how often an "over" hover re-stamps while the pointer stays (seconds) */
export const OVER_RESTAMP = 0.25;
/** an "over" pulse stays high at least this long, so the re-stamps read as one held level */
export const OVER_WINDOW = 0.45;

/**
 * Split stamps (ascending or not) into RUNS: a run starts at a stamp more than `gap` after the
 * previous one and stays high until its last stamp + `hold`. PURE.
 * @param {number[]} stamps @param {number} hold @param {number} [gap]
 * @returns {{start: number, last: number, end: number}[]}
 */
export function runsOf(stamps, hold, gap = RUN_GAP) {
	const sorted = [...stamps].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
	/** @type {{start: number, last: number, end: number}[]} */
	const runs = [];
	for (const t of sorted) {
		const cur = runs[runs.length - 1];
		if (cur && t - cur.last <= gap) {
			cur.last = t;
			cur.end = t + hold;
		} else runs.push({ start: t, last: t, end: t + hold });
	}
	return runs;
}

/** a damped oscillation, 0 at dt = 0 @param {number} dt @param {number} freq @param {number} damping */
export function ring(dt, freq, damping) {
	if (!(dt >= 0)) return 0;
	return Math.exp(-Math.max(0, damping) * dt) * Math.sin(2 * Math.PI * Math.max(0.05, freq) * dt);
}

/** how long a rung swing lasts before it reads as rest (e^-damping·t < 1 %) @param {number} damping */
export function ringLength(damping) {
	return Math.min(30, 4.6 / Math.max(0.2, damping));
}

/** ease 0..1 @param {number} k @param {string} [ease] */
export function ease(k, ease = 'smooth') {
	const x = Math.min(1, Math.max(0, k));
	if (ease === 'linear') return x;
	return x * x * (3 - 2 * x);
}

/**
 * HOVER ANIMATE: the envelope (-1..1, or 0..1 for in-out) at time `t` from the trigger stamps.
 *   once     a swing per run start; a start while one is still ringing is ignored
 *   restart  the newest run start restarts the swing
 *   energy   every run start adds its own swing (the bell: hovered again, it rings harder)
 *   while    swings while hovered, rings out after
 *   stop     swings while hovered, stops dead when the hover ends (hard stop)
 *   inout    eases to the "hovered" pose while hovered and back after (0..1)
 * @param {{mode?: string, freq?: number, damping?: number, inoutSeconds?: number}} p
 * @param {number[]} stamps the trigger stamps seen (synced seconds) @param {number} hold how long one stamp stays high
 * @param {number} t now (synced seconds)
 * @returns {number}
 */
export function hoverEnvelope(p, stamps, hold, t) {
	const mode = p?.mode ?? 'energy';
	const freq = Number(p?.freq ?? 1.2) || 1.2;
	const damping = Number(p?.damping ?? 1.2);
	const runs = runsOf(stamps, hold).filter((r) => r.start <= t);
	if (!runs.length) return 0;
	const last = runs[runs.length - 1];
	if (mode === 'inout') {
		const dur = Math.max(0.05, Number(p?.inoutSeconds ?? 0.25));
		if (t < last.end) return ease((t - last.start) / dur);
		const atLow = ease((last.end - last.start) / dur);
		return Math.max(0, atLow - (t - last.end) / dur);
	}
	if (mode === 'restart') return ring(t - last.start, freq, damping);
	if (mode === 'once') {
		const len = ringLength(damping);
		let playing = null;
		for (const r of runs) if (playing === null || r.start - playing >= len) playing = r.start;
		return playing === null ? 0 : ring(t - playing, freq, damping);
	}
	if (mode === 'while' || mode === 'stop') {
		const dt = t - last.start;
		const osc = Math.sin(2 * Math.PI * Math.max(0.05, freq) * dt);
		if (t < last.end) return osc;
		if (mode === 'stop') return 0;
		return osc * Math.exp(-Math.max(0, damping) * (t - last.end));
	}
	// energy: the sum, clamped so a frantic hover cannot spin the bell over the top
	let sum = 0;
	const len = ringLength(damping);
	for (const r of runs) if (t - r.start < len) sum += ring(t - r.start, freq, damping);
	return Math.max(-2, Math.min(2, sum));
}

/**
 * The hover state of ONE peer's pointer: which objects are over, with the 120 ms hysteresis.
 * Feed it the set seen this sample; it answers the edges. PURE (the state object is the caller's).
 * @param {Map<string, {lastSeen: number}>} over uuid -> when it was last seen (mutated)
 * @param {Iterable<string>} seen @param {number} now seconds
 * @param {number} [hysteresis]
 * @returns {{entered: string[], left: string[]}}
 */
export function hoverStep(over, seen, now, hysteresis = HOVER_HYSTERESIS) {
	/** @type {string[]} */ const entered = [];
	/** @type {string[]} */ const left = [];
	const seenSet = new Set(seen);
	for (const uuid of seenSet) {
		const row = over.get(uuid);
		if (row) row.lastSeen = now;
		else {
			over.set(uuid, { lastSeen: now });
			entered.push(uuid);
		}
	}
	for (const [uuid, row] of [...over]) {
		if (seenSet.has(uuid)) continue;
		if (now - row.lastSeen > hysteresis) {
			over.delete(uuid);
			left.push(uuid);
		}
	}
	return { entered, left };
}

// ---------------------------------------------------------------- Toggle Animation (F3 / F8)

/** @typedef {{name: string, p: number[], r: number[], s: number[]}} Pose */
/** @typedef {{kind: 'toggle'|'open'|'close'|'goto'|'auto', t: number, pose?: any}} DoorEvent */
/** @typedef {{from: number | null, fromPose: Pose | null, to: number, start: number, end: number}} DoorState */

/** the pose index a `go to` names: a number (0-based) or a pose name; -1 = none @param {Pose[]} poses @param {any} want */
export function poseIndexOf(poses, want) {
	if (typeof want === 'number' && Number.isFinite(want)) {
		const i = Math.round(want);
		return i >= 0 && i < poses.length ? i : -1;
	}
	const name = String(want ?? '').trim().toLowerCase();
	if (!name) return -1;
	const byName = poses.findIndex((pose) => String(pose?.name ?? '').toLowerCase() === name);
	if (byName >= 0) return byName;
	const n = Number(name);
	return Number.isFinite(n) ? poseIndexOf(poses, n) : -1;
}

/** lerp two poses (position + Euler rotation + scale) @param {Pose} a @param {Pose} b @param {number} k @returns {Pose} */
export function lerpPose(a, b, k) {
	const mix = (/** @type {number[]} */ x, /** @type {number[]} */ y) => [0, 1, 2].map((i) => (x?.[i] ?? 0) + ((y?.[i] ?? 0) - (x?.[i] ?? 0)) * k);
	return { name: k < 1 ? a.name : b.name, p: mix(a.p, b.p), r: mix(a.r, b.r), s: mix(a.s ?? [1, 1, 1], b.s ?? [1, 1, 1]) };
}

/**
 * Where the door IS at `t` (the transition, eased) — a pose, plus whether it is moving.
 * @param {DoorState} st @param {Pose[]} poses @param {number} t @param {string} [easing]
 * @returns {{pose: Pose, moving: boolean, k: number}}
 */
export function doorPoseAt(st, poses, t, easing = 'smooth') {
	const to = poses[st.to] ?? poses[0];
	if (st.from === null && !st.fromPose) return { pose: to, moving: false, k: 1 };
	const from = st.fromPose ?? poses[st.from ?? 0] ?? to;
	const span = Math.max(1e-3, st.end - st.start);
	const k = (t - st.start) / span;
	if (k >= 1) return { pose: to, moving: false, k: 1 };
	if (k <= 0) return { pose: from, moving: true, k: 0 };
	return { pose: lerpPose(from, to, ease(k, easing)), moving: true, k };
}

/**
 * ONE door event applied to the state, at its own stamp — deterministic, so every peer that sees
 * the same stamps ends in the same place. `interrupt`: 'reverse' starts the new move from where
 * the door is now; 'finish' ignores events that land while it moves. Returns the new state (or
 * the same object when nothing changes).
 * @param {DoorState} st @param {DoorEvent} ev @param {Pose[]} poses
 * @param {{duration?: number, interrupt?: string, ease?: string}} opts
 * @returns {DoorState}
 */
export function doorApply(st, ev, poses, opts) {
	if (!poses.length) return st;
	const moving = ev.t < st.end && (st.from !== null || !!st.fromPose);
	if (moving && opts?.interrupt === 'finish') return st;
	let want = -1;
	if (ev.kind === 'toggle') want = st.to === 0 ? poses.length - 1 : 0; // closed <-> the LAST pose (open)
	else if (ev.kind === 'open') want = poses.length - 1;
	else if (ev.kind === 'close' || ev.kind === 'auto') want = 0;
	else if (ev.kind === 'goto') want = poseIndexOf(poses, ev.pose);
	if (want < 0 || want >= poses.length || (want === st.to && !moving)) return st;
	const here = doorPoseAt(st, poses, ev.t, opts?.ease).pose;
	const duration = Math.max(0, Number(opts?.duration ?? 0.6) || 0);
	return { from: st.to, fromPose: moving ? here : null, to: want, start: ev.t, end: ev.t + duration };
}
