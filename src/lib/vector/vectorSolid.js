// 64-extrude (D7): a filled outline -> a SOLID, built on the mesh kernel (roadmap 99).
//
// outline -> faces -> extrude -> bevel, every step a kernel construction call, so the result is the
// clean mesh the editor works on (n-gon caps, quad walls, quad bevel rings; Edit mode and every face
// op apply to it), never three's ExtrudeGeometry and never a second triangulator:
//
//   1. RINGS. The fill's MultiPolygon (vectorPath.ringsToPolygons: outers CCW, holes CW), each ring
//      cleaned of repeated and collinear points. The REGION is on the LEFT of every ring.
//   2. LEVELS. One copy of every ring per level of the profile: the back cap, the back bevel's
//      quarter circle, the side wall, the front bevel, the front cap. A level is (offset, z): the
//      ring pushed `offset` OUTWARD along its mitred normals. Every level has the same vertex count,
//      so walls are quads between consecutive levels and every quad is planar (offset rings keep
//      their edges parallel).
//   3. CAPS. A cap with holes is cut into hole-free pieces by TWO BRIDGES per hole (the hole's
//      leftmost and rightmost corners to visible corners of the piece around it), so each piece is a
//      simple polygon: one kernel n-gon, triangulated by the kernel's own `triangulatePolygon`. An
//      "O" is two faces per cap; a star is one.
//   4. BEVEL. The bevel ring is INSIDE the outline by default (vectors: the drawn shape stays the
//      widest extent and the solid spans exactly z = 0..depth); `outset` grows the side outward (the
//      1.61 text object's look: three's bevelOffset). The width is clamped so no inset edge flips.
//   5. NORMALS. A corner attribute: caps flat; walls and bevel rings smooth by angle (40 degrees)
//      among themselves, so an ellipse's side is round and a star's tips stay sharp.
//
// PURE: kernel + numbers, no three.js (node tests, a Worker and the page run the same code).

import { MeshKernel } from '../meshKernel/kernel.js';
import { triangulatePolygon } from '../meshKernel/triangulate.js';
import { toArrays } from '../meshKernel/arrays.js';

/** a mitre longer than this many widths is cut (a needle tip would otherwise shoot off) */
const MITER_MAX = 6;
/** side faces whose normals are closer than this share a smooth normal */
const SMOOTH_COS = Math.cos((40 * Math.PI) / 180);
/** the bridge search tries this many nearest corners before it gives up on a hole */
const BRIDGE_TRIES = 256;

/**
 * @typedef {number[]} Pt [x, y]
 * @typedef {{ depth?: number, zBack?: number, zFront?: number, width?: number, thickness?: number,
 *   segments?: number, outset?: number, capMaterial?: number, sideMaterial?: number,
 *   roundProfile?: boolean, clamp?: boolean }} SolidOptions
 * `clamp: false` keeps the bevel as asked even where an inset side folds (the 1.61 text object's
 * look, which caps its own inward share at 1.5% of the em)
 * @typedef {{ rings: number, points: number, pieces: number, bridgeFailures: number, width: number,
 *   thickness: number, levels: number, ms: number }} SolidInfo
 */

/* ------------------------------------------------------------------ rings ---- */

/** twice the signed area @param {Pt[]} r */
function area2(r) {
	let a = 0;
	for (let i = 0, j = r.length - 1; i < r.length; j = i++)
		a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
	return a;
}

/**
 * Drop repeated points, points on a straight run and the closing duplicate. `eps` scales with the
 * ring (a coin and a billboard clean alike). @param {Pt[]} ring @returns {Pt[]}
 */
export function cleanRing(ring) {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of ring) {
		if (p[0] < minX) minX = p[0];
		if (p[0] > maxX) maxX = p[0];
		if (p[1] < minY) minY = p[1];
		if (p[1] > maxY) maxY = p[1];
	}
	const size = Math.max(maxX - minX, maxY - minY, 1e-9);
	const eps = size * 1e-7;
	/** @type {Pt[]} */
	let out = [];
	for (const p of ring) {
		const q = out[out.length - 1];
		if (q && Math.abs(q[0] - p[0]) <= eps && Math.abs(q[1] - p[1]) <= eps) continue;
		out.push([p[0], p[1]]);
	}
	while (
		out.length > 1 &&
		Math.abs(out[0][0] - out[out.length - 1][0]) <= eps &&
		Math.abs(out[0][1] - out[out.length - 1][1]) <= eps
	)
		out.pop();
	// collinear: the corner's cross product, relative to its two sides, under ~1e-9 rad
	let changed = true;
	while (changed && out.length > 3) {
		changed = false;
		/** @type {Pt[]} */
		const keep = [];
		const n = out.length;
		for (let i = 0; i < n; i++) {
			const a = keep.length ? keep[keep.length - 1] : out[(i + n - 1) % n];
			const b = out[i];
			const c = out[(i + 1) % n];
			const ux = b[0] - a[0];
			const uy = b[1] - a[1];
			const vx = c[0] - b[0];
			const vy = c[1] - b[1];
			const lu = Math.hypot(ux, uy);
			const lv = Math.hypot(vx, vy);
			const cross = ux * vy - uy * vx;
			const dot = ux * vx + uy * vy;
			if (lu > 0 && lv > 0 && Math.abs(cross) <= 1e-9 * lu * lv && dot > 0) {
				changed = true;
				continue;
			}
			keep.push(b);
		}
		if (keep.length < 3) break;
		out = keep;
	}
	return out;
}

/**
 * The unit mitre of every corner: the bisector of its two LEFT normals (into the region), scaled
 * so moving the corner by `d * mitre` moves both sides by `d` (cut at MITER_MAX).
 * @param {Pt[]} r @returns {Float64Array} 2 per corner
 */
export function ringMiters(r) {
	const n = r.length;
	const out = new Float64Array(n * 2);
	for (let i = 0; i < n; i++) {
		const a = r[(i + n - 1) % n];
		const b = r[i];
		const c = r[(i + 1) % n];
		let ex = b[0] - a[0];
		let ey = b[1] - a[1];
		let fx = c[0] - b[0];
		let fy = c[1] - b[1];
		const le = Math.hypot(ex, ey) || 1;
		const lf = Math.hypot(fx, fy) || 1;
		ex /= le;
		ey /= le;
		fx /= lf;
		fy /= lf;
		// left normals of the two sides
		const n1x = -ey;
		const n1y = ex;
		const n2x = -fy;
		const n2y = fx;
		let mx = n1x + n2x;
		let my = n1y + n2y;
		let lm = Math.hypot(mx, my);
		if (lm < 1e-9) {
			// a full turn back: push along the side direction
			mx = ex;
			my = ey;
			lm = 1;
		}
		mx /= lm;
		my /= lm;
		const k = 1 / Math.max(mx * n1x + my * n1y, 1 / MITER_MAX);
		out[i * 2] = mx * k;
		out[i * 2 + 1] = my * k;
	}
	return out;
}

/**
 * Does moving every corner INWARD by `d` keep every side pointing the way it did? (A side that
 * flips is a bevel wider than the shape is thin there.)
 * @param {Pt[][]} rings @param {Float64Array[]} miters @param {number} d
 */
function insetKeepsSides(rings, miters, d) {
	for (let r = 0; r < rings.length; r++) {
		const ring = rings[r];
		const m = miters[r];
		const n = ring.length;
		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n;
			const ox = ring[j][0] - ring[i][0];
			const oy = ring[j][1] - ring[i][1];
			const nx = ox + d * (m[j * 2] - m[i * 2]);
			const ny = oy + d * (m[j * 2 + 1] - m[i * 2 + 1]);
			if (ox * nx + oy * ny <= 0) return false;
		}
	}
	return true;
}

/**
 * The widest inset up to `want` that flips no side (bisection, 12 steps).
 * @param {Pt[][]} rings @param {Float64Array[]} miters @param {number} want
 */
export function safeInset(rings, miters, want) {
	if (want <= 0 || insetKeepsSides(rings, miters, want)) return Math.max(want, 0);
	let lo = 0;
	let hi = want;
	for (let k = 0; k < 12; k++) {
		const mid = (lo + hi) / 2;
		if (insetKeepsSides(rings, miters, mid)) lo = mid;
		else hi = mid;
	}
	// a hair inside the last good value: the sides of the cap must not meet exactly
	return lo * 0.98;
}

/* ---------------------------------------------------------------- bridges ---- */

/** do segments ab and cd cross or touch (endpoints shared by the two are not a touch)?
 * @param {Pt} a @param {Pt} b @param {Pt} c @param {Pt} d */
function segmentsMeet(a, b, c, d) {
	const o = (/** @type {Pt} */ p, /** @type {Pt} */ q, /** @type {Pt} */ r) =>
		(q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
	const d1 = o(c, d, a);
	const d2 = o(c, d, b);
	const d3 = o(a, b, c);
	const d4 = o(a, b, d);
	if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
		return true;
	const on = (/** @type {Pt} */ p, /** @type {Pt} */ q, /** @type {Pt} */ r) =>
		Math.min(p[0], q[0]) <= r[0] &&
		r[0] <= Math.max(p[0], q[0]) &&
		Math.min(p[1], q[1]) <= r[1] &&
		r[1] <= Math.max(p[1], q[1]);
	if (d1 === 0 && on(c, d, a)) return true;
	if (d2 === 0 && on(c, d, b)) return true;
	if (d3 === 0 && on(a, b, c)) return true;
	if (d4 === 0 && on(a, b, d)) return true;
	return false;
}

/** even-odd point in ring @param {Pt} p @param {Pt[]} ring */
function inside(p, ring) {
	let c = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const a = ring[i];
		const b = ring[j];
		if (
			a[1] > p[1] !== b[1] > p[1] &&
			p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
		)
			c = !c;
	}
	return c;
}

/**
 * Cut a polygon with holes into simple pieces. A corner is a REF `[ring, index]` into `rings` (the
 * cap level's coordinates), so the pieces address the same corners on every level.
 * @param {Pt[][]} rings [outer, ...holes] @returns {{ pieces: number[][][], failures: number }}
 */
export function bridgePieces(rings) {
	const at = (/** @type {number[]} */ ref) => rings[ref[0]][ref[1]];
	/** @type {number[][][]} */
	let pieces = [rings[0].map((_, i) => [0, i])];
	let failures = 0;
	const holes = rings.slice(1).map((_, k) => k + 1);
	// right to left, the earcut order: a later hole bridges past the ones already cut
	holes.sort(
		(a, b) => Math.max(...rings[b].map((p) => p[0])) - Math.max(...rings[a].map((p) => p[0]))
	);
	const pending = new Set(holes);
	for (const h of holes) {
		pending.delete(h);
		const ring = rings[h];
		const probe = ring[0];
		const pi = pieces.findIndex((piece) => inside(probe, piece.map(at)));
		if (pi < 0) {
			failures++;
			continue;
		}
		const piece = pieces[pi];
		const pts = piece.map(at);
		// obstacles: the piece's sides, this hole's sides, every hole not cut yet
		/** @type {Pt[][]} */
		const walls = [];
		const addSides = (/** @type {Pt[]} */ r) => {
			for (let i = 0; i < r.length; i++) walls.push([r[i], r[(i + 1) % r.length]]);
		};
		addSides(pts);
		addSides(ring);
		for (const o of pending) addSides(rings[o]);
		let iR = 0;
		let iL = 0;
		for (let i = 1; i < ring.length; i++) {
			if (ring[i][0] > ring[iR][0] || (ring[i][0] === ring[iR][0] && ring[i][1] < ring[iR][1]))
				iR = i;
			if (ring[i][0] < ring[iL][0] || (ring[i][0] === ring[iL][0] && ring[i][1] > ring[iL][1]))
				iL = i;
		}
		/** @param {Pt} from @param {number} skip a piece index already used @param {Pt[] | null} other a bridge it must not cross */
		const bridge = (from, skip, other) => {
			const order = pts
				.map((p, i) => [i, (p[0] - from[0]) ** 2 + (p[1] - from[1]) ** 2])
				.sort((a, b) => a[1] - b[1]);
			for (let k = 0; k < Math.min(order.length, BRIDGE_TRIES); k++) {
				const qi = order[k][0];
				if (qi === skip) continue;
				const q = pts[qi];
				if (other && (segmentsMeet(from, q, other[0], other[1]) || q === other[1])) continue;
				let blocked = false;
				for (const [a, b] of walls) {
					if (a === q || b === q || a === from || b === from) continue;
					if (segmentsMeet(from, q, a, b)) {
						blocked = true;
						break;
					}
				}
				if (blocked) continue;
				const mid = [(from[0] + q[0]) / 2, (from[1] + q[1]) / 2];
				if (!inside(mid, pts) || inside(mid, ring)) continue;
				return qi;
			}
			return -1;
		};
		const q1 = bridge(ring[iR], -1, null);
		const q2 = q1 < 0 ? -1 : bridge(ring[iL], q1, [ring[iR], pts[q1]]);
		if (q1 < 0 || q2 < 0 || iR === iL) {
			failures++;
			continue;
		}
		const n = piece.length;
		const m = ring.length;
		/** @param {number} from @param {number} to @param {number} len */
		const walk = (from, to, len) => {
			const out = [from];
			for (let i = from; i !== to;) out.push((i = (i + 1) % len));
			return out;
		};
		const A = [...walk(q1, q2, n).map((i) => piece[i]), ...walk(iL, iR, m).map((i) => [h, i])];
		const B = [...walk(q2, q1, n).map((i) => piece[i]), ...walk(iR, iL, m).map((i) => [h, i])];
		if (area2(A.map(at)) <= 0 || area2(B.map(at)) <= 0) {
			failures++;
			continue;
		}
		pieces.splice(pi, 1, A, B);
	}
	return { pieces, failures };
}

/* ------------------------------------------------------------------ build ---- */

/**
 * The profile levels, back cap first: [offset outward, z] pairs.
 * @param {number} zBack @param {number} zFront @param {number} width @param {number} thickness
 * @param {number} segments @param {number} outset
 */
export function profileLevels(zBack, zFront, width, thickness, segments, outset) {
	if (!(width > 0 && thickness > 0 && segments >= 1))
		return [
			[outset, zBack],
			[outset, zFront]
		];
	/** @type {number[][]} */
	const back = [];
	for (let k = 0; k <= segments; k++) {
		const t = (k / segments) * (Math.PI / 2);
		back.push([outset - width * (1 - Math.sin(t)), zBack + thickness * (1 - Math.cos(t))]);
	}
	/** @type {number[][]} */
	const front = [];
	for (let k = segments; k >= 0; k--) {
		const t = (k / segments) * (Math.PI / 2);
		front.push([outset - width * (1 - Math.sin(t)), zFront - thickness * (1 - Math.cos(t))]);
	}
	// a bevel that takes the whole depth: the two side levels are one
	if (Math.abs(back[back.length - 1][1] - front[0][1]) < 1e-9) front.shift();
	return [...back, ...front];
}

/**
 * Build the solid of a MultiPolygon on the kernel.
 * Vectors: `{depth, width}` (the bevel width, inward, a round profile; the solid spans z 0..depth).
 * Text: `{zBack, zFront, width, thickness, outset, segments, sideMaterial: 1}` (three's semantics:
 * the caps sit `thickness` beyond zBack / zFront).
 * @param {number[][][][]} polys MultiPolygon (outer CCW, holes CW)
 * @param {SolidOptions} [options]
 * @returns {{ mesh: MeshKernel, info: SolidInfo }}
 */
export function buildSolidKernel(polys, options = {}) {
	const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
	const segments = Math.max(1, Math.min(16, Math.round(options.segments ?? 2)));
	const outset = options.outset ?? 0;
	const capMaterial = options.capMaterial ?? 0;
	const sideMaterial = options.sideMaterial ?? 0;
	const round = options.roundProfile ?? options.zBack === undefined;
	/** @type {Pt[][][]} cleaned polygons */
	const clean = [];
	for (const poly of polys) {
		const outer = cleanRing(poly[0] ?? []);
		if (outer.length < 3 || area2(outer) <= 0) continue;
		const holes = poly
			.slice(1)
			.map(cleanRing)
			.filter((h) => h.length >= 3 && area2(h) < 0);
		clean.push([outer, ...holes]);
	}
	const allRings = clean.flat();
	const miters = allRings.map(ringMiters);
	// the bevel: inside the depth, and no wider than the shape is thin
	let zBack;
	let zFront;
	let width = Math.max(0, options.width ?? 0);
	let thickness;
	if (options.zBack === undefined) {
		const depth = Math.max(0, options.depth ?? 0);
		zBack = 0;
		zFront = depth;
		width = Math.min(width, depth / 2);
		const inward = safeInset(allRings, miters, width - outset);
		width = Math.max(0, Math.min(width, inward + outset));
		thickness = round ? width : Math.min(options.thickness ?? width, depth / 2);
	} else {
		zBack = options.zBack;
		zFront = options.zFront ?? zBack;
		thickness = Math.max(0, options.thickness ?? width);
		if (options.clamp !== false) {
			const inward = safeInset(allRings, miters, width - outset);
			width = Math.max(0, Math.min(width, inward + outset));
		}
		zBack -= thickness;
		zFront += thickness;
		if (width <= 0) thickness = 0;
	}
	const levels = profileLevels(zBack, zFront, width, thickness, segments, outset);
	const L = levels.length;
	const points = allRings.reduce((s, r) => s + r.length, 0);
	const mesh = new MeshKernel({
		vertices: points * L + 8,
		faces: points * (L - 1) + 64,
		corners: points * (L - 1) * 4 + points * 4 + 64,
		attributes: { normal: 3 }
	});
	// vertex IDs: [ring][level][index]
	/** @type {number[][][]} */
	const vid = allRings.map((ring, r) =>
		levels.map(([off, z]) => {
			const m = miters[r];
			// outward = against the left normal
			return ring.map((p, i) =>
				mesh.addVertex(p[0] - off * m[i * 2], p[1] - off * m[i * 2 + 1], z)
			);
		})
	);
	/** @type {number[]} */
	const capFaces = [];
	/** @type {number[]} */
	const sideFaces = [];
	// ---- walls + bevel rings: a quad per side per level step, outward. They form a GRID per ring
	// (face = base + level * n + side), which is how the normals find a corner's neighbours
	/** @type {{n: number, base: number}[]} */
	const grids = [];
	for (let r = 0; r < allRings.length; r++) {
		const n = allRings[r].length;
		grids.push({ n, base: sideFaces.length });
		for (let l = 0; l + 1 < L; l++) {
			const lo = vid[r][l];
			const hi = vid[r][l + 1];
			for (let i = 0; i < n; i++) {
				const j = (i + 1) % n;
				sideFaces.push(
					mesh.addFace([lo[i], lo[j], hi[j], hi[i]], {
						material: sideMaterial,
						triangles: [0, 1, 2, 0, 2, 3]
					})
				);
			}
		}
	}
	// ---- caps: bridged pieces, kernel-triangulated; back = mirrored winding
	let pieceCount = 0;
	let bridgeFailures = 0;
	let ringBase = 0;
	for (const poly of clean) {
		const capOff = levels[0][0];
		const capRings = poly.map((ring, k) => {
			const m = miters[ringBase + k];
			return ring.map(
				(p, i) => /** @type {Pt} */ ([p[0] - capOff * m[i * 2], p[1] - capOff * m[i * 2 + 1]])
			);
		});
		const { pieces, failures } = bridgePieces(capRings);
		bridgeFailures += failures;
		for (const piece of pieces) {
			const n = piece.length;
			const coords = new Float64Array(n * 3);
			piece.forEach(([r, i], k) => {
				coords[k * 3] = capRings[r][i][0];
				coords[k * 3 + 1] = capRings[r][i][1];
			});
			const tris = triangulatePolygon(coords, n);
			const front = piece.map(([r, i]) => vid[ringBase + r][L - 1][i]);
			capFaces.push(mesh.addFace(front, { material: capMaterial, triangles: tris }));
			const back = piece.map(([r, i]) => vid[ringBase + r][0][i]).reverse();
			const mirrored = [];
			for (let t = 0; t < tris.length; t += 3)
				mirrored.push(n - 1 - tris[t], n - 1 - tris[t + 2], n - 1 - tris[t + 1]);
			capFaces.push(mesh.addFace(back, { material: capMaterial, triangles: mirrored }));
			pieceCount++;
		}
		ringBase += poly.length;
	}
	writeNormals(mesh, capFaces, sideFaces, grids, L);
	const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
	return {
		mesh,
		info: {
			rings: allRings.length,
			points,
			pieces: pieceCount,
			bridgeFailures,
			width,
			thickness,
			levels: L,
			ms: t1 - t0
		}
	};
}

/**
 * Per-corner normals: caps flat, sides smooth by angle among SIDE faces only (a cap never bends
 * the side, the side never shades the cap). A side corner's neighbours are read off the grid
 * (the up-to-four quads around its vertex), never walked through the kernel's adjacency: this pass
 * was half the build time of a paragraph of text when it asked `vertexFaces` per corner.
 * @param {MeshKernel} mesh @param {number[]} caps @param {number[]} sides
 * @param {{n: number, base: number}[]} grids @param {number} L levels
 */
function writeNormals(mesh, caps, sides, grids, L) {
	const data = mesh.attrs.normal.data;
	const p = mesh.vPos;
	/** unit normal + area of a face @param {number} f @param {Float64Array} out @param {number} at */
	const newell = (f, out, at) => {
		let nx = 0;
		let ny = 0;
		let nz = 0;
		const first = mesh.fFirst[f];
		const len = mesh.fLen[f];
		for (let k = 0; k < len; k++) {
			const a = mesh.cVert[first + k] * 3;
			const b = mesh.cVert[first + ((k + 1) % len)] * 3;
			nx += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2]);
			ny += (p[a + 2] - p[b + 2]) * (p[a] + p[b]);
			nz += (p[a] - p[b]) * (p[a + 1] + p[b + 1]);
		}
		const l = Math.hypot(nx, ny, nz);
		out[at * 4] = l > 0 ? nx / l : 0;
		out[at * 4 + 1] = l > 0 ? ny / l : 0;
		out[at * 4 + 2] = l > 0 ? nz / l : 0;
		// a sliver still counts a little, or a needle tip loses its own direction
		out[at * 4 + 3] = Math.max(l / 2, 1e-12);
	};
	const one = new Float64Array(4);
	for (const f of caps) {
		newell(f, one, 0);
		const first = mesh.fFirst[f];
		for (let k = 0; k < mesh.fLen[f]; k++) {
			const c = first + k;
			data[c * 3] = one[0];
			data[c * 3 + 1] = one[1];
			data[c * 3 + 2] = one[2];
		}
	}
	// side face normals by their index in `sides` (= the grid index)
	const sn = new Float64Array(sides.length * 4);
	for (let s = 0; s < sides.length; s++) newell(sides[s], sn, s);
	const rows = L - 1;
	for (const { n, base } of grids) {
		for (let l = 0; l < rows; l++)
			for (let i = 0; i < n; i++) {
				const s = base + l * n + i;
				const f = sides[s];
				const first = mesh.fFirst[f];
				// corners: (l, i) (l, i+1) (l+1, i+1) (l+1, i) — the quad's own winding
				for (let k = 0; k < 4; k++) {
					const lv = l + (k >= 2 ? 1 : 0);
					const iv = (i + (k === 1 || k === 2 ? 1 : 0)) % n;
					let sx = 0;
					let sy = 0;
					let sz = 0;
					for (let dl = -1; dl <= 0; dl++) {
						const gl = lv + dl;
						if (gl < 0 || gl >= rows) continue;
						for (let di = -1; di <= 0; di++) {
							const g = base + gl * n + ((iv + di + n) % n);
							const dot =
								sn[s * 4] * sn[g * 4] +
								sn[s * 4 + 1] * sn[g * 4 + 1] +
								sn[s * 4 + 2] * sn[g * 4 + 2];
							if (g !== s && dot < SMOOTH_COS) continue;
							const w = sn[g * 4 + 3];
							sx += sn[g * 4] * w;
							sy += sn[g * 4 + 1] * w;
							sz += sn[g * 4 + 2] * w;
						}
					}
					const len = Math.hypot(sx, sy, sz) || 1;
					const c = first + k;
					data[c * 3] = sx / len;
					data[c * 3 + 1] = sy / len;
					data[c * 3 + 2] = sz / len;
				}
			}
	}
}

/**
 * The solid as plain arrays: non-indexed positions + normals (Float32), the face partition (each
 * kernel face = its output triangles: meshTopology's `__topo`), and per-triangle material.
 * @param {number[][][][]} polys @param {SolidOptions} [options]
 */
export function buildSolidArrays(polys, options = {}) {
	const { mesh, info } = buildSolidKernel(polys, options);
	const out = toArrays(mesh);
	return {
		positions: out.positions,
		normals: out.attributes.normal?.array ?? null,
		material: out.material,
		faces: out.faces,
		info,
		mesh
	};
}
