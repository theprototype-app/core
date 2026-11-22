// @ts-check
// Roadmap 99 K4 family 2: the REBUILD operators' machinery on the op mesh — the vertex and edge bevels
// cut corners off coplanar REGIONS and re-fan them (QUESTIONS 9: the soup's regions, not the stored faces,
// so the output is the soup's). Everything reads the op mesh's output view: a triangle index here is the
// soup's index, a vertex is a key cell (the op weld IS faceEdit's keyOf), and a rebuild drops the region's
// triangles from the view and appends the new faces in emission order — the soup's "untouched, then new".
import { isolateTriangles, cornerOf, newGroup, appendToView } from './opMesh.js';

/** @typedef {import('./opMesh.js').OpMesh} OpMesh */
/** @typedef {[number, number, number]} Vec */

/** faceEdit's FACE_COPLANAR: two triangles on one region when |n1 . n2| exceeds it */
export const COPLANAR = 0.999;

/** @param {number[]} a @param {number[]} b @returns {Vec} */
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {number[]} a @param {number[]} b @returns {Vec} */
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** @param {number[]} a @param {number} s @returns {Vec} */
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
/** @param {number[]} a @param {number[]} b */
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {number[]} a @param {number[]} b @returns {Vec} */
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {number[]} a */
export const length = (a) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
/** THREE's normalize: a zero vector stays zero @param {number[]} a @returns {Vec} */
export const normalize = (a) => {
	const l = length(a) || 1;
	return [a[0] / l, a[1] / l, a[2] / l];
};
/** THREE's lerp @param {number[]} a @param {number[]} b @param {number} t @returns {Vec} */
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** @param {number[]} a @param {number[]} b @param {number} t @returns {[number, number]} */
export const uvLerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
/** @param {number[]} a @param {number[]} b @param {number[]} c @returns {Vec} */
export const triNormal = (a, b, c) => normalize(cross(sub(b, a), sub(c, a)));
/** faceEdit's axisLeastAlignedWith @param {number[]} n @returns {Vec} */
export function axisLeastAlignedWith(n) {
	const ax = Math.abs(n[0]);
	const ay = Math.abs(n[1]);
	const az = Math.abs(n[2]);
	if (ax <= ay && ax <= az) return [1, 0, 0];
	if (ay <= az) return [0, 1, 0];
	return [0, 0, 1];
}

/** @param {OpMesh} om @param {number} v @returns {Vec} */
export function pos(om, v) {
	const p = om.mesh.vPos;
	return [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
}

/**
 * One rebuild STEP's read of the op mesh (rebuilt after every step: the soup re-reads its triangles).
 * `verts` = 3 vertex IDs per output triangle, `sides` = unordered vertex pair -> the triangles with that
 * side in ascending order (the soup's edgeMap), `normal(t)` = the triangle normal, THREE semantics.
 * @param {OpMesh} om
 */
export function readStep(om) {
	const { mesh, view } = om;
	const n = view.count;
	const verts = new Int32Array(n * 3);
	const S = mesh.vTop + 1;
	/** @type {Map<number, number[]>} */
	const sides = new Map();
	for (let t = 0; t < n; t++) {
		const first = mesh.fFirst[view.tFace[t]];
		for (let k = 0; k < 3; k++) verts[t * 3 + k] = mesh.cVert[first + view.tLoc[t * 3 + k]];
		for (let e = 0; e < 3; e++) {
			const a = verts[t * 3 + e];
			const b = verts[t * 3 + ((e + 1) % 3)];
			const key = a < b ? a * S + b : b * S + a;
			let list = sides.get(key);
			if (!list) sides.set(key, (list = []));
			list.push(t);
		}
	}
	const normals = new Float64Array(n * 3).fill(NaN);
	/** @param {number} t @returns {Vec} */
	const normal = (t) => {
		if (Number.isNaN(normals[t * 3])) {
			const m = triNormal(pos(om, verts[t * 3]), pos(om, verts[t * 3 + 1]), pos(om, verts[t * 3 + 2]));
			normals.set(m, t * 3);
		}
		return [normals[t * 3], normals[t * 3 + 1], normals[t * 3 + 2]];
	};
	/** the triangles with vertex v (ascending) @param {number} v */
	const trisAt = (v) => {
		/** @type {Set<number>} */
		const faces = new Set();
		for (const c of mesh.vertexCorners(v)) faces.add(mesh.cFace[c]);
		/** @type {number[]} */
		const out = [];
		// the faces' view triangles: a face's triangles are found through its corners' sides
		for (let t = 0; t < n; t++) {
			if (!faces.has(view.tFace[t])) continue;
			if (verts[t * 3] === v || verts[t * 3 + 1] === v || verts[t * 3 + 2] === v) out.push(t);
		}
		return out;
	};
	/** @param {number} a @param {number} b */
	const sideKey = (a, b) => (a < b ? a * S + b : b * S + a);
	return { om, n, verts, sides, normal, trisAt, sideKey, S };
}

/** @typedef {ReturnType<typeof readStep>} Step */
/** @typedef {{ tris: number[], normal: Vec, centroid: Vec }} Region */

/**
 * The coplanar REGIONS (faceEdit `groupFaces`) holding any of `seeds`, ordered by their lowest triangle:
 * the components of the soup's union — every side's lowest triangle joined to each other triangle on that
 * side whose normal is within COPLANAR of it. The region normal is its lowest triangle's, the centroid
 * the mean of every triangle corner.
 * @param {Step} step @param {number[]} seeds @returns {Region[]}
 */
export function regionsOf(step, seeds) {
	const { verts, sides, normal, sideKey } = step;
	/** @type {Map<number, number>} */
	const regionOf = new Map();
	/** @type {number[][]} */
	const regions = [];
	/** @param {number} a @param {number} b */
	const coplanar = (a, b) => Math.abs(dot(normal(a), normal(b))) > COPLANAR;
	for (const seed of seeds) {
		if (regionOf.has(seed)) continue;
		const id = regions.length;
		/** @type {number[]} */
		const members = [seed];
		regionOf.set(seed, id);
		for (let i = 0; i < members.length; i++) {
			const t = members[i];
			for (let e = 0; e < 3; e++) {
				const list = /** @type {number[]} */ (sides.get(sideKey(verts[t * 3 + e], verts[t * 3 + ((e + 1) % 3)])));
				const head = list[0];
				/** @type {number[]} */
				const next = [];
				if (t === head) {
					for (let j = 1; j < list.length; j++) if (coplanar(head, list[j])) next.push(list[j]);
				} else if (coplanar(head, t)) next.push(head);
				for (const u of next)
					if (!regionOf.has(u)) {
						regionOf.set(u, id);
						members.push(u);
					}
			}
		}
		regions.push(members.sort((a, b) => a - b));
	}
	regions.sort((a, b) => a[0] - b[0]);
	return regions.map((tris) => {
		const c = [0, 0, 0];
		let count = 0;
		for (const t of tris)
			for (let k = 0; k < 3; k++) {
				const p = pos(step.om, verts[t * 3 + k]);
				c[0] += p[0];
				c[1] += p[1];
				c[2] += p[2];
				count++;
			}
		const d = count || 1;
		return { tris, normal: normal(tris[0]), centroid: /** @type {Vec} */ ([c[0] / d, c[1] / d, c[2] / d]) };
	});
}

/**
 * The region's ordered boundary LOOP (faceEdit `boundaryLoop`): its sides walked by exactly one region
 * triangle, followed start -> next start; null unless they form ONE closed loop.
 * @param {Step} step @param {number[]} tris @returns {number[] | null} vertex IDs
 */
export function boundaryLoop(step, tris) {
	const { verts, sideKey } = step;
	/** @type {Map<number, number>} */
	const count = new Map();
	for (const t of tris)
		for (let e = 0; e < 3; e++) {
			const k = sideKey(verts[t * 3 + e], verts[t * 3 + ((e + 1) % 3)]);
			count.set(k, (count.get(k) ?? 0) + 1);
		}
	/** @type {number[][]} */
	const dir = [];
	for (const t of tris)
		for (let e = 0; e < 3; e++) {
			const a = verts[t * 3 + e];
			const b = verts[t * 3 + ((e + 1) % 3)];
			if (count.get(sideKey(a, b)) === 1) dir.push([a, b]);
		}
	if (dir.length < 3) return null;
	/** @type {Map<number, number[]>} */
	const byStart = new Map();
	for (const e of dir) byStart.set(e[0], e);
	const start = dir[0][0];
	/** @type {number[]} */
	const loop = [];
	/** @type {number[] | undefined} */
	let edge = dir[0];
	do {
		loop.push(edge[0]);
		edge = byStart.get(edge[1]);
		if (!edge) return null;
	} while (edge[0] !== start && loop.length <= dir.length);
	return loop.length === dir.length ? loop : null;
}

/** vertex -> the uv of its FIRST corner over the region's triangles (faceEdit `cornerData`)
 * @param {Step} step @param {number[]} tris @returns {Map<number, [number, number]>} */
export function cornerUvs(step, tris) {
	const uv = step.om.mesh.attrs.uv;
	/** @type {Map<number, [number, number]>} */
	const out = new Map();
	for (const t of tris)
		for (let k = 0; k < 3; k++) {
			const v = step.verts[t * 3 + k];
			if (out.has(v)) continue;
			if (!uv) out.set(v, [0, 0]);
			else {
				const c = cornerOf(step.om, t, k);
				out.set(v, [uv.data[c * 2], uv.data[c * 2 + 1]]);
			}
		}
	return out;
}

/** the material slot of output triangle t @param {OpMesh} om @param {number} t */
export const materialOf = (om, t) => om.mesh.fMat[om.view.tFace[t]];

/**
 * Key cell -> its first live vertex (the rebuilder's reuse map), `gone` left out.
 * @param {OpMesh} om @param {Set<number>} [gone] @returns {Map<string, number>}
 */
export function cellMap(om, gone = new Set()) {
	const m = om.mesh;
	/** @type {Map<string, number>} */
	const cells = new Map();
	for (let v = 0; v < m.vTop; v++) {
		if (!m.hasVertex(v) || gone.has(v)) continue;
		const k = keyOfPos(pos(om, v));
		if (!cells.has(k)) cells.set(k, v);
	}
	return cells;
}

/**
 * A rebuild in progress: vertices by position (key cell), new TRIANGLES in emission order (each its own kernel
 * face, wound exactly as the soup pushed it), committed by `finish` — drop the replaced triangles from
 * the view, append the new ones.
 * @param {OpMesh} om @param {Set<number>} [gone] vertices the rebuild removes (never reused by `vertex`)
 * @param {Map<string, number> | null} [base] `cellMap` of an op mesh this one is an UNCHANGED copy of (the
 * adjust engine's per-scrub clone): read under this rebuild's own cells instead of re-keying every vertex
 */
export function rebuilder(om, gone = /** @type {Set<number>} */ (new Set()), base = null) {
	const m = om.mesh;
	const hasUv = !!m.attrs.uv;
	/** @type {{ v: number[], uv: number[][], material: number, triangles: number[], join?: boolean }[]} */
	const tris = [];
	/** @type {Map<string, number> | null} key cell -> vertex (live ones, built on first use, then the new ones) */
	let cells = null;
	return {
		/**
		 * The vertex for a point: the one already in its key cell (an existing vertex, or one this rebuild
		 * made), else a new one there — the op weld's rule, so the op mesh is what a fresh weld of the
		 * output would give (the soup's next operator sees one point per key). `gone` = vertices the rebuild
		 * removes, never reused. @param {number[]} p
		 */
		vertex(p) {
			if (!cells) cells = base ? new Map() : cellMap(om, gone);
			const k = keyOfPos(p);
			let v = cells.get(k);
			if (v === undefined && base) {
				const b = base.get(k);
				if (b !== undefined && !gone.has(b)) v = b;
			}
			if (v === undefined) cells.set(k, (v = m.addVertex(p[0], p[1], p[2])));
			return v;
		},
		/** @param {number[]} v 3 vertex IDs @param {number[][]} uv 3 uvs @param {number} material */
		tri(v, uv, material) {
			tris.push({ v, uv, material, triangles: [0, 1, 2] });
		},
		/**
		 * 99 K4 family 3: a whole new face (a loop cut's sub-quad), triangulated as given
		 * @param {number[]} v vertex IDs @param {number[][]} uv one uv per vertex @param {number} material
		 * @param {number[]} triangles local corner triples
		 */
		face(v, uv, material, triangles) {
			tris.push({ v, uv, material, triangles });
		},
		/**
		 * A triangle that belongs to the PREVIOUS queued item's face (one stored face held by several kernel
		 * faces: a fan around a new hub point, which is no polygon loop of its own)
		 * @param {number[]} v @param {number[][]} uv @param {number} material
		 */
		joinTri(v, uv, material) {
			tris.push({ v, uv, material, triangles: [0, 1, 2], join: true });
		},
		get count() {
			return tris.length;
		},
		/**
		 * @param {number[]} replaced output triangles the rebuild consumes @param {number[]} [orphans] vertices
		 * to drop once nothing uses them @returns {number[]} the new faces, in output order
		 */
		finish(replaced, orphans = [...gone]) {
			const drop = isolateTriangles(om, replaced);
			const keep = [];
			const { view } = om;
			for (let t = 0; t < view.count; t++) if (!drop.has(view.tFace[t])) keep.push(t);
			const tFace = new Int32Array(keep.length);
			const tLoc = new Int32Array(keep.length * 3);
			keep.forEach((t, i) => {
				tFace[i] = view.tFace[t];
				tLoc.set(view.tLoc.subarray(t * 3, t * 3 + 3), i * 3);
			});
			om.view = { tFace, tLoc, count: keep.length };
			for (const f of drop) m.removeFace(f);
			for (const v of orphans) if (m.hasVertex(v) && !m.vertexCorners(v).length) m.removeVertex(v);
			/** @type {number[]} */
			const added = [];
			for (const t of tris) {
				/** @type {Record<string, number[]>} */
				const attrs = {};
				if (hasUv) attrs.uv = t.uv.flatMap((q) => [q[0], q[1]]);
				const f = m.addFace(t.v, { material: t.material, attrs, triangles: t.triangles });
				if (t.join && added.length) om.logical[f] = om.logical[added[added.length - 1]];
				else newGroup(om, f);
				added.push(f);
			}
			appendToView(om, added);
			return added;
		}
	};
}

/** @typedef {ReturnType<typeof rebuilder>} Rebuild */
/** @typedef {{ v: number, uv: number[] }} RingCorner */

/**
 * faceEdit `fanPolygon`: fan the ring from `startAt`, each triangle flipped when its own normal opposes
 * `normal`. @param {Rebuild} rb @param {OpMesh} om @param {RingCorner[]} ring @param {number[]} normal
 * @param {number} material @param {number} [startAt]
 */
export function fanPolygon(rb, om, ring, normal, material, startAt = 0) {
	const n = ring.length;
	if (n < 3) return;
	const at = (/** @type {number} */ i) => ring[(startAt + i) % n];
	for (let i = 1; i < n - 1; i++) {
		const a = at(0);
		const b = at(i);
		const c = at(i + 1);
		if (dot(triNormal(pos(om, a.v), pos(om, b.v), pos(om, c.v)), normal) < 0) rb.tri([a.v, c.v, b.v], [a.uv, c.uv, b.uv], material);
		else rb.tri([a.v, b.v, c.v], [a.uv, b.uv, c.uv], material);
	}
}

/** faceEdit `fanLoop`: fan in ring order, no normal test @param {Rebuild} rb @param {RingCorner[]} ring
 * @param {number} material @param {number} [startAt] */
export function fanLoop(rb, ring, material, startAt = 0) {
	const n = ring.length;
	if (n < 3) return;
	const at = (/** @type {number} */ i) => ring[(startAt + i) % n];
	for (let i = 1; i < n - 1; i++) {
		const a = at(0);
		const b = at(i);
		const c = at(i + 1);
		rb.tri([a.v, b.v, c.v], [a.uv, b.uv, c.uv], material);
	}
}

/**
 * faceEdit `pushQuad` as two triangles: a-b-c / a-c-d, or a-c-b / a-d-c when the first opposes `want`.
 * @param {Rebuild} rb @param {OpMesh} om @param {number[]} q 4 vertex IDs @param {number[]} want
 * @param {number} material @param {number[][]} uvs 4 uvs
 */
export function pushQuad(rb, om, q, want, material, uvs) {
	const [a, b, c, d] = q;
	if (dot(triNormal(pos(om, a), pos(om, b), pos(om, c)), want) < 0) {
		rb.tri([a, c, b], [uvs[0], uvs[2], uvs[1]], material);
		rb.tri([a, d, c], [uvs[0], uvs[3], uvs[2]], material);
	} else {
		rb.tri([a, b, c], [uvs[0], uvs[1], uvs[2]], material);
		rb.tri([a, c, d], [uvs[0], uvs[2], uvs[3]], material);
	}
}

/**
 * faceEdit `pushQuad` as ONE quad face (an authored sub-quad): a-b-c / a-c-d, or the soup's flipped pair
 * a-c-b / a-d-c (= the quad a-d-c-b's [0,2,3] [0,1,2]). The flip test reads `at`, the soup's own (unwelded)
 * corner points, so the winding is decided exactly as the soup decided it.
 * @param {Rebuild} rb @param {number[]} q 4 vertex IDs @param {number[][]} at their 4 points @param {number[]} want
 * @param {number} material @param {number[][] | null} uvs 4 uvs, or null (untextured)
 */
export function pushQuadFace(rb, q, at, want, material, uvs) {
	const [a, b, c, d] = q;
	const flip = dot(triNormal(at[0], at[1], at[2]), want) < 0;
	const uv = uvs ?? [[0, 0], [0, 0], [0, 0], [0, 0]];
	if (flip) rb.face([a, d, c, b], [uv[0], uv[3], uv[2], uv[1]], material, [0, 2, 3, 0, 1, 2]);
	else rb.face([a, b, c, d], uv, material, [0, 1, 2, 0, 2, 3]);
}

/** the op weld's key of a position (faceEdit keyOf) @param {number[]} p */
export const keyOfPos = (p) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;

/** keyOf string -> the live vertex in that cell (the op weld puts one there) @param {OpMesh} om
 * @param {string[]} keys @returns {Map<string, number>} */
export function verticesByKey(om, keys) {
	const want = new Set(keys);
	const m = om.mesh;
	/** @type {Map<string, number>} */
	const out = new Map();
	for (let v = 0; v < m.vTop; v++) {
		if (!m.hasVertex(v)) continue;
		const k = keyOfPos(pos(om, v));
		if (want.has(k) && !out.has(k)) out.set(k, v);
	}
	return out;
}
