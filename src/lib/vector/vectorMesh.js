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
//
// 64-extrude (D7): an extruded fill is built on the MESH KERNEL (vectorSolid.js): n-gon caps,
// quad walls and quad bevel rings, stored as the face partition (`__topo`), so Edit mode opens it
// as a clean mesh. Its colours stay per vertex; a gradient on a solid is NOT refined (that would
// cut the caps into triangle soup): a two-stop linear gradient is exact, a radial one is coarse.
import * as THREE from 'three';
import { flattenSubpath, ringsToPolygons, boundsOf } from './vectorPath.js';
import { buildSolidArrays } from './vectorSolid.js';
import { strokeAll, piecesToTriangles } from './vectorStroke.js';
import { cleanVector, vectorSubpaths, fillColourAt, hexToRgb } from './vectorRecord.js';

/** gap between the fill surface and the stroke drawn over it (metres) */
export const STROKE_LIFT = 0.0015;
/** TEST/DEBUG: the last solid built (timing, pieces, the bevel width it could fit) — never on userData,
 * where a timing would make every save of the same shape differ @type {any} */
export let lastSolid = null;
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
	return subs
		.map((s) => ({ pts: flattenSubpath(s, tol), closed: s.closed }))
		.filter((l) => l.pts.length >= 2);
}

/** the fill region as a MultiPolygon (open subpaths close implicitly, as SVG fills them)
 * @param {Record<string, any>} params @returns {number[][][][]} */
export function vectorFillPolygons(params) {
	return ringsToPolygons(
		vectorPolylines(params)
			.map((l) => l.pts)
			.filter((r) => r.length >= 3)
	);
}

/** @param {number[][][][]} polys */
function shapesOf(polys) {
	return polys.map((poly) => {
		const shape = new THREE.Shape(poly[0].map((p) => new THREE.Vector2(p[0], p[1])));
		for (const hole of poly.slice(1))
			shape.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(p[0], p[1]))));
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
			const r =
				m === d01
					? t
					: m === d12
						? [...t.slice(3), ...t.slice(0, 3)]
						: [...t.slice(6), ...t.slice(0, 6)];
			const mid = [(r[0] + r[3]) / 2, (r[1] + r[4]) / 2, (r[2] + r[5]) / 2];
			next.push(
				[...r.slice(0, 3), ...mid, ...r.slice(6, 9)],
				[...mid, ...r.slice(3, 6), ...r.slice(6, 9)]
			);
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
	const fast = depthOnly(p);
	if (fast) return fast;
	const lines = vectorPolylines(p);
	const all = lines.map((l) => l.pts);
	const b = boundsOf(all);
	const bw = Math.max(b.maxX - b.minX, 1e-6);
	const bh = Math.max(b.maxY - b.minY, 1e-6);
	const depth = p.depth;
	/** the pieces, in output order: positions (non-indexed xyz), optional normals, optional face partition
	 * @type {{pos: ArrayLike<number>, normals: ArrayLike<number> | null, faces: number[][] | null, colour: (x: number, y: number) => number[]}[]} */
	const parts = [];
	const fillColour = (/** @type {number} */ x, /** @type {number} */ y) =>
		fillColourAt(p, (x - b.minX) / bw, (y - b.minY) / bh);
	/** @type {any} */
	let solidInfo = null;

	// ---- fill
	if (p.fillType !== 'none') {
		const polys = ringsToPolygons(all.filter((r) => r.length >= 3));
		if (polys.length && depth > 0) {
			const solid = buildSolidArrays(polys, { depth, width: p.bevel, segments: p.bevelSegments });
			solidInfo = solid.info;
			parts.push({
				pos: solid.positions,
				normals: solid.normals,
				faces: solid.faces,
				colour: fillColour
			});
		} else if (polys.length) {
			const g = new THREE.ShapeGeometry(shapesOf(polys), 1);
			let fill = flatPositions(g);
			g.dispose();
			if (p.fillType !== 'solid') fill = refine(fill, Math.max(bw, bh) / 24, MAX_TRIANGLES);
			parts.push({ pos: fill, normals: null, faces: null, colour: fillColour });
		}
	}

	// ---- stroke: front and back copies
	if (p.strokeWidth > 0) {
		const tris = piecesToTriangles(
			strokeAll(lines, { width: p.strokeWidth, join: p.join, cap: p.cap, dash: p.dash, gap: p.gap })
		);
		const front = (p.fillType !== 'none' ? depth : 0) + STROKE_LIFT;
		const back = -STROKE_LIFT;
		const sc = hexToRgb(p.stroke);
		/** @type {number[]} */
		const pos = [];
		for (let i = 0; i < tris.length; i += 6) {
			pos.push(
				tris[i],
				tris[i + 1],
				front,
				tris[i + 2],
				tris[i + 3],
				front,
				tris[i + 4],
				tris[i + 5],
				front
			);
			// the back copy is wound the other way so its face points -Z
			pos.push(
				tris[i],
				tris[i + 1],
				back,
				tris[i + 4],
				tris[i + 5],
				back,
				tris[i + 2],
				tris[i + 3],
				back
			);
		}
		parts.push({ pos, normals: null, faces: null, colour: () => sc });
	}

	const geometry = new THREE.BufferGeometry();
	const count = parts.reduce((n, part) => n + part.pos.length, 0);
	if (!count) return geometry;
	const pos = new Float32Array(count);
	const normal = new Float32Array(count);
	// vertex colours are LINEAR in three: convert the sRGB values the record speaks
	const linear = new Float32Array(count);
	const uv = new Float32Array((count / 3) * 2);
	const c = new THREE.Color();
	/** @type {number[][]} */
	const faces = [];
	let at = 0;
	for (const part of parts) {
		const src = part.pos;
		const tri0 = at / 9;
		for (let i = 0; i < src.length; i++) pos[at + i] = src[i];
		if (part.normals) for (let i = 0; i < src.length; i++) normal[at + i] = part.normals[i];
		else
			for (let i = 0; i < src.length; i += 9) {
				// flat: the triangle's own normal on its three corners
				const ux = src[i + 3] - src[i];
				const uy = src[i + 4] - src[i + 1];
				const uz = src[i + 5] - src[i + 2];
				const vx = src[i + 6] - src[i];
				const vy = src[i + 7] - src[i + 1];
				const vz = src[i + 8] - src[i + 2];
				let nx = uy * vz - uz * vy;
				let ny = uz * vx - ux * vz;
				let nz = ux * vy - uy * vx;
				const l = Math.hypot(nx, ny, nz) || 1;
				nx /= l;
				ny /= l;
				nz /= l;
				for (let k = 0; k < 9; k += 3) {
					normal[at + i + k] = nx;
					normal[at + i + k + 1] = ny;
					normal[at + i + k + 2] = nz;
				}
			}
		for (let i = 0; i < src.length; i += 3) {
			const s = part.colour(src[i], src[i + 1]);
			c.setRGB(s[0], s[1], s[2], THREE.SRGBColorSpace);
			linear[at + i] = c.r;
			linear[at + i + 1] = c.g;
			linear[at + i + 2] = c.b;
			const j = ((at + i) / 3) * 2;
			uv[j] = (src[i] - b.minX) / bw;
			uv[j + 1] = (src[i + 1] - b.minY) / bh;
		}
		const tris = src.length / 9;
		if (part.faces) for (const face of part.faces) faces.push(face.map((t) => t + tri0));
		else for (let t = 0; t < tris; t++) faces.push([tri0 + t]);
		at += src.length;
	}
	geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
	geometry.setAttribute('color', new THREE.BufferAttribute(linear, 3));
	geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
	// 64-extrude: a solid keeps its kernel faces (meshTopology's `__topo`: n-gon caps, quad walls), so
	// Edit mode opens it as the mesh it was built as instead of re-deriving quads from triangles
	if (solidInfo) {
		geometry.userData.__topo = { counts: faces.map((f) => f.length), tris: faces.flat() };
		lastSolid = solidInfo;
		remember(p, { pos, normal, colour: linear, uv, topo: geometry.userData.__topo });
	}
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	return geometry;
}

/* ---------------------------------------------------------- depth drag ---- */

// 64-extrude: dragging the depth changes nothing but how far the front half sits from the back, so
// the solid's faces, normals, colours and uvs stay; only the front half's z moves. Every peer builds
// from the record, so this path is what keeps a drag on a 2 000-point shape at frame rate on all of
// them. It applies when the bevel fits inside both depths with room to spare (a bevel that takes
// the whole depth merges two levels: a different mesh) — anything else builds in full.

/** the last few solids built, by their record minus depth @type {Map<string, {depth: number, bevel: number, pos: Float32Array, normal: Float32Array, colour: Float32Array, uv: Float32Array, topo: {counts: number[], tris: number[]}}>} */
const solids = new Map();
const SOLIDS_MAX = 3;

/** @param {Record<string, any>} p */
const shapeKey = (p) => JSON.stringify({ ...p, depth: 0 });

/** @param {Record<string, any>} p @param {{pos: Float32Array, normal: Float32Array, colour: Float32Array, uv: Float32Array, topo: any}} arrays */
function remember(p, arrays) {
	const key = shapeKey(p);
	solids.delete(key);
	solids.set(key, {
		depth: p.depth,
		bevel: p.bevel,
		pos: arrays.pos.slice(),
		normal: arrays.normal.slice(),
		colour: arrays.colour.slice(),
		uv: arrays.uv.slice(),
		topo: { counts: arrays.topo.counts.slice(), tris: arrays.topo.tris.slice() }
	});
	while (solids.size > SOLIDS_MAX)
		solids.delete(/** @type {string} */ (solids.keys().next().value));
}

/** a solid of the same shape at another depth, from the cache; null = build it @param {Record<string, any>} p */
function depthOnly(p) {
	if (!(p.depth > 0) || p.fillType === 'none') return null;
	const hit = solids.get(shapeKey(p));
	if (!hit) return null;
	// the bevel must fit strictly inside both depths (or be off)
	if (p.bevel > 0 && !(p.bevel < hit.depth / 2 && p.bevel < p.depth / 2)) return null;
	const pos = hit.pos.slice();
	const split = hit.depth / 2;
	const shift = p.depth - hit.depth;
	for (let i = 2; i < pos.length; i += 3) if (pos[i] > split) pos[i] += shift;
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	geometry.setAttribute('normal', new THREE.BufferAttribute(hit.normal.slice(), 3));
	geometry.setAttribute('color', new THREE.BufferAttribute(hit.colour.slice(), 3));
	geometry.setAttribute('uv', new THREE.BufferAttribute(hit.uv.slice(), 2));
	geometry.userData.__topo = { counts: hit.topo.counts.slice(), tris: hit.topo.tris.slice() };
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	fastBuilds++;
	return geometry;
}

/** TEST/DEBUG: how many builds took the depth path */
let fastBuilds = 0;
export const vectorMeshDebug = () => ({ fastBuilds, cached: solids.size, lastSolid });
/** TEST: forget the cached solids */
export function resetSolidCache() {
	solids.clear();
}

/** the material a vector shape is made with (vertex colours carry every colour)
 * @returns {THREE.MeshStandardMaterial} */
export function vectorMaterial() {
	return new THREE.MeshStandardMaterial({
		color: 0xffffff,
		vertexColors: true,
		roughness: 0.8,
		metalness: 0,
		side: THREE.DoubleSide
	});
}
