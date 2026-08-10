// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, objectsGroup, TControls, lockedObjects, isVRMode } from '../stores/sceneStore';
// 15-F: session-scoped undo — editSession imports ONLY history (an edge we
// already have), so this closes no cycle
import { noteEditEnter, noteEditExit, sealEditHistorySession } from './editSession';
import { peers, showToast, settingsOpen, settingsSection } from '../stores/appStore';
import { registerHistoryKind, recordEntry } from './history';

// Face editing core (118, pulled forward from pending/25 and scoped to VR
// blockout). Desktop-agnostic geometry math: read a BufferGeometry into a flat
// list of triangles, group coplanar+adjacent triangles into logical faces (a
// cube face is ONE face, not two tris), and rebuild the geometry for the four
// ops that cover ~90% of prototyping — extrude, inset, move-along-normal,
// delete. Topology changes can't ride the per-vertex `verts` channel, so every
// commit ships a full `meshgeo` snapshot (positions array + uuid, size-capped);
// receivers swap the geometry wholesale. History kind 'meshgeo' is undoable.

/** Default VR face cap — D7 (roadmap 13): raised from 300 so the default
 * sphere (960 tris) edits out of the box; the LIVE limit is the user-editable
 * `vrFaceCap` setting below */
export const VR_FACE_CAP = 1000;
/** D7: user-editable face-edit triangle limit (Settings ▸ VR, local pref)
 * @type {import('svelte/store').Writable<number>} */
export const vrFaceCap = writable(
	typeof localStorage !== 'undefined'
		? parseInt(localStorage.getItem('vrFaceCap') ?? '') || VR_FACE_CAP
		: VR_FACE_CAP
);
if (typeof localStorage !== 'undefined')
	vrFaceCap.subscribe((value) => localStorage.setItem('vrFaceCap', String(value)));

/** D7: over-limit / blocked-edit warning with a deep link into the Settings
 * VR section (works in noVR immediately; VR users see it on exit — on-device
 * surfacing stays a manual check). @param {string} message */
export function editCapToast(message) {
	showToast(message, [
		{
			label: 'Open Settings',
			action: () => {
				settingsSection.set('vr');
				settingsOpen.set(true);
			}
		}
	]);
}
/** hard ceiling on a snapshot message (floats) — ~5k tris */
const MAX_SNAPSHOT = 45000;

/** rounded position key @param {number} x @param {number} y @param {number} z */
function keyOf(x, y, z) {
	return `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
}

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

// ---- CL-A A8: scene-root edit proxy ----------------------------------------
// The custom-collider session edits a PROXY mesh at the scene root (never in
// objectsGroup, so it can't leak into GLTF sync). objectsGroup lookups in the
// edit tools fall back to it; peers never learn its uuid, so replicated edit
// messages (verts/meshgeo/lock) NO-OP on their side.
/** @type {any} */ let editProxy = null;
/** @param {any} object the live proxy mesh, or null to clear */
export function registerEditProxy(object) {
	editProxy = object;
}
/** D1: meshEdit's live-session refresh hook — registered at ITS module eval
 * (meshEdit imports us; see the applyMeshGeo call site for why not import()).
 * @type {((uuid: string) => void) | null} */
let vertexSessionRefresher = null;
/** @param {(uuid: string) => void} fn */
export function registerVertexSessionRefresher(fn) {
	vertexSessionRefresher = fn;
}

/** objectsGroup lookup that also finds the registered edit proxy @param {string} uuid */
export function lookupEditable(uuid) {
	const found = get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
	if (found) return found;
	return editProxy && editProxy.uuid === uuid ? editProxy : null;
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

/** element index -> material slot, read off a geometry's groups (0 when the
 * geometry is ungrouped) @param {any[]} groups @param {number} count */
function slotLookup(groups, count) {
	if (!groups?.length) return () => 0;
	const slots = new Int32Array(count);
	for (const group of groups) {
		const start = Math.max(group.start | 0, 0);
		const end = Math.min(start + (group.count | 0), count);
		for (let i = start; i < end; i++) slots[i] = group.materialIndex || 0;
	}
	return (/** @type {number} */ i) => slots[i] || 0;
}

/**
 * Read a geometry into triangles [[Vector3,Vector3,Vector3], ...] (index
 * expanded). Each triangle also carries `mi` — the MATERIAL SLOT it came from
 * (15-G): a merged or imported mesh can wear a material ARRAY, and three draws
 * an array material by walking `geometry.groups`, so a swapped-in geometry with
 * no groups renders NOTHING AT ALL. @param {any} geometry
 */
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

/** M1: uv of a triangle corner, or [0,0] when the mesh is untextured.
 * @param {any} tri @param {number} corner */
function uvAt(tri, corner) {
	return tri?.uv ? tri.uv[corner] : [0, 0];
}

/** M1: linear blend of two uv pairs @param {number[]} a @param {number[]} b @param {number} t */
function uvLerp(a, b, t) {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** M1: the uv centroid of a triangle set — inset shrinks toward it in uv space
 * exactly as the positions shrink toward the spatial centroid.
 * @param {any[]} tris @param {number[]} triIndices */
function uvCentroidOf(tris, triIndices) {
	let u = 0;
	let v = 0;
	let n = 0;
	for (const ti of triIndices) {
		if (!tris[ti]?.uv) continue;
		for (const pair of tris[ti].uv) {
			u += pair[0];
			v += pair[1];
			n++;
		}
	}
	return n ? [u / n, v / n] : [0, 0];
}

/** @param {any[]} t triangle */
function triNormal(t) {
	return new THREE.Vector3()
		.subVectors(t[1], t[0])
		.cross(new THREE.Vector3().subVectors(t[2], t[0]))
		.normalize();
}

/**
 * Group triangles into logical faces: union triangles that share an edge AND
 * are coplanar (near-parallel normals). Returns [{triIndices, normal,
 * centroid}]. @param {any[]} tris
 */
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
			if (Math.abs(normals[list[0]].dot(normals[list[i]])) > 0.999) union(list[0], list[i]);
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

/**
 * 15-G: pair coplanar neighbour triangles into QUADS — the unit a modeler
 * actually thinks in. The geometry here is a triangle SOUP with no stored face
 * topology, so quads are re-derived from the mesh whenever it changes.
 *
 * Two triangles pair when they share an edge, face the same way, and the quad
 * they would form is CONVEX (the shared edge has to be a real diagonal —
 * pairing across a concave joint gives a bow-tie). Every candidate is scored by
 * how rectangular the result is and matched GREEDILY best-first, so a coplanar
 * fan pairs the obvious way rather than the first way. A triangle left without
 * a partner is its own unit (the answer to "a genuine 3-sided face").
 *
 * Returns `partner`, where partner[i] is i's quad-mate or -1. Deterministic for
 * a given geometry: score ties break on triangle index.
 * @param {any[]} tris @returns {Int32Array}
 */
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
		if (normals[a].dot(normals[b]) < 0.999) continue; // coplanar AND co-facing
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

/**
 * How rectangular a candidate quad is (lower is better), or null when the ring
 * is concave or degenerate — which means those two triangles do NOT form a quad.
 * @param {any[]} ring 4 corners in order @param {any} normal
 */
function quadScore(ring, normal) {
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

function cloneTris(/** @type {any[]} */ tris) {
	return tris.map((t) =>
		withSlot(
			[t[0].clone(), t[1].clone(), t[2].clone()],
			t.mi,
			t.uv && t.uv.map((/** @type {number[]} */ p) => [p[0], p[1]])
		)
	);
}

/** average vertex position of a triangle set @param {any[]} tris @param {number[]} triIndices */
function centroidOfTris(tris, triIndices) {
	const centroid = new THREE.Vector3();
	let count = 0;
	triIndices.forEach((ti) => tris[ti].forEach((/** @type {any} */ v) => (centroid.add(v), count++)));
	return centroid.divideScalar(count || 1);
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
function componentsOfTris(tris, triIndices) {
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

/**
 * Outward direction of the wall stitched onto a boundary edge — the side that
 * must face the viewer, or the wall backface-culls to invisible.
 *
 * Derived LOCALLY from the edge itself: boundary edges inherit their direction
 * from the triangles' winding, and a face is wound counter-clockwise seen from
 * +normal, so `edge x normal` points away from the face interior. It used to be
 * measured from the face CENTROID instead, which is only right for a single
 * convex face: with two shells multi-selected the synthetic centroid lands in
 * the gap between them, so the two walls FACING EACH OTHER were wound inward
 * and vanished (15-G — extruding both top faces of two merged cubes). Concave
 * faces and faces with holes were wrong for the same reason.
 * @param {any} p0 @param {any} p1 @param {any} normal
 */
function edgeOutward(p0, p1, normal) {
	const out = new THREE.Vector3().subVectors(p1, p0).cross(normal);
	// an edge always lies in its own face plane, so this is only ever degenerate
	// for a zero-area triangle
	if (out.lengthSq() < 1e-12) return normal.clone();
	return out.normalize();
}

/** Extrude a face by dist along its normal, stitching visible side walls @param {any[]} tris @param {any} face @param {number} dist */
export function extrudeFace(tris, face, dist) {
	const out = cloneTris(tris);
	const offset = face.normal.clone().multiplyScalar(dist);
	const faceSet = new Set(face.triIndices);
	const boundary = boundaryEdges(tris, face);
	out.forEach((t, ti) => {
		if (faceSet.has(ti)) t.forEach((/** @type {any} */ v) => v.add(offset));
	});
	boundary.forEach(({ p0, p1, ti, c0, c1 }) => {
		const a = p0.clone();
		const b = p1.clone();
		const a2 = p0.clone().add(offset);
		const b2 = p1.clone().add(offset);
		// M1: the wall inherits the boundary edge's UVs; the offset copies take
		// their base corner's uv, so the texture runs unbroken up the new side
		// (Blender's "extrude copies the source face's UVs" behaviour)
		const uvA = uvAt(tris[ti], c0);
		const uvB = uvAt(tris[ti], c1);
		// each wall takes its OWN triangle's normal + slot: a multi-selection can
		// span shells (and, in a mixed selection, differently-facing faces)
		pushQuad(
			out,
			a,
			b,
			b2,
			a2,
			edgeOutward(p0, p1, triNormal(tris[ti])),
			tris[ti].mi,
			tris[ti].uv && [uvA, uvB, uvB, uvA]
		);
	});
	return out;
}

/** position keys of a face's vertices (138: weld set for a move) @param {any[]} tris @param {any} face */
function faceVertexKeys(tris, face) {
	const keys = new Set();
	face.triIndices.forEach((/** @type {number} */ ti) =>
		tris[ti].forEach((/** @type {any} */ v) => keys.add(keyOf(v.x, v.y, v.z)))
	);
	return keys;
}

/**
 * Push/pull a face along its normal, WELDED (138): every vertex sharing the
 * face's corner positions moves too, so adjacent faces stretch with it instead
 * of the face detaching and tearing a hole. @param {any[]} tris @param {any} face @param {number} dist
 */
export function moveFaceAlongNormal(tris, face, dist) {
	const out = cloneTris(tris);
	const offset = face.normal.clone().multiplyScalar(dist);
	const keys = faceVertexKeys(tris, face);
	out.forEach((t) => t.forEach((/** @type {any} */ v) => { if (keys.has(keyOf(v.x, v.y, v.z))) v.add(offset); }));
	return out;
}

/** Inset: shrink a face toward its centroid + stitch a visible frame ring so
 * the gap doesn't read as a hole (121).
 *
 * 15-G: each CONNECTED COMPONENT shrinks toward its OWN centre. A multi-select
 * spanning two shells arrives as one synthetic face whose centroid sits between
 * them, so shrinking toward it slid both faces sideways into the gap instead of
 * insetting either of them in place.
 * @param {any[]} tris @param {any} face @param {number} amount */
export function insetFace(tris, face, amount) {
	const out = cloneTris(tris);
	const t = Math.min(Math.max(amount, 0), 0.95);
	for (const component of componentsOfTris(tris, face.triIndices)) {
		const centroid = centroidOfTris(tris, component);
		// M1: the cap shrinks in UV space by the same factor it shrinks in
		// space, so the texture stays put on the smaller face instead of
		// stretching across it
		const uvCentroid = uvCentroidOf(tris, component);
		const componentSet = new Set(component);
		out.forEach((tri, ti) => {
			if (!componentSet.has(ti)) return;
			tri.forEach((/** @type {any} */ v) => v.lerp(centroid, t));
			if (tri.uv) tri.uv = tri.uv.map((/** @type {number[]} */ p) => uvLerp(p, uvCentroid, t));
		});
		// frame ring: original boundary edge → its inset counterpart, facing outward
		// like the face did (normal ≈ the face normal)
		boundaryEdges(tris, { triIndices: component }).forEach(({ p0, p1, ti, c0, c1 }) => {
			const a = p0.clone();
			const b = p1.clone();
			const b2 = p1.clone().lerp(centroid, t);
			const a2 = p0.clone().lerp(centroid, t);
			const uvA = uvAt(tris[ti], c0);
			const uvB = uvAt(tris[ti], c1);
			pushQuad(out, a, b, b2, a2, triNormal(tris[ti]), tris[ti].mi, tris[ti].uv && [
				uvA,
				uvB,
				uvLerp(uvB, uvCentroid, t),
				uvLerp(uvA, uvCentroid, t)
			]);
		});
	}
	return out;
}

/** Remove a face's triangles @param {any[]} tris @param {any} face */
export function deleteFaceTris(tris, face) {
	const faceSet = new Set(face.triIndices);
	return cloneTris(tris.filter((_, ti) => !faceSet.has(ti)));
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

/** B4: reverse the winding (swap b/c) of the target tris — flips their
 * normals. @param {any[]} tris @param {number[]} targetTris */
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
 * B4: bridge exactly TWO multi-selected pieces into a tunnel — delete both
 * caps, stitch quads between their boundary loops (equal edge counts
 * required), walking both loops from the closest-vertex-pair anchor and
 * winding each quad OUTWARD from the tunnel axis. Commits + replicates +
 * records ONE undoable meshgeo. @returns {boolean}
 */
export function bridgeFaces() {
	if (!faceEdited) return false;
	const sel = get(faceEditSelectedTris).filter((/** @type {number} */ ti) => workingTris[ti]);
	if (!sel.length) {
		showToast('Multi-select two faces first (Multi on, click both)');
		return false;
	}
	// The op target is the SELECTION, split into its two connected pieces — NOT
	// the coplanar groups the selection happens to touch (the opTargetFace rule).
	// Expanding to whole logical faces silently ignored Face/Triangle/Shell
	// granularity: extruding a face leaves a wall that is COPLANAR with the flat
	// side beneath it, so groupFaces merges the two, and picking just the wall
	// band bridged the entire side of the shell instead (15-G).
	const parts = componentsOfTris(workingTris, sel);
	if (parts.length !== 2) {
		showToast(
			parts.length < 2
				? 'Bridge needs TWO separate pieces — the selected faces touch each other'
				: 'Bridge needs exactly TWO pieces (' + parts.length + ' separate pieces selected)'
		);
		return false;
	}
	const [setA, setB] = parts;
	const loopA = boundaryLoop(workingTris, setA);
	const loopB = boundaryLoop(workingTris, setB);
	if (!loopA || !loopB) {
		showToast('Bridge pieces need one closed boundary each');
		return false;
	}
	if (loopA.length !== loopB.length) {
		showToast('Bridge needs matching edge counts (' + loopA.length + ' vs ' + loopB.length + ')');
		return false;
	}
	const before = trisToPositions(workingTris);
	const beforeGroups = trisToGroups(workingTris);
	const beforeUVs = trisToUVs(workingTris);
	const remove = new Set([...setA, ...setB]);
	const next = cloneTris(workingTris.filter((/** @type {any} */ _, /** @type {number} */ ti) => !remove.has(ti)));
	const n = loopA.length;
	// anchor: the closest vertex pair between the loops
	let ai = 0,
		bi = 0,
		best = Infinity;
	for (let i = 0; i < n; i++)
		for (let j = 0; j < n; j++) {
			const d = loopA[i].distanceToSquared(loopB[j]);
			if (d < best) {
				best = d;
				ai = i;
				bi = j;
			}
		}
	// walk B forward or backward — whichever keeps the pairing untwisted
	const pairingCost = (/** @type {number} */ sign) => {
		let sum = 0;
		for (let k = 0; k < n; k++)
			sum += loopA[(ai + k) % n].distanceToSquared(loopB[(((bi + sign * k) % n) + n) % n]);
		return sum;
	};
	const sign = pairingCost(1) <= pairingCost(-1) ? 1 : -1;
	const centA = new THREE.Vector3();
	loopA.forEach((/** @type {any} */ p) => centA.add(p));
	centA.multiplyScalar(1 / n);
	const centB = new THREE.Vector3();
	loopB.forEach((/** @type {any} */ p) => centB.add(p));
	centB.multiplyScalar(1 / n);
	const axis = centB.clone().sub(centA);
	// the tunnel walls take the FIRST piece's material slot (15-G) — a merged
	// multi-material mesh must stay fully grouped or it renders as nothing
	const mi = workingTris[setA[0]]?.mi || 0;
	// M1: a tunnel is brand-new surface with no uv to inherit from either cap —
	// give it the standard strip parametrization (u runs around the loop, v goes
	// 0 at A to 1 at B). Only when the mesh is textured at all: a uv attribute
	// must cover EVERY vertex or three throws.
	const textured = workingTris.some((/** @type {any} */ t) => !!t.uv);
	for (let k = 0; k < n; k++) {
		const a0 = loopA[(ai + k) % n];
		const a1 = loopA[(ai + k + 1) % n];
		const b0 = loopB[(((bi + sign * k) % n) + n) % n];
		const b1 = loopB[(((bi + sign * (k + 1)) % n) + n) % n];
		const mid = a0.clone().add(a1).add(b0).add(b1).multiplyScalar(0.25);
		// radial OUT from the tunnel axis at this quad = the visible side
		let wantDir;
		if (axis.lengthSq() > 1e-9) {
			const t = Math.min(Math.max(mid.clone().sub(centA).dot(axis) / axis.lengthSq(), 0), 1);
			wantDir = mid.clone().sub(centA.clone().addScaledVector(axis, t));
		} else wantDir = mid.clone().sub(centA);
		if (wantDir.lengthSq() < 1e-9) wantDir = new THREE.Vector3(0, 1, 0);
		pushQuad(
			next,
			a0.clone(),
			a1.clone(),
			b1.clone(),
			b0.clone(),
			wantDir.normalize(),
			mi,
			textured
				? [
						[k / n, 0],
						[(k + 1) / n, 0],
						[(k + 1) / n, 1],
						[k / n, 1]
					]
				: undefined
		);
	}
	const positions = trisToPositions(next);
	if (positions.length > MAX_SNAPSHOT) {
		showToast('That edit is too large to sync');
		return false;
	}
	const groups = trisToGroups(next);
	const uvs = trisToUVs(next);
	applyGeometrySnapshot(positions, groups, uvs);
	broadcastMeshGeo(faceEdited.uuid, positions, groups, uvs);
	recordEntry({
		kind: 'meshgeo',
		uuid: faceEdited.uuid,
		before: { positions: before, groups: beforeGroups, uvs: beforeUVs },
		after: { positions, groups, uvs }
	});
	faceEditSelectedTris.set([]);
	faceEditHighlight.set(-1);
	return true;
}

/** Triangles → a fresh non-indexed BufferGeometry with recomputed normals @param {any[]} tris */
export function trisToGeometry(tris) {
	const positions = new Float32Array(tris.length * 9);
	tris.forEach((t, i) => {
		for (let k = 0; k < 3; k++) {
			positions[i * 9 + k * 3] = t[k].x;
			positions[i * 9 + k * 3 + 1] = t[k].y;
			positions[i * 9 + k * 3 + 2] = t[k].z;
		}
	});
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	return geometry;
}

/**
 * 15-G: the triangles' MATERIAL SLOTS run-length encoded into geometry groups
 * (vertex units, the shape three wants). Returns null when everything is slot 0
 * — a single-material mesh needs no groups at all, so the overwhelmingly common
 * case puts nothing extra on the wire and behaves exactly as before.
 * @param {any[]} tris @returns {any[] | null}
 */
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

/**
 * Keep a MULTI-MATERIAL mesh renderable across a geometry swap (15-G). three
 * draws an array material by iterating `geometry.groups`, so a fresh geometry
 * with none draws NOTHING — a merged mesh vanished the moment any face op ran.
 * Prefer the groups the edit computed; else carry the previous geometry's over
 * (exact whenever the vertex count is unchanged — the sculpt / vertex-drag
 * paths); and always cover the tail so no triangle is left unrendered.
 * @param {any} geometry @param {any} previous the geometry being replaced
 * @param {any} object @param {any[] | null} [groups]
 */
function preserveMaterialGroups(geometry, previous, object, groups) {
	if (!Array.isArray(object?.material) || object.material.length < 2) return;
	const count = geometry.attributes.position.count;
	const source = groups?.length ? groups : previous?.groups;
	let covered = 0;
	let last = 0;
	if (source?.length)
		for (const group of source) {
			const start = Math.max(group.start | 0, 0);
			const size = Math.min(group.count | 0, count - start);
			if (start >= count || size <= 0) continue;
			last = group.materialIndex || 0;
			geometry.addGroup(start, size, last);
			covered = Math.max(covered, start + size);
		}
	// a shorter list than the geometry (an older peer's ungrouped snapshot, or a
	// path that does not track slots) would leave the tail invisible
	if (covered < count) geometry.addGroup(covered, count - covered, last);
}

/**
 * M1: the triangles' UVs as a flat array (2 per vertex), or null when the mesh
 * is untextured — the common case then puts nothing extra on the wire, in
 * history, or in the geometry, exactly like `trisToGroups`. A triangle that
 * somehow lost its uv (new geometry an op forgot to tag) contributes zeros
 * rather than a short array: a uv attribute must cover EVERY vertex.
 * @param {any[]} tris @returns {number[] | null}
 */
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

/**
 * M1: keep a TEXTURED mesh mapped across a geometry swap. Prefer the uvs the
 * edit computed; else carry the previous geometry's attribute over — exact
 * whenever the vertex count is unchanged (sculpt strokes, vertex drags, VR
 * grabs, stretch), clipped or zero-padded when an op grew/shrank the mesh
 * without tracking uvs (createFaceFromVerts). Never leaves a partial attribute:
 * three requires uv.count === position.count.
 * @param {any} geometry @param {any} previous @param {number[] | null} [uvs]
 */
function preserveUVs(geometry, previous, uvs) {
	const count = geometry.attributes.position.count;
	if (uvs?.length) {
		const array = new Float32Array(count * 2);
		array.set(uvs.length > array.length ? uvs.slice(0, array.length) : uvs);
		geometry.setAttribute('uv', new THREE.BufferAttribute(array, 2));
		return;
	}
	const old = previous?.attributes?.uv;
	if (!old) return;
	// Read through the previous geometry's INDEX when it had one: several paths
	// snapshot INDEX-EXPANDED positions (weld, entering sculpt, create-face), so
	// the new vertex count is previous.index.count while the old uv attribute is
	// still in unique-vertex space. Without this a weld on an indexed mesh
	// zero-padded 12 of a box's 36 uvs.
	const index = previous.index;
	const expanded = index && count === index.count;
	const array = new Float32Array(count * 2);
	for (let i = 0; i < count; i++) {
		const j = expanded ? index.getX(i) : i;
		if (j >= old.count) continue; // grew past what we know — leave 0,0
		array[i * 2] = old.getX(j);
		array[i * 2 + 1] = old.getY(j);
	}
	geometry.setAttribute('uv', new THREE.BufferAttribute(array, 2));
}

/** flat positions array for a snapshot message @param {any[]} tris */
export function trisToPositions(tris) {
	/** @type {number[]} */
	const positions = [];
	tris.forEach((t) => t.forEach((/** @type {any} */ v) => positions.push(v.x, v.y, v.z)));
	return positions;
}

/**
 * Scale one axis of a flat xyz positions array about its centroid on that axis
 * (161 stretch). Pure. @param {number[]} positions @param {number} axis 0|1|2
 * @param {number} factor @returns {number[]}
 */
export function stretchPositions(positions, axis, factor) {
	const out = positions.slice();
	const count = out.length / 3;
	if (!count) return out;
	let sum = 0;
	for (let i = axis; i < out.length; i += 3) sum += out[i];
	const center = sum / count;
	for (let i = axis; i < out.length; i += 3) out[i] = center + (out[i] - center) * factor;
	return out;
}

/**
 * Numbers off the wire: a plain array (history replays), an ArrayBuffer (the
 * wire format) or a typed-array VIEW — binarypack may deliver a view into a
 * LARGER buffer, so slice the exact bytes (the assetShare gotcha).
 * @param {any} data
 */
function toFloats(data) {
	if (data instanceof ArrayBuffer) return new Float32Array(data);
	if (ArrayBuffer.isView(data))
		return new Float32Array(
			/** @type {any} */ (data).buffer.slice(
				/** @type {any} */ (data).byteOffset,
				/** @type {any} */ (data).byteOffset + /** @type {any} */ (data).byteLength
			)
		);
	return new Float32Array(data);
}

/**
 * Swap an object's geometry to a positions snapshot (remote msg / undo replay).
 * @param {string} uuid @param {number[]} positions
 * @param {any[] | null} [groups] material groups for a multi-material mesh (15-G);
 *   omitted by the sculpt/vertex paths, which never change the vertex count
 * @param {any} [uvs] M1: texture coordinates, same three wire shapes as
 *   positions; omitted means "carry the previous attribute over"
 */
export function applyMeshGeo(uuid, positions, groups, uvs) {
	const object = lookupEditable(uuid); // A8: also finds the collider-edit proxy
	if (!object) return;
	const floats = toFloats(positions);
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(floats, 3));
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	// T-2: terrain reads smooth, not faceted — average normals across
	// position-welded vertices (deterministic: every peer derives the same
	// shading from the same positions; nothing extra on the wire)
	if (object.userData.terrain) smoothWeldedNormals(geometry);
	const previous = object.geometry;
	preserveMaterialGroups(geometry, previous, object, groups);
	preserveUVs(geometry, previous, uvs == null ? null : Array.from(toFloats(uvs)));
	previous?.dispose?.();
	object.geometry = geometry;
	object.userData.faceEdited = true; // parametric Geometry rows disable (like vertexEdited)
	// if we're editing this object, re-derive working tris + faces (a remote
	// change or undo swapped the geometry out from under the session, 122)
	if (faceEdited === object) {
		rebuildFaces();
		refreshFaceOverlay();
		refreshFaceWireframe(); // B2: remote/undo swap replaced the geometry
	}
	// a live sculpt session's weld map is a cache over THIS geometry — rebuild
	// it after a remote stroke / undo swap (dynamic: terrainSculpt imports us);
	// rebuildSculptCaches picks the terrain OR mesh map by the active mode
	import('./terrainSculpt').then((m) => {
		if (get(m.sculptObject) === uuid) m.rebuildSculptCaches(object);
	});
	// D1: a live VERTEX session's handles are a cache over THIS geometry too —
	// rebuild them after an undo / remote commit. meshEdit registers the hook at
	// module eval (it imports us — a dynamic import back would be a SECOND module
	// instance under vite's ?t= HMR stamps, whose editingObject is always null).
	vertexSessionRefresher?.(uuid);
	objectsGroup.update((v) => v);
}

/** Average normals across position-welded vertices of a NON-INDEXED geometry
 * (computeVertexNormals on split tris gives flat shading). @param {any} geometry */
function smoothWeldedNormals(geometry) {
	const position = geometry.attributes.position;
	const normal = geometry.attributes.normal;
	if (!position || !normal) return;
	/** @type {Map<string, number[]>} */
	const groups = new Map();
	for (let i = 0; i < position.count; i++) {
		const key =
			Math.round(position.getX(i) * 1e4) +
			'|' +
			Math.round(position.getY(i) * 1e4) +
			'|' +
			Math.round(position.getZ(i) * 1e4);
		let list = groups.get(key);
		if (!list) groups.set(key, (list = []));
		list.push(i);
	}
	const sum = new THREE.Vector3();
	for (const indices of groups.values()) {
		if (indices.length < 2) continue;
		sum.set(0, 0, 0);
		for (const i of indices) sum.add(new THREE.Vector3(normal.getX(i), normal.getY(i), normal.getZ(i)));
		sum.normalize();
		for (const i of indices) normal.setXYZ(i, sum.x, sum.y, sum.z);
	}
	normal.needsUpdate = true;
}

/** Triangle count of an object's geometry (0 when not a mesh) @param {any} object */
export function triangleCount(object) {
	const pos = object?.geometry?.attributes?.position;
	if (!pos) return 0;
	return (object.geometry.index ? object.geometry.index.count : pos.count) / 3;
}

/** Is this object simple enough to face-edit in VR? D7: capped by the
 * user-editable vrFaceCap setting. @param {any} object */
export function vrFaceEditable(object) {
	const tris = triangleCount(object);
	return tris > 0 && tris <= get(vrFaceCap);
}

// ---- B2: edit-session wireframe (shared by vertex + face modes) ------------

/** @type {any} face-mode wireframe overlay (child of faceEdited) — declared
 * BEFORE the store: its subscriber runs at module eval (TDZ) */
let wire = null;

/** wireframe overlay display toggle — honored by BOTH edit modes, local pref */
export const meshEditWireframe = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('meshEditWireframe') !== 'false'
);
meshEditWireframe.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('meshEditWireframe', String(value));
	if (wire) wire.visible = value; // live toggle mid-session (face mode)
});

/** D3: mesh-edit hotkeys (E/I/G/S/B/F/X · W) enabled — local pref, default ON.
 * Read by MeshEditPopup (the local keydown), shortcuts.js (bare mesh-edit keys
 * never match the registry while a session owns them — F also focuses) and
 * editorNavigation (W/A/S/D/Q/E fly is suppressed while it's on; toggling the
 * pref OFF is the escape hatch that returns the camera keys, quiz 15-D3). */
export const meshEditHotkeys = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('meshEditHotkeys') !== 'false'
);
meshEditHotkeys.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('meshEditHotkeys', String(value));
});

/**
 * The edit-session wireframe overlay: an object-CHILD LineSegments (follows
 * the transform for free) whose raycast is stubbed out (D8: three raycasts
 * lines with a 1-world-unit threshold — a live overlay would eat beams/picks
 * a metre off the surface). Shared with meshEdit's vertex mode. @param {any} object
 */
export function buildEditWireframe(object) {
	// D4: pick the wire color at BUILD time from the material's luminance — the
	// fixed blue disappeared on similar-hued/light materials. Rebuilds happen on
	// every geometry swap, so material changes are picked up incidentally.
	const material = Array.isArray(object.material) ? object.material[0] : object.material;
	const c = material?.color;
	// relative luminance over three's LINEAR color components
	const lum = c ? 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b : 0;
	const overlay = new THREE.LineSegments(
		new THREE.WireframeGeometry(object.geometry),
		new THREE.LineBasicMaterial({
			color: lum > 0.5 ? 0x1f2937 : 0x2f81f7,
			transparent: true,
			opacity: 0.5
		})
	);
	overlay.name = 'edit-overlay';
	overlay.raycast = () => {};
	overlay.visible = get(meshEditWireframe);
	return overlay;
}

/** (Re)build the face-mode wireframe from the CURRENT geometry — called on
 * enter + after every geometry swap (commit, live gesture, remote, undo). */
function refreshFaceWireframe() {
	if (wire) {
		wire.parent?.remove(wire);
		wire.geometry?.dispose?.();
		wire.material?.dispose?.();
		wire = null;
	}
	if (!faceEdited) return;
	wire = buildEditWireframe(faceEdited);
	faceEdited.add(wire);
}

// ---- face edit MODE (VR + desktop-parity hook) ----

/** @type {import('svelte/store').Writable<string|null>} uuid in face-edit mode */
export const faceEditObject = writable(null);
/** highlighted face index (ray/selection), or -1 @type {import('svelte/store').Writable<number>} */
export const faceEditHighlight = writable(-1);
/** armed op for the next commit (B4 adds the one-shots)
 * @type {import('svelte/store').Writable<'extrude'|'inset'|'move'|'delete'|'subdivide'|'flip'|'bridge'>} */
export const faceEditOp = writable('extrude');
/** live op amount, stick-driven @type {import('svelte/store').Writable<number>} */
export const faceEditAmount = writable(0.3);
/** 176: desktop auto-apply the active extrude/inset op on face click */
export const faceAutoApply = writable(true);

/** 176: on a desktop face click, apply the active extrude/inset op if auto-apply
 * is on and a face is highlighted. Returns TRUE if it committed. */
export function autoApplyFaceOp() {
	if (!get(faceAutoApply)) return false;
	const op = get(faceEditOp);
	if (op !== 'extrude' && op !== 'inset') return false;
	if (get(faceEditHighlight) < 0) return false;
	return commitFaceOp(op, get(faceEditAmount));
}

/** Arm an op (from the Faces sub-ring / desktop toolbar)
 * @param {'extrude'|'inset'|'move'|'delete'|'subdivide'|'flip'|'bridge'} op */
export function setFaceOp(op) {
	faceEditOp.set(op);
	// inset lives in 0..0.9; the others are signed distances
	faceEditAmount.set(op === 'inset' ? 0.2 : 0.3);
	// B1 (inset fix): a seated MOVE gizmo intercepts the next face click (the
	// $TControls.dragging||axis guard skips face dispatch), so the click DRAGGED
	// the face instead of applying the armed op. Only Move keeps the gizmo.
	if (typeof window !== 'undefined') {
		if (op === 'move') attachFaceGizmo();
		else detachFaceGizmo();
	}
}

/** Nudge the live amount (grab-hand stick) @param {number} delta */
export function adjustFaceAmount(delta) {
	faceEditAmount.update((a) => {
		const op = get(faceEditOp);
		if (op === 'inset') return Math.min(Math.max(a + delta, 0.02), 0.9);
		return Math.min(Math.max(a + delta, -5), 5);
	});
}

/** Commit the armed op at the live amount on the highlighted face (VR trigger) */
export function commitArmedFaceOp() {
	const op = get(faceEditOp);
	return commitFaceOp(op, get(faceEditAmount));
}

// ---- 212: granularity + multiselect (CL-B B3, 15-G Quad) -----
/** face-select granularity: 'quad' = the two triangles forming a quad (DEFAULT
 * since 15-G — what a modeler expects to click, and unlike 'face' an extrusion
 * wall stays its own unit instead of merging into the coplanar side beneath it;
 * on a plain box a quad IS the side); 'face' = the whole coplanar group;
 * 'triangle' = the single tri under the ray (was MISLABELED 'polygon' — that
 * RETIRED alias still reads as 'triangle', and must not be confused with
 * 'quad'); 'shell' = the connected island of welded triangles; 'object' = all.
 * @type {import('svelte/store').Writable<'quad'|'face'|'triangle'|'shell'|'object'|'polygon'>} */
export const faceEditGranularity = writable('quad');

/** the granularity with the legacy 'polygon' value migrated at read time */
function granularity() {
	const g = get(faceEditGranularity);
	return g === 'polygon' ? 'triangle' : g;
}
/** Multi mode: triggers ACCUMULATE picks; ops apply to the whole set */
export const faceEditMulti = writable(false);
/** accumulated selected tri indices (into workingTris) in Multi mode @type {import('svelte/store').Writable<number[]>} */
export const faceEditSelectedTris = writable(/** @type {number[]} */ ([]));
/** the raw triangle under the ray/cursor (for polygon picking), or -1 */
export const faceEditHoverTri = writable(-1);

/** The tri indices a single pick selects, per granularity. @param {number} tri */
function pickFaceUnitTris(tri) {
	if (tri < 0 || !workingTris[tri]) return [];
	const g = granularity();
	if (g === 'triangle') return [tri];
	// 15-G: the quad the triangle belongs to — what a modeler means by a face.
	// Sits BETWEEN triangle and face: a box side is one quad either way, but an
	// extrusion wall stays its own quad instead of merging into the coplanar
	// side beneath it (which is what `face` does, by design).
	if (g === 'quad') return quadOfTriangle(tri);
	// the WHOLE mesh. Differs from `shell` only when the mesh has SEVERAL
	// disconnected islands (a merged group, a multi-part import) — on a plain box
	// or sphere every triangle is one island, so Shell already is the object.
	if (g === 'object') return workingTris.map((_, i) => i);
	// B3: shell = the connected component of welded triangles under the ray
	if (g === 'shell') return shellsOfTris(workingTris).find((group) => group.includes(tri)) ?? [tri];
	const fi = faceIndexForTriangle(tri);
	return fi >= 0 ? [...faces[fi].triIndices] : [];
}

/** Multi mode: toggle the picked unit into the accumulated selection. @param {number} tri */
export function toggleFaceSelection(tri) {
	const unit = pickFaceUnitTris(tri);
	if (!unit.length) return false;
	faceEditSelectedTris.update((sel) => {
		const set = new Set(sel);
		const allIn = unit.every((t) => set.has(t));
		unit.forEach((t) => (allIn ? set.delete(t) : set.add(t)));
		return [...set];
	});
	refreshFaceOverlay();
	return true;
}

/** Clear the accumulated multi-selection */
export function clearFaceSelection() {
	if (get(faceEditSelectedTris).length) faceEditSelectedTris.set([]);
	refreshFaceOverlay();
}

/** B3: set the pick granularity (units differ, so drop the selection).
 * Legacy 'polygon' maps to 'triangle' — it is a RETIRED alias for the old
 * triangle mode and must NOT be confused with 15-G's 'quad'.
 * @param {'face'|'quad'|'triangle'|'shell'|'object'|'polygon'} mode */
export function setFaceGranularity(mode) {
	const next = mode === 'polygon' ? 'triangle' : mode;
	if (!['face', 'quad', 'triangle', 'shell', 'object'].includes(next)) return;
	faceEditGranularity.set(/** @type {any} */ (next));
	clearFaceSelection();
}

/** Cycle QUAD -> FACE -> TRIANGLE -> SHELL -> OBJECT (VR keeps one toggle button) */
export function toggleFaceGranularity() {
	const order = ['quad', 'face', 'triangle', 'shell', 'object'];
	setFaceGranularity(
		/** @type {any} */ (order[(order.indexOf(granularity()) + 1) % order.length])
	);
}

/** Toggle Multi mode on/off (drop the accumulated selection either way) */
export function toggleFaceMulti() {
	faceEditMulti.update((v) => !v);
	clearFaceSelection();
}

/** The tri indices the next op targets: the SELECTION whenever non-empty
 * (E10 — the unifying rule, Multi no longer gates it), else the hovered unit
 * (polygon = the tri; face = the coplanar group under the ray/highlight).
 * @returns {number[]} */
function opTargetTris() {
	if (get(faceEditSelectedTris).length)
		return get(faceEditSelectedTris).filter((/** @type {number} */ ti) => workingTris[ti]);
	if (granularity() !== 'face') return pickFaceUnitTris(get(faceEditHoverTri));
	const fi = get(faceEditHighlight);
	return fi >= 0 && faces[fi] ? faces[fi].triIndices.filter((/** @type {number} */ ti) => workingTris[ti]) : [];
}

/** E10: a plain (non-additive) pick REPLACES the selection with the
 * granularity-aware unit under the cursor. @param {number} tri */
export function pickFaceUnit(tri) {
	faceEditSelectedTris.set(pickFaceUnitTris(tri));
	refreshFaceOverlay();
}

// ---- M2: loop select + grow/shrink -----------------------------------------
// A face LOOP is the classic quad-strip walk: enter a quad through one edge,
// leave through the OPPOSITE one, repeat until you come back or run out of
// quads. It only exists because 15-G derives quads (`pairQuads`) from the
// triangle soup — which is exactly why quad granularity landed first.

/** the quad's 4 ring keys in order (p, ra, q, rb — the shared edge p-q is the
 * diagonal), or null when the two tris do not actually share an edge.
 * @param {number} a @param {number} b @returns {string[] | null} */
function quadRingKeys(a, b) {
	const ka = workingTris[a]?.map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z));
	const kb = workingTris[b]?.map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z));
	if (!ka || !kb) return null;
	const shared = ka.filter((/** @type {string} */ k) => kb.includes(k));
	if (shared.length !== 2) return null;
	const ra = ka.find((/** @type {string} */ k) => !shared.includes(k));
	const rb = kb.find((/** @type {string} */ k) => !shared.includes(k));
	if (!ra || !rb) return null;
	return [shared[0], ra, shared[1], rb];
}

/** @param {string} a @param {string} b */
const edgeKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

/** quad adjacency, rebuilt with the faces. `edges` maps a quad id (the LOWER of
 * its two triangle indices) to its 4 boundary edge keys in ring order; `byEdge`
 * maps an edge key to the quads touching it.
 * @type {{ edges: Map<number, string[]>, byEdge: Map<string, number[]> } | null} */
let quadTopology = null;

function buildQuadTopology() {
	/** @type {Map<number, string[]>} */
	const edges = new Map();
	/** @type {Map<string, number[]>} */
	const byEdge = new Map();
	for (let ti = 0; ti < workingTris.length; ti++) {
		const mate = quadPartner[ti] ?? -1;
		if (mate < 0 || mate < ti) continue; // one entry per quad, keyed by the lower index
		const ring = quadRingKeys(ti, mate);
		if (!ring) continue;
		const quadEdges = [0, 1, 2, 3].map((i) => edgeKey(ring[i], ring[(i + 1) % 4]));
		edges.set(ti, quadEdges);
		for (const ek of quadEdges) {
			let list = byEdge.get(ek);
			if (!list) byEdge.set(ek, (list = []));
			list.push(ti);
		}
	}
	quadTopology = { edges, byEdge };
	return quadTopology;
}

/** the quad id a triangle belongs to (the lower of the pair), or -1 when it has
 * no mate — a lone triangle breaks a loop rather than guessing across it.
 * @param {number} tri */
function quadIdOf(tri) {
	const mate = quadPartner[tri] ?? -1;
	return mate < 0 ? -1 : Math.min(tri, mate);
}

/**
 * The face loop through a triangle's quad. `axis` picks WHICH of the two loops
 * crossing that quad to walk (0 or 1) — a quad sits on two perpendicular loops,
 * so the toolbar button cycles the axis on a repeat press.
 * @param {number} tri @param {number} [axis] @returns {number[]} tri indices
 */
export function faceLoopTris(tri, axis = 0) {
	const start = quadIdOf(tri);
	if (start < 0) return tri >= 0 && workingTris[tri] ? [tri] : [];
	const topo = quadTopology ?? buildQuadTopology();
	const startEdges = topo.edges.get(start);
	if (!startEdges) return [tri];
	/** @type {Set<number>} */
	const seen = new Set([start]);
	// walk BOTH ways from the chosen axis's pair of opposite edges
	for (const first of [startEdges[axis % 2], startEdges[(axis % 2) + 2]]) {
		let quad = start;
		let edge = first;
		for (let guard = 0; guard < workingTris.length; guard++) {
			const next = (topo.byEdge.get(edge) ?? []).find((q) => q !== quad);
			if (next === undefined || seen.has(next)) break; // boundary, non-quad, or closed
			seen.add(next);
			const ring = topo.edges.get(next);
			const at = ring ? ring.indexOf(edge) : -1;
			if (!ring || at < 0) break;
			edge = ring[(at + 2) % 4]; // straight across
			quad = next;
		}
	}
	/** @type {number[]} */
	const out = [];
	for (const q of seen) {
		out.push(q);
		const mate = quadPartner[q] ?? -1;
		if (mate >= 0) out.push(mate);
	}
	return out;
}

/** the axis the last loop select used, so a repeat press walks the OTHER loop */
let loopAxis = 0;
/** @type {string} */
let loopSignature = '';

/**
 * M2: select the face loop through the current pick. Repeating it on the same
 * loop switches to the perpendicular one (a quad lies on two) — the standard
 * "press again to cycle" affordance, since a single click cannot say which.
 * @returns {boolean}
 */
export function selectFaceLoop() {
	if (!faceEdited) return false;
	const sel = get(faceEditSelectedTris);
	const anchor = sel.length ? sel[0] : get(faceEditHoverTri);
	if (anchor < 0 || !workingTris[anchor]) {
		showToast('Pick a quad first, then Loop');
		return false;
	}
	if (quadIdOf(anchor) < 0) {
		showToast('Loop select needs a QUAD — this triangle has no pair');
		return false;
	}
	const signature = quadIdOf(anchor) + ':' + sel.length;
	if (signature === loopSignature) loopAxis = (loopAxis + 1) % 2;
	const loop = faceLoopTris(anchor, loopAxis);
	faceEditSelectedTris.set(loop);
	loopSignature = quadIdOf(anchor) + ':' + loop.length;
	refreshFaceOverlay();
	return true;
}

/** every welded position key a triangle set touches @param {number[]} triIndices */
function keysOfTris(triIndices) {
	const keys = new Set();
	for (const ti of triIndices)
		workingTris[ti]?.forEach((/** @type {any} */ v) => keys.add(keyOf(v.x, v.y, v.z)));
	return keys;
}

/**
 * M2: grow the selection by one ring — every triangle touching a selected
 * vertex joins, then each newcomer expands to its full pick UNIT so quads stay
 * whole. @returns {boolean}
 */
export function growSelection() {
	if (!faceEdited) return false;
	const sel = get(faceEditSelectedTris);
	if (!sel.length) {
		showToast('Select something first, then Grow');
		return false;
	}
	const keys = keysOfTris(sel);
	const next = new Set(sel);
	workingTris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
		if (next.has(ti)) return;
		if (t.some((/** @type {any} */ v) => keys.has(keyOf(v.x, v.y, v.z))))
			pickFaceUnitTris(ti).forEach((u) => next.add(u));
	});
	faceEditSelectedTris.set([...next]);
	refreshFaceOverlay();
	return true;
}

/**
 * M2: shrink by one ring — drop every triangle that touches the selection's
 * BORDER, i.e. keep only those whose every vertex is interior (i.e. every
 * triangle sharing that vertex is also selected). @returns {boolean}
 */
export function shrinkSelection() {
	if (!faceEdited) return false;
	const sel = get(faceEditSelectedTris);
	if (!sel.length) return false;
	const selSet = new Set(sel);
	/** @type {Map<string, boolean>} key -> every toucher selected? */
	const interior = new Map();
	workingTris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
		const mine = selSet.has(ti);
		t.forEach((/** @type {any} */ v) => {
			const k = keyOf(v.x, v.y, v.z);
			interior.set(k, (interior.get(k) ?? true) && mine);
		});
	});
	const next = sel.filter((/** @type {number} */ ti) =>
		workingTris[ti].every((/** @type {any} */ v) => interior.get(keyOf(v.x, v.y, v.z)))
	);
	faceEditSelectedTris.set(next);
	refreshFaceOverlay();
	return true;
}

/** M6: select every triangle of the mesh */
export function selectAllFaces() {
	if (!faceEdited) return false;
	faceEditSelectedTris.set(workingTris.map((/** @type {any} */ _, /** @type {number} */ i) => i));
	refreshFaceOverlay();
	return true;
}

/** M6: invert the selection (by pick UNIT, so quads stay whole) */
export function invertFaceSelection() {
	if (!faceEdited) return false;
	const sel = new Set(get(faceEditSelectedTris));
	const next = new Set();
	workingTris.forEach((/** @type {any} */ _, /** @type {number} */ ti) => {
		if (!sel.has(ti)) pickFaceUnitTris(ti).forEach((u) => next.add(u));
	});
	// a unit straddling the border would drag selected tris back in
	sel.forEach((ti) => next.delete(ti));
	faceEditSelectedTris.set([...next]);
	refreshFaceOverlay();
	return true;
}

/** M6: grow the selection to every triangle CONNECTED to it (select linked) */
export function selectLinkedFaces() {
	if (!faceEdited) return false;
	const sel = get(faceEditSelectedTris);
	if (!sel.length) {
		showToast('Select something first, then Linked');
		return false;
	}
	const next = new Set(sel);
	for (const shell of shellsOfTris(workingTris))
		if (shell.some((ti) => next.has(ti))) shell.forEach((ti) => next.add(ti));
	faceEditSelectedTris.set([...next]);
	refreshFaceOverlay();
	return true;
}

/** Synthesize a face {triIndices, normal, centroid} from the op target tris (212).
 * For a single coplanar group this equals the groupFaces() face, so the default
 * FACE path is unchanged. */
function opTargetFace() {
	const tris = opTargetTris();
	if (!tris.length) return null;
	const normal = new THREE.Vector3();
	const centroid = new THREE.Vector3();
	let cnt = 0;
	tris.forEach((/** @type {number} */ ti) => {
		normal.add(triNormal(workingTris[ti]));
		workingTris[ti].forEach((/** @type {any} */ v) => (centroid.add(v), cnt++));
	});
	if (normal.lengthSq() < 1e-9) normal.copy(triNormal(workingTris[tris[0]]));
	return { triIndices: tris, normal: normal.normalize(), centroid: centroid.divideScalar(cnt || 1) };
}

/** Tris to tint in the overlay: the selection plus the hovered unit (212;
 * E10 — the selection always shows, Multi no longer gates it) */
function overlayTris() {
	const set = new Set();
	get(faceEditSelectedTris).forEach((t) => set.add(t));
	pickFaceUnitTris(get(faceEditHoverTri)).forEach((t) => set.add(t));
	return [...set].filter((ti) => workingTris[ti]);
}

/** @type {any} */ let faceEdited = null;
/** 175: remember the last face selected per object, restored on re-entry
 * @type {{uuid: string|null, fi: number}} */
let stashedFace = { uuid: null, fi: -1 };
/** @type {any[]} */ let workingTris = [];
/** @type {any[]} */ let faces = [];
/** 15-G: quad pairing over workingTris — quadPartner[i] is i's mate, or -1
 * @type {Int32Array} */ let quadPartner = new Int32Array(0);
/** @type {any} */ let overlay = null; // highlighted-face tint at the scene root

/** rebuild the working triangles + face groups from the live geometry */
function rebuildFaces() {
	if (!faceEdited) return;
	workingTris = readTriangles(faceEdited.geometry);
	faces = groupFaces(workingTris);
	quadPartner = pairQuads(workingTris);
	quadTopology = null; // M2: the loop-walk adjacency is rebuilt on demand
}

/** O(1) identity of the quad a triangle belongs to — the lower of the pair, so
 * both halves key the same. -1 for no triangle. @param {number} tri */
function quadKey(tri) {
	if (tri < 0 || !workingTris[tri]) return -1;
	const mate = quadPartner[tri] ?? -1;
	return mate >= 0 ? Math.min(tri, mate) : tri;
}

/** the tri indices of the quad `tri` belongs to — itself when it has no mate
 * (a genuine 3-sided face, or an odd triangle in a fan). @param {number} tri */
export function quadOfTriangle(tri) {
	if (tri < 0 || !workingTris[tri]) return [];
	const mate = quadPartner[tri] ?? -1;
	return mate >= 0 ? [tri, mate] : [tri];
}

export function faceCount() {
	return faces.length;
}
/** exposed for tests/preview: the current face groups */
export function currentFaces() {
	return faces;
}

/** @param {string} uuid */
export function enterFaceEdit(uuid) {
	if (get(faceEditObject)) exitFaceEdit();
	const object = lookupEditable(uuid); // A8: also accepts the collider proxy
	if (!object || !object.geometry?.attributes?.position) {
		// D7: a multi-mesh GROUP blocks face editing — say how to unblock it
		if (object?.type === 'Group')
			showToast('A group can’t be mesh-edited — Ungroup it first, then edit each mesh');
		else showToast('Only meshes can be face-edited');
		return;
	}
	if (!vrFaceEditable(object)) {
		editCapToast(
			'Mesh exceeds the face edit limit (' +
				Math.round(triangleCount(object)) +
				' of ' +
				get(vrFaceCap) +
				' triangles) — raise it in Settings ▸ VR'
		);
		return;
	}
	if (get(lockedObjects).find((lock) => lock[1] === uuid)) {
		showToast('This object is locked by another peer');
		return;
	}
	faceEdited = object;
	rebuildFaces();
	faceEditHighlight.set(-1);
	faceEditHoverTri.set(-1);
	if (get(faceEditSelectedTris).length) faceEditSelectedTris.set([]); // 212
	/** @type {any} */
	const controls = get(TControls);
	controls?.detach?.();
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'lock', uuid: uuid, peerId: peer.peer.id });
	faceEditObject.set(uuid);
	noteEditEnter('face', uuid); // 15-F: opens (or continues) the undo barrier
	refreshFaceWireframe(); // B2: face mode gets the same wireframe as vertex mode
	if (typeof window !== 'undefined') window.addEventListener('keydown', onFaceKeydown);
	// 175: restore the face selected last time in this object (per-mode memory)
	if (stashedFace.uuid === uuid && stashedFace.fi >= 0 && faces[stashedFace.fi]) {
		faceEditHighlight.set(stashedFace.fi);
		refreshFaceOverlay();
		// B1: only the Move op keeps a gizmo on the face (see setFaceOp)
		if (get(faceEditOp) === 'move') attachFaceGizmo();
	}
}

/** @param {KeyboardEvent} event */
function onFaceKeydown(event) {
	if (event.key === 'Escape') {
		exitFaceEdit();
		sealEditHistorySession(); // 15-F: Escape = Done, sealed synchronously
	}
}

export function exitFaceEdit() {
	if (!faceEdited) return;
	if (get(faceEditHighlight) >= 0) stashedFace = { uuid: faceEdited.uuid, fi: get(faceEditHighlight) };
	detachFaceGizmo(); // 163: drop the desktop gizmo + its proxy
	// revert an uncommitted gesture's live preview before tearing down (122)
	const pendingBefore = faceGrab?.before ?? faceAdjust?.before ?? null;
	faceGrab = null;
	faceAdjust = null;
	if (pendingBefore) applyGeometrySnapshot(pendingBefore);
	if (typeof window !== 'undefined') window.removeEventListener('keydown', onFaceKeydown);
	if (overlay) {
		overlay.parent?.remove(overlay);
		overlay.geometry?.dispose?.();
		overlay.material?.dispose?.();
		overlay = null;
	}
	if (wire) {
		wire.parent?.remove(wire);
		wire.geometry?.dispose?.();
		wire.material?.dispose?.();
		wire = null;
	}
	faceEdited = null;
	workingTris = [];
	faces = [];
	faceEditHighlight.set(-1);
	faceEditHoverTri.set(-1);
	if (get(faceEditSelectedTris).length) faceEditSelectedTris.set([]); // 212
	faceEditObject.set(null);
	noteEditExit('face'); // 15-F: deferred seal unless another mode re-enters
}

/**
 * Map a raycast hit (three.js faceIndex = TRIANGLE index) to a logical face
 * index and highlight it. Returns TRUE only when the highlight changed, so the
 * caller ticks a haptic once and the overlay rebuilds once (121). A negative
 * triangleIndex clears the highlight. @param {number} triangleIndex
 * @param {boolean} [healStale] E10: outside Multi mode, aiming at anything
 * OUTSIDE the current selection dissolves it (the cap E6 keeps selected is a
 * convenience, not a lock) — VR calls this per-frame from the beam, so VR
 * trigger semantics stay identical. Additive (ctrl) desktop clicks pass false
 * or the heal would wipe the selection they are adding to.
 */
export function highlightFaceByTriangle(triangleIndex, healStale = true) {
	// 212: track the raw tri (polygon picking) + refresh per-tri in polygon mode
	const prevTri = get(faceEditHoverTri);
	faceEditHoverTri.set(triangleIndex);
	const fi = triangleIndex < 0 ? -1 : faces.findIndex((f) => f.triIndices.includes(triangleIndex));
	const prevFi = get(faceEditHighlight);
	faceEditHighlight.set(fi);
	let healed = false;
	if (healStale && triangleIndex >= 0 && !get(faceEditMulti)) {
		const sel = get(faceEditSelectedTris);
		if (sel.length) {
			const set = new Set(sel);
			if (!pickFaceUnitTris(triangleIndex).every((t) => set.has(t))) {
				faceEditSelectedTris.set([]);
				healed = true;
			}
		}
	}
	// "changed" means the picked UNIT changed — that is what the overlay draws.
	// Face compares the coplanar group; 15-G quad compares the PAIR (crossing a
	// quad's internal diagonal is not a new unit, so the overlay must not
	// rebuild); triangle/shell/object stay per raw tri (a shell key would mean
	// re-running the union-find on every hover frame).
	const g = granularity();
	const changed =
		g === 'face'
			? fi !== prevFi
			: g === 'quad'
				? quadKey(triangleIndex) !== quadKey(prevTri)
				: triangleIndex !== prevTri;
	if (changed || healed) refreshFaceOverlay();
	return changed;
}

/** Clear the face highlight (ray left the mesh) — returns TRUE if it changed */
export function clearFaceHighlight() {
	return highlightFaceByTriangle(-1);
}

/** logical face index for a triangle index, or -1 (no highlight side-effect) @param {number} triangleIndex */
export function faceIndexForTriangle(triangleIndex) {
	return triangleIndex < 0 ? -1 : faces.findIndex((f) => f.triIndices.includes(triangleIndex));
}

/**
 * E10: live counts for the toolbar — selected tris, the logical faces they
 * cover, and (with EXACTLY two faces) their boundary-edge counts, so a bridge
 * mismatch is visible BEFORE clicking. @returns {{tris: number, faces: number,
 * loops: [number, number] | null}}
 */
export function faceSelectionInfo() {
	const sel = get(faceEditSelectedTris).filter((/** @type {number} */ ti) => workingTris[ti]);
	if (!sel.length) return { tris: 0, faces: 0, loops: null };
	/** @type {Set<number>} */
	const faceSet = new Set();
	sel.forEach((/** @type {number} */ ti) => {
		const fi = faceIndexForTriangle(ti);
		if (fi >= 0) faceSet.add(fi);
	});
	/** @type {[number, number] | null} */
	let loops = null;
	if (faceSet.size === 2) {
		const [a, b] = [...faceSet];
		loops = [
			boundaryLoop(workingTris, faces[a].triIndices)?.length ?? 0,
			boundaryLoop(workingTris, faces[b].triIndices)?.length ?? 0
		];
	}
	return { tris: sel.length, faces: faceSet.size, loops };
}

/** the op target's world-space centroid + normal (for ghost/preview) — the
 * multi selection or hovered unit (212), falling back to the highlighted face */
export function highlightedFaceInfo() {
	const face = opTargetFace();
	if (!face || !faceEdited) return null;
	faceEdited.updateMatrixWorld(true);
	return {
		index: get(faceEditHighlight),
		centroid: faceEdited.localToWorld(face.centroid.clone()),
		normal: face.normal.clone().transformDirection(faceEdited.matrixWorld).normalize()
	};
}

/** tint the op target with a scene-root overlay triangle set (212: selection + hover) */
function refreshFaceOverlay() {
	const scene = get(globalScene);
	if (!scene || !faceEdited) return;
	if (overlay) {
		overlay.parent?.remove(overlay);
		overlay.geometry?.dispose?.();
		overlay = null;
	}
	const tris = overlayTris();
	if (!tris.length) return;
	/** @type {number[]} */
	const positions = [];
	tris.forEach((ti) =>
		workingTris[ti].forEach((/** @type {any} */ v) => positions.push(v.x, v.y, v.z))
	);
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	overlay = new THREE.Mesh(
		geometry,
		new THREE.MeshBasicMaterial({
			color: 0xff7a1a,
			transparent: true,
			opacity: 0.4,
			depthTest: false,
			side: THREE.DoubleSide
		})
	);
	overlay.renderOrder = 999;
	overlay.name = 'face-edit-overlay';
	faceEdited.updateMatrixWorld(true);
	overlay.applyMatrix4(faceEdited.matrixWorld);
	scene.add(overlay);
}

/**
 * Run an op on the highlighted face and commit: rebuild geometry, replicate
 * the snapshot, record history. subdivide/flip/bridge take no amount (B4).
 * @param {'extrude'|'inset'|'move'|'delete'|'subdivide'|'flip'|'bridge'} op
 * @param {number} amount
 */
export function commitFaceOp(op, amount) {
	// B4: bridge validates + commits its own two-face path
	if (op === 'bridge') return bridgeFaces();
	// 212: target the multi selection / hovered unit / highlighted face group
	const face = opTargetFace();
	if (!faceEdited || !face) return false;
	const before = trisToPositions(workingTris);
	const beforeGroups = trisToGroups(workingTris);
	const beforeUVs = trisToUVs(workingTris);
	let next;
	if (op === 'extrude') next = extrudeFace(workingTris, face, amount);
	else if (op === 'inset') next = insetFace(workingTris, face, amount);
	else if (op === 'move') next = moveFaceAlongNormal(workingTris, face, amount);
	else if (op === 'delete') next = deleteFaceTris(workingTris, face);
	else if (op === 'subdivide') next = subdivideFaceTris(workingTris, face.triIndices);
	else if (op === 'flip') next = flipFaceNormals(workingTris, face.triIndices);
	else return false;
	const positions = trisToPositions(next);
	if (positions.length > MAX_SNAPSHOT) {
		showToast('That edit is too large to sync');
		return false;
	}
	// 15-G / M1: these ops change the triangle COUNT, so a multi-material mesh
	// needs its groups recomputed and a textured one its uvs (the grab/adjust
	// paths only move vertices, and their counts match, so applyGeometrySnapshot
	// carries the old groups/uvs over)
	const groups = trisToGroups(next);
	const uvs = trisToUVs(next);
	applyGeometrySnapshot(positions, groups, uvs);
	broadcastMeshGeo(faceEdited.uuid, positions, groups, uvs);
	recordEntry({
		kind: 'meshgeo',
		uuid: faceEdited.uuid,
		before: { positions: before, groups: beforeGroups, uvs: beforeUVs },
		after: { positions, groups, uvs }
	});
	if (op === 'inset' || op === 'extrude' || op === 'move') {
		// E6: keep the CAP selected — its tri indices survive the op (cloneTris
		// keeps order, ring/walls APPEND). groupFaces re-merges a coplanar inset
		// cap with its ring into ONE logical face, so the highlight alone cannot
		// describe the cap; the selection is what makes "inset then Move the cap"
		// possible at all.
		faceEditSelectedTris.set([...face.triIndices]);
		faceEditHighlight.set(faceIndexForTriangle(face.triIndices[0]));
		refreshFaceOverlay();
		// E7: the gizmo comes back seated on the new cap (attachFaceGizmo reads
		// the selection-first op target). NEVER on arm — that's the B1 fix.
		if (typeof window !== 'undefined') attachFaceGizmo();
	} else {
		// subdivide/flip/delete rebuild the topology: indices are stale (212)
		if (get(faceEditSelectedTris).length) faceEditSelectedTris.set([]);
		if (op === 'delete') faceEditHighlight.set(-1);
	}
	return true;
}

/** swap the LIVE edited object's geometry + re-derive faces + overlay
 * @param {number[]} positions @param {any[] | null} [groups] material groups (15-G)
 * @param {number[] | null} [uvs] texture coordinates (M1) */
function applyGeometrySnapshot(positions, groups, uvs) {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	const previous = faceEdited.geometry;
	preserveMaterialGroups(geometry, previous, faceEdited, groups);
	preserveUVs(geometry, previous, uvs);
	previous?.dispose?.();
	faceEdited.geometry = geometry;
	faceEdited.userData.faceEdited = true;
	rebuildFaces();
	refreshFaceOverlay();
	refreshFaceWireframe(); // B2: the overlay wraps the NEW geometry
	objectsGroup.update((v) => v);
}

/** @param {string} uuid @param {number[]} positions @param {any[] | null} [groups]
 * @param {number[] | null} [uvs] */
function broadcastMeshGeo(uuid, positions, groups, uvs) {
	/** @type {any} */
	const peer = get(peers);
	// raw Float32 BYTES, not a plain number array: binarypack recurses per
	// element and blows the call stack on big arrays (a 48-seg terrain snapshot
	// = 41k numbers silently vanished — broadcast() catches the throw), and
	// bytes are ~half the wire size anyway. applyMeshGeo accepts either shape.
	// `groups` is a handful of small objects — safe as a plain value, and absent
	// entirely for the single-material case (an older peer simply ignores it)
	// M1: `uvs` ride as raw bytes too, and only for a textured mesh
	if (peer)
		peer.send({
			type: 'meshgeo',
			uuid: uuid,
			positions: new Float32Array(positions).buffer,
			...(groups?.length ? { groups } : {}),
			...(uvs?.length ? { uvs: new Float32Array(uvs).buffer } : {})
		});
}

/**
 * Commit a full geometry snapshot for ANY object (161 stretch, 162/163 face
 * transforms): swap locally, replicate, record ONE undoable meshgeo. Size-
 * capped like the face ops. @param {string} uuid @param {number[]} before
 * @param {number[]} after @returns {boolean}
 */
export function commitMeshGeoSnapshot(uuid, before, after) {
	if (after.length > MAX_SNAPSHOT) {
		showToast('That edit is too large to sync');
		return false;
	}
	applyMeshGeo(uuid, after);
	broadcastMeshGeo(uuid, after);
	recordEntry({ kind: 'meshgeo', uuid, before, after });
	return true;
}

/** Order 4 coplanar-ish points into a convex ring around their centroid, so a
 * fan triangulation is non-self-intersecting. @param {THREE.Vector3[]} v */
function orderQuad(v) {
	const c = new THREE.Vector3();
	v.forEach((p) => c.add(p));
	c.multiplyScalar(1 / v.length);
	const n = new THREE.Vector3()
		.subVectors(v[1], v[0])
		.cross(new THREE.Vector3().subVectors(v[2], v[0]))
		.normalize();
	const u = new THREE.Vector3().subVectors(v[0], c).normalize();
	const w = new THREE.Vector3().crossVectors(n, u).normalize();
	const ang = (/** @type {THREE.Vector3} */ p) => {
		const d = new THREE.Vector3().subVectors(p, c);
		return Math.atan2(d.dot(w), d.dot(u));
	};
	return [...v].sort((a, b) => ang(a) - ang(b));
}

/** 177/183: create a triangle (3) or quad (4) face from OBJECT-LOCAL vertex
 * positions and commit it as a meshgeo snapshot (replicated + undoable). Winds
 * the new face outward (normal away from the mesh centre). Shared by the desktop
 * vertices toolbar and VR. @param {string} uuid @param {{x:number,y:number,z:number}[]} verts
 * @param {any} [viewerPos] world-space viewer position; when given, the face is wound to FACE
 * the viewer (191: in VR the face you look at must be the visible side) */
export function createFaceFromVerts(uuid, verts, viewerPos = null) {
	if (!verts || verts.length < 3 || verts.length > 4) return false;
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object || !object.geometry?.attributes?.position) return false;
	let poly = verts.map((p) => new THREE.Vector3(p.x, p.y, p.z));
	// reject degenerate selections (duplicate/collinear points)
	for (let i = 0; i < poly.length; i++)
		for (let j = i + 1; j < poly.length; j++) if (poly[i].distanceTo(poly[j]) < 1e-6) return false;
	if (poly.length === 4) poly = orderQuad(poly);
	// outward winding: flip if the face normal points toward the mesh centre
	const meshCenter = new THREE.Box3()
		.setFromBufferAttribute(object.geometry.attributes.position)
		.getCenter(new THREE.Vector3());
	const faceCenter = new THREE.Vector3();
	poly.forEach((p) => faceCenter.add(p));
	faceCenter.multiplyScalar(1 / poly.length);
	const normal = new THREE.Vector3()
		.subVectors(poly[1], poly[0])
		.cross(new THREE.Vector3().subVectors(poly[2], poly[0]));
	let flip;
	if (viewerPos) {
		// 191: wind so the normal points AT the viewer (the side they look from)
		const localViewer = object.worldToLocal(viewerPos.clone());
		flip = normal.dot(new THREE.Vector3().subVectors(localViewer, faceCenter)) < 0;
	} else {
		// outward winding: flip if the face normal points toward the mesh centre
		flip = normal.dot(new THREE.Vector3().subVectors(faceCenter, meshCenter)) < 0;
	}
	// fan-triangulate the ordered polygon
	const appended = [];
	for (let i = 1; i < poly.length - 1; i++) {
		const tri = [poly[0], poly[i], poly[i + 1]];
		const ordered = flip ? [tri[0], tri[2], tri[1]] : tri;
		for (const p of ordered) appended.push(p.x, p.y, p.z);
	}
	const before = trisToPositions(readTriangles(object.geometry));
	const after = before.concat(appended);
	return commitMeshGeoSnapshot(uuid, before, after);
}

// ---- VR face grab + live extrude/inset (122): a pending edit applied live,
// committed as ONE meshgeo on release/confirm ----

let lastFaceBroadcast = 0;
/** @type {any} rigid face-grab state */
let faceGrab = null;
/** @type {any} live extrude/inset adjust state */
let faceAdjust = null;

/** Live geometry swap from the CURRENT workingTris WITHOUT re-grouping faces
 * (indices stay stable through a gesture); broadcasts a preview ~5/s. */
function liveGeometryUpdate() {
	const positions = trisToPositions(workingTris);
	// 15-G: the live preview swaps geometry every frame — without the groups a
	// multi-material mesh blinks out for the whole gesture (a live extrude/inset
	// adjust re-stitches walls, so the count changes too)
	const groups = trisToGroups(workingTris);
	const uvs = trisToUVs(workingTris); // M1: same reason — the texture must not blink
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	const previous = faceEdited.geometry;
	preserveMaterialGroups(geometry, previous, faceEdited, groups);
	preserveUVs(geometry, previous, uvs);
	previous?.dispose?.();
	faceEdited.geometry = geometry;
	faceEdited.userData.faceEdited = true;
	refreshFaceOverlay();
	refreshFaceWireframe(); // B2: track the gesture live
	objectsGroup.update((v) => v);
	const now = Date.now();
	if (now - lastFaceBroadcast > 200) {
		lastFaceBroadcast = now;
		broadcastMeshGeo(faceEdited.uuid, positions, groups, uvs);
	}
}

/** True while a face grab or extrude/inset adjust is in progress (122) */
export function faceGesturePending() {
	return !!faceGrab || !!faceAdjust;
}

/** Begin a rigid grab of the target (grip/gizmo). Captures the pre-edit snapshot
 * + the target's original local vertices.
 * @param {any} faceOrIndex a synthesized op target, or a face-group index */
export function beginFaceGrab(faceOrIndex) {
	if (!faceEdited || faceGesturePending()) return false;
	// 212-style: accept a SYNTHESIZED target (granularity/multi-aware, see
	// opTargetFace) or a plain face-group index for back-compat. The gizmo passes
	// the synthesized one — grabbing `faces[highlight]` was why a Shell pick
	// highlighted a whole island but only dragged the coplanar face under the
	// cursor, leaving the rest of the shell behind.
	const index = typeof faceOrIndex === 'number' ? faceOrIndex : -1;
	const face = typeof faceOrIndex === 'number' ? faces[faceOrIndex] : faceOrIndex;
	if (!face || !face.triIndices?.length) return false;
	const triIndices = face.triIndices.filter((/** @type {number} */ ti) => workingTris[ti]);
	if (!triIndices.length) return false;
	// weld-neighbour set (138): verts OUTSIDE the grabbed set sharing its corner
	// positions — the TRANSLATION carries them so the mesh stretches, not tears.
	// A whole-shell/object grab has none, which is exactly right: it moves rigidly.
	const faceSet = new Set(triIndices);
	const keys = faceVertexKeys(workingTris, { triIndices });
	/** @type {any[]} */
	const neighbours = [];
	workingTris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
		if (faceSet.has(ti)) return;
		t.forEach((/** @type {any} */ v, /** @type {number} */ k) => {
			if (keys.has(keyOf(v.x, v.y, v.z))) neighbours.push({ ti, k, orig: v.clone() });
		});
	});
	faceGrab = {
		index,
		triIndices,
		before: trisToPositions(workingTris),
		originals: triIndices.map((/** @type {number} */ ti) =>
			workingTris[ti].map((/** @type {any} */ v) => v.clone())
		),
		neighbours,
		centroid: face.centroid.clone(),
		normal: face.normal.clone()
	};
	if (index >= 0) faceEditHighlight.set(index);
	return true;
}

/**
 * Apply a LOCAL-space rigid transform to the grabbed face around its centroid
 * (rebuilt from the snapshot each call — no drift). Pure + testable.
 * E8: `scale` also takes a Vector3 (per-axis, in the PROXY frame given by
 * `scaleQuat` — v' = R·S·R⁻¹·v); a plain number stays uniform, so every VR
 * caller is untouched.
 * @param {{dPos?: any, dQuat?: any, push?: number, scale?: number | any, scaleQuat?: any}} t
 */
export function applyFaceGrab(t) {
	if (!faceGrab || !faceEdited) return;
	const pivot = faceGrab.centroid;
	const dPos = t.dPos || new THREE.Vector3();
	const dQuat = t.dQuat || new THREE.Quaternion();
	const scale = t.scale ?? 1;
	const pushVec = faceGrab.normal.clone().multiplyScalar(t.push || 0);
	/** @type {(v: any) => any} diagonal scale sandwiched in the proxy frame */
	let applyScale;
	if (typeof scale === 'number') {
		applyScale = (v) => v.multiplyScalar(scale);
	} else {
		const R = t.scaleQuat || new THREE.Quaternion();
		const Rinv = R.clone().invert();
		applyScale = (v) => v.applyQuaternion(Rinv).multiply(scale).applyQuaternion(R);
	}
	// the ONE rigid transform (about the face centroid) applied to a base vertex
	const xf = (/** @type {any} */ v) =>
		applyScale(v.clone().sub(pivot)).applyQuaternion(dQuat).add(pivot).add(dPos).add(pushVec);
	faceGrab.triIndices.forEach((/** @type {number} */ ti, /** @type {number} */ k) => {
		workingTris[ti] = faceGrab.originals[k].map(xf);
	});
	// 162: the welded neighbours sit at the face's CORNER positions, so they get
	// the SAME rigid transform — shared corners stay welded under rotate + scale
	// too (138 moved them by translation only, which tore the edge when the
	// controller rotated). Their far verts aren't in the set, so adjacent faces
	// stretch instead of moving rigidly.
	faceGrab.neighbours.forEach((/** @type {any} */ n) => {
		workingTris[n.ti][n.k] = xf(n.orig);
	});
	liveGeometryUpdate();
}

/** Commit the grab: finalize geometry, replicate, one undo entry. */
export function commitFaceGrab() {
	if (!faceGrab || !faceEdited) return false;
	const positions = trisToPositions(workingTris);
	const before = faceGrab.before;
	faceGrab = null;
	applyGeometrySnapshot(positions);
	broadcastMeshGeo(faceEdited.uuid, positions);
	recordEntry({ kind: 'meshgeo', uuid: faceEdited.uuid, before, after: positions });
	return true;
}

/** Drop a grab without committing — restore the pre-grab geometry. */
export function cancelFaceGrab() {
	if (!faceGrab || !faceEdited) return;
	const before = faceGrab.before;
	faceGrab = null;
	applyGeometrySnapshot(before);
}

// ---- 163: desktop face transform gizmo (a scene-root proxy driving the 162
// rigid grab). The proxy lives at the SCENE ROOT (not under the object) so it
// never leaks into GLTF sync / raycasts, like the vertex proxy. ----
/** @type {any} */ let faceProxy = null;
/** @type {any} */ let faceProxyStart = null;
/** the op target the gizmo was seated on — what a drag actually moves */
/** @type {any} */ let gizmoTarget = null;

/** E9: face-gizmo space — 'local' = the FACE basis (Z = normal), 'world' =
 * world axes. Persisted local pref. NOTE three r185: scale mode always
 * orients local, whatever `.space` says. Declared AFTER faceProxy: the
 * subscriber runs at module eval (the store-subscriber TDZ gotcha).
 * @type {import('svelte/store').Writable<'local'|'world'>} */
export const faceGizmoSpace = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('faceGizmoSpace') === 'world'
		? 'world'
		: 'local'
);
faceGizmoSpace.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('faceGizmoSpace', String(value));
	/** @type {any} */
	const controls = get(TControls);
	// live flip while the face gizmo is seated
	if (faceProxy && controls && controls.object === faceProxy) controls.setSpace?.(value);
});

/** E9: pick the world axis least aligned with n (deterministic tangent seed)
 * @param {any} n */
function axisLeastAlignedWith(n) {
	const ax = Math.abs(n.x),
		ay = Math.abs(n.y),
		az = Math.abs(n.z);
	if (ax <= ay && ax <= az) return new THREE.Vector3(1, 0, 0);
	if (ay <= az) return new THREE.Vector3(0, 1, 0);
	return new THREE.Vector3(0, 0, 1);
}

function ensureFaceProxy() {
	if (faceProxy) return faceProxy;
	const scene = get(globalScene);
	if (!scene) return null;
	faceProxy = new THREE.Object3D();
	faceProxy.userData.isFaceProxy = true;
	scene.add(faceProxy);
	return faceProxy;
}

/** World-space focus target {center,radius} for the selected face, or null (173). */
export function focusTargetFace() {
	if (!faceEdited) return null;
	const fi = get(faceEditHighlight);
	if (fi < 0 || !faces[fi]) return null;
	faceEdited.updateMatrixWorld(true);
	const center = faceEdited.localToWorld(faces[fi].centroid.clone());
	const box = new THREE.Box3().setFromObject(faceEdited);
	const objR = box.getSize(new THREE.Vector3()).length() / 2;
	return { center, radius: Math.max(objR * 0.3, 0.3) };
}

/**
 * Attach the transform gizmo to the current op TARGET (desktop) — the same
 * granularity/multi-aware set every other op uses, not just the coplanar face
 * under the cursor. The target is STASHED here because by the time the user
 * presses a gizmo handle the pointer is over the gizmo, not the mesh, so the
 * live hover can no longer be trusted to describe what they meant to grab.
 */
export function attachFaceGizmo() {
	if (typeof window === 'undefined' || !faceEdited) return;
	if (get(isVRMode)) return; // the desktop gizmo helper would render in-headset
	/** @type {any} */
	const controls = get(TControls);
	const target = opTargetFace();
	if (!target || !controls) {
		gizmoTarget = null;
		detachFaceGizmo();
		return;
	}
	gizmoTarget = target;
	const proxy = ensureFaceProxy();
	if (!proxy) return;
	faceEdited.updateMatrixWorld(true);
	proxy.position.copy(faceEdited.localToWorld(target.centroid.clone()));
	// E9: FACE basis — gizmo Z = the face WORLD normal (push/pull), X/Y = its
	// tangents (deterministic seed: the world axis least aligned with n). The
	// old object-quaternion copy gave every face of an axis-aligned box the
	// same handles.
	const n = target.normal.clone().transformDirection(faceEdited.matrixWorld).normalize();
	const t = new THREE.Vector3().crossVectors(axisLeastAlignedWith(n), n).normalize();
	const bit = new THREE.Vector3().crossVectors(n, t);
	proxy.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(t, bit, n));
	proxy.scale.setScalar(1);
	controls.setSpace?.(get(faceGizmoSpace));
	controls.attach(proxy);
}

/** Detach + remove the face gizmo proxy. */
export function detachFaceGizmo() {
	/** @type {any} */
	const controls = get(TControls);
	if (faceProxy) {
		if (controls && controls.object === faceProxy) controls.detach();
		faceProxy.parent?.remove(faceProxy);
		faceProxy = null;
	}
	faceProxyStart = null;
	gizmoTarget = null;
	// E9 leak fix: setSpace('local') used to stick to the SHARED TransformControls
	// after a face session, silently flipping normal object transforms to local
	controls?.setSpace?.('world');
}

/** Gizmo dragging-changed for the face proxy (163). @param {boolean} dragging */
export function onFaceGizmoDragChanged(dragging) {
	if (!faceEdited || !faceProxy) return;
	if (dragging) {
		// the target captured when the gizmo was seated (see attachFaceGizmo)
		if (beginFaceGrab(gizmoTarget ?? get(faceEditHighlight))) {
			// E9: R maps proxy-local into object-local (identity when the proxy
			// copied the object frame, the pre-E9 case) — deltas measured in the
			// proxy frame must be conjugated through it before hitting the verts
			const objQuat = faceEdited.getWorldQuaternion(new THREE.Quaternion());
			faceProxyStart = {
				pos: faceProxy.position.clone(),
				quat: faceProxy.quaternion.clone(),
				R: objQuat.invert().multiply(faceProxy.quaternion)
			};
		}
	} else if (faceProxyStart) {
		faceProxyStart = null;
		commitFaceGrab(); // ONE meshgeo + undo; rebuilds the face cache
		attachFaceGizmo(); // re-seat on the rebuilt face
	}
}

/** Gizmo onchange for the face proxy — apply the rigid transform (163/162;
 * E9 face-basis frame conjugation; E8 per-axis scale). */
export function onFaceGizmoMoved() {
	if (!faceEdited || !faceProxy || !faceProxyStart) return;
	const dPos = faceEdited
		.worldToLocal(faceProxy.position.clone())
		.sub(faceEdited.worldToLocal(faceProxyStart.pos.clone()));
	// the delta in the PROXY frame, conjugated into object-local (dQuatLocal =
	// R·dQuat·R⁻¹) — with the face-basis proxy the raw delta is in the wrong
	// frame and a rotate-about-normal would smear the cap off its plane
	const dQuatProxy = faceProxyStart.quat.clone().invert().multiply(faceProxy.quaternion);
	const R = faceProxyStart.R;
	const dQuat = R.clone().multiply(dQuatProxy).multiply(R.clone().invert());
	applyFaceGrab({ dPos, dQuat, scale: faceProxy.scale.clone(), scaleQuat: R });
}

/** The op target as a synthesized face (multi selection / hovered polygon /
 * highlighted group) — for the VR live-adjust + ghost to aim at (212). */
export function currentTargetFace() {
	return opTargetFace();
}

/**
 * Begin a live extrude/inset adjust (trigger): applies the op at a default
 * amount immediately (visible), then depth/scale sticks reshape it until a
 * second trigger commits. 212: accepts the synthesized op target OR a face-group
 * index (number, back-compat). @param {any} faceOrIndex @param {'extrude'|'inset'} op @param {number} defaultAmount
 */
export function beginFaceAdjust(faceOrIndex, op, defaultAmount) {
	const face = typeof faceOrIndex === 'number' ? faces[faceOrIndex] : faceOrIndex;
	if (!faceEdited || !face || !face.triIndices?.length || faceGesturePending()) return false;
	faceAdjust = {
		op,
		before: trisToPositions(workingTris),
		originalTris: cloneTris(workingTris),
		originalFace: {
			triIndices: [...face.triIndices],
			normal: face.normal.clone(),
			centroid: face.centroid.clone()
		},
		amount: defaultAmount,
		scale: 1
	};
	reapplyFaceAdjust();
	return true;
}

function reapplyFaceAdjust() {
	const a = faceAdjust;
	let next =
		a.op === 'inset'
			? insetFace(a.originalTris, a.originalFace, a.amount)
			: extrudeFace(a.originalTris, a.originalFace, a.amount);
	// scale the cap (the original face tris, moved in place) around its centroid
	if (a.scale !== 1) {
		const capCentroid =
			a.op === 'inset'
				? a.originalFace.centroid.clone()
				: a.originalFace.centroid.clone().add(a.originalFace.normal.clone().multiplyScalar(a.amount));
		a.originalFace.triIndices.forEach((/** @type {number} */ ti) => {
			next[ti] = next[ti].map((/** @type {any} */ v) =>
				v.clone().sub(capCentroid).multiplyScalar(a.scale).add(capCentroid)
			);
		});
	}
	workingTris = next;
	liveGeometryUpdate();
}

/** Stick reshapes the pending adjust @param {number} dAmount depth @param {number} dScale cap scale */
export function adjustFaceGesture(dAmount, dScale) {
	if (!faceAdjust) return;
	if (dAmount) {
		// 192: inset must stay in 0.02..0.9 — clamping to [-5,5] like extrude let
		// controller motion drive the inset to ~0/negative, collapsing it (it
		// looked like the second-trigger confirm had CANCELLED the operation)
		const min = faceAdjust.op === 'inset' ? 0.02 : -5;
		const max = faceAdjust.op === 'inset' ? 0.9 : 5;
		faceAdjust.amount = Math.min(Math.max(faceAdjust.amount + dAmount, min), max);
	}
	if (dScale) faceAdjust.scale = Math.min(Math.max(faceAdjust.scale + dScale, 0.05), 5);
	reapplyFaceAdjust();
}

/** the live extrude/inset adjust amount, or null (192 test hook) */
export function faceAdjustAmount() {
	return faceAdjust ? faceAdjust.amount : null;
}

/** Second trigger: commit the pending extrude/inset — rebuild, replicate, undo. */
export function commitFaceAdjust() {
	if (!faceAdjust || !faceEdited) return false;
	const positions = trisToPositions(workingTris);
	const before = faceAdjust.before;
	faceAdjust = null;
	// a live extrude/inset RE-STITCHES walls, so the count changes — this path
	// must carry the recomputed groups + uvs like commitFaceOp does (15-G / M1)
	const groups = trisToGroups(workingTris);
	const uvs = trisToUVs(workingTris);
	applyGeometrySnapshot(positions, groups, uvs);
	broadcastMeshGeo(faceEdited.uuid, positions, groups, uvs);
	recordEntry({
		kind: 'meshgeo',
		uuid: faceEdited.uuid,
		before,
		after: { positions, groups, uvs }
	});
	if (get(faceEditSelectedTris).length) faceEditSelectedTris.set([]); // 212: stale after reshape
	return true;
}

/** Back/hub reverts a pending adjust to the pre-op geometry. */
export function cancelFaceAdjust() {
	if (!faceAdjust || !faceEdited) return;
	const before = faceAdjust.before;
	faceAdjust = null;
	applyGeometrySnapshot(before);
}

// undo/redo replays meshgeo snapshots through the same apply + broadcast path
registerHistoryKind('meshgeo', (entry, state) => {
	// 15-G / M1: a topology op stores {positions, groups, uvs} so a multi-material
	// TEXTURED mesh keeps its slots and mapping through undo/redo; every other
	// producer (sculpt strokes, vertex drags, VR grabs) still stores a bare
	// positions array, and their uvs ride the previous-attribute carry-over
	const positions = state?.positions ?? state;
	const groups = state?.positions ? state.groups : undefined;
	const uvs = state?.positions ? state.uvs : undefined;
	applyMeshGeo(entry.uuid, positions, groups, uvs);
	// same raw-bytes wire format as broadcastMeshGeo (big plain arrays blow
	// binarypack's recursion and the replay would silently not replicate)
	/** @type {any} */
	const peer = get(peers);
	if (peer)
		peer.send({
			type: 'meshgeo',
			uuid: entry.uuid,
			positions: new Float32Array(positions).buffer,
			...(groups?.length ? { groups } : {}),
			...(uvs?.length ? { uvs: new Float32Array(uvs).buffer } : {})
		});
	return true;
});
