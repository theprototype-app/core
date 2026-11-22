// @ts-check
// Roadmap 99 K4 family 3: the CUT operators on the op mesh — loop cut (this file), knife and connect.
// A cut REPLACES triangles: the ones it crosses leave the view, the untouched ones keep their order and their
// faces, and the new pieces are appended in the soup's emission order (rebuild.js). New vertices come by key
// cell, so the cut points two neighbouring quads both compute are one vertex, as the soup's weld makes them.
import { cornerOf, opPartition } from './opMesh.js';
import {
	pos,
	rebuilder,
	keyOfPos,
	lerp,
	uvLerp,
	triNormal,
	pushQuadFace,
	readStep,
	boundaryLoop,
	cornerUvs,
	materialOf,
	sub,
	cross,
	length
} from './rebuild.js';

/** @typedef {import('./opMesh.js').OpMesh} OpMesh */

/** faceEdit `edgeKey` @param {string} a @param {string} b */
const edgeKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

/**
 * The view triangle's vertex IDs, keys, points and uvs.
 * @param {OpMesh} om @param {number} t
 */
function triCorners(om, t) {
	const m = om.mesh;
	const uv = m.attrs.uv;
	const first = m.fFirst[om.view.tFace[t]];
	const out = [];
	for (let k = 0; k < 3; k++) {
		const v = m.cVert[first + om.view.tLoc[t * 3 + k]];
		const p = pos(om, v);
		const c = cornerOf(om, t, k);
		out.push({ v, key: keyOfPos(p), pos: p, uv: uv ? [uv.data[c * 2], uv.data[c * 2 + 1]] : null });
	}
	return out;
}

/**
 * LOOP CUT (faceEdit `loopCutCore`): every quad of `ring` is split across the walk into cuts + 1 sub-quads,
 * positions and uvs interpolated, its material kept; each sub-quad is ONE authored face. The flanking quads
 * keep their full edge (the soup's T-junction). `ring` and `partner` index the op mesh's output triangles
 * (the soup's indices), the quad pairing being the editor's.
 * @param {OpMesh} om @param {{ quad: number, cross: string[] }[]} ring
 * @param {Int32Array | number[]} partner
 * @param {{ cuts?: number, position?: number, cells?: Map<string, number> | null }} [options] `cells` = the
 * `cellMap` of the op mesh this one is an unchanged copy of (the adjust engine's scrubs)
 * @returns {{ firstNew: number, consumed: number[] }} firstNew = the output index of the first new triangle
 */
export function loopCutRegion(om, ring, partner, options = {}) {
	const n = options.cuts ?? 1;
	// clamped short of 0/1: a cut AT the boundary would emit a zero-width band of degenerate quads
	const position = Math.min(Math.max(options.position ?? 0.5, 0.01), 0.99);
	const cutsAt = n === 1 ? [position] : Array.from({ length: n }, (_, i) => (i + 1) / (n + 1));
	const bounds = [0, ...cutsAt, 1];
	/** @type {Set<number>} */
	const consumed = new Set();
	for (const { quad } of ring) {
		consumed.add(quad);
		const mate = partner[quad] ?? -1;
		if (mate >= 0) consumed.add(mate);
	}
	const firstNew = om.view.count - consumed.size;
	const rb = rebuilder(om, new Set(), options.cells ?? null);
	/** @type {Set<number>} */
	const used = new Set();
	for (const { quad, cross } of ring) {
		const mate = partner[quad] ?? -1;
		if (quad < 0 || quad >= om.view.count || mate < 0 || mate >= om.view.count) continue;
		const ta = triCorners(om, quad);
		const tb = triCorners(om, mate);
		// faceEdit quadRingKeysIn: p, ra, q, rb (the shared side p-q is the diagonal)
		const ka = ta.map((c) => c.key);
		const kb = tb.map((c) => c.key);
		const shared = ka.filter((k) => kb.includes(k));
		if (shared.length !== 2) continue;
		const ra = ka.find((k) => !shared.includes(k));
		const rbk = kb.find((k) => !shared.includes(k));
		if (!ra || !rbk) continue;
		const keys = [shared[0], ra, shared[1], rbk];
		const edges = [0, 1, 2, 3].map((i) => edgeKey(keys[i], keys[(i + 1) % 4]));
		const at = edges.indexOf(cross[0]);
		if (at < 0) continue;
		// faceEdit quadCornersIn: the first corner seen per key gives its point and uv
		/** @type {Map<string, { pos: number[], uv: number[] | null }>} */
		const corner = new Map();
		for (const c of [...ta, ...tb])
			if (!corner.has(c.key)) corner.set(c.key, { pos: c.pos, uv: c.uv });
		const [A, B, C, D] = [0, 1, 2, 3].map((o) => corner.get(keys[(at + o) % 4]));
		if (!A || !B || !C || !D) continue;
		const material = om.mesh.fMat[om.view.tFace[quad]];
		const want = triNormal(ta[0].pos, ta[1].pos, ta[2].pos);
		const textured = !!A.uv;
		for (let k = 0; k < bounds.length - 1; k++) {
			const t0 = bounds[k];
			const t1 = bounds[k + 1];
			const pts = [
				lerp(A.pos, D.pos, t0),
				lerp(B.pos, C.pos, t0),
				lerp(B.pos, C.pos, t1),
				lerp(A.pos, D.pos, t1)
			];
			const q = pts.map((p) => rb.vertex(p));
			q.forEach((v) => used.add(v));
			const uvs = textured
				? [
						uvLerp(/** @type {number[]} */ (A.uv), /** @type {number[]} */ (D.uv), t0),
						uvLerp(/** @type {number[]} */ (B.uv), /** @type {number[]} */ (C.uv), t0),
						uvLerp(/** @type {number[]} */ (B.uv), /** @type {number[]} */ (C.uv), t1),
						uvLerp(/** @type {number[]} */ (A.uv), /** @type {number[]} */ (D.uv), t1)
					]
				: null;
			pushQuadFace(rb, q, pts, want, material, uvs);
		}
	}
	// a consumed corner no new piece reuses (a ring quad that could not be walked) goes with its triangles
	/** @type {number[]} */
	const orphans = [];
	for (const t of consumed)
		for (const c of triCorners(om, t)) if (!used.has(c.v)) orphans.push(c.v);
	rb.finish([...consumed], orphans);
	return { firstNew, consumed: [...consumed] };
}

/**
 * faceEdit `fanBest` for a ring of EXISTING vertices, as ONE face: the start corner whose spokes duplicate no
 * surviving edge and whose thinnest triangle is the widest; the degenerate fallback fans from a new centroid
 * hub (several kernel faces, one stored face). @param {import('./rebuild.js').Rebuild} rb @param {OpMesh} om
 * @param {{ v: number, uv: number[] }[]} ring @param {number} material
 * @param {(a: number, b: number) => boolean} surviving whether a vertex pair is an edge of a surviving triangle
 */
function fanBestFace(rb, om, ring, material, surviving) {
	const n = ring.length;
	if (n < 3) return;
	const P = ring.map((c) => pos(om, c.v));
	let best = -1;
	let bestArea = -1;
	for (let s = 0; s < n; s++) {
		let valid = true;
		for (let i = 2; i < n - 1 && valid; i++)
			if (surviving(ring[s].v, ring[(s + i) % n].v)) valid = false;
		if (!valid) continue;
		let minArea = Infinity;
		for (let i = 1; i < n - 1; i++) {
			const a = P[s];
			const b = P[(s + i) % n];
			const c = P[(s + i + 1) % n];
			minArea = Math.min(minArea, length(cross(sub(b, a), sub(c, a))));
		}
		// (the soup's preferNot is empty for connect: every start is "preferred", so only the area decides)
		if (best < 0 || minArea > bestArea * (1 + 1e-9) + 1e-12) {
			best = s;
			bestArea = minArea;
		}
	}
	if (best >= 0 && bestArea > 1e-12) {
		const order = ring.map((_, i) => ring[(best + i) % n]);
		/** @type {number[]} */
		const triangles = [];
		for (let i = 1; i < n - 1; i++) triangles.push(0, i, i + 1);
		rb.face(
			order.map((c) => c.v),
			order.map((c) => c.uv),
			material,
			triangles
		);
		return;
	}
	const hubP = [0, 0, 0];
	const hubUv = [0, 0];
	ring.forEach((c, i) => {
		hubP[0] += P[i][0] / n;
		hubP[1] += P[i][1] / n;
		hubP[2] += P[i][2] / n;
		hubUv[0] += c.uv[0] / n;
		hubUv[1] += c.uv[1] / n;
	});
	const hub = rb.vertex(hubP);
	for (let i = 0; i < n; i++) {
		const a = ring[i];
		const b = ring[(i + 1) % n];
		if (i === 0) rb.face([hub, a.v, b.v], [hubUv, a.uv, b.uv], material, [0, 1, 2]);
		else rb.joinTri([hub, a.v, b.v], [hubUv, a.uv, b.uv], material);
	}
}

/**
 * VERTEX CONNECT / J-cut (faceEdit `connectVerticesCore`): two corners of ONE stored face, not neighbours —
 * the face is split along the line between them into two faces, each fanned from its best corner. No vertex
 * is created (but the degenerate hub), so nothing outside the face changes. The faces are the op mesh's
 * stored partition, walked in stored order like the soup's. Output the result with `order: 'replace'`
 * (the survivors in stored order, then the two halves: the soup's `replaceFaces`).
 * @param {OpMesh} om @param {string} keyA @param {string} keyB welded keys
 * @returns {{ ok: true } | { error: string }}
 */
export function connectVerticesRegion(om, keyA, keyB) {
	if (keyA === keyB) return { error: 'Connect needs two DIFFERENT vertices' };
	const faces = opPartition(om, 'stored');
	const step = readStep(om);
	const keyOfV = (/** @type {number} */ v) => keyOfPos(pos(om, v));
	let sharedEdge = false;
	for (const face of faces) {
		/** @type {Set<string>} */
		const keysIn = new Set();
		for (const t of face) for (let k = 0; k < 3; k++) keysIn.add(keyOfV(step.verts[t * 3 + k]));
		if (!keysIn.has(keyA) || !keysIn.has(keyB)) continue;
		const loop = boundaryLoop(step, face);
		if (!loop) continue;
		const keys = loop.map(keyOfV);
		const n = keys.length;
		const i = keys.indexOf(keyA);
		const j = keys.indexOf(keyB);
		if (i < 0 || j < 0) continue; // an interior vertex of the face, not a corner
		if ((i + 1) % n === j || (j + 1) % n === i) {
			sharedEdge = true;
			continue;
		}
		const uvs = cornerUvs(step, face);
		const ring = loop.map((v) => ({ v, uv: uvs.get(v) ?? [0, 0] }));
		const half = (/** @type {number} */ from, /** @type {number} */ to) => {
			const out = [];
			for (let k = from; ; k = (k + 1) % n) {
				out.push(ring[k]);
				if (k === to) break;
			}
			return out;
		};
		const material = materialOf(om, face[0]);
		const inFace = new Set(face);
		// the cut is a BORDER edge of both halves, so any start keeps it an edge
		const surviving = (/** @type {number} */ a, /** @type {number} */ b) =>
			(step.sides.get(step.sideKey(a, b)) ?? []).some((t) => !inFace.has(t));
		const rb = rebuilder(om);
		fanBestFace(rb, om, half(i, j), material, surviving);
		fanBestFace(rb, om, half(j, i), material, surviving);
		rb.finish(face, []);
		return { ok: true };
	}
	return {
		error: sharedEdge
			? 'Those two vertices already share an edge — pick two corners of one face that are NOT neighbours'
			: 'Connect needs both vertices on the SAME face (its corners, not across a fold)'
	};
}
