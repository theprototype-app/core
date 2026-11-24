// @ts-check
// Roadmap 99 K4 family 2: the BEVELS on the kernel. The FACE bevel is the soup's own recipe — per step, each
// connected piece insets by a world distance (converted to its own fraction), then the cap is pushed along the
// face normal — over the family-1 kernel operators, so its output (triangles, order, partition, uvs) is the soup's.
import { isolateTriangles, cornerOf, explodeFaces as isolateFaces } from './opMesh.js';
import {
	readStep,
	regionsOf,
	boundaryLoop,
	cornerUvs,
	materialOf,
	rebuilder,
	fanPolygon,
	pushQuad,
	verticesByKey,
	keyOfPos,
	triNormal,
	pos,
	sub,
	add,
	scale,
	dot,
	cross,
	length,
	normalize,
	lerp,
	uvLerp,
	axisLeastAlignedWith
} from './rebuild.js';
import { insetRegion, moveRegion, triangleComponents, borderOf } from './extrude.js';

/** @typedef {import('./opMesh.js').OpMesh} OpMesh */
/** @typedef {import('./rebuild.js').Vec} Vec */
/** @typedef {import('./rebuild.js').Rebuild} Rebuild */

/**
 * The inset FRACTION that makes one connected piece's border travel `width` world units: the width over the
 * mean distance of its border vertices (deduplicated by position key) from the piece's centroid (every
 * triangle corner counts) — faceEdit's `insetDistanceToFraction`, clamped to 0.95; a degenerate piece = 0.95.
 * @param {OpMesh} om @param {number[]} piece @param {number} width @returns {number}
 */
export function insetFraction(om, piece, width) {
	const m = om.mesh;
	const p = m.vPos;
	let cx = 0;
	let cy = 0;
	let cz = 0;
	let n = 0;
	for (const t of piece)
		for (let k = 0; k < 3; k++) {
			const v = m.cVert[cornerOf(om, t, k)];
			cx += p[v * 3];
			cy += p[v * 3 + 1];
			cz += p[v * 3 + 2];
			n++;
		}
	cx /= n || 1;
	cy /= n || 1;
	cz /= n || 1;
	const faces = isolateTriangles(om, piece);
	/** @type {Set<string>} */
	const seen = new Set();
	let sum = 0;
	let count = 0;
	for (const b of borderOf(om, piece, faces))
		for (const v of [b.va, b.vb]) {
			const x = p[v * 3];
			const y = p[v * 3 + 1];
			const z = p[v * 3 + 2];
			const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			sum += Math.hypot(x - cx, y - cy, z - cz);
			count++;
		}
	const mean = count ? sum / count : 0;
	if (mean < 1e-9) return 0.95;
	return Math.min(Math.max(width / mean, 0), 0.95);
}

/**
 * FACE BEVEL of a region (faceEdit `bevelFacesCore`): `segments` steps on a schedule that blends linear (profile 0)
 * toward the convex (profile > 0) or concave (< 0) quarter circle; each step insets every connected piece by its
 * share of `width` (world units) and pushes the cap along `normal` by its share of the depth (+width out, -width in).
 * The cap keeps its triangle indices; the rings are the operator's authored faces.
 * @param {OpMesh} om @param {number[]} tris @param {number[]} normal the target face's normal
 * @param {{ width?: number, segments?: number, profile?: number, direction?: 'out' | 'in' }} [options]
 */
export function bevelRegion(om, tris, normal, options = {}) {
	const n = options.segments ?? 1;
	const total = options.width ?? 0.15;
	const profile = Math.min(Math.max(options.profile ?? 1, -1), 1);
	const concave = profile < 0;
	const curve = Math.abs(profile);
	const depth = (options.direction === 'in' ? -1 : 1) * total;
	for (let k = 1; k <= n; k++) {
		const from = ((k - 1) / n) * (Math.PI / 2);
		const to = (k / n) * (Math.PI / 2);
		const arcSin = Math.sin(to) - Math.sin(from);
		const arcCos = Math.cos(from) - Math.cos(to);
		const insetShare = ((1 - curve) * 1) / n + curve * (concave ? arcCos : arcSin);
		const pushShare = ((1 - curve) * 1) / n + curve * (concave ? arcSin : arcCos);
		const worldStep = insetShare * total;
		if (worldStep > 1e-9)
			for (const piece of triangleComponents(om, tris)) insetRegion(om, piece, insetFraction(om, piece, worldStep));
		const pushStep = pushShare * depth;
		if (pushStep) moveRegion(om, tris, normal, pushStep);
	}
	return { capTriIndices: [...tris] };
}

/** faceEdit `clampedBevelWidth`: never cross, never swallow an edge @param {number} width @param {number} edgeLength */
const clampedBevelWidth = (width, edgeLength) => Math.min(Math.max(width, 1e-4), edgeLength * 0.45);

/**
 * VERTEX BEVEL of one vertex (faceEdit `bevelOneVertex`): every coplanar region around it gives up the
 * corner for the two offset points on its boundary edges (keyed by the far vertex, so two regions sharing
 * an edge share the point), each region is re-fanned from its new boundary, and the hole is capped (flat,
 * domed/dished by `profile`, or `segments` concentric rings). Null = left alone (an open corner, a region
 * with a hole). @param {OpMesh} om @param {number} v @param {number} width @param {number} profile
 * @param {number} segments @returns {number[] | null} the cap's vertices (its authoring set)
 */
function bevelVertexK(om, v, width, profile, segments) {
	const step = readStep(om);
	const atVertex = regionsOf(step, step.trisAt(v));
	if (atVertex.length < 3) return null;
	/** @type {Map<number, Vec>} far vertex -> offset point */
	const offsets = new Map();
	const plan = [];
	for (const region of atVertex) {
		const loop = boundaryLoop(step, region.tris);
		if (!loop) return null;
		const corners = cornerUvs(step, region.tris);
		const index = loop.indexOf(v);
		if (index < 0) return null;
		const n = loop.length;
		const vertex = pos(om, v);
		const vertexUv = corners.get(v) ?? [0, 0];
		/** @param {number} far */
		const offsetTo = (far) => {
			const span = sub(pos(om, far), vertex);
			const len = length(span);
			const w = clampedBevelWidth(width, len);
			if (!offsets.has(far)) offsets.set(far, add(vertex, scale(normalize(span), w)));
			return { far, uv: uvLerp(vertexUv, corners.get(far) ?? vertexUv, len > 1e-9 ? w / len : 0) };
		};
		plan.push({ region, loop, corners, index, a: offsetTo(loop[(index - 1 + n) % n]), b: offsetTo(loop[(index + 1) % n]) });
	}
	if (offsets.size < 3) return null;
	let normal = /** @type {Vec} */ ([0, 0, 0]);
	for (const entry of plan) normal = add(normal, entry.region.normal);
	if (dot(normal, normal) < 1e-12) return null;
	normal = normalize(normal);

	const rb = rebuilder(om, new Set([v]));
	/** @type {Map<number, number>} far vertex -> the new offset vertex */
	const offsetVertex = new Map();
	for (const [far, p] of offsets) offsetVertex.set(far, rb.vertex(p));
	/** @type {number[]} */
	const replaced = [];
	for (const entry of plan) replaced.push(...entry.region.tris);
	// each region: its boundary with the corner replaced by the two offset points (Pnext, next ... previous, Pprevious)
	for (const { region, loop, corners, index, a, b } of plan) {
		const n = loop.length;
		/** @type {import('./rebuild.js').RingCorner[]} */
		const ring = [];
		for (let i = 1; i < n; i++) {
			const point = loop[(index + i) % n];
			ring.push({ v: point, uv: corners.get(point) ?? [0, 0] });
		}
		ring.unshift({ v: /** @type {number} */ (offsetVertex.get(b.far)), uv: b.uv });
		ring.push({ v: /** @type {number} */ (offsetVertex.get(a.far)), uv: a.uv });
		fanPolygon(rb, om, ring, region.normal, materialOf(om, region.tris[0]), 1);
	}
	// the cap: the offset points by angle around the corner normal
	const points = [...offsets.entries()];
	let centre = /** @type {Vec} */ ([0, 0, 0]);
	for (const [, p] of points) centre = add(centre, p);
	centre = scale(centre, 1 / points.length);
	const uAxis = normalize(cross(axisLeastAlignedWith(normal), normal));
	const vAxis = normalize(cross(normal, uAxis));
	const ordered = points
		.map(([far, p]) => {
			const d = sub(p, centre);
			return { far, p, angle: Math.atan2(dot(d, vAxis), dot(d, uAxis)) };
		})
		.sort((x, y) => x.angle - y.angle);
	const capMaterial = materialOf(om, plan[0].region.tris[0]);
	const capUv = plan[0].a.uv;
	const ring = ordered.map((o) => ({ v: /** @type {number} */ (offsetVertex.get(o.far)), uv: capUv }));
	/** @type {number[]} */
	const capVerts = ring.map((c) => c.v);
	if (segments > 1) {
		const lift = (/** @type {number} */ u) => profile * width * Math.sin((u * Math.PI) / 2);
		/** @type {number[][]} */
		const rings = [ring.map((c) => c.v)];
		for (let j = 1; j < segments; j++) {
			const u = j / segments;
			rings.push(ordered.map((o) => rb.vertex(add(lerp(o.p, centre, u), scale(normal, lift(u))))));
		}
		const top = rb.vertex(add(centre, scale(normal, lift(1))));
		const n = ordered.length;
		for (let j = 0; j + 1 < rings.length; j++)
			for (let i = 0; i < n; i++)
				pushQuad(rb, om, [rings[j][i], rings[j][(i + 1) % n], rings[j + 1][(i + 1) % n], rings[j + 1][i]], normal, capMaterial, [capUv, capUv, capUv, capUv]);
		const last = rings[rings.length - 1];
		for (let i = 0; i < n; i++)
			fanPolygon(rb, om, [{ v: top, uv: capUv }, { v: last[i], uv: capUv }, { v: last[(i + 1) % n], uv: capUv }], normal, capMaterial, 0);
		for (let j = 1; j < rings.length; j++) capVerts.push(...rings[j]);
		capVerts.push(top);
	} else if (Math.abs(profile) < 1e-3) {
		fanPolygon(rb, om, ring, normal, capMaterial, 0);
	} else {
		const apex = { v: rb.vertex(add(centre, scale(normal, profile * width))), uv: capUv };
		for (let i = 0; i < ring.length; i++) fanPolygon(rb, om, [apex, ring[i], ring[(i + 1) % ring.length]], normal, capMaterial, 0);
	}
	rb.finish(replaced);
	return capVerts;
}

/**
 * VERTEX BEVEL of every key (faceEdit `bevelVerticesCore` + its wrapper's authoring): each vertex against
 * the CURRENT mesh, then the stored partition is the soup's — every cap ONE face (the triangles whose three
 * vertices are all on it), every other triangle its own face (composeFaces(null, ...)), and the op mesh's
 * faces made to match (a face of several triangles is split), so the IDs agree with the partition.
 * @param {OpMesh} om @param {string[]} keys welded position keys
 * @param {{ width?: number, profile?: number, segments?: number }} [options]
 * @returns {{ done: number, skipped: number, caps: number[][] }} caps = each bevelled corner's cap vertices
 */
export function bevelVertices(om, keys, options = {}) {
	const width = options.width ?? 0.2;
	const profile = options.profile ?? 0;
	const segments = Math.max(1, Math.min(Math.round(options.segments ?? 1) || 1, 8));
	const byKey = verticesByKey(om, keys);
	/** @type {number[][]} */
	const caps = [];
	let done = 0;
	let skipped = 0;
	for (const key of keys) {
		const v = byKey.get(key);
		const cap = v === undefined || !om.mesh.hasVertex(v) ? null : bevelVertexK(om, v, width, profile, segments);
		if (!cap) {
			skipped++;
			continue;
		}
		caps.push(cap);
		done++;
	}
	if (done) singletonPartition(om, caps);
	return { done, skipped, caps };
}

/**
 * The vertex bevel's partition: caps authored (a triangle is on a cap when all three vertices are), then
 * every other triangle alone, in output order; faces of several triangles split so each kernel face is one
 * stored face. @param {OpMesh} om @param {number[][]} caps
 */
function singletonPartition(om, caps) {
	const step = readStep(om);
	const { verts, n } = step;
	/** @type {number[][]} */
	const authored = [];
	/** @type {Set<number>} */
	const claimed = new Set();
	for (const cap of caps) {
		const set = new Set(cap);
		/** @type {number[]} */
		const face = [];
		for (let t = 0; t < n; t++) if (set.has(verts[t * 3]) && set.has(verts[t * 3 + 1]) && set.has(verts[t * 3 + 2])) face.push(t);
		if (!face.length || face.some((t) => claimed.has(t))) continue;
		face.forEach((t) => claimed.add(t));
		authored.push(face);
	}
	// split every multi-triangle face (keeps corners, order keys, the first piece's ID)
	/** @type {number[]} */
	const multi = [];
	for (let t = 0; t < n; t++) if (om.mesh.fTriLen[om.view.tFace[t]] > 1) multi.push(t);
	if (multi.length) isolateFaces(om, multi);
	const group = new Int32Array(n).fill(-1);
	authored.forEach((face, i) => face.forEach((t) => (group[t] = i)));
	let next = authored.length;
	for (let t = 0; t < n; t++) if (group[t] < 0) group[t] = next++;
	for (let t = 0; t < n; t++) om.logical[om.view.tFace[t]] = group[t];
	om.baseGroup = 0;
	om.nextGroup = next;
}

/** @typedef {{ p: Vec, uv: number[] }} PointCorner a ring corner by POSITION (the edge bevel's soup currency) */

/**
 * faceEdit `fanBest`: fan the ring from the corner whose smallest triangle is largest and whose spokes
 * duplicate no surviving edge (`surviving(a, b)` over key-cell vertices), else from its centroid.
 * @param {Rebuild} rb @param {PointCorner[]} ring @param {number} material
 * @param {(a: Vec, b: Vec) => boolean} surviving
 */
function fanBest(rb, ring, material, surviving) {
	const n = ring.length;
	if (n < 3) return;
	let best = -1;
	let bestArea = -1;
	let bestPreferred = false;
	for (let s = 0; s < n; s++) {
		let valid = true;
		for (let i = 2; i < n - 1 && valid; i++) if (surviving(ring[s].p, ring[(s + i) % n].p)) valid = false;
		if (!valid) continue;
		let minArea = Infinity;
		for (let i = 1; i < n - 1; i++) {
			const a = ring[s].p;
			const area = length(cross(sub(ring[(s + i) % n].p, a), sub(ring[(s + i + 1) % n].p, a)));
			minArea = Math.min(minArea, area);
		}
		const preferred = true; // the edge bevel passes no preferNot set
		const better =
			minArea > bestArea * (1 + 1e-9) + 1e-12 ||
			(Math.abs(minArea - bestArea) <= bestArea * 1e-9 + 1e-12 && preferred && !bestPreferred);
		if (best < 0 || better) {
			best = s;
			bestArea = minArea;
			bestPreferred = preferred;
		}
	}
	if (best >= 0 && bestArea > 1e-12) return fanLoopP(rb, ring, material, best);
	let hp = /** @type {Vec} */ ([0, 0, 0]);
	const huv = [0, 0];
	for (const c of ring) {
		hp = add(hp, c.p);
		huv[0] += c.uv[0] / n;
		huv[1] += c.uv[1] / n;
	}
	const hub = { p: scale(hp, 1 / n), uv: huv };
	for (let i = 0; i < n; i++) fanLoopP(rb, [hub, ring[i], ring[(i + 1) % n]], material, 0);
}

/** fanLoop over position corners @param {Rebuild} rb @param {PointCorner[]} ring @param {number} material
 * @param {number} startAt */
function fanLoopP(rb, ring, material, startAt) {
	const n = ring.length;
	if (n < 3) return;
	const at = (/** @type {number} */ i) => ring[(startAt + i) % n];
	for (let i = 1; i < n - 1; i++) {
		const a = at(0);
		const b = at(i);
		const c = at(i + 1);
		rb.tri([rb.vertex(a.p), rb.vertex(b.p), rb.vertex(c.p)], [a.uv, b.uv, c.uv], material);
	}
}

/** fanPolygon over position corners @param {Rebuild} rb @param {PointCorner[]} ring @param {number[]} normal
 * @param {number} material @param {number} startAt */
function fanPolygonP(rb, ring, normal, material, startAt) {
	const n = ring.length;
	if (n < 3) return;
	const at = (/** @type {number} */ i) => ring[(startAt + i) % n];
	for (let i = 1; i < n - 1; i++) {
		const a = at(0);
		const b = at(i);
		const c = at(i + 1);
		const [va, vb, vc] = [rb.vertex(a.p), rb.vertex(b.p), rb.vertex(c.p)];
		if (dot(triNormal(a.p, b.p, c.p), normal) < 0) rb.tri([va, vc, vb], [a.uv, c.uv, b.uv], material);
		else rb.tri([va, vb, vc], [a.uv, b.uv, c.uv], material);
	}
}

/** pushQuad over positions @param {Rebuild} rb @param {Vec[]} q @param {number[]} want @param {number} material
 * @param {number[][]} uvs */
function pushQuadP(rb, q, want, material, uvs) {
	const [a, b, c, d] = q.map((p) => rb.vertex(p));
	if (dot(triNormal(q[0], q[1], q[2]), want) < 0) {
		rb.tri([a, c, b], [uvs[0], uvs[2], uvs[1]], material);
		rb.tri([a, d, c], [uvs[0], uvs[3], uvs[2]], material);
	} else {
		rb.tri([a, b, c], [uvs[0], uvs[1], uvs[2]], material);
		rb.tri([a, c, d], [uvs[0], uvs[2], uvs[3]], material);
	}
}

/**
 * EDGE BEVEL of one edge (faceEdit `bevelOneEdge`, its rules verbatim: QUESTIONS 9). The two coplanar regions
 * on the edge fold a strip into their interiors; a valence-3 end slides the strip's side point along the side
 * region's other edge there and hands the third region the whole side chain; an end with two or more other
 * regions is MITERED (bevelled like a vertex, capped). Returns 'valence' when an end runs straight on into a
 * flat region, null when it cannot be done (border edge, region with a hole, ...).
 * @param {OpMesh} om @param {number} va @param {number} vb the edge's vertices
 * @param {number} width @param {number} segments @param {number} profile @returns {true | 'valence' | null}
 */
function bevelEdgeK(om, va, vb, width, segments, profile) {
	const step = readStep(om);
	const faces = regionsOf(step, [...step.trisAt(va), ...step.trisAt(vb)]);
	/** @type {Map<import('./rebuild.js').Region, number[] | null>} */
	const loops = new Map();
	const loopOf = (/** @type {import('./rebuild.js').Region} */ face) => {
		if (!loops.has(face)) loops.set(face, boundaryLoop(step, face.tris));
		return /** @type {number[] | null} */ (loops.get(face));
	};
	/** @type {{ face: import('./rebuild.js').Region, loop: number[], a: Vec, b: Vec }[]} */
	const sides = [];
	for (const face of faces) {
		const loop = loopOf(face);
		if (!loop) continue;
		const ia = loop.indexOf(va);
		const ib = loop.indexOf(vb);
		if (ia < 0 || ib < 0) continue;
		if (Math.abs(ia - ib) === 1 || Math.abs(ia - ib) === loop.length - 1) sides.push({ face, loop, a: [0, 0, 0], b: [0, 0, 0] });
	}
	if (sides.length !== 2) return null;
	const pa = pos(om, va);
	const pb = pos(om, vb);
	let along = sub(pb, pa);
	if (dot(along, along) < 1e-12) return null;
	const w = clampedBevelWidth(width, length(along));
	along = normalize(along);
	for (const side of sides) {
		let inward = sub(side.face.centroid, pa);
		inward = sub(inward, scale(along, dot(inward, along)));
		if (dot(inward, inward) < 1e-12) return null;
		inward = scale(normalize(inward), w);
		side.a = add(pa, inward);
		side.b = add(pb, inward);
	}
	const touches = (/** @type {import('./rebuild.js').Region} */ face, /** @type {number} */ v) =>
		face.tris.some((t) => step.verts[t * 3] === v || step.verts[t * 3 + 1] === v || step.verts[t * 3 + 2] === v);
	const others = (/** @type {number} */ v) => faces.filter((face) => !sides.some((s) => s.face === face) && touches(face, v));
	const otherAtA = others(va);
	const otherAtB = others(vb);
	if (!otherAtA.length || !otherAtB.length) return 'valence';
	// valence-3 ends: the side point slides along the side region's other edge there
	for (const side of sides)
		for (const [end, far, endOthers, pick] of /** @type {const} */ ([
			[va, vb, otherAtA, 'a'],
			[vb, va, otherAtB, 'b']
		])) {
			if (endOthers.length !== 1) continue;
			const n = side.loop.length;
			const i = side.loop.indexOf(end);
			const prev = side.loop[(i - 1 + n) % n];
			const j = prev === far ? (i + 1) % n : (i - 1 + n) % n;
			const endPos = pos(om, side.loop[i]);
			let span = sub(pos(om, side.loop[j]), endPos);
			const len = length(span);
			if (len < 1e-9) continue;
			span = scale(span, 1 / len);
			const sin = length(cross(along, span));
			if (sin < 1e-3) continue;
			side[pick] = add(endPos, scale(span, Math.min(w / sin, len * 0.45)));
		}
	let outward = add(sides[0].face.normal, sides[1].face.normal);
	if (dot(outward, outward) < 1e-12) return null;
	outward = normalize(outward);
	/** @type {{ a: Vec, b: Vec }[]} */
	const rings = [];
	for (let k = 0; k <= segments; k++) {
		const t = k / segments;
		const bulge = Math.sin(Math.PI * t) * profile * width;
		rings.push({ a: add(lerp(sides[0].a, sides[1].a, t), scale(outward, bulge)), b: add(lerp(sides[0].b, sides[1].b, t), scale(outward, bulge)) });
	}
	const key = keyOfPos;

	/** THE MITERED CORNER (faceEdit `miterPlan`) @param {number} vk @param {number} wk
	 * @param {import('./rebuild.js').Region[]} otherFaces @param {boolean} atA */
	const miterPlan = (vk, wk, otherFaces, atA) => {
		const V = pos(om, vk);
		/** @type {Map<number, Vec>} far vertex -> the edge's offset point */
		const offsetOn = new Map();
		const plan = [];
		for (const face of [...sides.map((s) => s.face), ...otherFaces]) {
			const loop = loopOf(face);
			if (!loop) return null;
			const i = loop.indexOf(vk);
			if (i < 0) return null;
			const n = loop.length;
			const corners = cornerUvs(step, face.tris);
			const vUv = corners.get(vk) ?? [0, 0];
			const side = sides.find((s) => s.face === face);
			/** @param {number} j @returns {PointCorner | null} */
			const replacement = (j) => {
				const x = loop[j];
				if (x === wk) return side ? { p: atA ? side.a : side.b, uv: vUv } : null;
				const span = sub(pos(om, x), V);
				const len = length(span);
				if (len < 1e-9) return null;
				const ww = clampedBevelWidth(width, len);
				let q = offsetOn.get(x);
				if (!q) offsetOn.set(x, (q = add(V, scale(normalize(span), ww))));
				return { p: q, uv: uvLerp(vUv, corners.get(x) ?? vUv, ww / len) };
			};
			const before = replacement((i - 1 + n) % n);
			const after = replacement((i + 1) % n);
			if (!before || !after) return null;
			plan.push({ face, loop, i, before, after, corners });
		}
		/** @type {Map<string, Vec>} */
		const next = new Map();
		/** @type {Set<string>} */
		const incoming = new Set();
		for (const entry of plan) {
			const from = key(entry.after.p);
			const to = key(entry.before.p);
			if (next.has(from)) return null;
			next.set(from, entry.before.p);
			incoming.add(to);
		}
		const startKey = [...next.keys()].find((k) => !incoming.has(k));
		if (!startKey) return null;
		const chainKey = (/** @type {number} */ k) => key(atA ? rings[k].a : rings[k].b);
		/** @type {Vec[]} */
		const path = [];
		let at = startKey;
		let guard = 0;
		/** @type {Vec | undefined} */
		let atPos = plan.find((e) => key(e.after.p) === startKey)?.after.p;
		while (atPos && guard++ <= plan.length) {
			path.push(atPos);
			const to = next.get(at);
			if (!to) break;
			atPos = to;
			at = key(to);
		}
		if (path.length !== plan.length + 1) return null;
		const first = key(path[0]);
		const last = key(path[path.length - 1]);
		/** @type {number[]} */
		let chain;
		if (last === chainKey(segments) && first === chainKey(0)) {
			chain = [];
			for (let k = segments - 1; k >= 1; k--) chain.push(k);
		} else if (last === chainKey(0) && first === chainKey(segments)) {
			chain = [];
			for (let k = 1; k <= segments - 1; k++) chain.push(k);
		} else return null;
		const capRing = [...path, ...chain.map((k) => (atA ? rings[k].a : rings[k].b))];
		return { plan, capRing };
	};
	const miterA = otherAtA.length >= 2 ? miterPlan(va, vb, otherAtA, true) : null;
	const miterB = otherAtB.length >= 2 ? miterPlan(vb, va, otherAtB, false) : null;
	if ((otherAtA.length >= 2 && !miterA) || (otherAtB.length >= 2 && !miterB)) return null;
	// the valence-3 ends' third regions, read before anything changes (a null here refuses the edge)
	const endpoints = [...(miterA ? [] : [{ v: va, face: otherAtA[0] }]), ...(miterB ? [] : [{ v: vb, face: otherAtB[0] }])].map((e) => ({
		...e,
		loop: loopOf(e.face)
	}));
	for (const e of endpoints) if (!e.loop || e.loop.indexOf(e.v) < 0) return null;

	/** @type {Set<number>} */
	const replacedSet = new Set();
	for (const face of [...sides.map((s) => s.face), ...otherAtA, ...otherAtB]) for (const t of face.tris) replacedSet.add(t);
	const replaced = [...replacedSet];
	const rb = rebuilder(om, new Set([va, vb]));
	// a spoke may not duplicate an edge of a triangle that survives (key cells: the op weld)
	/** @type {Map<string, number> | null} */
	let cellVertex = null;
	/** @param {Vec} p */
	const liveVertexAt = (p) => {
		if (!cellVertex) {
			cellVertex = new Map();
			const m = om.mesh;
			for (let v = 0; v < m.vTop; v++) {
				if (!m.hasVertex(v)) continue;
				const k = keyOfPos(pos(om, v));
				if (!cellVertex.has(k)) cellVertex.set(k, v);
			}
		}
		return cellVertex.get(keyOfPos(p));
	};
	/** @param {Vec} a @param {Vec} b */
	const surviving = (a, b) => {
		const x = liveVertexAt(a);
		const y = liveVertexAt(b);
		// a vertex made after the step was read has no surviving side (and would alias sideKey)
		if (x === undefined || y === undefined || x === y || x >= step.S || y >= step.S) return false;
		const list = step.sides.get(step.sideKey(x, y));
		return !!list && list.some((t) => !replacedSet.has(t));
	};
	const miterPair = (/** @type {any} */ miter, /** @type {any} */ face) => miter?.plan.find((/** @type {any} */ e) => e.face === face) ?? null;
	for (const side of sides) {
		const corners = cornerUvs(step, side.face.tris);
		const material = materialOf(om, side.face.tris[0]);
		const pairA = miterPair(miterA, side.face);
		const pairB = miterPair(miterB, side.face);
		/** @type {PointCorner[]} */
		const ring = side.loop.flatMap((point) => {
			const uv = corners.get(point) ?? [0, 0];
			const pair = point === va ? pairA : point === vb ? pairB : null;
			if (pair) return [{ p: pair.before.p, uv: pair.before.uv }, { p: pair.after.p, uv: pair.after.uv }];
			if (point === va) return [{ p: side.a, uv }];
			if (point === vb) return [{ p: side.b, uv }];
			return [{ p: pos(om, point), uv }];
		});
		if (pairA || pairB) fanBest(rb, ring, material, surviving);
		else fanPolygonP(rb, ring, side.face.normal, material, 0);
	}
	const stripMaterial = materialOf(om, sides[0].face.tris[0]);
	for (let k = 0; k < segments; k++)
		pushQuadP(rb, [rings[k].a, rings[k].b, rings[k + 1].b, rings[k + 1].a], outward, stripMaterial, [
			[k / segments, 0],
			[k / segments, 1],
			[(k + 1) / segments, 1],
			[(k + 1) / segments, 0]
		]);
	for (const miter of [miterA, miterB]) {
		if (!miter) continue;
		for (const entry of miter.plan) {
			if (sides.some((s) => s.face === entry.face)) continue;
			const n = entry.loop.length;
			/** @type {PointCorner[]} */
			const ring = [];
			for (let k = 0; k < n; k++) {
				if (k === entry.i) {
					ring.push({ p: entry.before.p, uv: entry.before.uv });
					ring.push({ p: entry.after.p, uv: entry.after.uv });
				} else ring.push({ p: pos(om, entry.loop[k]), uv: entry.corners.get(entry.loop[k]) ?? [0, 0] });
			}
			fanBest(rb, ring, materialOf(om, entry.face.tris[0]), surviving);
		}
		const capUv = miter.plan[0].before.uv;
		fanBest(rb, miter.capRing.map((p) => ({ p, uv: capUv })), stripMaterial, surviving);
	}
	for (const { v, face, loop } of endpoints) {
		const lp = /** @type {number[]} */ (loop);
		const corners = cornerUvs(step, face.tris);
		const index = lp.indexOf(v);
		const count = lp.length;
		const previous = lp[(index - 1 + count) % count];
		const previousSide = sides.find((s) => s.loop.includes(previous) && s.loop.includes(v)) ?? sides[0];
		const forward = previousSide === sides[0];
		const material = materialOf(om, face.tris[0]);
		const uv = corners.get(v) ?? [0, 0];
		const sidePoint = (/** @type {number} */ k) => (v === va ? rings[k].a : rings[k].b);
		/** @type {PointCorner[]} */
		const ring = [];
		for (let i = 1; i < count; i++) {
			const point = lp[(index + i) % count];
			ring.push({ p: pos(om, point), uv: corners.get(point) ?? [0, 0] });
		}
		ring.unshift({ p: sidePoint(forward ? segments : 0), uv });
		for (let k = 0; k <= segments; k++) {
			const at = forward ? k : segments - k;
			if (at === (forward ? segments : 0)) continue;
			ring.push({ p: sidePoint(at), uv });
		}
		fanLoopP(rb, ring, material, 1);
	}
	rb.finish(replaced);
	return true;
}

/**
 * EDGE BEVEL of every selected edge in turn (faceEdit `bevelEdgesCore`), each against the CURRENT mesh.
 * `edgeKeys` are welded key pairs ('ka|kb'). The output partition is DERIVED by the commit (the soup's rule).
 * @param {OpMesh} om @param {string[]} edgeKeys
 * @param {{ width?: number, segments?: number, profile?: number }} [options]
 * @returns {{ done: number, refusedValence: number, refusedBorder: number }}
 */
export function bevelEdges(om, edgeKeys, options = {}) {
	const width = options.width ?? 0.1;
	const segments = options.segments ?? 1;
	const profile = options.profile ?? 0;
	let done = 0;
	let refusedValence = 0;
	let refusedBorder = 0;
	for (const edge of edgeKeys) {
		const [ka, kb] = edge.split('|');
		const byKey = verticesByKey(om, [ka, kb]);
		const va = byKey.get(ka);
		const vb = byKey.get(kb);
		const result = va === undefined || vb === undefined ? null : bevelEdgeK(om, va, vb, width, segments, profile);
		if (result === 'valence') refusedValence++;
		else if (!result) refusedBorder++;
		else done++;
	}
	return { done, refusedValence, refusedBorder };
}
