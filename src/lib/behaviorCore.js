// 33 P2 — ANIMATED, FUNCTIONAL PACK ITEMS: the pure half (imports NOTHING, so vitest
// covers it with no browser). The runtime that drives the mixer, the wire, the triggers
// and the colliders is packBehavior.js.
//
// THE CONTRACT (roadmap 33, P2): a pack item MAY carry
//   behavior: {type: 'door'|'toggle'|'oneshot'|'loop', clip, closeClip?, trigger:
//              'click'|'proximity'|'knock', autoplay: false, sound?, collider?: 'follow'}
// and the rule the user asked for: NOTHING plays on placement, on load or in Edit, and
// nothing loops unless it is an ambient `loop` with `autoplay: true`.
//
// THE STATE is runtime and shared: `{on, at, from, n}` — `on` is open/running, `at` the
// SESSION ms of the last trigger (sessionNow, so every peer evaluates the same moment),
// `from` where the movement started in OPEN-clip seconds (a door closed half-way opens
// from where it is, not from shut), `n` the trigger count (a oneshot's identity, and the
// tie-break for two triggers in one millisecond). Every pose is a pure function of
// (spec, state, durations, now) — determinism is the netcode, so a toggle is ONE message.

export const BEHAVIOR_TYPES = ['door', 'toggle', 'oneshot', 'loop'];
export const BEHAVIOR_TRIGGERS = ['click', 'proximity', 'knock'];
/** the proximity trigger's radius (metres from the object's box) */
export const PROXIMITY_RADIUS = 1.5;
/** the slowest hand that counts as a knock (m/s) */
export const KNOCK_SPEED = 0.6;
const NAME_MAX = 64;

/**
 * @typedef {{type: 'door'|'toggle'|'oneshot'|'loop', clip: string, closeClip: string | null,
 *   trigger: 'click'|'proximity'|'knock', autoplay: boolean, sound: string | null,
 *   collider: 'follow' | null}} BehaviorSpec
 * @typedef {{on: boolean, at: number, from: number, n: number}} BehaviorState
 */

/** @param {any} v */
function clipName(v) {
	return typeof v === 'string' && v.trim() ? v.trim().slice(0, NAME_MAX) : null;
}

/**
 * The ONE boundary: a pack row, GLB extras or a wire message in, a clean spec or null out.
 * Unknown keys are dropped (the spec is small and fully understood); a missing `clip` is
 * null — there is nothing to drive. `autoplay` is honoured ONLY for `loop` (the rule).
 * `collider` defaults to 'follow' for a door (a door you cannot walk through when it is open
 * is not a door) and to none otherwise.
 * @param {any} raw @returns {BehaviorSpec | null}
 */
export function normalizeBehavior(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const type = BEHAVIOR_TYPES.includes(raw.type) ? raw.type : null;
	const clip = clipName(raw.clip);
	if (!type || !clip) return null;
	const trigger = BEHAVIOR_TRIGGERS.includes(raw.trigger) ? raw.trigger : 'click';
	const closeClip = type === 'door' || type === 'toggle' ? clipName(raw.closeClip) : null;
	const collider =
		raw.collider === 'follow' || (raw.collider === undefined && type === 'door') ? 'follow' : null;
	return {
		type,
		clip,
		closeClip: closeClip && closeClip !== clip ? closeClip : null,
		trigger,
		autoplay: type === 'loop' && raw.autoplay === true,
		sound: clipName(raw.sound),
		collider
	};
}

/** @returns {BehaviorState} the state before anything happened */
export function restState() {
	return { on: false, at: 0, from: 0, n: 0 };
}

/** @param {any} raw @returns {BehaviorState | null} a wire/save state, checked */
export function normalizeState(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const at = Number(raw.at);
	const from = Number(raw.from);
	const n = Number(raw.n);
	if (!Number.isFinite(at) || !Number.isFinite(from) || !Number.isFinite(n)) return null;
	return { on: raw.on === true, at, from: Math.max(0, from), n: Math.max(0, Math.floor(n)) };
}

/**
 * Latest wins: the newer stamp, then the higher count (two triggers inside one ms).
 * @param {BehaviorState | null} mine @param {BehaviorState} theirs @returns {boolean}
 */
export function stateIsNewer(mine, theirs) {
	if (!mine) return true;
	if (theirs.at !== mine.at) return theirs.at > mine.at;
	return theirs.n > mine.n;
}

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
	return Math.min(hi, Math.max(lo, v));
}

/**
 * How far along the OPEN clip a door/toggle is now (seconds, 0 = shut, `open` = full).
 * Moves at clip speed from `from` toward the end the state points at.
 * @param {BehaviorState} state @param {number} openDur @param {number} nowMs
 */
export function openPosition(state, openDur, nowMs) {
	const dur = Math.max(1e-3, openDur);
	if (!state.n) return 0;
	const elapsed = Math.max(0, (nowMs - state.at) / 1000);
	const from = clamp(state.from, 0, dur);
	return state.on ? Math.min(dur, from + elapsed) : Math.max(0, from - elapsed);
}

/**
 * THE POSE: which clip to show and at what time. `active` false is Edit (the user's rule:
 * the rest pose, whatever the shared state says) — and the rest pose is the OPEN clip at 0.
 * `durations` maps clip name -> seconds. A `closeClip` is played while closing, mapped so a
 * half-open door closes from half-way: progress through it = 1 - openPosition / openDur.
 * @param {BehaviorSpec} spec @param {BehaviorState} state
 * @param {Record<string, number>} durations @param {number} nowMs @param {boolean} active
 * @returns {{clip: string, time: number, moving: boolean}}
 */
export function poseAt(spec, state, durations, nowMs, active) {
	const dur = Math.max(1e-3, durations[spec.clip] ?? 1);
	const rest = { clip: spec.clip, time: 0, moving: false };
	if (!active) return rest;
	const elapsed = Math.max(0, (nowMs - state.at) / 1000);
	if (spec.type === 'loop') {
		const running = spec.autoplay || state.on;
		if (!running) return rest;
		// ambient loops share the session clock's phase; a triggered one starts at its stamp
		const t = spec.autoplay ? nowMs / 1000 : elapsed;
		return { clip: spec.clip, time: ((t % dur) + dur) % dur, moving: true };
	}
	if (spec.type === 'oneshot') {
		if (!state.n) return rest;
		const time = Math.min(dur, elapsed);
		return { clip: spec.clip, time, moving: time < dur };
	}
	// door / toggle
	const pos = openPosition(state, dur, nowMs);
	const moving = state.n > 0 && (state.on ? pos < dur : pos > 0);
	if (!state.on && spec.closeClip && durations[spec.closeClip] && state.n) {
		const cdur = Math.max(1e-3, durations[spec.closeClip]);
		return { clip: spec.closeClip, time: (1 - pos / dur) * cdur, moving };
	}
	return { clip: spec.clip, time: pos, moving };
}

/**
 * The next state after a trigger at `nowMs` (the press, a knock, the proximity edge).
 * `want` forces a direction (proximity: true on the rising edge, false on the falling one);
 * undefined toggles. A oneshot always restarts; a loop starts/stops. Returns null when
 * nothing would change (a proximity open on an already-open door).
 * @param {BehaviorSpec} spec @param {BehaviorState} state @param {Record<string, number>} durations
 * @param {number} nowMs @param {boolean} [want] @returns {BehaviorState | null}
 */
export function nextState(spec, state, durations, nowMs, want) {
	const n = state.n + 1;
	if (spec.type === 'oneshot') return { on: true, at: nowMs, from: 0, n };
	if (spec.type === 'loop') {
		if (spec.autoplay) return null; // ambient: nothing to trigger
		const on = want === undefined ? !state.on : want;
		return on === state.on && state.n ? null : { on, at: nowMs, from: 0, n };
	}
	const on = want === undefined ? !state.on : want;
	if (on === state.on && state.n) return null;
	const dur = Math.max(1e-3, durations[spec.clip] ?? 1);
	return { on, at: nowMs, from: openPosition(state, dur, nowMs), n };
}

/**
 * A box MINUS a box, as slabs: the part of `outer` not covered by `hole`, in up to six
 * axis-aligned pieces (below/above the hole on x, then y, then z, each later axis inside
 * the earlier ones' range). Slabs thinner than `minSize` are dropped — along a door's
 * thickness the hole spans (nearly) the whole frame, so those slabs would be slivers.
 * Boxes are [minx, miny, minz, maxx, maxy, maxz]. Used to cut a doorway out of a frame
 * whose mesh is one piece (two posts and a lintel make ONE box, which would block the
 * opening forever).
 * @param {number[]} outer @param {number[]} hole @param {number} [minSize]
 * @returns {number[][]}
 */
export function boxMinusBox(outer, hole, minSize = 0.01) {
	const h = [0, 1, 2].map((a) => [clamp(hole[a], outer[a], outer[a + 3]), clamp(hole[a + 3], outer[a], outer[a + 3])]);
	if (h.some(([lo, hi]) => hi - lo <= 0)) return [outer.slice()]; // no overlap
	/** @type {number[][]} */
	const out = [];
	const cur = outer.slice();
	for (let a = 0; a < 3; a++) {
		const [lo, hi] = h[a];
		if (lo - cur[a] >= minSize) {
			const s = cur.slice();
			s[a + 3] = lo;
			out.push(s);
		}
		if (cur[a + 3] - hi >= minSize) {
			const s = cur.slice();
			s[a] = hi;
			out.push(s);
		}
		cur[a] = lo;
		cur[a + 3] = hi;
	}
	return out;
}

/** does box `a` overlap box `b` (strictly, by more than `eps`)? @param {number[]} a @param {number[]} b */
export function boxesOverlap(a, b, eps = 1e-4) {
	for (let i = 0; i < 3; i++) if (a[i + 3] - eps <= b[i] || b[i + 3] - eps <= a[i]) return false;
	return true;
}

/**
 * The frame's collider pieces: each static box, minus every moving part's REST box it
 * overlaps (a moving part that sits inside a static mesh's box is a doorway, a lid, a
 * hatch — the opening must stay open). Pure over boxes in the object's local frame.
 * @param {number[][]} staticBoxes @param {number[][]} movingBoxes @returns {number[][]}
 */
export function frameSlabs(staticBoxes, movingBoxes) {
	/** @type {number[][]} */
	let pieces = staticBoxes.map((b) => b.slice());
	for (const hole of movingBoxes) {
		/** @type {number[][]} */
		const next = [];
		for (const piece of pieces) {
			if (boxesOverlap(piece, hole)) next.push(...boxMinusBox(piece, passageThrough(piece, hole)));
			else next.push(piece);
		}
		pieces = next;
	}
	// 33-scenes: a leftover thinner than MIN_SLAB on any axis is the edge of a part that sits
	// ON the moving one (a garden gate's iron straps are a static mesh 1 cm proud of the leaf):
	// it draws nothing a player could stand against, and as a collider it was a 1.76 m wide wall
	// in the open gateway (measured: the walker stopped at the open Garden gate)
	return pieces.filter((b) => b[3] - b[0] >= MIN_SLAB && b[4] - b[1] >= MIN_SLAB && b[5] - b[2] >= MIN_SLAB);
}

/** a slab thinner than this on any axis is dropped (see frameSlabs) */
const MIN_SLAB = 0.02;

/** a frame no deeper than this is a wall/doorway the opening passes THROUGH */
const PASSAGE_DEPTH = 0.6;
/** 33-scenes: a passage under a frame this much taller than its leaf is open to the frame's top */
const OPEN_ABOVE = 0.4;

/**
 * A door leaf is thinner than the frame it hangs in (the frame is the wall's depth), so
 * cutting just the leaf's box leaves a sliver in front of and behind it that still blocks
 * the doorway. When the moving part's THIN axis lies inside a shallow static box, the hole
 * runs through that box's whole depth on that axis. A lid sitting ON a chest never enters
 * here (they only touch), and a deep box keeps its exact hole.
 * @param {number[]} piece @param {number[]} hole @returns {number[]}
 */
export function passageThrough(piece, hole) {
	let thin = 0;
	for (let a = 1; a < 3; a++) if (hole[a + 3] - hole[a] < hole[thin + 3] - hole[thin]) thin = a;
	const depth = piece[thin + 3] - piece[thin];
	const inside = hole[thin] >= piece[thin] - 1e-4 && hole[thin + 3] <= piece[thin + 3] + 1e-4;
	if (depth > PASSAGE_DEPTH || !inside) return hole;
	const out = hole.slice();
	out[thin] = piece[thin];
	out[thin + 3] = piece[thin + 3];
	// 33-scenes: a LOW leaf in a TALL frame (a garden gate under its crossbar, ~1 m of picket
	// under a 2 m frame) leaves the frame box above the leaf as one solid slab across the
	// gateway. The gap over a gate is air, so a vertical passage runs to the top of its frame
	// box. A thin crossbar is not worth a collider: kept as a lintel slab it caught the walker's
	// head on a raised path (the town kit's gate frame tops out at 1.96 m; capsule top 1.87 m).
	// A door's leaf fills its frame, so a door keeps its lintel unchanged
	if (thin !== 1 && piece[4] - out[4] > OPEN_ABOVE) out[4] = piece[4];
	return out;
}

/** the 8 corners of a box as a flat xyz list (a custom collider piece is a hull of points)
 * @param {number[]} b @returns {number[]} */
export function boxCorners(b) {
	const out = [];
	for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) out.push(x, y, z);
	return out;
}

/** The sound a trigger plays when the item names none, per type. @param {BehaviorSpec} spec */
export function defaultSound(spec) {
	return spec.type === 'door' ? 'door' : spec.type === 'oneshot' ? 'lever' : spec.type === 'toggle' ? 'click' : null;
}
