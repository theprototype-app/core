// 64 D1/D3: STROKES as geometry. A LEAF (imports nothing).
//
// A stroke is built as a set of small CONVEX PIECES — one quad per segment, one join piece per
// interior vertex (miter / round / bevel), one cap per open end (butt / round / square) — so
// the same pieces serve twice: drawn directly as triangles (overlaps are invisible on an opaque
// stroke and cost no boolean), and UNIONED by vectorBoolean into a clean outline for
// stroke-to-outline and inset / outset (D3). Dashes split the polyline by arc length first, and
// every dash is stroked with the shape's own caps (SVG semantics).

const ROUND_STEPS = 12;

/** @typedef {{width: number, join?: 'miter'|'round'|'bevel', cap?: 'butt'|'round'|'square', miterLimit?: number, dash?: number, gap?: number, dashOffset?: number}} StrokeStyle */

/** a circle polygon (CCW) @param {number[]} c @param {number} r @param {number} [steps] */
function circle(c, r, steps = ROUND_STEPS * 2) {
	/** @type {number[][]} */
	const out = [];
	for (let i = 0; i < steps; i++) {
		const a = (i / steps) * Math.PI * 2;
		out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
	}
	return out;
}

/** make a convex polygon CCW @param {number[][]} poly */
function ccw(poly) {
	let a = 0;
	for (let i = 0; i < poly.length; i++) {
		const p = poly[i];
		const q = poly[(i + 1) % poly.length];
		a += p[0] * q[1] - q[0] * p[1];
	}
	return a < 0 ? [...poly].reverse() : poly;
}

/**
 * Split a polyline into dashes by arc length. `closed` walks the closing segment too.
 * @param {number[][]} pts @param {boolean} closed @param {number} dash @param {number} gap @param {number} [offset]
 * @returns {number[][][]} open polylines
 */
export function dashPolyline(pts, closed, dash, gap, offset = 0) {
	if (!(dash > 0) || !(gap > 0) || pts.length < 2) return [closed ? [...pts, pts[0]] : pts];
	const line = closed ? [...pts, pts[0]] : pts;
	const period = dash + gap;
	/** @type {number[][][]} */
	const out = [];
	/** @type {number[][] | null} */
	let current = null;
	// phase along the pattern at the start of the line
	let phase = (((offset % period) + period) % period);
	let on = phase < dash;
	let left = on ? dash - phase : period - phase;
	if (on) current = [line[0]];
	for (let i = 0; i + 1 < line.length; i++) {
		const a = line[i];
		const b = line[i + 1];
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		let at = 0;
		while (len - at > left) {
			at += left;
			const t = at / len;
			const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
			if (on) {
				current?.push(p);
				if (current && current.length >= 2) out.push(current);
				current = null;
				on = false;
				left = gap;
			} else {
				current = [p];
				on = true;
				left = dash;
			}
		}
		left -= len - at;
		if (on) current?.push(b);
	}
	if (on && current && current.length >= 2) out.push(current);
	return out;
}

/**
 * The convex pieces of one stroked polyline.
 * @param {number[][]} pts @param {boolean} closed @param {StrokeStyle} style @returns {number[][][]}
 */
export function strokePieces(pts, closed, style) {
	const hw = (style.width ?? 0) / 2;
	if (!(hw > 0)) return [];
	const join = style.join ?? 'miter';
	const cap = style.cap ?? 'butt';
	const limit = style.miterLimit ?? 4;
	// drop zero-length segments
	/** @type {number[][]} */
	const line = [];
	for (const p of pts) {
		const q = line[line.length - 1];
		if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) line.push(p);
	}
	if (closed && line.length > 2) {
		const a = line[0];
		const b = line[line.length - 1];
		if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) line.pop();
	}
	/** @type {number[][][]} */
	const pieces = [];
	if (line.length < 2) {
		// a dot: round / square caps draw it, butt draws nothing (SVG)
		if (line.length === 1 && cap === 'round') pieces.push(circle(line[0], hw));
		if (line.length === 1 && cap === 'square') {
			const [x, y] = line[0];
			pieces.push([
				[x - hw, y - hw],
				[x + hw, y - hw],
				[x + hw, y + hw],
				[x - hw, y + hw]
			]);
		}
		return pieces;
	}
	const n = line.length;
	const segCount = closed ? n : n - 1;
	/** unit direction + left normal per segment @type {{dx: number, dy: number, nx: number, ny: number}[]} */
	const dirs = [];
	for (let s = 0; s < segCount; s++) {
		const a = line[s];
		const b = line[(s + 1) % n];
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		const dx = (b[0] - a[0]) / len;
		const dy = (b[1] - a[1]) / len;
		dirs.push({ dx, dy, nx: -dy, ny: dx });
	}
	for (let s = 0; s < segCount; s++) {
		const a = line[s];
		const b = line[(s + 1) % n];
		const { nx, ny } = dirs[s];
		pieces.push(
			ccw([
				[a[0] + nx * hw, a[1] + ny * hw],
				[b[0] + nx * hw, b[1] + ny * hw],
				[b[0] - nx * hw, b[1] - ny * hw],
				[a[0] - nx * hw, a[1] - ny * hw]
			])
		);
	}
	// joins at every vertex where two segments meet
	const joinAt = (/** @type {number} */ v, /** @type {number} */ s0, /** @type {number} */ s1) => {
		const p = line[v];
		const d0 = dirs[s0];
		const d1 = dirs[s1];
		const cross = d0.dx * d1.dy - d0.dy * d1.dx;
		const dot = d0.dx * d1.dx + d0.dy * d1.dy;
		if (Math.abs(cross) < 1e-9 && dot > 0) return; // straight on
		// the OUTER side of the turn: a left turn (cross > 0) opens on the right
		const side = cross > 0 ? -1 : 1;
		const e0 = [p[0] + d0.nx * hw * side, p[1] + d0.ny * hw * side];
		const e1 = [p[0] + d1.nx * hw * side, p[1] + d1.ny * hw * side];
		if (join === 'round') {
			pieces.push(circle(p, hw));
			return;
		}
		if (join === 'miter') {
			// the miter tip: where the two offset edges meet
			const cosHalf = Math.sqrt(Math.max(0, (1 + dot) / 2));
			const ratio = cosHalf > 1e-9 ? 1 / cosHalf : Infinity; // miter length / half width
			if (ratio <= limit) {
				const mx = d0.nx + d1.nx;
				const my = d0.ny + d1.ny;
				const ml = Math.hypot(mx, my);
				if (ml > 1e-9) {
					const len = hw * ratio;
					const tip = [p[0] + (mx / ml) * len * side, p[1] + (my / ml) * len * side];
					pieces.push(ccw([p, e0, tip, e1]));
					return;
				}
			}
		}
		pieces.push(ccw([p, e0, e1]));
	};
	for (let v = 1; v < n - 1; v++) joinAt(v, v - 1, v);
	if (closed) {
		joinAt(0, segCount - 1, 0);
		if (n > 2) joinAt(n - 1, n - 2, n - 1);
	} else {
		// caps
		const ends = [
			{ p: line[0], d: dirs[0], sign: -1 },
			{ p: line[n - 1], d: dirs[segCount - 1], sign: 1 }
		];
		for (const { p, d, sign } of ends) {
			if (cap === 'round') pieces.push(circle(p, hw));
			else if (cap === 'square') {
				const ex = d.dx * hw * sign;
				const ey = d.dy * hw * sign;
				pieces.push(
					ccw([
						[p[0] + d.nx * hw, p[1] + d.ny * hw],
						[p[0] + d.nx * hw + ex, p[1] + d.ny * hw + ey],
						[p[0] - d.nx * hw + ex, p[1] - d.ny * hw + ey],
						[p[0] - d.nx * hw, p[1] - d.ny * hw]
					])
				);
			}
		}
	}
	return pieces;
}

/**
 * Every convex piece of a whole stroke (dashes applied). @param {{pts: number[][], closed: boolean}[]} lines
 * @param {StrokeStyle} style @returns {number[][][]}
 */
export function strokeAll(lines, style) {
	/** @type {number[][][]} */
	const out = [];
	for (const { pts, closed } of lines) {
		if (style.dash && style.dash > 0 && style.gap && style.gap > 0) {
			for (const dash of dashPolyline(pts, closed, style.dash, style.gap, style.dashOffset ?? 0)) out.push(...strokePieces(dash, false, style));
		} else out.push(...strokePieces(pts, closed, style));
	}
	return out;
}

/** fan-triangulate convex pieces into a flat [x,y, x,y, x,y, ...] list @param {number[][][]} pieces */
export function piecesToTriangles(pieces) {
	/** @type {number[]} */
	const out = [];
	for (const poly of pieces)
		for (let i = 1; i + 1 < poly.length; i++) out.push(poly[0][0], poly[0][1], poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1]);
	return out;
}
