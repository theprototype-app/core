// @ts-nocheck — a frozen copy of the PRE-PORT triangle-soup operators (faceEdit.js at 99-ops-a 6fe0fcef,
// unchanged since 99-edit-core 17d9a01b), kept as the parity reference for roadmap 99 K4 families 4-6
// (lane 99-ops-b; family 1-3's copy is soupOps99.js). Do not edit: the kernel ports are measured against
// exactly this code. Family 4 = bridge / fill / solidify, family 5 = merge / dissolve / delete, family 6 =
// subdivide (faces, levels, edges) / symmetrize (mirrorTrisCore).
import * as THREE from 'three';
import { appendedQuads, composeFaces } from '$lib/meshTopology.js';

/** rounded position key @param {number} x @param {number} y @param {number} z */
function keyOf(x, y, z) {
	return `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
}

/** Carry a MATERIAL SLOT (and M1: the per-corner UVs) onto a triangle. Stored as
 * properties on the triangle array so every op that clones/filters/maps tris
 * keeps them without changing the [v0,v1,v2] shape every caller expects.
 * @param {any} tri @param {number=} mi @param {any=} uv */
function withSlot(tri, mi, uv) {
	tri.mi = mi || 0;
	if (uv) tri.uv = uv; // M1: per-corner [[u,v],[u,v],[u,v]], absent when untextured
	return tri;
}

/** M1: uv of a triangle corner, or [0,0] when the mesh is untextured.
 * @param {any} tri @param {number} corner */
function uvAt(tri, corner) {
	return tri?.uv ? tri.uv[corner] : [0, 0];
}

/** @param {any[]} t triangle */
function triNormal(t) {
	return new THREE.Vector3()
		.subVectors(t[1], t[0])
		.cross(new THREE.Vector3().subVectors(t[2], t[0]))
		.normalize();
}

function cloneTris(/** @type {any[]} */ tris) {
	return tris.map((t) =>
		withSlot(
			[t[0].clone(), t[1].clone(), t[2].clone()],
			t.mi,
			t.uv && t.uv.map((/** @type {number[]} */ p) => [p[0], p[1]])
		)
	);
}

/** @param {string} a @param {string} b */
const edgeKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

/**
 * Union-find over welded vertex keys: the connected components ("shells") of
 * a triangle soup — a merged-in primitive is one shell, a plane floating off
 * a box is another. Shared by Shell granularity (CL-B) and custom-collider
 * piece splitting (CL-A A8). @param {any[]} tris @returns {number[][]} tri-index groups
 */
export function shellsOfTris(tris) {
	const n = tris.length;
	const parent = [...Array(n).keys()];
	const find = (/** @type {number} */ a) => {
		while (parent[a] !== a) {
			parent[a] = parent[parent[a]];
			a = parent[a];
		}
		return a;
	};
	const union = (/** @type {number} */ a, /** @type {number} */ b) => {
		parent[find(a)] = find(b);
	};
	/** @type {Map<string, number>} first tri seen per welded vertex key */
	const byKey = new Map();
	tris.forEach((t, ti) => {
		for (const v of t) {
			const k = keyOf(v.x, v.y, v.z);
			const first = byKey.get(k);
			if (first === undefined) byKey.set(k, ti);
			else union(first, ti);
		}
	});
	/** @type {Map<number, number[]>} */
	const groups = new Map();
	for (let ti = 0; ti < n; ti++) {
		const root = find(ti);
		let list = groups.get(root);
		if (!list) groups.set(root, (list = []));
		list.push(ti);
	}
	return [...groups.values()];
}

/**
 * Split a target triangle set into CONNECTED COMPONENTS, welded by vertex
 * position. `opTargetFace` synthesizes ONE face for a multi-selection, so a
 * selection spanning two separate shells arrives as a single "face" whose
 * centroid sits in the empty space between them — any op that reasons about a
 * face's CENTRE has to work per component or it drags one shell toward the
 * other (15-G: two merged cubes, both top faces inset, slid together).
 * @param {any[]} tris @param {number[]} triIndices @returns {number[][]}
 */
export function componentsOfTris(tris, triIndices) {
	/** @type {Map<string, string>} */
	const parent = new Map();
	const find = (/** @type {string} */ key) => {
		let root = key;
		while (parent.get(root) !== root) root = /** @type {string} */ (parent.get(root));
		while (parent.get(key) !== root) {
			const next = /** @type {string} */ (parent.get(key));
			parent.set(key, root);
			key = next;
		}
		return root;
	};
	const keysOf = (/** @type {number} */ ti) =>
		tris[ti].map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z));
	for (const ti of triIndices) {
		const keys = keysOf(ti);
		for (const key of keys) if (!parent.has(key)) parent.set(key, key);
		for (let i = 1; i < keys.length; i++) parent.set(find(keys[0]), find(keys[i]));
	}
	/** @type {Map<string, number[]>} */
	const byRoot = new Map();
	for (const ti of triIndices) {
		const root = find(keysOf(ti)[0]);
		let list = byRoot.get(root);
		if (!list) byRoot.set(root, (list = []));
		list.push(ti);
	}
	return [...byRoot.values()];
}

/** boundary edges of a face group: directed edges appearing once (unordered)
 * within the group @param {any[]} tris @param {any} face */
function boundaryEdges(tris, face) {
	/** @type {any[]} */
	const dir = [];
	/** @type {Map<string, number>} */
	const count = new Map();
	face.triIndices.forEach((/** @type {number} */ ti) => {
		const t = tris[ti];
		for (let e = 0; e < 3; e++) {
			const p0 = t[e];
			const p1 = t[(e + 1) % 3];
			const ek = [keyOf(p0.x, p0.y, p0.z), keyOf(p1.x, p1.y, p1.z)].sort().join('|');
			count.set(ek, (count.get(ek) || 0) + 1);
			// `ti` = the triangle this directed edge belongs to, so a wall stitched
			// onto it can take that triangle's OWN normal + material slot (15-G);
			// `c0`/`c1` are the CORNER indices within that triangle, which is how a
			// stitched wall reads the edge's UVs (M1)
			dir.push({ ek, p0, p1, ti, c0: e, c1: (e + 1) % 3 });
		}
	});
	return dir.filter((d) => count.get(d.ek) === 1);
}

/**
 * Add a quad (a,b,c,d) as two triangles, winding it so its normal aligns with
 * wantDir — otherwise the wall/ring backface-culls to invisible (121 fix).
 * @param {any[]} out @param {any} a @param {any} b @param {any} c @param {any} d @param {any} wantDir
 * @param {number=} mi material slot the new geometry belongs to (15-G)
 * @param {any[]=} uvs M1: the four corners' [u,v] in a,b,c,d order — the uv
 *   permutation follows the winding flip, or the texture would shear
 */
function pushQuad(out, a, b, c, d, wantDir, mi, uvs) {
	let t1 = [a, b, c];
	let t2 = [a, c, d];
	let uv1 = uvs && [uvs[0], uvs[1], uvs[2]];
	let uv2 = uvs && [uvs[0], uvs[2], uvs[3]];
	if (triNormal(t1).dot(wantDir) < 0) {
		t1 = [a, c, b];
		t2 = [a, d, c];
		uv1 = uvs && [uvs[0], uvs[2], uvs[1]];
		uv2 = uvs && [uvs[0], uvs[3], uvs[2]];
	}
	out.push(withSlot(t1, mi, uv1), withSlot(t2, mi, uv2));
}

/** Ordered boundary LOOP of a tri set: its directed boundary edges walked
 * p1 -> next p0. Null unless the boundary is ONE closed loop. (E10: exported
 * for faceSelectionInfo's live edge counts.)
 * @param {any[]} tris @param {number[]} triIndices @returns {any[] | null} */
export function boundaryLoop(tris, triIndices) {
	const dir = boundaryEdges(tris, { triIndices });
	if (dir.length < 3) return null;
	/** @type {Map<string, any>} */
	const byStart = new Map();
	for (const e of dir) byStart.set(keyOf(e.p0.x, e.p0.y, e.p0.z), e);
	const startKey = keyOf(dir[0].p0.x, dir[0].p0.y, dir[0].p0.z);
	/** @type {any[]} */
	const loop = [];
	let edge = dir[0];
	do {
		loop.push(edge.p0.clone());
		edge = byStart.get(keyOf(edge.p1.x, edge.p1.y, edge.p1.z));
		if (!edge) return null;
	} while (keyOf(edge.p0.x, edge.p0.y, edge.p0.z) !== startKey && loop.length <= dir.length);
	return loop.length === dir.length ? loop : null;
}

/**
 * P1 (19-A): the PURE core of the bridge — triangles + the two pieces in,
 * triangles out, no session reads. The loop resolution lives HERE (the loops
 * must be walked on whatever triangles the core is given), returning the exact
 * wrapper toast text as `{error}` when they cannot bridge; the selection-side
 * preconditions (a selection exists, exactly two pieces) stay in the wrapper.
 * @param {any[]} tris @param {number[]} setA @param {number[]} setB the two
 *   connected components (indices into `tris`)
 * @param {{cuts?: number, twist?: number, invert?: boolean}} [options] cuts =
 *   intermediate loops along the tunnel. P3: `twist` rotates the loop PAIRING
 *   by N steps (the angle ordering is deterministic but blind to which vertex
 *   should meet which — a skewed tunnel is one twist step away from a straight
 *   one). P7a: `invert` flips every wall AFTER the shell test has had its say —
 *   the shell test is a heuristic GUESS about which surface of the tunnel you
 *   are meant to see, and this is the user's correction when the guess is wrong
 *   on an unusual shape. Both default to the pre-existing behaviour exactly.
 * @returns {{tris: any[], origin: number[], authored: number[][]} | {error: string}}
 */
export function bridgeFacesCore(tris, setA, setB, options = {}) {
	const cuts = options.cuts ?? 0;
	const twist = Math.round(options.twist ?? 0) || 0;
	const invert = !!options.invert;
	const loopA = boundaryLoop(tris, setA);
	const loopB = boundaryLoop(tris, setB);
	if (!loopA || !loopB) {
		return { error: 'Bridge pieces need one closed boundary each' };
	}
	if (loopA.length !== loopB.length) {
		return {
			error: 'Bridge needs matching edge counts (' + loopA.length + ' vs ' + loopB.length + ')'
		};
	}
	const remove = new Set([...setA, ...setB]);
	// WHICH WAY DO THE TUNNEL WALLS FACE? It depends on what the tunnel IS, and the first
	// pass got one of the two cases backwards (reported: bridging two parallel quads of a
	// subdivided cube needed a manual Flip Normals, while bridging two separate shells was
	// fine). Deleting both caps from ONE shell punches a HOLE THROUGH a solid, and you
	// look at a hole's INNER surface — so those walls face the axis. Two SEPARATE shells
	// get an exterior connection, a tube you see from outside, facing away from the axis.
	/** @type {Map<number, number>} tri -> shell id, built once (a scan per lookup would
	 * be quadratic on a dense mesh) */
	const shellOf = new Map();
	shellsOfTris(tris).forEach((shell, id) => shell.forEach((ti) => shellOf.set(ti, id)));
	const sameShell = shellOf.get(setA[0]) === shellOf.get(setB[0]);
	const next = cloneTris(tris.filter((/** @type {any} */ _, /** @type {number} */ ti) => !remove.has(ti)));
	const survivorCount = next.length;
	const n = loopA.length;
	const centA = new THREE.Vector3();
	loopA.forEach((/** @type {any} */ p) => centA.add(p));
	centA.multiplyScalar(1 / n);
	const centB = new THREE.Vector3();
	loopB.forEach((/** @type {any} */ p) => centB.add(p));
	centB.multiplyScalar(1 / n);
	const axis = centB.clone().sub(centA);
	// PAIRING: order both loops by their ANGLE around their own centre, measured
	// in ONE basis perpendicular to the tunnel axis, then pair by index. The old
	// closest-vertex anchor plus a forward/backward cost vote is tie-sensitive —
	// between two aligned square caps several vertex pairs are exactly
	// equidistant, so which one won depended on loop order, and a one-step
	// rotation there shows up as a SKEWED tunnel. Angles cannot tie like that.
	const axisN =
		axis.lengthSq() > 1e-9 ? axis.clone().normalize() : new THREE.Vector3(0, 1, 0);
	const uAxis = Math.abs(axisN.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
	uAxis.addScaledVector(axisN, -uAxis.dot(axisN));
	if (uAxis.lengthSq() < 1e-9) uAxis.set(0, 0, 1);
	uAxis.normalize();
	const vAxis = new THREE.Vector3().crossVectors(axisN, uAxis).normalize();
	/** @param {any} p @param {any} centre */
	const angleOf = (p, centre) => {
		const d = p.clone().sub(centre);
		return Math.atan2(d.dot(vAxis), d.dot(uAxis));
	};
	/** @param {any[]} loop @param {any} centre */
	const byAngle = (loop, centre) =>
		loop
			.map((/** @type {any} */ p, /** @type {number} */ i) => ({ i, a: angleOf(p, centre) }))
			.sort((x, y) => x.a - y.a || x.i - y.i)
			.map((x) => x.i);
	const orderA = byAngle(loopA, centA);
	const orderB = byAngle(loopB, centB);
	// the twist as a non-negative offset into orderB (JS % keeps the sign)
	const tw = ((twist % n) + n) % n;
	// the tunnel walls take the FIRST piece's material slot (15-G) — a merged
	// multi-material mesh must stay fully grouped or it renders as nothing
	const mi = tris[setA[0]]?.mi || 0;
	// M1: a tunnel is brand-new surface with no uv to inherit from either cap —
	// give it the standard strip parametrization (u runs around the loop, v goes
	// 0 at A to 1 at B). Only when the mesh is textured at all: a uv attribute
	// must cover EVERY vertex or three throws.
	const textured = tris.some((/** @type {any} */ t) => !!t.uv);
	// SEGMENTS along the tunnel: `cuts` intermediate rings, so cuts=0 is the one
	// band this always built. Each ring is a straight lerp between the paired
	// loop points — the pairing is already settled above, so a cut cannot
	// introduce a twist the single-band version did not have.
	const segs = Math.max(1, Math.round(cuts) + 1);
	for (let s = 0; s < segs; s++) {
		const t0 = s / segs;
		const t1 = (s + 1) / segs;
		for (let k = 0; k < n; k++) {
			const a0 = loopA[orderA[k]];
			const a1 = loopA[orderA[(k + 1) % n]];
			const b0 = loopB[orderB[(k + tw) % n]];
			const b1 = loopB[orderB[(k + 1 + tw) % n]];
			const p00 = a0.clone().lerp(b0, t0);
			const p10 = a1.clone().lerp(b1, t0);
			const p11 = a1.clone().lerp(b1, t1);
			const p01 = a0.clone().lerp(b0, t1);
			const mid = p00.clone().add(p10).add(p11).add(p01).multiplyScalar(0.25);
			// radial OUT from the tunnel axis at this quad = the visible side
			let wantDir;
			if (axis.lengthSq() > 1e-9) {
				const t = Math.min(Math.max(mid.clone().sub(centA).dot(axis) / axis.lengthSq(), 0), 1);
				wantDir = mid.clone().sub(centA.clone().addScaledVector(axis, t));
			} else wantDir = mid.clone().sub(centA);
			if (wantDir.lengthSq() < 1e-9) wantDir = new THREE.Vector3(0, 1, 0);
			if (sameShell) wantDir.negate(); // a hole through a solid shows its INNER surface
			// P7a: the user's override, applied AFTER the heuristic — whichever way
			// the shell test guessed, this is the other one
			if (invert) wantDir.negate();
			pushQuad(
				next,
				p00,
				p10,
				p11,
				p01,
				wantDir.normalize(),
				mi,
				textured
					? [
							[k / n, t0],
							[(k + 1) / n, t0],
							[(k + 1) / n, t1],
							[k / n, t1]
						]
					: undefined
			);
		}
	}
	// both caps go, the survivors reindex, and every tunnel wall is a quad the op
	// knows it built (pushQuad pairs, so the appended range reads as quads)
	const origin = survivorOrigin(tris.length, remove);
	while (origin.length < next.length) origin.push(-1);
	return { tris: next, origin, authored: appendedQuads(survivorCount, next.length) };
}

/**
 * Fan an ordered ring into triangles IN RING ORDER — (r0, ri, ri+1) — with no
 * normal test: the ring's own order carries the winding (see the section note).
 * @param {any[]} out appended to @param {{pos: any, uv: number[]}[]} ring
 * @param {any} mi @param {boolean} textured @param {number} [startAt]
 * @returns {number[]} the out indices appended
 */
function fanLoop(out, ring, mi, textured, startAt = 0) {
	/** @type {number[]} */
	const added = [];
	const n = ring.length;
	if (n < 3) return added;
	const at = (/** @type {number} */ i) => ring[(startAt + i) % n];
	for (let i = 1; i < n - 1; i++) {
		const a = at(0);
		const b = at(i);
		const c = at(i + 1);
		added.push(out.length);
		out.push(
			withSlot([a.pos.clone(), b.pos.clone(), c.pos.clone()], mi, textured ? [a.uv, b.uv, c.uv] : undefined)
		);
	}
	return added;
}

/**
 * Fan a ring from its BEST corner. A dissolved region is rarely a convex planar
 * polygon: a 2x2 grid's centre leaves an octagon whose edge midpoints are
 * collinear with its corners (a corner start emits zero-area slivers), and a box
 * corner leaves a hexagon whose far corners are joined by the NEIGHBOURING faces'
 * diagonals (a spoke along one gives that edge four faces — non-manifold). So
 * every start is scored: a spoke may not duplicate an edge in `avoid` (the
 * surviving mesh's edges), and the start whose smallest triangle is largest wins;
 * ties prefer a corner outside `preferNot` (the removed vertex's neighbours — the
 * dissolve re-appearance rule), then the lowest index. With no valid start the
 * ring is fanned from its centroid instead, whose spokes are new by construction.
 * @param {any[]} out @param {{pos: any, uv: number[]}[]} ring
 * @param {any} mi @param {boolean} textured @param {Set<string>} avoid welded edge keys
 * @param {Set<string>} [preferNot] welded vertex keys
 * @returns {number[]} the out indices appended
 */
function fanBest(out, ring, mi, textured, avoid, preferNot = new Set()) {
	const n = ring.length;
	if (n < 3) return [];
	const keys = ring.map((c) => keyOf(c.pos.x, c.pos.y, c.pos.z));
	let best = -1;
	let bestArea = -1;
	let bestPreferred = false;
	for (let s = 0; s < n; s++) {
		let valid = true;
		for (let i = 2; i < n - 1 && valid; i++) if (avoid.has(edgeKey(keys[s], keys[(s + i) % n]))) valid = false;
		if (!valid) continue;
		let minArea = Infinity;
		for (let i = 1; i < n - 1; i++) {
			const a = ring[s].pos;
			const b = ring[(s + i) % n].pos;
			const c = ring[(s + i + 1) % n].pos;
			const area = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length();
			minArea = Math.min(minArea, area);
		}
		const preferred = !preferNot.has(keys[s]);
		const better =
			minArea > bestArea * (1 + 1e-9) + 1e-12 ||
			(Math.abs(minArea - bestArea) <= bestArea * 1e-9 + 1e-12 && preferred && !bestPreferred);
		if (best < 0 || better) {
			best = s;
			bestArea = minArea;
			bestPreferred = preferred;
		}
	}
	if (best >= 0 && bestArea > 1e-12) return fanLoop(out, ring, mi, textured, best);
	const hub = { pos: new THREE.Vector3(), uv: [0, 0] };
	for (const c of ring) {
		hub.pos.add(c.pos);
		hub.uv[0] += c.uv[0] / n;
		hub.uv[1] += c.uv[1] / n;
	}
	hub.pos.multiplyScalar(1 / n);
	/** @type {number[]} */
	const added = [];
	for (let i = 0; i < n; i++) added.push(...fanLoop(out, [hub, ring[i], ring[(i + 1) % n]], mi, textured, 0));
	return added;
}

/** every welded edge of the triangles NOT in `drop` — what a new fan must not
 * duplicate @param {any[]} tris @param {Set<number>} drop */
function survivingEdges(tris, drop) {
	/** @type {Set<string>} */
	const edges = new Set();
	tris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
		if (drop.has(ti)) return;
		for (let e = 0; e < 3; e++)
			edges.add(edgeKey(keyOf(t[e].x, t[e].y, t[e].z), keyOf(t[(e + 1) % 3].x, t[(e + 1) % 3].y, t[(e + 1) % 3].z)));
	});
	return edges;
}

/**
 * P6 FILL HOLE — the pure core. The picked BORDER edges (or the whole border
 * loop of a single picked border edge) must close ONE loop; the cap goes in as
 * ONE face. Winding comes from the neighbours, not from a centre heuristic:
 * every border edge is used by exactly one triangle, in one direction, so the
 * cap takes each edge the OTHER way round — the manifold rule, right for a
 * concave mesh where "away from the centre" is not. A convex planar loop is
 * fanned from a corner (no new vertex: a four-edge hole becomes a real quad);
 * anything else is fanned from the loop CENTROID, the robust star-shaped case.
 * @param {any[]} tris @param {string[]} edgeKeys
 * @returns {{tris: any[], cap: number[], loopKeys: string[], centroid: boolean} | {error: string}}
 */
export function fillHoleCore(tris, edgeKeys) {
	/** @type {Map<string, {ti: number, e: number}[]>} */
	const uses = new Map();
	tris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
		for (let e = 0; e < 3; e++) {
			const k = edgeKey(
				keyOf(t[e].x, t[e].y, t[e].z),
				keyOf(t[(e + 1) % 3].x, t[(e + 1) % 3].y, t[(e + 1) % 3].z)
			);
			let list = uses.get(k);
			if (!list) uses.set(k, (list = []));
			list.push({ ti, e });
		}
	});
	let picked = [...new Set(edgeKeys)];
	if (!picked.length) return { error: 'Pick the border edges of the hole first' };
	if (picked.some((k) => uses.get(k)?.length !== 1))
		return {
			error:
				'Fill needs BORDER edges — a picked edge has faces on both sides (or none). Pick the rim of a hole.'
		};
	/** the existing directed border edge: from -> to, as the one triangle using it winds it
	 * @param {string} k */
	const directed = (k) => {
		const { ti, e } = /** @type {any} */ (uses.get(k))[0];
		const t = tris[ti];
		const a = t[e];
		const b = t[(e + 1) % 3];
		return {
			from: keyOf(a.x, a.y, a.z),
			to: keyOf(b.x, b.y, b.z),
			a,
			b,
			uvA: uvAt(t, e),
			uvB: uvAt(t, (e + 1) % 3),
			mi: t.mi,
			textured: !!t.uv
		};
	};
	if (picked.length === 1) {
		// ONE border edge picked = "fill the hole this edge is on": walk its whole border
		// loop (every border edge, followed head to tail)
		/** @type {Map<string, string>} border from -> its edge key */
		const byFrom = new Map();
		for (const [k, list] of uses) if (list.length === 1) byFrom.set(directed(k).from, k);
		const loop = [picked[0]];
		let at = directed(picked[0]).to;
		const start = directed(picked[0]).from;
		while (at !== start && loop.length <= byFrom.size) {
			const k = byFrom.get(at);
			if (!k) return { error: 'That border edge does not close a loop — pick the whole rim' };
			loop.push(k);
			at = directed(k).to;
		}
		if (at !== start) return { error: 'That border edge does not close a loop — pick the whole rim' };
		picked = loop;
	}
	// the cap walks each border edge backwards: capNext(to) = from
	/** @type {Map<string, any>} */
	const capNext = new Map();
	/** @type {Map<string, {pos: any, uv: number[]}>} */
	const corner = new Map();
	let mi = 0;
	let textured = false;
	for (const k of picked) {
		const d = directed(k);
		if (capNext.has(d.to))
			return { error: 'The picked edges branch at a vertex — they must form ONE simple loop' };
		capNext.set(d.to, d.from);
		if (!corner.has(d.from)) corner.set(d.from, { pos: d.a, uv: d.uvA });
		if (!corner.has(d.to)) corner.set(d.to, { pos: d.b, uv: d.uvB });
		mi = d.mi;
		textured = textured || d.textured;
	}
	const startKey = /** @type {string} */ (capNext.keys().next().value);
	/** @type {string[]} */
	const loopKeys = [];
	let at = startKey;
	do {
		loopKeys.push(at);
		at = capNext.get(at);
		if (at === undefined) return { error: 'The picked edges do not close — they must form ONE loop' };
	} while (at !== startKey && loopKeys.length <= picked.length);
	if (at !== startKey || loopKeys.length !== picked.length)
		return {
			error: 'The picked edges are not ONE closed loop (' + picked.length + ' edges, ' + loopKeys.length + ' in the first loop)'
		};
	if (loopKeys.length < 3) return { error: 'A hole needs at least three edges' };
	const ring = loopKeys.map((k) => {
		const c = /** @type {any} */ (corner.get(k));
		return { pos: c.pos.clone(), uv: c.uv };
	});
	// Newell normal of the cap ring, in cap winding
	const normal = new THREE.Vector3();
	for (let i = 0; i < ring.length; i++) {
		const p = ring[i].pos;
		const q = ring[(i + 1) % ring.length].pos;
		normal.x += (p.y - q.y) * (p.z + q.z);
		normal.y += (p.z - q.z) * (p.x + q.x);
		normal.z += (p.x - q.x) * (p.y + q.y);
	}
	const centre = new THREE.Vector3();
	for (const c of ring) centre.add(c.pos);
	centre.multiplyScalar(1 / ring.length);
	let convex = normal.lengthSq() > 1e-16;
	if (convex) {
		normal.normalize();
		let size = 0;
		for (const c of ring) size = Math.max(size, c.pos.distanceTo(centre));
		for (let i = 0; i < ring.length && convex; i++) {
			const p = ring[(i - 1 + ring.length) % ring.length].pos;
			const q = ring[i].pos;
			const r = ring[(i + 1) % ring.length].pos;
			const turn = new THREE.Vector3().subVectors(q, p).cross(new THREE.Vector3().subVectors(r, q));
			if (turn.dot(normal) <= 1e-12) convex = false;
			if (Math.abs(new THREE.Vector3().subVectors(q, centre).dot(normal)) > size * 1e-3) convex = false;
		}
	}
	const out = cloneTris(tris);
	/** @type {number[]} */
	let cap;
	if (convex) cap = fanBest(out, ring, mi, textured, survivingEdges(tris, new Set()));
	else {
		let u = 0;
		let v = 0;
		for (const c of ring) {
			u += c.uv[0];
			v += c.uv[1];
		}
		const hub = { pos: centre, uv: [u / ring.length, v / ring.length] };
		cap = [];
		for (let i = 0; i < ring.length; i++)
			cap.push(...fanLoop(out, [hub, ring[i], ring[(i + 1) % ring.length]], mi, textured, 0));
	}
	return { tris: out, cap, loopKeys, centroid: !convex };
}

/**
 * P6 SOLIDIFY / SHELL — the pure core. The selected surface gains a back: a copy
 * offset by `thickness` along each welded vertex's averaged (area-weighted)
 * normal — positive = INTO the surface — wound the other way, and a rim of quads
 * along the selection's border edges joining the two. Each rim quad takes the
 * border edge the opposite way to the triangle that owns it and the back copy's
 * edge the opposite way to the back triangle, so the result is closed AND
 * consistently wound by construction (no per-quad normal guess). A closed
 * selection has no border, so it gets no rim: a hollow shell.
 * @param {any[]} tris @param {number[]} triIndices the selection
 * @param {{thickness?: number}} [options]
 *
 * REFUSED when the selection's border is shared with UNSELECTED faces (a patch of
 * a closed box): the rim would make every such edge carry three faces. Thicken
 * an open surface, the whole piece, or open the mesh first.
 * @returns {{tris: any[], copyOf: Map<number, number>, rimFrom: number} | {error: string}}
 *   copyOf = source tri -> its back copy's index; rim quads are pairs from rimFrom
 */
export function solidifyCore(tris, triIndices, options = {}) {
	let thickness = options.thickness ?? 0.1;
	if (Math.abs(thickness) < 1e-4) thickness = thickness < 0 ? -1e-4 : 1e-4;
	const sel = [...new Set(triIndices)].filter((ti) => tris[ti]).sort((a, b) => a - b);
	if (!sel.length) return { error: 'Select a face first, then Solidify' };
	const border = boundaryEdges(tris, { triIndices: sel });
	if (border.length) {
		const selSet = new Set(sel);
		/** @type {Set<string>} */
		const outside = new Set();
		tris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
			if (selSet.has(ti)) return;
			for (let e = 0; e < 3; e++)
				outside.add(
					edgeKey(keyOf(t[e].x, t[e].y, t[e].z), keyOf(t[(e + 1) % 3].x, t[(e + 1) % 3].y, t[(e + 1) % 3].z))
				);
		});
		if (border.some((d) => outside.has(d.ek)))
			return {
				error:
					'Solidify thickens an OPEN surface — this selection’s border is shared with faces you did not pick. Select the whole piece (Shell), or delete a face to open the mesh first.'
			};
	}
	/** @type {Map<string, any>} */
	const normalAt = new Map();
	for (const ti of sel) {
		const t = tris[ti];
		// un-normalised cross = 2x area along the normal: an area-weighted sum
		const n = new THREE.Vector3().subVectors(t[1], t[0]).cross(new THREE.Vector3().subVectors(t[2], t[0]));
		for (const v of t) {
			const k = keyOf(v.x, v.y, v.z);
			const sum = normalAt.get(k) ?? new THREE.Vector3();
			sum.add(n);
			normalAt.set(k, sum);
		}
	}
	for (const sum of normalAt.values()) {
		if (sum.lengthSq() < 1e-20) sum.set(0, 1, 0);
		sum.normalize();
	}
	/** @type {Map<string, any>} one offset point per welded key — the weld */
	const back = new Map();
	const backOf = (/** @type {any} */ v) => {
		const k = keyOf(v.x, v.y, v.z);
		let p = back.get(k);
		if (!p) back.set(k, (p = v.clone().addScaledVector(normalAt.get(k), -thickness)));
		return p;
	};
	const out = cloneTris(tris);
	/** @type {Map<number, number>} */
	const copyOf = new Map();
	for (const ti of sel) {
		const t = tris[ti];
		copyOf.set(ti, out.length);
		out.push(
			withSlot(
				[backOf(t[0]).clone(), backOf(t[2]).clone(), backOf(t[1]).clone()],
				t.mi,
				t.uv && [t.uv[0], t.uv[2], t.uv[1]].map((/** @type {number[]} */ q) => [q[0], q[1]])
			)
		);
	}
	const rimFrom = out.length;
	for (const d of border) {
		const t = tris[d.ti];
		const p0 = d.p0;
		const p1 = d.p1;
		const q0 = backOf(p0);
		const q1 = backOf(p1);
		const uv0 = uvAt(t, d.c0);
		const uv1 = uvAt(t, d.c1);
		const textured = !!t.uv;
		// p1 -> p0 (the owner has p0 -> p1), p0 -> q0, q0 -> q1 (the back copy has
		// q1 -> q0), q1 -> p1: every rim edge meets its neighbour the other way round
		out.push(
			withSlot([p1.clone(), p0.clone(), q0.clone()], t.mi, textured ? [uv1, uv0, uv0] : undefined),
			withSlot([p1.clone(), q0.clone(), q1.clone()], t.mi, textured ? [uv1, uv0, uv1] : undefined)
		);
	}
	return { tris: out, copyOf, rimFrom };
}
/**
 * The origin map for an op that DROPPED some input triangles and kept the rest in order
 * (`tris.filter(...)`): every survivor's new index maps to the input index it was. Any
 * appended geometry is the caller's business — pad with -1 or hand `composeFaces` its
 * own authored faces.
 * @param {number} count input triangle count @param {Set<number>} dropped
 * @returns {number[]}
 */
export function survivorOrigin(count, dropped) {
	/** @type {number[]} */
	const origin = [];
	for (let ti = 0; ti < count; ti++) if (!dropped.has(ti)) origin.push(ti);
	return origin;
}

// ---- family 5 (merge / dissolve / delete): verbatim from faceEdit at 6fe0fcef -------------------------------------

/** corner key -> {pos, uv} for one face's triangles, so a rebuilt polygon keeps its mapping
 * @param {any[]} tris @param {number[]} triIndices */
function cornerData(tris, triIndices) {
	/** @type {Map<string, {pos: any, uv: number[]}>} */
	const map = new Map();
	for (const ti of triIndices)
		tris[ti]?.forEach((/** @type {any} */ v, /** @type {number} */ c) => {
			const key = keyOf(v.x, v.y, v.z);
			if (!map.has(key)) map.set(key, { pos: v, uv: uvAt(tris[ti], c) });
		});
	return map;
}

/**
 * Rebuild a soup with some FACES dropped and new triangles appended, carrying the
 * partition: survivors keep their face (reindexed), the added polygons become
 * the faces `addedFaces` names (indices relative to `added`). The vertex
 * operators run several keys in a row, and each step must see the previous
 * step's n-gon as ONE face — so the partition has to travel with the triangles.
 * @param {any[]} tris @param {number[][]} faces @param {Set<number>} drop
 * @param {any[]} added @param {number[][]} addedFaces
 * @returns {{tris: any[], faces: number[][]}}
 */
function replaceFaces(tris, faces, drop, added, addedFaces) {
	const newIndex = new Int32Array(tris.length).fill(-1);
	/** @type {any[]} */
	const kept = [];
	tris.forEach((t, ti) => {
		if (drop.has(ti)) return;
		newIndex[ti] = kept.length;
		kept.push(t);
	});
	const base = kept.length;
	const outFaces = faces
		.map((face) => face.map((ti) => newIndex[ti]).filter((ti) => ti >= 0))
		.filter((face) => face.length);
	for (const face of addedFaces) outFaces.push(face.map((i) => base + i));
	return { tris: [...kept, ...added], faces: outFaces };
}

/** a face's boundary as welded keys + positions + per-corner uv, or null when it
 * is not ONE closed loop (a face with a hole) @param {any[]} tris @param {number[]} face */
function faceRing(tris, face) {
	const loop = boundaryLoop(tris, face);
	if (!loop) return null;
	const corners = cornerData(tris, face);
	const keys = loop.map((p) => keyOf(p.x, p.y, p.z));
	return {
		keys,
		ring: loop.map((p, i) => ({ pos: p.clone(), uv: corners.get(keys[i])?.uv ?? [0, 0] }))
	};
}

/**
 * P6 DISSOLVE VERTICES — the pure core. Each vertex is removed and the faces
 * around it become ONE n-gon (the union's boundary loop, fanned from a corner
 * that was NOT the removed vertex's neighbour — the dissolve rule: no spoke may
 * retrace a removed edge). A vertex with exactly TWO edges (an edge midpoint, a
 * leftover T-junction) is instead dropped from each face it sits on, keeping the
 * faces separate: merging them would fold two non-coplanar sides into one.
 * A border vertex simply leaves the border loop. Keys run one after another
 * against the CURRENT soup and partition, so two picks on one face both land.
 * @param {any[]} tris @param {number[][]} faces @param {string[]} vertexKeys
 * @returns {{tris: any[], faces: number[][], done: number, skipped: number}}
 */
export function dissolveVerticesCore(tris, faces, vertexKeys) {
	let cur = { tris: cloneTris(tris), faces: faces.map((f) => [...f]) };
	let done = 0;
	let skipped = 0;
	for (const vk of [...new Set(vertexKeys)]) {
		const at = [];
		for (let fi = 0; fi < cur.faces.length; fi++)
			if (
				cur.faces[fi].some((ti) =>
					cur.tris[ti].some((/** @type {any} */ v) => keyOf(v.x, v.y, v.z) === vk)
				)
			)
				at.push(fi);
		if (!at.length) {
			skipped++;
			continue;
		}
		const rings = at.map((fi) => faceRing(cur.tris, cur.faces[fi]));
		if (rings.some((r) => !r)) {
			skipped++;
			continue;
		}
		/** @type {Set<string>} */
		const neighbours = new Set();
		for (const fr of /** @type {any[]} */ (rings)) {
			const n = fr.keys.length;
			const i = fr.keys.indexOf(vk);
			if (i < 0) continue;
			neighbours.add(fr.keys[(i - 1 + n) % n]);
			neighbours.add(fr.keys[(i + 1) % n]);
		}
		/** @type {any[]} */
		const added = [];
		/** @type {number[][]} */
		const addedFaces = [];
		const drop = new Set(at.flatMap((fi) => cur.faces[fi]));
		const mi = cur.tris[cur.faces[at[0]][0]].mi;
		const textured = !!cur.tris[cur.faces[at[0]][0]].uv;
		let ok = true;
		const avoid = survivingEdges(cur.tris, drop);
		if (neighbours.size === 2) {
			// JOIN the two edges: drop the vertex from every face it is a corner of
			for (let f = 0; f < at.length; f++) {
				const fr = /** @type {any} */ (rings[f]);
				const keep = fr.ring.filter((/** @type {any} */ _, /** @type {number} */ i) => fr.keys[i] !== vk);
				if (keep.length < 3) {
					ok = false;
					break;
				}
				const fmi = cur.tris[cur.faces[at[f]][0]].mi;
				addedFaces.push(fanBest(added, keep, fmi, textured, avoid));
			}
		} else {
			const union = [...drop];
			const loop = boundaryLoop(cur.tris, union);
			if (!loop) ok = false;
			else {
				const corners = cornerData(cur.tris, union);
				const ring = [];
				for (const p of loop) {
					const k = keyOf(p.x, p.y, p.z);
					if (k === vk) continue; // a BORDER vertex leaves the border loop
					ring.push({ key: k, pos: p.clone(), uv: corners.get(k)?.uv ?? [0, 0] });
				}
				if (ring.length < 3) ok = false;
				else {
					addedFaces.push(fanBest(added, ring, mi, textured, avoid, neighbours));
				}
			}
		}
		if (!ok) {
			skipped++;
			continue;
		}
		cur = replaceFaces(cur.tris, cur.faces, drop, added, addedFaces);
		done++;
	}
	return { tris: cur.tris, faces: cur.faces, done, skipped };
}

const FACE_COPLANAR = 0.999;

// The family-5 SESSION operators at 6fe0fcef, their bodies verbatim with the session reads made parameters
// (FS.workingTris -> tris, currentPartition() -> partition, FS.quadPartner -> partner, the edge pick -> sel) and
// the commit replaced by returning what it would store: { tris, faces } or { error } (the refusal toast text).

/** mergeByDistance @param {any[]} tris @param {number[][]} partition @param {number} threshold */
export function mergeByDistanceSoup(tris, partition, threshold = 0.001) {
	const eps = Math.max(1e-5, threshold);
	const cluster = new Map();
	const cellOf = (v) => Math.round(v.x / eps) + ',' + Math.round(v.y / eps) + ',' + Math.round(v.z / eps);
	for (const t of tris)
		for (const v of t) {
			const k = cellOf(v);
			const hit = cluster.get(k);
			if (hit) {
				hit.sum.add(v);
				hit.n++;
			} else cluster.set(k, { sum: v.clone(), n: 1 });
		}
	const next = cloneTris(tris);
	let moved = 0;
	for (const t of next)
		for (const v of t) {
			const hit = cluster.get(cellOf(v));
			if (!hit || hit.n < 2) continue;
			const target = hit.sum.clone().divideScalar(hit.n);
			if (v.distanceToSquared(target) > 1e-14) moved++;
			v.copy(target);
		}
	const ok = (t) =>
		triNormal(t).lengthSq() > 1e-12 &&
		keyOf(t[0].x, t[0].y, t[0].z) !== keyOf(t[1].x, t[1].y, t[1].z) &&
		keyOf(t[1].x, t[1].y, t[1].z) !== keyOf(t[2].x, t[2].y, t[2].z) &&
		keyOf(t[2].x, t[2].y, t[2].z) !== keyOf(t[0].x, t[0].y, t[0].z);
	const survived = [];
	next.forEach((t, ti) => {
		if (ok(t)) survived.push(ti);
	});
	const kept = next.filter(ok);
	const dropped = next.length - kept.length;
	if (!moved && !dropped) return { error: 'No vertices closer than ' + eps + ' to merge' };
	return { tris: kept, faces: composeFaces(partition, survived, []), moved, dropped };
}

/** dissolveEdges @param {any[]} tris @param {number[][]} partition @param {ArrayLike<number>} partner
 * @param {string[]} sel */
export function dissolveEdgesSoup(tris, partition, partner, sel) {
	const byEdge = new Map();
	tris.forEach((t, ti) => {
		for (let e = 0; e < 3; e++) {
			const k = edgeKey(keyOf(t[e].x, t[e].y, t[e].z), keyOf(t[(e + 1) % 3].x, t[(e + 1) % 3].y, t[(e + 1) % 3].z));
			let list = byEdge.get(k);
			if (!list) byEdge.set(k, (list = []));
			list.push(ti);
		}
	});
	const normals = tris.map(triNormal);
	const drop = new Set();
	const added = [];
	const fans = [];
	let dissolved = 0;
	let skipped = 0;
	for (const key of sel) {
		const pair = byEdge.get(key);
		if (!pair || pair.length !== 2 || pair.some((ti) => drop.has(ti))) {
			skipped++;
			continue;
		}
		const patch = new Set();
		for (const ti of pair) {
			patch.add(ti);
			const mate = partner[ti] ?? -1;
			if (mate >= 0) patch.add(mate);
		}
		const pt = [...patch];
		if (pt.some((ti) => normals[ti].dot(normals[pt[0]]) < FACE_COPLANAR)) {
			skipped++;
			continue;
		}
		const loop = boundaryLoop(tris, pt);
		if (!loop || loop.length < 3) {
			skipped++;
			continue;
		}
		const corner = new Map();
		for (const ti of pt)
			tris[ti].forEach((v, c) => {
				const k = keyOf(v.x, v.y, v.z);
				if (!corner.has(k)) corner.set(k, { pos: v, uv: uvAt(tris[ti], c) });
			});
		const ends = key.split('|');
		const startAt = loop.findIndex((p) => !ends.includes(keyOf(p.x, p.y, p.z)));
		if (startAt < 0) {
			skipped++;
			continue;
		}
		const n = loop.length;
		const at = (i) => {
			const p = loop[(startAt + i) % n];
			return corner.get(keyOf(p.x, p.y, p.z)) ?? { pos: p, uv: [0, 0] };
		};
		const mi = tris[pt[0]].mi;
		const textured = !!tris[pt[0]].uv;
		const normal = normals[pt[0]];
		const fanStart = added.length;
		for (let i = 1; i < n - 1; i++) {
			const a = at(0);
			const b = at(i);
			const c = at(i + 1);
			const tri = [a.pos.clone(), b.pos.clone(), c.pos.clone()];
			const uv = textured ? [a.uv, b.uv, c.uv] : undefined;
			if (triNormal(tri).dot(normal) < 0) added.push(withSlot([tri[0], tri[2], tri[1]], mi, uv && [uv[0], uv[2], uv[1]]));
			else added.push(withSlot(tri, mi, uv));
		}
		fans.push([fanStart, added.length]);
		pt.forEach((ti) => drop.add(ti));
		dissolved++;
	}
	if (!dissolved)
		return {
			error:
				'Nothing to dissolve — an edge must join TWO COPLANAR faces (a model corner cannot be dissolved without changing the shape)'
		};
	const survivors = cloneTris(tris.filter((_, ti) => !drop.has(ti)));
	const next = [...survivors, ...added];
	const origin = survivorOrigin(tris.length, drop);
	while (origin.length < next.length) origin.push(-1);
	const fanFaces = fans.map(([from, to]) => {
		const face = [];
		for (let i = from; i < to; i++) face.push(survivors.length + i);
		return face;
	});
	return { tris: next, faces: composeFaces(partition, origin, fanFaces), dissolved, skipped };
}

/** deleteSelectedEdges @param {any[]} tris @param {number[][]} partition @param {string[]} sel */
export function deleteEdgesSoup(tris, partition, sel) {
	const keys = new Set(sel);
	const drop = new Set();
	tris.forEach((t, ti) => {
		for (let e = 0; e < 3; e++) {
			const k = edgeKey(keyOf(t[e].x, t[e].y, t[e].z), keyOf(t[(e + 1) % 3].x, t[(e + 1) % 3].y, t[(e + 1) % 3].z));
			if (keys.has(k)) {
				drop.add(ti);
				return;
			}
		}
	});
	if (!drop.size) return { error: 'Nothing to delete — no face uses those edges' };
	if (drop.size >= tris.length) return { error: 'That would delete every face of the mesh — pick fewer edges' };
	const kept = cloneTris(tris.filter((_, ti) => !drop.has(ti)));
	return { tris: kept, faces: composeFaces(partition, survivorOrigin(tris.length, drop), []), dropped: drop.size };
}

/** deleteVertices (its stored partition may be null: composeFaces then makes every survivor its own face)
 * @param {any[]} tris @param {number[][] | null} stored @param {string[]} vertexKeys */
export function deleteVerticesSoup(tris, stored, vertexKeys) {
	const keys = new Set(vertexKeys);
	const drop = new Set();
	tris.forEach((t, ti) => {
		if (t.some((v) => keys.has(keyOf(v.x, v.y, v.z)))) drop.add(ti);
	});
	if (!drop.size) return { error: 'Nothing to delete — no face uses those vertices' };
	if (drop.size >= tris.length) return { error: 'That would delete every face of the mesh — pick fewer vertices' };
	const kept = cloneTris(tris.filter((_, ti) => !drop.has(ti)));
	return { tris: kept, faces: composeFaces(stored, survivorOrigin(tris.length, drop), []), dropped: drop.size };
}

/** deleteFaceTris (the face op: the partition composeFaces of the survivors, commitFaceOp's rule)
 * @param {any[]} tris @param {{triIndices: number[]}} face */
export function deleteFaceTris(tris, face) {
	const faceSet = new Set(face.triIndices);
	return cloneTris(tris.filter((_, ti) => !faceSet.has(ti)));
}

// ---- family 6: subdivide / symmetrize (verbatim; subdivideEdgesSoup = subdivideSelectedEdges' body made pure) ----

/** M1: linear blend of two uv pairs @param {number[]} a @param {number[]} b @param {number} t */
function uvLerp(a, b, t) {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** the quad's 4 ring keys in order (p, ra, q, rb — the shared edge p-q is the
 * diagonal), or null when the two tris do not actually share an edge.
 * P1 (19-A): parameterized on `tris` so the pure op cores (and subdivideLevels'
 * later passes) can run outside the live session — a helper that indexes
 * SESSION state cannot be reused outside it (the diagonalEdgeKeys precedent).
 * @param {any[]} tris @param {number} a @param {number} b
 * @returns {string[] | null} */
function quadRingKeysIn(tris, a, b) {
	const ka = tris[a]?.map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z));
	const kb = tris[b]?.map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z));
	if (!ka || !kb) return null;
	const shared = ka.filter((/** @type {string} */ k) => kb.includes(k));
	if (shared.length !== 2) return null;
	const ra = ka.find((/** @type {string} */ k) => !shared.includes(k));
	const rb = kb.find((/** @type {string} */ k) => !shared.includes(k));
	if (!ra || !rb) return null;
	return [shared[0], ra, shared[1], rb];
}

/** B4: subdivide each target tri into 4 via edge midpoints. Midpoints of an
 * edge shared by two SELECTED tris coincide numerically, so the selection
 * stays stitched (an unselected neighbor keeps its full edge — a T-junction,
 * visually seamless on a plane). @param {any[]} tris @param {number[]} targetTris */
export function subdivideFaceTris(tris, targetTris) {
	const targets = new Set(targetTris);
	/** @type {any[]} */
	const out = [];
	tris.forEach((t, ti) => {
		if (!targets.has(ti)) {
			out.push(withSlot([t[0].clone(), t[1].clone(), t[2].clone()], t.mi, t.uv));
			return;
		}
		const [a, b, c] = t;
		const ab = a.clone().add(b).multiplyScalar(0.5);
		const bc = b.clone().add(c).multiplyScalar(0.5);
		const ca = c.clone().add(a).multiplyScalar(0.5);
		// M1: uv midpoints are the EXACT analogue of the position midpoints, so a
		// subdivided face keeps its mapping pixel-for-pixel
		const uA = uvAt(t, 0);
		const uB = uvAt(t, 1);
		const uC = uvAt(t, 2);
		const uAB = uvLerp(uA, uB, 0.5);
		const uBC = uvLerp(uB, uC, 0.5);
		const uCA = uvLerp(uC, uA, 0.5);
		out.push(
			withSlot([a.clone(), ab.clone(), ca.clone()], t.mi, t.uv && [uA, uAB, uCA]),
			withSlot([ab.clone(), b.clone(), bc.clone()], t.mi, t.uv && [uAB, uB, uBC]),
			withSlot([ca.clone(), bc.clone(), c.clone()], t.mi, t.uv && [uCA, uBC, uC]),
			withSlot([ab, bc, ca], t.mi, t.uv && [uAB, uBC, uCA])
		);
	});
	return out;
}

/**
 * Subdivide the target as QUADS where it can: each paired quad becomes a 2x2
 * grid of sub-quads, and only genuinely unpaired triangles take the 4-way
 * triangle split above.
 *
 * This matters far beyond tidiness. The triangle split turns one quad (2 tris)
 * into 8 triangles that have NO grid pairing: pairQuads scores every candidate
 * by rectangularity, the corner-and-centre "kite" pairings are all legal, and
 * the greedy match produces a pinwheel. The quad graph the loop tools walk was
 * then meaningless — which is why "subdivide a face, then Loop" behaved
 * randomly. Bilinear children of a rectangle are rectangles, so the grid scores
 * 0 and pairQuads recovers exactly the topology this emitted.
 *
 * Unselected neighbours keep their full edge, the same T-junction tradeoff the
 * triangle split and loop cut already document.
 * P10: it also reports the TOPOLOGY it built — `origin` maps each output triangle back
 * to the input one it descends from, and `authored` lists the faces this op knows it
 * created (one entry per sub-quad, singletons for a 4-way triangle split). A carry-over
 * alone cannot express that, because all eight children of a split quad descend from the
 * same old face and would collapse into one eight-triangle face.
 * @param {any[]} tris @param {number[]} targetTris
 * @param {Int32Array | number[] | null} partner quad pairing for `tris` (the body
 *   already tolerates null — `partner?.[ti]`)
 * @returns {{tris: any[], newIndices: number[], origin: number[], authored: number[][]}}
 */
export function subdivideFaceUnits(tris, targetTris, partner) {
	const targets = new Set(targetTris);
	/** @type {any[]} */
	const out = [];
	/** @type {number[]} */
	const newIndices = [];
	/** @type {number[]} out index -> the input index it came from (-1 = brand new) */
	const origin = [];
	/** @type {number[][]} */
	const authored = [];
	/** every push into `out` goes through here so `origin` cannot drift out of step
	 * @param {any} tri @param {number} from */
	const keep = (tri, from) => {
		origin[out.length] = from;
		out.push(tri);
	};
	const done = new Set();
	const mid = (/** @type {any} */ p, /** @type {any} */ q) => p.clone().add(q).multiplyScalar(0.5);
	tris.forEach((t, ti) => {
		if (done.has(ti)) return;
		if (!targets.has(ti)) {
			keep(withSlot([t[0].clone(), t[1].clone(), t[2].clone()], t.mi, t.uv), ti);
			return;
		}
		const mate = partner?.[ti] ?? -1;
		// both halves must be in the selection, or the quad is only half-targeted
		// and splitting it as a quad would edit geometry the user did not pick
		const keys = mate >= 0 && targets.has(mate) ? quadRingKeysIn(tris, ti, mate) : null;
		if (!keys) {
			// unpaired (or half-picked): the classic 4-way split, unchanged
			const sub = subdivideFaceTris([t], [0]);
			for (const s of sub) {
				newIndices.push(out.length);
				// four separate triangular faces, NOT one face of four: they descend
				// from the same input tri, so only an authored entry can say so
				authored.push([out.length]);
				keep(s, ti);
			}
			return;
		}
		done.add(ti);
		done.add(mate);
		// corners in ring order — quadRingKeys returns [p, ra, q, rb] with the
		// shared p-q as the diagonal, so ring order is p, ra, q, rb
		const corner = new Map();
		for (const idx of [ti, mate]) {
			const tri = tris[idx];
			tri.forEach((/** @type {any} */ v, /** @type {number} */ c) => {
				const k = keyOf(v.x, v.y, v.z);
				if (!corner.has(k)) corner.set(k, { pos: v, uv: uvAt(tri, c) });
			});
		}
		const ring = keys.map((/** @type {string} */ k) => corner.get(k));
		if (ring.some((/** @type {any} */ r) => !r)) {
			keep(withSlot([t[0].clone(), t[1].clone(), t[2].clone()], t.mi, t.uv), ti);
			return;
		}
		const [A, B, C, D] = ring;
		const mAB = mid(A.pos, B.pos);
		const mBC = mid(B.pos, C.pos);
		const mCD = mid(C.pos, D.pos);
		const mDA = mid(D.pos, A.pos);
		// the bilinear centre is the midpoint of either diagonal
		const ctr = mid(A.pos, C.pos);
		const uAB = uvLerp(A.uv, B.uv, 0.5);
		const uBC = uvLerp(B.uv, C.uv, 0.5);
		const uCD = uvLerp(C.uv, D.uv, 0.5);
		const uDA = uvLerp(D.uv, A.uv, 0.5);
		const uCtr = uvLerp(A.uv, C.uv, 0.5);
		const mi = t.mi;
		const textured = !!t.uv;
		const wantDir = triNormal(t);
		/** @param {any[]} pos @param {any[]} uv */
		const emit = (pos, uv) => {
			const at = out.length;
			pushQuad(out, pos[0], pos[1], pos[2], pos[3], wantDir, mi, textured ? uv : undefined);
			/** @type {number[]} */
			const cell = [];
			for (let i = at; i < out.length; i++) {
				newIndices.push(i);
				origin[i] = ti; // the grid cell descends from the quad's first half
				cell.push(i);
			}
			// ONE sub-quad, authored: this is the pinwheel fix made explicit. Bilinear
			// children of a rectangle score as rectangles so pairQuads would recover
			// the same pairing here, but a later twist would lose it again.
			authored.push(cell);
		};
		emit([A.pos.clone(), mAB, ctr.clone(), mDA], [A.uv, uAB, uCtr, uDA]);
		emit([mAB.clone(), B.pos.clone(), mBC, ctr.clone()], [uAB, B.uv, uBC, uCtr]);
		emit([ctr.clone(), mBC.clone(), C.pos.clone(), mCD], [uCtr, uBC, C.uv, uCD]);
		emit([mDA.clone(), ctr.clone(), mCD.clone(), D.pos.clone()], [uDA, uCtr, uCD, D.uv]);
	});
	return { tris: out, newIndices, origin, authored };
}

/**
 * P1 (19-A): iterate `subdivideFaceUnits` `levels` times as ONE pure step, for the
 * adjust engine's Levels parameter (P3). Unused until then — reviewed here so P3
 * does not re-derive it.
 *
 * Between passes the quad pairing CANNOT be re-derived (`pairQuads` can disagree
 * with the split on any non-planar quad — the P9 lesson), so the next pass's
 * `partner` is rebuilt from the previous pass's AUTHORED faces: exactly the 2-tri
 * sub-quads it emitted pair, the 4-way singletons stay unpaired. Each pass
 * re-targets the previous pass's `newIndices` (subdividing again subdivides the
 * area the first pass produced), and the origin maps COMPOSE back to the ORIGINAL
 * input — `origin[i] = prev.origin[step.origin[i]]`, with -1 sticking — so
 * `composeFaces` sees ancestors in the caller's index space, never a middle pass's.
 * The final `authored` needs no merging: a later pass re-targets EVERY face the
 * previous one authored, so only the last pass's faces exist to author.
 * @param {any[]} tris @param {number[]} targetTris @param {Int32Array | number[] | null} partner
 * @param {number} levels
 * @returns {{tris: any[], newIndices: number[], origin: number[], authored: number[][]}}
 */
export function subdivideLevels(tris, targetTris, partner, levels) {
	const passes = Math.max(1, Math.round(levels) || 1);
	let result = subdivideFaceUnits(tris, targetTris, partner);
	for (let pass = 1; pass < passes; pass++) {
		const nextPartner = new Int32Array(result.tris.length).fill(-1);
		for (const face of result.authored) {
			if (face.length !== 2) continue;
			nextPartner[face[0]] = face[1];
			nextPartner[face[1]] = face[0];
		}
		const step = subdivideFaceUnits(result.tris, result.newIndices, nextPartner);
		const prevOrigin = result.origin;
		const origin = step.origin.map((/** @type {number} */ o) =>
			o < 0 ? -1 : (prevOrigin[o] ?? -1)
		);
		result = { tris: step.tris, newIndices: step.newIndices, origin, authored: step.authored };
	}
	return result;
}

/**
 * Append the MIRROR of one kept triangle. A reflection flips handedness, so the winding is
 * reversed — copying the order verbatim turns every mirrored face inside out, which is
 * invisible from outside until you notice you can see through the model.
 * @param {any[]} out @param {any[]} pairs @param {number} kept the source index in `out`
 * @param {any} tri the kept triangle (carries mi/uv like every tri array) @param {any} uv
 */
/** the axis negation for the mirror in progress — set by mirrorTrisCore @type {(v: any) => void} */
let mirrorComponent = () => {};

function mirrorInto(out, pairs, kept, tri, uv) {
	const mirrored = tri.map((/** @type {any} */ v) => {
		const point = v.clone();
		mirrorComponent(point);
		return point;
	});
	// a triangle sitting ON the plane maps to itself: mirroring it would double it up
	if (mirrored.every((/** @type {any} */ v, /** @type {number} */ i) => v.equals(tri[i]))) return;
	pairs.push({ source: kept, mirrored: out.length });
	out.push(withSlot([mirrored[0], mirrored[2], mirrored[1]], tri.mi ?? out[kept]?.mi, uv && [uv[0], uv[2], uv[1]]));
}

/**
 * The PURE half of symmetrize (37 R11: shared by the one-shot command and LIVE symmetry):
 * keep one side of a triangle soup, clip what straddles the plane, and append the mirror of
 * everything kept. Triangles in, triangles out — no session, no scene.
 * @param {any[]} tris @param {number[][]|null} prior the partition to carry (null = derive)
 * @param {'x'|'y'|'z'} axis @param {number} keep +1 keeps the positive side, -1 the negative
 * @param {number} tolerance vertices this close to the plane are pinned ONTO it
 * @returns {{tris: any[], faces: number[][]|null, kept: Map<number, number>, pairs: number,
 *   clipped: number, dropped: number}|null} null = nothing on the kept side to mirror.
 *   `kept` maps a wholly-kept source triangle to its index in the output (a selection
 *   survives through it).
 */
export function mirrorTrisCore(tris, prior, axis, keep, tolerance) {
	const index = axis === 'y' ? 1 : axis === 'z' ? 2 : 0;
	const component = (/** @type {any} */ v) => (index === 0 ? v.x : index === 1 ? v.y : v.z);
	const setComponent = (/** @type {any} */ v, /** @type {number} */ value) => {
		if (index === 0) v.x = value;
		else if (index === 1) v.y = value;
		else v.z = value;
	};
	mirrorComponent = (v) => setComponent(v, -component(v));
	const working = cloneTris(tris);
	for (const tri of working)
		for (const v of tri) if (Math.abs(component(v)) < tolerance) setComponent(v, 0);
	/** @type {any[]} */
	const out = [];
	/** @type {number[]} out index -> source index, for the kept half */
	const origin = [];
	/** @type {{source: number, mirrored: number}[]} */
	const pairs = [];
	/** @type {Map<number, number>} */
	const kept = new Map();
	let dropped = 0;
	let clipped = 0;
	working.forEach((/** @type {any} */ tri, /** @type {number} */ ti) => {
		// SIGNED distance to the plane, oriented so positive means "the half we keep"
		const d = tri.map((/** @type {any} */ v) => component(v) * keep);
		const positives = d.filter((/** @type {number} */ x) => x > 0).length;
		const negatives = d.filter((/** @type {number} */ x) => x < 0).length;
		if (!positives && !negatives) return; // a sliver lying IN the plane has no area to keep
		if (!negatives) {
			// wholly on the keep side
			origin[out.length] = ti;
			kept.set(ti, out.length);
			const keptAt = out.length;
			out.push(withSlot([tri[0].clone(), tri[1].clone(), tri[2].clone()], tri.mi, tri.uv));
			mirrorInto(out, pairs, keptAt, tri, tri.uv);
			return;
		}
		if (!positives) {
			dropped++;
			return;
		}
		// STRADDLING: clip it. Classifying by centroid instead (the first pass) leaves a
		// jagged half whose boundary the mirror cannot meet — 8 odd edges on a plain box,
		// because a box has no vertices on the plane at all and every side face straddles.
		// Sutherland-Hodgman against one plane: keep the inside corners, add the crossings.
		/** @type {{pos: any, uv: number[]|undefined}[]} */
		const polygon = [];
		for (let i = 0; i < 3; i++) {
			const j = (i + 1) % 3;
			const uvI = tri.uv ? tri.uv[i] : undefined;
			const uvJ = tri.uv ? tri.uv[j] : undefined;
			if (d[i] >= 0) polygon.push({ pos: tri[i].clone(), uv: uvI });
			if ((d[i] > 0 && d[j] < 0) || (d[i] < 0 && d[j] > 0)) {
				const t = d[i] / (d[i] - d[j]);
				const point = tri[i].clone().lerp(tri[j], t);
				// force the crossing EXACTLY onto the plane: both triangles sharing this edge
				// compute the same t, and pinning the component kills the last float wobble, so
				// the seam welds and the mirror lands on it precisely
				setComponent(point, 0);
				polygon.push({ pos: point, uv: uvI && uvJ ? uvLerp(uvI, uvJ, t) : undefined });
			}
		}
		if (polygon.length < 3) {
			dropped++;
			return;
		}
		clipped++;
		const normal = triNormal(tri);
		for (let i = 1; i < polygon.length - 1; i++) {
			const piece = [polygon[0], polygon[i], polygon[i + 1]];
			const points = piece.map((entry) => entry.pos.clone());
			const uvs = tri.uv ? piece.map((entry) => entry.uv ?? tri.uv[0]) : undefined;
			const flip = triNormal(points).dot(normal) < 0;
			const wound = flip ? [points[0], points[2], points[1]] : points;
			const woundUv = uvs && (flip ? [uvs[0], uvs[2], uvs[1]] : uvs);
			origin[out.length] = ti;
			const keptAt = out.length;
			out.push(withSlot(wound, tri.mi, woundUv));
			mirrorInto(out, pairs, keptAt, wound, woundUv);
		}
	});
	if (!pairs.length) return null;
	// the partition: a kept triangle keeps its face, and each mirrored triangle joins the
	// MIRROR of that face — so a quad stays a quad on both sides instead of becoming loose
	// triangles that coplanarity has to re-guess
	/** @type {Map<number, number[]>} source face index -> mirrored out indices */
	const mirroredFaces = new Map();
	if (prior) {
		/** @type {Map<number, number>} source tri -> its face */
		const faceOf = new Map();
		prior.forEach((face, fi) => face.forEach((ti) => faceOf.set(ti, fi)));
		for (const pair of pairs) {
			const fi = faceOf.get(origin[pair.source]);
			if (fi === undefined) continue;
			let list = mirroredFaces.get(fi);
			if (!list) mirroredFaces.set(fi, (list = []));
			list.push(pair.mirrored);
		}
	}
	const authored = [...mirroredFaces.values()].filter((list) => list.length);
	const fullOrigin = [];
	for (let i = 0; i < out.length; i++) fullOrigin[i] = origin[i] ?? -1;
	return {
		tris: out,
		faces: composeFaces(prior, fullOrigin, authored),
		kept,
		pairs: pairs.length,
		clipped,
		dropped
	};
}

export function subdivideEdgesSoup(tris, partition, sel) {
	const wanted = new Set(sel);
	// ONE midpoint per welded edge key — the crack rule (the knife's crossings map)
	/** @type {Map<string, any>} */
	const midpoints = new Map();
	tris.forEach((/** @type {any} */ t) => {
		for (let e = 0; e < 3; e++) {
			const key = edgeKey(
				keyOf(t[e].x, t[e].y, t[e].z),
				keyOf(t[(e + 1) % 3].x, t[(e + 1) % 3].y, t[(e + 1) % 3].z)
			);
			if (!wanted.has(key) || midpoints.has(key)) continue;
			midpoints.set(key, t[e].clone().add(t[(e + 1) % 3]).multiplyScalar(0.5));
		}
	});
	if (!midpoints.size) return { error: 'Nothing to subdivide — no face uses those edges' };
	const priorFaces = partition;
	/** @type {any[]} */
	const out = [];
	/** new tri -> the input triangle it came from: EVERY piece maps to its parent, so
	 * composeFaces folds the split back into the parent's face
	 * @type {number[]} */
	const origin = [];
	let split = 0;
	tris.forEach((/** @type {any} */ tri, /** @type {number} */ ti) => {
		/** the triangle's edges that carry a midpoint */
		const hits = [];
		for (let e = 0; e < 3; e++) {
			const key = edgeKey(
				keyOf(tri[e].x, tri[e].y, tri[e].z),
				keyOf(tri[(e + 1) % 3].x, tri[(e + 1) % 3].y, tri[(e + 1) % 3].z)
			);
			const m = midpoints.get(key);
			if (m)
				hits.push({
					e,
					m,
					uv: tri.uv ? uvLerp(tri.uv[e], tri.uv[(e + 1) % 3], 0.5) : undefined
				});
		}
		const faceNormal = triNormal(tri);
		/** append one triangle wound like the parent (the knife's push)
		 * @param {any[]} points @param {any[]|undefined} uvs */
		const emit = (points, uvs) => {
			const flip = triNormal(points).dot(faceNormal) < 0;
			const wound = flip ? [points[0], points[2], points[1]] : points;
			const uv = uvs && (flip ? [uvs[0], uvs[2], uvs[1]] : uvs);
			out.push(
				withSlot(
					wound.map((/** @type {any} */ v) => v.clone()),
					tri.mi,
					uv
				)
			);
			origin.push(ti);
		};
		if (!hits.length) {
			out.push(withSlot([tri[0].clone(), tri[1].clone(), tri[2].clone()], tri.mi, tri.uv));
			origin.push(ti);
			return;
		}
		if (hits.length === 1) {
			// fan to the opposite corner — the knife's single-crossing split
			const { e, m, uv } = hits[0];
			const near = tri[e];
			const far = tri[(e + 1) % 3];
			const opposite = tri[(e + 2) % 3];
			emit([m, far, opposite], tri.uv && [uv, tri.uv[(e + 1) % 3], tri.uv[(e + 2) % 3]]);
			emit([m, opposite, near], tri.uv && [uv, tri.uv[(e + 2) % 3], tri.uv[e]]);
		} else if (hits.length === 2) {
			// two midpoints: the corner they share comes off as a sliver and the rest is
			// a quad — paired by WALKING THE BOUNDARY, the knife's rule (any other
			// pairing covers a different quad and the halves overlap)
			const [first, second] = hits.sort((x, y) => x.e - y.e);
			const shared = first.e + 1 === second.e ? second.e : 0; // edges 0,1 -> 1; 1,2 -> 2; 0,2 -> 0
			const cornerIndex = shared % 3;
			const p = first.e === (cornerIndex + 2) % 3 ? first : second; // the midpoint BEFORE the corner
			const q = p === first ? second : first;
			const corner = tri[cornerIndex];
			const other0 = tri[(cornerIndex + 1) % 3];
			const other1 = tri[(cornerIndex + 2) % 3];
			const uvCorner = tri.uv && tri.uv[cornerIndex];
			const uv0 = tri.uv && tri.uv[(cornerIndex + 1) % 3];
			const uv1 = tri.uv && tri.uv[(cornerIndex + 2) % 3];
			emit([p.m, corner, q.m], tri.uv && [p.uv, uvCorner, q.uv]);
			emit([q.m, other0, other1], tri.uv && [q.uv, uv0, uv1]);
			emit([q.m, other1, p.m], tri.uv && [q.uv, uv1, p.uv]);
		} else {
			// all three edges picked: the standard 4-way — three corner triangles plus
			// the middle one spanning the midpoints. Three hits on three edges sort
			// to exactly e = 0, 1, 2.
			const [m01, m12, m20] = [...hits].sort((x, y) => x.e - y.e);
			emit([tri[0], m01.m, m20.m], tri.uv && [tri.uv[0], m01.uv, m20.uv]);
			emit([m01.m, tri[1], m12.m], tri.uv && [m01.uv, tri.uv[1], m12.uv]);
			emit([m20.m, m12.m, tri[2]], tri.uv && [m20.uv, m12.uv, tri.uv[2]]);
			emit([m01.m, m12.m, m20.m], tri.uv && [m01.uv, m12.uv, m20.uv]);
		}
		split++;
	});
	// the two halves of each pick — what stays selected for the next step
	/** @type {string[]} */
	const halves = [];
	for (const [key, m] of midpoints) {
		const [ka, kb] = key.split('|');
		const km = keyOf(m.x, m.y, m.z);
		halves.push(edgeKey(ka, km), edgeKey(km, kb));
	}
	return { tris: out, faces: composeFaces(priorFaces, origin, []), halves, edges: midpoints.size, split };
}
