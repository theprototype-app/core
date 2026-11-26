// 64-vector-edit (D5 row 2): SNAPPING a point in a shape's own plane — the arithmetic. A LEAF
// (imports nothing), so the order of the rules is unit-tested with no scene.
//
// Everything here is 2D in the plane's own frame (metres). The caller (vectorSnap.js) gathers the
// candidates off the scene and turns the screen tolerances into plane metres. The order, first
// rule that answers wins:
//   1. a POINT (another shape's anchor or centre, this shape's other anchors) inside `tol`
//   2. an EDGE (a segment of an outline) inside `tol`: the nearest spot on it
//   3. SMART GUIDES, per axis: a candidate whose x (or y) is inside `guideTol` lends the point its x
//      (or y), and the guide line is drawn from that candidate
//   4. the GRID on every axis no guide took (the caller's function: the scene's grid, in world)
// Nothing answering leaves the point where it was. Ties keep the FIRST candidate (input order), so
// two peers looking at the same scene snap to the same spot.

/** @typedef {{axis: 0 | 1, value: number, from: number[]}} Guide */
/** @typedef {{at: number[], kind: null | 'point' | 'edge' | 'guide' | 'grid', target?: number[], guides: Guide[]}} SnapResult */

/**
 * @param {number[]} at the raw point [x, y]
 * @param {{points?: number[][], guidePoints?: number[][], segments?: number[][][], tol?: number, guideTol?: number,
 *   guides?: boolean, grid?: null | ((at: number[]) => number[] | null)}} c
 * @returns {SnapResult}
 */
export function snap2d(at, c) {
	const tol = c.tol ?? 0;
	const points = c.points ?? [];
	if (tol > 0 && points.length) {
		let best = null;
		let bd = tol;
		for (const p of points) {
			const d = Math.hypot(p[0] - at[0], p[1] - at[1]);
			if (d < bd) {
				bd = d;
				best = p;
			}
		}
		if (best) return { at: [best[0], best[1]], kind: 'point', target: best, guides: [] };
	}
	const segments = c.segments ?? [];
	if (tol > 0 && segments.length) {
		let best = null;
		let bd = tol;
		for (const s of segments) {
			const q = nearestOnSegment(s[0], s[1], at);
			const d = Math.hypot(q[0] - at[0], q[1] - at[1]);
			if (d < bd) {
				bd = d;
				best = q;
			}
		}
		if (best) return { at: best, kind: 'edge', target: best, guides: [] };
	}
	const out = [at[0], at[1]];
	/** @type {Guide[]} */
	const guides = [];
	const gtol = c.guideTol ?? 0;
	const gpoints = c.guidePoints ?? points;
	if (c.guides && gtol > 0 && gpoints.length)
		for (const axis of /** @type {const} */ ([0, 1])) {
			let best = null;
			let bd = gtol;
			for (const p of gpoints) {
				const d = Math.abs(p[axis] - at[axis]);
				// equal offsets: the nearer candidate along the OTHER axis draws the shorter guide
				if (d < bd - 1e-12 || (best && Math.abs(d - bd) <= 1e-12 && Math.abs(p[1 - axis] - at[1 - axis]) < Math.abs(best[1 - axis] - at[1 - axis]))) {
					bd = d;
					best = p;
				}
			}
			if (best) {
				out[axis] = best[axis];
				guides.push({ axis, value: best[axis], from: [best[0], best[1]] });
			}
		}
	const g = c.grid ? c.grid(at) : null;
	let gridded = false;
	if (g)
		for (const axis of [0, 1])
			if (!guides.some((q) => q.axis === axis) && Number.isFinite(g[axis])) {
				out[axis] = g[axis];
				gridded = true;
			}
	const kind = guides.length ? 'guide' : gridded ? 'grid' : null;
	return { at: out, kind, guides };
}

/** the nearest point on segment a-b to p @param {number[]} a @param {number[]} b @param {number[]} p */
export function nearestOnSegment(a, b, p) {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len2 = dx * dx + dy * dy;
	if (len2 < 1e-18) return [a[0], a[1]];
	const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
	return [a[0] + dx * t, a[1] + dy * t];
}

/** round a value to a grid step (a step <= 0 leaves it) @param {number} v @param {number} step */
export function roundTo(v, step) {
	return step > 0 ? Math.round(v / step) * step : v;
}
