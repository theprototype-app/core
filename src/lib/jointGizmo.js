// 102b row 2: the joint gizmo's GEOMETRY, pure (imports nothing): one joint def plus its two world
// anchors and a's world rotation in, line segments (pairs of points) and per-vertex colours out.
// jointHelpers.js draws them. What each kind shows:
//   every kind  a small cross at each anchor
//   weld        the line between the two anchors (they coincide unless the caller placed one)
//   hinge       the axis through the anchor; with limits, the arc it may turn through
//   ball        three small rings round the anchor (it turns every way)
//   slider      the axis; with limits, the travel between two end ticks, in the limit colour
//   spring      a zigzag from one anchor to the other
//   rope        the rope itself, slack or taut by colour, and a tick where it goes taut

/** @typedef {[number, number, number]} V3 */

export const GIZMO_COLORS = {
	anchor: [0.95, 0.95, 0.95],
	axis: [0.25, 0.8, 0.95],
	limit: [0.96, 0.62, 0.04],
	spring: [0.13, 0.77, 0.37],
	ropeSlack: [0.6, 0.65, 0.75],
	ropeTaut: [0.98, 0.45, 0.09]
};

/** @param {number[]} q [x,y,z,w] @param {number[]} v @returns {V3} v rotated by q */
export function rotate(q, v) {
	const [qx, qy, qz, qw] = q;
	const [vx, vy, vz] = v;
	// t = 2 * cross(q.xyz, v); v' = v + w t + cross(q.xyz, t)
	const tx = 2 * (qy * vz - qz * vy);
	const ty = 2 * (qz * vx - qx * vz);
	const tz = 2 * (qx * vy - qy * vx);
	return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

const add = (/** @type {number[]} */ p, /** @type {number[]} */ d, s = 1) => /** @type {V3} */ ([p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s]);
const sub = (/** @type {number[]} */ p, /** @type {number[]} */ r) => /** @type {V3} */ ([p[0] - r[0], p[1] - r[1], p[2] - r[2]]);
const len = (/** @type {number[]} */ v) => Math.hypot(v[0], v[1], v[2]);
const norm = (/** @type {number[]} */ v) => {
	const l = len(v) || 1;
	return /** @type {V3} */ ([v[0] / l, v[1] / l, v[2] / l]);
};
const cross = (/** @type {number[]} */ u, /** @type {number[]} */ v) =>
	/** @type {V3} */ ([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
/** a unit vector at right angles to v @param {number[]} v */
export const perpendicular = (v) => norm(Math.abs(v[1]) < 0.9 ? cross(v, [0, 1, 0]) : cross(v, [1, 0, 0]));

/**
 * @param {any} def joint def @param {number[]} anchorA world @param {number[]} anchorB world
 * @param {number[]} quatA a's world rotation [x,y,z,w] @param {number[]} pos out: xyz per vertex
 * @param {number[]} col out: rgb per vertex
 */
export function jointGizmoSegments(def, anchorA, anchorB, quatA, pos, col) {
	/** @param {number[]} p @param {number[]} r @param {number[]} c */
	const seg = (p, r, c) => {
		pos.push(p[0], p[1], p[2], r[0], r[1], r[2]);
		col.push(c[0], c[1], c[2], c[0], c[1], c[2]);
	};
	/** @param {number[]} at */
	const marker = (at, s = 0.05) => {
		seg(add(at, [1, 0, 0], -s), add(at, [1, 0, 0], s), GIZMO_COLORS.anchor);
		seg(add(at, [0, 1, 0], -s), add(at, [0, 1, 0], s), GIZMO_COLORS.anchor);
		seg(add(at, [0, 0, 1], -s), add(at, [0, 0, 1], s), GIZMO_COLORS.anchor);
	};
	/** an arc round `axis` at `at` from angle `from` to `to`
	 * @param {number[]} at @param {number[]} axis @param {number} from @param {number} to
	 * @param {number} radius @param {number[]} c */
	const arc = (at, axis, from, to, radius, c, steps = 16) => {
		const u = perpendicular(axis);
		const w = cross(axis, u);
		let prev = null;
		for (let i = 0; i <= steps; i++) {
			const t = from + ((to - from) * i) / steps;
			const p = add(add(at, u, Math.cos(t) * radius), w, Math.sin(t) * radius);
			if (prev) seg(prev, p, c);
			prev = p;
		}
	};
	const kind = def?.kind === 'weld' ? 'fixed' : def?.kind;
	marker(anchorA);
	if (len(sub(anchorB, anchorA)) > 1e-4) marker(anchorB);
	const axis = norm(rotate(quatA, def?.axisA ?? [0, 1, 0]));
	const limits = Array.isArray(def?.limits) && def.limits.length === 2 ? def.limits : null;
	if (kind === 'fixed') {
		seg(anchorA, anchorB, GIZMO_COLORS.anchor);
	} else if (kind === 'revolute') {
		seg(add(anchorB, axis, -0.4), add(anchorB, axis, 0.4), GIZMO_COLORS.axis);
		if (limits) {
			arc(anchorB, axis, limits[0], limits[1], 0.25, GIZMO_COLORS.limit);
			const u = perpendicular(axis);
			const w = cross(axis, u);
			for (const t of limits) seg(anchorB, add(add(anchorB, u, Math.cos(t) * 0.25), w, Math.sin(t) * 0.25), GIZMO_COLORS.limit);
		}
	} else if (kind === 'spherical') {
		for (const ring of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) arc(anchorB, ring, 0, Math.PI * 2, 0.12, GIZMO_COLORS.axis, 12);
	} else if (kind === 'prismatic') {
		// the travel is measured from a's anchor, along a's axis (rapier's prismatic frame)
		const [lo, hi] = limits ?? [-0.6, 0.6];
		seg(add(anchorA, axis, lo), add(anchorA, axis, hi), limits ? GIZMO_COLORS.limit : GIZMO_COLORS.axis);
		if (limits) {
			const u = perpendicular(axis);
			for (const t of limits) {
				const end = add(anchorA, axis, t);
				seg(add(end, u, -0.08), add(end, u, 0.08), GIZMO_COLORS.limit);
			}
		}
	} else if (kind === 'spring') {
		const d = sub(anchorB, anchorA);
		const l = len(d);
		const dir = norm(d);
		const u = perpendicular(dir);
		const zigs = 10;
		let prev = anchorA;
		for (let i = 1; i <= zigs; i++) {
			const along = add(anchorA, dir, (l * i) / (zigs + 1));
			const p = add(along, u, i % 2 ? 0.05 : -0.05);
			seg(prev, p, GIZMO_COLORS.spring);
			prev = p;
		}
		seg(prev, anchorB, GIZMO_COLORS.spring);
	} else if (kind === 'rope') {
		const d = sub(anchorB, anchorA);
		const l = len(d);
		const max = Number.isFinite(def?.length) ? def.length : l;
		const taut = l >= max * 0.98;
		seg(anchorA, anchorB, taut ? GIZMO_COLORS.ropeTaut : GIZMO_COLORS.ropeSlack);
		if (!taut && l > 1e-4) {
			// where b's anchor would pull the rope tight, on the line it hangs along now
			const end = add(anchorA, norm(d), max);
			const u = perpendicular(norm(d));
			seg(add(end, u, -0.06), add(end, u, 0.06), GIZMO_COLORS.limit);
		}
	}
}
