import { writable, get } from 'svelte/store';
import { peers } from '../stores/appStore';
// The 'transport' history kind. Safe as a static import for the same reason
// scenePost's is: history's own subtree is three/stores/flowRuntime/editOverlays/
// meshBudget, and nothing in it reaches this module. KEEP IT THAT WAY — when B3 adds
// transport VALUE NODES, flowRuntime must reach the clock through a registered seam
// or a primed dynamic import, never a static edge, or the SSR prerender TDZ-crashes
// on the registerHistoryKind call below (the TDZ cycle family, three times now).
import { registerHistoryKind, recordEntry } from './history';
import { audioTimeFor, sampleAudioClock, primeAudioClock } from './audioEngine';

// The MUSICAL CLOCK (roadmap #23 A2, cloud plans-core/pending/23-a-audio-engine.md).
//
// Three things in one module, because they are one idea — "when is beat N":
//
//   1. THE TRANSPORT. A replicated latest-wins singleton on the scenePhysics /
//      scenePost shape: `{bpm, startedAt, playing, swing, barsPerLoop, changedAt}`,
//      ONE normalizer at every boundary, a monotonic stamp, `transport`/
//      `gettransport` on the wire, a snapshot/restore pair for the four save paths,
//      and a 'transport' history kind.
//   2. THE LOOK-AHEAD SCHEDULER. A 25 ms setInterval with a 100 ms horizon that turns
//      "at beat 4" into an exact `osc.start(t)` through `audioTimeFor`. This is why a
//      pattern is sample-accurate rather than rAF-accurate — and it runs on
//      setInterval, NOT rAF, because a background or throttled tab thins rAF and the
//      music would stutter (the same reason `physics` grew a fixed-timestep
//      accumulator).
//   3. THE PEER CLOCK-OFFSET ESTIMATE (finding 6). Nothing in the app measured
//      system-clock skew between peers before this; `syncedAnimations`, `soundRuntime`
//      and `sceneMusic` all assume every peer's `Date.now()` agrees. A `clockping` /
//      `clockpong` round trip estimates it NTP-style, median of the last N.
//
// ONE CLOCK BASIS (finding 5). Beats are `(Date.now() - startedAt) / 1000 * bpm / 60`
// — the `sceneMusic` basis, which has no daily wrap. `flowRuntime`'s
// `Date.now() % 86400000 / 1000` is LEFT ALONE ON PURPOSE: it is fine for a sine LFO
// and fatal for a transport, because a loop whose duration does not divide 86 400 s
// jumps phase at UTC midnight. Do not "unify" the two.
//
// WHAT SKEW ACTUALLY DOES — worked out for A2, because the plan's finding 6 said "a
// 300 ms offset puts a live-played note a third of a second off the receiver's beat",
// and that is only half right. Every stamp on the wire (`startedAt`, a live note's
// `at`) is a Date.now() on SOME peer's clock, and every receiver compares those raw
// numbers against its OWN Date.now():
//
//   - the BEAT of a note is `(noteStamp - startedAt) * bpm/60000`, a difference of two
//     wire numbers. It is the same on every peer regardless of skew — so with raw
//     stamps everywhere, every peer already agrees on WHICH BEAT a note fell on.
//   - what skew moves is the ABSOLUTE time each peer renders that beat: peer B's whole
//     grid sits (e_A - e_B) later than A's in real time. Over a network nobody can hear
//     that. In one physical room (the colocation lane) it is two speakers a third of a
//     second apart, and THAT is where an offset correction earns its place.
//   - correcting the note stamp ALONE — the plan's "applied to incoming live-note
//     timestamps only" — puts the note on the wrong beat by exactly the offset,
//     because the grid it lands against was not corrected. Correct BOTH the grid
//     (`startedAt`, by its AUTHOR's offset) and the stamp (by its SENDER's), or
//     neither. The estimator below makes both possible; nothing applies either yet,
//     and `correctRemoteStamp` is the primitive for the colocated case to opt into.
//   - what a remote listener DOES hear is LATENCY: a live note arrives L ms after it
//     was played, and if L exceeds the sender's clock lead it lands late by L - lead.
//     No clock estimate fixes that; a shared playback delay or grid quantization does,
//     and that is a C-lane decision the measured numbers below inform.
//
// MEASURED 2026-09-03 (suite `music-clock`, two peers on one machine so the TRUE skew
// is 0, over the self-hosted signaling box):  see the table in the suite header and
// the plan doc — the estimator's noise floor and its convergence on an injected
// +300 ms skew are both recorded there rather than repeated here, so there is one
// place to update.

// ---- the document -----------------------------------------------------------

/**
 * @typedef {object} Transport
 * @property {number} bpm          20..300
 * @property {number} startedAt    Date.now() stamp of beat 0 (0 = never started)
 * @property {boolean} playing
 * @property {number} swing        0..1 — how far the off-eighth is pushed late (1 = a 16th)
 * @property {number} barsPerLoop  1..64, the pattern length devices loop over
 * @property {number} changedAt    monotonic latest-wins stamp
 */

/** Fixed for A2 — a `beatsPerBar` field can join the document later through
 * `normalizeTransport` without a wire change (the scenePhysics B1 precedent). */
export const BEATS_PER_BAR = 4;

/** The shipped default. A transport equal to this writes NO `transport` key into a
 * save, so an ordinary scene's file is byte-identical to what it was before A2. */
export const DEFAULT_TRANSPORT = Object.freeze({
	bpm: 120,
	startedAt: 0,
	playing: false,
	swing: 0,
	barsPerLoop: 4,
	changedAt: 0
});

const CLAIMED = ['bpm', 'startedAt', 'playing', 'swing', 'barsPerLoop', 'changedAt', 'type'];

/** @param {any} v @param {number} lo @param {number} hi @param {number} fallback */
function num(v, lo, hi, fallback) {
	const n = typeof v === 'number' ? v : Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(lo, Math.min(hi, n));
}

/**
 * The ONE boundary normalizer — every store write (local edit, remote apply,
 * handshake, restore, history replay) goes through it. Clamps live HERE, so a stale
 * or hostile payload cannot install a tempo the UI could never produce. Unknown keys
 * are preserved verbatim, so a newer peer's field survives a round trip through us.
 * @param {any} raw @returns {Transport}
 */
export function normalizeTransport(raw) {
	const source = raw && typeof raw === 'object' ? raw : {};
	const d = DEFAULT_TRANSPORT;
	/** @type {any} */
	const state = {
		bpm: num(source.bpm, 20, 300, d.bpm),
		startedAt: num(source.startedAt, 0, Number.MAX_SAFE_INTEGER, d.startedAt),
		playing: typeof source.playing === 'boolean' ? source.playing : d.playing,
		swing: num(source.swing, 0, 1, d.swing),
		barsPerLoop: Math.round(num(source.barsPerLoop, 1, 64, d.barsPerLoop)),
		changedAt: typeof source.changedAt === 'number' && Number.isFinite(source.changedAt) ? source.changedAt : 0
	};
	for (const key of Object.keys(source)) if (!CLAIMED.includes(key)) state[key] = source[key];
	return state;
}

/** The shared transport. @type {import('svelte/store').Writable<Transport>} */
export const transport = writable(normalizeTransport(null));

// ---- beat maths (pure) --------------------------------------------------------

/**
 * Where the transport is at a wall-clock instant, in beats from `startedAt`.
 * 0 while stopped. Pure — the scheduler, the suite and a future value node all read
 * through this one function.
 * @param {Transport} state @param {number} [wallMs]
 */
export function beatAt(state, wallMs = Date.now()) {
	if (!state.playing || !state.startedAt) return 0;
	return Math.max(0, ((wallMs - state.startedAt) / 1000) * (state.bpm / 60));
}

/** The wall-clock stamp of a beat. @param {Transport} state @param {number} beat */
export function wallForBeat(state, beat) {
	return state.startedAt + (beat * 60000) / state.bpm;
}

/** The AUDIO-clock time of a beat — what a device hands to `osc.start(t)`.
 * @param {Transport} state @param {number} beat */
export function audioTimeForBeat(state, beat) {
	return audioTimeFor(wallForBeat(state, beat));
}

/** Beats in one pattern loop. @param {Transport} state */
export function loopBeats(state) {
	return state.barsPerLoop * BEATS_PER_BAR;
}

/**
 * Swing, the MPC definition: the OFF-EIGHTH step of each beat is pushed late by up to
 * a sixteenth. `swing` 0 is straight, 1 puts the off-eighth at 3/4 of the beat (the
 * "75%" setting), ~0.67 is a triplet feel. Only the exact off-eighth moves — a note on
 * a downbeat or a sixteenth is where it was — so a live-played note is never swung
 * (it is not on the grid) and a straight pattern is byte-identical at swing 0.
 * @param {number} beat @param {number} swing
 */
export function swungBeat(beat, swing) {
	if (!(swing > 0)) return beat;
	const frac = beat - Math.floor(beat);
	return Math.abs(frac - 0.5) < 1e-6 ? beat + swing * 0.25 : beat;
}

/** A read of the transport for a HUD or a value node: `{bpm, beat, bar, step, phase,
 * playing, loopBeats}`. `phase` is the position inside the current loop in 0..1. */
export function transportNow(wallMs = Date.now()) {
	const state = get(transport);
	const beat = beatAt(state, wallMs);
	const loop = loopBeats(state);
	return {
		bpm: state.bpm,
		playing: state.playing,
		beat,
		bar: Math.floor(beat / BEATS_PER_BAR),
		step: Math.floor((beat % BEATS_PER_BAR) * 4), // sixteenth within the bar's beat grid
		loopBeats: loop,
		phase: loop > 0 ? (beat % loop) / loop : 0,
		swing: state.swing
	};
}

// ---- editing (local + replicate) ---------------------------------------------

/** true while a history replay is writing, so the replay records nothing */
let applyingHistory = false;

/**
 * Write the document, stamp it, record ONE undo entry and replicate (latest-wins).
 *
 * BUMP PAST THE PREVIOUS STAMP, never a bare Date.now(): a gesture (a BPM scrub)
 * writes several times inside one millisecond, so those edits would share a stamp
 * and a receiver's `<=` guard would drop every one after the first — the drag AND
 * the undo after it silently failing to replicate. Documented, and it has bitten
 * twice already (shaderGraph, scenePost).
 * @param {(state: Transport) => Transport} fn
 */
function commit(fn) {
	const before = get(transport);
	const next = normalizeTransport(fn(before));
	next.changedAt = Math.max(Date.now(), (before.changedAt || 0) + 1);
	transport.set(next);
	if (!applyingHistory) recordTransportEntry(before, next);
	broadcastTransport();
	return next;
}

/** @param {Transport} before @param {Transport} after */
function recordTransportEntry(before, after) {
	const { changedAt: _b, ...b } = before;
	const { changedAt: _a, ...a } = after;
	if (JSON.stringify(a) === JSON.stringify(b)) return;
	recordEntry({ kind: 'transport', beforeState: before, afterState: after, before: 'before', after: 'after' });
}

// Replaying writes the stored document locally AND replicates it, so peers follow an
// undo like any other edit (the 'look' kind precedent).
registerHistoryKind('transport', (entry, state) => {
	const target = state === entry.before ? entry.beforeState : entry.afterState;
	applyingHistory = true;
	try {
		commit(() => target);
	} finally {
		applyingHistory = false;
	}
	return true;
});

/**
 * Patch any fields. A BPM change while PLAYING re-anchors `startedAt` so the beat
 * you are on is the beat you stay on — otherwise the beat position jumps by the
 * tempo ratio and every scheduled pattern lurches. Every peer receives the new
 * `{bpm, startedAt}` pair together, so they all compute the same continuous beat.
 * @param {Partial<Transport> & Record<string, any>} patch
 */
export function setTransport(patch) {
	return commit((state) => {
		/** @type {any} */
		const merged = { ...state, ...(patch ?? {}) };
		if (state.playing && typeof patch?.bpm === 'number' && patch.bpm !== state.bpm) {
			const now = Date.now();
			const bpm = num(patch.bpm, 20, 300, state.bpm);
			merged.bpm = bpm;
			merged.startedAt = now - (beatAt(state, now) * 60000) / bpm;
		}
		return merged;
	});
}

/** @param {number} bpm */
export function setBpm(bpm) {
	return setTransport({ bpm });
}

/** @param {number} swing 0..1 */
export function setSwing(swing) {
	return setTransport({ swing });
}

/** @param {number} bars */
export function setBarsPerLoop(bars) {
	return setTransport({ barsPerLoop: bars });
}

/** Start from beat 0 at `at` (default now). Every peer starts inside the same beat
 * from the same stamp — the `sceneMusic` loop-phase model. @param {number} [at] */
export function playTransport(at = Date.now()) {
	return commit((state) => ({ ...state, playing: true, startedAt: at }));
}

/** Stop. `startedAt` is kept (it is the record of the last run); `beatAt` reads 0. */
export function stopTransport() {
	return commit((state) => ({ ...state, playing: false }));
}

export function toggleTransport() {
	return get(transport).playing ? stopTransport() : playTransport();
}

// ---- replication --------------------------------------------------------------

/** Handshake payload (singleton push, like scenePhysicsState). */
export function transportState() {
	return { type: 'transport', ...get(transport) };
}

/** Send the current transport to every peer. */
export function broadcastTransport() {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send(transportState());
}

/**
 * Remote/handshake apply: newest change wins. Refuse only a STRICTLY older document —
 * an ordered DataConnection means an equal stamp arrived later, so it is the newer
 * intent (the scenePhysics rule). @param {any} data
 */
export function applyRemoteTransport(data) {
	const incoming = normalizeTransport(data);
	if (incoming.changedAt < (get(transport).changedAt || 0)) return false;
	transport.set(incoming);
	return true;
}

/**
 * Answer a `gettransport` re-pull, retrying until the connection opens (peerjs
 * silently drops anything sent before that). The handshake PUSHES `transportState()`
 * in both directions, so this is the explicit re-pull rather than the only path.
 * A never-touched transport says nothing — there is nothing to say.
 * @param {string} peerId
 */
export function sendTransport(peerId, attempt = 0) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	if (!(get(transport).changedAt > 0)) return;
	const conn = peer.connections[peerId];
	if (!conn || !conn.open) {
		if (attempt < 20) setTimeout(() => sendTransport(peerId, attempt + 1), 500);
		return;
	}
	conn.send(transportState());
}

// ---- persistence --------------------------------------------------------------

/** Is this transport musically the shipped default? `startedAt` is deliberately NOT
 * part of the answer — a transport that was played and stopped is still a default
 * one, and a save should not grow a field for having been pressed. Unknown fields
 * make it non-default: they are somebody's data. @param {Transport} state */
export function isDefaultTransport(state) {
	const d = DEFAULT_TRANSPORT;
	if (state.playing || state.bpm !== d.bpm || state.swing !== d.swing || state.barsPerLoop !== d.barsPerLoop) return false;
	return Object.keys(state).every((key) => CLAIMED.includes(key));
}

/** Save payload — null at the default, so an ordinary scene writes no `transport`
 * key at all (the scenePhysicsSnapshot precedent; sessions.js wires the call site). */
export function transportSnapshot() {
	const state = get(transport);
	return isDefaultTransport(state) ? null : { ...state };
}

/**
 * Restore from a save. An ABSENT payload resets to the default — a scene load is a
 * whole-world replace, so "the file says nothing" means "the author was at 120,
 * stopped", not "keep the room's tempo" (the scenePhysics A6 rule).
 *
 * A PLAYING transport restarts from beat 0 NOW: the saved `startedAt` is in the past
 * and every peer takes the same re-broadcast stamp, so the shared phase still agrees
 * (the musicRestore precedent). `resume: false` brings it back STOPPED — autosave's
 * choice, because a reload should not start the beat lab on its own.
 * @param {any} payload @param {boolean} [replicate] @param {{resume?: boolean}} [opts]
 */
export function transportRestore(payload, replicate = false, opts = {}) {
	const resume = opts.resume !== false;
	const next = normalizeTransport(payload);
	if (next.playing) {
		if (resume) next.startedAt = Date.now();
		else next.playing = false;
	}
	// a restore is an authoritative local write, so it must WIN over whatever changedAt
	// the file carries (an old file's stamp is in the past) — and stay monotonic, since
	// it can land in the same millisecond as the write before it
	next.changedAt = Math.max(Date.now(), (get(transport).changedAt || 0) + 1);
	transport.set(next);
	if (replicate) broadcastTransport();
	return next;
}

// ---- the look-ahead scheduler --------------------------------------------------

/** How often the scheduler looks. */
export const TICK_MS = 25;
/** How far ahead it commits events to the audio clock. */
export const HORIZON_MS = 100;
/** A (re)start fires events from this far in the past, so a device that registered
 * its pattern a frame before Play still gets beat 0. */
const LATE_GRACE_MS = 50;

/**
 * @typedef {object} ScheduledEvent
 * @property {number} id
 * @property {number} beat       one-shot beat, or the repeat's offset
 * @property {number} every      0 for a one-shot, else the repeat interval in beats
 * @property {number} nextK      repeats: index of the next occurrence to fire
 * @property {boolean} swing     apply the transport's swing to the fired beat
 * @property {(e: {beat: number, at: number, late: boolean, bpm: number, bar: number}) => void} fn
 */

/** @type {ScheduledEvent[]} */
let events = [];
let nextId = 1;
/** beat position up to which everything has been handed to the audio clock */
let scheduledThrough = -Infinity;
/** the transport identity the scheduler last saw — a change means a (re)start */
let lastRun = '';
/** when THIS peer first saw the current run (a local Play, or the remote document
 * landing). The (re)start's grace is measured from here, not from the tick that
 * notices it: the first tick after Play can land 100+ ms late on a busy main thread,
 * and measured from the tick beat 0 was already "in the past" and never fired. */
let runSeenAt = 0;
let seenRun = '';
/** @type {any} */
let timer = null;
let fired = 0;

/**
 * Schedule `fn` for a beat. It is called up to HORIZON_MS EARLY with the exact audio
 * time to start at: `fn({beat, at, late, bpm, bar})` — hand `at` to a voice's
 * `start(at)`, never play at call time. A beat already in the past fires on the next
 * tick with `late: true` and an `at` already gone, which WebAudio treats as "now": a
 * late-arriving note plays late rather than never.
 *
 * `opts.every` makes it REPEAT every N beats from `beat` on, for as long as the
 * transport runs. A repeat never replays the past — a late joiner at beat 37 gets
 * its first occurrence at or after 37, not thirty-seven catch-up hits.
 *
 * THE RULE FOR fn: it must be a PURE function of its arguments. The transport is the
 * deterministic-events model (golden rule 8) — every peer runs the same pattern from
 * the same `startedAt`, and an impure callback desyncs silently, per peer, with no
 * error anywhere.
 *
 * @param {number} beat @param {ScheduledEvent['fn']} fn
 * @param {{every?: number, swing?: boolean}} [opts]
 * @returns {() => void} cancel
 */
export function schedule(beat, fn, opts = {}) {
	const every = opts.every && opts.every > 0 ? opts.every : 0;
	/** @type {ScheduledEvent} */
	const event = { id: nextId++, beat, every, nextK: 0, swing: opts.swing !== false, fn };
	if (every) event.nextK = firstOccurrence(event, scheduledThrough);
	events.push(event);
	startScheduler();
	return () => {
		events = events.filter((e) => e !== event);
	};
}

/** Sugar: a repeating event. @param {number} every @param {ScheduledEvent['fn']} fn
 * @param {{offset?: number, swing?: boolean}} [opts] */
export function scheduleRepeat(every, fn, opts = {}) {
	return schedule(opts.offset ?? 0, fn, { every, swing: opts.swing });
}

/** Drop every scheduled event (a device teardown, a scene clear). */
export function clearScheduled() {
	events = [];
}

/** The first occurrence index of a repeat that lies strictly after `from`.
 * @param {ScheduledEvent} event @param {number} from */
function firstOccurrence(event, from) {
	if (!Number.isFinite(from)) return 0;
	return Math.max(0, Math.floor((from - event.beat) / event.every) + 1);
}

/** Idempotent. Started by the first `schedule`; runs whether or not the transport
 * plays, because a stopped transport costs one cheap read per tick and a device must
 * not have to know when Play was pressed. */
export function startScheduler() {
	if (timer != null || typeof setInterval === 'undefined') return;
	primeAudioClock();
	timer = setInterval(tick, TICK_MS);
}

export function stopScheduler() {
	if (timer != null) clearInterval(timer);
	timer = null;
}

/** @param {Transport} state */
function runKey(state) {
	return state.playing ? state.startedAt + '|' + state.bpm : '';
}

// Note the moment a run begins, synchronously with the store write (local or remote),
// and look ahead at once so beat 0 gets its `at` as early as possible.
transport.subscribe((state) => {
	const run = runKey(state);
	if (run === seenRun) return;
	seenRun = run;
	runSeenAt = Date.now();
	if (events.length) tick(runSeenAt);
});

/** One look-ahead pass. Exported for the suite, which drives it by hand to prove the
 * horizon and the no-double-fire rule without waiting on real time. */
export function tick(wallMs = Date.now()) {
	// feed the engine's clock filter every tick, so `audioTimeFor` sees many phases of
	// the device callback (see the clock section of audioEngine.js)
	sampleAudioClock();
	const state = get(transport);
	const run = runKey(state);
	if (run !== lastRun) {
		// a (re)start, a stop, or a re-anchoring tempo change: nothing handed to the
		// audio clock under the OLD run is worth remembering, and the past is not replayed.
		// "The past" is measured from when this peer SAW the run begin — a local Play
		// fires beat 0 however late this tick is; a late joiner starts where it joined.
		lastRun = run;
		const seen = run === seenRun && runSeenAt ? Math.min(runSeenAt, wallMs) : wallMs;
		scheduledThrough = state.playing ? beatAt(state, seen) - (LATE_GRACE_MS / 1000) * (state.bpm / 60) : -Infinity;
		for (const event of events) if (event.every) event.nextK = firstOccurrence(event, scheduledThrough);
	}
	if (!state.playing || !events.length) return;
	const until = beatAt(state, wallMs) + (HORIZON_MS / 1000) * (state.bpm / 60);
	if (until <= scheduledThrough) return;
	/** @type {ScheduledEvent[]} */
	const done = [];
	for (const event of events) {
		if (!event.every) {
			if (event.beat <= until) {
				fire(state, event, event.beat, event.beat <= scheduledThrough);
				done.push(event);
			}
			continue;
		}
		let beat = event.beat + event.nextK * event.every;
		while (beat <= until) {
			fire(state, event, beat, false);
			event.nextK++;
			beat = event.beat + event.nextK * event.every;
		}
	}
	if (done.length) events = events.filter((e) => !done.includes(e));
	scheduledThrough = until;
}

/** @param {Transport} state @param {ScheduledEvent} event @param {number} beat @param {boolean} late */
function fire(state, event, beat, late) {
	const swung = event.swing ? swungBeat(beat, state.swing) : beat;
	fired++;
	try {
		event.fn({ beat, at: audioTimeForBeat(state, swung), late, bpm: state.bpm, bar: Math.floor(beat / BEATS_PER_BAR) });
	} catch (error) {
		console.warn('[musicClock] a scheduled callback threw', error);
	}
}

// ---- peer clock offset (finding 6) ----------------------------------------------
//
// NTP's four-stamp round trip, over the data channel the peers already share:
//   t0  we send `clockping`            (our clock)
//   t1  they receive it                (their clock)
//   t2  they send `clockpong`          (their clock)
//   t3  we receive it                  (our clock)
//   rtt    = (t3 - t0) - (t2 - t1)
//   offset = ((t1 - t0) + (t2 - t3)) / 2       their clock minus ours
// The error of one sample is bounded by the round trip's ASYMMETRY, at most rtt/2.
// The estimate is the MEDIAN of the last N: a median rejects the one sample that
// went through a slow relay, a mean does not.

/** samples kept per peer */
const CLOCK_RING = 12;
/** how many pings the connect burst sends, how far apart, and how long after the
 * handshake it starts. MEASURED: samples taken during the connect storm (the joiner is
 * receiving objects, compiling shaders, first-painting) carried 100+ ms of one-sided
 * main-thread delay and pulled a 6-sample median to +427 ms on a true +300 — so the
 * burst waits for the storm to pass, and the filter below discounts what it catches. */
const BURST = 6;
const BURST_GAP_MS = 250;
const BURST_DELAY_MS = 2000;
/** steady-state re-measure, so a drifting clock is tracked and storm samples age out */
const RESYNC_MS = 5000;

/** @type {Record<string, {offsets: number[], rtts: number[]}>} */
const clockSamples = {};

/** peerId -> `{offset, rtt, samples}` — offset is THEIR clock minus OURS, in ms.
 * Local, derived, never replicated (the `peerQuality` precedent).
 * @type {import('svelte/store').Writable<Record<string, {offset: number, rtt: number, samples: number}>>} */
export const peerClocks = writable({});

/** @param {number[]} arr */
function median(arr) {
	const s = [...arr].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The estimate from a ring of samples: the MEDIAN OFFSET OF THE LOWEST-RTT HALF.
 *
 * A sample's error is its round trip's asymmetry, and asymmetry comes from queueing —
 * a packet that waited (in the network, or on a busy main thread before the handler
 * ran) is late on ONE leg. The samples with the shortest round trips waited the least,
 * so NTP's clock filter keeps the minimum-delay sample; taking the median of the best
 * half keeps that bias-rejection while still outvoting a single odd reading. Pure,
 * exported for the suite. @param {{offsets: number[], rtts: number[]}} ring
 */
export function estimateFromSamples(ring) {
	const n = ring.offsets.length;
	if (!n) return null;
	const order = ring.rtts.map((rtt, i) => i).sort((a, b) => ring.rtts[a] - ring.rtts[b]);
	const best = order.slice(0, Math.max(1, Math.ceil(n / 2)));
	return {
		offset: median(best.map((i) => ring.offsets[i])),
		rtt: median(best.map((i) => ring.rtts[i])),
		samples: n
	};
}

/**
 * Fold one measurement into a peer's ring and republish the median. Pure enough to
 * test without a connection. @param {string} peerId @param {number} offset @param {number} rtt
 */
export function recordClockSample(peerId, offset, rtt) {
	if (!Number.isFinite(offset) || !Number.isFinite(rtt) || rtt < 0) return;
	const ring = (clockSamples[peerId] ??= { offsets: [], rtts: [] });
	ring.offsets.push(offset);
	ring.rtts.push(rtt);
	while (ring.offsets.length > CLOCK_RING) {
		ring.offsets.shift();
		ring.rtts.shift();
	}
	const estimate = estimateFromSamples(ring);
	if (estimate) peerClocks.update((map) => ({ ...map, [peerId]: estimate }));
}

/** The estimated offset of a peer's clock from ours (ms, theirs minus ours), or null
 * before the first sample lands. @param {string} peerId */
export function peerClockOffset(peerId) {
	return get(peerClocks)[peerId]?.offset ?? null;
}

/**
 * A stamp taken on `peerId`'s clock, expressed on OURS. The primitive for the
 * colocated case (see the header): only meaningful when the GRID is corrected by the
 * same rule, so nothing in core applies it by default. Unknown peer = unchanged.
 * @param {string} peerId @param {number} wallMs
 */
export function correctRemoteStamp(peerId, wallMs) {
	const offset = peerClockOffset(peerId);
	return offset == null ? wallMs : wallMs - offset;
}

/** Drop a peer's samples (handleDisconnected — golden rule 3). @param {string} peerId */
export function dropPeerClock(peerId) {
	delete clockSamples[peerId];
	peerClocks.update((map) => {
		if (!(peerId in map)) return map;
		const next = { ...map };
		delete next[peerId];
		return next;
	});
}

/** @param {string} peerId @returns {any} the stable OUTGOING conn, or null */
function connFor(peerId) {
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.connections?.[peerId];
	return conn && conn.open ? conn : null;
}

/** One ping. Returns false when there is no open conn to send it on. @param {string} peerId */
export function sendClockPing(peerId) {
	const conn = connFor(peerId);
	if (!conn) return false;
	/** @type {any} */
	const peer = get(peers);
	conn.send({ type: 'clockping', sender: peer.peer.id, t0: Date.now() });
	return true;
}

/**
 * Answer a ping. Stamped on receipt (t1) and again on send (t2) so the responder's
 * own processing time is subtracted out of the round trip. Replies over our stable
 * OUTGOING conn to the sender (golden rule 9), falling back to the conn it arrived on
 * while the dance is still settling. @param {any} data @param {any} [arrivedOn]
 */
export function answerClockPing(data, arrivedOn) {
	const t1 = Date.now();
	if (!data || typeof data.t0 !== 'number') return;
	/** @type {any} */
	const peer = get(peers);
	const conn = connFor(data.sender) ?? (arrivedOn && arrivedOn.open ? arrivedOn : null);
	if (!conn) return;
	conn.send({ type: 'clockpong', sender: peer?.peer?.id ?? '', t0: data.t0, t1, t2: Date.now() });
}

/** Fold a pong into the sender's estimate. @param {any} data */
export function applyClockPong(data) {
	const t3 = Date.now();
	if (!data || typeof data.t0 !== 'number' || typeof data.t1 !== 'number' || typeof data.t2 !== 'number') return;
	if (!data.sender) return;
	const rtt = t3 - data.t0 - (data.t2 - data.t1);
	const offset = (data.t1 - data.t0 + (data.t2 - t3)) / 2;
	recordClockSample(String(data.sender), offset, rtt);
}

/** @type {any} */
let resyncTimer = null;

/**
 * Start measuring a peer: a short burst now (so an estimate exists within a second of
 * connecting — the median needs several samples before it means anything), then a
 * steady re-measure every RESYNC_MS for as long as the conn is open. Called from
 * `sendHandshake`, which is the one place a conn is known to be OPEN (golden rule 2).
 * @param {string} peerId
 */
export function startClockSync(peerId) {
	if (typeof setTimeout === 'undefined') return;
	for (let i = 0; i < BURST; i++) setTimeout(() => sendClockPing(peerId), BURST_DELAY_MS + i * BURST_GAP_MS);
	if (resyncTimer == null) {
		resyncTimer = setInterval(() => {
			/** @type {any} */
			const peer = get(peers);
			for (const id of Object.keys(peer?.connections ?? {})) sendClockPing(id);
		}, RESYNC_MS);
	}
}

// ---- debug ----------------------------------------------------------------------

/** What the clock holds — for `window.__stores` and the suite. */
export function clockDebug() {
	const state = get(transport);
	return {
		transport: { ...state },
		now: transportNow(),
		scheduler: {
			events: events.length,
			repeats: events.filter((e) => e.every).length,
			scheduledThrough,
			ticking: timer != null,
			fired,
			tickMs: TICK_MS,
			horizonMs: HORIZON_MS
		},
		peers: JSON.parse(JSON.stringify(get(peerClocks))),
		// the raw rings behind the medians, so a suite can read the DISTRIBUTION
		samples: JSON.parse(JSON.stringify(clockSamples))
	};
}
