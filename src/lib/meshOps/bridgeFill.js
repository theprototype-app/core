// @ts-check
// Roadmap 99 K4 family 4: BRIDGE / FILL HOLE / SOLIDIFY on the kernel (lane 99-ops-b).
//
// Each one is the soup operator's recipe run on the op mesh: the same loops, pairing, fan and normals,
// computed from the same corner positions in the same order (THREE semantics: a zero vector normalizes
// to zero), so the output triangles, their order, their diagonals and the stored partition are the
// soup's. What changes is what the result IS: the bridge's walls and the solidify rim are kernel quads
// over the loops' own vertices (an intermediate ring is one shared vertex per loop point), a convex
// hole's cap is ONE n-gon, the back of a solidified face is the face reversed (same triangulation,
// mirrored), and every untouched face keeps its ID.
//
// Pure (no three.js, no stores): node tests, a Worker and the page run the same code.

import { isolateTriangles, appendToView, newGroup, cornerOf, NONE } from './opMesh.js';
import { sub, add, scale, dot, cross, normalize, lerp, triNormal, pos, keyOfPos } from './rebuild.js';

export { keyOfPos };

/** @typedef {import('./opMesh.js').OpMesh} OpMesh @typedef {[number, number, number]} Vec */

// the vector maths and the op-weld key are ops-a's (meshOps/rebuild.js, family 2): one copy for every operator
/** @param {ArrayLike<number>} a */
const lengthSq = (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];

/** vertex IDs of output triangle t @param {OpMesh} om @param {number} t @returns {number[]} */
function triVerts(om, t) {
	const m = om.mesh;
	return [m.cVert[cornerOf(om, t, 0)], m.cVert[cornerOf(om, t, 1)], m.cVert[cornerOf(om, t, 2)]];
}

/** the uv of output triangle t's corner k ([0, 0] untextured: the soup's uvAt) @param {OpMesh} om
 * @param {number} t @param {number} k @returns {[number, number]} */
function triUv(om, t, k) {
	const uv = om.mesh.attrs.uv;
	if (!uv) return [0, 0];
	const c = cornerOf(om, t, k);
	return [uv.data[c * 2], uv.data[c * 2 + 1]];
}

/** an unordered vertex pair as one number — stable while an operator adds vertices (the multiplier is the
 * kernel's vertex limit, 2^26, not the live vTop) @param {OpMesh} _om @param {number} a @param {number} b */
function pairKey(_om, a, b) {
	return a < b ? a * 67108864 + b : b * 67108864 + a;
}

/**
 * The directed sides of `tris` walked by exactly one of them (faceEdit `boundaryEdges`: sides counted
 * by vertex pair, diagonals included), in triangle order, corner order.
 * @param {OpMesh} om @param {number[]} tris
 * @returns {{ t: number, a: number, b: number, ka: number, kb: number }[]} a -> b as the triangle winds it
 */
function borderSides(om, tris) {
	/** @type {Map<number, number>} */
	const count = new Map();
	/** @type {{ t: number, a: number, b: number, ka: number, kb: number, key: number }[]} */
	const dir = [];
	for (const t of tris) {
		const v = triVerts(om, t);
		for (let e = 0; e < 3; e++) {
			const a = v[e];
			const b = v[(e + 1) % 3];
			const key = pairKey(om, a, b);
			count.set(key, (count.get(key) ?? 0) + 1);
			dir.push({ t, a, b, ka: e, kb: (e + 1) % 3, key });
		}
	}
	return dir.filter((d) => count.get(d.key) === 1);
}

/**
 * faceEdit `boundaryLoop`: the border sides followed start -> next start (a later side leaving the same
 * vertex replaces an earlier one, the soup's Map), null unless they are ONE closed loop.
 * @param {OpMesh} om @param {number[]} tris @returns {number[] | null} vertex IDs in loop order
 */
export function boundaryLoopOf(om, tris) {
	const dir = borderSides(om, tris);
	if (dir.length < 3) return null;
	/** @type {Map<number, { a: number, b: number }>} */
	const byStart = new Map();
	for (const d of dir) byStart.set(d.a, d);
	const start = dir[0].a;
	/** @type {number[]} */
	const loop = [];
	/** @type {{ a: number, b: number } | undefined} */
	let side = dir[0];
	do {
		loop.push(side.a);
		side = byStart.get(side.b);
		if (!side) return null;
	} while (side.a !== start && loop.length <= dir.length);
	return loop.length === dir.length ? loop : null;
}

/**
 * Remove the faces of `tris` (partly covered faces are split first, so the rest of them stays with
 * its stored face) and the vertices nothing uses any more (but `keep`); the view drops their triangles.
 * @param {OpMesh} om @param {number[]} tris @param {Set<number>} [keepVerts] vertices to keep even when unused
 */
function removeTriangles(om, tris, keepVerts) {
	const m = om.mesh;
	const drop = isolateTriangles(om, tris);
	const { view } = om;
	/** @type {number[]} */
	const keep = [];
	for (let t = 0; t < view.count; t++) if (!drop.has(view.tFace[t])) keep.push(t);
	const tFace = new Int32Array(keep.length);
	const tLoc = new Int32Array(keep.length * 3);
	keep.forEach((t, i) => {
		tFace[i] = view.tFace[t];
		tLoc.set(view.tLoc.subarray(t * 3, t * 3 + 3), i * 3);
	});
	om.view = { tFace, tLoc, count: keep.length };
	/** @type {Set<number>} */
	const verts = new Set();
	for (const f of drop) {
		for (const v of m.faceVertices(f)) verts.add(v);
		m.removeFace(f);
	}
	for (const v of verts) if (!keepVerts?.has(v) && m.hasVertex(v) && !m.vertexCorners(v).length) m.removeVertex(v);
}

/**
 * The soup's pushQuad as one kernel face: corners a, b, c, d (positions `p`, the soup's own points, for
 * the flip test) wound so the first triangle faces `want`; triangulated a-b-c / a-c-d, or a-c-b / a-d-c
 * flipped, uvs following the corners. A new logical group (an authored quad).
 * @param {OpMesh} om @param {number[]} q 4 vertex IDs @param {number[][]} p their 4 positions
 * @param {number[]} want @param {number} material @param {number[][] | null} uvs
 */
function addQuad(om, q, p, want, material, uvs) {
	const m = om.mesh;
	const [a, b, c, d] = q;
	const flip = dot(triNormal(p[0], p[1], p[2]), want) < 0;
	// flipped: the soup's triangles [a,c,b] [a,d,c] are the quad a-d-c-b's [0,2,3] [0,1,2]
	const verts = flip ? [a, d, c, b] : [a, b, c, d];
	const triangles = flip ? [0, 2, 3, 0, 1, 2] : [0, 1, 2, 0, 2, 3];
	const order = flip ? [0, 3, 2, 1] : [0, 1, 2, 3];
	/** @type {Record<string, number[]>} */
	const attrs = {};
	if (m.attrs.uv) attrs.uv = order.flatMap((i) => (uvs ? uvs[i] : [0, 0]));
	const f = m.addFace(verts, { material, attrs, triangles });
	newGroup(om, f);
	return f;
}

// ---- BRIDGE -------------------------------------------------------------------------------------------

/**
 * Are output triangles s and t on one SHELL (faceEdit `shellsOfTris`: welded-vertex connectivity over
 * every triangle)? A walk over vertex -> faces from s's vertices. @param {OpMesh} om @param {number} s
 * @param {number} t
 */
function sameShell(om, s, t) {
	const m = om.mesh;
	const goal = new Set(triVerts(om, t));
	/** @type {Set<number>} */
	const seen = new Set(triVerts(om, s));
	const stack = [...seen];
	for (const v of seen) if (goal.has(v)) return true;
	/** @type {Set<number>} */
	const faces = new Set();
	while (stack.length) {
		const v = /** @type {number} */ (stack.pop());
		for (const c of m.vertexCorners(v)) {
			const f = m.cFace[c];
			if (faces.has(f)) continue;
			faces.add(f);
			for (const w of m.faceVertices(f)) {
				if (seen.has(w)) continue;
				if (goal.has(w)) return true;
				seen.add(w);
				stack.push(w);
			}
		}
	}
	return false;
}

/**
 * faceEdit `bridgeFacesCore` on the op mesh: both pieces' faces go and a tunnel of quads joins their
 * boundary loops — `cuts` intermediate rings (shared vertices), the loops paired by ANGLE about their
 * centres in one basis perpendicular to the tunnel axis (`twist` rotates the pairing), every wall wound
 * outward from the axis (inward for a hole through one shell; `invert` flips the guess), the first
 * piece's material, a strip uv when textured. Refusals are the soup's toast texts.
 * @param {OpMesh} om @param {number[]} setA @param {number[]} setB output triangles of the two pieces
 * @param {{ cuts?: number, twist?: number, invert?: boolean }} [options]
 * @returns {{ ok: true, walls: number } | { error: string }}
 */
export function bridgeRegions(om, setA, setB, options = {}) {
	const m = om.mesh;
	const cuts = options.cuts ?? 0;
	const twist = Math.round(options.twist ?? 0) || 0;
	const invert = !!options.invert;
	const loopA = boundaryLoopOf(om, setA);
	const loopB = boundaryLoopOf(om, setB);
	if (!loopA || !loopB) return { error: 'Bridge pieces need one closed boundary each' };
	if (loopA.length !== loopB.length)
		return { error: 'Bridge needs matching edge counts (' + loopA.length + ' vs ' + loopB.length + ')' };
	const shell = sameShell(om, setA[0], setB[0]);
	const material = m.fMat[om.view.tFace[setA[0]]];
	const textured = !!m.attrs.uv;
	const n = loopA.length;
	const PA = loopA.map((v) => pos(om, v));
	const PB = loopB.map((v) => pos(om, v));
	/** @param {Vec[]} P */
	const centre = (P) => {
		let c = /** @type {Vec} */ ([0, 0, 0]);
		for (const p of P) c = add(c, p);
		return scale(c, 1 / n);
	};
	const centA = centre(PA);
	const centB = centre(PB);
	const axis = sub(centB, centA);
	const axisN = lengthSq(axis) > 1e-9 ? normalize(axis) : /** @type {Vec} */ ([0, 1, 0]);
	let uAxis = /** @type {Vec} */ (Math.abs(axisN[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0]);
	uAxis = add(uAxis, scale(axisN, -dot(uAxis, axisN)));
	if (lengthSq(uAxis) < 1e-9) uAxis = [0, 0, 1];
	uAxis = normalize(uAxis);
	const vAxis = normalize(cross(axisN, uAxis));
	/** @param {Vec[]} P @param {Vec} c */
	const byAngle = (P, c) =>
		P.map((p, i) => {
			const d = sub(p, c);
			return { i, a: Math.atan2(dot(d, vAxis), dot(d, uAxis)) };
		})
			.sort((x, y) => x.a - y.a || x.i - y.i)
			.map((x) => x.i);
	const orderA = byAngle(PA, centA);
	const orderB = byAngle(PB, centB);
	const tw = ((twist % n) + n) % n;
	const segs = Math.max(1, Math.round(cuts) + 1);
	// both caps go first (the soup filters them out, then appends the walls)
	// (a loose piece's loop vertices stay: the walls stand on them)
	removeTriangles(om, [...setA, ...setB], new Set([...loopA, ...loopB]));
	// ring r (0 = loop A, segs = loop B) vertex for wall column k: the loops' own vertices at the ends,
	// one shared new vertex per column on every intermediate ring
	/** @type {number[][]} */
	const ring = [];
	for (let s = 0; s <= segs; s++) {
		/** @type {number[]} */
		const row = [];
		for (let k = 0; k < n; k++) {
			if (s === 0) row.push(loopA[orderA[k]]);
			else if (s === segs) row.push(loopB[orderB[(k + tw) % n]]);
			else {
				const p = lerp(PA[orderA[k]], PB[orderB[(k + tw) % n]], s / segs);
				row.push(m.addVertex(p[0], p[1], p[2]));
			}
		}
		ring.push(row);
	}
	/** @type {number[]} */
	const added = [];
	const axisSq = lengthSq(axis);
	for (let s = 0; s < segs; s++) {
		const t0 = s / segs;
		const t1 = (s + 1) / segs;
		for (let k = 0; k < n; k++) {
			const a0 = PA[orderA[k]];
			const a1 = PA[orderA[(k + 1) % n]];
			const b0 = PB[orderB[(k + tw) % n]];
			const b1 = PB[orderB[(k + 1 + tw) % n]];
			const p00 = lerp(a0, b0, t0);
			const p10 = lerp(a1, b1, t0);
			const p11 = lerp(a1, b1, t1);
			const p01 = lerp(a0, b0, t1);
			const mid = scale(add(add(add(p00, p10), p11), p01), 0.25);
			/** @type {Vec} */
			let want;
			if (axisSq > 1e-9) {
				const t = Math.min(Math.max(dot(sub(mid, centA), axis) / axisSq, 0), 1);
				want = sub(mid, add(centA, scale(axis, t)));
			} else want = sub(mid, centA);
			if (lengthSq(want) < 1e-9) want = [0, 1, 0];
			if (shell) want = scale(want, -1);
			if (invert) want = scale(want, -1);
			const q = [ring[s][k], ring[s][(k + 1) % n], ring[s + 1][(k + 1) % n], ring[s + 1][k]];
			const uvs = textured
				? [
						[k / n, t0],
						[(k + 1) / n, t0],
						[(k + 1) / n, t1],
						[k / n, t1]
					]
				: null;
			added.push(addQuad(om, q, [p00, p10, p11, p01], normalize(want), material, uvs));
		}
	}
	appendToView(om, added);
	return { ok: true, walls: added.length };
}

// ---- FILL HOLE ----------------------------------------------------------------------------------------

/**
 * faceEdit `fillHoleCore` on the op mesh. The picked BORDER edges (vertex pairs; ONE picked edge = its
 * whole border loop) must close one simple loop; the cap takes every border side the other way round
 * (the manifold rule). A convex planar loop is fanned from its best corner (faceEdit `fanBest`) as ONE
 * n-gon; anything else, or a ring with no valid start, is fanned from a centre vertex (one logical face).
 * @param {OpMesh} om @param {[number, number][]} edges picked edges as vertex-ID pairs
 * @returns {{ ok: true, loop: number[], loopKeys: string[], centroid: boolean, cap: number[] } | { error: string }}
 *   `loop` = the cap's ring (vertex IDs, cap winding; `loopKeys` their position keys), `cap` = the new faces
 */
export function fillHole(om, edges) {
	const m = om.mesh;
	const { view } = om;
	// every triangle side by vertex pair (the soup's `uses`, diagonals included), first use kept
	/** @type {Map<number, { t: number, e: number, n: number }>} */
	const uses = new Map();
	/** @type {number[]} border pair keys in the order their side was first met */
	const sideOrder = [];
	for (let t = 0; t < view.count; t++) {
		const v = triVerts(om, t);
		for (let e = 0; e < 3; e++) {
			const key = pairKey(om, v[e], v[(e + 1) % 3]);
			const use = uses.get(key);
			if (use) use.n++;
			else {
				uses.set(key, { t, e, n: 1 });
				sideOrder.push(key);
			}
		}
	}
	/** @type {number[]} */
	let picked = [...new Set(edges.map(([a, b]) => pairKey(om, a, b)))];
	if (!picked.length) return { error: 'Pick the border edges of the hole first' };
	if (picked.some((k) => uses.get(k)?.n !== 1))
		return {
			error:
				'Fill needs BORDER edges — a picked edge has faces on both sides (or none). Pick the rim of a hole.'
		};
	/** the border side as its one triangle winds it @param {number} k */
	const directed = (k) => {
		const { t, e } = /** @type {{ t: number, e: number }} */ (uses.get(k));
		const v = triVerts(om, t);
		return {
			from: v[e],
			to: v[(e + 1) % 3],
			uvA: triUv(om, t, e),
			uvB: triUv(om, t, (e + 1) % 3),
			material: m.fMat[view.tFace[t]]
		};
	};
	const notLoop = 'That border edge does not close a loop — pick the whole rim';
	if (picked.length === 1) {
		/** @type {Map<number, number>} border from -> its pair key (a later side replaces an earlier one) */
		const byFrom = new Map();
		for (const k of sideOrder) if (/** @type {any} */ (uses.get(k)).n === 1) byFrom.set(directed(k).from, k);
		const loop = [picked[0]];
		let at = directed(picked[0]).to;
		const start = directed(picked[0]).from;
		while (at !== start && loop.length <= byFrom.size) {
			const k = byFrom.get(at);
			if (k === undefined) return { error: notLoop };
			loop.push(k);
			at = directed(k).to;
		}
		if (at !== start) return { error: notLoop };
		picked = loop;
	}
	/** @type {Map<number, number>} the cap walks each border side backwards: capNext(to) = from */
	const capNext = new Map();
	/** @type {Map<number, number[]>} vertex -> its uv (first seen) */
	const corner = new Map();
	let material = 0;
	for (const k of picked) {
		const d = directed(k);
		if (capNext.has(d.to)) return { error: 'The picked edges branch at a vertex — they must form ONE simple loop' };
		capNext.set(d.to, d.from);
		if (!corner.has(d.from)) corner.set(d.from, d.uvA);
		if (!corner.has(d.to)) corner.set(d.to, d.uvB);
		material = d.material;
	}
	const startV = /** @type {number} */ (capNext.keys().next().value);
	/** @type {number[]} */
	const loop = [];
	/** @type {number | undefined} */
	let at = startV;
	do {
		loop.push(/** @type {number} */ (at));
		at = capNext.get(/** @type {number} */ (at));
		if (at === undefined) return { error: 'The picked edges do not close — they must form ONE loop' };
	} while (at !== startV && loop.length <= picked.length);
	if (at !== startV || loop.length !== picked.length)
		return {
			error: 'The picked edges are not ONE closed loop (' + picked.length + ' edges, ' + loop.length + ' in the first loop)'
		};
	if (loop.length < 3) return { error: 'A hole needs at least three edges' };
	const n = loop.length;
	const P = loop.map((v) => pos(om, v));
	const UV = loop.map((v) => /** @type {number[]} */ (corner.get(v)));
	// Newell normal of the cap ring, in cap winding
	let normal = /** @type {Vec} */ ([0, 0, 0]);
	for (let i = 0; i < n; i++) {
		const p = P[i];
		const q = P[(i + 1) % n];
		normal = [
			normal[0] + (p[1] - q[1]) * (p[2] + q[2]),
			normal[1] + (p[2] - q[2]) * (p[0] + q[0]),
			normal[2] + (p[0] - q[0]) * (p[1] + q[1])
		];
	}
	let centre = /** @type {Vec} */ ([0, 0, 0]);
	for (const p of P) centre = add(centre, p);
	centre = scale(centre, 1 / n);
	let convex = lengthSq(normal) > 1e-16;
	if (convex) {
		normal = normalize(normal);
		let size = 0;
		for (const p of P) size = Math.max(size, Math.sqrt(lengthSq(sub(p, centre))));
		for (let i = 0; i < n && convex; i++) {
			const p = P[(i - 1 + n) % n];
			const q = P[i];
			const r = P[(i + 1) % n];
			if (dot(cross(sub(q, p), sub(r, q)), normal) <= 1e-12) convex = false;
			if (Math.abs(dot(sub(q, centre), normal)) > size * 1e-3) convex = false;
		}
	}
	const hasUv = !!m.attrs.uv;
	/** @type {number[]} */
	const cap = [];
	const group = om.nextGroup++;
	/** a cap face over ring corners, one group @param {number[]} verts @param {number[][]} uvs
	 * @param {number[]} triangles */
	const capFace = (verts, uvs, triangles) => {
		/** @type {Record<string, number[]>} */
		const attrs = {};
		if (hasUv) attrs.uv = uvs.flatMap((q) => [q[0], q[1]]);
		const f = m.addFace(verts, { material, attrs, triangles });
		om.logical[f] = group;
		cap.push(f);
	};
	/** fan from a hub vertex: one triangle face per ring side, all one logical face
	 * @param {number[]} hubPos @param {number[]} hubUv */
	const hubFan = (hubPos, hubUv) => {
		const hub = m.addVertex(hubPos[0], hubPos[1], hubPos[2]);
		for (let i = 0; i < n; i++)
			capFace([hub, loop[i], loop[(i + 1) % n]], [hubUv, UV[i], UV[(i + 1) % n]], [0, 1, 2]);
	};
	if (convex) {
		const best = bestFanStart(om, loop, P);
		if (best >= 0) {
			/** @type {number[]} */
			const triangles = [];
			for (let i = 1; i < n - 1; i++) triangles.push(best, (best + i) % n, (best + i + 1) % n);
			capFace(loop, UV, triangles);
		} else {
			// fanBest's fallback: its hub uv is summed in n-ths
			const uv = [0, 0];
			for (const q of UV) {
				uv[0] += q[0] / n;
				uv[1] += q[1] / n;
			}
			hubFan(centre, uv);
		}
	} else {
		let u = 0;
		let v = 0;
		for (const q of UV) {
			u += q[0];
			v += q[1];
		}
		hubFan(centre, [u / n, v / n]);
	}
	appendToView(om, cap);
	return { ok: true, loop, loopKeys: P.map(keyOfPos), centroid: !convex, cap };
}

/**
 * faceEdit `fanBest`'s choice of start: no spoke may duplicate an existing side (every triangle side of
 * the mesh, diagonals included), the start whose smallest triangle is largest wins (ties to the lower
 * index: nothing is preferred-against here); -1 when no start is valid or the best one is degenerate.
 * @param {OpMesh} om @param {number[]} loop @param {Vec[]} P
 */
function bestFanStart(om, loop, P) {
	const n = loop.length;
	// the sides a spoke could duplicate: only pairs of ring vertices matter
	const onRing = new Set(loop);
	/** @type {Set<number>} */
	const avoid = new Set();
	const { view } = om;
	for (let t = 0; t < view.count; t++) {
		const v = triVerts(om, t);
		for (let e = 0; e < 3; e++) {
			const a = v[e];
			const b = v[(e + 1) % 3];
			if (onRing.has(a) && onRing.has(b)) avoid.add(pairKey(om, a, b));
		}
	}
	let best = -1;
	let bestArea = -1;
	for (let s = 0; s < n; s++) {
		let valid = true;
		for (let i = 2; i < n - 1 && valid; i++) if (avoid.has(pairKey(om, loop[s], loop[(s + i) % n]))) valid = false;
		if (!valid) continue;
		let minArea = Infinity;
		for (let i = 1; i < n - 1; i++) {
			const a = P[s];
			const b = P[(s + i) % n];
			const c = P[(s + i + 1) % n];
			minArea = Math.min(minArea, Math.sqrt(lengthSq(cross(sub(b, a), sub(c, a)))));
		}
		const better = minArea > bestArea * (1 + 1e-9) + 1e-12;
		if (best < 0 || better) {
			best = s;
			bestArea = minArea;
		}
	}
	return best >= 0 && bestArea > 1e-12 ? best : -1;
}

// ---- SOLIDIFY -----------------------------------------------------------------------------------------

/**
 * faceEdit `solidifyCore` on the op mesh: the selected surface gains a back — each selected face
 * reversed over vertices offset by `thickness` along the area-weighted vertex normal (positive = into the
 * surface), its triangulation mirrored — and a rim quad on every border side, wound to meet both. The
 * back faces follow their sources' stored faces (one group per source group, in stored order), the rim
 * quads come after; a closed selection gets no rim (a hollow shell). Refused when the border is shared
 * with unselected faces (the rim would make those edges carry three faces).
 * @param {OpMesh} om @param {number[]} triIndices output triangles
 * @param {{ thickness?: number }} [options]
 * @returns {{ ok: true, back: Map<number, number>, rim: number, rimFrom: number } | { error: string }}
 *   back = source triangle -> its back copy's output index
 */
export function solidifyRegion(om, triIndices, options = {}) {
	const m = om.mesh;
	let thickness = options.thickness ?? 0.1;
	if (Math.abs(thickness) < 1e-4) thickness = thickness < 0 ? -1e-4 : 1e-4;
	const sel = [...new Set(triIndices)].filter((t) => t >= 0 && t < om.view.count).sort((a, b) => a - b);
	if (!sel.length) return { error: 'Select a face first, then Solidify' };
	const border = borderSides(om, sel);
	const faces = isolateTriangles(om, sel);
	for (const d of border) {
		const e = m.findEdge(d.a, d.b);
		if (e === NONE) continue;
		for (const f of m.edgeFaces(e))
			if (!faces.has(f))
				return {
					error:
						'Solidify thickens an OPEN surface — this selection’s border is shared with faces you did not pick. Select the whole piece (Shell), or delete a face to open the mesh first.'
				};
	}
	// area-weighted vertex normals over the selection (un-normalised cross = 2x area along the normal)
	/** @type {Map<number, Vec>} */
	const normalAt = new Map();
	const vertsOf = sel.map((t) => triVerts(om, t));
	sel.forEach((t, i) => {
		const v = vertsOf[i];
		const p = v.map((x) => pos(om, x));
		const nrm = cross(sub(p[1], p[0]), sub(p[2], p[0]));
		for (const x of v) normalAt.set(x, add(normalAt.get(x) ?? [0, 0, 0], nrm));
	});
	for (const [v, sum] of normalAt) normalAt.set(v, normalize(lengthSq(sum) < 1e-20 ? [0, 1, 0] : sum));
	/** @type {Map<number, number>} vertex -> its back vertex (created in the soup's first-use order) */
	const back = new Map();
	/** @param {number} v */
	const backOf = (v) => {
		let b = back.get(v);
		if (b === undefined) {
			const p = add(pos(om, v), scale(/** @type {Vec} */ (normalAt.get(v)), -thickness));
			back.set(v, (b = m.addVertex(p[0], p[1], p[2])));
		}
		return b;
	};
	for (const v of vertsOf) {
		backOf(v[0]);
		backOf(v[2]);
		backOf(v[1]);
	}
	// one back group per source group, in stored order (solidifyFaces' authored list), then the rim's
	/** @type {Map<number, number>} */
	const backGroup = new Map();
	const sourceGroups = [...new Set(sel.map((t) => om.logical[om.view.tFace[t]]))].sort((a, b) => a - b);
	for (const g of sourceGroups) backGroup.set(g, om.nextGroup++);
	// each selected face reversed: corner j of the back face = source corner (n - j) % n, so the soup's
	// back triangle [b0, b2, b1] is local (s(l0), s(l2), s(l1)); its order key keeps the selection's order
	const rank = new Map(sel.map((t, i) => [t, i]));
	/** @type {Map<number, number[]>} face -> its selected output triangles */
	const trisOf = new Map();
	for (const t of sel) {
		const f = om.view.tFace[t];
		let list = trisOf.get(f);
		if (!list) trisOf.set(f, (list = []));
		list.push(t);
	}
	const base = m.nextOrder;
	/** @type {{ f: number, orders: number[] }[]} */
	const added = [];
	for (const [f, list] of trisOf) {
		const srcVerts = m.faceVertices(f);
		const n = srcVerts.length;
		const s = (/** @type {number} */ l) => (n - l) % n;
		const verts = srcVerts.map((_, j) => backOf(srcVerts[s(j)]));
		/** @type {Record<string, number[]>} */
		const attrs = {};
		for (const [name, attr] of Object.entries(m.attrs)) {
			const first = m.fFirst[f];
			/** @type {number[]} */
			const data = [];
			for (let j = 0; j < n; j++)
				for (let k = 0; k < attr.size; k++) data.push(attr.data[(first + s(j)) * attr.size + k]);
			attrs[name] = data;
		}
		/** @type {number[]} */
		const triangles = [];
		/** @type {number[]} */
		const orders = [];
		for (const t of list) {
			const l = [om.view.tLoc[t * 3], om.view.tLoc[t * 3 + 1], om.view.tLoc[t * 3 + 2]];
			triangles.push(s(l[0]), s(l[2]), s(l[1]));
			orders.push(base + /** @type {number} */ (rank.get(t)));
		}
		const g = m.addFace(verts, { material: m.fMat[f], attrs, triangles, orders });
		om.logical[g] = /** @type {number} */ (backGroup.get(om.logical[f]));
		added.push({ f: g, orders });
	}
	const rimFrom = om.view.count + sel.length;
	/** @type {number[]} */
	const rim = [];
	for (const d of border) {
		const p0 = d.a;
		const p1 = d.b;
		const q0 = /** @type {number} */ (back.get(p0));
		const q1 = /** @type {number} */ (back.get(p1));
		const uv0 = triUv(om, d.t, d.ka);
		const uv1 = triUv(om, d.t, d.kb);
		// p1 -> p0 (the owner has p0 -> p1), p0 -> q0, q0 -> q1 (the back copy has q1 -> q0), q1 -> p1
		/** @type {Record<string, number[]>} */
		const attrs = {};
		if (m.attrs.uv) attrs.uv = [...uv1, ...uv0, ...uv0, ...uv1];
		const f = m.addFace([p1, p0, q0, q1], { material: m.fMat[om.view.tFace[d.t]], attrs, triangles: [0, 1, 2, 0, 2, 3] });
		newGroup(om, f);
		rim.push(f);
	}
	appendToView(om, [...added.map((a) => a.f), ...rim]);
	/** @type {Map<number, number>} */
	const backTri = new Map();
	sel.forEach((t, i) => backTri.set(t, om.view.count - rim.length * 2 - sel.length + i));
	return { ok: true, back: backTri, rim: border.length, rimFrom };
}

/**
 * The editor's edge picks (welded key pairs `"x,y,z|x,y,z"`, faceEdit edgeKey) as vertex-ID pairs on the op
 * mesh (the op weld puts one vertex in each key cell); a key with no vertex gives -1.
 * @param {OpMesh} om @param {string[]} edgeKeys @returns {[number, number][]}
 */
export function edgesOfKeys(om, edgeKeys) {
	const want = new Set();
	for (const k of edgeKeys) for (const part of k.split('|')) want.add(part);
	const m = om.mesh;
	/** @type {Map<string, number>} */
	const byKey = new Map();
	for (let v = 0; v < m.vTop; v++) {
		if (!m.hasVertex(v)) continue;
		const k = keyOfPos(pos(om, v));
		if (want.has(k) && !byKey.has(k)) byKey.set(k, v);
	}
	/** @type {[number, number][]} */
	const out = [];
	for (const k of edgeKeys) {
		const [a, b] = k.split('|');
		// a key with no vertex stays in as a pair no side has (the operator refuses it as the soup did)
		out.push([byKey.get(a) ?? -1, byKey.get(b) ?? -1]);
	}
	return out;
}

// the vector and op-mesh helpers family 5 (dissolve.js) shares; they move onto ops-a's rebuild.js once both are on one branch
export { lengthSq, triVerts, triUv, pairKey, removeTriangles };
