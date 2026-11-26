// 64 D3: BOOLEANS, STROKE-TO-OUTLINE and INSET / OUTSET on vector shapes. Pure: records in,
// records out — the scene glue (vectorActions) commits them. polygon-clipping (MIT) lives
// ONLY here, so it is a lazy chunk: nothing on the boot path imports this module.
//
// Results are POLYGONS (curves come back flattened to corner nodes at the builder's own
// tolerance) — the roadmap's call: Paper.js only if curve-preserving booleans turn out to
// matter. Every input is snapped to a fine grid first, which is what keeps polygon-clipping's
// sweep line away from the near-coincident edges two touching shapes produce; a failure retries
// on a coarser grid before giving up.
import polygonClipping from 'polygon-clipping';
import { polygonsToSubpaths, ringsToPolygons, centreSubpaths } from './vectorPath.js';
import { strokeAll } from './vectorStroke.js';
import { cleanVector } from './vectorRecord.js';
import { vectorPolylines, vectorFillPolygons } from './vectorMesh.js';

export const BOOLEAN_OPS = ['union', 'subtract', 'intersect', 'exclude'];

/** @typedef {number[][][][]} MultiPolygon */

/** apply a 2D affine [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f) @param {MultiPolygon} mp @param {number[] | null} m */
export function transformPolygons(mp, m) {
	if (!m) return mp;
	return mp.map((poly) => poly.map((ring) => ring.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])));
}

/** snap to a grid and close every ring (polygon-clipping wants closed rings) @param {MultiPolygon} mp @param {number} grid */
function snap(mp, grid) {
	const q = (/** @type {number} */ v) => Math.round(v / grid) * grid;
	return mp
		.map((poly) =>
			poly
				.map((ring) => {
					const r = ring.map(([x, y]) => [q(x), q(y)]);
					if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push([...r[0]]);
					return r;
				})
				.filter((ring) => ring.length >= 4)
		)
		.filter((poly) => poly.length);
}

/** run one polygon-clipping op with the grid-retry @param {'union'|'difference'|'intersection'|'xor'} op @param {MultiPolygon[]} geoms @returns {MultiPolygon} */
function clip(op, geoms) {
	const fn = /** @type {any} */ (polygonClipping)[op];
	let last;
	for (const grid of [1e-7, 1e-6, 1e-5]) {
		try {
			const [first, ...rest] = geoms.map((g) => snap(g, grid));
			return fn(first ?? [], ...rest);
		} catch (error) {
			last = error;
		}
	}
	throw last;
}

/** map the user-facing op name to polygon-clipping's @param {string} op */
const opName = (op) => (op === 'subtract' ? 'difference' : op === 'intersect' ? 'intersection' : op === 'exclude' ? 'xor' : 'union');

/** the fill area of a record — or, for a shape with no fill, the area its stroke covers (a pen
 * line taking part in a boolean is the line you can see) @param {Record<string, any>} params @returns {MultiPolygon} */
export function areaOf(params) {
	const p = cleanVector(params);
	if (p.fillType === 'none' && p.strokeWidth > 0) return strokeArea(p);
	return vectorFillPolygons(p);
}

/** the region a stroke covers, as clean polygons @param {Record<string, any>} params @returns {MultiPolygon} */
export function strokeArea(params) {
	const p = cleanVector(params);
	const pieces = strokeAll(vectorPolylines(p), { width: p.strokeWidth, join: p.join, cap: p.cap, dash: p.dash, gap: p.gap });
	if (!pieces.length) return [];
	return clip('union', pieces.map((piece) => [[piece]]));
}

/**
 * A boolean of several shapes. The FIRST is the subject (subtract takes the rest away from it)
 * and the result keeps its look — fill, stroke, extrusion — the way every vector app does.
 * @param {string} op one of BOOLEAN_OPS
 * @param {{params: Record<string, any>, matrix?: number[] | null}[]} shapes each shape's record
 *   and the 2D affine that carries its outline into the FIRST shape's frame (null = same frame)
 * @returns {{params: Record<string, any>, cx: number, cy: number} | null} the new record, re-centred,
 *   and the offset the object must move by so nothing moves in the world; null = empty result
 */
export function booleanShapes(op, shapes) {
	if (shapes.length < 2) return null;
	const geoms = shapes.map((s) => transformPolygons(areaOf(s.params), s.matrix ?? null));
	const result = clip(/** @type {any} */ (opName(op)), geoms);
	return resultRecord(shapes[0].params, result);
}

/** build the record a polygon result becomes, styled after `base` @param {Record<string, any>} base @param {MultiPolygon} result @param {Record<string, any>} [patch] */
function resultRecord(base, result, patch = {}) {
	const subs = polygonsToSubpaths(result);
	if (!subs.length) return null;
	const { subpaths, cx, cy } = centreSubpaths(subs);
	const b = cleanVector(base);
	// a pen line that took part as its stroke area becomes a FILLED shape of that colour
	const fill = b.fillType === 'none' ? { fillType: 'solid', fill: b.stroke, strokeWidth: 0 } : {};
	return { params: cleanVector({ ...b, ...fill, ...patch, kind: 'path', paths: subpaths }), cx, cy };
}

/**
 * Stroke-to-outline: the stroke becomes a filled shape of the stroke's colour (no stroke of its
 * own). The caller decides what happens to the source (keep its fill, drop its stroke).
 * @param {Record<string, any>} params @returns {{params: Record<string, any>, cx: number, cy: number} | null}
 */
export function outlineStroke(params) {
	const p = cleanVector(params);
	if (!(p.strokeWidth > 0)) return null;
	return resultRecord(p, strokeArea(p), { fillType: 'solid', fill: p.stroke, strokeWidth: 0, dash: 0, gap: 0 });
}

/**
 * Inset (negative) / outset (positive) the fill area by `distance`, corners following the
 * shape's join (round / miter / bevel). An inset that eats the whole shape returns null.
 * @param {Record<string, any>} params @param {number} distance @returns {{params: Record<string, any>, cx: number, cy: number} | null}
 */
export function offsetShape(params, distance) {
	const p = cleanVector(params);
	const area = areaOf(p);
	if (!area.length || !distance) return null;
	// the band either side of the outline: every ring of the area, stroked 2|d| wide
	const rings = area.flatMap((poly) => poly.map((ring) => ({ pts: ring, closed: true })));
	const pieces = strokeAll(rings, { width: Math.abs(distance) * 2, join: p.join, cap: 'butt', miterLimit: 8 });
	const band = pieces.map((piece) => [[piece]]);
	const result = distance > 0 ? clip('union', [area, ...band]) : clip('difference', [area, clip('union', band)]);
	return resultRecord(p, result);
}

/** area of a MultiPolygon (holes subtract) — for tests and the empty-result check @param {MultiPolygon} mp */
export function multiArea(mp) {
	let a = 0;
	for (const poly of mp)
		for (let r = 0; r < poly.length; r++) {
			const ring = poly[r];
			let s = 0;
			for (let i = 0, n = ring.length; i < n; i++) {
				const p = ring[i];
				const q = ring[(i + 1) % n];
				s += p[0] * q[1] - q[0] * p[1];
			}
			a += (r === 0 ? 1 : -1) * Math.abs(s / 2);
		}
	return a;
}

/** a record's fill area in square metres (for tests / the UI) @param {Record<string, any>} params */
export function recordArea(params) {
	return multiArea(ringsToPolygons(vectorPolylines(params).map((l) => l.pts)));
}
