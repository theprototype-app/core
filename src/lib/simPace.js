// 78 F25 — A SLOW PHYSICS INITIATOR SLOWED THE WHOLE SESSION. Only the initiator steps the world
// and everyone else watches its stream, so the initiator's frame rate is everybody's clock. Two
// fixes, both here as pure rules (physics.js does the plumbing):
//
//   1. PACE: the feed was capped at 0.25 s of sim time per frame and 8 substeps, and the backlog
//      beyond that was thrown away — below ~30 fps the world ran in slow motion. Now the caps
//      follow what this device can afford: as many substeps as fit a stepping budget (measured
//      substep cost), up to 60, and (78-int u1) 0.25 s of feed per frame, so sim time keeps up with wall
//      time unless the STEPPING itself is what is slow (78-int u1: the feed is back to 0.25 s, see MAX_FEED) (the 26-G slow-step guard stays the
//      backstop: the budget keeps a frame's stepping well under its 24 ms line).
//   2. HANDOFF: every peer reports its frame time while a run is on (`simvote`); the initiator
//      hands the world — with each body's velocity — to a peer that is clearly faster (at most
//      60 % of its frame time) for 3 s running, at most once per 10 s. An AI agent never votes,
//      so the 1.48.0 rule (an agent page never steps) holds.
import { writable } from 'svelte/store';

export const BASE_SUBSTEPS = 8;
export const HARD_SUBSTEPS = 60;
export const BASE_FEED = 0.25;
// 78-int u1: the feed stays at 0.25 s a frame (it was 1 s). Only the initiator steps the world, so no
// cross-peer determinism needs more, and a 1 s / 60-substep catch-up after a hitch (a Quest, a phone, a tab
// switch) moved every body a whole second in one frame — crates teleported and a throw read on the next frame
// had already landed. A hitch past 0.25 s is dropped as before F25; the adaptive SUBSTEPS still keep a steadily
// slow device in real time (14 ms budget, up to 60)
export const MAX_FEED = BASE_FEED;
/** ms of stepping a frame may spend catching up (under the slow-step guard's 24 ms, with room
 * for the write-back and the broadcast that follow the substeps) */
export const STEP_BUDGET_MS = 14;

export const HANDOFF_MARGIN = 0.6;
export const HANDOFF_SUSTAIN_MS = 3000;
export const HANDOFF_COOLDOWN_MS = 10000;
export const VOTE_EVERY_MS = 1500;
export const VOTE_STALE_MS = 6000;

/**
 * How many substeps and how much sim time one frame may take, from the measured cost of a
 * substep. PURE. @param {number} substepMs EMA of one substep's cost (0 = unknown)
 * @param {number} fixedDt @returns {{maxSub: number, feed: number}}
 */
export function paceLimits(substepMs, fixedDt) {
	// an UNKNOWN cost (the first frame of a run) takes the old caps: a heavy scene's first frame
	// must not try 60 substeps before anything has been measured
	const fit = substepMs > 0 ? Math.floor(STEP_BUDGET_MS / substepMs) : BASE_SUBSTEPS;
	const maxSub = Math.max(BASE_SUBSTEPS, Math.min(HARD_SUBSTEPS, fit));
	const feed = Math.max(BASE_FEED, Math.min(MAX_FEED, maxSub * fixedDt));
	return { maxSub, feed };
}

/**
 * The peer the world should move to, or null: the fastest FRESH vote at most HANDOFF_MARGIN of
 * my own frame time. PURE. @param {number} mineMs @param {{peerId: string, frameMs: number, at: number}[]} votes
 * @param {number} now @returns {string | null}
 */
export function handoffCandidate(mineMs, votes, now) {
	if (!(mineMs > 0)) return null;
	let best = null;
	for (const v of votes) {
		if (!(v.frameMs > 0) || now - v.at > VOTE_STALE_MS) continue;
		if (v.frameMs > mineMs * HANDOFF_MARGIN) continue;
		if (!best || v.frameMs < best.frameMs || (v.frameMs === best.frameMs && v.peerId < best.peerId)) best = v;
	}
	return best ? best.peerId : null;
}

/**
 * The sustain + cooldown half: feed it the candidate each vote round; it answers the peer to hand
 * to once the same one has stayed best for HANDOFF_SUSTAIN_MS. PURE over its state object.
 * @param {{candidate: string | null, since: number, lastHandoff: number}} state (mutated)
 * @param {string | null} candidate @param {number} now @returns {string | null}
 */
export function handoffDue(state, candidate, now) {
	if (candidate !== state.candidate) {
		state.candidate = candidate;
		state.since = now;
		return null;
	}
	if (!candidate || now - state.since < HANDOFF_SUSTAIN_MS || now - state.lastHandoff < HANDOFF_COOLDOWN_MS) return null;
	state.lastHandoff = now;
	state.candidate = null;
	return candidate;
}

/** 78-int u1: how long after the last carry ends the handoff still waits (a throw is in flight) */
export const HANDOFF_SETTLE_MS = 2000;

/**
 * 78-int u1: NO HANDOFF WHILE SOMETHING IS CARRIED. A body held by a player (ours, 'user', or a peer's
 * move stream, 'external') lives in THIS world's hold; handing the world over mid-carry dropped the hold and
 * the release then landed on a world that had no carry (a throw arrived at 0 m/s). The vote waits while any
 * body is held and for HANDOFF_SETTLE_MS after the last one was let go. PURE.
 * @param {boolean} holding is any body held right now @param {number} lastHeldAt ms (0 = never) @param {number} now
 * @returns {boolean}
 */
export function handoffBlocked(holding, lastHeldAt, now) {
	if (holding) return true;
	return lastHeldAt > 0 && now - lastHeldAt < HANDOFF_SETTLE_MS;
}

// ---- this device's frame time (EMA of rAF deltas) ------------------------------------------

/** ms per frame on this device, smoothed (0 until measured) */
export const frameMs = writable(0);
let ema = 0;
let meterOn = false;
/** start measuring (idempotent; a browser only) */
export function startFrameMeter() {
	if (meterOn || typeof requestAnimationFrame !== 'function') return;
	meterOn = true;
	let last = performance.now();
	const tick = () => {
		const now = performance.now();
		const dt = Math.min(2000, now - last);
		last = now;
		ema = ema ? ema * 0.9 + dt * 0.1 : dt;
		frameMs.set(Math.round(ema * 10) / 10);
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}
/** the current smoothed frame time @returns {number} */
export function currentFrameMs() {
	return ema;
}
