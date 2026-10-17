// 47 M1: the Measure tool's arithmetic. A LEAF — imports nothing — so the chain maths, the
// label text and the label anchors are unit-tested without a scene, and the overlay, the
// screen-space labels and the toolbox all read the same numbers.
//
// A measurement is a CHAIN: points in world metres, one segment between each neighbour pair.
// Its labels are a length at every segment's midpoint, the turn at every interior point (the
// angle BETWEEN the two segments there, so two edges of a box corner read 90°) and, once there
// is more than one segment, a running total at the last point.

/** @param {number[]} a @param {number[]} b */
function dist(a, b) {
	return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/**
 * The angle at `at` between the segments to `prev` and `next`, in degrees (0-180), or null
 * when either segment has no length (a double click on one spot has no direction).
 * @param {number[]} prev @param {number[]} at @param {number[]} next
 */
export function jointAngle(prev, at, next) {
	const u = [prev[0] - at[0], prev[1] - at[1], prev[2] - at[2]];
	const v = [next[0] - at[0], next[1] - at[1], next[2] - at[2]];
	const lu = Math.hypot(u[0], u[1], u[2]);
	const lv = Math.hypot(v[0], v[1], v[2]);
	if (lu < 1e-9 || lv < 1e-9) return null;
	const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv);
	return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/**
 * Segment lengths, the total and the interior angles of a chain.
 * @param {number[][]} points
 * @returns {{segments: number[], total: number, angles: (number|null)[]}}
 */
export function chainStats(points) {
	const segments = [];
	for (let i = 1; i < points.length; i++) segments.push(dist(points[i - 1], points[i]));
	const angles = [];
	for (let i = 1; i < points.length - 1; i++) angles.push(jointAngle(points[i - 1], points[i], points[i + 1]));
	return { segments, total: segments.reduce((sum, s) => sum + s, 0), angles };
}

/** metres, three decimals under 10 m (a millimetre is the precision a 1 m box is checked to)
 * @param {number} metres */
export function formatLength(metres) {
	if (!Number.isFinite(metres)) return '—';
	return `${metres.toFixed(Math.abs(metres) < 10 ? 3 : 2)} m`;
}

/** @param {number|null} degrees */
export function formatAngle(degrees) {
	return degrees == null || !Number.isFinite(degrees) ? '—' : `${degrees.toFixed(1)}°`;
}

/** the axis deltas of one segment, for the toolbox readout @param {number[]} a @param {number[]} b */
export function segmentDelta(a, b) {
	return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
}

/**
 * Every label of one chain, anchored in WORLD space (the overlay projects them each frame).
 * Keys are stable per chain + index, so the DOM layer keeps its nodes while the camera moves.
 * @param {number[][]} points @param {string} chainId
 * @returns {{key: string, kind: 'segment'|'angle'|'total', point: number[], text: string}[]}
 */
export function chainLabels(points, chainId) {
	const { segments, total, angles } = chainStats(points);
	/** @type {{key: string, kind: 'segment'|'angle'|'total', point: number[], text: string}[]} */
	const out = [];
	segments.forEach((length, i) => {
		const a = points[i];
		const b = points[i + 1];
		out.push({
			key: `${chainId}:s${i}`,
			kind: 'segment',
			point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
			text: formatLength(length)
		});
	});
	angles.forEach((angle, i) => {
		if (angle == null) return;
		out.push({ key: `${chainId}:a${i}`, kind: 'angle', point: points[i + 1], text: formatAngle(angle) });
	});
	if (segments.length > 1)
		out.push({ key: `${chainId}:t`, kind: 'total', point: points[points.length - 1], text: `Total ${formatLength(total)}` });
	return out;
}

// ---- 48 B2: a measurement as a SCENE ITEM ---------------------------------------------------
//
// A kept measurement is an object in objectsGroup carrying `userData.measure = {v, points}`:
// points in the OBJECT's local frame, so moving the item (the gizmo, a peer, undo) carries its
// dimension lines with it, exactly as a stroke or a spline does.

export const MEASURE_VERSION = 1;
/** a chain longer than this is not a measurement (and the record replicates whole) */
export const MEASURE_MAX_POINTS = 64;

/**
 * The ONE boundary for a measurement record (local writes, the wire, a load). Null when it
 * holds fewer than two usable points.
 * @param {any} raw @returns {{v: number, points: number[][]} | null}
 */
export function normalizeMeasure(raw) {
	if (!raw || typeof raw !== 'object' || !Array.isArray(raw.points)) return null;
	/** @type {number[][]} */
	const points = [];
	for (const p of raw.points.slice(0, MEASURE_MAX_POINTS)) {
		if (!Array.isArray(p) || p.length < 3) continue;
		const q = [Number(p[0]), Number(p[1]), Number(p[2])];
		if (q.every((n) => Number.isFinite(n) && Math.abs(n) < 1e6)) points.push(q);
	}
	return points.length >= 2 ? { v: MEASURE_VERSION, points } : null;
}

/**
 * Closest approach between a ray (origin + t·dir, t ≥ 0, dir unit) and the segment a–b.
 * @param {number[]} o @param {number[]} d @param {number[]} a @param {number[]} b
 * @returns {{dist: number, t: number, point: number[]}} `point` = the closest point ON THE SEGMENT
 */
export function raySegment(o, d, a, b) {
	const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
	const w = [a[0] - o[0], a[1] - o[1], a[2] - o[2]];
	const dot = (/** @type {number[]} */ x, /** @type {number[]} */ y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
	const uu = dot(u, u);
	const ud = dot(u, d);
	const uw = dot(u, w);
	const dw = dot(d, w);
	const den = uu - ud * ud; // |d| = 1
	// s = parameter on the segment, t = on the ray
	let s = den > 1e-12 ? (ud * dw - uw) / den : 0;
	s = uu > 1e-12 ? Math.max(0, Math.min(1, s)) : 0;
	const p = [a[0] + u[0] * s, a[1] + u[1] * s, a[2] + u[2] * s];
	const t = Math.max(0, (p[0] - o[0]) * d[0] + (p[1] - o[1]) * d[1] + (p[2] - o[2]) * d[2]);
	const q = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
	return { dist: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]), t, point: p };
}

/**
 * The index of the screen point nearest `px` within `radius` css px, or -1.
 * @param {(number[] | null)[]} screen projected points (null = behind the camera) @param {number[]} px @param {number} radius
 */
export function nearestScreenPoint(screen, px, radius) {
	let best = -1;
	let bestD = radius;
	screen.forEach((p, i) => {
		if (!p) return;
		const d = Math.hypot(p[0] - px[0], p[1] - px[1]);
		if (d <= bestD) (best = i), (bestD = d);
	});
	return best;
}

/** where each kind's label sits relative to its anchor before any collision (css px) */
const KIND_OFFSET = /** @type {Record<string, number[]>} */ ({ segment: [0, -15], angle: [0, 15], total: [14, 0] });
/** most informative first: the per-segment lengths win a crowded spot, then the total */
const KIND_ORDER = /** @type {Record<string, number>} */ ({ segment: 0, total: 1, angle: 2 });

/**
 * Lay screen-space labels out so no two overlap — the 47 pills sat on their anchors, and a
 * chain of short segments stacked them into one unreadable blot. Greedy, most informative
 * first: each label tries its natural spot, then steps away from it vertically (a line of
 * text is what collides) and then sideways; a label with no free spot within reach is
 * HIDDEN (the toolbox readout still carries every number) rather than drawn over another.
 * Positions are label CENTRES. Deterministic: ties keep the input order.
 * @template {{key: string, kind: string, text: string, x: number, y: number}} L
 * @param {L[]} labels anchors in css px
 * @param {{charW?: number, padX?: number, h?: number, gap?: number}} [opts]
 * @returns {(L & {x: number, y: number, w: number, hidden: boolean})[]}
 */
export function layoutLabels(labels, opts = {}) {
	const charW = opts.charW ?? 7.2;
	const padX = opts.padX ?? 16;
	const h = opts.h ?? 21;
	const gap = opts.gap ?? 2;
	const order = labels.map((l, i) => ({ l, i })).sort((a, b) => (KIND_ORDER[a.l.kind] ?? 9) - (KIND_ORDER[b.l.kind] ?? 9) || a.i - b.i);
	/** @type {{x0: number, y0: number, x1: number, y1: number}[]} */
	const placed = [];
	/** @type {any[]} */
	const out = new Array(labels.length);
	const step = h + gap;
	const tries = [
		[0, 0],
		[0, -step],
		[0, step],
		[0, -2 * step],
		[0, 2 * step],
		[0, -3 * step],
		[0, 3 * step]
	];
	for (const { l, i } of order) {
		const w = l.text.length * charW + padX;
		const off = KIND_OFFSET[l.kind] ?? [0, 0];
		const bx = l.x + off[0] + (l.kind === 'total' ? w / 2 : 0);
		const by = l.y + off[1];
		/** @type {number[] | null} */
		let spot = null;
		const side = w + gap;
		for (const [dx, dy] of [...tries, ...tries.map(([, dy]) => [side, dy]), ...tries.map(([, dy]) => [-side, dy])]) {
			const box = { x0: bx + dx - w / 2, y0: by + dy - h / 2, x1: bx + dx + w / 2, y1: by + dy + h / 2 };
			if (placed.every((p) => box.x1 + gap <= p.x0 || box.x0 >= p.x1 + gap || box.y1 + gap <= p.y0 || box.y0 >= p.y1 + gap)) {
				spot = [bx + dx, by + dy];
				placed.push(box);
				break;
			}
		}
		out[i] = { ...l, x: spot ? spot[0] : bx, y: spot ? spot[1] : by, w, hidden: !spot };
	}
	return out;
}
