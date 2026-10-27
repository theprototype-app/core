// 51 — DEVICE THINNING, the pure half (imports NOTHING; unit-tested in tests/unit/scatterThin.test.js).
//
// The user's ruling (2026-10-21): the SAME layout everywhere; a weaker device draws fewer FAR
// instances, faded out by distance, so the scatter stays inside the budget meter's line for that
// device — and the NEAR instances and every COLLIDER stay identical, so gameplay matches.
//
// THE PLAN is one distance: walk the instances nearest first, adding each one's triangles, and
// stop where the budget runs out — that distance is the CUTOFF. Everything inside NEAR_KEEP is
// drawn whatever it costs (what you can walk into is never thinned). The last FADE_BAND share of
// the way to the cutoff shrinks an instance smoothly to nothing, so the edge reads as a fade
// rather than a line of rocks popping as you walk.

/** metres around the viewer that are never thinned */
export const NEAR_KEEP = 30;
/** the share of the distance to the cutoff over which an instance shrinks away */
export const FADE_BAND = 0.2;
/** the share of a device's triangle line scatter may take (the rest is the scene's own) */
export const SCATTER_SHARE = 0.5;

/** @typedef {'quest' | 'phone' | 'desktop'} ThinProfile */

/**
 * The triangle budget scatter gets on a device: its share of the target's line, raised to what
 * is left once the rest of the scene is counted when that is known (`others`, the scene's own
 * triangles) — never below a quarter of the line, never above the whole of it.
 * @param {number} line the target's triangle budget (budgets.json) @param {number} [others]
 */
export function scatterBudget(line, others) {
	if (!Number.isFinite(line) || line <= 0) return Infinity;
	if (!Number.isFinite(others) || /** @type {number} */ (others) < 0) return line * SCATTER_SHARE;
	return Math.min(line, Math.max(line * 0.25, line - /** @type {number} */ (others)));
}

/**
 * Where the drawn scatter ends. `dists[i]` = instance i's distance to the viewer (metres), and
 * `tris[i]` its triangles (every part it draws). Infinity = nothing to thin.
 * @param {ArrayLike<number>} dists @param {ArrayLike<number>} tris @param {number} budget
 * @param {number} [near] @returns {{cutoff: number, fadeStart: number, drawnTris: number, total: number}}
 */
export function thinPlan(dists, tris, budget, near = NEAR_KEEP) {
	const n = dists.length;
	let total = 0;
	for (let i = 0; i < n; i++) total += tris[i];
	if (!(total > budget)) return { cutoff: Infinity, fadeStart: Infinity, drawnTris: total, total };
	const order = new Uint32Array(n);
	for (let i = 0; i < n; i++) order[i] = i;
	order.sort((a, b) => dists[a] - dists[b]);
	let sum = 0;
	let cutoff = near;
	for (let k = 0; k < n; k++) {
		const i = order[k];
		const d = dists[i];
		if (d > near && sum + tris[i] > budget) {
			// the cutoff sits half way to the first instance that does not fit, so it is drawn
			// by nobody and the last one that fits is inside
			const prev = k ? dists[order[k - 1]] : 0;
			cutoff = Math.max(near, (prev + d) / 2);
			break;
		}
		sum += tris[i];
		cutoff = d + 1e-6;
		if (k === n - 1) cutoff = Infinity;
	}
	// a fade shrinks what it draws, so the band costs no more than the plan already counted
	const fadeStart = cutoff === Infinity ? Infinity : Math.max(near, cutoff * (1 - FADE_BAND));
	return { cutoff, fadeStart, drawnTris: sum, total };
}

/** An instance's scale at distance d under a plan: 1 inside the fade, 0 past the cutoff, a
 * smoothstep in between. @param {number} d @param {{cutoff: number, fadeStart: number}} plan */
export function fadeAt(d, plan) {
	if (d <= plan.fadeStart) return 1;
	if (d >= plan.cutoff) return 0;
	const t = (plan.cutoff - d) / (plan.cutoff - plan.fadeStart);
	return t * t * (3 - 2 * t);
}

/**
 * Which device profile a viewer is: a headset in an immersive session, a touch-first screen (the
 * N6, folded or unfolded), else a desktop. `choice` is the LOCAL setting ('auto' reads the device;
 * 'off' draws everything).
 * @param {string} choice @param {{xr: boolean, coarse: boolean}} device
 * @returns {ThinProfile | null} null = no thinning
 */
export function thinProfileOf(choice, device) {
	if (choice === 'off') return null;
	if (choice === 'quest' || choice === 'phone' || choice === 'desktop') return choice;
	return device.xr ? 'quest' : device.coarse ? 'phone' : 'desktop';
}
