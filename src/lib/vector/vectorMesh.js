// 64 D1: a vector record -> ONE BufferGeometry (three + the vector leaves).
//
// The fill is triangulated by three's own ShapeGeometry / ExtrudeGeometry (earcut) from the
// flattened outline, rings grouped into outers and holes by even-odd nesting; the stroke is the
// convex pieces from vectorStroke drawn as triangles a hair in front of the front face and
// behind the back one, so it never z-fights the fill and shows from both sides. Colours are
// VERTEX COLOURS (fill solid / linear / radial per vertex, stroke flat), so the object is one
// mesh with one plain material: toJSON, GLTF (COLOR_0), duplicate and undo all carry it with
// nothing new. A gradient fill is REFINED first (long triangle edges split) so the colour
// interpolation between vertices follows the gradient instead of smearing across two big
// triangles.
//
// The shape lies in its local XY plane facing +Z; an extruded shape grows from z = 0 to
// z = depth (+Z is the surface normal it was drawn on, so it rises OFF the surface).
import * as THREE from 'three';
import { flattenSubpath, ringsToPolygons, boundsOf } from './vectorPath.js';
import { strokeAll, piecesToTriangles } from './vectorStroke.js';
import { cleanVector, vectorSubpaths, fillColourAt, hexToRgb } from './vectorRecord.js';

/** gap between the fill surface and the stroke drawn over it (metres) */
export const STROKE_LIFT = 0.0015;
/** a cap on the triangles one shape may build (fill refinement stops early past it) */
const MAX_TRIANGLES = 60000;

/** flattening tolerance scaled to the shape: fine on a coin, cheap on a billboard
 * @param {number[][][]} raw control-point polylines */
function toleranceFor(raw) {
	const b = boundsOf(raw);
	const size = Math.max(b.maxX - b.minX, b.maxY - b.minY, 0.01);
	return Math.min(0.05, Math.max(0.002, size / 120));
}

/**
 * The flattened outline: one polyline per subpath. @param {Record<string, any>} params
 * @returns {{pts: number[][], closed: boolean}[]}
 */
export function vectorPolylines(params) {
	const p = cleanVector(params);
	const subs = vectorSubpaths(p);
	const tol = toleranceFor(subs.map((s) => s.nodes.map((n) => [n.x, n.y])));
	return subs.map((s) => ({ pts: flattenSubpath(s, tol), closed: s.closed })).filter((l) => l.pts.length >= 2);
}

/** the fill region as a MultiPolygon (open subpaths close implicitly, as SVG fills them)
 * @param {Record<string, any>} params @returns {number[][][][]} */
export function vectorFillPolygons(params) {
	return ringsToPolygons(vectorPolylines(params).map((l) => l.pts).filter((r) => r.length >= 3));
}

/** @param {number[][][][]} polys */
function shapesOf(polys) {
	return polys.map((poly) => {
		const shape = new THREE.Shape(poly[0].map((p) => new THREE.Vector2(p[0], p[1])));
		for (const hole of poly.slice(1)) shape.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(p[0], p[1]))));
		return shape;
	});
}

/** split triangles until no edge is longer than `maxEdge` (longest-edge bisection)
 * @param {number[]} pos flat xyz, 9 per triangle @param {number} maxEdge @param {number} budget triangles */
function refine(pos, maxEdge, budget) {
	/** @type {number[][]} */
	let queue = [];
	for (let i = 0; i < pos.length; i += 9) queue.push(pos.slice(i, i + 9));
	/** @type {number[][]} */
	const done = [];
	const max2 = maxEdge * maxEdge;
	while (queue.length) {
		/** @type {number[][]} */
		const next = [];
		for (const t of queue) {
			if (done.length + next.length + queue.length > budget) {
				done.push(t);
				continue;
			}
			const d01 = (t[0] - t[3]) ** 2 + (t[1] - t[4]) ** 2 + (t[2] - t[5]) ** 2;
			const d12 = (t[3] - t[6]) ** 2 + (t[4] - t[7]) ** 2 + (t[5] - t[8]) ** 2;
			const d20 = (t[6] - t[0]) ** 2 + (t[7] - t[1]) ** 2 + (t[8] - t[2]) ** 2;
			const m = Math.max(d01, d12, d20);
			if (m <= max2) {
				done.push(t);
				continue;
			}
			// rotate so the longest edge is v0-v1, then split it at its midpoint
			const r = m === d01 ? t : m === d12 ? [...t.slice(3), ...t.slice(0, 3)] : [...t.slice(6), ...t.slice(0, 6)];
			const mid = [(r[0] + r[3]) / 2, (r[1] + r[4]) / 2, (r[2] + r[5]) / 2];
			next.push([...r.slice(0, 3), ...mid, ...r.slice(6, 9)], [...mid, ...r.slice(3, 6), ...r.slice(6, 9)]);
		}
		queue = next;
	}
	return done.flat();
}

/** a non-indexed position array of a geometry @param {THREE.BufferGeometry} g */
function flatPositions(g) {
	const plain = g.index ? g.toNonIndexed() : g;
	const out = Array.from(plain.attributes.position.array);
	if (plain !== g) plain.dispose();
	return out;
}

/**
 * Build the geometry of a record. Returns a plain BufferGeometry (position, normal, uv, color);
 * an empty record (nothing to fill, nothing to stroke) builds an EMPTY geometry, never null, so
 * a param nudge can never strand an object with no geometry at all.
 * @param {Record<string, any>} params @returns {THREE.BufferGeometry}
 */
export function buildVectorGeometry(params) {
	const p = cleanVector(params);
	const lines = vectorPolylines(p);
	const all = lines.map((l) => l.pts);
	const b = boundsOf(all);
	const bw = Math.max(b.maxX - b.minX, 1e-6);
	const bh = Math.max(b.maxY - b.minY, 1e-6);
	const depth = p.depth;
	/** @type {number[]} */
	const pos = [];
	/** @type {number[]} */
	const col = [];

	// ---- fill
	if (p.fillType !== 'none') {
		const polys = ringsToPolygons(all.filter((r) => r.length >= 3));
		if (polys.length) {
			const shapes = shapesOf(polys);
			const g =
				depth > 0
					? new THREE.ExtrudeGeometry(shapes, {
							depth,
							curveSegments: 1,
							bevelEnabled: p.bevel > 0,
							bevelThickness: Math.min(p.bevel, depth / 2),
							bevelSize: p.bevel,
							bevelSegments: 2
						})
					: new THREE.ShapeGeometry(shapes, 1);
			let fill = flatPositions(g);
			g.dispose();
			if (p.fillType !== 'solid') fill = refine(fill, Math.max(bw, bh) / 24, MAX_TRIANGLES);
			if (depth > 0 && p.bevel > 0) {
				// a bevel grows out to z = depth + bevelThickness on both caps: re-seat the back cap on z = 0
				const t = Math.min(p.bevel, depth / 2);
				for (let i = 2; i < fill.length; i += 3) fill[i] += t;
			}
			for (let i = 0; i < fill.length; i += 3) {
				const c = fillColourAt(p, (fill[i] - b.minX) / bw, (fill[i + 1] - b.minY) / bh);
				col.push(c[0], c[1], c[2]);
			}
			pos.push(...fill);
		}
	}

	// ---- stroke: front and back copies
	if (p.strokeWidth > 0) {
		const tris = piecesToTriangles(strokeAll(lines, { width: p.strokeWidth, join: p.join, cap: p.cap, dash: p.dash, gap: p.gap }));
		const bevelT = depth > 0 && p.bevel > 0 ? 2 * Math.min(p.bevel, depth / 2) : 0;
		const front = (p.fillType !== 'none' ? depth + bevelT : 0) + STROKE_LIFT;
		const back = -STROKE_LIFT;
		const sc = hexToRgb(p.stroke);
		for (let i = 0; i < tris.length; i += 6) {
			pos.push(tris[i], tris[i + 1], front, tris[i + 2], tris[i + 3], front, tris[i + 4], tris[i + 5], front);
			// the back copy is wound the other way so its face points -Z
			pos.push(tris[i], tris[i + 1], back, tris[i + 4], tris[i + 5], back, tris[i + 2], tris[i + 3], back);
			for (let k = 0; k < 6; k++) col.push(sc[0], sc[1], sc[2]);
		}
	}

	const geometry = new THREE.BufferGeometry();
	if (!pos.length) return geometry;
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	// vertex colours are LINEAR in three: convert the sRGB values the record speaks
	const linear = new Float32Array(col.length);
	const c = new THREE.Color();
	for (let i = 0; i < col.length; i += 3) {
		c.setRGB(col[i], col[i + 1], col[i + 2], THREE.SRGBColorSpace);
		linear[i] = c.r;
		linear[i + 1] = c.g;
		linear[i + 2] = c.b;
	}
	geometry.setAttribute('color', new THREE.BufferAttribute(linear, 3));
	const uv = new Float32Array((pos.length / 3) * 2);
	for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
		uv[j] = (pos[i] - b.minX) / bw;
		uv[j + 1] = (pos[i + 1] - b.minY) / bh;
	}
	geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
	geometry.computeVertexNormals();
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	return geometry;
}

/** the material a vector shape is made with (vertex colours carry every colour)
 * @returns {THREE.MeshStandardMaterial} */
export function vectorMaterial() {
	return new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
}
