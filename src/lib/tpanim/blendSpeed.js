// 57 M3: the Blend by Speed node's arithmetic — a LEAF of plain numbers (unit-tested).
// A 1D blend space: idle→walk between 0 and the walk speed, walk→run between the walk and run
// speeds, the walk/run clips played faster or slower so the feet keep pace (within limits, past
// which a stride looks wrong). A missing slot hands its range to its neighbour.

const RATE_MIN = 0.6;
const RATE_MAX = 1.6;
/** below this the body stands (m/s) — the avatars' locomotion constant */
export const IDLE_SPEED = 0.15;

/**
 * Target weights + clip rates for a speed.
 * @param {number} speed m/s
 * @param {{walkSpeed?: number, runSpeed?: number, idle?: boolean, walk?: boolean, run?: boolean}} o which slots have a clip
 * @returns {{weights: {idle: number, walk: number, run: number}, rates: {idle: number, walk: number, run: number}}}
 */
export function blendSpeedWeights(speed, o = {}) {
	const s = Math.max(0, Number(speed) || 0);
	const W = Math.max(0.05, o.walkSpeed ?? 1.4);
	const R = Math.max(W + 0.05, o.runSpeed ?? 3.5);
	const has = { idle: o.idle !== false, walk: o.walk !== false, run: o.run !== false };
	let idle = 0;
	let walk = 0;
	let run = 0;
	if (s <= IDLE_SPEED) idle = 1;
	else if (s < W) {
		const k = (s - IDLE_SPEED) / (W - IDLE_SPEED);
		idle = 1 - k;
		walk = k;
	} else if (s < R) {
		const k = (s - W) / (R - W);
		walk = 1 - k;
		run = k;
	} else run = 1;
	// a slot with no clip gives its weight to the nearest one that has one
	if (!has.run) [walk, run] = [walk + run, 0];
	if (!has.walk) {
		if (has.run && s >= W / 2) [run, walk] = [run + walk, 0];
		else [idle, walk] = [idle + walk, 0];
	}
	if (!has.idle) [walk, idle] = has.walk ? [walk + idle, 0] : [walk, idle];
	if (!has.idle && !has.walk && has.run) [run, idle] = [run + idle, 0];
	const clamp = (/** @type {number} */ x) => Math.min(RATE_MAX, Math.max(RATE_MIN, x));
	return {
		weights: { idle, walk, run },
		rates: { idle: 1, walk: has.walk ? clamp(s / W) : 1, run: has.run ? clamp(s / R) : has.walk ? clamp(s / W) : 1 }
	};
}

/**
 * Ease current weights toward the targets: 95 % of the way in `crossfade` seconds (0 = snap).
 * @param {Record<string, number>} cur @param {Record<string, number>} target @param {number} dt @param {number} crossfade
 * @returns {Record<string, number>}
 */
export function smoothWeights(cur, target, dt, crossfade) {
	if (!(crossfade > 0)) return { ...target };
	const k = 1 - Math.exp((-3 * Math.max(0, dt)) / crossfade);
	/** @type {Record<string, number>} */
	const out = {};
	for (const key of new Set([...Object.keys(cur), ...Object.keys(target)])) out[key] = (cur[key] ?? 0) + ((target[key] ?? 0) - (cur[key] ?? 0)) * k;
	return out;
}

const AUTO = {
	idle: /idle|stand|breath/i,
	walk: /walk(?!.*back)|stroll/i,
	run: /run(?!.*strafe)|sprint|jog/i
};

/**
 * The clip for a slot: the one named in the node, else the first of the model's clips whose name
 * says it (Idle / Walking_A / Running_A …). '' = none.
 * @param {string[]} names the model's clips @param {'idle'|'walk'|'run'} slot @param {string} [wanted]
 */
export function clipForSlot(names, slot, wanted) {
	const w = String(wanted ?? '').trim();
	if (w) return names.includes(w) ? w : '';
	return names.find((n) => AUTO[slot].test(n)) ?? '';
}
