// 64 D1: the PATH MATH of the vector shapes. A LEAF (imports nothing) so the unit layer can
// prove it with no three and no DOM.
//
// A shape's outline is a list of SUBPATHS, each `{closed, nodes}`. A node is
// `{x, y, ix, iy, ox, oy, smooth}`: the anchor in the shape's own XY plane (metres), and its
// IN / OUT bezier handles as OFFSETS from the anchor (0, 0 = no handle, a sharp corner on that
// side). `smooth` marks a point whose handles stay collinear when one is dragged (the pen's
// click-drag point); a corner's handles move independently. The segment from node a to node b
// is the cubic (a, a + a.out, b + b.in, b) — a straight line when both handles are zero.
//
// Parametric kinds (rect / ellipse / star / polygon) BUILD their subpaths here from a handful
// of numbers, so the record that travels stays tiny and the corner radius stays live; a pen
// path (and every boolean / outline result) carries its nodes verbatim.

/** κ — the cubic handle length (× radius) that draws a quarter circle */
export const KAPPA = 0.5522847498307936;

/** @typedef {{x: number, y: number, ix: number, iy: number, ox: number, oy: number, smooth?: boolean}} VNode */
/** @typedef {{closed: boolean, nodes: VNode[]}} VSubpath */

/** @param {number} x @param {number} y @param {number} [ix] @param {number} [iy] @param {number} [ox] @param {number} [oy] @param {boolean} [smooth] @returns {VNode} */
export function node(x, y, ix = 0, iy = 0, ox = 0, oy = 0, smooth = false) {
	return { x, y, ix, iy, ox, oy, smooth };
}

/** @param {VNode} n @returns {VNode} */
export function cloneNode(n) {
	return { x: n.x, y: n.y, ix: n.ix, iy: n.iy, ox: n.ox, oy: n.oy, smooth: !!n.smooth };
}

/** @param {VSubpath[]} subs @returns {VSubpath[]} */
export function cloneSubpaths(subs) {
	return subs.map((s) => ({ closed: !!s.closed, nodes: s.nodes.map(cloneNode) }));
}

/** does a node carry any handle? @param {VNode} n */
export const hasHandles = (n) => n.ix !== 0 || n.iy !== 0 || n.ox !== 0 || n.oy !== 0;

/* ------------------------------------------------------------- primitives ---- */

/**
 * A polygon whose corners are rounded by `radius`: at each vertex the two edges are cut back
 * by the tangent distance and a cubic quarter-ish arc joins the cuts. The cut is clamped to
 * half of the shorter neighbouring edge, so a radius larger than the shape allows gives the
 * roundest shape that fits instead of a self-crossing one.
 * @param {number[][]} pts CCW vertices @param {number} radius @returns {VNode[]}
 */
export function roundedPolygon(pts, radius) {
	const n = pts.length;
	if (!(radius > 0) || n < 3) return pts.map((p) => node(p[0], p[1]));
	/** @type {VNode[]} */
	const out = [];
	for (let i = 0; i < n; i++) {
		const p = pts[i];
		const a = pts[(i + n - 1) % n];
		const b = pts[(i + 1) % n];
		const ax = a[0] - p[0];
		const ay = a[1] - p[1];
		const bx = b[0] - p[0];
		const by = b[1] - p[1];
		const la = Math.hypot(ax, ay);
		const lb = Math.hypot(bx, by);
		if (la < 1e-9 || lb < 1e-9) {
			out.push(node(p[0], p[1]));
			continue;
		}
		const ux = ax / la;
		const uy = ay / la;
		const vx = bx / lb;
		const vy = by / lb;
		const cos = Math.max(-1, Math.min(1, ux * vx + uy * vy));
		const theta = Math.acos(cos); // interior angle between the two edges
		if (theta < 1e-4 || Math.PI - theta < 1e-4) {
			out.push(node(p[0], p[1]));
			continue;
		}
		const half = Math.tan(theta / 2);
		let cut = radius / half;
		cut = Math.min(cut, la / 2, lb / 2);
		const r = cut * half;
		const sweep = Math.PI - theta;
		const k = (4 / 3) * Math.tan(sweep / 4) * r;
		// the arc runs from the cut on the incoming edge to the cut on the outgoing one
		const s1 = node(p[0] + ux * cut, p[1] + uy * cut);
		s1.ox = -ux * k;
		s1.oy = -uy * k;
		s1.smooth = true;
		const s2 = node(p[0] + vx * cut, p[1] + vy * cut);
		s2.ix = -vx * k;
		s2.iy = -vy * k;
		s2.smooth = true;
		out.push(s1, s2);
	}
	return out;
}

/** @param {number} w @param {number} h @param {number} corner @returns {VSubpath[]} */
export function rectPath(w, h, corner = 0) {
	const x = w / 2;
	const y = h / 2;
	const pts = [
		[-x, -y],
		[x, -y],
		[x, y],
		[-x, y]
	];
	return [{ closed: true, nodes: roundedPolygon(pts, Math.min(Math.max(corner, 0), Math.min(w, h) / 2)) }];
}

/** four cubic quarters — no transcendental, so every engine builds the same ellipse
 * @param {number} w @param {number} h @returns {VSubpath[]} */
export function ellipsePath(w, h) {
	const rx = w / 2;
	const ry = h / 2;
	const kx = rx * KAPPA;
	const ky = ry * KAPPA;
	return [
		{
			closed: true,
			nodes: [
				node(rx, 0, 0, -ky, 0, ky, true),
				node(0, ry, kx, 0, -kx, 0, true),
				node(-rx, 0, 0, ky, 0, -ky, true),
				node(0, -ry, -kx, 0, kx, 0, true)
			]
		}
	];
}

/** the vertices of a regular polygon / star, the first one straight up
 * @param {number} count @param {number} outer @param {number} inner (= outer for a polygon) @param {boolean} star */
export function starVertices(count, outer, inner, star) {
	const n = Math.max(3, Math.round(count));
	const total = star ? n * 2 : n;
	/** @type {number[][]} */
	const pts = [];
	for (let i = 0; i < total; i++) {
		const a = Math.PI / 2 + (i * Math.PI * 2) / total;
		const r = star && i % 2 === 1 ? inner : outer;
		pts.push([Math.cos(a) * r, Math.sin(a) * r]);
	}
	return pts;
}

/** @param {number} points @param {number} radius @param {number} innerRatio @param {number} corner @returns {VSubpath[]} */
export function starPath(points, radius, innerRatio, corner = 0) {
	return [{ closed: true, nodes: roundedPolygon(starVertices(points, radius, radius * innerRatio, true), corner) }];
}

/** @param {number} sides @param {number} radius @param {number} corner @returns {VSubpath[]} */
export function polygonPath(sides, radius, corner = 0) {
	return [{ closed: true, nodes: roundedPolygon(starVertices(sides, radius, radius, false), corner) }];
}

/* -------------------------------------------------------------- segments ---- */

/** the four control points of the segment a -> b @param {VNode} a @param {VNode} b */
export function segmentControls(a, b) {
	return [a.x, a.y, a.x + a.ox, a.y + a.oy, b.x + b.ix, b.y + b.iy, b.x, b.y];
}

/** is the segment a straight line? @param {VNode} a @param {VNode} b */
export const isLine = (a, b) => a.ox === 0 && a.oy === 0 && b.ix === 0 && b.iy === 0;

/** point on a cubic @param {number[]} c 8 numbers @param {number} t @returns {number[]} */
export function cubicAt(c, t) {
	const u = 1 - t;
	const a = u * u * u;
	const b = 3 * u * u * t;
	const d = 3 * u * t * t;
	const e = t * t * t;
	return [a * c[0] + b * c[2] + d * c[4] + e * c[6], a * c[1] + b * c[3] + d * c[5] + e * c[7]];
}

/** the segment pairs of a subpath (a closed one wraps) @param {VSubpath} sub @returns {[number, number][]} */
export function segmentPairs(sub) {
	const n = sub.nodes.length;
	/** @type {[number, number][]} */
	const pairs = [];
	for (let i = 0; i + 1 < n; i++) pairs.push([i, i + 1]);
	if (sub.closed && n > 1) pairs.push([n - 1, 0]);
	return pairs;
}

/** the control polygon length — an upper bound on the arc length, cheap and deterministic @param {number[]} c */
function controlLength(c) {
	return Math.hypot(c[2] - c[0], c[3] - c[1]) + Math.hypot(c[4] - c[2], c[5] - c[3]) + Math.hypot(c[6] - c[4], c[7] - c[5]);
}

/**
 * Flatten a subpath to a polyline. A curve gets a step count from its control-polygon length
 * over `tolerance` (clamped 4..64), so a big circle stays round and a tiny one stays cheap.
 * The closing point of a closed subpath is NOT repeated.
 * @param {VSubpath} sub @param {number} [tolerance] metres per step @returns {number[][]}
 */
export function flattenSubpath(sub, tolerance = 0.02) {
	const nodes = sub.nodes;
	if (!nodes.length) return [];
	/** @type {number[][]} */
	const out = [[nodes[0].x, nodes[0].y]];
	for (const [i, j] of segmentPairs(sub)) {
		const a = nodes[i];
		const b = nodes[j];
		const last = j === 0;
		if (isLine(a, b)) {
			if (!last) out.push([b.x, b.y]);
			continue;
		}
		const c = segmentControls(a, b);
		const steps = Math.max(4, Math.min(64, Math.ceil(controlLength(c) / tolerance)));
		for (let s = 1; s <= steps; s++) {
			if (last && s === steps) break;
			out.push(cubicAt(c, s / steps));
		}
	}
	return dedupe(out, sub.closed);
}

/** drop consecutive duplicates (and a closing duplicate) @param {number[][]} pts @param {boolean} closed */
export function dedupe(pts, closed) {
	/** @type {number[][]} */
	const out = [];
	for (const p of pts) {
		const q = out[out.length - 1];
		if (q && Math.abs(q[0] - p[0]) < 1e-9 && Math.abs(q[1] - p[1]) < 1e-9) continue;
		out.push(p);
	}
	if (closed && out.length > 1) {
		const a = out[0];
		const b = out[out.length - 1];
		if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) out.pop();
	}
	return out;
}

/** signed area (CCW positive) @param {number[][]} ring */
export function ringArea(ring) {
	let a = 0;
	for (let i = 0, n = ring.length; i < n; i++) {
		const p = ring[i];
		const q = ring[(i + 1) % n];
		a += p[0] * q[1] - q[0] * p[1];
	}
	return a / 2;
}

/** even-odd point in polygon @param {number[]} pt @param {number[][]} ring */
export function pointInRing(pt, ring) {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const a = ring[i];
		const b = ring[j];
		if (a[1] > pt[1] !== b[1] > pt[1] && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
	}
	return inside;
}

/** a point strictly inside a ring (for containment tests that must not sit ON a shared edge):
 * the midpoint of the first edge, nudged a hair to the ring's inner side @param {number[][]} ring */
function interiorProbe(ring) {
	const a = ring[0];
	const b = ring[1] ?? ring[0];
	const mx = (a[0] + b[0]) / 2;
	const my = (a[1] + b[1]) / 2;
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len = Math.hypot(dx, dy) || 1;
	const side = ringArea(ring) >= 0 ? 1 : -1; // CCW: the inside is on the left
	const e = 1e-6;
	return [mx - (dy / len) * e * side, my + (dx / len) * e * side];
}

/**
 * Group rings into polygons with holes by EVEN-ODD nesting depth: a ring inside an even number
 * of others is an outer boundary, one inside an odd number is a hole of its smallest container.
 * Outers come back CCW, holes CW (the polygon-clipping / earcut convention).
 * @param {number[][][]} rings @returns {number[][][][]} MultiPolygon [[outer, ...holes], ...]
 */
export function ringsToPolygons(rings) {
	const list = rings.filter((r) => r.length >= 3 && Math.abs(ringArea(r)) > 1e-12);
	const areas = list.map((r) => Math.abs(ringArea(r)));
	const probes = list.map(interiorProbe);
	const depth = list.map((_, i) => list.reduce((d, other, j) => (j !== i && areas[j] > areas[i] && pointInRing(probes[i], other) ? d + 1 : d), 0));
	/** @type {number[][][][]} */
	const polys = [];
	/** @type {Map<number, number>} */
	const polyOf = new Map();
	const order = list.map((_, i) => i).sort((a, b) => areas[b] - areas[a]);
	for (const i of order) {
		const ring = list[i];
		if (depth[i] % 2 === 0) {
			polyOf.set(i, polys.length);
			polys.push([ringArea(ring) >= 0 ? ring : [...ring].reverse()]);
			continue;
		}
		// the smallest even-depth container
		let best = -1;
		for (const j of order) {
			if (j === i || depth[j] !== depth[i] - 1 || areas[j] <= areas[i]) continue;
			if (!pointInRing(probes[i], list[j])) continue;
			if (best < 0 || areas[j] < areas[best]) best = j;
		}
		const at = best >= 0 ? polyOf.get(best) : undefined;
		if (at === undefined) {
			polys.push([ringArea(ring) >= 0 ? ring : [...ring].reverse()]);
			continue;
		}
		polys[at].push(ringArea(ring) <= 0 ? ring : [...ring].reverse());
	}
	return polys;
}

/** bounds of a set of polylines @param {number[][][]} lines @returns {{minX: number, minY: number, maxX: number, maxY: number}} */
export function boundsOf(lines) {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const line of lines)
		for (const p of line) {
			if (p[0] < minX) minX = p[0];
			if (p[1] < minY) minY = p[1];
			if (p[0] > maxX) maxX = p[0];
			if (p[1] > maxY) maxY = p[1];
		}
	if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	return { minX, minY, maxX, maxY };
}

/* ------------------------------------------------------------ pen editing ---- */

/**
 * Split segment (i -> i+1) of a subpath at t with de Casteljau: the curve keeps its exact
 * shape and gains a SMOOTH node at the split. Returns a new subpath (the input is not touched).
 * @param {VSubpath} sub @param {number} seg index of the segment's first node @param {number} t
 */
export function insertNodeAt(sub, seg, t) {
	const pairs = segmentPairs(sub);
	const pair = pairs[seg];
	if (!pair) return cloneSubpaths([sub])[0];
	const [i, j] = pair;
	const nodes = sub.nodes.map(cloneNode);
	const a = nodes[i];
	const b = nodes[j];
	const c = segmentControls(a, b);
	if (isLine(a, b)) {
		const m = node(c[0] + (c[6] - c[0]) * t, c[1] + (c[7] - c[1]) * t);
		nodes.splice(i + 1, 0, m);
		return { closed: sub.closed, nodes };
	}
	const lerp = (/** @type {number} */ p, /** @type {number} */ q) => p + (q - p) * t;
	const p01 = [lerp(c[0], c[2]), lerp(c[1], c[3])];
	const p12 = [lerp(c[2], c[4]), lerp(c[3], c[5])];
	const p23 = [lerp(c[4], c[6]), lerp(c[5], c[7])];
	const p012 = [lerp(p01[0], p12[0]), lerp(p01[1], p12[1])];
	const p123 = [lerp(p12[0], p23[0]), lerp(p12[1], p23[1])];
	const m = [lerp(p012[0], p123[0]), lerp(p012[1], p123[1])];
	a.ox = p01[0] - a.x;
	a.oy = p01[1] - a.y;
	b.ix = p23[0] - b.x;
	b.iy = p23[1] - b.y;
	const mid = node(m[0], m[1], p012[0] - m[0], p012[1] - m[1], p123[0] - m[0], p123[1] - m[1], true);
	nodes.splice(i + 1, 0, mid);
	return { closed: sub.closed, nodes };
}

/** the nearest point on a subpath (sampled, then refined) @param {VSubpath} sub @param {number[]} pt
 * @returns {{seg: number, t: number, x: number, y: number, dist: number} | null} */
export function nearestOnSubpath(sub, pt) {
	let best = null;
	const pairs = segmentPairs(sub);
	for (let s = 0; s < pairs.length; s++) {
		const [i, j] = pairs[s];
		const c = segmentControls(sub.nodes[i], sub.nodes[j]);
		const N = 48;
		let bt = 0;
		let bd = Infinity;
		for (let k = 0; k <= N; k++) {
			const p = cubicAt(c, k / N);
			const d = Math.hypot(p[0] - pt[0], p[1] - pt[1]);
			if (d < bd) {
				bd = d;
				bt = k / N;
			}
		}
		// refine by bisection around the best sample
		let lo = Math.max(0, bt - 1 / N);
		let hi = Math.min(1, bt + 1 / N);
		for (let r = 0; r < 20; r++) {
			const t1 = lo + (hi - lo) / 3;
			const t2 = hi - (hi - lo) / 3;
			const p1 = cubicAt(c, t1);
			const p2 = cubicAt(c, t2);
			if (Math.hypot(p1[0] - pt[0], p1[1] - pt[1]) < Math.hypot(p2[0] - pt[0], p2[1] - pt[1])) hi = t2;
			else lo = t1;
		}
		const t = (lo + hi) / 2;
		const p = cubicAt(c, t);
		const d = Math.hypot(p[0] - pt[0], p[1] - pt[1]);
		if (!best || d < best.dist) best = { seg: s, t, x: p[0], y: p[1], dist: d };
	}
	return best;
}

/**
 * Convert a node: to SMOOTH it gets collinear handles along its neighbours' chord (a third of
 * each neighbour distance, the Catmull-Rom feel); to CORNER both handles go.
 * @param {VSubpath} sub @param {number} index @param {boolean} smooth
 */
export function convertNode(sub, index, smooth) {
	const nodes = sub.nodes.map(cloneNode);
	const n = nodes[index];
	if (!n) return { closed: sub.closed, nodes };
	if (!smooth) {
		n.ix = n.iy = n.ox = n.oy = 0;
		n.smooth = false;
		return { closed: sub.closed, nodes };
	}
	const count = nodes.length;
	const prev = index > 0 ? nodes[index - 1] : sub.closed ? nodes[count - 1] : null;
	const next = index < count - 1 ? nodes[index + 1] : sub.closed ? nodes[0] : null;
	const px = prev ? prev.x : n.x;
	const py = prev ? prev.y : n.y;
	const nx = next ? next.x : n.x;
	const ny = next ? next.y : n.y;
	let dx = nx - px;
	let dy = ny - py;
	const len = Math.hypot(dx, dy);
	if (len < 1e-9) return { closed: sub.closed, nodes };
	dx /= len;
	dy /= len;
	const li = prev ? Math.hypot(n.x - px, n.y - py) / 3 : 0;
	const lo = next ? Math.hypot(nx - n.x, ny - n.y) / 3 : 0;
	n.ix = -dx * li;
	n.iy = -dy * li;
	n.ox = dx * lo;
	n.oy = dy * lo;
	n.smooth = true;
	return { closed: sub.closed, nodes };
}

/**
 * Move one handle of a node to an ABSOLUTE position. A smooth node keeps the opposite handle
 * collinear (its own length); `mirror` also copies the length (the pen's drag-out); `free`
 * breaks a smooth node into a corner (Alt).
 * @param {VSubpath} sub @param {number} index @param {'in' | 'out'} which @param {number[]} at
 * @param {{mirror?: boolean, free?: boolean}} [opts]
 */
export function moveHandle(sub, index, which, at, opts = {}) {
	const nodes = sub.nodes.map(cloneNode);
	const n = nodes[index];
	if (!n) return { closed: sub.closed, nodes };
	const dx = at[0] - n.x;
	const dy = at[1] - n.y;
	if (which === 'in') {
		n.ix = dx;
		n.iy = dy;
	} else {
		n.ox = dx;
		n.oy = dy;
	}
	if (opts.free) n.smooth = false;
	else if (n.smooth || opts.mirror) {
		const len = Math.hypot(dx, dy);
		const otherLen = opts.mirror ? len : which === 'in' ? Math.hypot(n.ox, n.oy) : Math.hypot(n.ix, n.iy);
		const ux = len > 1e-12 ? -dx / len : 0;
		const uy = len > 1e-12 ? -dy / len : 0;
		if (which === 'in') {
			n.ox = ux * otherLen;
			n.oy = uy * otherLen;
		} else {
			n.ix = ux * otherLen;
			n.iy = uy * otherLen;
		}
		if (opts.mirror) n.smooth = true;
	}
	return { closed: sub.closed, nodes };
}

/** move an anchor (its handles ride along) @param {VSubpath} sub @param {number} index @param {number[]} at */
export function moveNode(sub, index, at) {
	const nodes = sub.nodes.map(cloneNode);
	if (nodes[index]) {
		nodes[index].x = at[0];
		nodes[index].y = at[1];
	}
	return { closed: sub.closed, nodes };
}

/** delete a node (a subpath keeps at least two) @param {VSubpath} sub @param {number} index */
export function deleteNode(sub, index) {
	if (sub.nodes.length <= 2) return cloneSubpaths([sub])[0];
	const nodes = sub.nodes.map(cloneNode);
	nodes.splice(index, 1);
	return { closed: sub.closed && nodes.length >= 3, nodes };
}

/**
 * Re-centre subpaths on their bounds centre: returns the shifted copy and the offset that was
 * taken out (the object moves by it, so nothing moves in the world).
 * @param {VSubpath[]} subs @returns {{subpaths: VSubpath[], cx: number, cy: number}}
 */
export function centreSubpaths(subs) {
	const lines = subs.map((s) => s.nodes.map((n) => [n.x, n.y]));
	const b = boundsOf(lines);
	const cx = (b.minX + b.maxX) / 2;
	const cy = (b.minY + b.maxY) / 2;
	return {
		subpaths: subs.map((s) => ({ closed: s.closed, nodes: s.nodes.map((n) => ({ ...cloneNode(n), x: n.x - cx, y: n.y - cy })) })),
		cx,
		cy
	};
}

/** polygons -> corner-only closed subpaths, collinear points dropped (boolean / outline results)
 * @param {number[][][][]} polys MultiPolygon @param {number} [eps] @returns {VSubpath[]} */
export function polygonsToSubpaths(polys, eps = 1e-7) {
	/** @type {VSubpath[]} */
	const out = [];
	for (const poly of polys)
		for (const ring of poly) {
			const pts = simplifyRing(dedupe(ring.map((p) => [p[0], p[1]]), true), eps);
			if (pts.length >= 3) out.push({ closed: true, nodes: pts.map((p) => node(p[0], p[1])) });
		}
	return out;
}

/** drop points that lie on the line through their neighbours @param {number[][]} ring @param {number} eps */
export function simplifyRing(ring, eps) {
	let pts = ring;
	let changed = true;
	while (changed && pts.length > 3) {
		changed = false;
		/** @type {number[][]} */
		const keep = [];
		for (let i = 0; i < pts.length; i++) {
			const a = pts[(i + pts.length - 1) % pts.length];
			const p = pts[i];
			const b = pts[(i + 1) % pts.length];
			const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
			const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
			if (Math.abs(cross) / len < eps && keep.length + (pts.length - i) > 3) {
				changed = true;
				continue;
			}
			keep.push(p);
		}
		pts = keep;
	}
	return pts;
}
