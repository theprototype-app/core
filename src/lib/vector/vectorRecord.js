// 64 D1: the VECTOR RECORD — what a vector shape IS. A LEAF (imports only the path leaf).
//
// A shape is an ordinary mesh whose `userData.geometryParams = {gtype: 'Vector', params}`, the
// 21-C1 Terrain / 37 R3 arch precedent: the `geometry` message, the `'geometry'` history kind
// and the toJSON / GLTF extras ride for free, a late joiner rebuilds from the stamp, and the
// Inspector's Geometry rows (the live corner radius among them) come from VECTOR_PARAMS with no
// new UI. Colours are part of the record and baked into VERTEX COLOURS by the builder — one
// mesh, one material, nothing that a GLTF save or the per-node exporter could split apart.
//
// `cleanVector` is the ONE boundary: every key is clamped or defaulted, unknown keys dropped,
// so userData never holds a value the builder would not use (the arch `clean` rule) and a
// hostile record off the wire cannot ask for a million nodes.
import { rectPath, ellipsePath, starPath, polygonPath, cloneSubpaths } from './vectorPath.js';

export const VECTOR_KINDS = ['rect', 'ellipse', 'star', 'polygon', 'path'];
export const FILL_TYPES = ['solid', 'linear', 'radial', 'none'];
export const JOINS = ['miter', 'round', 'bevel'];
export const CAPS = ['butt', 'round', 'square'];
/** the display name an object of each kind gets */
export const KIND_NAMES = { rect: 'Rectangle', ellipse: 'Ellipse', star: 'Star', polygon: 'Polygon', path: 'Path' };

/** caps that keep a record (and the geometry built from it) bounded */
export const MAX_SUBPATHS = 64;
export const MAX_NODES = 4000;
export const MAX_STOPS = 8;
const MAX_SIZE = 200;

/** @param {any} v @param {number} lo @param {number} hi @param {number} def */
const num = (v, lo, hi, def) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
/** @param {any} v @param {string[]} list @param {string} def */
const pick = (v, list, def) => (list.includes(v) ? v : def);
/** @param {any} v @param {string} def */
const colour = (v, def) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : def);

/** @returns {Record<string, any>} */
export function vectorDefaults(kind = 'rect') {
	return {
		kind: pick(kind, VECTOR_KINDS, 'rect'),
		width: 1,
		height: 1,
		radius: 0.5,
		points: kind === 'polygon' ? 6 : 5,
		innerRatio: 0.45,
		corner: 0,
		paths: [],
		fillType: kind === 'path' ? 'none' : 'solid',
		fill: '#4f8cff',
		fill2: '#ff5ca8',
		gradAngle: 0,
		gradX: 0.5,
		gradY: 0.5,
		gradR: 0.5,
		stops: [],
		stroke: '#1d2433',
		strokeWidth: kind === 'path' ? 0.03 : 0,
		join: 'miter',
		cap: 'butt',
		dash: 0,
		gap: 0,
		depth: 0,
		bevel: 0
	};
}

/** clean a node list from anywhere @param {any} raw */
function cleanPaths(raw) {
	if (!Array.isArray(raw)) return [];
	/** @type {import('./vectorPath.js').VSubpath[]} */
	const out = [];
	let budget = MAX_NODES;
	for (const sub of raw.slice(0, MAX_SUBPATHS)) {
		if (!sub || !Array.isArray(sub.nodes)) continue;
		const nodes = [];
		for (const n of sub.nodes) {
			if (budget <= 0) break;
			if (!n) continue;
			const c = (/** @type {any} */ v) => num(v, -MAX_SIZE, MAX_SIZE, 0);
			if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
			nodes.push({ x: c(n.x), y: c(n.y), ix: c(n.ix), iy: c(n.iy), ox: c(n.ox), oy: c(n.oy), smooth: !!n.smooth });
			budget--;
		}
		if (nodes.length >= 2) out.push({ closed: !!sub.closed, nodes });
	}
	return out;
}

/** gradient stops [[offset 0..1, '#rrggbb'], ...] sorted @param {any} raw */
function cleanStops(raw) {
	if (!Array.isArray(raw)) return [];
	return raw
		.slice(0, MAX_STOPS)
		.filter((s) => Array.isArray(s) && Number.isFinite(s[0]))
		.map((s) => [num(s[0], 0, 1, 0), colour(s[1], '#000000')])
		.sort((a, b) => /** @type {number} */ (a[0]) - /** @type {number} */ (b[0]));
}

/** @param {any} raw @returns {Record<string, any>} */
export function cleanVector(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const kind = pick(r.kind, VECTOR_KINDS, 'rect');
	const d = vectorDefaults(kind);
	const out = {
		kind,
		width: num(r.width, 0.01, MAX_SIZE, d.width),
		height: num(r.height, 0.01, MAX_SIZE, d.height),
		radius: num(r.radius, 0.01, MAX_SIZE, d.radius),
		points: Math.round(num(r.points, 3, 64, d.points)),
		innerRatio: num(r.innerRatio, 0.05, 1, d.innerRatio),
		corner: num(r.corner, 0, MAX_SIZE, d.corner),
		paths: kind === 'path' ? cleanPaths(r.paths) : [],
		fillType: pick(r.fillType, FILL_TYPES, d.fillType),
		fill: colour(r.fill, d.fill),
		fill2: colour(r.fill2, d.fill2),
		gradAngle: num(r.gradAngle, -360, 360, d.gradAngle),
		gradX: num(r.gradX, -2, 3, d.gradX),
		gradY: num(r.gradY, -2, 3, d.gradY),
		gradR: num(r.gradR, 0.01, 4, d.gradR),
		stops: cleanStops(r.stops),
		stroke: colour(r.stroke, d.stroke),
		strokeWidth: num(r.strokeWidth, 0, 20, d.strokeWidth),
		join: pick(r.join, JOINS, d.join),
		cap: pick(r.cap, CAPS, d.cap),
		dash: num(r.dash, 0, 50, d.dash),
		gap: num(r.gap, 0, 50, d.gap),
		depth: num(r.depth, 0, 50, d.depth),
		bevel: num(r.bevel, 0, 5, d.bevel)
	};
	return out;
}

/** the outline of a record as subpaths @param {Record<string, any>} p @returns {import('./vectorPath.js').VSubpath[]} */
export function vectorSubpaths(p) {
	switch (p.kind) {
		case 'rect':
			return rectPath(p.width, p.height, p.corner);
		case 'ellipse':
			return ellipsePath(p.width, p.height);
		case 'star':
			return starPath(p.points, p.radius, p.innerRatio, p.corner);
		case 'polygon':
			return polygonPath(p.points, p.radius, p.corner);
		default:
			return cloneSubpaths(p.paths ?? []);
	}
}

/* ------------------------------------------------------------- colour ---- */

/** '#rrggbb' -> [r, g, b] 0..1 (sRGB) @param {string} hex */
export function hexToRgb(hex) {
	const v = parseInt(hex.slice(1), 16);
	return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** the gradient's stop list (the two-colour shorthand when none are authored) @param {Record<string, any>} p */
export function gradientStops(p) {
	return p.stops?.length >= 2 ? p.stops : [[0, p.fill], [1, p.fill2]];
}

/** sRGB colour of a stop list at t (interpolated in sRGB, the SVG default) @param {any[]} stops @param {number} t */
export function stopColour(stops, t) {
	if (t <= stops[0][0]) return hexToRgb(stops[0][1]);
	const last = stops[stops.length - 1];
	if (t >= last[0]) return hexToRgb(last[1]);
	for (let i = 0; i + 1 < stops.length; i++) {
		const [a, ca] = stops[i];
		const [b, cb] = stops[i + 1];
		if (t >= a && t <= b) {
			const k = b - a > 1e-9 ? (t - a) / (b - a) : 0;
			const x = hexToRgb(ca);
			const y = hexToRgb(cb);
			return [x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k];
		}
	}
	return hexToRgb(last[1]);
}

/**
 * The fill colour at a point, in objectBoundingBox terms (SVG): (u, v) is the point's position
 * in the fill's bounds, 0..1 with v UP. Linear runs along `gradAngle` degrees (0 = left to
 * right, 90 = bottom to top) across the box; radial is centred at (gradX, gradY) with radius
 * gradR, both in box units (so it is an ellipse on a non-square box — what SVG draws).
 * @param {Record<string, any>} p @param {number} u @param {number} v @returns {number[]} sRGB
 */
export function fillColourAt(p, u, v) {
	if (p.fillType === 'linear') {
		const a = (p.gradAngle * Math.PI) / 180;
		const dx = Math.cos(a);
		const dy = Math.sin(a);
		const span = Math.abs(dx) + Math.abs(dy);
		const t = 0.5 + ((u - 0.5) * dx + (v - 0.5) * dy) / span;
		return stopColour(gradientStops(p), t);
	}
	if (p.fillType === 'radial') {
		const t = Math.hypot(u - p.gradX, v - p.gradY) / p.gradR;
		return stopColour(gradientStops(p), t);
	}
	return hexToRgb(p.fill);
}

/* ---------------------------------------------------------- Inspector ---- */

/** @param {string[]} kinds */
const forKinds = (kinds) => (/** @type {any} */ p) => kinds.includes(p?.kind);
const gradient = (/** @type {any} */ p) => p?.fillType === 'linear' || p?.fillType === 'radial';
const stroked = (/** @type {any} */ p) => (p?.strokeWidth ?? 0) > 0;

/** the Geometry-section rows (ParamSpec, geometryParams.js) — `show` keeps each kind's own
 * @type {import('../geometryParams.js').ParamSpec[]} */
export const VECTOR_PARAMS = [
	{ key: 'width', label: 'Width', kind: 'slider', min: 0.05, max: 20, step: 0.05, def: 1, show: forKinds(['rect', 'ellipse']) },
	{ key: 'height', label: 'Height', kind: 'slider', min: 0.05, max: 20, step: 0.05, def: 1, show: forKinds(['rect', 'ellipse']) },
	{ key: 'radius', label: 'Radius', kind: 'slider', min: 0.05, max: 10, step: 0.05, def: 0.5, show: forKinds(['star', 'polygon']) },
	{ key: 'points', label: 'Points', kind: 'int', min: 3, max: 32, def: 5, show: forKinds(['star']) },
	{ key: 'points', label: 'Sides', kind: 'int', min: 3, max: 32, def: 6, show: forKinds(['polygon']) },
	{ key: 'innerRatio', label: 'Inner', kind: 'slider', min: 0.05, max: 1, step: 0.01, def: 0.45, show: forKinds(['star']) },
	{ key: 'corner', label: 'Corner radius', kind: 'slider', min: 0, max: 5, step: 0.01, def: 0, show: forKinds(['rect', 'star', 'polygon']) },
	{ key: 'fillType', label: 'Fill', kind: 'choice', options: FILL_TYPES, def: 'solid' },
	{ key: 'gradAngle', label: 'Angle', kind: 'slider', min: -180, max: 180, step: 1, def: 0, show: (p) => p?.fillType === 'linear' },
	{ key: 'gradX', label: 'Centre X', kind: 'slider', min: 0, max: 1, step: 0.01, def: 0.5, show: (p) => p?.fillType === 'radial' },
	{ key: 'gradY', label: 'Centre Y', kind: 'slider', min: 0, max: 1, step: 0.01, def: 0.5, show: (p) => p?.fillType === 'radial' },
	{ key: 'gradR', label: 'Spread', kind: 'slider', min: 0.05, max: 2, step: 0.01, def: 0.5, show: (p) => p?.fillType === 'radial' },
	{ key: 'strokeWidth', label: 'Stroke', kind: 'slider', min: 0, max: 1, step: 0.005, def: 0 },
	{ key: 'join', label: 'Join', kind: 'choice', options: JOINS, def: 'miter', show: stroked },
	{ key: 'cap', label: 'Cap', kind: 'choice', options: CAPS, def: 'butt', show: stroked },
	{ key: 'dash', label: 'Dash', kind: 'slider', min: 0, max: 2, step: 0.01, def: 0, show: stroked },
	{ key: 'gap', label: 'Gap', kind: 'slider', min: 0, max: 2, step: 0.01, def: 0, show: (p) => stroked(p) && (p?.dash ?? 0) > 0 },
	{ key: 'depth', label: 'Extrude', kind: 'slider', min: 0, max: 5, step: 0.01, def: 0 },
	{ key: 'bevel', label: 'Bevel', kind: 'slider', min: 0, max: 0.5, step: 0.005, def: 0, show: (p) => (p?.depth ?? 0) > 0 }
];

/** colour fields the Inspector's Vector colours row edits @type {{key: string, label: string, show?: (p: any) => boolean}[]} */
export const VECTOR_COLOURS = [
	{ key: 'fill', label: 'Fill', show: (p) => p?.fillType !== 'none' },
	{ key: 'fill2', label: 'Gradient end', show: gradient },
	{ key: 'stroke', label: 'Stroke', show: stroked }
];
