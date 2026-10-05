// 36-avatars (plan 76.2): idle / walk / run / strafe / backwards / airborne from the CAMERA STREAM a
// peer already sends — no message of its own. A LEAF of plain numbers.
//
// The stream arrives at 20-30 Hz and `moveCamera` SNAPS the avatar root to each sample, so a velocity
// read frame-to-frame is a spike on one frame and zero on the next. The tracker differentiates per
// SAMPLE (only when the position actually changed) and low-passes the result; a hop over TELEPORT_M
// is a teleport and resets instead of reading as a sprint.

export const TELEPORT_M = 3;
/** below this the body stands (m/s) */
export const IDLE_SPEED = 0.15;
/** the walk clip's natural pace (m/s, world) — timeScale = speed / this */
export const WALK_SPEED = 1.3;
/** above this the run clip takes over (m/s) */
export const RUN_SPEED = 2.6;
export const RUN_CLIP_SPEED = 3.6;
/** vertical speed that reads as flying/falling with no ground under the feet (m/s) */
export const AIR_SPEED = 1.2;

/** the clip slots the blend writes */
export const SLOTS = ['idle', 'walk', 'back', 'run', 'strafeLeft', 'strafeRight', 'air'];

/** @returns {{vel: number[], last: number[] | null, lastT: number, still: number}} */
export function newTracker() {
	return { vel: [0, 0, 0], last: null, lastT: 0, still: 0 };
}

/**
 * Feed the root's position at time `t` (seconds). Returns the tracker (mutated).
 * @param {ReturnType<typeof newTracker>} tr @param {number[]} pos @param {number} t
 */
export function trackPose(tr, pos, t) {
	if (!tr.last) {
		tr.last = [pos[0], pos[1], pos[2]];
		tr.lastT = t;
		return tr;
	}
	const dx = pos[0] - tr.last[0];
	const dy = pos[1] - tr.last[1];
	const dz = pos[2] - tr.last[2];
	const moved = Math.hypot(dx, dy, dz);
	const dt = t - tr.lastT;
	if (moved > TELEPORT_M) {
		tr.vel = [0, 0, 0];
		tr.last = [pos[0], pos[1], pos[2]];
		tr.lastT = t;
		return tr;
	}
	if (moved > 1e-5 && dt > 1e-3) {
		// a new sample: blend its velocity in
		const k = Math.min(1, dt / 0.15);
		const v = [dx / dt, dy / dt, dz / dt];
		for (let i = 0; i < 3; i++) tr.vel[i] += (v[i] - tr.vel[i]) * k;
		tr.last = [pos[0], pos[1], pos[2]];
		tr.lastT = t;
		tr.still = 0;
	} else if (dt > 0.12) {
		// no new sample for longer than the stream's cadence: the peer stopped. Decay to rest.
		const k = Math.min(1, (dt - 0.12) / 0.2);
		for (let i = 0; i < 3; i++) tr.vel[i] *= 1 - k;
		tr.still = dt;
	}
	return tr;
}

/**
 * Split a world velocity into the body's frame.
 * @param {number[]} vel @param {number} bodyYaw (0 faces -Z)
 */
export function bodyFrameVelocity(vel, bodyYaw) {
	const fx = -Math.sin(bodyYaw);
	const fz = -Math.cos(bodyYaw);
	// right = forward rotated -90deg about Y
	const rx = -fz;
	const rz = fx;
	return {
		forward: vel[0] * fx + vel[2] * fz,
		strafe: vel[0] * rx + vel[2] * rz,
		vertical: vel[1]
	};
}

/**
 * Target weights (sum 1) and playback rates for each slot.
 * @param {{forward: number, strafe: number, vertical: number}} v
 * @returns {{weights: Record<string, number>, rates: Record<string, number>}}
 */
export function locomotionWeights({ forward, strafe, vertical }) {
	/** @type {Record<string, number>} */
	const w = { idle: 0, walk: 0, back: 0, run: 0, strafeLeft: 0, strafeRight: 0, air: 0 };
	/** @type {Record<string, number>} */
	const rate = { idle: 1, walk: 1, back: 1, run: 1, strafeLeft: 1, strafeRight: 1, air: 1 };
	const flat = Math.hypot(forward, strafe);
	// flying (an editor camera rising/sinking, a fall): the airborne pose, legs tucked
	if (Math.abs(vertical) > AIR_SPEED && Math.abs(vertical) > flat) {
		w.air = 1;
		return { weights: w, rates: rate };
	}
	if (flat < IDLE_SPEED) {
		w.idle = 1;
		return { weights: w, rates: rate };
	}
	// how much of the motion is sideways (0 = straight, 1 = pure strafe)
	const side = Math.abs(strafe) / flat;
	const sideW = Math.max(0, Math.min(1, (side - 0.45) / 0.35));
	const straightW = 1 - sideW;
	// ramp in from idle over the first half metre per second
	const go = Math.min(1, (flat - IDLE_SPEED) / 0.5);
	w.idle = 1 - go;
	if (straightW > 0) {
		if (forward < 0) {
			w.back = straightW * go;
			rate.back = clampRate(flat / WALK_SPEED);
		} else {
			// walk -> run crossfade between WALK_SPEED*1.4 and RUN_SPEED
			const runW = Math.max(0, Math.min(1, (flat - WALK_SPEED * 1.4) / (RUN_SPEED - WALK_SPEED * 1.4)));
			w.walk = straightW * go * (1 - runW);
			w.run = straightW * go * runW;
			rate.walk = clampRate(flat / WALK_SPEED);
			rate.run = clampRate(flat / RUN_CLIP_SPEED);
		}
	}
	if (sideW > 0) {
		const slot = strafe < 0 ? 'strafeLeft' : 'strafeRight';
		w[slot] = sideW * go;
		rate[slot] = clampRate(flat / RUN_CLIP_SPEED);
	}
	return { weights: w, rates: rate };
}

/** @param {number} r */
function clampRate(r) {
	return Math.max(0.4, Math.min(2.2, r));
}

/**
 * Ease the live weights toward the targets (time constant `tau` s) and renormalise.
 * @param {Record<string, number>} cur @param {Record<string, number>} target @param {number} dt @param {number} [tau]
 */
export function approachWeights(cur, target, dt, tau = 0.18) {
	const k = 1 - Math.exp(-Math.max(0, dt) / tau);
	let sum = 0;
	for (const s of SLOTS) {
		cur[s] = (cur[s] ?? 0) + ((target[s] ?? 0) - (cur[s] ?? 0)) * k;
		sum += cur[s];
	}
	if (sum > 1e-6) for (const s of SLOTS) cur[s] /= sum;
	else cur.idle = 1;
	return cur;
}
