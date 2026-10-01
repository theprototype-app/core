// 31 K1 (D2/S1): WHERE A PLAYER MAY TELEPORT — a pure leaf (imports nothing), so every rule is
// unit-tested with no headset, no scene and no physics.
//
// The Quest reports: "Dungeon Realms ... I would like to be able to teleport but not outside
// the dungeon walls" and "In Stars room I would like to be able to teleport but not outside
// the scene". Edit's teleport lands anywhere an arc touches (a top face or the y = 0 plane);
// a GAME's teleport (Interact/Play, `play.locomotion.teleport: true`) is BOUNDED:
//   1 the landing is WALKABLE — a surface whose world normal points up (y >= 0.7), or the
//     scene's floor plane;
//   2 it lies INSIDE the play area — `play.bounds {min, max}` when a scene or a publisher
//     gives one, else the scene's content bounds shrunk by 0.3 m on x and z;
//   3 a dungeon RASTER (dungeonPlay's grid) says the target cell is floor AND no wall cell
//     lies on the straight line from the player to it;
//   4 nothing SOLID is crossed on the way — the straight segment 1.1 m above both ends must
//     miss every published collider box (and, at runtime, every mesh).
// The first rule that fails names the verdict; an invalid target draws the arc red and a
// release does nothing.

/** a landing surface's world normal.y must reach this (about 45 degrees) */
export const WALKABLE_NORMAL_Y = 0.7;
/** content bounds are shrunk by this on x and z when no play.bounds is given */
export const BOUNDS_INSET = 0.3;
/** the wall probe runs this high above both ends (a knee-high rim can be teleported over) */
export const PROBE_HEIGHT = 1.1;
/** raster samples along the segment, metres */
export const RASTER_STEP = 0.25;
/** the body radius a raster floor cell must hold at the target */
export const RASTER_RADIUS = 0.2;

const LIMIT = 100000;

/**
 * `{min:[x,y,z], max:[x,y,z]}` at a store/api boundary: six finite numbers within the spawn
 * limit, each axis ordered (a swapped pair is put right). Anything else is null.
 * @param {any} raw @returns {{min: [number, number, number], max: [number, number, number]} | null}
 */
export function normalizeBounds(raw) {
	const lo = raw?.min;
	const hi = raw?.max;
	if (!Array.isArray(lo) || !Array.isArray(hi) || lo.length < 3 || hi.length < 3) return null;
	const a = lo.slice(0, 3).map(Number);
	const b = hi.slice(0, 3).map(Number);
	if (![...a, ...b].every((v) => Number.isFinite(v) && Math.abs(v) <= LIMIT)) return null;
	return {
		min: /** @type {[number, number, number]} */ ([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])]),
		max: /** @type {[number, number, number]} */ ([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])])
	};
}

/**
 * The content box pulled in by `inset` on x and z (y is left alone: a floor sits AT the
 * box's bottom). A box narrower than twice the inset collapses onto its centre line.
 * @param {{min: number[], max: number[]}} box @param {number} [inset]
 * @returns {{min: [number, number, number], max: [number, number, number]}}
 */
export function shrinkBox(box, inset = BOUNDS_INSET) {
	/** @param {number} i */
	const axis = (i) => {
		const lo = box.min[i] + inset;
		const hi = box.max[i] - inset;
		if (lo <= hi) return [lo, hi];
		const mid = (box.min[i] + box.max[i]) / 2;
		return [mid, mid];
	};
	const [x0, x1] = axis(0);
	const [z0, z1] = axis(2);
	return { min: [x0, box.min[1], z0], max: [x1, box.max[1], z1] };
}

/**
 * @param {{x: number, y: number, z: number}} p @param {{min: number[], max: number[]}} box
 * @param {number} [eps]
 */
export function inBox(p, box, eps = 1e-6) {
	return (
		p.x >= box.min[0] - eps && p.x <= box.max[0] + eps &&
		p.y >= box.min[1] - eps && p.y <= box.max[1] + eps &&
		p.z >= box.min[2] - eps && p.z <= box.max[2] + eps
	);
}

/**
 * Does the segment a -> b cross the box? (the slab test over t in [0, 1])
 * @param {{x: number, y: number, z: number}} a @param {{x: number, y: number, z: number}} b
 * @param {{min: number[], max: number[]}} box
 */
export function segmentHitsBox(a, b, box) {
	let t0 = 0;
	let t1 = 1;
	const from = [a.x, a.y, a.z];
	const d = [b.x - a.x, b.y - a.y, b.z - a.z];
	for (let i = 0; i < 3; i++) {
		if (Math.abs(d[i]) < 1e-12) {
			if (from[i] < box.min[i] || from[i] > box.max[i]) return false;
			continue;
		}
		let near = (box.min[i] - from[i]) / d[i];
		let far = (box.max[i] - from[i]) / d[i];
		if (near > far) [near, far] = [far, near];
		t0 = Math.max(t0, near);
		t1 = Math.min(t1, far);
		if (t0 > t1) return false;
	}
	return true;
}

/**
 * Every RASTER_STEP along a -> b (x/z only) must be a floor cell for a point body (the
 * target itself is tested with a body radius by the caller). `walkable(raster, x, z, r)` is
 * dungeonPlay's rule, passed in so this leaf imports nothing.
 * @param {any} raster @param {{x: number, z: number}} a @param {{x: number, z: number}} b
 * @param {(raster: any, x: number, z: number, r?: number) => boolean} walkable
 */
export function rasterSegmentClear(raster, a, b, walkable) {
	const length = Math.hypot(b.x - a.x, b.z - a.z);
	const steps = Math.max(1, Math.ceil(length / RASTER_STEP));
	// start one step OUT from the player (you may be brushing a wall where you stand)
	for (let i = 1; i <= steps; i++) {
		const t = i / steps;
		if (!walkable(raster, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, 0)) return false;
	}
	return true;
}

/**
 * THE VERDICT. Every input but `to` is optional; an absent rule passes.
 * @param {{
 *   from?: {x: number, y: number, z: number} | null,
 *   to: {x: number, y: number, z: number},
 *   normalY?: number,
 *   bounds?: {min: number[], max: number[]} | null,
 *   colliders?: {min: number[], max: number[]}[] | null,
 *   raster?: any,
 *   walkable?: ((raster: any, x: number, z: number, r?: number) => boolean) | null,
 *   meshBlocked?: boolean
 * }} input
 * @returns {{ok: boolean, reason: 'ok' | 'steep' | 'outside' | 'off-floor' | 'wall-cell' | 'blocked'}}
 */
export function teleportVerdictPure(input) {
	const { from, to } = input;
	if (!to || ![to.x, to.y, to.z].every(Number.isFinite)) return { ok: false, reason: 'off-floor' };
	if ((input.normalY ?? 1) < WALKABLE_NORMAL_Y) return { ok: false, reason: 'steep' };
	if (input.bounds && !inBox(to, input.bounds)) return { ok: false, reason: 'outside' };
	if (input.raster && input.walkable) {
		if (!input.walkable(input.raster, to.x, to.z, RASTER_RADIUS)) return { ok: false, reason: 'off-floor' };
		if (from && !rasterSegmentClear(input.raster, from, to, input.walkable)) return { ok: false, reason: 'wall-cell' };
	}
	if (from && input.colliders?.length) {
		const a = { x: from.x, y: from.y + PROBE_HEIGHT, z: from.z };
		const b = { x: to.x, y: to.y + PROBE_HEIGHT, z: to.z };
		for (const box of input.colliders) {
			// a box the player is already standing in (a doorway's lintel, a room volume) is not
			// a wall between here and there
			if (inBox(a, box, -1e-6)) continue;
			if (segmentHitsBox(a, b, box)) return { ok: false, reason: 'blocked' };
		}
	}
	if (input.meshBlocked) return { ok: false, reason: 'blocked' };
	return { ok: true, reason: 'ok' };
}
