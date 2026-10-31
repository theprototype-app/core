// 51 E4/E5 — EDITING SCATTER INSTANCES, the pure half (imports NOTHING; tests/unit).
//
// Every function here takes an instance LIST ({x, z, yaw, scale} in the terrain's local
// frame — terrainScatterCore's Instance) and returns a NEW list; nothing is mutated in
// place, so a stroke can keep its stroke-start copy and undo is "put the old list back".
// Which instances an op touches is a Set of list INDICES: the adapter (scatterEditAdapter.js)
// owns how an index maps to the set format's stable instance id.
//
// Brushes are rate-based like the sculpt and paint brushes (strength × falloff × dt), with
// the same smoothstep falloff, so a slow stroke and a fast one end up in the same place
// for the same time held. Relax is deterministic (no random): each instance inside the
// circle moves away from neighbours closer than the local mean spacing, which evens a
// clump out without ever pushing anything past the brush edge.

const TAU = Math.PI * 2;
export const EDIT_SCALE_MIN = 0.05;
export const EDIT_SCALE_MAX = 20;

/** @typedef {{x: number, z: number, yaw: number, scale: number}} Instance */
/** @typedef {{minX: number, minZ: number, sizeX: number, sizeZ: number}} Bounds */

/** @param {number} n */
const clampScale = (n) => Math.min(EDIT_SCALE_MAX, Math.max(EDIT_SCALE_MIN, n));
/** @param {number} a */
export const wrapYaw = (a) => ((a % TAU) + TAU) % TAU;

/** smoothstep falloff: 1 at the centre, 0 at the rim. @param {number} d distance @param {number} r radius */
export function falloff(d, r) {
	if (!(r > 0) || d >= r) return 0;
	const t = 1 - d / r;
	return t * t * (3 - 2 * t);
}

/** @param {Instance} p @param {number} cx @param {number} cz */
const dist = (p, cx, cz) => Math.hypot(p.x - cx, p.z - cz);

// ---- selection ops ----------------------------------------------------------------------

/** Indices whose projected screen point lies in the rect (both corners inclusive, any order).
 * @param {{sx: number, sy: number, visible: boolean}[]} projected one per instance, same order
 * @param {{x0: number, y0: number, x1: number, y1: number}} rect
 * @returns {Set<number>} */
export function indicesInRect(projected, rect) {
	const x0 = Math.min(rect.x0, rect.x1);
	const x1 = Math.max(rect.x0, rect.x1);
	const y0 = Math.min(rect.y0, rect.y1);
	const y1 = Math.max(rect.y0, rect.y1);
	const out = new Set();
	projected.forEach((p, i) => {
		if (p.visible && p.sx >= x0 && p.sx <= x1 && p.sy >= y0 && p.sy <= y1) out.add(i);
	});
	return out;
}

/** Turn each selected instance about its own up axis. @param {Instance[]} list
 * @param {Set<number>} ids @param {number} delta radians */
export function rotateEach(list, ids, delta) {
	return list.map((p, i) => (ids.has(i) ? { ...p, yaw: wrapYaw(p.yaw + delta) } : p));
}

/** Multiply each selected instance's scale. @param {Instance[]} list @param {Set<number>} ids @param {number} factor */
export function scaleEach(list, ids, factor) {
	return list.map((p, i) => (ids.has(i) ? { ...p, scale: clampScale(p.scale * factor) } : p));
}

/** Set each selected instance's pose fields (the gizmo's absolute write).
 * @param {Instance[]} list @param {Map<number, Partial<Instance>>} poses */
export function setPoses(list, poses) {
	return list.map((p, i) => {
		const q = poses.get(i);
		if (!q) return p;
		return {
			...p, // 51-union: an instance's id / source pick / tint ride along
			x: Number.isFinite(q.x) ? /** @type {number} */ (q.x) : p.x,
			z: Number.isFinite(q.z) ? /** @type {number} */ (q.z) : p.z,
			yaw: Number.isFinite(q.yaw) ? wrapYaw(/** @type {number} */ (q.yaw)) : p.yaw,
			scale: Number.isFinite(q.scale) ? clampScale(/** @type {number} */ (q.scale)) : p.scale
		};
	});
}

/** Move the selection rigidly: a translation plus a turn of the whole group about `pivot`
 * (each instance's own yaw turns with it) and a uniform scale about the pivot — what a
 * gizmo on a multi-instance selection does.
 * @param {Instance[]} list @param {Set<number>} ids
 * @param {{dx: number, dz: number, dyaw: number, factor: number, pivot: {x: number, z: number}}} t */
export function transformGroup(list, ids, t) {
	const c = Math.cos(t.dyaw);
	const s = Math.sin(t.dyaw);
	return list.map((p, i) => {
		if (!ids.has(i)) return p;
		// three's rotation.y turns +x toward -z: x' = x cos + z sin, z' = -x sin + z cos
		const ox = (p.x - t.pivot.x) * t.factor;
		const oz = (p.z - t.pivot.z) * t.factor;
		return {
			...p,
			x: t.pivot.x + ox * c + oz * s + t.dx,
			z: t.pivot.z - ox * s + oz * c + t.dz,
			yaw: wrapYaw(p.yaw + t.dyaw),
			scale: clampScale(p.scale * t.factor)
		};
	});
}

/** Drop the selected instances. Returns the kept list and old-index → new-index for the
 * survivors (a selection held across the op is re-mapped through it).
 * @param {Instance[]} list @param {Set<number>} ids */
export function deleteSelected(list, ids) {
	/** @type {Instance[]} */
	const kept = [];
	/** @type {Map<number, number>} */
	const remap = new Map();
	list.forEach((p, i) => {
		if (ids.has(i)) return;
		remap.set(i, kept.length);
		kept.push(p);
	});
	return { list: kept, remap };
}

/** Re-roll the selected instances' look: a fresh yaw (when random rotation is on) and a
 * fresh scale in the range. Positions and every UNselected instance are untouched — the
 * user's "re-roll keeps the other hand edits".
 * @param {Instance[]} list @param {Set<number>} ids @param {() => number} rng
 * @param {{scaleMin: number, scaleMax: number, randomRotation: boolean}} o */
export function rerollSelected(list, ids, rng, o) {
	const lo = Math.min(o.scaleMin, o.scaleMax);
	const hi = Math.max(o.scaleMin, o.scaleMax);
	return list.map((p, i) => {
		if (!ids.has(i)) return p;
		const yaw = o.randomRotation ? rng() * TAU : p.yaw;
		return { ...p, yaw, scale: clampScale(lo + (hi - lo) * rng()) };
	});
}

/** The selection's centre (mean of positions) — the gizmo's seat. @param {Instance[]} list @param {Set<number>} ids */
export function centroid(list, ids) {
	let x = 0;
	let z = 0;
	let n = 0;
	for (const i of ids) {
		const p = list[i];
		if (!p) continue;
		x += p.x;
		z += p.z;
		n++;
	}
	return n ? { x: x / n, z: z / n } : null;
}

// ---- brushes ----------------------------------------------------------------------------

/** Rotate brush: turns instances under the brush, fastest at the centre (half a turn per
 * second at full strength). @param {Instance[]} list @param {number} cx @param {number} cz
 * @param {number} radius @param {number} strength 0..1 @param {number} dt seconds @param {boolean} [reverse]
 * @param {(i: number) => boolean} [only] which instances the brush may touch */
export function rotateBrush(list, cx, cz, radius, strength, dt, reverse = false, only) {
	const rate = Math.PI * Math.max(0, Math.min(1, strength)) * dt * (reverse ? -1 : 1);
	let changed = 0;
	const out = list.map((p, i) => {
		if (only && !only(i)) return p;
		const w = falloff(dist(p, cx, cz), radius);
		if (!w) return p;
		changed++;
		return { ...p, yaw: wrapYaw(p.yaw + rate * w) };
	});
	return { list: out, changed };
}

/** Scale brush: grows (or with `reverse` shrinks) instances under the brush — a factor of
 * e^(strength·dt) per second at the centre, so it is symmetric: grow then shrink for the
 * same time held lands back where it started. Same shape as rotateBrush. */
export function scaleBrush(
	/** @type {Instance[]} */ list,
	/** @type {number} */ cx,
	/** @type {number} */ cz,
	/** @type {number} */ radius,
	/** @type {number} */ strength,
	/** @type {number} */ dt,
	reverse = false,
	/** @type {((i: number) => boolean) | undefined} */ only = undefined
) {
	const k = Math.max(0, Math.min(1, strength)) * dt * (reverse ? -1 : 1);
	let changed = 0;
	const out = list.map((p, i) => {
		if (only && !only(i)) return p;
		const w = falloff(dist(p, cx, cz), radius);
		if (!w) return p;
		const scale = clampScale(p.scale * Math.exp(k * w));
		if (scale === p.scale) return p;
		changed++;
		return { ...p, scale };
	});
	return { list: out, changed };
}

/**
 * Relax brush: evens the spacing under the brush. The target gap is the mean nearest-
 * neighbour distance of the instances inside the circle; each instance there is pushed
 * away from every neighbour nearer than that gap, weighted by the falloff and capped so
 * nothing jumps more than a quarter gap per step or leaves the brush or the terrain.
 * Neighbours OUTSIDE the circle push but are never moved. Deterministic.
 * @param {Instance[]} list @param {number} cx @param {number} cz @param {number} radius
 * @param {number} strength 0..1 @param {number} dt @param {Bounds} bounds
 * @param {(i: number) => boolean} [only]
 */
export function relaxBrush(list, cx, cz, radius, strength, dt, bounds, only) {
	const inside = [];
	const near = [];
	for (let i = 0; i < list.length; i++) {
		if (only && !only(i)) continue;
		const d = dist(list[i], cx, cz);
		if (d < radius) inside.push(i);
		if (d < radius * 1.5) near.push(i);
	}
	if (inside.length < 2) return { list, changed: 0 };
	// the target gap: the mean nearest-neighbour distance among the instances inside
	let sum = 0;
	for (const i of inside) {
		let best = Infinity;
		for (const j of near) if (j !== i) best = Math.min(best, Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z));
		sum += Number.isFinite(best) ? best : 0;
	}
	// a floor so a clump stacked on one spot (mean gap 0) still has somewhere to spread to
	const gap = Math.max(radius * 0.05, (sum / inside.length) * 1.25);
	const rate = Math.max(0, Math.min(1, strength)) * dt * 4;
	const out = list.slice();
	let changed = 0;
	for (const i of inside) {
		const p = list[i];
		let fx = 0;
		let fz = 0;
		for (const j of near) {
			if (j === i) continue;
			const q = list[j];
			const dx = p.x - q.x;
			const dz = p.z - q.z;
			const d = Math.hypot(dx, dz);
			if (d >= gap) continue;
			if (d < 1e-6) {
				// coincident: a fixed direction per PAIR, opposite for its two members, so two
				// stacked rocks separate the same way on every peer
				const a = ((Math.min(i, j) * 2654435761 + Math.max(i, j)) % 360) * (Math.PI / 180);
				const sign = i < j ? 1 : -1;
				fx += Math.cos(a) * sign;
				fz += Math.sin(a) * sign;
				continue;
			}
			const push = (gap - d) / gap;
			fx += (dx / d) * push;
			fz += (dz / d) * push;
		}
		const w = falloff(dist(p, cx, cz), radius);
		let mx = fx * gap * rate * w;
		let mz = fz * gap * rate * w;
		const m = Math.hypot(mx, mz);
		const cap = gap * 0.25;
		if (m > cap) {
			mx *= cap / m;
			mz *= cap / m;
		}
		if (Math.hypot(mx, mz) < 1e-6) continue;
		let x = p.x + mx;
		let z = p.z + mz;
		// never out of the brush (a relax must not leak instances into an area you left
		// alone) and never off the terrain
		const r = Math.hypot(x - cx, z - cz);
		if (r > radius) {
			x = cx + ((x - cx) / r) * radius;
			z = cz + ((z - cz) / r) * radius;
		}
		x = Math.min(bounds.minX + bounds.sizeX, Math.max(bounds.minX, x));
		z = Math.min(bounds.minZ + bounds.sizeZ, Math.max(bounds.minZ, z));
		out[i] = { ...p, x, z };
		changed++;
	}
	return { list: out, changed };
}

/** Erase brush with a filter: drops instances inside the circle that `only` admits (all of
 * them when it is absent). @param {Instance[]} list @param {number} cx @param {number} cz
 * @param {number} radius @param {(i: number) => boolean} [only] */
export function eraseBrush(list, cx, cz, radius, only) {
	const out = list.filter((p, i) => dist(p, cx, cz) > radius || (only ? !only(i) : false));
	return { list: out, changed: list.length - out.length };
}

// ---- E5 helpers -------------------------------------------------------------------------

/** How many instances an "instances → objects" conversion may make without asking. */
export const CONVERT_CONFIRM_ABOVE = 500;

/** Yaw (rotation about +y) of a quaternion, the way three's rotation.y reads it for an
 * upright object — what a converted object's turn becomes as an instance.
 * @param {{x: number, y: number, z: number, w: number}} q */
export function yawOfQuaternion(q) {
	// the forward (+z) axis rotated by q, projected on the ground plane
	const fx = 2 * (q.x * q.z + q.w * q.y);
	const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
	return wrapYaw(Math.atan2(fx, fz));
}

/** Can a group of objects become one scatter set? They must share one source key
 * (`keyOf` answers '' for something that cannot be a source).
 * @param {any[]} objects @param {(o: any) => string} keyOf
 * @returns {{ok: true, key: string} | {ok: false, reason: string}} */
export function commonSource(objects, keyOf) {
	if (objects.length < 2) return { ok: false, reason: 'Select at least two copies of one object' };
	const keys = new Set(objects.map(keyOf));
	if (keys.has('')) return { ok: false, reason: 'Only primitives and Library models can become scatter' };
	if (keys.size > 1) return { ok: false, reason: 'The selection holds different objects — select copies of ONE object' };
	return { ok: true, key: /** @type {string} */ ([...keys][0]) };
}
