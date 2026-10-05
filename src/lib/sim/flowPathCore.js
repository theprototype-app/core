// 36-fb F24: CONTINUOUS FLOWS — a flow path STREAMS what is in it toward its end. A LEAF that
// imports nothing (the worker, the runtime and vitest use it).
//
// A path is a polyline in its object's LOCAL frame (`userData.flowPath.points`), with a width
// and a depth (an elliptical tube around the line). Two kinds:
//   river — particles inside the tube are steered along the tangent at `speed` (with
//           `strength` = how hard, 1/s) and pulled back toward the middle, so a stream follows
//           a curving chute instead of spilling at the first bend; with `recycle` on, a
//           particle that reaches the END reappears at the START (a closed loop — a fountain
//           that never runs dry, a river that circles — costs nothing extra: the same
//           particles go round and never age out);
//   pipe  — an INTAKE at the first point swallows particles and they come out of the last
//           point at `speed` along its last segment (a hidden pump: how a water mill's lift
//           closes the loop). Nothing is simulated in between.
// Floating OBJECTS are carried along a path by the `flowfloat` node (deterministic, see
// flowRuntime); dynamic bodies in water feel W1's flow as before.

export const FLOW_PATH_VERSION = 1;
export const MAX_FLOW_POINTS = 32;
/** the most paths one emitter's solver steers with */
export const MAX_FLOWS = 8;

/** @typedef {{version: number, kind: 'river'|'pipe', points: number[][], width: number, depth: number, speed: number,
 *   strength: number, recycle: boolean, show: boolean, color: string, opacity: number}} FlowPathSpec */

export const FLOW_PATH_DEFAULTS = Object.freeze({
	version: FLOW_PATH_VERSION,
	kind: /** @type {'river'} */ ('river'),
	points: Object.freeze([Object.freeze([0, 0, 0]), Object.freeze([1.5, -0.25, 0]), Object.freeze([3, -0.5, 0])]),
	width: 0.5,
	depth: 0.3,
	speed: 1.2, // m/s along the path
	strength: 4, // 1/s: how fast a particle takes the path's velocity
	recycle: false,
	show: true, // draw the animated water surface (the Quest fallback's body of water)
	color: '#3f8fd0',
	opacity: 0.6
});

/** @param {any} v @param {number} d @param {number} lo @param {number} hi */
const clampNum = (v, d, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/**
 * THE boundary for `userData.flowPath`. A path needs two distinct points; fewer = the default.
 * @param {any} raw @returns {FlowPathSpec}
 */
export function normalizeFlowPath(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const d = FLOW_PATH_DEFAULTS;
	/** @type {number[][]} */
	let points = Array.isArray(r.points)
		? r.points
				.slice(0, MAX_FLOW_POINTS)
				.filter((/** @type {any} */ p) => Array.isArray(p) && p.length === 3 && p.every((/** @type {any} */ v) => typeof v === 'number' && Number.isFinite(v)))
				.map((/** @type {number[]} */ p) => p.map((v) => Math.min(500, Math.max(-500, v))))
		: [];
	// drop zero-length segments (a duplicate point has no tangent)
	points = points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1], p[2] - points[i - 1][2]) > 1e-4);
	if (points.length < 2) points = d.points.map((p) => p.slice());
	return {
		version: FLOW_PATH_VERSION,
		kind: r.kind === 'pipe' ? 'pipe' : 'river',
		points,
		width: clampNum(r.width, d.width, 0.05, 10),
		depth: clampNum(r.depth, d.depth, 0.02, 5),
		speed: clampNum(r.speed, d.speed, 0, 20),
		strength: clampNum(r.strength, d.strength, 0, 40),
		recycle: r.recycle === true,
		show: r.show !== false,
		color: typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : d.color,
		opacity: clampNum(r.opacity, d.opacity, 0.05, 1)
	};
}

/**
 * Arc-length bookkeeping for a polyline: cumulative length at each point + the total.
 * @param {number[][]} pts @returns {{cum: number[], total: number}}
 */
export function arcLengths(pts) {
	const cum = [0];
	for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
	return { cum, total: cum[cum.length - 1] };
}

/**
 * The point + unit tangent at arc length `s` (clamped to the path).
 * @param {number[][]} pts @param {number[]} cum @param {number} s @returns {{p: number[], t: number[]}}
 */
export function pointAt(pts, cum, s) {
	const total = cum[cum.length - 1];
	s = Math.min(total, Math.max(0, s));
	let i = 1;
	while (i < pts.length - 1 && cum[i] < s) i++;
	const a = pts[i - 1], b = pts[i];
	const len = cum[i] - cum[i - 1] || 1;
	const u = (s - cum[i - 1]) / len;
	const t = [(b[0] - a[0]) / len, (b[1] - a[1]) / len, (b[2] - a[2]) / len];
	return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u], t };
}

/**
 * A path made ready for a solver (area-local, flat arrays, its box) — built on the main thread
 * each frame by the runtime and sent to the worker.
 * @param {FlowPathSpec} spec @param {number[][]} ptsLocal the points already in the solver's frame
 */
export function compileFlow(spec, ptsLocal) {
	const { cum, total } = arcLengths(ptsLocal);
	const pad = Math.max(spec.width / 2, spec.depth) + 0.05;
	const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	for (const p of ptsLocal)
		for (let a = 0; a < 3; a++) {
			lo[a] = Math.min(lo[a], p[a] - pad);
			hi[a] = Math.max(hi[a], p[a] + pad);
		}
	return { kind: spec.kind, pts: ptsLocal.flat(), cum, total, width: spec.width, depth: spec.depth, speed: spec.speed, strength: spec.strength, recycle: spec.recycle, lo, hi };
}

/** @typedef {ReturnType<typeof compileFlow>} CompiledFlow */

/**
 * The closest point of a compiled flow to (x, y, z): segment index, arc length, the offset.
 * @param {CompiledFlow} f @param {number} x @param {number} y @param {number} z @param {number[]} out [s, seg, ox, oy, oz]
 */
function closest(f, x, y, z, out) {
	const P = f.pts;
	let best = Infinity;
	for (let i = 0; i + 1 < f.cum.length; i++) {
		const ax = P[i * 3], ay = P[i * 3 + 1], az = P[i * 3 + 2];
		const bx = P[i * 3 + 3], by = P[i * 3 + 4], bz = P[i * 3 + 5];
		const dx = bx - ax, dy = by - ay, dz = bz - az;
		const l2 = dx * dx + dy * dy + dz * dz || 1;
		let u = ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / l2;
		u = u < 0 ? 0 : u > 1 ? 1 : u;
		const cx = ax + dx * u, cy = ay + dy * u, cz = az + dz * u;
		const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy) + (z - cz) * (z - cz);
		if (d2 < best) {
			best = d2;
			out[0] = f.cum[i] + u * Math.sqrt(l2);
			out[1] = i;
			out[2] = x - cx;
			out[3] = y - cy;
			out[4] = z - cz;
		}
	}
}

/**
 * One frame of every flow over a solver's particles (after its step): rivers steer, recycle at
 * their end; pipes swallow at the intake and pour from the outlet. Recycled particles are
 * reborn (age 0), so a closed loop never runs dry against the lifetime cap.
 * @param {{count: number, x: Float32Array, v: Float32Array, age: Float32Array, radius: number, flowing?: Uint8Array}} solver
 * @param {CompiledFlow[] | null | undefined} flows @param {number} dt
 * @returns {{steered: number, recycled: number, piped: number}}
 */
export function applyFlows(solver, flows, dt) {
	const stats = { steered: 0, recycled: 0, piped: 0 };
	if (!flows?.length) return stats;
	const { x, v, age } = solver;
	// who is in a tube is decided afresh every frame (friction skips them on the next step)
	if (solver.flowing) solver.flowing.fill(0, 0, solver.count);
	const c = [0, 0, 0, 0, 0];
	let seed = (solver.count * 2654435761) >>> 0 || 1;
	const jitter = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
	for (const f of flows) {
		const k = 1 - Math.exp(-f.strength * dt);
		const P = f.pts;
		const nPts = f.cum.length;
		const hw = f.width / 2;
		// the end's tangent and the start's (for rebirth)
		const t0 = unit(P[3] - P[0], P[4] - P[1], P[5] - P[2]);
		const e = (nPts - 1) * 3;
		const tE = unit(P[e] - P[e - 3], P[e + 1] - P[e - 2], P[e + 2] - P[e - 1]);
		for (let i = 0; i < solver.count; i++) {
			const ix = i * 3;
			const px = x[ix], py = x[ix + 1], pz = x[ix + 2];
			if (px < f.lo[0] || px > f.hi[0] || py < f.lo[1] || py > f.hi[1] || pz < f.lo[2] || pz > f.hi[2]) continue;
			if (f.kind === 'pipe') {
				const dx = px - P[0], dy = py - P[1], dz = pz - P[2];
				if (dx * dx + dy * dy + dz * dz > hw * hw) continue;
				reborn(solver, i, P[e], P[e + 1], P[e + 2], tE, f.speed, hw * 0.5, jitter);
				stats.piped++;
				continue;
			}
			closest(f, px, py, pz, c);
			const seg = c[1];
			const tx = (P[seg * 3 + 3] - P[seg * 3]), ty = (P[seg * 3 + 4] - P[seg * 3 + 1]), tz = (P[seg * 3 + 5] - P[seg * 3 + 2]);
			const tl = Math.hypot(tx, ty, tz) || 1;
			const ux = tx / tl, uy = ty / tl, uz = tz / tl;
			// offset split: vertical, and horizontal-perpendicular to the path
			const ox = c[2], oy = c[3], oz = c[4];
			const along = ox * ux + oy * uy + oz * uz;
			let lx = ox - ux * along, lz = oz - uz * along;
			const lat = Math.hypot(lx, lz);
			if ((lat / hw) ** 2 + (oy / f.depth) ** 2 > 1) continue;
			stats.steered++;
			if (solver.flowing) solver.flowing[i] = 1;
			// the end of a recycling river: back to the start
			if (f.recycle && c[0] >= f.total - Math.max(hw, 0.05)) {
				reborn(solver, i, P[0], P[1], P[2], t0, f.speed, hw * 0.5, jitter);
				stats.recycled++;
				continue;
			}
			const vt = v[ix] * ux + v[ix + 1] * uy + v[ix + 2] * uz;
			const dv = (f.speed - vt) * k;
			v[ix] += ux * dv;
			v[ix + 1] += uy * dv;
			v[ix + 2] += uz * dv;
			// back toward the middle (horizontally) and lateral sloshing damped
			if (lat > 1e-6) {
				lx /= lat;
				lz /= lat;
				const vl = v[ix] * lx + v[ix + 2] * lz;
				const pull = -(lat / hw) * f.speed * 0.6 * k - vl * k * 0.5;
				v[ix] += lx * pull;
				v[ix + 2] += lz * pull;
			}
			age[i] = Math.min(age[i], 0.5); // a particle IN a flow stays young: loops never age out
		}
	}
	return stats;
}

/** @param {number} x @param {number} y @param {number} z */
function unit(x, y, z) {
	const l = Math.hypot(x, y, z) || 1;
	return [x / l, y / l, z / l];
}

/**
 * Re-place particle i at a point, moving along `t` at `speed`, jittered across the stream.
 * @param {{x: Float32Array, v: Float32Array, age: Float32Array}} s @param {number} i
 * @param {number} px @param {number} py @param {number} pz @param {number[]} t @param {number} speed @param {number} r @param {() => number} jitter
 */
function reborn(s, i, px, py, pz, t, speed, r, jitter) {
	const k = i * 3;
	s.x[k] = px + jitter() * r * (1 - Math.abs(t[0]));
	s.x[k + 1] = py + jitter() * r * 0.4;
	s.x[k + 2] = pz + jitter() * r * (1 - Math.abs(t[2]));
	s.v[k] = t[0] * speed;
	s.v[k + 1] = t[1] * speed;
	s.v[k + 2] = t[2] * speed;
	s.age[i] = 0;
}

/**
 * Where a floating object rides at time `time` (s): it started at arc length `s0` and moves at
 * `speed`, wrapping at the end (a loop) — a pure function of (path, s0, time), so every peer
 * computes the same pose from the shared clock (the `flowfloat` node's whole netcode).
 * @param {number[][]} pts @param {number} s0 @param {number} speed @param {number} time @param {boolean} wrap
 */
export function floatAt(pts, s0, speed, time, wrap = true) {
	const { cum, total } = arcLengths(pts);
	let s = s0 + speed * time;
	if (wrap && total > 0) s = ((s % total) + total) % total;
	return { ...pointAt(pts, cum, s), s, total };
}

/**
 * The arc length of the point on a path closest to (x, y, z) (where a floater "starts").
 * @param {number[][]} pts @param {number[]} q
 */
export function arcLengthOf(pts, q) {
	const f = compileFlow(normalizeFlowPath({ points: pts }), pts);
	const out = [0, 0, 0, 0, 0];
	closest(f, q[0], q[1], q[2], out);
	return out[0];
}
