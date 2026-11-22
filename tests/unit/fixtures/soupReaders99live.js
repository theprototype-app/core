// @ts-nocheck
// Roadmap 99 K5 (lane 99-live): faceEdit's soup topology readers as they were at feat/99-ops-b 81ae981a,
// frozen VERBATIM (only `export` added) for the triFrame parity tests. Do not edit.
import * as THREE from 'three';
const FACE_COPLANAR = 0.999;
const QUAD_COPLANAR = 0.999;
export const edgeKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

export function keyOf(x, y, z) {
	return `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
}

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

export function withSlot(tri, mi, uv) {
	tri.mi = mi || 0;
	if (uv) tri.uv = uv; // M1: per-corner [[u,v],[u,v],[u,v]], absent when untextured
	return tri;
}

export function slotLookup(groups, count) {
	if (!groups?.length) return () => 0;
	const slots = new Int32Array(count);
	for (const group of groups) {
		const start = Math.max(group.start | 0, 0);
		const end = Math.min(start + (group.count | 0), count);
		for (let i = start; i < end; i++) slots[i] = group.materialIndex || 0;
	}
	return (/** @type {number} */ i) => slots[i] || 0;
}

export function readTriangles(geometry) {
	const pos = geometry.attributes.position;
	const uvAttr = geometry.attributes.uv;
	const index = geometry.index;
	const count = index ? index.count : pos.count;
	const slotAt = slotLookup(geometry.groups, count);
	const tris = [];
	for (let i = 0; i < count; i += 3) {
		const idx = (/** @type {number} */ o) => (index ? index.getX(i + o) : i + o);
		const vert = (/** @type {number} */ o) => {
			const j = idx(o);
			return new THREE.Vector3(pos.getX(j), pos.getY(j), pos.getZ(j));
		};
		const tri = withSlot([vert(0), vert(1), vert(2)], slotAt(i));
		// M1: carry TEXTURE COORDINATES through the edit. Every op used to rebuild
		// the geometry from positions alone, so editing a textured mesh silently
		// destroyed its mapping. `uv` is [[u,v],[u,v],[u,v]] per corner, or absent
		// when the source has no uv attribute (the overwhelmingly common case —
		// nothing extra is computed, stored or sent for those).
		if (uvAttr) tri.uv = [0, 1, 2].map((o) => [uvAttr.getX(idx(o)), uvAttr.getY(idx(o))]);
		tris.push(tri);
	}
	return tris;
}

export function triNormal(t) {
	return new THREE.Vector3()
		.subVectors(t[1], t[0])
		.cross(new THREE.Vector3().subVectors(t[2], t[0]))
		.normalize();
}

export function groupFaces(tris) {
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
	const normals = tris.map(triNormal);
	/** @type {Map<string, number[]>} */
	const edgeMap = new Map();
	tris.forEach((t, ti) => {
		for (let e = 0; e < 3; e++) {
			const k1 = keyOf(t[e].x, t[e].y, t[e].z);
			const k2 = keyOf(t[(e + 1) % 3].x, t[(e + 1) % 3].y, t[(e + 1) % 3].z);
			const ek = [k1, k2].sort().join('|');
			if (!edgeMap.has(ek)) edgeMap.set(ek, []);
			/** @type {number[]} */ (edgeMap.get(ek)).push(ti);
		}
	});
	for (const list of edgeMap.values()) {
		for (let i = 1; i < list.length; i++)
			if (Math.abs(normals[list[0]].dot(normals[list[i]])) > FACE_COPLANAR) union(list[0], list[i]);
	}
	/** @type {Map<number, number[]>} */
	const groups = new Map();
	for (let i = 0; i < n; i++) {
		const r = find(i);
		if (!groups.has(r)) groups.set(r, []);
		/** @type {number[]} */ (groups.get(r)).push(i);
	}
	return [...groups.values()].map((triIndices) => {
		const normal = normals[triIndices[0]].clone();
		const centroid = new THREE.Vector3();
		let count = 0;
		triIndices.forEach((ti) => tris[ti].forEach((/** @type {any} */ v) => (centroid.add(v), count++)));
		centroid.divideScalar(count || 1);
		return { triIndices, normal, centroid };
	});
}

export function pairQuads(tris) {
	const partner = new Int32Array(tris.length).fill(-1);
	const normals = tris.map(triNormal);
	/** @type {Map<string, number[]>} edge key -> the triangles touching it */
	const edgeMap = new Map();
	tris.forEach((t, ti) => {
		for (let e = 0; e < 3; e++) {
			const k1 = keyOf(t[e].x, t[e].y, t[e].z);
			const k2 = keyOf(t[(e + 1) % 3].x, t[(e + 1) % 3].y, t[(e + 1) % 3].z);
			const ek = [k1, k2].sort().join('|');
			let list = edgeMap.get(ek);
			if (!list) edgeMap.set(ek, (list = []));
			list.push(ti);
		}
	});

	/** the corner of `t` that is NOT on the shared edge @param {any[]} t @param {string[]} shared */
	const cornerOff = (t, shared) =>
		t.find((/** @type {any} */ v) => !shared.includes(keyOf(v.x, v.y, v.z)));
	/** the corner of `t` at a given key @param {any[]} t @param {string} key */
	const cornerAt = (t, key) => t.find((/** @type {any} */ v) => keyOf(v.x, v.y, v.z) === key);

	/** @type {{ a: number, b: number, score: number }[]} */
	const candidates = [];
	for (const [ek, list] of edgeMap) {
		if (list.length !== 2) continue; // an open or non-manifold edge is no diagonal
		const [a, b] = list;
		if (a === b) continue;
		if (normals[a].dot(normals[b]) < QUAD_COPLANAR) continue; // coplanar AND co-facing
		const shared = ek.split('|');
		const ra = cornerOff(tris[a], shared);
		const rb = cornerOff(tris[b], shared);
		const p = cornerAt(tris[a], shared[0]);
		const q = cornerAt(tris[a], shared[1]);
		if (!ra || !rb || !p || !q) continue;
		// ring order around the quad: the shared edge p-q is the diagonal, so the
		// two off-corners sit between its ends
		const score = quadScore([p, ra, q, rb], normals[a]);
		if (score === null) continue; // concave or degenerate — not a quad
		candidates.push({ a: Math.min(a, b), b: Math.max(a, b), score });
	}

	// best-first greedy matching; ties break on index so the result is stable
	candidates.sort((x, y) => x.score - y.score || x.a - y.a || x.b - y.b);
	for (const { a, b } of candidates) {
		if (partner[a] !== -1 || partner[b] !== -1) continue;
		partner[a] = b;
		partner[b] = a;
	}
	return partner;
}

export function quadScore(ring, normal) {
	let score = 0;
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const cur = ring[i];
		const u = new THREE.Vector3().subVectors(ring[(i + 3) % 4], cur);
		const v = new THREE.Vector3().subVectors(ring[(i + 1) % 4], cur);
		if (u.lengthSq() < 1e-12 || v.lengthSq() < 1e-12) return null;
		u.normalize();
		v.normalize();
		// every corner must turn the same way around the face normal, or the ring
		// folds over itself (the bow-tie case)
		const turn = new THREE.Vector3().crossVectors(v, u).dot(normal);
		if (Math.abs(turn) < 1e-9) return null; // collinear corner
		if (sign === 0) sign = Math.sign(turn);
		else if (Math.sign(turn) !== sign) return null; // concave
		// squareness: 0 at a right angle, approaching 1 as the corner collapses
		score += Math.abs(u.dot(v));
	}
	return score;
}

export function cloneTris(/** @type {any[]} */ tris) {
	return tris.map((t) =>
		withSlot(
			[t[0].clone(), t[1].clone(), t[2].clone()],
			t.mi,
			t.uv && t.uv.map((/** @type {number[]} */ p) => [p[0], p[1]])
		)
	);
}

export function centroidOfTris(tris, triIndices) {
	const centroid = new THREE.Vector3();
	let count = 0;
	triIndices.forEach((ti) => tris[ti].forEach((/** @type {any} */ v) => (centroid.add(v), count++)));
	return centroid.divideScalar(count || 1);
}

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

export function boundaryEdges(tris, face) {
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

export function faceVertexKeys(tris, face) {
	const keys = new Set();
	face.triIndices.forEach((/** @type {number} */ ti) =>
		tris[ti].forEach((/** @type {any} */ v) => keys.add(keyOf(v.x, v.y, v.z)))
	);
	return keys;
}

export function flipFaceNormals(tris, targetTris) {
	const targets = new Set(targetTris);
	return tris.map((t, ti) =>
		withSlot(
			targets.has(ti)
				? [t[0].clone(), t[2].clone(), t[1].clone()]
				: [t[0].clone(), t[1].clone(), t[2].clone()],
			t.mi,
			// M1: the uvs follow the same corner swap, or the texture mirrors
			t.uv && (targets.has(ti) ? [t.uv[0], t.uv[2], t.uv[1]] : t.uv)
		)
	);
}

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

export function trisToGroups(tris) {
	if (!tris.length || !tris.some((t) => (t.mi || 0) > 0)) return null;
	/** @type {any[]} */
	const groups = [];
	let start = 0;
	let slot = tris[0].mi || 0;
	for (let i = 1; i <= tris.length; i++) {
		const next = i < tris.length ? tris[i].mi || 0 : -1;
		if (next === slot) continue;
		groups.push({ start: start * 3, count: (i - start) * 3, materialIndex: slot });
		start = i;
		slot = next;
	}
	return groups;
}

export function trisToUVs(tris) {
	if (!tris.some((t) => !!t.uv)) return null;
	/** @type {number[]} */
	const uvs = [];
	for (const t of tris)
		for (let c = 0; c < 3; c++) {
			const pair = t.uv ? t.uv[c] : null;
			uvs.push(pair ? pair[0] : 0, pair ? pair[1] : 0);
		}
	return uvs;
}

export function trisToPositions(tris) {
	/** @type {number[]} */
	const positions = [];
	tris.forEach((t) => t.forEach((/** @type {any} */ v) => positions.push(v.x, v.y, v.z)));
	return positions;
}

export function diagonalEdgeKeys(tris, partner) {
	const out = new Set();
	for (let i = 0; i < tris.length; i++) {
		const mate = partner[i];
		if (mate == null || mate < 0 || mate < i || !tris[i] || !tris[mate]) continue;
		const ka = tris[i].map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z));
		const kb = tris[mate].map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z));
		const shared = ka.filter((/** @type {string} */ k) => kb.includes(k));
		if (shared.length === 2) out.add(edgeKey(shared[0], shared[1]));
	}
	return out;
}

export function internalEdgeKeys(tris, faces, partner) {
	if (!faces) return diagonalEdgeKeys(tris, partner ?? pairQuads(tris));
	const out = new Set();
	for (const face of faces) {
		if (face.length < 2) continue;
		/** @type {Map<string, number>} */
		const count = new Map();
		for (const ti of face) {
			const t = tris[ti];
			if (!t) continue;
			const keys = t.map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z));
			for (let e = 0; e < 3; e++) {
				const key = edgeKey(keys[e], keys[(e + 1) % 3]);
				count.set(key, (count.get(key) ?? 0) + 1);
			}
		}
		for (const [key, seen] of count) if (seen >= 2) out.add(key);
	}
	return out;
}

export function quadRingKeysIn(tris, a, b) {
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

export function derivePartition(tris, partner) {
	/** @type {number[][]} */
	const partition = [];
	const claimed = new Uint8Array(tris.length);
	for (let ti = 0; ti < tris.length; ti++) {
		if (claimed[ti]) continue;
		const mate = partner[ti] ?? -1;
		if (mate > ti && !claimed[mate]) {
			claimed[ti] = claimed[mate] = 1;
			partition.push([ti, mate]);
		} else {
			claimed[ti] = 1;
			partition.push([ti]);
		}
	}
	return partition;
}
