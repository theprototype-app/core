// @ts-check
// Roadmap 99 K4 family 3: the KNIFE on the op mesh (faceEdit `knifeCutCore`, 37 R11). The soup builds the cut
// up: every polyline point that lands on the mesh is INSERTED as a vertex first (onto the welded edge it sits on,
// or inside the triangle), then each segment is a straight cut on the previous result. Unlike the other cuts the
// knife splits a triangle IN PLACE: its pieces take its slot in the output order, so a step here rebuilds the
// view with the pieces where their triangle was and renumbers the order keys to the view (toArrays then emits
// exactly the soup's order). Edges are vertex pairs: the op weld makes a vertex one key cell, which is what the
// soup's welded edge key is. New points reuse the vertex already in their key cell (the soup's key semantics).
// The partition is not authored: the commit derives it, as before (the op mesh is never kept).
import { isolateTriangles, cornerOf, newGroup } from './opMesh.js';
import { pos, keyOfPos } from './rebuild.js';

/** @typedef {import('./opMesh.js').OpMesh} OpMesh */
/** @typedef {{ px: number[], w: number }} Screen */
/** @typedef {{ v: number, pos: number[], uv: number[] | null }} Corner */
/** @typedef {{ pos: number[], uv: number[] | null }} Point */

// faceEdit's knife constants (pixels)
const KNIFE_SNAP_VERTEX = 6;
const KNIFE_SNAP_EDGE = 3;
const KNIFE_ON = 0.05;

/** faceEdit perspectiveParam @param {number} t @param {number} w0 @param {number} w1 */
function perspectiveParam(t, w0, w1) {
	const denominator = w1 + t * (w0 - w1);
	if (Math.abs(denominator) < 1e-12) return t;
	return (t * w0) / denominator;
}

/** faceEdit segmentCross @param {number[]} a @param {number[]} b @param {number[]} c @param {number[]} d */
function segmentCross(a, b, c, d) {
	const rx = b[0] - a[0];
	const ry = b[1] - a[1];
	const sx = d[0] - c[0];
	const sy = d[1] - c[1];
	const denominator = rx * sy - ry * sx;
	if (Math.abs(denominator) < 1e-9) return null;
	const onCut = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denominator;
	const onEdge = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denominator;
	if (onCut < 0 || onCut > 1) return null;
	if (onEdge < 1e-4 || onEdge > 1 - 1e-4) return null;
	return { onCut, onEdge };
}

/** faceEdit screenBary @param {number[]} p @param {number[]} a @param {number[]} b @param {number[]} c */
function screenBary(p, a, b, c) {
	const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
	if (Math.abs(area) < 1e-9) return null;
	const l1 = ((c[0] - b[0]) * (p[1] - b[1]) - (p[0] - b[0]) * (c[1] - b[1])) / area;
	const l2 = ((a[0] - c[0]) * (p[1] - c[1]) - (p[0] - c[0]) * (a[1] - c[1])) / area;
	return [l1, l2, 1 - l1 - l2];
}

/** faceEdit screenFoot @param {number[]} p @param {number[]} a @param {number[]} b */
function screenFoot(p, a, b) {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const length2 = dx * dx + dy * dy;
	const t = length2 > 1e-12 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2 : 0;
	const clamped = Math.min(Math.max(t, 0), 1);
	const x = a[0] + dx * clamped;
	const y = a[1] + dy * clamped;
	return { t, distance: Math.hypot(p[0] - x, p[1] - y), at: [x, y] };
}

/** THREE's Vector3.lerp @param {number[]} a @param {number[]} b @param {number} u */
const lerp3 = (a, b, u) => [
	a[0] + (b[0] - a[0]) * u,
	a[1] + (b[1] - a[1]) * u,
	a[2] + (b[2] - a[2]) * u
];

/** faceEdit barycentricOf (THREE vector maths, same order) @param {number[]} p @param {number[][]} tri */
function barycentricOf(p, tri) {
	const [a, b, c] = tri;
	const v0 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
	const v1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
	const v2 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
	const d = (/** @type {number[]} */ x, /** @type {number[]} */ y) =>
		x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
	const d00 = d(v0, v0);
	const d01 = d(v0, v1);
	const d11 = d(v1, v1);
	const d20 = d(v2, v0);
	const d21 = d(v2, v1);
	const denominator = d00 * d11 - d01 * d01;
	if (Math.abs(denominator) < 1e-12) return [1, 0, 0];
	const v = (d11 * d20 - d01 * d21) / denominator;
	const w = (d00 * d21 - d01 * d20) / denominator;
	return [1 - v - w, v, w];
}

/** faceEdit triNormal's direction (unnormalized: only its sign against another is read) @param {number[][]} t */
function triDir(t) {
	const ax = t[1][0] - t[0][0];
	const ay = t[1][1] - t[0][1];
	const az = t[1][2] - t[0][2];
	const bx = t[2][0] - t[0][0];
	const by = t[2][1] - t[0][1];
	const bz = t[2][2] - t[0][2];
	const n = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
	const l = Math.hypot(n[0], n[1], n[2]);
	return l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 0];
}

/**
 * The knife's working state over the op mesh: corners per view triangle, the screen cache by vertex, the
 * key-cell vertex map and the in-place replace.
 * @param {OpMesh} om @param {(p: number[]) => Screen} project
 */
function knifeState(om, project) {
	const m = om.mesh;
	const uvAttr = m.attrs.uv;
	/** @type {Map<number, Screen>} */
	const screen = new Map();
	/** @type {Map<string, number> | null} */
	let cells = null;
	return {
		/** @param {number} v @returns {Screen} */
		screenOf(v) {
			let hit = screen.get(v);
			if (!hit) screen.set(v, (hit = project(pos(om, v))));
			return hit;
		},
		/** @param {number} t @returns {Corner[]} */
		corners(t) {
			const first = m.fFirst[om.view.tFace[t]];
			/** @type {Corner[]} */
			const out = [];
			for (let k = 0; k < 3; k++) {
				const v = m.cVert[first + om.view.tLoc[t * 3 + k]];
				const c = cornerOf(om, t, k);
				out.push({
					v,
					pos: pos(om, v),
					uv: uvAttr ? [uvAttr.data[c * 2], uvAttr.data[c * 2 + 1]] : null
				});
			}
			return out;
		},
		/** @param {number} t */
		material(t) {
			return m.fMat[om.view.tFace[t]];
		},
		/** the vertex for a new point: the live one in its key cell, else a new one @param {number[]} p */
		vertex(p) {
			if (!cells) {
				cells = new Map();
				for (let v = 0; v < m.vTop; v++) {
					if (!m.hasVertex(v)) continue;
					const k = keyOfPos(pos(om, v));
					if (!cells.has(k)) cells.set(k, v);
				}
			}
			const k = keyOfPos(p);
			let v = cells.get(k);
			if (v === undefined) cells.set(k, (v = m.addVertex(p[0], p[1], p[2])));
			return v;
		},
		/**
		 * Replace view triangles IN PLACE: each listed triangle's slot takes its pieces, in order (each piece one
		 * kernel face); the order keys are renumbered to the new view.
		 * @param {Map<number, { v: number[], uv: (number[] | null)[], material: number }[]>} pieces
		 */
		replace(pieces) {
			const replaced = [...pieces.keys()];
			const drop = isolateTriangles(om, replaced);
			const { view } = om;
			/** @type {Map<number, number[]>} old triangle -> its new faces */
			const made = new Map();
			for (const [t, list] of pieces) {
				const faces = [];
				for (const p of list) {
					/** @type {Record<string, number[]>} */
					const attrs = {};
					if (uvAttr)
						attrs.uv = p.uv.flatMap((q) => [
							/** @type {number[]} */ (q)[0],
							/** @type {number[]} */ (q)[1]
						]);
					const f = m.addFace(p.v, { material: p.material, attrs, triangles: [0, 1, 2] });
					newGroup(om, f);
					faces.push(f);
				}
				made.set(t, faces);
			}
			for (const f of drop) m.removeFace(f);
			let count = view.count;
			for (const list of made.values()) count += list.length - 1;
			const tFace = new Int32Array(count);
			const tLoc = new Int32Array(count * 3);
			let at = 0;
			for (let t = 0; t < view.count; t++) {
				const list = made.get(t);
				if (list)
					for (const f of list) {
						tFace[at] = f;
						tLoc[at * 3] = 0;
						tLoc[at * 3 + 1] = 1;
						tLoc[at * 3 + 2] = 2;
						at++;
					}
				else {
					tFace[at] = view.tFace[t];
					tLoc.set(view.tLoc.subarray(t * 3, t * 3 + 3), at * 3);
					at++;
				}
			}
			om.view = { tFace, tLoc, count };
			// order keys = view index, so the output order is the soup's (pieces where their triangle was)
			for (let i = 0; i < count; i++) {
				const f = tFace[i];
				const first = m.fTriFirst[f];
				for (let r = first; r < first + m.fTriLen[f]; r++)
					if (
						m.tLocal[r * 3] === tLoc[i * 3] &&
						m.tLocal[r * 3 + 1] === tLoc[i * 3 + 1] &&
						m.tLocal[r * 3 + 2] === tLoc[i * 3 + 2]
					) {
						m.tOrder[r] = i;
						break;
					}
			}
			m.nextOrder = count;
		}
	};
}

/** @typedef {ReturnType<typeof knifeState>} KnifeState */

/** an edge key over vertex IDs @param {number} a @param {number} b */
const sideKey = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);

/** the uv of a point inside a triangle, barycentrically (null when untextured) @param {number[]} p @param {Corner[]} c */
function uvOf(p, c) {
	if (!c[0].uv) return null;
	const bary = barycentricOf(
		p,
		c.map((x) => x.pos)
	);
	const uv = /** @type {number[][]} */ (c.map((x) => x.uv));
	return [
		uv[0][0] * bary[0] + uv[1][0] * bary[1] + uv[2][0] * bary[2],
		uv[0][1] * bary[0] + uv[1][1] * bary[1] + uv[2][1] * bary[2]
	];
}

/** faceEdit snapKnifePoint @param {OpMesh} om @param {KnifeState} st @param {number[]} p @returns {number[]} */
function snapKnifePoint(om, st, p) {
	/** @type {Screen[] | null} */
	let front = null;
	let frontDepth = Infinity;
	for (let t = 0; t < om.view.count; t++) {
		const s = st.corners(t).map((c) => st.screenOf(c.v));
		const bary = screenBary(p, s[0].px, s[1].px, s[2].px);
		if (!bary) continue;
		let near = Math.min(...bary) >= 0;
		if (!near)
			for (let e = 0; e < 3 && !near; e++)
				near = screenFoot(p, s[e].px, s[(e + 1) % 3].px).distance < KNIFE_SNAP_EDGE;
		if (!near) continue;
		const inverse = bary.reduce((sum, l, i) => sum + Math.max(l, 0) / s[i].w, 0);
		const depth = inverse > 0 ? 1 / inverse : Infinity;
		if (depth < frontDepth) {
			frontDepth = depth;
			front = s;
		}
	}
	if (!front) return p;
	/** @type {number[] | null} */
	let best = null;
	let bestDistance = KNIFE_SNAP_VERTEX;
	for (const corner of front) {
		const distance = Math.hypot(p[0] - corner.px[0], p[1] - corner.px[1]);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = corner.px;
		}
	}
	if (best) return [best[0], best[1]];
	bestDistance = KNIFE_SNAP_EDGE;
	for (let e = 0; e < 3; e++) {
		const foot = screenFoot(p, front[e].px, front[(e + 1) % 3].px);
		if (foot.distance < bestDistance) {
			bestDistance = foot.distance;
			best = foot.at;
		}
	}
	return best ? [best[0], best[1]] : p;
}

/** faceEdit insertKnifeCorner: true when the point landed on the mesh @param {OpMesh} om @param {KnifeState} st
 * @param {number[]} p */
function insertKnifeCorner(om, st, p) {
	/** @type {Map<number, number[]>} edge -> the point on it */
	const onEdge = new Map();
	/** @type {Map<number, number[]>} triangle -> the point inside it */
	const inside = new Map();
	const n = om.view.count;
	/** @type {Corner[][]} */
	const all = new Array(n);
	for (let t = 0; t < n; t++) {
		const c = (all[t] = st.corners(t));
		const s = c.map((x) => st.screenOf(x.v));
		if (s.some((corner) => Math.hypot(p[0] - corner.px[0], p[1] - corner.px[1]) < KNIFE_ON))
			continue;
		let edgeHit = false;
		for (let e = 0; e < 3; e++) {
			const foot = screenFoot(p, s[e].px, s[(e + 1) % 3].px);
			if (foot.distance >= KNIFE_ON || foot.t <= 1e-4 || foot.t >= 1 - 1e-4) continue;
			edgeHit = true;
			const key = sideKey(c[e].v, c[(e + 1) % 3].v);
			if (onEdge.has(key)) continue;
			const u = perspectiveParam(foot.t, s[e].w, s[(e + 1) % 3].w);
			onEdge.set(key, lerp3(c[e].pos, c[(e + 1) % 3].pos, u));
		}
		if (edgeHit) continue;
		const bary = screenBary(p, s[0].px, s[1].px, s[2].px);
		if (!bary || Math.min(...bary) <= 0) continue;
		const weights = bary.map((l, i) => l / s[i].w);
		const total = weights[0] + weights[1] + weights[2];
		// THREE: clone().multiplyScalar(w0).addScaledVector(b, w1).addScaledVector(c, w2)
		const w0 = weights[0] / total;
		const w1 = weights[1] / total;
		const w2 = weights[2] / total;
		const a = c[0].pos;
		const b = c[1].pos;
		const cc = c[2].pos;
		inside.set(
			t,
			[0, 1, 2].map((i) => a[i] * w0 + b[i] * w1 + cc[i] * w2)
		);
	}
	if (!onEdge.size && !inside.size) return false;
	/** @type {Map<number, { v: number[], uv: (number[] | null)[], material: number }[]>} */
	const pieces = new Map();
	for (let t = 0; t < n; t++) {
		const c = all[t];
		/** @type {{ v: number, pos: number[], uv: number[] | null, added: boolean }[]} */
		const ring = [];
		for (let e = 0; e < 3; e++) {
			ring.push({ v: c[e].v, pos: c[e].pos, uv: c[e].uv, added: false });
			const mid = onEdge.get(sideKey(c[e].v, c[(e + 1) % 3].v));
			if (mid) ring.push({ v: -1, pos: mid, uv: uvOf(mid, c), added: true });
		}
		const centre = inside.get(t);
		if (ring.length === 3 && !centre) continue;
		const material = st.material(t);
		/** @type {{ v: number[], uv: (number[] | null)[], material: number }[]} */
		const list = [];
		if (centre) {
			const uv = uvOf(centre, c);
			const cv = st.vertex(centre);
			for (let e = 0; e < 3; e++) {
				const k = (e + 1) % 3;
				list.push({ v: [cv, c[e].v, c[k].v], uv: [uv, c[e].uv, c[k].uv], material });
			}
		} else {
			for (const r of ring) if (r.added) r.v = st.vertex(r.pos);
			const start = ring.findIndex((r) => r.added);
			const apex = ring[start];
			for (let i = 1; i < ring.length - 1; i++) {
				const b = ring[(start + i) % ring.length];
				const cc = ring[(start + i + 1) % ring.length];
				list.push({ v: [apex.v, b.v, cc.v], uv: [apex.uv, b.uv, cc.uv], material });
			}
		}
		pieces.set(t, list);
	}
	st.replace(pieces);
	return true;
}

/** faceEdit knifeSegment: the number of triangles cut, or -1 when the segment crossed no edge
 * @param {OpMesh} om @param {KnifeState} st @param {number[]} from @param {number[]} to */
function knifeSegment(om, st, from, to) {
	/** @type {Map<number, number[]>} edge -> the crossing point */
	const crossings = new Map();
	const n = om.view.count;
	/** @type {Corner[][]} */
	const all = new Array(n);
	for (let t = 0; t < n; t++) {
		const c = (all[t] = st.corners(t));
		for (let e = 0; e < 3; e++) {
			const key = sideKey(c[e].v, c[(e + 1) % 3].v);
			if (crossings.has(key)) continue;
			const a = st.screenOf(c[e].v);
			const b = st.screenOf(c[(e + 1) % 3].v);
			const hit = segmentCross(from, to, a.px, b.px);
			if (!hit) continue;
			const u = perspectiveParam(hit.onEdge, a.w, b.w);
			crossings.set(key, lerp3(c[e].pos, c[(e + 1) % 3].pos, u));
		}
	}
	if (!crossings.size) return -1;
	/** @type {Map<number, { v: number[], uv: (number[] | null)[], material: number }[]>} */
	const pieces = new Map();
	let cut = 0;
	for (let t = 0; t < n; t++) {
		const c = all[t];
		/** @type {{ e: number, point: number[] }[]} */
		const hits = [];
		for (let e = 0; e < 3; e++) {
			const point = crossings.get(sideKey(c[e].v, c[(e + 1) % 3].v));
			if (point) hits.push({ e, point });
		}
		if (hits.length !== 1 && hits.length !== 2) continue;
		const material = st.material(t);
		const faceNormal = triDir(c.map((x) => x.pos));
		/** @type {{ v: number[], uv: (number[] | null)[], material: number }[]} */
		const list = [];
		/** one piece wound like the original @param {Point[]} pts */
		const push = (pts) => {
			const d = triDir(pts.map((x) => x.pos));
			const flip = d[0] * faceNormal[0] + d[1] * faceNormal[1] + d[2] * faceNormal[2] < 0;
			const w = flip ? [pts[0], pts[2], pts[1]] : pts;
			list.push({ v: w.map((x) => /** @type {any} */ (x).v), uv: w.map((x) => x.uv), material });
		};
		/** @param {number[]} p */
		const at = (p) => ({ v: st.vertex(p), pos: p, uv: uvOf(p, c) });
		if (hits.length === 1) {
			const e = hits[0].e;
			const point = at(hits[0].point);
			const near = c[e];
			const far = c[(e + 1) % 3];
			const opposite = c[(e + 2) % 3];
			push([point, far, opposite]);
			push([point, opposite, near]);
		} else {
			const [first, second] = hits.sort((x, y) => x.e - y.e);
			const shared = first.e + 1 === second.e ? second.e : 0;
			const cornerIndex = shared % 3;
			const p = first.e === (cornerIndex + 2) % 3 ? first : second;
			const q = p === first ? second : first;
			const corner = c[cornerIndex];
			const other0 = c[(cornerIndex + 1) % 3];
			const other1 = c[(cornerIndex + 2) % 3];
			const P = at(p.point);
			const Q = at(q.point);
			push([P, corner, Q]);
			push([Q, other0, other1]);
			push([Q, other1, P]);
		}
		pieces.set(t, list);
		cut++;
	}
	st.replace(pieces);
	return cut;
}

/**
 * THE KNIFE (faceEdit `knifeCutCore`): cut the op mesh along a screen-space polyline. `project(p)` puts a LOCAL
 * point on screen with its view depth `w` (1 for an orthographic camera). Output with `order: 'appearance'`
 * is fine for positions; the commit derives the partition.
 * @param {OpMesh} om @param {number[][]} points the polyline in pixels, at least two
 * @param {(p: number[]) => Screen} project
 * @returns {{ cut: number, corners: number } | null} null = it touched nothing
 */
export function knifeCut(om, points, project) {
	const st = knifeState(om, project);
	let corners = 0;
	/** @type {number[][]} */
	const placed = [];
	for (const point of points) {
		const snapped = snapKnifePoint(om, st, point);
		placed.push(snapped);
		if (insertKnifeCorner(om, st, snapped)) corners++;
	}
	let cut = 0;
	for (let i = 0; i + 1 < placed.length; i++) {
		const a = placed[i];
		const b = placed[i + 1];
		if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) continue;
		const r = knifeSegment(om, st, a, b);
		if (r < 0) continue;
		cut += r;
	}
	if (!cut && !corners) return null;
	return { cut, corners };
}
